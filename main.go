package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unsafe"

	webview "github.com/jchv/go-webview2"
)

const PORT = 8788

// ---- 单实例：命名互斥锁 + 置顶已有窗口 ----

var (
	modKernel32       = syscall.NewLazyDLL("kernel32.dll")
	modUser32         = syscall.NewLazyDLL("user32.dll")
	procCreateMutex   = modKernel32.NewProc("CreateMutexW")
	procFindWindow    = modUser32.NewProc("FindWindowW")
	procShowWindow    = modUser32.NewProc("ShowWindow")
	procSetForeground = modUser32.NewProc("SetForegroundWindow")
	procIsIconic      = modUser32.NewProc("IsIconic")
)

const mutexName = "XiaoHeiMaoWikiSingleInstance"
const SW_RESTORE = 9

// 检查是否已有实例运行。
// 返回 true = 已有实例（当前进程应退出），false = 首次启动。
func ensureSingleInstance() bool {
	namePtr, _ := syscall.UTF16PtrFromString(mutexName)
	handle, _, err := procCreateMutex.Call(0, 1, uintptr(unsafe.Pointer(namePtr)))
	if handle == 0 {
		return false
	}
	// ERROR_ALREADY_EXISTS = 183
	if err.(syscall.Errno) == 183 {
		// 已有实例，找到它的窗口并置顶
		bringExistingWindowToFront()
		return true
	}
	// 首次创建，保持 handle 不关闭（进程退出时自动释放）
	return false
}

func bringExistingWindowToFront() {
	// 按窗口标题查找
	titles := []string{"小黑猫 Wiki"}
	for _, title := range titles {
		titlePtr, _ := syscall.UTF16PtrFromString(title)
		hwnd, _, _ := procFindWindow.Call(0, uintptr(unsafe.Pointer(titlePtr)))
		if hwnd != 0 {
			// 如果窗口最小化了，先还原
			iconic, _, _ := procIsIconic.Call(hwnd)
			if iconic != 0 {
				procShowWindow.Call(hwnd, SW_RESTORE)
			}
			procSetForeground.Call(hwnd)
			return
		}
	}
}

// ---- MIME 类型 ----
var mimeTypes = map[string]string{
	"html":        "text/html;charset=utf-8",
	"js":          "application/javascript",
	"css":         "text/css",
	"png":         "image/png",
	"jpg":         "image/jpeg",
	"jpeg":        "image/jpeg",
	"svg":         "image/svg+xml",
	"ico":         "image/x-icon",
	"webp":        "image/webp",
	"gif":         "image/gif",
	"woff":        "font/woff",
	"woff2":       "font/woff2",
	"ttf":         "font/ttf",
	"webmanifest": "application/manifest+json",
}

// ---- 全局路径 ----
var (
	appFS       fs.FS
	appRoot     string
	learnersDir string
)

// ---- API 缓存 ----
var (
	monstersJSON      []byte
	monstersMap       map[string]json.RawMessage
	typesJSON         []byte
	magicItemsJSON    []byte
	gameTermsJSON     []byte
	personalitiesJSON []byte
	movesMap          map[string]json.RawMessage
)

type MonsterBasic struct {
	ID           int             `json:"id"`
	Name         string          `json:"name"`
	IsLeaderForm bool            `json:"is_leader_form"`
	Localized    json.RawMessage `json:"localized"`
	raw          json.RawMessage
}

var monsterList []MonsterBasic

func appPath(parts ...string) string {
	clean := make([]string, 0, len(parts)+1)
	clean = append(clean, appRoot)
	for _, part := range parts {
		part = strings.ReplaceAll(part, "\\", "/")
		part = strings.TrimPrefix(part, "/")
		part = strings.TrimSuffix(part, "/")
		if part != "" {
			clean = append(clean, part)
		}
	}
	return path.Join(clean...)
}

func appReadFile(parts ...string) ([]byte, error) {
	return fs.ReadFile(appFS, appPath(parts...))
}

func appReadDir(parts ...string) ([]fs.DirEntry, error) {
	return fs.ReadDir(appFS, appPath(parts...))
}

func appStat(parts ...string) (fs.FileInfo, error) {
	return fs.Stat(appFS, appPath(parts...))
}

func appExists(parts ...string) bool {
	_, err := appStat(parts...)
	return err == nil
}

func initAppFS(exeDir string) {
	// 优先使用 exe 同级目录（打包模式），其次尝试 Xwiki/output 子目录（开发模式）
	candidates := []string{
		exeDir,
		filepath.Join(exeDir, "Xwiki"),
		filepath.Join(exeDir, "output"),
		filepath.Join(exeDir, "..", "Xwiki"),
		filepath.Join(exeDir, "..", "output"),
	}
	for _, c := range candidates {
		info, err := os.Stat(c)
		if err == nil && info.IsDir() {
			// 检查目录中是否有 index.html，确认是网站根目录
			if _, err2 := os.Stat(filepath.Join(c, "index.html")); err2 == nil {
				appFS = os.DirFS(c)
				appRoot = "" // os.DirFS 已指向根目录，无需额外前缀
				return
			}
		}
	}
	log.Fatalf("找不到网站文件目录，请确保 index.html 与小黑猫 Wiki.exe 在同一目录下。")
}

func loadCache() {
	learnersDir = path.Join("api-cache", "moves", "learners")

	// 纯静态站点模式：数据由前端 data.js 通过 fetch 加载，API 层可选
	data, err := appReadFile("api-cache", "monsters.json")
	if err != nil {
		// 没有 api-cache 目录，跳过 API 缓存加载（纯静态模式）
		return
	}
	monstersJSON = data

	var rawList []json.RawMessage
	json.Unmarshal(data, &rawList)
	monsterList = make([]MonsterBasic, 0, len(rawList))
	for _, raw := range rawList {
		var m MonsterBasic
		json.Unmarshal(raw, &m)
		m.raw = raw
		monsterList = append(monsterList, m)
	}

	monstersMap = make(map[string]json.RawMessage)
	entries, _ := appReadDir("api-cache", "monsters")
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		content, err := appReadFile("api-cache", "monsters", e.Name())
		if err == nil {
			monstersMap[id] = json.RawMessage(content)
		}
	}

	typesJSON, _ = appReadFile("api-cache", "types.json")
	magicItemsJSON, _ = appReadFile("api-cache", "magic_items.json")
	gameTermsJSON, _ = appReadFile("api-cache", "game_terms.json")
	personalitiesJSON, _ = appReadFile("api-cache", "personalities.json")

	movesIndexData, err := appReadFile("api-cache", "moves", "index.json")
	if err == nil {
		movesMap = make(map[string]json.RawMessage)
		json.Unmarshal(movesIndexData, &movesMap)
	}
}

func findWikiUpdateScript(exeDir string) string {
	candidates := []string{
		filepath.Join(exeDir, "tools", "wiki", "wiki_apply_pipeline.js"),
		filepath.Join(exeDir, "tools", "wiki", "wiki_preview_update.js"),
		filepath.Join(exeDir, "tools", "wiki", "wiki_update.js"),
		filepath.Join(exeDir, "..", "tools", "wiki", "wiki_apply_pipeline.js"),
		filepath.Join(exeDir, "..", "tools", "wiki", "wiki_preview_update.js"),
		filepath.Join(exeDir, "..", "tools", "wiki", "wiki_update.js"),
		filepath.Join(exeDir, "wiki_apply_pipeline.js"),
		filepath.Join(exeDir, "..", "wiki_apply_pipeline.js"),
		filepath.Join(exeDir, "wiki_preview_update.js"),
		filepath.Join(exeDir, "..", "wiki_preview_update.js"),
		filepath.Join(exeDir, "wiki_update.js"),
		filepath.Join(exeDir, "..", "wiki_update.js"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func runWikiUpdate(exeDir string) (string, error) {
	script := findWikiUpdateScript(exeDir)
	if script == "" {
		return "", fmt.Errorf("找不到更新脚本")
	}

	nodePath, err := exec.LookPath("node")
	if err != nil {
		return "", fmt.Errorf("找不到 node.exe，请确认 Node.js 已安装并加入 PATH")
	}

	outputDir := filepath.Join(exeDir, "output")
	runnerPath := filepath.Join(exeDir, "wiki_update_runner.cmd")
	runnerContent := fmt.Sprintf("@echo off\r\necho [RK] node: \"%s\"\r\necho [RK] update script: \"%s\"\r\necho [RK] output dir: \"%s\"\r\ncd /d \"%s\"\r\n\"%s\" \"%s\" \"%s\"\r\necho.\r\necho [RK] update finished. Press any key to close.\r\npause\r\n", nodePath, script, outputDir, exeDir, nodePath, script, outputDir)
	if err := os.WriteFile(runnerPath, []byte(runnerContent), 0644); err != nil {
		return "", fmt.Errorf("无法创建更新脚本: %v", err)
	}
	spawn := exec.Command("cmd.exe", "/c", "start", "", "cmd.exe", "/k", runnerPath)
	spawn.Dir = exeDir
	spawn.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	spawn.Stdin = nil
	spawn.Stdout = nil
	spawn.Stderr = nil
	if err := spawn.Start(); err != nil {
		return "", fmt.Errorf("无法打开更新窗口: %v", err)
	}
	spawn.Process.Release()
	msg := "已打开更新窗口，请在 CMD 中查看进度。更新完成后重启程序以加载最新数据。"
	return msg, nil
}

// ---- JSON 响应 ----
func writeJSON(w http.ResponseWriter, status int, data []byte) {
	w.Header().Set("Content-Type", "application/json;charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(status)
	w.Write(data)
}

var (
	reMonsterByID  = regexp.MustCompile(`^/api/monsters/(\d+)$`)
	reMoveLearners = regexp.MustCompile(`^/api/moves/(\d+)/learners$`)
	reMoveByID     = regexp.MustCompile(`^/api/moves/(\d+)$`)
)

// ---- API 路由 ----
func handleAPI(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	q := r.URL.Query()

	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if path == "/api/wiki/update" {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, []byte(`{"error":"Method not allowed"}`))
			return
		}
		exeDir := getExeDir()
		msg, err := runWikiUpdate(exeDir)
		if err != nil {
			data, _ := json.Marshal(map[string]any{"ok": false, "error": msg})
			writeJSON(w, 500, data)
			return
		}
		data, _ := json.Marshal(map[string]any{"ok": true, "message": msg})
		writeJSON(w, 200, data)
		return
	}

	if path == "/api/monsters" {
		nameFilter := strings.ToLower(q.Get("name"))
		leaderFilter := q.Get("is_leader_form")
		if nameFilter == "" && leaderFilter == "" {
			writeJSON(w, 200, monstersJSON)
			return
		}
		result := make([]json.RawMessage, 0)
		for _, m := range monsterList {
			if nameFilter != "" {
				if !strings.Contains(strings.ToLower(m.Name), nameFilter) &&
					!strings.Contains(strings.ToLower(string(m.Localized)), nameFilter) {
					continue
				}
			}
			if leaderFilter != "" {
				want := leaderFilter == "true"
				if m.IsLeaderForm != want {
					continue
				}
			}
			result = append(result, m.raw)
		}
		out, _ := json.Marshal(result)
		writeJSON(w, 200, out)
		return
	}

	if m := reMonsterByID.FindStringSubmatch(path); m != nil {
		if data, ok := monstersMap[m[1]]; ok {
			writeJSON(w, 200, data)
		} else {
			writeJSON(w, 404, []byte(`{"error":"Not found"}`))
		}
		return
	}

	if path == "/api/types" {
		writeJSON(w, 200, typesJSON)
		return
	}
	if path == "/api/magic_items" {
		writeJSON(w, 200, magicItemsJSON)
		return
	}
	if path == "/api/game_terms" {
		writeJSON(w, 200, gameTermsJSON)
		return
	}
	if path == "/api/personalities" {
		writeJSON(w, 200, personalitiesJSON)
		return
	}

	if path == "/api/moves" {
		idsParam := q.Get("ids")
		if idsParam != "" {
			result := make([]json.RawMessage, 0)
			for _, idStr := range strings.Split(idsParam, ",") {
				if data, ok := movesMap[strings.TrimSpace(idStr)]; ok {
					result = append(result, data)
				}
			}
			out, _ := json.Marshal(result)
			writeJSON(w, 200, out)
		} else {
			result := make([]json.RawMessage, 0, len(movesMap))
			for _, v := range movesMap {
				result = append(result, v)
			}
			out, _ := json.Marshal(result)
			writeJSON(w, 200, out)
		}
		return
	}

	if m := reMoveLearners.FindStringSubmatch(path); m != nil {
		if data, err := appReadFile(learnersDir, m[1]+".json"); err == nil {
			writeJSON(w, 200, data)
		} else {
			writeJSON(w, 200, []byte(`{"move_pool":[],"move_stones":[],"legacy":[]}`))
		}
		return
	}

	if m := reMoveByID.FindStringSubmatch(path); m != nil {
		if data, ok := movesMap[m[1]]; ok {
			writeJSON(w, 200, data)
		} else {
			writeJSON(w, 404, []byte(`{"error":"Not found"}`))
		}
		return
	}

	if path == "/api/auth/quota" {
		writeJSON(w, 200, []byte(`{"teams_limit":-1,"teams_used":0,"is_guest":true}`))
		return
	}
	if strings.HasPrefix(path, "/api/auth/") {
		writeJSON(w, 401, []byte(`{"error":"Offline mode"}`))
		return
	}

	// ---- 数据编辑 API ----
	if path == "/api/edit/monster" && r.Method == http.MethodPost {
		handleEditMonster(w, r)
		return
	}
	if path == "/api/add/monster" && r.Method == http.MethodPost {
		handleAddMonster(w, r)
		return
	}
	if path == "/api/add/move" && r.Method == http.MethodPost {
		handleAddMove(w, r)
		return
	}
	// ---- 打开外链 ----
	if path == "/api/open-url" && r.Method == http.MethodPost {
		handleOpenURL(w, r)
		return
	}
	// ---- 用户设置 ----
	if path == "/api/settings" && r.Method == http.MethodGet {
		handleGetSettings(w, r)
		return
	}
	if path == "/api/settings" && r.Method == http.MethodPost {
		handleSaveSettings(w, r)
		return
	}
	// ---- 窗口状态（前端用于决定是否允许 Ctrl+滚轮缩放） ----
	if path == "/api/window/state" && r.Method == http.MethodGet {
		if isWindowMaximized() {
			writeJSON(w, 200, []byte(`{"maximized":true}`))
		} else {
			writeJSON(w, 200, []byte(`{"maximized":false}`))
		}
		return
	}

	writeJSON(w, 200, []byte(`[]`))
}

// isWindowMaximized 检测主窗口是否最大化（SW_SHOWMAXIMIZED=3）
func isWindowMaximized() bool {
	user32 := syscall.NewLazyDLL("user32.dll")
	findWindow := user32.NewProc("FindWindowW")
	getPlacement := user32.NewProc("GetWindowPlacement")
	title, _ := syscall.UTF16PtrFromString("小黑猫 Wiki")
	hwnd, _, _ := findWindow.Call(0, uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return false
	}
	type RECT struct{ Left, Top, Right, Bottom int32 }
	type POINT struct{ X, Y int32 }
	type WINDOWPLACEMENT struct {
		length           uint32
		flags, showCmd   uint32
		ptMinPosition    POINT
		ptMaxPosition    POINT
		rcNormalPosition RECT
	}
	var wp WINDOWPLACEMENT
	wp.length = uint32(unsafe.Sizeof(wp))
	getPlacement.Call(hwnd, uintptr(unsafe.Pointer(&wp)))
	return wp.showCmd == 3 // SW_SHOWMAXIMIZED
}

func handleOpenURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}
	if req.URL == "" {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"URL不能为空"}`))
		return
	}
	// 用默认浏览器打开
	cmd := exec.Command("cmd", "/c", "start", "", req.URL)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"`+err.Error()+`"}`))
		return
	}
	writeJSON(w, 200, []byte(`{"ok":true}`))
}

// ---- 数据编辑 API 处理函数 ----

// getDataFilePath 返回数据文件的绝对路径
func getDataFilePath(filename string) string {
	exeDir := getExeDir()
	candidates := []string{
		filepath.Join(exeDir, "data", filename),
		filepath.Join(exeDir, "Xwiki", "data", filename),
		filepath.Join(exeDir, "..", "Xwiki", "data", filename),
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

func getMonstersFilePath() string { return getDataFilePath("monsters.json") }
func getMovesFilePath() string    { return getDataFilePath("moves.json") }

// ---- 用户设置 ----
type UserSettings struct {
	CloseBehavior  string `json:"close_behavior"`  // "close" | "minimize"
	WindowWidth    int    `json:"window_width"`
	WindowHeight   int    `json:"window_height"`
	WindowMaximized bool  `json:"window_maximized"`
	DefaultRoute   string `json:"default_route"`
}

func getSettingsFilePath() string {
	exeDir := getExeDir()
	// 优先 exe 同级，其次 Xwiki 子目录
	p1 := filepath.Join(exeDir, "settings.json")
	if _, err := os.Stat(p1); err == nil {
		return p1
	}
	return filepath.Join(exeDir, "Xwiki", "settings.json")
}

func loadSettings() UserSettings {
	s := UserSettings{
		CloseBehavior:  "close",
		WindowWidth:    1280,
		WindowHeight:   800,
		WindowMaximized: false,
		DefaultRoute:   "petdex",
	}
	path := getSettingsFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		// 尝试备用路径
		path2 := filepath.Join(getExeDir(), "settings.json")
		data, err = os.ReadFile(path2)
		if err != nil {
			return s
		}
	}
	json.Unmarshal(data, &s)
	if s.WindowWidth <= 0 { s.WindowWidth = 1280 }
	if s.WindowHeight <= 0 { s.WindowHeight = 800 }
	if s.CloseBehavior == "" { s.CloseBehavior = "close" }
	if s.DefaultRoute == "" { s.DefaultRoute = "petdex" }
	return s
}

func saveSettings(s UserSettings) error {
	path := getSettingsFilePath()
	// 确保目录存在（首次保存时 Xwiki 子目录可能不存在）
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(path, data, 0644)
}

func handleGetSettings(w http.ResponseWriter, r *http.Request) {
	s := loadSettings()
	out, _ := json.Marshal(s)
	writeJSON(w, 200, out)
}

func handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	var s UserSettings
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}
	if s.CloseBehavior == "" { s.CloseBehavior = "close" }
	if s.WindowWidth <= 0 { s.WindowWidth = 1280 }
	if s.WindowHeight <= 0 { s.WindowHeight = 800 }
	if s.DefaultRoute == "" { s.DefaultRoute = "petdex" }
	if err := saveSettings(s); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"保存失败"}`))
		return
	}
	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func handleEditMonster(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID             int    `json:"id"`
		BaseHP         int    `json:"base_hp"`
		BasePhyAtk     int    `json:"base_phy_atk"`
		BaseMagAtk     int    `json:"base_mag_atk"`
		BasePhyDef     int    `json:"base_phy_def"`
		BaseMagDef     int    `json:"base_mag_def"`
		BaseSpd        int    `json:"base_spd"`
		MainType       string `json:"main_type"`
		SubType        string `json:"sub_type"`
		EvolutionStage string `json:"evolution_stage"`
		FormCategory  string `json:"form_category"`   // 无多形态 / 主形态 / 变体形态
		MainFormName  string `json:"main_form_name"`   // 变体形态时指定的主形态名
		EvolvesFromID *int   `json:"evolves_from_id"`  // 进化上游精灵ID, nil=无
		TraitName      string `json:"trait_name"`
		TraitDesc      string `json:"trait_desc"`
		SkillList      []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"skillList"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}

	// 读取 monsters.json
	filePath := getMonstersFilePath()
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"无法读取数据文件"}`))
		return
	}

	var monsters []map[string]interface{}
	if err := json.Unmarshal(data, &monsters); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"数据解析失败"}`))
		return
	}

	// 查找并更新对应精灵
	found := false
	foundIdx := -1
	for i, m := range monsters {
		id, ok := m["id"].(float64)
		if !ok { continue }
		if int(id) != req.ID { continue }
		foundIdx = i

		monsters[i]["base_hp"] = req.BaseHP
		monsters[i]["base_phy_atk"] = req.BasePhyAtk
		monsters[i]["base_mag_atk"] = req.BaseMagAtk
		monsters[i]["base_phy_def"] = req.BasePhyDef
		monsters[i]["base_mag_def"] = req.BaseMagDef
		monsters[i]["base_spd"] = req.BaseSpd
		monsters[i]["evolution_stage"] = req.EvolutionStage

		// 地区形态
		if req.FormCategory != "" {
			monsters[i]["form_category"] = req.FormCategory
		}
		monsters[i]["main_form_name"] = req.MainFormName

		// 进化关系
		if req.EvolvesFromID != nil {
			monsters[i]["evolves_from_id"] = *req.EvolvesFromID
		} else {
			monsters[i]["evolves_from_id"] = nil
		}

		if req.MainType != "" {
			monsters[i]["main_type"] = map[string]interface{}{
				"name": req.MainType,
			}
		}
		if req.SubType != "" {
			monsters[i]["sub_type"] = map[string]interface{}{
				"name": req.SubType,
			}
		} else {
			monsters[i]["sub_type"] = nil
		}

		if req.TraitName != "" || req.TraitDesc != "" {
			monsters[i]["trait"] = map[string]interface{}{
				"localized": map[string]interface{}{
					"zh": map[string]interface{}{
						"name":        req.TraitName,
						"description": req.TraitDesc,
					},
				},
			}
		}

		found = true
		break
	}

	if !found || foundIdx < 0 {
		writeJSON(w, 404, []byte(`{"ok":false,"error":"未找到该精灵"}`))
		return
	}

	// 写回文件
	out, _ := json.MarshalIndent(monsters, "", "  ")
	if err := os.WriteFile(filePath, out, 0644); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"文件写入失败"}`))
		return
	}

	// 如果有技能列表变更，更新 wiki_monster_data.json
	if req.SkillList != nil {
		updateWikiSkills(monsters[foundIdx], req.SkillList)
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func handleAddMonster(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name              string   `json:"name"`
		EvolutionChain    string   `json:"evolution_chain_name"`
		BaseHP            int      `json:"base_hp"`
		BasePhyAtk        int      `json:"base_phy_atk"`
		BaseMagAtk        int      `json:"base_mag_atk"`
		BasePhyDef        int      `json:"base_phy_def"`
		BaseMagDef        int      `json:"base_mag_def"`
		BaseSpd           int      `json:"base_spd"`
		MainType          string   `json:"main_type"`
		SubType           string   `json:"sub_type"`
		EvolutionStage    string   `json:"evolution_stage"`
		FormCategory      string   `json:"form_category"`
		MainFormName      string   `json:"main_form_name"`
		EvolvesFromID     *int     `json:"evolves_from_id"`
		TraitName         string   `json:"trait_name"`
		TraitDesc         string   `json:"trait_desc"`
		SkillList         []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"skillList"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}

	if req.Name == "" {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"名称不能为空"}`))
		return
	}

	filePath := getMonstersFilePath()
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"无法读取数据文件"}`))
		return
	}

	var monsters []map[string]interface{}
	if err := json.Unmarshal(data, &monsters); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"数据解析失败"}`))
		return
	}

	// 找最大 ID
	maxID := 0
	for _, m := range monsters {
		if id, ok := m["id"].(float64); ok && int(id) > maxID {
			maxID = int(id)
		}
	}

	newID := maxID + 1

	newMonster := map[string]interface{}{
		"id":               newID,
		"form":             "default",
		"main_type":        map[string]interface{}{"name": req.MainType},
		"sub_type":         nil,
		"leader_potential": false,
		"is_leader_form":   false,
		"preferred_attack_style": "Physical",
		"localized": map[string]interface{}{
			"zh": map[string]interface{}{
				"name": req.Name,
			},
		},
		"base_hp":     req.BaseHP,
		"base_phy_atk": req.BasePhyAtk,
		"base_mag_atk": req.BaseMagAtk,
		"base_phy_def": req.BasePhyDef,
		"base_mag_def": req.BaseMagDef,
		"base_spd":    req.BaseSpd,
		"evolves_from_id": req.EvolvesFromID,
		"dex_number":  0,
		"trait": map[string]interface{}{
			"localized": map[string]interface{}{
				"zh": map[string]interface{}{
					"name":        req.TraitName,
					"description": req.TraitDesc,
				},
			},
		},
		"image":               "",
		"evolution_stage":     req.EvolutionStage,
		"form_category":       req.FormCategory,
		"main_form_name":      req.MainFormName,
		"evolution_chain_name": req.EvolutionChain,
	}

	if req.SubType != "" {
		newMonster["sub_type"] = map[string]interface{}{"name": req.SubType}
	}

	monsters = append(monsters, newMonster)

	out, _ := json.MarshalIndent(monsters, "", "  ")
	if err := os.WriteFile(filePath, out, 0644); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"文件写入失败"}`))
		return
	}

	// 更新 wiki_monster_data.json 中的技能列表
	if len(req.SkillList) > 0 {
		updateWikiSkills(newMonster, req.SkillList)
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func handleAddMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		Type        string `json:"type"`
		Category    string `json:"category"`
		Power       int    `json:"power"`
		Energy      int    `json:"energy"`
		Combo       int    `json:"combo"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}

	if req.Name == "" {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"技能名称不能为空"}`))
		return
	}

	filePath := getMovesFilePath()
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"无法读取数据文件"}`))
		return
	}

	var moves []map[string]interface{}
	if err := json.Unmarshal(data, &moves); err != nil {
		// 可能是对象格式
		var movesMap map[string]interface{}
		if err2 := json.Unmarshal(data, &movesMap); err2 != nil {
			writeJSON(w, 500, []byte(`{"ok":false,"error":"数据解析失败"}`))
			return
		}
		for _, v := range movesMap {
			moves = append(moves, v.(map[string]interface{}))
		}
	}

	// 找最大 ID
	maxID := 0
	for _, m := range moves {
		if id, ok := m["id"].(float64); ok && int(id) > maxID {
			maxID = int(id)
		}
	}

	// 映射技能类型
	catMap := map[string]string{
		"物攻": "Physical Attack", "魔攻": "Magic Attack",
		"状态": "Status", "防御": "Defense",
		"条件攻击": "Conditional Attack", "能量": "Energy",
	}
	catEn := catMap[req.Category]
	if catEn == "" { catEn = "Status" }

	newMove := map[string]interface{}{
		"id":     maxID + 1,
		"move_type": map[string]interface{}{"name": req.Type},
		"localized": map[string]interface{}{
			"zh": map[string]interface{}{
				"name":        req.Name,
				"description": req.Description,
			},
		},
		"move_category":  catEn,
		"energy_cost":    req.Energy,
		"power":          req.Power,
		"base_combo":     req.Combo,
	}

	moves = append(moves, newMove)

	out, _ := json.MarshalIndent(moves, "", "  ")
	if err := os.WriteFile(filePath, out, 0644); err != nil {
		writeJSON(w, 500, []byte(`{"ok":false,"error":"文件写入失败"}`))
		return
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func updateWikiSkills(monster map[string]interface{}, skillList []struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	}) {
	// 获取精灵显示名
	name := ""
	if loc, ok := monster["localized"].(map[string]interface{}); ok {
		if zh, ok := loc["zh"].(map[string]interface{}); ok {
			if n, ok := zh["name"].(string); ok {
				name = n
			}
		}
	}
	if form, ok := monster["form"].(string); ok && form != "" && form != "default" {
		name = name + "（" + form + "）"
	}
	if name == "" { return }

	wikiPath := getDataFilePath("wiki_monster_data.json")
	data, err := os.ReadFile(wikiPath)
	if err != nil { return }

	var wiki map[string]interface{}
	if err := json.Unmarshal(data, &wiki); err != nil { return }

	// 从 moves.json 构建技能名 → (类型, 属性, 描述) 映射
	moveTypeMap := map[string]string{
		"Physical Attack": "物攻", "Magic Attack": "魔攻",
		"Status": "状态", "Defense": "防御",
		"Conditional Attack": "条件攻击", "Energy": "能量",
	}
	skillInfoMap := map[string]struct{ cat, elem, desc string }{}
	if movesData, err := os.ReadFile(getMovesFilePath()); err == nil {
		var movesRaw []map[string]interface{}
		if json.Unmarshal(movesData, &movesRaw) == nil {
			for _, mv := range movesRaw {
				name := ""
				if loc, ok := mv["localized"].(map[string]interface{}); ok {
					if zh, ok := loc["zh"].(map[string]interface{}); ok {
						if n, ok := zh["name"].(string); ok { name = n }
					}
				}
				if name == "" { continue }
				catEn, _ := mv["move_category"].(string)
				catZh := moveTypeMap[catEn]
				if catZh == "" { catZh = "自定义" }
				elem := "普通"
				if mt, ok := mv["move_type"].(map[string]interface{}); ok {
					if loc, ok := mt["localized"].(map[string]interface{}); ok {
						if zh, ok := loc["zh"].(string); ok && zh != "" { elem = zh }
						if zhMap, ok := loc["zh"].(map[string]interface{}); ok {
							if v, ok := zhMap["zh"].(string); ok && v != "" { elem = v }
						}
					}
				}
				// 也从 move_type.localized.zh 获取
				if mt, ok := mv["move_type"].(map[string]interface{}); ok {
					if loc, ok := mt["localized"].(map[string]interface{}); ok {
						if zh, ok := loc["zh"].(string); ok && zh != "" { elem = zh }
					}
				}
				desc := ""
				if loc, ok := mv["localized"].(map[string]interface{}); ok {
					if zh, ok := loc["zh"].(map[string]interface{}); ok {
						if d, ok := zh["description"].(string); ok { desc = d }
					}
				}
				skillInfoMap[name] = struct{ cat, elem, desc string }{catZh, elem, desc}
			}
		}
	}

	// 构建新的技能列表
	skills := make([]interface{}, 0, len(skillList))
	for _, s := range skillList {
		info, ok := skillInfoMap[s.Name]
		if !ok {
			info = struct{ cat, elem, desc string }{"自定义", "普通", ""}
		}
		skills = append(skills, map[string]interface{}{
			"name":   s.Name,
			"source": s.Source,
			"type":   info.cat,
			"element": info.elem,
			"desc":   info.desc,
		})
	}

	if entry, ok := wiki[name].(map[string]interface{}); ok {
		entry["skills"] = skills
	} else {
		// 创建新条目
		wiki[name] = map[string]interface{}{
			"image":  "",
			"skills": skills,
		}
	}

	out, _ := json.MarshalIndent(wiki, "", "  ")
	os.WriteFile(wikiPath, out, 0644)
}

// ---- 静态文件 ----
func sanitizeStaticPath(raw string) string {
	raw = strings.ReplaceAll(raw, "\\", "/")
	raw = strings.TrimPrefix(raw, "/")
	cleaned := path.Clean(raw)
	if cleaned == "." || cleaned == "/" {
		return ""
	}
	cleaned = strings.TrimPrefix(cleaned, "/")
	if strings.HasPrefix(cleaned, "../") || cleaned == ".." {
		return ""
	}
	return cleaned
}

func handleStatic(w http.ResponseWriter, r *http.Request) {
	// 用 RequestURI 获取原始未解码路径（去掉 query string）
	rawURI := r.RequestURI
	if i := strings.Index(rawURI, "?"); i >= 0 {
		rawURI = rawURI[:i]
	}
	// 已解码路径（用于判断扩展名）
	decodedPath := r.URL.Path

	if decodedPath == "/" {
		serveFileWithMIME(w, r, "index.html")
		return
	}

	// 无扩展名的路径（SPA hash 路由）统一返回 index.html
	if filepath.Ext(decodedPath) == "" {
		serveFileWithMIME(w, r, "index.html")
		return
	}

	// 有扩展名的静态资源（JS/CSS/图片）按路径找文件
	candidates := []string{
		sanitizeStaticPath(rawURI),
		sanitizeStaticPath(decodedPath),
	}

	for _, c := range candidates {
		if c == "" {
			continue
		}
		if info, err := appStat(c); err == nil && !info.IsDir() {
			serveFileWithMIME(w, r, c)
			return
		}
	}

	http.NotFound(w, r)
}

func serveFileWithMIME(w http.ResponseWriter, r *http.Request, relPath string) {
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(relPath), "."))
	ct, ok := mimeTypes[ext]
	if !ok {
		ct = "application/octet-stream"
	}

	data, err := appReadFile(relPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// 对 HTML 注入时间戳，强制浏览器重新加载所有资源
	if ext == "html" {
		ts := fmt.Sprintf("%d", time.Now().Unix())
		html := string(data)
		html = strings.ReplaceAll(html, "{{CACHE_BUST}}", ts)
		data = []byte(html)
	}

	w.Header().Set("Content-Type", ct)
	// JS/CSS/HTML 每次都重新加载，避免 WebView2 缓存导致改动不生效
	if ext == "js" || ext == "css" || ext == "html" {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}

	// 对 JSON 等大文本启用 gzip 压缩
	if (ext == "json" || ext == "js" || ext == "css" || ext == "html" || ext == "svg") && len(data) > 1024 {
		if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			w.Header().Set("Content-Encoding", "gzip")
			w.WriteHeader(200)
			gw := gzip.NewWriter(w)
			defer gw.Close()
			gw.Write(data)
			return
		}
	}

	w.WriteHeader(200)
	w.Write(data)
}

// ---- 找可用端口 ----
func findFreePort(preferred int) int {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", preferred))
	if err == nil {
		ln.Close()
		return preferred
	}
	ln, _ = net.Listen("tcp", ":0")
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func getExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func main() {
	// 单实例检测：已有实例则置顶它并退出
	if ensureSingleInstance() {
		return
	}

	exeDir := getExeDir()
	initAppFS(exeDir)

	loadCache()

	port := findFreePort(PORT)
	pageURL := fmt.Sprintf("http://localhost:%d/", port)

	// 启动 HTTP 服务器（后台 goroutine）
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", handleAPI)
	mux.HandleFunc("/", handleStatic)

	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		log.Fatalf("端口监听失败: %v", err)
	}
	go http.Serve(listener, mux)

	// 加载用户设置
	settings := loadSettings()

	// 创建 WebView2 窗口
	wWidth, wHeight := uint(1280), uint(800)
	if settings.WindowWidth > 0 { wWidth = uint(settings.WindowWidth) }
	if settings.WindowHeight > 0 { wHeight = uint(settings.WindowHeight) }

	wv := webview.NewWithOptions(webview.WebViewOptions{
		Debug: false,
		Window: nil,
		WindowOptions: webview.WindowOptions{
			Title:  "小黑猫 Wiki",
			Width:  wWidth,
			Height: wHeight,
			Center: true,
			IconId: 1,
		},
	})
	if wv == nil {
		log.Fatal("无法创建 WebView2 窗口，请确认已安装 WebView2 运行时")
	}
	defer wv.Destroy()

	wv.SetTitle("小黑猫 Wiki")
	if settings.WindowMaximized {
		wv.SetSize(0, 0, webview.HintMax)
	} else {
		wv.SetSize(int(wWidth), int(wHeight), webview.HintNone)
	}
	wv.Navigate(pageURL)
	wv.Run()
}


