package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func scanTestCSV(t *testing.T, path string, rows ...[]string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	if err := w.Write([]string{"opencode", "meaning", "content"}); err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if err := w.Write(row); err != nil {
			t.Fatal(err)
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func scanTestRequest(h http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50500"
	r.Header.Set("Origin", "http://127.0.0.1:8080")
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set(scanTokenHeader, token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func scanTestToken(t *testing.T, h http.Handler) string {
	t.Helper()
	w := scanTestRequest(h, "GET", "/api/battles/scan", "", "")
	var state struct {
		Path  string `json:"path"`
		Token string `json:"scanToken"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || len(state.Token) != 64 {
		t.Fatalf("scan state: %d %s", w.Code, w.Body.String())
	}
	return state.Token
}

func TestScanHTTPExplicitTokenAndNoArchiveReadOnGet(t *testing.T) {
	s, mux := backendMux(t)
	token := scanTestToken(t, mux)
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("fresh GET created database", err)
	}
	file := scanTestCSV(t, filepath.Join(t.TempDir(), scanArchiveName), []string{"0x0102", "notbattle", `{}`})
	body, _ := json.Marshal(map[string]string{"path": file})
	for _, badToken := range []string{"", "invalid", strings.Repeat("0", 64)} {
		w := scanTestRequest(mux, "POST", "/api/battles/scan", string(body), badToken)
		if w.Code != 403 || strings.Contains(w.Body.String(), file) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("rejected POST wrote database", err)
	}
	w := scanTestRequest(mux, "POST", "/api/battles/scan", string(body), token)
	var result BattleScanResult
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	if result.Path != file || result.Files != 1 || result.Ignored != 1 || result.Completed != 0 || result.Imported != 0 || result.Pending != 0 || result.Issues == nil {
		t.Fatal(result)
	}
	// A missing archive proves GET neither stats nor opens the saved path.
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewBattleService(s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	newMux := http.NewServeMux()
	reopened.Register(newMux)
	w = scanTestRequest(newMux, "GET", "/api/battles/scan", "", "")
	var state map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &state) != nil || state["path"] != file {
		t.Fatal(w.Code, w.Body.String())
	}
	if state["scanToken"] == token || len(state["scanToken"]) != 64 {
		t.Fatal("token persisted across service lifetime")
	}
	if reopened.db != nil {
		t.Fatal("GET initialized writable database")
	}
	w = scanTestRequest(newMux, "POST", "/api/battles/scan", string(body), token)
	if w.Code != 403 {
		t.Fatal("previous service token accepted", w.Code)
	}
}

func TestScanHTTPStrictShapeOriginAndSafeErrors(t *testing.T) {
	_, mux := backendMux(t)
	token := scanTestToken(t, mux)
	for _, body := range []string{`{}`, `null`, `[]`, `{"path":null}`, `{"path":4}`, `{"path":""}`, `{"path":"secret","x":true}`, `{"path":"secret","path":"other"}`, `{"Path":"secret"}`, `{"path":"relative-secret"}`, `{"path":"secret"} {}`} {
		w := scanTestRequest(mux, "POST", "/api/battles/scan", body, token)
		if w.Code != 400 || strings.Contains(w.Body.String(), "secret") {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	for _, method := range []string{"PUT", "DELETE", "HEAD", "OPTIONS"} {
		w := scanTestRequest(mux, method, "/api/battles/scan", "{}", token)
		if w.Code != 405 || w.Header().Get("Allow") != "GET, POST" {
			t.Fatal(method, w.Code)
		}
	}
	for _, path := range []string{"/api/battles/scan?path=secret", "/api/battles/scan?"} {
		w := scanTestRequest(mux, "GET", path, "", "")
		if w.Code != 400 || strings.Contains(w.Body.String(), "secret") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, mutate := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
		func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		func(r *http.Request) { r.Host = "evil.example" },
		func(r *http.Request) { r.RemoteAddr = "192.0.2.2:123" },
		func(r *http.Request) { r.Header.Add(scanTokenHeader, token) },
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/battles/scan", strings.NewReader(`{"path":"secret"}`))
		r.RemoteAddr = "127.0.0.1:4"
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set(scanTokenHeader, token)
		mutate(r)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 403 || strings.Contains(w.Body.String(), "secret") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestScanScopedFilesAndPathRejection(t *testing.T) {
	root := t.TempDir()
	a := scanTestCSV(t, filepath.Join(root, "runs", "run-a", scanArchiveName))
	b := scanTestCSV(t, filepath.Join(root, "runs", "run-b", scanArchiveName))
	scanTestCSV(t, filepath.Join(root, "runs", "run-a", "deeper", scanArchiveName))
	scanTestCSV(t, filepath.Join(root, "runs", "keys", scanArchiveName))
	scanTestCSV(t, filepath.Join(root, "elsewhere", scanArchiveName))
	for _, test := range []struct {
		path  string
		count int
	}{{root, 2}, {filepath.Join(root, "runs"), 2}, {filepath.Dir(a), 1}, {a, 1}} {
		files, err := scanArchiveFiles(context.Background(), test.path, scanDefaultLimits())
		if err != nil || len(files) != test.count {
			t.Fatal(test.path, files, err)
		}
		for _, file := range files {
			if file != a && file != b {
				t.Fatal("scope escape", file)
			}
		}
	}
	invalid := []string{"relative", "", "\\\\host\\share\\" + scanArchiveName, "\\\\?\\C:\\" + scanArchiveName, filepath.Join(root, "keys", scanArchiveName), a + ":secret", root + string(os.PathSeparator) + ".." + string(os.PathSeparator) + scanArchiveName, a + "\n", a + " "}
	for _, path := range invalid {
		if _, err := scanCleanPath(path); !errors.Is(err, errScanPath) {
			t.Fatal("unsafe path accepted", path, err)
		}
	}
	other := filepath.Join(root, "decoded_packets.jsonl")
	if err := os.WriteFile(other, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := scanArchiveFiles(context.Background(), other, scanDefaultLimits()); !errors.Is(err, errScanPath) {
		t.Fatal(err)
	}
	limits := scanDefaultLimits()
	limits.files = 1
	if _, err := scanArchiveFiles(context.Background(), root, limits); !errors.Is(err, errScanLimit) {
		t.Fatal("file count not bounded", err)
	}
	limits = scanDefaultLimits()
	limits.entries = 1
	if _, err := scanArchiveFiles(context.Background(), root, limits); !errors.Is(err, errScanLimit) {
		t.Fatal("directory entries not bounded", err)
	}
}

func TestScanRejectsSymlinkAndParentSymlink(t *testing.T) {
	root := t.TempDir()
	real := scanTestCSV(t, filepath.Join(root, "real", scanArchiveName))
	linked := filepath.Join(root, "linked")
	if err := os.Symlink(filepath.Dir(real), linked); err != nil {
		t.Skip("symlink privilege unavailable")
	}
	if _, err := scanArchiveFiles(context.Background(), filepath.Join(linked, scanArchiveName), scanDefaultLimits()); !errors.Is(err, errScanPath) {
		t.Fatal("parent symlink accepted", err)
	}
	leafDir := filepath.Join(root, "leaf")
	if err := os.Mkdir(leafDir, 0700); err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(leafDir, scanArchiveName)
	if err := os.Symlink(real, leaf); err != nil {
		t.Fatal(err)
	}
	if _, err := scanArchiveFiles(context.Background(), leaf, scanDefaultLimits()); !errors.Is(err, errScanPath) {
		t.Fatal("leaf symlink accepted", err)
	}
}

func TestScanBudgetsCancellationAndPartialCSVTail(t *testing.T) {
	file := scanTestCSV(t, filepath.Join(t.TempDir(), scanArchiveName), []string{"0x0102", "ignored", `{}`}, []string{"0x0102", "ignored", `{}`})
	for _, change := range []func(*scanLimits){
		func(l *scanLimits) { l.bytes = 1 },
		func(l *scanLimits) { l.rows = 1 },
		func(l *scanLimits) { l.rowBytes = 8 },
		func(l *scanLimits) { l.budget = time.Nanosecond },
	} {
		s := backendService(t)
		limits := scanDefaultLimits()
		change(&limits)
		_, err := s.scanArchiveWithLimits(context.Background(), file, limits)
		if !errors.Is(err, errScanLimit) && !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if _, err := os.Stat(s.path); !os.IsNotExist(err) {
			t.Fatal("budget failure wrote database", err)
		}
	}
	s := backendService(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.ScanArchive(ctx, file); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("cancel wrote database", err)
	}
	for _, tail := range []string{`0x0102,ignored,"{""partial"":`, `0x0102,ignored,{}`} {
		file := scanTestCSV(t, filepath.Join(t.TempDir(), scanArchiveName), []string{"0x0102", "ignored", `{}`})
		f, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.WriteString(f, tail); err != nil {
			f.Close()
			t.Fatal(err)
		}
		f.Close()
		result, err := backendService(t).ScanArchive(context.Background(), file)
		if err != nil || result.Ignored != 1 || result.Files != 1 || len(result.Issues) != 1 || result.Completed != 0 {
			t.Fatal(result, err)
		}
	}
	ctx, cancel = context.WithCancel(context.Background())
	reader := &scanBoundReader{ctx: ctx, reader: strings.NewReader("private payload"), ceiling: 100}
	cancel()
	if n, err := reader.Read(make([]byte, 10)); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatal("source read after cancel", n, err)
	}
}

func TestScanImportProtectsLegacyBytesAndCountsUpdates(t *testing.T) {
	s := backendService(t)
	old := backendBattle(t, "oct29-rich")
	old.Source = "rkpp-named-v1"
	backendImport(t, s, old)
	var before string
	if err := s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", old.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	incoming := backendBattle(t, old.ID)
	incoming.Source = "rkpp-live-v1"
	incoming.Events[0].SkillID = 999 // deliberate conflict with the old scheme
	result, err := s.Import(context.Background(), []BattleRecord{incoming})
	if err != nil || result.Imported != 0 || result.Updated != 0 || result.Duplicates != 1 {
		t.Fatal(result, err)
	}
	var after string
	if err := s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", old.ID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if sha256.Sum256([]byte(before)) != sha256.Sum256([]byte(after)) {
		t.Fatal("legacy raw row changed")
	}
	live := backendBattle(t, "same-source")
	live.Source = "rkpp-live-v1"
	result = backendImport(t, s, live)
	if result.Imported != 1 || result.Updated != 0 {
		t.Fatal(result)
	}
	verified, err := s.Record(context.Background(), live.ID)
	if err != nil || !verified.Quality.Actions || !verified.Quality.Roster["me"] {
		t.Fatal("verified initial quality lost", err)
	}
	// Extending a previously complete action set correctly withdraws its old
	// completeness under the existing Merge contract. The assembler likewise
	// declares actions partial; replay must not reassert old completeness.
	live.Quality.Actions = false
	live.Events = append(live.Events, BattleEvent{ID: "extra", Seq: 2, Round: 2, Kind: "skill", Phase: "executed", Side: "me", Actor: "self", SkillID: 10})
	result = backendImport(t, s, live)
	if result.Imported != 1 || result.Updated != 1 || result.Duplicates != 0 {
		t.Fatal(result)
	}
	result = backendImport(t, s, live)
	if result.Imported != 0 || result.Updated != 0 || result.Duplicates != 1 {
		t.Fatal(result)
	}
	got, err := s.Record(context.Background(), live.ID)
	if err != nil || got.Quality.Actions || !got.Quality.Roster["me"] {
		t.Fatal("verified roster or conservative action quality changed", err, got.Quality)
	}
}

func scanTestFrames(t *testing.T, path string, frames ...[]byte) string {
	t.Helper()
	rows := make([][]string, 0, len(frames))
	for _, frame := range frames {
		var envelope struct {
			Opencode string          `json:"opencode"`
			Content  json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(frame, &envelope); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, []string{envelope.Opencode, "battle", string(envelope.Content)})
	}
	return scanTestCSV(t, path, rows...)
}

func TestScanLifecycleLosslessPendingUpdateReplay(t *testing.T) {
	s := backendService(t)
	id := "18446744073709551615"
	path := filepath.Join(t.TempDir(), scanArchiveName)
	scanTestFrames(t, path, liveTestStart(id), liveTestFinish(id, 12, 0))
	first, err := s.ScanArchive(context.Background(), path)
	if err != nil || first.Completed != 1 || first.Imported != 1 || first.Pending != 0 || first.Updated != 0 || first.Unchanged != 0 {
		t.Fatal(first, err)
	}
	saved, err := s.Record(context.Background(), "rkpp:"+id)
	if err != nil || saved.Outcome != "loss" || saved.Source != "rkpp-live-v1" {
		t.Fatal("64-bit battle ID or source lost", err)
	}
	replay, err := s.ScanArchive(context.Background(), path)
	if err != nil || replay.Completed != 1 || replay.Imported != 0 || replay.Updated != 0 || replay.Unchanged != 1 {
		t.Fatal(replay, err)
	}
	// A later complete capture can enrich the same-source record through the
	// ordinary checked Import merge, never through an unguarded replace.
	scanTestFrames(t, path, liveTestStart(id), liveTestCommand(7, liveTestCast(1, 1, 700001000)), liveTestFinish(id, 12, 0))
	updated, err := s.ScanArchive(context.Background(), path)
	if err != nil || updated.Completed != 1 || updated.Imported != 0 || updated.Updated != 1 || updated.Unchanged != 0 {
		t.Fatal(updated, err)
	}
	replay, err = s.ScanArchive(context.Background(), path)
	if err != nil || replay.Imported != 0 || replay.Updated != 0 || replay.Unchanged != 1 {
		t.Fatal(replay, err)
	}
	pendingPath := scanTestFrames(t, filepath.Join(t.TempDir(), scanArchiveName), liveTestStart("123"))
	pending, err := s.ScanArchive(context.Background(), pendingPath)
	if err != nil || pending.Completed != 0 || pending.Pending != 1 || pending.Imported != 0 {
		t.Fatal(pending, err)
	}
	if _, err := s.Record(context.Background(), "rkpp:123"); !errors.Is(err, errBattleNotFound) {
		t.Fatal("unfinished battle committed", err)
	}
}

func TestScanPartialFinishAndCrossFileIsolation(t *testing.T) {
	s := backendService(t)
	path := scanTestFrames(t, filepath.Join(t.TempDir(), scanArchiveName), liveTestStart("111"), liveTestFinish("111", 12, 0))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data[:len(data)-1], 0600); err != nil {
		t.Fatal(err)
	}
	partial, err := s.ScanArchive(context.Background(), path)
	if err != nil || partial.Completed != 0 || partial.Pending != 1 || len(partial.Issues) != 1 {
		t.Fatal(partial, err)
	}
	if _, err := s.Record(context.Background(), "rkpp:111"); !errors.Is(err, errBattleNotFound) {
		t.Fatal("unterminated finish committed", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	complete, err := s.ScanArchive(context.Background(), path)
	if err != nil || complete.Imported != 1 || complete.Pending != 0 {
		t.Fatal(complete, err)
	}
	root := t.TempDir()
	scanTestFrames(t, filepath.Join(root, "runs", "a", scanArchiveName), liveTestStart("222"))
	scanTestFrames(t, filepath.Join(root, "runs", "b", scanArchiveName), liveTestFinish("222", 12, 0))
	isolated, err := s.ScanArchive(context.Background(), root)
	if err != nil || isolated.Files != 2 || isolated.Completed != 0 || isolated.Pending != 1 {
		t.Fatal("cross-file lifecycle guessed", isolated, err)
	}
	if _, err := s.Record(context.Background(), "rkpp:222"); !errors.Is(err, errBattleNotFound) {
		t.Fatal(err)
	}
}

func TestScanBudgetAfterCompletionDoesNotCommit(t *testing.T) {
	s := backendService(t)
	path := scanTestFrames(t, filepath.Join(t.TempDir(), scanArchiveName), liveTestStart("333"), liveTestFinish("333", 12, 0), liveTestFrame("0x0102", map[string]any{}))
	limits := scanDefaultLimits()
	limits.rows = 2
	if _, err := s.scanArchiveWithLimits(context.Background(), path, limits); !errors.Is(err, errScanLimit) {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("budget failure committed completed prefix", err)
	}
}

// Explicit opt-in only: a user-selected external archive is read, while all
// records/settings are written solely to a new TempDir database. No host default.
func TestScanActualArchiveOptIn(t *testing.T) {
	path := os.Getenv("XHM_SCAN_ACTUAL_CSV")
	if path == "" {
		t.Skip("explicit selected archive not supplied")
	}
	catalog, err := os.ReadFile(filepath.Join("data", "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewBattleService(filepath.Join(t.TempDir(), "actual.sqlite"), func() ([]byte, error) { return catalog, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.ScanArchive(context.Background(), path)
	if err != nil {
		t.Fatal("actual archive scan failed", err)
	}
	if first.Completed < 4 || first.Imported < 4 || first.Updated != 0 || first.Files != 1 {
		t.Fatal(fmt.Sprintf("unexpected aggregate %+v", first))
	}
	second, err := s.ScanArchive(context.Background(), path)
	if err != nil {
		t.Fatal("actual archive replay failed", err)
	}
	if second.Updated != 0 || second.Unchanged < first.Completed {
		t.Fatal("replay changed completed records", second)
	}
	t.Logf("selected archive: completed=%d imported=%d replay unchanged=%d pending=%d ignored=%d", first.Completed, first.Imported, second.Unchanged, first.Pending, first.Ignored)
}
