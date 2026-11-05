package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
	"xhmwiki/internal/sourcebaseline"
)

type catalogUpdateStatus struct {
	OK                     bool                      `json:"ok"`
	State                  string                    `json:"state"`
	TaskID                 string                    `json:"task_id,omitempty"`
	Phase                  string                    `json:"phase,omitempty"`
	Completed              int                       `json:"completed"`
	Total                  int                       `json:"total,omitempty"`
	BaseRevision           string                    `json:"base_revision,omitempty"`
	CurrentRevision        string                    `json:"current_revision,omitempty"`
	SourceURL              string                    `json:"source_url"`
	Changes                []officialdex.Change      `json:"changes"`
	Issues                 []officialdex.Issue       `json:"issues"`
	Summary                map[string]any            `json:"summary"`
	CanApply               bool                      `json:"can_apply"`
	Candidates             []catalogCandidate        `json:"candidates"`
	RememberedChoices      []catalogRememberedChoice `json:"remembered_choices"`
	AutomaticSourceChanges int                       `json:"automatic_source_changes"`
	SourceBaselineActive   bool                      `json:"source_baseline_active"`
	Error                  string                    `json:"error,omitempty"`
	Message                string                    `json:"message,omitempty"`
}
type catalogUpdateManager struct {
	mu         sync.Mutex
	rt         *catalogRuntime
	status     catalogUpdateStatus
	proposal   *officialdex.Proposal
	choicePlan *catalogChoicePlan
	cancel     context.CancelFunc
	done       chan struct{}
	client     *http.Client
	// Tests may inject transport; UI never supplies a URL or arbitrary command.
	fetchSource func(context.Context) ([]byte, error)
	fetchImage  func(context.Context, string) ([]byte, error)
}

func newCatalogUpdateManager(rt *catalogRuntime) *catalogUpdateManager {
	m := &catalogUpdateManager{rt: rt, client: newOfficialCatalogClient()}
	m.status = catalogUpdateStatus{OK: true, State: "idle", SourceURL: officialdex.SourceURL, Changes: []officialdex.Change{}, Issues: []officialdex.Issue{}, Summary: map[string]any{}}
	m.fetchSource = func(ctx context.Context) ([]byte, error) {
		return fetchOfficialBytes(ctx, m.client, officialdex.SourceURL, 32<<20)
	}
	m.fetchImage = func(ctx context.Context, u string) ([]byte, error) {
		return fetchOfficialBytes(ctx, m.client, u, 8<<20)
	}
	return m
}
func newOfficialCatalogClient() *http.Client {
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second, IdleConnTimeout: 60 * time.Second, MaxConnsPerHost: 4, MaxIdleConnsPerHost: 4, ForceAttemptHTTP2: true}
	return &http.Client{Transport: transport, Timeout: 40 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("官方源重定向过多")
		}
		return validateOfficialURL(r.URL.String())
	}}
}
func validateOfficialURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host != "static.gamecenter.qq.com" || u.User != nil || u.Fragment != "" || !strings.HasPrefix(u.Path, "/xgame/roco-kingdom/compendium/") || strings.Contains(u.Path, "\\") {
		return errors.New("仅允许腾讯图鉴的固定HTTPS来源")
	}
	cleaned := path.Clean(u.Path)
	if !strings.HasPrefix(cleaned, "/xgame/roco-kingdom/compendium/") {
		return errors.New("官方图片路径无效")
	}
	return nil
}
func fetchOfficialBytes(ctx context.Context, client *http.Client, raw string, limit int64) ([]byte, error) {
	if err := validateOfficialURL(raw); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "MeowNyxWiki-Catalog/1")
	req.Header.Set("Accept", "application/json,image/png,image/jpeg;q=0.9,*/*;q=0.1")
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连接官方图鉴失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("官方图鉴返回HTTP %d", response.StatusCode)
	}
	if response.ContentLength > limit {
		return nil, errors.New("官方响应超过大小限制")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, errors.New("官方响应超过大小限制")
	}
	if len(body) == 0 {
		return nil, errors.New("官方返回空内容，未修改本地资料")
	}
	return body, nil
}
func (m *catalogUpdateManager) Status() catalogUpdateStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := m.status
	// Immutable once published, but clone the top-level collections for callers.
	out.Changes = append([]officialdex.Change{}, out.Changes...)
	out.Issues = append([]officialdex.Issue{}, out.Issues...)
	out.Summary = map[string]any{}
	for k, v := range m.status.Summary {
		out.Summary[k] = v
	}
	out.Candidates = append([]catalogCandidate{}, out.Candidates...)
	out.RememberedChoices = []catalogRememberedChoice{}
	if m.rt.store != nil {
		snap := m.rt.store.Current()
		out.CurrentRevision = snap.Revision
		if c, err := catalog.Parse(snap.Data); err == nil {
			out.SourceBaselineActive = len(c.Extensions[sourcebaseline.Extension]) > 0
			if memory, err := readCatalogChoiceMemory(c); err == nil {
				out.RememberedChoices = rememberedCatalogChoices(memory)
			} else {
				out.CanApply = false
				out.Error = err.Error()
			}
		}
	}
	return out
}
func (m *catalogUpdateManager) busy() bool {
	return m.status.State == "checking" || m.status.State == "applying"
}
func catalogTaskID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("task-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
func (m *catalogUpdateManager) Start() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy() {
		return errors.New("已有图鉴更新任务正在运行")
	}
	snap, files, err := m.rt.legacySnapshot()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	m.cancel = cancel
	m.done = make(chan struct{})
	m.proposal = nil
	m.choicePlan = nil
	m.status = catalogUpdateStatus{OK: true, State: "checking", TaskID: catalogTaskID(), Phase: "正在读取官方图鉴", BaseRevision: snap.Revision, SourceURL: officialdex.SourceURL, Changes: []officialdex.Change{}, Issues: []officialdex.Issue{}, Summary: map[string]any{}}
	go m.check(ctx, m.done, files, snap.Data)
	return nil
}
func (m *catalogUpdateManager) check(ctx context.Context, done chan struct{}, files catalog.LegacyFiles, before []byte) {
	defer close(done)
	source, err := m.fetchSource(ctx)
	if err == nil {
		err = checkJSON(source)
	}
	if err != nil {
		m.fail(ctx, err)
		return
	}
	if err = validateOfficialCoverage(files.Monsters, source); err != nil {
		m.fail(ctx, err)
		return
	}
	m.mu.Lock()
	m.status.Phase = "正在核对身份、技能和本地保留项"
	m.mu.Unlock()
	current, err := catalog.Parse(before)
	var proposal *officialdex.Proposal
	if err == nil {
		proposal, err = officialdex.BuildCatalogProposal(current, source)
	}
	var plan *catalogChoicePlan
	if err == nil {
		plan, err = buildCatalogChoicePlan(before, proposal)
	}
	if err != nil {
		m.fail(ctx, err)
		return
	}
	if err = ctx.Err(); err != nil {
		m.fail(ctx, err)
		return
	}
	summary := map[string]any{}
	stats, _ := json.Marshal(proposal.Stats)
	_ = json.Unmarshal(stats, &summary)
	summary["changes"] = len(proposal.Changes)
	summary["issues"] = len(proposal.Issues)
	m.mu.Lock()
	defer m.mu.Unlock()
	if ctx.Err() != nil {
		m.status.State = "cancelled"
		m.status.Message = "已取消检查，现有资料未改变"
		return
	}
	m.proposal = proposal
	m.choicePlan = plan
	m.status.Candidates, m.status.AutomaticSourceChanges = plan.pending()
	m.status.State = "preview"
	m.status.Phase = "检查完成，请核对差异后确认"
	m.status.Changes = plan.visibleChanges(proposal.Changes)
	m.status.SourceBaselineActive = plan.baseline != nil
	summary["changes"] = len(m.status.Changes)
	m.status.Issues = plan.visibleIssues(proposal.Issues)
	summary["issues"] = len(m.status.Issues) // acknowledged baseline differences are not outstanding issues
	m.status.Summary = summary
	m.status.CanApply = !proposal.HasBlockingIssues()
	m.status.Message = "选择仅是草稿；点击应用才保存选择和资料。未选项保留本地。"
	if !m.status.CanApply {
		m.status.Message = "存在无法安全处理的冲突，已阻止应用；现有资料和手工编辑仍可使用。"
	}
}

// Large disappearance is a completeness alarm, not authorization to delete.
// Compare known source mappings where available, never a hard-coded game count.
func validateOfficialCoverage(monsters, source []byte) error {
	var local []struct {
		Ref *catalog.SourceRef `json:"_source_ref"`
	}
	var raw struct {
		Details map[string]json.RawMessage `json:"d"`
	}
	if err := json.Unmarshal(monsters, &local); err != nil {
		return err
	}
	if err := json.Unmarshal(source, &raw); err != nil {
		return err
	}
	known, present := 0, 0
	for _, m := range local {
		if m.Ref != nil && m.Ref.Provider == officialdex.Provider {
			known++
			if _, ok := raw.Details[m.Ref.ID]; ok {
				present++
			}
		}
	}
	if (known > 0 && present*5 < known*4) || (known == 0 && len(raw.Details)*2 < len(local)) {
		return errors.New("官方源的精灵覆盖范围异常减少，可能是不完整响应或接口变更；本次未应用，不会清空或删除本地资料")
	}
	return nil
}

func (m *catalogUpdateManager) fail(ctx context.Context, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.CanApply = false
	if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
		m.status.State = "cancelled"
		m.status.Message = "已取消，活动资料未改变"
		m.status.Error = ""
		return
	}
	m.status.State = "error"
	m.status.Error = err.Error()
	m.status.Message = "更新未提交，现有资料保持不变；可重试或使用精灵编辑。"
}
func (m *catalogUpdateManager) Cancel(taskID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if taskID == "" || taskID != m.status.TaskID {
		return errors.New("更新任务不匹配")
	}
	if m.status.Phase == "正在安全提交资料" {
		return errors.New("正在安全提交，请等待完成后再关闭")
	}
	if m.busy() {
		m.cancel()
		return nil
	}
	if m.status.State == "preview" {
		m.status.State = "cancelled"
		m.status.CanApply = false
		m.proposal = nil
		m.status.Message = "已放弃候选资料，活动资料未改变"
	}
	return nil
}
func (m *catalogUpdateManager) Apply(taskID, base string, ack bool, choices []catalogChoice) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.status.State != "preview" || m.proposal == nil || taskID == "" || taskID != m.status.TaskID {
		return errors.New("没有可应用的当前预览，请重新检查")
	}
	if !m.status.CanApply || m.proposal.HasBlockingIssues() {
		return errors.New("存在阻止应用的资料冲突")
	}
	if base == "" || base != m.status.BaseRevision || base != m.rt.store.Current().Revision {
		return catalogstore.ErrConflict
	}
	for _, issue := range m.status.Issues {
		if issue.Severity == "review" && !ack {
			return errors.New("请逐项检查待确认项；未解决项将保留本地并跳过")
		}
	}
	if m.choicePlan == nil {
		return errors.New("预览缺少候选，请重新检查")
	}
	candidate, images, err := m.choicePlan.resolve(choices)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	m.cancel = cancel
	m.done = make(chan struct{})
	m.status.State = "applying"
	m.status.CanApply = false
	m.status.Phase = "正在准备普通立绘"
	m.status.Completed = 0
	go m.apply(ctx, m.done, candidate, images, base)
	return nil
}
func (m *catalogUpdateManager) apply(ctx context.Context, done chan struct{}, c *catalog.Catalog, imageCandidates []officialdex.ImageCandidate, base string) {
	defer close(done)
	var err error
	if m.rt.store.Current().Revision != base {
		m.fail(ctx, catalogstore.ErrConflict)
		return
	}
	images, issues := m.prepareImages(ctx, c, imageCandidates)
	if err = ctx.Err(); err != nil {
		m.fail(ctx, err)
		return
	}
	data, err := catalog.Marshal(c)
	if err != nil {
		m.fail(ctx, err)
		return
	}
	m.rt.mutationMu.Lock()
	defer m.rt.mutationMu.Unlock()
	if err = ctx.Err(); err != nil {
		m.fail(ctx, err)
		return
	}
	m.mu.Lock()
	m.status.Phase = "正在安全提交资料"
	m.status.Issues = append(m.status.Issues, issues...)
	m.mu.Unlock()
	committed, err := m.rt.store.Commit(data, base, images)
	if err != nil {
		m.fail(ctx, err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status.State = "applied"
	m.status.CurrentRevision = committed.Revision
	m.status.Phase = "更新完成"
	m.status.Summary["images_downloaded"] = len(images)
	m.status.Message = "新资料已安全保存。请先保存其他页面的草稿，再重新载入资料；收藏、编队和个人设置未被清空。"
}

type catalogImageResult struct {
	candidate officialdex.ImageCandidate
	data      []byte
	config    image.Config
	format    string
	err       error
}

func (m *catalogUpdateManager) prepareImages(ctx context.Context, c *catalog.Catalog, candidates []officialdex.ImageCandidate) (map[string][]byte, []officialdex.Issue) {
	byID := map[int]*catalog.Monster{}
	for i := range c.Monsters {
		byID[c.Monsters[i].ID] = &c.Monsters[i]
	}
	selected := []officialdex.ImageCandidate{}
	seen := map[int]bool{}
	for _, item := range candidates {
		// A full-body compendium image must not replace an existing cropped avatar.
		if item.Purpose != "wiki" || seen[item.ID] || byID[item.ID] == nil {
			continue
		}
		seen[item.ID] = true
		selected = append(selected, item)
	}
	images := map[string][]byte{}
	issues := []officialdex.Issue{}
	if len(selected) > 2000 {
		return images, []officialdex.Issue{{Severity: "warning", Code: "image-limit", Entity: "image", Message: "图片候选超过安全上限，本次保留全部旧图。"}}
	}
	m.mu.Lock()
	m.status.Total = len(selected)
	m.mu.Unlock()
	jobs := make(chan officialdex.ImageCandidate)
	results := make(chan catalogImageResult)
	var workers sync.WaitGroup
	for i := 0; i < 4; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for item := range jobs {
				b, err := m.fetchImage(ctx, item.URL)
				var cfg image.Config
				format := ""
				if err == nil {
					cfg, format, err = image.DecodeConfig(bytes.NewReader(b))
					if err == nil && (format != "png" && format != "jpeg" || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 4096 || cfg.Height > 4096) {
						err = errors.New("图片格式或尺寸不符合安全限制")
					}
				}
				select {
				case results <- catalogImageResult{item, b, cfg, format, err}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, item := range selected {
			select {
			case jobs <- item:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { workers.Wait(); close(results) }()
	totalBytes := 0
	completed := 0
	for result := range results {
		completed++
		m.mu.Lock()
		m.status.Completed = completed
		m.status.Phase = "正在核对普通立绘"
		m.mu.Unlock()
		item := result.candidate
		monster := byID[item.ID]
		if result.err != nil {
			issues = append(issues, officialdex.Issue{Severity: "warning", Code: "image-unavailable", Entity: "image", ID: item.ID, Name: item.Name, Message: "官方图片未能下载或校验，本次保留旧图。"})
			continue
		}
		if old, err := m.rt.readImage(monster.Images.Portrait); err == nil {
			oldConfig, _, e := image.DecodeConfig(bytes.NewReader(old))
			if e == nil && (result.config.Width < oldConfig.Width || result.config.Height < oldConfig.Height || (result.config.Width == oldConfig.Width && result.config.Height == oldConfig.Height)) {
				continue
			}
		}
		if totalBytes+len(result.data) > 128<<20 {
			issues = append(issues, officialdex.Issue{Severity: "warning", Code: "image-budget", Entity: "image", ID: item.ID, Name: item.Name, Message: "达到图片批次大小限制，本次保留旧图。"})
			continue
		}
		// Decode pixels as well: dimensions alone do not prove a complete PNG/JPEG.
		if _, _, err := image.Decode(bytes.NewReader(result.data)); err != nil {
			issues = append(issues, officialdex.Issue{Severity: "warning", Code: "image-corrupt", Entity: "image", ID: item.ID, Name: item.Name, Message: "图片内容校验失败，保留旧图。"})
			continue
		}
		ext := "png"
		if result.format == "jpeg" {
			ext = "jpg"
		}
		name := catalogstore.Hash(result.data) + "." + ext
		if _, exists := images[name]; !exists {
			images[name] = result.data
			totalBytes += len(result.data)
		}
		monster.Images.Portrait = "assets/monster/images/catalog/" + name
		if monster.Images.Avatar == "" {
			monster.Images.Avatar = "catalog/" + name
		}
	}
	return images, issues
}
func (rt *catalogRuntime) readImage(raw string) ([]byte, error) {
	if raw == "" {
		return nil, os.ErrNotExist
	}
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" {
		return nil, os.ErrNotExist
	}
	name := sanitizeStaticPath(u.Path)
	if !strings.HasPrefix(name, "assets/") {
		return nil, os.ErrNotExist
	}
	if data, handled, e := rt.staticData(name); handled {
		return data, e
	}
	return appReadFile(name)
}
func (m *catalogUpdateManager) Close() {
	m.mu.Lock()
	done := m.done
	if m.cancel != nil && m.status.Phase != "正在安全提交资料" {
		m.cancel()
	}
	m.mu.Unlock()
	if done != nil {
		<-done
	}
	if transport, ok := m.client.Transport.(*http.Transport); ok {
		transport.CloseIdleConnections()
	}
}
func (rt *catalogRuntime) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	if rt.initErr != nil || rt.update == nil {
		err := rt.initErr
		if err == nil {
			err = errors.New("图鉴更新服务尚未初始化")
		}
		configError(w, 503, err)
		return
	}
	operation := strings.TrimPrefix(r.URL.Path, "/api/catalog/update/")
	var err error
	if (operation == "status" || operation == "choices") && r.Method == http.MethodGet {
		out, _ := json.Marshal(rt.update.Status())
		writeJSON(w, 200, out)
		return
	}
	if r.Method != http.MethodPost {
		configError(w, 405, errors.New("只支持相应的GET或POST操作"))
		return
	}
	// Key/choice arrays may cover a full catalog; bounded and still far smaller
	// than accepting client-provided catalog values.
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	b, e := io.ReadAll(r.Body)
	if e != nil {
		configError(w, 400, e)
		return
	}
	if e = checkJSON(b); e != nil {
		configError(w, 400, e)
		return
	}
	var req struct {
		TaskID             string          `json:"task_id"`
		BaseRevision       string          `json:"base_revision"`
		AcknowledgeReviews bool            `json:"acknowledge_reviews"`
		Choices            []catalogChoice `json:"choices"`
		Keys               []string        `json:"keys"`
		All                bool            `json:"all"`
	}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&req); e != nil {
		configError(w, 400, e)
		return
	}
	switch operation {
	case "check":
		err = rt.update.Start()
	case "cancel":
		err = rt.update.Cancel(req.TaskID)
	case "apply":
		err = rt.update.Apply(req.TaskID, req.BaseRevision, req.AcknowledgeReviews, req.Choices)
	case "choices/clear":
		err = rt.update.ClearChoices(req.BaseRevision, req.Keys, req.All)
	default:
		configError(w, 404, errors.New("未知更新操作"))
		return
	}
	if err != nil {
		status := 409
		if !errors.Is(err, catalogstore.ErrConflict) && operation == "check" {
			status = 400
		}
		configError(w, status, err)
		return
	}
	out, _ := json.Marshal(rt.update.Status())
	writeJSON(w, 200, out)
}
