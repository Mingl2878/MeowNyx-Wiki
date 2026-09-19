package main

import (
	"compress/gzip"
	"encoding/json"
	"errors"
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
	"runtime"
	"strings"
	"sync"
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

	procGetWindowLongPtr = modUser32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtr = modUser32.NewProc("SetWindowLongPtrW")
	procCallWindowProc   = modUser32.NewProc("CallWindowProcW")
	procRegisterHotKey   = modUser32.NewProc("RegisterHotKey")
	procUnregisterHotKey = modUser32.NewProc("UnregisterHotKey")
	procPostMessage      = modUser32.NewProc("PostMessageW")
	procPostThreadMsg    = modUser32.NewProc("PostThreadMessageW")
	procGetMessage       = modUser32.NewProc("GetMessageW")
	procGetThreadID      = modKernel32.NewProc("GetCurrentThreadId")
	procGetSystemMetrics = modUser32.NewProc("GetSystemMetrics")
	procEnumMonitors     = modUser32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW  = modUser32.NewProc("GetMonitorInfoW")
	procSetWindowPos     = modUser32.NewProc("SetWindowPos")
)

const mutexName = "XiaoHeiMaoWikiSingleInstance"
const SW_RESTORE = 9
const SW_MAXIMIZE = 3
const SW_MINIMIZE = 6
const WM_CLOSE = 0x0010
const WM_HOTKEY = 0x0312
const WM_APP_RELOAD_HOTKEY = 0x8010 // WM_APP+0x10: 通知热键线程重载设置
const WM_QUIT = 0x0012
const GWLP_WNDPROC = ^uintptr(3) // -4
const HOTKEY_ID = 1
const SM_CMONITORS = 80 // 显示器数量
const MONITORINFOF_PRIMARY = 1

// ---- 主窗口句柄与消息钩子 ----
var (
	mainHwnd           uintptr
	gOldWndProc        uintptr
	gCloseMu           sync.RWMutex
	gCloseBehavior     = "close"
	gClosePending      bool
	gCloseApproved     bool
	gRequestCloseFlush func()
)

// ---- 多显示器检测与枚举 ----
type winRect struct{ left, top, right, bottom int32 }

type monitorInfoExW struct {
	cbSize    uint32
	rcMonitor winRect
	rcWork    winRect
	dwFlags   uint32
	szDevice  [32]uint16
}

var (
	monitorEnumMu  sync.Mutex
	monitorEnumBuf []monitorEntry
)

type monitorEntry struct {
	rc      winRect
	primary bool
}

// monitorEnumCallback 收集每个显示器的屏幕矩形
func monitorEnumCallback(hmon, hdc, lprect, lparam uintptr) uintptr {
	var mi monitorInfoExW
	mi.cbSize = uint32(unsafe.Sizeof(mi))
	r, _, _ := procGetMonitorInfoW.Call(hmon, uintptr(unsafe.Pointer(&mi)))
	if r != 0 {
		monitorEnumBuf = append(monitorEnumBuf, monitorEntry{mi.rcMonitor, mi.dwFlags&MONITORINFOF_PRIMARY != 0})
	}
	return 1
}

var monitorEnumCB = syscall.NewCallback(monitorEnumCallback)

// monitorCount 返回系统显示器数量（至少为1）
func monitorCount() int {
	r, _, _ := procGetSystemMetrics.Call(SM_CMONITORS)
	n := int(int32(r))
	if n < 1 {
		n = 1
	}
	return n
}

// monitorRects 枚举所有显示器矩形，主显示器排在索引0
func monitorRects() []monitorEntry {
	monitorEnumMu.Lock()
	defer monitorEnumMu.Unlock()
	monitorEnumBuf = nil
	procEnumMonitors.Call(0, 0, monitorEnumCB, 0)
	out := monitorEnumBuf
	// 主显示器排到索引0
	for i, m := range out {
		if m.primary && i > 0 {
			first := out[0]
			out[0] = m
			out[i] = first
			break
		}
	}
	if len(out) == 0 {
		out = append(out, monitorEntry{winRect{0, 0, 1920, 1080}, true})
	}
	return out
}

// ---- 全局热键：独立线程 + 独立消息循环（与 WebView 消息循环解耦，确保可靠接收）----
var hotkeyThreadID uintptr

// winMsg 与 Windows MSG 结构对应

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	PtX     int32
	PtY     int32
}

// applyHotkeyOnThread 在当前（热键）线程上按设置注册热键，返回是否注册成功（未绑定视为成功）
func applyHotkeyOnThread() bool {
	procUnregisterHotKey.Call(0, HOTKEY_ID)
	s := loadSettings()
	if s.HotkeyVK == 0 {
		return true
	}
	r, _, _ := procRegisterHotKey.Call(0, HOTKEY_ID, uintptr(s.HotkeyMods), uintptr(s.HotkeyVK))
	return r != 0
}

// hotkeyResultCh 热键重载结果（true=注册成功），供保存设置接口同步反馈
var hotkeyResultCh = make(chan bool, 1)

// hotkeyThreadProc 热键专用线程：注册热键并泵消息，按下时唤起主窗口
func hotkeyThreadProc() {
	runtime.LockOSThread()
	hotkeyThreadID, _, _ = procGetThreadID.Call()
	applyHotkeyOnThread()
	var msg winMsg
	for {
		r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			continue
		}
		if msg.Message == WM_QUIT {
			return
		}
		if msg.Message == WM_APP_RELOAD_HOTKEY {
			ok := applyHotkeyOnThread()
			select {
			case hotkeyResultCh <- ok:
			default:
			}
			continue
		}
		if msg.Message == WM_HOTKEY && msg.WParam == HOTKEY_ID && mainHwnd != 0 {
			iconic, _, _ := procIsIconic.Call(mainHwnd)
			if iconic != 0 {
				procShowWindow.Call(mainHwnd, SW_RESTORE)
			}
			procSetForeground.Call(mainHwnd)
		}
	}
}

// wndProc 主窗口消息钩子：拦截 WM_CLOSE（最小化到任务栏）
func wndProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	if msg == WM_CLOSE {
		gCloseMu.Lock()
		approved := gCloseApproved
		gCloseApproved = false
		cb := gCloseBehavior
		gCloseMu.Unlock()
		if !approved {
			if cb == "minimize" {
				iconic, _, _ := procIsIconic.Call(hwnd)
				if iconic == 0 {
					// Preserve minimize-on-close. Closing an already minimized
					// window is a real exit and must flush first.
					procShowWindow.Call(hwnd, SW_MINIMIZE)
					return 0
				}
			}
			gCloseMu.Lock()
			flush := gRequestCloseFlush
			pending := gClosePending
			if flush != nil && !pending {
				gClosePending = true
			}
			gCloseMu.Unlock()
			if flush != nil {
				if !pending {
					flush()
				}
				return 0
			}
		}
	}
	r, _, _ := procCallWindowProc.Call(gOldWndProc, hwnd, msg, wParam, lParam)
	return r
}

// Accept acknowledgements only for a native-initiated pending close. Keeping
// this state transition separate also lets tests exercise it without a window.
func finishCloseFlush(ok bool) bool {
	gCloseMu.Lock()
	defer gCloseMu.Unlock()
	if !gClosePending {
		return false
	}
	gClosePending = false
	gCloseApproved = ok
	return ok
}

// installWindowHook 安装主窗口消息钩子（须在窗口线程上调用）
func installWindowHook(hwnd uintptr) {
	mainHwnd = hwnd
	if gOldWndProc != 0 {
		return
	}
	old, _, _ := procGetWindowLongPtr.Call(hwnd, GWLP_WNDPROC)
	gOldWndProc = old
	cb := syscall.NewCallback(wndProc)
	procSetWindowLongPtr.Call(hwnd, GWLP_WNDPROC, cb)
}

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
	titles := []string{applicationTitle(), "小黑猫 Wiki"}
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
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-cache")
	}
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

	// Profile APIs do not inherit other API endpoints' permissive preflight.
	if path == "/api/user-config" {
		handleUserConfig(w, r)
		return
	}
	if path == "/api/settings" {
		if !guardUserConfigRequest(w, r) {
			return
		}
		switch r.Method {
		case http.MethodGet:
			handleGetSettings(w, r)
		case http.MethodPost:
			handleSaveSettings(w, r)
		default:
			w.Header().Set("Allow", "GET, POST")
			configError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		}
		return
	}

	if r.Method == http.MethodOptions {
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
	if path == "/api/fonts" {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, []byte(`{"error":"Method not allowed"}`))
			return
		}
		out, _ := json.Marshal(map[string]any{"fonts": installedFontFamilies()})
		writeJSON(w, 200, out)
		return
	}
	if path == "/api/font-file" {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, []byte(`{"error":"Method not allowed"}`))
			return
		}
		fontPath, ok := selectedUserFontFile(q.Get("family"))
		if !ok {
			writeJSON(w, http.StatusNotFound, []byte(`{"error":"本机用户字体文件不可用"}`))
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, fontPath)
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
	// ---- 立即最大化/还原窗口（设置页窗口模式即时应用） ----
	if path == "/api/window/maximize" && r.Method == http.MethodPost {
		var req struct {
			Maximized bool `json:"maximized"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if mainHwnd != 0 {
			if req.Maximized {
				procShowWindow.Call(mainHwnd, SW_MAXIMIZE)
			} else {
				procShowWindow.Call(mainHwnd, SW_RESTORE)
			}
		}
		writeJSON(w, 200, []byte(`{"ok":true}`))
		return
	}

	writeJSON(w, 200, []byte(`[]`))
}

// isWindowMaximized 检测主窗口是否最大化（SW_SHOWMAXIMIZED=3）
func isWindowMaximized() bool {
	user32 := syscall.NewLazyDLL("user32.dll")
	findWindow := user32.NewProc("FindWindowW")
	getPlacement := user32.NewProc("GetWindowPlacement")
	title, _ := syscall.UTF16PtrFromString(applicationTitle())
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

// ---- 用户数据目录（独立于安装目录：覆盖安装/卸载均不影响用户数据）----
func getUserDataDir() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.Getenv("AppData")
	}
	return filepath.Join(base, "小黑猫Wiki")
}

// copyDir 递归复制目录
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, rerr := filepath.Rel(src, p)
		if rerr != nil {
			return rerr
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			return rerr
		}
		return os.WriteFile(target, data, 0644)
	})
}

// migrateWebView2Data 将旧版默认的 WebView2 数据目录（%AppData%\<exe文件名>）迁移到用户数据目录
// 仅在新目录为空时执行复制，旧目录保留不删除（安全迁移）
func migrateWebView2Data() {
	newUdf := filepath.Join(getUserDataDir(), "webview2")
	if entries, err := os.ReadDir(newUdf); err == nil && len(entries) > 0 {
		return // 已有数据，不迁移
	}
	exePath, err := os.Executable()
	if err != nil {
		return
	}
	exeName := filepath.Base(exePath)
	// 旧版库的默认目录名 = exe 文件名（含 .exe）；不同版本 exe 名可能带或不带空格
	candidates := []string{
		filepath.Join(os.Getenv("AppData"), exeName),
		filepath.Join(os.Getenv("AppData"), strings.TrimSuffix(exeName, ".exe")+".exe"),
		filepath.Join(os.Getenv("AppData"), strings.ReplaceAll(exeName, " ", "")+".exe"),
	}
	seen := map[string]bool{}
	for _, old := range candidates {
		if seen[old] {
			continue
		}
		seen[old] = true
		if st, err := os.Stat(old); err == nil && st.IsDir() {
			os.MkdirAll(newUdf, 0755)
			copyDir(old, newUdf)
			return
		}
	}
}

// ---- 数据编辑 API 处理函数 ----

// getDataFilePath 返回数据文件的绝对路径（随安装目录分发，更新时会被新版本数据覆盖）
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
	CloseBehavior           string `json:"close_behavior"` // "close" | "minimize"
	WindowWidth             int    `json:"window_width"`
	WindowHeight            int    `json:"window_height"`
	WindowMaximized         bool   `json:"window_maximized"`
	DefaultRoute            string `json:"default_route"`
	DefaultMaxZoom          int    `json:"default_max_zoom"` // 最大化时界面缩放百分比（50~200）
	HotkeyMods              int    `json:"hotkey_mods"`      // 热键修饰键位掩码（1=ALT 2=CTRL 4=SHIFT 8=WIN）
	HotkeyVK                int    `json:"hotkey_vk"`        // 热键虚拟键码（0=未绑定）
	DefaultMonitor          int    `json:"default_monitor"`  // 默认打开的显示器（0=主显示器，多显示器时可用）
	FontFamily              string `json:"font_family"`      // "" = 跟随 Windows 系统字体
	EffectiveIncludeSpeed   bool   `json:"effective_include_speed"`
	EffectiveSpeedMode      string `json:"effective_speed_mode"`
	EffectiveSpeedThreshold int    `json:"effective_speed_threshold"`
}

// Startup/hotkey compatibility wrapper only. HTTP reads must expose errors.
func loadSettings() UserSettings {
	s, err := sharedUserConfig.settings()
	if err != nil {
		log.Printf("加载共享个人配置失败（未覆盖文件）: %v", err)
	}
	return s
}

func saveSettings(s UserSettings) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	patch, err := parseObject(raw)
	if err != nil {
		return err
	}
	_, err = sharedUserConfig.updateSettings(patch)
	return err
}

func handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	s, err := sharedUserConfig.settings()
	if err != nil {
		configError(w, http.StatusInternalServerError, err)
		return
	}
	out, _ := json.Marshal(struct {
		UserSettings
		MonitorCount int `json:"monitor_count"`
	}{s, monitorCount()})
	writeJSON(w, 200, out)
}

func handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	patch, err := readConfigRequest(w, r)
	if err != nil {
		configRequestError(w, err)
		return
	}
	settingsHTTPMu.Lock()
	defer settingsHTTPMu.Unlock()
	s, err := sharedUserConfig.updateSettings(patch)
	if err != nil {
		var validation *settingsValidationError
		if errors.As(err, &validation) {
			configError(w, http.StatusBadRequest, err)
		} else {
			configError(w, http.StatusInternalServerError, err)
		}
		return
	}
	// Live effects only AFTER a durable successful save.
	gCloseMu.Lock()
	gCloseBehavior = s.CloseBehavior
	gCloseMu.Unlock()
	// 通知热键线程重载热键，并等待注册结果（最多500ms）
	hotkeyOK := true
	if hotkeyThreadID != 0 {
		select {
		case <-hotkeyResultCh:
		default:
		}
		procPostThreadMsg.Call(hotkeyThreadID, WM_APP_RELOAD_HOTKEY, 0, 0)
		select {
		case hotkeyOK = <-hotkeyResultCh:
		case <-time.After(500 * time.Millisecond):
		}
	}
	if hotkeyOK {
		writeJSON(w, 200, []byte(`{"ok":true}`))
	} else {
		writeJSON(w, 200, []byte(`{"ok":true,"hotkey_failed":true}`))
	}
}

func handleEditMonster(w http.ResponseWriter, r *http.Request) {
	handleEditMonsterFiles(w, r, getMonstersFilePath(), getDataFilePath("wiki_monster_data.json"), getMovesFilePath())
}

func handleEditMonsterFiles(w http.ResponseWriter, r *http.Request, filePath, wikiPath, movesPath string) {
	dataEditMu.Lock()
	defer dataEditMu.Unlock()
	var req struct {
		ID               int            `json:"id"`
		BaseHP           int            `json:"base_hp"`
		BasePhyAtk       int            `json:"base_phy_atk"`
		BaseMagAtk       int            `json:"base_mag_atk"`
		BasePhyDef       int            `json:"base_phy_def"`
		BaseMagDef       int            `json:"base_mag_def"`
		BaseSpd          int            `json:"base_spd"`
		MainType         string         `json:"main_type"`
		SubType          string         `json:"sub_type"`
		EvolutionStage   string         `json:"evolution_stage"`
		FormCategory     string         `json:"form_category"`   // 无多形态 / 主形态 / 变体形态
		MainFormName     string         `json:"main_form_name"`  // 变体形态时指定的主形态名
		EvolvesFromID    *int           `json:"evolves_from_id"` // 进化上游精灵ID, nil=无
		TraitName        string         `json:"trait_name"`
		TraitDesc        string         `json:"trait_desc"`
		SkillList        []wikiSkillRef `json:"skillList"`
		AllowEmptySkills bool           `json:"allowEmptySkills"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}

	// 读取 monsters.json
	data, err := os.ReadFile(filePath)
	if err != nil {
		writeDataError(w, fmt.Errorf("read data: %w", err))
		return
	}

	var monsters []map[string]interface{}
	if err := json.Unmarshal(data, &monsters); err != nil {
		writeDataError(w, fmt.Errorf("parse data: %w", err))
		return
	}
	if monsters == nil {
		writeDataError(w, fmt.Errorf("monsters must be an array, not null"))
		return
	}
	seenIDs := map[int]bool{}
	for _, monster := range monsters {
		id, err := numericMonsterID(monster["id"])
		if err != nil || seenIDs[id] {
			writeDataError(w, fmt.Errorf("invalid or duplicate monster ID: %v", monster["id"]))
			return
		}
		seenIDs[id] = true
	}

	// 查找并更新对应精灵
	found := false
	foundIdx := -1
	for i, m := range monsters {
		id, ok := m["id"].(float64)
		if !ok {
			continue
		}
		if int(id) != req.ID {
			continue
		}
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

	// Validate both files before replacing either one.
	writes, err := prepareMonsterSave(monsters, monsters[foundIdx], req.SkillList, req.AllowEmptySkills, filePath, data, wikiPath, movesPath)
	if err != nil {
		writeDataError(w, err)
		return
	}
	if err := commitDataWrites(writes); err != nil {
		writeDataError(w, err)
		return
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func handleAddMonster(w http.ResponseWriter, r *http.Request) {
	handleAddMonsterFiles(w, r, getMonstersFilePath(), getDataFilePath("wiki_monster_data.json"), getMovesFilePath())
}

func handleAddMonsterFiles(w http.ResponseWriter, r *http.Request, filePath, wikiPath, movesPath string) {
	dataEditMu.Lock()
	defer dataEditMu.Unlock()
	var req struct {
		Name             string         `json:"name"`
		EvolutionChain   string         `json:"evolution_chain_name"`
		BaseHP           int            `json:"base_hp"`
		BasePhyAtk       int            `json:"base_phy_atk"`
		BaseMagAtk       int            `json:"base_mag_atk"`
		BasePhyDef       int            `json:"base_phy_def"`
		BaseMagDef       int            `json:"base_mag_def"`
		BaseSpd          int            `json:"base_spd"`
		MainType         string         `json:"main_type"`
		SubType          string         `json:"sub_type"`
		EvolutionStage   string         `json:"evolution_stage"`
		FormCategory     string         `json:"form_category"`
		MainFormName     string         `json:"main_form_name"`
		EvolvesFromID    *int           `json:"evolves_from_id"`
		TraitName        string         `json:"trait_name"`
		TraitDesc        string         `json:"trait_desc"`
		SkillList        []wikiSkillRef `json:"skillList"`
		AllowEmptySkills bool           `json:"allowEmptySkills"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"无效的请求"}`))
		return
	}

	if req.Name == "" {
		writeJSON(w, 400, []byte(`{"ok":false,"error":"名称不能为空"}`))
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		writeDataError(w, fmt.Errorf("read data: %w", err))
		return
	}

	var monsters []map[string]interface{}
	if err := json.Unmarshal(data, &monsters); err != nil {
		writeDataError(w, fmt.Errorf("parse data: %w", err))
		return
	}
	if monsters == nil {
		writeDataError(w, fmt.Errorf("monsters must be an array, not null"))
		return
	}
	seenIDs := map[int]bool{}
	for _, monster := range monsters {
		id, err := numericMonsterID(monster["id"])
		if err != nil || seenIDs[id] {
			writeDataError(w, fmt.Errorf("invalid or duplicate monster ID: %v", monster["id"]))
			return
		}
		seenIDs[id] = true
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
		"id":                     newID,
		"form":                   "default",
		"main_type":              map[string]interface{}{"name": req.MainType},
		"sub_type":               nil,
		"leader_potential":       false,
		"is_leader_form":         false,
		"preferred_attack_style": "Physical",
		"localized": map[string]interface{}{
			"zh": map[string]interface{}{
				"name": req.Name,
			},
		},
		"base_hp":         req.BaseHP,
		"base_phy_atk":    req.BasePhyAtk,
		"base_mag_atk":    req.BaseMagAtk,
		"base_phy_def":    req.BasePhyDef,
		"base_mag_def":    req.BaseMagDef,
		"base_spd":        req.BaseSpd,
		"evolves_from_id": req.EvolvesFromID,
		"dex_number":      0,
		"trait": map[string]interface{}{
			"localized": map[string]interface{}{
				"zh": map[string]interface{}{
					"name":        req.TraitName,
					"description": req.TraitDesc,
				},
			},
		},
		"image":                "",
		"evolution_stage":      req.EvolutionStage,
		"form_category":        req.FormCategory,
		"main_form_name":       req.MainFormName,
		"evolution_chain_name": req.EvolutionChain,
	}

	if req.SubType != "" {
		newMonster["sub_type"] = map[string]interface{}{"name": req.SubType}
	}

	monsters = append(monsters, newMonster)

	writes, err := prepareMonsterSave(monsters, newMonster, req.SkillList, req.AllowEmptySkills, filePath, data, wikiPath, movesPath)
	if err != nil {
		writeDataError(w, err)
		return
	}
	if err := commitDataWrites(writes); err != nil {
		writeDataError(w, err)
		return
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
}

func handleAddMove(w http.ResponseWriter, r *http.Request) {
	handleAddMoveFiles(w, r, getMovesFilePath())
}

func handleAddMoveFiles(w http.ResponseWriter, r *http.Request, filePath string) {
	dataEditMu.Lock()
	defer dataEditMu.Unlock()
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

	data, err := os.ReadFile(filePath)
	if err != nil {
		writeDataError(w, fmt.Errorf("read data: %w", err))
		return
	}

	var moves []map[string]interface{}
	if err := json.Unmarshal(data, &moves); err != nil {
		// 可能是对象格式
		var movesMap map[string]interface{}
		if err2 := json.Unmarshal(data, &movesMap); err2 != nil {
			writeDataError(w, fmt.Errorf("parse data: %w", err))
			return
		}
		if movesMap == nil {
			writeDataError(w, fmt.Errorf("moves must be an array or object, not null"))
			return
		}
		for _, v := range movesMap {
			move, ok := v.(map[string]interface{})
			if !ok {
				writeDataError(w, fmt.Errorf("invalid move entry"))
				return
			}
			moves = append(moves, move)
		}
	}

	if moves == nil {
		// An empty object is accepted; JSON null is not a database.
		if strings.TrimSpace(string(data)) == "null" {
			writeDataError(w, fmt.Errorf("moves must not be null"))
			return
		}
		moves = []map[string]interface{}{}
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
	if catEn == "" {
		catEn = "Status"
	}

	newMove := map[string]interface{}{
		"id":        maxID + 1,
		"move_type": map[string]interface{}{"name": req.Type},
		"localized": map[string]interface{}{
			"zh": map[string]interface{}{
				"name":        req.Name,
				"description": req.Description,
			},
		},
		"move_category": catEn,
		"energy_cost":   req.Energy,
		"power":         req.Power,
		"base_combo":    req.Combo,
	}

	moves = append(moves, newMove)

	out, err := json.MarshalIndent(moves, "", "  ")
	if err != nil {
		writeDataError(w, fmt.Errorf("marshal moves: %w", err))
		return
	}
	if err := commitDataWrites([]preparedDataWrite{{filePath, data, out}}); err != nil {
		writeDataError(w, err)
		return
	}

	writeJSON(w, 200, []byte(`{"ok":true}`))
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
	// 所有静态资源（含图片/JSON）都禁止缓存，避免版本更新后
	// WebView2 使用旧缓存的图片（如精灵头像替换后仍显示旧图）
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")

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
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", preferred))
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
	pageURL := fmt.Sprintf("http://127.0.0.1:%d/", port)

	// 启动 HTTP 服务器（后台 goroutine）
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", handleAPI)
	mux.HandleFunc("/", handleStatic)

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		log.Fatalf("端口监听失败: %v", err)
	}
	go http.Serve(listener, mux)

	// 加载用户设置
	settings := loadSettings()
	gCloseMu.Lock()
	gCloseBehavior = settings.CloseBehavior
	gCloseMu.Unlock()

	// 迁移旧版 WebView2 数据目录（localStorage：配队/技能设置等）到用户数据目录
	// 旧版库默认路径为 %AppData%\<exe文件名>（如 "小黑猫 Wiki.exe"）
	migrateWebView2Data()

	// 创建用户数据目录（settings.json / webview2 / data 的宿主目录）
	os.MkdirAll(getUserDataDir(), 0755)

	// 创建 WebView2 窗口
	wWidth, wHeight := uint(1280), uint(800)
	if settings.WindowWidth > 0 {
		wWidth = uint(settings.WindowWidth)
	}
	if settings.WindowHeight > 0 {
		wHeight = uint(settings.WindowHeight)
	}

	wv := webview.NewWithOptions(webview.WebViewOptions{
		Debug:    false,
		Window:   nil,
		DataPath: filepath.Join(getUserDataDir(), "webview2"), // localStorage 等浏览器数据存用户目录
		WindowOptions: webview.WindowOptions{
			Title:  applicationTitle(),
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

	// Native close waits for pending writes. A missing frontend component blocks
	// page startup, so that read-only loading-error window may still close.
	if err := wv.Bind("__xhmCloseReady", func(ok bool) {
		wv.Dispatch(func() {
			if finishCloseFlush(ok) {
				procPostMessage.Call(mainHwnd, WM_CLOSE, 0, 0)
			}
		})
	}); err != nil {
		log.Fatalf("无法绑定安全关闭回调: %v", err)
	}
	gCloseMu.Lock()
	gRequestCloseFlush = func() {
		wv.Eval(`(function () {
            Promise.resolve().then(function () {
                if (!window.UserConfig) {
                    return window.__xhmCloseReady(true);
                }
                if (typeof window.UserConfig.flush !== 'function') {
                    throw new Error('个人配置组件异常，无法安全关闭。请稍后重试。');
                }
                if (typeof window.UserConfig.requestClose === 'function') {
                    // requestClose owns flush + __xhmCloseReady(bool).
                    return window.UserConfig.requestClose();
                }
                return Promise.resolve(window.UserConfig.flush()).then(function (ok) {
                    return window.__xhmCloseReady(ok === true);
                });
            }).catch(function (error) {
                console.error('Close flush failed', error);
                window.__xhmCloseReady(false);
                window.alert('个人配置保存失败，窗口保持打开。请重试保存后再关闭。');
            });
        })();`)
	}
	gCloseMu.Unlock()
	wv.SetTitle(applicationTitle())
	// 窗口已创建、消息循环尚未启动：直接（同线程）安装消息钩子与热键
	installWindowHook(uintptr(wv.Window()))
	// 启动全局热键线程
	go hotkeyThreadProc()
	wv.SetSize(int(wWidth), int(wHeight), webview.HintNone)
	// 默认打开在指定显示器（多显示器时）：移动窗口到该屏居中；索引0=主显示器则保持系统默认位置
	if mIdx := settings.DefaultMonitor; mIdx > 0 {
		if rects := monitorRects(); mIdx < len(rects) {
			rc := rects[mIdx].rc
			x := int(rc.left) + (int(rc.right)-int(rc.left)-int(wWidth))/2
			y := int(rc.top) + (int(rc.bottom)-int(rc.top)-int(wHeight))/2
			const SWP_NOSIZE = 0x0001
			const SWP_NOZORDER = 0x0004
			const SWP_NOACTIVATE = 0x0010
			procSetWindowPos.Call(uintptr(wv.Window()), 0, uintptr(x), uintptr(y), 0, 0,
				SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE)
		}
	}
	if settings.WindowMaximized {
		// 注意：库的 SetSize(HintMax) 只设置窗口最大尺寸限制，并非最大化；这里直接最大化窗口
		procShowWindow.Call(uintptr(wv.Window()), SW_MAXIMIZE)
	}
	wv.Navigate(pageURL)
	wv.Run()
}
