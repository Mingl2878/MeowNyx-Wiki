package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
)

// All fixtures, snapshots, assets and backups stay under t.TempDir. Never call
// initCatalogRuntime/getUserDataDir, start a server, or make a network request.
type catalogTestObject = map[string]any
type catalogTestFixture struct {
	rt     *catalogRuntime
	opts   catalogstore.Options
	assets string
}

func catalogTestJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func catalogTestLegacy(t *testing.T, count int, refs bool) catalog.LegacyFiles {
	t.Helper()
	typ := catalogTestObject{"id": 1, "name": "Normal", "localized": catalogTestObject{"zh": "普通"}, "vulnerable_to": []any{}, "resistant_to": []any{}}
	monsters := []any{}
	wiki := catalogTestObject{}
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("测试精灵%d", i)
		m := catalogTestObject{"id": i, "dex_number": i, "localized": catalogTestObject{"zh": catalogTestObject{"name": name}}, "base_hp": 90, "base_phy_atk": 90, "base_phy_def": 90, "base_mag_atk": 90, "base_mag_def": 90, "base_spd": 90, "main_type": typ, "sub_type": nil, "trait": catalogTestObject{"localized": catalogTestObject{"zh": catalogTestObject{"name": "测试特性", "description": "本地特性说明"}}}, "image": "", "form": "default", "form_category": "无多形态", "main_form_name": "", "evolution_stage": "高级形态", "evolution_chain_name": "", "evolves_from_id": nil, "is_leader_form": false, "learnset_mode": "own", "season": "本地赛季"}
		if refs {
			m["_source_ref"] = catalogTestObject{"provider": officialdex.Provider, "id": fmt.Sprint(100 + i), "identity": fmt.Sprintf("NO.%03d|%s|", i, name)}
		}
		monsters = append(monsters, m)
		wiki[name] = catalogTestObject{"monster_id": i, "image": "", "skills": []any{catalogTestObject{"name": "冲撞", "source": "默认", "desc": "本地技能说明", "type": "物攻", "element": "普通"}}}
	}
	moves := []any{catalogTestObject{"id": 3, "localized": catalogTestObject{"zh": catalogTestObject{"name": "冲撞", "description": "本地技能说明"}}, "move_type": typ, "move_category": "Physical Attack", "energy_cost": 1, "power": 60, "base_combo": nil, "power_formula": nil, "season": "本地赛季"}}
	return catalog.LegacyFiles{Monsters: catalogTestJSON(t, monsters), Moves: catalogTestJSON(t, moves), Types: catalogTestJSON(t, []any{typ}), Wiki: catalogTestJSON(t, wiki)}
}
func catalogTestNew(t *testing.T, count int, refs bool, replace func(string, string) error) *catalogTestFixture {
	t.Helper()
	legacy := catalogTestLegacy(t, count, refs)
	c, e := catalog.ImportLegacy(legacy)
	if e != nil {
		t.Fatal(e)
	}
	baseline, e := catalog.Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	assets := filepath.Join(dir, "bundled")
	if e = os.MkdirAll(assets, 0700); e != nil {
		t.Fatal(e)
	}
	oldFS, oldRoot := appFS, appRoot
	appFS, appRoot = os.DirFS(assets), ""
	t.Cleanup(func() { appFS, appRoot = oldFS, oldRoot })
	if replace == nil {
		replace = catalogstore.ReplaceFile
	}
	opts := catalogstore.Options{Root: filepath.Join(dir, "catalog"), BackupDir: filepath.Join(dir, "isolated-backups"), Baseline: baseline, Replace: replace, Validate: func(b []byte) error { _, e := catalog.Parse(b); return e }}
	store, e := catalogstore.Open(opts)
	if e != nil {
		t.Fatal(e)
	}
	rt := &catalogRuntime{store: store}
	rt.update = newCatalogUpdateManager(rt)
	rt.update.fetchSource = func(context.Context) ([]byte, error) { return nil, errors.New("test source not injected") }
	rt.update.fetchImage = func(context.Context, string) ([]byte, error) { return nil, errors.New("test image not injected") }
	t.Cleanup(rt.update.Close)
	return &catalogTestFixture{rt, opts, assets}
}
func catalogTestSource(t *testing.T, count int, images bool) []byte {
	t.Helper()
	d := catalogTestObject{}
	l := []any{}
	for i := 1; i <= count; i++ {
		name := fmt.Sprintf("测试精灵%d", i)
		no := fmt.Sprintf("NO.%03d", i)
		row := catalogTestObject{"n": no, "nm": name, "fn": name, "f": "", "e": "普通", "e2": "", "s": "最终形态", "hp": 100, "atk": 101, "matk": 102, "df": 103, "mdf": 104, "spd": 105, "rt": 615, "tn": "官方测试特性", "te": "官方特性说明", "forms": []any{}, "evo": []any{}, "sk": catalogTestObject{"s": []any{catalogTestObject{"nm": "冲撞", "tp": "物攻", "el": "普通", "ec": "2", "pw": "75", "ef": "官方技能说明", "lv": "20"}}, "b": []any{}, "t": []any{}}}
		if images {
			row["img"] = "a/i/explicit.png?v=abcd"
		}
		d[fmt.Sprint(100+i)] = row
		l = append(l, catalogTestObject{"i": 100 + i, "n": no, "nm": name, "fn": name, "f": ""})
	}
	return catalogTestJSON(t, catalogTestObject{"l": l, "d": d, "e": []any{"普通"}})
}
func catalogTestWait(t *testing.T, m *catalogUpdateManager) {
	t.Helper()
	m.mu.Lock()
	done := m.done
	m.mu.Unlock()
	if done == nil {
		t.Fatal("task did not create completion channel")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("catalog task did not finish")
	}
}
func catalogTestSignal(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("catalog test synchronization timed out")
	}
}
func catalogTestRequest(method, path string, body []byte) *http.Request {
	r := httptest.NewRequest(method, "http://127.0.0.1:8788"+path, bytes.NewReader(body))
	if method == http.MethodPost {
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}
func catalogTestUpdate(t *testing.T, rt *catalogRuntime, operation string, body any) *httptest.ResponseRecorder {
	t.Helper()
	r := catalogTestRequest(http.MethodPost, "/api/catalog/update/"+operation, catalogTestJSON(t, body))
	w := httptest.NewRecorder()
	rt.handleUpdate(w, r)
	return w
}
func catalogTestStatus(t *testing.T, rt *catalogRuntime) catalogUpdateStatus {
	t.Helper()
	w := httptest.NewRecorder()
	rt.handleUpdate(w, catalogTestRequest(http.MethodGet, "/api/catalog/update/status", nil))
	if w.Code != 200 {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
	var out catalogUpdateStatus
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func catalogTestPreview(t *testing.T, fx *catalogTestFixture, source []byte) catalogUpdateStatus {
	t.Helper()
	fx.rt.update.fetchSource = func(context.Context) ([]byte, error) { return bytes.Clone(source), nil }
	w := catalogTestUpdate(t, fx.rt, "check", catalogTestObject{})
	if w.Code != 200 {
		t.Fatalf("check: %d %s", w.Code, w.Body.String())
	}
	catalogTestWait(t, fx.rt.update)
	s := catalogTestStatus(t, fx.rt)
	if s.State != "preview" {
		t.Fatalf("expected preview, got %+v", s)
	}
	return s
}

// Explicit test-only administrator selection; HTTP never defaults to all-source.
func catalogTestSourceChoices(s catalogUpdateStatus) []catalogChoice {
	choices := []catalogChoice{}
	for _, item := range s.Candidates {
		if item.SourceAvailable {
			choices = append(choices, catalogChoice{Key: item.Key, Choice: "source"})
		}
	}
	return choices
}
func catalogTestApply(t *testing.T, fx *catalogTestFixture, s catalogUpdateStatus) catalogUpdateStatus {
	t.Helper()
	w := catalogTestUpdate(t, fx.rt, "apply", catalogTestObject{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": catalogTestSourceChoices(s)})
	if w.Code != 200 {
		t.Fatalf("apply: %d %s", w.Code, w.Body.String())
	}
	catalogTestWait(t, fx.rt.update)
	return catalogTestStatus(t, fx.rt)
}
func catalogTestNoWrite(t *testing.T, fx *catalogTestFixture, before catalogstore.Snapshot) {
	t.Helper()
	now := fx.rt.store.Current()
	if now.Revision != before.Revision || !bytes.Equal(now.Data, before.Data) {
		t.Fatal("noncommitting operation changed active catalog")
	}
	for _, p := range []string{fx.opts.Root, fx.opts.BackupDir} {
		if _, e := os.Stat(p); !errors.Is(e, os.ErrNotExist) {
			t.Fatalf("read/check unexpectedly created %s: %v", p, e)
		}
	}
}
func catalogTestData(t *testing.T, rt *catalogRuntime) catalogTestObject {
	t.Helper()
	w := httptest.NewRecorder()
	rt.handleData(w, catalogTestRequest(http.MethodGet, "/api/catalog/data", nil))
	if w.Code != 200 {
		t.Fatalf("data: %d %s", w.Code, w.Body.String())
	}
	var out catalogTestObject
	if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	return out
}

func TestCatalogUpdateIntegrationPreviewApplyAndStableRepeat(t *testing.T) {
	fx := catalogTestNew(t, 2, false, nil)
	before := fx.rt.store.Current()
	var imageCalls atomic.Int32
	fx.rt.update.fetchImage = func(context.Context, string) ([]byte, error) { imageCalls.Add(1); return nil, errors.New("unused") }
	s := catalogTestPreview(t, fx, catalogTestSource(t, 2, false))
	if !s.CanApply || s.BaseRevision != before.Revision || len(s.Changes) == 0 {
		t.Fatalf("bad preview %+v", s)
	}
	catalogTestNoWrite(t, fx, before)
	if imageCalls.Load() != 0 {
		t.Fatal("preview downloaded assets")
	}
	if catalogTestData(t, fx.rt)["revision"] != before.Revision {
		t.Fatal("preview leaked into data view")
	}
	bad := catalogTestUpdate(t, fx.rt, "apply", catalogTestObject{"task_id": "wrong", "base_revision": before.Revision})
	if bad.Code != 409 {
		t.Fatal("wrong task applied")
	}
	applied := catalogTestApply(t, fx, s)
	if applied.State != "applied" || applied.Error != "" {
		t.Fatalf("apply failed %+v", applied)
	}
	after := fx.rt.store.Current()
	if after.Revision == before.Revision || after.Revision != applied.CurrentRevision {
		t.Fatal("new catalog did not publish one revision")
	}
	c, e := catalog.Parse(after.Data)
	if e != nil {
		t.Fatal(e)
	}
	if c.Monsters[0].ID != 1 || c.Monsters[0].Stats.HP != 100 || c.Skills[0].ID != 3 || *c.Skills[0].Power != 75 {
		t.Fatal("updated values or IDs incorrect")
	}
	backup, e := os.ReadFile(filepath.Join(fx.opts.BackupDir, before.Revision+".json"))
	if e != nil || !bytes.Equal(backup, before.Data) {
		t.Fatal("exact previous revision backup missing", e)
	}
	reopened, e := catalogstore.Open(fx.opts)
	if e != nil || reopened.Current().Revision != after.Revision {
		t.Fatal("reopen lost committed revision", e)
	}
	if catalogTestData(t, fx.rt)["revision"] != after.Revision {
		t.Fatal("data response not pinned to active revision")
	}
	if w := catalogTestUpdate(t, fx.rt, "apply", catalogTestObject{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": catalogTestSourceChoices(s)}); w.Code != 409 {
		t.Fatal("duplicate apply accepted")
	}
	s = catalogTestPreview(t, fx, catalogTestSource(t, 2, false))
	if len(s.Changes) != 0 {
		t.Fatalf("repeat import not idempotent: %+v", s.Changes)
	}
	if err := fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, []catalogChoice{}); err == nil || fx.rt.store.Current().Revision != after.Revision {
		t.Fatal("empty repeat must not silently apply or commit")
	}
}

func TestCatalogUpdateIntegrationHTTPGuardsAndBadTasks(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	calls := 0
	fx.rt.update.fetchSource = func(context.Context) ([]byte, error) { calls++; return nil, errors.New("unexpected") }
	for _, tc := range []struct {
		name, method, path, body string
		mutate                   func(*http.Request)
		want                     int
	}{
		{"origin", http.MethodPost, "check", "{}", func(r *http.Request) { r.Header.Set("Origin", "http://evil.invalid") }, 403},
		{"cross-site", http.MethodPost, "check", "{}", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"host", http.MethodPost, "check", "{}", func(r *http.Request) { r.Host = "evil.invalid:8788" }, 403},
		{"content-type", http.MethodPost, "check", "{}", func(r *http.Request) { r.Header.Set("Content-Type", "text/plain") }, 415},
		{"malformed", http.MethodPost, "check", "<html>", nil, 400},
		{"unknown-url", http.MethodPost, "check", `{"url":"https://evil.invalid"}`, nil, 400},
		{"duplicate", http.MethodPost, "check", `{"task_id":"a","task_id":"b"}`, nil, 400},
		{"method", http.MethodGet, "check", "", nil, 405},
		{"route", http.MethodPost, "unknown", "{}", nil, 404},
		{"cancel-task", http.MethodPost, "cancel", `{"task_id":"wrong"}`, nil, 409},
		{"no-preview", http.MethodPost, "apply", `{"task_id":"wrong","base_revision":"bad"}`, nil, 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := catalogTestRequest(tc.method, "/api/catalog/update/"+tc.path, []byte(tc.body))
			if tc.mutate != nil {
				tc.mutate(r)
			}
			w := httptest.NewRecorder()
			fx.rt.handleUpdate(w, r)
			if w.Code != tc.want {
				t.Fatalf("got %d want %d: %s", w.Code, tc.want, w.Body.String())
			}
		})
	}
	if calls != 0 {
		t.Fatal("invalid local request started remote work")
	}
	catalogTestNoWrite(t, fx, before)
	if s := catalogTestStatus(t, fx.rt); s.State != "idle" {
		t.Fatal("invalid request mutated state")
	}
}

func TestCatalogUpdateIntegrationMalformedAndReducedSourceKeepOld(t *testing.T) {
	for _, tc := range []struct {
		name   string
		count  int
		refs   bool
		source func(*testing.T) []byte
		err    error
	}{
		{"transport", 2, false, nil, errors.New("offline")},
		{"html", 2, false, func(*testing.T) []byte { return []byte("<html>502</html>") }, nil},
		{"schema", 2, false, func(*testing.T) []byte { return []byte(`{"d":[],"l":[]}`) }, nil},
		{"unmapped-coverage", 6, false, func(t *testing.T) []byte { return catalogTestSource(t, 1, false) }, nil},
		{"mapped-coverage", 5, true, func(t *testing.T) []byte { return catalogTestSource(t, 3, false) }, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fx := catalogTestNew(t, tc.count, tc.refs, nil)
			before := fx.rt.store.Current()
			fx.rt.update.fetchSource = func(context.Context) ([]byte, error) {
				if tc.err != nil {
					return nil, tc.err
				}
				return tc.source(t), nil
			}
			w := catalogTestUpdate(t, fx.rt, "check", catalogTestObject{})
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			catalogTestWait(t, fx.rt.update)
			s := catalogTestStatus(t, fx.rt)
			if s.State != "error" || s.CanApply || s.Error == "" {
				t.Fatalf("invalid source not an explicit error: %+v", s)
			}
			catalogTestNoWrite(t, fx, before)
		})
	}
}

func TestCatalogUpdateIntegrationCancelCheckPreviewAndImageStage(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	started := make(chan struct{})
	fx.rt.update.fetchSource = func(ctx context.Context) ([]byte, error) { close(started); <-ctx.Done(); return nil, ctx.Err() }
	if e := fx.rt.update.Start(); e != nil {
		t.Fatal(e)
	}
	catalogTestSignal(t, started)
	s := catalogTestStatus(t, fx.rt)
	if e := fx.rt.update.Start(); e == nil {
		t.Fatal("parallel check accepted")
	}
	if e := fx.rt.update.Cancel("wrong"); e == nil {
		t.Fatal("wrong cancellation task accepted")
	}
	if e := fx.rt.update.Cancel(s.TaskID); e != nil {
		t.Fatal(e)
	}
	catalogTestWait(t, fx.rt.update)
	if catalogTestStatus(t, fx.rt).State != "cancelled" {
		t.Fatal("cancelled check published preview")
	}
	catalogTestNoWrite(t, fx, before)
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	if e := fx.rt.update.Cancel(s.TaskID); e != nil {
		t.Fatal(e)
	}
	if catalogTestStatus(t, fx.rt).CanApply {
		t.Fatal("cancelled preview applicable")
	}
	if e := fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); e == nil {
		t.Fatal("cancelled preview applied")
	}
	imageStarted := make(chan struct{})
	var once sync.Once
	fx.rt.update.fetchImage = func(ctx context.Context, _ string) ([]byte, error) {
		once.Do(func() { close(imageStarted) })
		<-ctx.Done()
		return nil, ctx.Err()
	}
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, true))
	if e := fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); e != nil {
		t.Fatal(e)
	}
	catalogTestSignal(t, imageStarted)
	if e := fx.rt.update.Cancel(s.TaskID); e != nil {
		t.Fatal(e)
	}
	catalogTestWait(t, fx.rt.update)
	if catalogTestStatus(t, fx.rt).State != "cancelled" {
		t.Fatal("cancelled image stage applied")
	}
	catalogTestNoWrite(t, fx, before)
}

func catalogTestManualBody(revision string, hp int) catalogTestObject {
	return catalogTestObject{"base_revision": revision, "id": 1, "base_hp": hp, "base_phy_atk": 90, "base_phy_def": 90, "base_mag_atk": 90, "base_mag_def": 90, "base_spd": 90, "main_type": "Normal", "sub_type": "", "evolution_stage": "高级形态", "form_category": "无多形态", "main_form_name": "", "evolves_from_id": nil, "trait_name": "手工特性", "trait_desc": "手工特性说明"}
}
func catalogTestManual(t *testing.T, rt *catalogRuntime, kind string, body any) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	rt.handleManual(w, catalogTestRequest(http.MethodPost, "/api/edit-monster", catalogTestJSON(t, body)), kind)
	return w
}
func TestCatalogUpdateIntegrationManualKeepsLearningAndRejectsStalePreview(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	c, e := catalog.Parse(before.Data)
	if e != nil {
		t.Fatal(e)
	}
	oldLearn := catalogTestJSON(t, c.Learnsets)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	w := catalogTestManual(t, fx.rt, "edit", catalogTestManualBody(before.Revision, 123))
	if w.Code != 200 {
		t.Fatalf("complete manual form failed: %d %s", w.Code, w.Body.String())
	}
	after := fx.rt.store.Current()
	if after.Revision == before.Revision {
		t.Fatal("manual edit not committed")
	}
	c, e = catalog.Parse(after.Data)
	if e != nil {
		t.Fatal(e)
	}
	if c.Monsters[0].Stats.HP != 123 || !bytes.Equal(catalogTestJSON(t, c.Learnsets), oldLearn) {
		t.Fatal("manual stats edit cleared or changed learning")
	}
	b, e := os.ReadFile(filepath.Join(fx.opts.BackupDir, before.Revision+".json"))
	if e != nil || !bytes.Equal(b, before.Data) {
		t.Fatal("manual edit not backed up", e)
	}
	if e = fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); !errors.Is(e, catalogstore.ErrConflict) {
		t.Fatal("old preview overwrote manual edit", e)
	}
	w = catalogTestManual(t, fx.rt, "edit", catalogTestManualBody(before.Revision, 140))
	if w.Code != 409 {
		t.Fatal("stale manual form accepted")
	}
	if fx.rt.store.Current().Revision != after.Revision {
		t.Fatal("rejected stale form changed catalog")
	}
	bad := catalogTestManualBody(after.Revision, 141)
	bad["skillList"] = []any{}
	w = catalogTestManual(t, fx.rt, "edit", bad)
	if w.Code < 400 || fx.rt.store.Current().Revision != after.Revision {
		t.Fatal("empty learning cleared without consent")
	}
}

func TestCatalogUpdateIntegrationReplaceFailurePreservesSnapshotAndBackup(t *testing.T) {
	fx := catalogTestNew(t, 1, false, func(from, to string) error {
		if filepath.Base(to) == "current.json" {
			return errors.New("injected pointer replacement failure")
		}
		return catalogstore.ReplaceFile(from, to)
	})
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	out := catalogTestApply(t, fx, s)
	if out.State != "error" || out.Error == "" || fx.rt.store.Current().Revision != before.Revision {
		t.Fatal("failed commit reported success or changed memory")
	}
	b, e := os.ReadFile(filepath.Join(fx.opts.BackupDir, before.Revision+".json"))
	if e != nil || !bytes.Equal(b, before.Data) {
		t.Fatal("commit failure lost exact backup", e)
	}
	reopened, e := catalogstore.Open(fx.opts)
	if e != nil || reopened.Current().Revision != before.Revision {
		t.Fatal("commit failure changed active disk revision", e)
	}
}

func TestCatalogUpdateIntegrationCommitCannotBeCancelledHalfway(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	fx := catalogTestNew(t, 1, false, func(from, to string) error {
		if filepath.Base(to) == "current.json" {
			once.Do(func() { close(entered) })
			<-release
		}
		return catalogstore.ReplaceFile(from, to)
	})
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	if e := fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); e != nil {
		t.Fatal(e)
	}
	catalogTestSignal(t, entered)
	err := fx.rt.update.Cancel(s.TaskID)
	close(release)
	if err == nil {
		t.Fatal("cancellation allowed halfway through atomic commit")
	}
	catalogTestWait(t, fx.rt.update)
	if catalogTestStatus(t, fx.rt).State != "applied" {
		t.Fatal("protected commit did not finish")
	}
}

// RoundTripper fixtures exercise URL/status/size/redirect policy without sockets.
type catalogTestTransport func(*http.Request) (*http.Response, error)

func (f catalogTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func catalogTestResponse(code int, body string) *http.Response {
	return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), ContentLength: -1}
}
func TestCatalogUpdateIntegrationOfficialHTTPBoundary(t *testing.T) {
	var calls atomic.Int32
	client := newOfficialCatalogClient()
	client.Transport = catalogTestTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return catalogTestResponse(200, "{}"), nil
	})
	for _, raw := range []string{"http://static.gamecenter.qq.com/xgame/roco-kingdom/compendium/d.json", "https://evil.invalid/d.json", "https://static.gamecenter.qq.com/other/d.json", "https://static.gamecenter.qq.com/xgame/roco-kingdom/compendium/../../outside.png", "https://static.gamecenter.qq.com/xgame/roco-kingdom/compendium/%2e%2e/outside.png", "https://user@static.gamecenter.qq.com/xgame/roco-kingdom/compendium/d.json"} {
		if _, e := fetchOfficialBytes(context.Background(), client, raw, 100); e == nil {
			t.Fatalf("unsafe URL fetched %s", raw)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unsafe URL reached transport")
	}
	for _, tc := range []struct {
		name     string
		response func() *http.Response
		limit    int64
	}{{"status", func() *http.Response { return catalogTestResponse(503, "service failure") }, 100}, {"empty", func() *http.Response { return catalogTestResponse(200, "") }, 100}, {"chunked-size", func() *http.Response { return catalogTestResponse(200, "123456") }, 5}, {"declared-size", func() *http.Response { r := catalogTestResponse(200, "x"); r.ContentLength = 200; return r }, 100}} {
		t.Run(tc.name, func(t *testing.T) {
			client.Transport = catalogTestTransport(func(*http.Request) (*http.Response, error) { return tc.response(), nil })
			if _, e := fetchOfficialBytes(context.Background(), client, officialdex.SourceURL, tc.limit); e == nil {
				t.Fatal("invalid HTTP response accepted")
			}
		})
	}
	calls.Store(0)
	client.Transport = catalogTestTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		resp := catalogTestResponse(302, "")
		resp.Header.Set("Location", "https://evil.invalid/payload")
		return resp, nil
	})
	if _, e := fetchOfficialBytes(context.Background(), client, officialdex.SourceURL, 100); e == nil {
		t.Fatal("cross-host redirect accepted")
	}
	if calls.Load() != 1 {
		t.Fatal("cross-host redirect reached another transport request")
	}
}

func catalogTestImage(t *testing.T, width, height int, format string) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	var b bytes.Buffer
	var e error
	switch format {
	case "png":
		e = png.Encode(&b, img)
	case "jpeg":
		e = jpeg.Encode(&b, img, nil)
	case "gif":
		e = gif.Encode(&b, img, nil)
	default:
		t.Fatal("unknown test image format")
	}
	if e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestCatalogUpdateIntegrationImagesDecodeAndNeverDownscale(t *testing.T) {
	for _, tc := range []struct {
		name          string
		width, height int
		format        string
		corrupt       bool
		want          bool
		issue         string
	}{{"smaller", 32, 32, "png", false, false, ""}, {"same", 64, 64, "png", false, false, ""}, {"one-dimension-smaller", 32, 128, "png", false, false, ""}, {"larger", 128, 128, "png", false, true, ""}, {"jpeg", 128, 128, "jpeg", false, true, ""}, {"wrong-format", 128, 128, "gif", false, false, "image-unavailable"}, {"too-wide", 4097, 1, "png", false, false, "image-unavailable"}, {"truncated-pixels", 128, 128, "png", true, false, "image-corrupt"}} {
		t.Run(tc.name, func(t *testing.T) {
			fx := catalogTestNew(t, 1, false, nil)
			c, e := catalog.Parse(fx.rt.store.Current().Data)
			if e != nil {
				t.Fatal(e)
			}
			c.Monsters[0].Images.Avatar = "keep-avatar.png"
			c.Monsters[0].Images.Portrait = "assets/old.png"
			old := catalogTestImage(t, 64, 64, "png")
			oldPath := filepath.Join(fx.assets, "assets", "old.png")
			if e = os.MkdirAll(filepath.Dir(oldPath), 0700); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(oldPath, old, 0600); e != nil {
				t.Fatal(e)
			}
			incoming := catalogTestImage(t, tc.width, tc.height, tc.format)
			if tc.corrupt {
				incoming = incoming[:len(incoming)-12]
			}
			fx.rt.update.fetchImage = func(context.Context, string) ([]byte, error) { return incoming, nil }
			candidate := officialdex.ImageCandidate{ID: 1, Name: "测试精灵1", Purpose: "wiki", URL: officialdex.ImageBaseURL + "a/i/new.png?v=abcd"}
			images, issues := fx.rt.update.prepareImages(context.Background(), c, []officialdex.ImageCandidate{candidate, {ID: 1, Purpose: "monster", URL: candidate.URL}})
			if (len(images) == 1) != tc.want {
				t.Fatalf("image acceptance=%d want=%v issues=%+v", len(images), tc.want, issues)
			}
			if c.Monsters[0].Images.Avatar != "keep-avatar.png" {
				t.Fatal("full-body image replaced cropped avatar")
			}
			if !tc.want && c.Monsters[0].Images.Portrait != "assets/old.png" {
				t.Fatal("rejected image replaced portrait")
			}
			if tc.want && !strings.HasPrefix(c.Monsters[0].Images.Portrait, "assets/monster/images/catalog/") {
				t.Fatal("accepted image not content-addressed")
			}
			if tc.issue != "" {
				found := false
				for _, i := range issues {
					found = found || i.Code == tc.issue
				}
				if !found {
					t.Fatalf("missing %s: %+v", tc.issue, issues)
				}
			}
			if b, e := os.ReadFile(oldPath); e != nil || !bytes.Equal(b, old) {
				t.Fatal("bundled original image modified", e)
			}
		})
	}
}

func TestCatalogUpdateIntegrationUntrustedImageSourceNeverDownloads(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	var src catalogTestObject
	if e := json.Unmarshal(catalogTestSource(t, 1, true), &src); e != nil {
		t.Fatal(e)
	}
	src["d"].(map[string]any)["101"].(map[string]any)["img"] = "https://evil.invalid/payload.png"
	var calls atomic.Int32
	fx.rt.update.fetchImage = func(context.Context, string) ([]byte, error) { calls.Add(1); return nil, errors.New("must not fetch") }
	s := catalogTestPreview(t, fx, catalogTestJSON(t, src))
	out := catalogTestApply(t, fx, s)
	if out.State != "applied" || calls.Load() != 0 {
		t.Fatal("untrusted source image was fetched")
	}
}

func TestCatalogUpdateIntegrationManualCreateAndUnknownType(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	body := catalogTestManualBody(before.Revision, 123)
	body["main_type"] = "NotAType"
	if w := catalogTestManual(t, fx.rt, "edit", body); w.Code < 400 || fx.rt.store.Current().Revision != before.Revision {
		t.Fatal("unknown manual type was accepted or guessed")
	}
	newMove := catalogTestObject{"base_revision": before.Revision, "name": "手工新技能", "type": "Normal", "category": "物攻", "power": 88, "energy": 2, "combo": 0, "description": "手工提供的描述"}
	w := catalogTestManual(t, fx.rt, "add-move", newMove)
	if w.Code != 200 {
		t.Fatalf("manual move create failed: %d %s", w.Code, w.Body.String())
	}
	current := fx.rt.store.Current()
	c, e := catalog.Parse(current.Data)
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Skills) != 2 || c.Skills[1].ID != 4 || c.Skills[1].TypeID != 1 {
		t.Fatal("manual move identity/type lost")
	}
	if len(c.SkillRules) != 0 {
		t.Fatal("zero combo became a guessed rule")
	}
	body = catalogTestManualBody(current.Revision, 120)
	delete(body, "id")
	body["name"] = "手工新精灵"
	w = catalogTestManual(t, fx.rt, "add-monster", body)
	if w.Code != 200 {
		t.Fatalf("manual monster create failed: %d %s", w.Code, w.Body.String())
	}
	c, e = catalog.Parse(fx.rt.store.Current().Data)
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Monsters) != 2 || c.Monsters[1].ID != 2 || c.Monsters[1].TypeIDs[0] != 1 || len(c.Learnsets) != 2 || c.Learnsets[1].Mode != "own" || len(c.Learnsets[1].Skills) != 0 {
		t.Fatal("new monster lacks explicitly owned empty learning face")
	}
}

func TestCatalogUpdateIntegrationManualPreservesExplicitInheritance(t *testing.T) {
	fx := catalogTestNew(t, 2, false, nil)
	old := fx.rt.store.Current()
	c, e := catalog.Parse(old.Data)
	if e != nil {
		t.Fatal(e)
	}
	c.Learnsets[1].Mode = "inherit"
	c.Learnsets[1].FromID = 1
	c.Learnsets[1].Skills = []catalog.LearnedSkill{}
	data, e := catalog.Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	snap, e := fx.rt.store.Commit(data, old.Revision, nil)
	if e != nil {
		t.Fatal(e)
	}
	learning := catalogTestJSON(t, c.Learnsets)
	body := catalogTestManualBody(snap.Revision, 130)
	body["id"] = 2
	w := catalogTestManual(t, fx.rt, "edit", body)
	if w.Code != 200 {
		t.Fatalf("inherit manual edit: %d %s", w.Code, w.Body.String())
	}
	c, e = catalog.Parse(fx.rt.store.Current().Data)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(learning, catalogTestJSON(t, c.Learnsets)) || c.Monsters[0].Stats.HP != 90 || c.Monsters[1].Stats.HP != 130 {
		t.Fatal("unrelated/ancestor learning or stats polluted")
	}
}

func TestCatalogUpdateIntegrationReviewAcknowledgmentAndBlockingConflict(t *testing.T) {
	fx := catalogTestNew(t, 2, false, nil)
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	if e := fx.rt.update.Apply(s.TaskID, s.BaseRevision, false, catalogTestSourceChoices(s)); e == nil {
		t.Fatal("review applied without acknowledgement")
	}
	catalogTestNoWrite(t, fx, before)
	if out := catalogTestApply(t, fx, s); out.State != "applied" {
		t.Fatalf("acknowledged safe partial failed: %+v", out)
	}
	c, e := catalog.Parse(fx.rt.store.Current().Data)
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Monsters) != 2 || c.Monsters[1].Stats.HP != 90 {
		t.Fatal("local-only monster removed or updated")
	}
	var src catalogTestObject
	if e = json.Unmarshal(catalogTestSource(t, 2, false), &src); e != nil {
		t.Fatal(e)
	}
	row := src["d"].(map[string]any)["102"].(map[string]any)
	row["sk"].(map[string]any)["s"].([]any)[0].(map[string]any)["pw"] = "999"
	s = catalogTestPreview(t, fx, catalogTestJSON(t, src))
	revision := fx.rt.store.Current().Revision
	if s.CanApply {
		t.Fatal("conflicting same-name skill allowed apply")
	}
	if e = fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); e == nil || fx.rt.store.Current().Revision != revision {
		t.Fatal("acknowledgement bypassed a blocking conflict")
	}
}

func TestCatalogUpdateIntegrationManualCommitFailureNeverReportsSuccess(t *testing.T) {
	fx := catalogTestNew(t, 1, false, func(from, to string) error {
		if filepath.Base(to) == "current.json" {
			return errors.New("manual pointer failure")
		}
		return catalogstore.ReplaceFile(from, to)
	})
	before := fx.rt.store.Current()
	w := catalogTestManual(t, fx.rt, "edit", catalogTestManualBody(before.Revision, 150))
	if w.Code < 400 || fx.rt.store.Current().Revision != before.Revision || strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("failed manual commit reported success: %d %s", w.Code, w.Body.String())
	}
	backup, e := os.ReadFile(filepath.Join(fx.opts.BackupDir, before.Revision+".json"))
	if e != nil || !bytes.Equal(backup, before.Data) {
		t.Fatal("manual failure lacks original backup", e)
	}
}

func TestCatalogUpdateIntegrationUnavailableRuntimeAndDataGuards(t *testing.T) {
	rt := &catalogRuntime{initErr: errors.New("invalid canonical data")}
	w := httptest.NewRecorder()
	rt.handleData(w, catalogTestRequest(http.MethodGet, "/api/catalog/data", nil))
	if w.Code != 503 {
		t.Fatal("broken catalog returned fake data")
	}
	w = httptest.NewRecorder()
	rt.handleUpdate(w, catalogTestRequest(http.MethodGet, "/api/catalog/update/status", nil))
	if w.Code != 503 {
		t.Fatal("broken catalog pretended updater available")
	}
	w = catalogTestManual(t, rt, "edit", catalogTestManualBody("bad", 100))
	if w.Code != 503 {
		t.Fatal("broken catalog allowed manual write")
	}
	fx := catalogTestNew(t, 1, false, nil)
	r := catalogTestRequest(http.MethodGet, "/api/catalog/data", nil)
	r.Header.Set("Origin", "http://elsewhere.invalid")
	w = httptest.NewRecorder()
	fx.rt.handleData(w, r)
	if w.Code != 403 {
		t.Fatal("data leaked cross-origin")
	}
	w = httptest.NewRecorder()
	fx.rt.handleData(w, catalogTestRequest(http.MethodPost, "/api/catalog/data", []byte(`{}`)))
	if w.Code != 405 {
		t.Fatal("data endpoint accepted mutation method")
	}
	for _, path := range []string{"data/catalog.json", "data/monsters.json", "data/moves.json", "data/types.json", "data/wiki_monster_data.json"} {
		b, handled, e := fx.rt.staticData(path)
		if e != nil || !handled || !json.Valid(b) {
			t.Fatalf("invalid pinned compatibility response %s %v", path, e)
		}
	}
	for _, raw := range []string{"https://evil.invalid/image.png", "file:///C:/secret.png", "C:/secret.png", "../outside.png", ""} {
		if _, e := fx.rt.readImage(raw); e == nil {
			t.Fatalf("nonasset read allowed %q", raw)
		}
	}
}
