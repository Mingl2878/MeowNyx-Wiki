package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Every fixture and database in these tests is isolated. The fake receiver is
// importRelayFrame itself: no listening socket, RKPP process, AppData or capture.
func sourceTestReceive(t *testing.T, s *BattleService, assembler *BattleStreamAssembler, frame []byte) {
	t.Helper()
	if err := s.importRelayFrame(context.Background(), assembler, frame); err != nil {
		t.Fatal(err)
	}
}

func sourceTestMux(s *BattleService) *http.ServeMux {
	mux := http.NewServeMux()
	s.Register(mux)
	return mux
}
func sourceTestExport(t *testing.T, s *BattleService, format string) *httptest.ResponseRecorder {
	t.Helper()
	return scanTestRequest(sourceTestMux(s), "GET", "/api/battles/source/export?format="+format, "", "")
}
func sourceTestStatus(t *testing.T, s *BattleService) BattleSourceStatus {
	t.Helper()
	status, err := s.SourceStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func TestBattleSourceEmptyGETNeverCreatesStorage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-parent", "source.sqlite")
	s, err := NewBattleService(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	mux := sourceTestMux(s)
	for _, item := range []struct{ path, body string }{
		{"/api/battles/source/export?format=json", "[]\n"},
		{"/api/battles/source/export?format=ndjson", ""},
	} {
		w := scanTestRequest(mux, "GET", item.path, "", "")
		if w.Code != 200 || w.Body.String() != item.body || w.Header().Get("X-Source-Event-Count") != "0" || w.Header().Get("X-Source-Complete") != "true" {
			t.Fatal("empty export contract")
		}
	}
	status := sourceTestStatus(t, s)
	if status.Available || status.Count != 0 || status.Bytes != 0 || !status.Complete || len(status.Issues) == 0 {
		t.Fatal(status)
	}
	if s.db != nil {
		t.Fatal("GET opened writable service DB")
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("GET created storage")
	}
}

func TestBattleSourceLosslessFullFrameDedupAndRestart(t *testing.T) {
	s := backendService(t)
	a := NewBattleStreamAssembler()
	first := []byte(" \n{\"opencode\":\"0x13f3\",\"event_id\":\"e1\",\"captured_at\":\"2026-11-05T01:00:00Z\",\"content\": {\"battle_id\":18446744073709551615,\"extra\":[1.2300,1e+09,-0,\"<>&\\u4e2d\"]},\"safe_extra\":{\"x\":9007199254740993}}\n")
	second := bytes.Replace(first, []byte(`"e1"`), []byte(`"e2"`), 1)
	third := bytes.Replace(first, []byte("01:00:00Z"), []byte("01:00:01Z"), 1)
	for _, frame := range [][]byte{first, first, second, third} {
		sourceTestReceive(t, s, a, frame)
	}
	// Caller mutation cannot alter already-captured source bytes.
	original := append([]byte(nil), first...)
	first[0] = '\t'
	want := append([]byte("["), original...)
	want = append(want, ',')
	want = append(want, second...)
	want = append(want, ',')
	want = append(want, third...)
	want = append(want, []byte("]\n")...)
	w := sourceTestExport(t, s, "json")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatal("original JSON bytes/lexemes/order not preserved")
	}
	if w.Header().Get("Content-Disposition") != `attachment; filename="battle-source-events.json"` || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("unsafe download headers")
	}
	status := sourceTestStatus(t, s)
	if status.Count != 3 || status.Bytes != int64(len(original)+len(second)+len(third)) || !status.Available || !status.Complete {
		t.Fatal(status)
	}
	var nd bytes.Buffer
	for _, frame := range [][]byte{original, second, third} {
		var compact bytes.Buffer
		if err := json.Compact(&compact, frame); err != nil {
			t.Fatal(err)
		}
		nd.Write(compact.Bytes())
		nd.WriteByte('\n')
	}
	w = sourceTestExport(t, s, "ndjson")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), nd.Bytes()) {
		t.Fatal("NDJSON changed content/number lexemes")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewBattleService(s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	w = sourceTestExport(t, reopened, "json")
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) || reopened.db != nil {
		t.Fatal("read-only restart changed archive")
	}
}

func TestBattleSourceRejectsProtectedMalformedAndCanonicalInputs(t *testing.T) {
	s := backendService(t)
	a := NewBattleStreamAssembler()
	// A safe accepted preview opens only the auxiliary archive. Private fields
	// must be rejected at every depth and even inside JSON string content/extras.
	safe := []byte(`{"opencode":"0x13f3","content":{},"safe_extra":"{plain arbitrary text}"}`)
	sourceTestReceive(t, s, a, safe)
	bad := [][]byte{
		[]byte(`{"opencode":"0x13f3","content":{"private_key":"fixture-private"}}`),
		[]byte(`{"opencode":"0x13f3","content":{"nested":[{"authToken":"fixture-auth"}]}}`),
		[]byte(`{"opencode":"0x13f3","content":"{\"passwd\":\"fixture-password\"}"}`),
		[]byte(`{"opencode":"0x13f3","content":{},"extra":"{\"access_token\":\"fixture-token\"}"}`),
		[]byte(`{"opencode":"0x13f3","content":{},"key":"fixture-key"}`),
		[]byte(`{"opencode":"0x13f3","content":{},"cookie":"fixture-cookie"}`),
		[]byte(`{"opencode":"0x13f3","content":{"account":{"credentials":"fixture-credentials"}}}`),
		[]byte(`{"opencode":"0x13f3","content":{"raw_packet":[1,2,3]}}`),
		[]byte(`{"opencode":"0x13f3","content":{"pcap":"fixture-pcap"}}`),
		[]byte(`{"opencode":"0x13f3","content":{},"content":{}}`),
		[]byte(`{"opencode":"0x13f3","content":`),
		[]byte(`{"opencode":"0x13f3","content":"not json"}`),
		[]byte(`{"opencode":"0x1324","content":{"perform_cmd":4}}`),
	}
	for _, frame := range bad {
		sourceTestReceive(t, s, a, frame)
	}
	canonical, _ := json.Marshal(backendBattle(t, "canonical-not-source"))
	for _, frame := range [][]byte{canonical, []byte(`{"heartbeat":true}`), []byte(`{"opencode":"0x0102","content":{"key":"fixture-nonbattle"}}`), []byte(`{"opencode":"0x13f3","content":{"id":"canonical","version":1,"events":[]}}`)} {
		sourceTestReceive(t, s, a, frame)
	}
	w := sourceTestExport(t, s, "json")
	if w.Code != 200 || w.Body.String() != "["+string(safe)+"]\n" {
		t.Fatal("rejected payload was archived")
	}
	status := sourceTestStatus(t, s)
	if status.Count != 1 || len(status.Issues) < 3 || !status.Complete {
		t.Fatal("omissions not visible", status)
	}
	serialized, _ := json.Marshal(s.RelayStatus())
	for _, marker := range []string{"fixture-private", "fixture-auth", "fixture-password", "fixture-token", "fixture-key", "fixture-cookie"} {
		if bytes.Contains(serialized, []byte(marker)) || bytes.Contains(w.Body.Bytes(), []byte(marker)) {
			t.Fatal("private payload escaped fixed diagnostics")
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewBattleService(s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if len(sourceTestStatus(t, reopened).Issues) < 3 {
		t.Fatal("source omissions disappeared on restart")
	}
}

func TestBattleSourceProtectedOnlyNeverCreatesDB(t *testing.T) {
	s := backendService(t)
	sourceTestReceive(t, s, NewBattleStreamAssembler(), []byte(`{"opencode":"0x13f3","content":{"session_key":"fixture-secret"}}`))
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("protected-only input created DB")
	}
	if sourceTestStatus(t, s).Count != 0 || len(s.RelayStatus().Issues) == 0 {
		t.Fatal("protected skip silent")
	}
}

func TestBattleSourceOldSchemaGETIsByteExactAndNoMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, ddl := range battleSchemaDDL {
		if _, err := db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version=%d", battleSchemaVersion)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(fmt.Sprintf("PRAGMA application_id=%d", battleApplicationID)); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewBattleService(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, format := range []string{"json", "ndjson"} {
		if sourceTestExport(t, s, format).Code != 200 {
			t.Fatal("schema-1 empty archive refused")
		}
	}
	if sourceTestStatus(t, s).Count != 0 || s.db != nil {
		t.Fatal("legacy GET activated DB")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("GET migrated/wrote old schema-1 DB")
	}
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").Scan(&count) != nil || count != len(battleSchemaDDL) {
		t.Fatal("GET created auxiliary table/rule marker")
	}
}

func TestBattleSourceStrictHTTPOriginMethodsQueryAndAdmission(t *testing.T) {
	s := backendService(t)
	mux := sourceTestMux(s)
	for _, query := range []string{"", "?", "?format=", "?format=xml", "?format=json&format=json", "?format=json&path=fixture-path", "?format=ndjson&filename=fixture-name", "?format=json&id=fixture-id", "?format=json;path=x", "?format=%ZZ"} {
		w := scanTestRequest(mux, "GET", "/api/battles/source/export"+query, "", "")
		if w.Code != 400 || strings.Contains(w.Body.String(), "fixture-") {
			t.Fatal("export query fail-open")
		}
	}
	for _, path := range []string{"/api/battles/source/status?", "/api/battles/source/status?path=fixture-path"} {
		if scanTestRequest(mux, "GET", path, "", "").Code != 400 {
			t.Fatal("status accepted query")
		}
	}
	for _, path := range []string{"/api/battles/source/export?format=json", "/api/battles/source/status"} {
		for _, method := range []string{"POST", "PUT", "HEAD", "OPTIONS", "DELETE"} {
			w := scanTestRequest(mux, method, path, "{}", "")
			if w.Code != 405 || w.Header().Get("Allow") != "GET" {
				t.Fatal("source route mutation allowed")
			}
		}
		for _, mutate := range []func(*http.Request){
			func(r *http.Request) { r.Header.Set("Origin", "http://evil.example") },
			func(r *http.Request) { r.Host = "evil.example" },
			func(r *http.Request) { r.RemoteAddr = "192.0.2.1:80" },
			func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") },
		} {
			r := httptest.NewRequest("GET", "http://127.0.0.1:8080"+path, nil)
			r.RemoteAddr = "127.0.0.1:22"
			mutate(r)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != 403 {
				t.Fatal("source read guard missing")
			}
		}
	}
	s.requests <- struct{}{}
	s.requests <- struct{}{}
	for _, path := range []string{"/api/battles/source/export?format=json", "/api/battles/source/status"} {
		if scanTestRequest(mux, "GET", path, "", "").Code != 429 {
			t.Fatal("source GET bypassed admission")
		}
	}
	<-s.requests
	<-s.requests
	if s.db != nil {
		t.Fatal("rejected requests created DB")
	}
}

func TestBattleSourceSevenHistoricalRecordAndRuleBytesRemainExact(t *testing.T) {
	s := backendService(t)
	for i := 0; i < 7; i++ {
		id := fmt.Sprintf("legacy-%d", i)
		if i == 0 {
			id = "rkpp:77"
		}
		backendImport(t, s, backendBattle(t, id))
	}
	// Unknown historical fields and whitespace are deliberately outside the
	// normalized projection. Archive GET/append must never re-serialize them.
	rows, err := s.db.Query("SELECT id,record_json FROM battles ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	original := map[string]string{}
	for rows.Next() {
		var id, data string
		if rows.Scan(&id, &data) != nil {
			t.Fatal("read fixture")
		}
		original[id] = " \n" + data[:len(data)-1] + `,"unknown_history":{"uint":18446744073709551615,"text":"keep"}}`
	}
	rows.Close()
	for id, data := range original {
		if _, err := s.db.Exec("UPDATE battles SET record_json=? WHERE id=?", data, id); err != nil {
			t.Fatal(err)
		}
	}
	rule := ` {"id":"legacy-rule","name":"Legacy","monsterIds":[2],"unknown_strategy":{"keep":true}} `
	if _, err := s.db.Exec("INSERT INTO battle_rules(id,position,rule_json) VALUES('legacy-rule',0,?)", rule); err != nil {
		t.Fatal(err)
	}
	a := NewBattleStreamAssembler()
	sourceTestReceive(t, s, a, liveTestStart("77"))
	sourceTestReceive(t, s, a, liveTestFinish("77", 12, 0))
	if w := sourceTestExport(t, s, "json"); w.Code != 200 {
		t.Fatal("export failed")
	}
	_ = sourceTestStatus(t, s)
	for id, before := range original {
		var after string
		if s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", id).Scan(&after) != nil || before != after {
			t.Fatal("historical row bytes changed")
		}
	}
	var after string
	if s.db.QueryRow("SELECT rule_json FROM battle_rules WHERE id='legacy-rule'").Scan(&after) != nil || rule != after {
		t.Fatal("strategy unknown fields changed")
	}
	var version, count int
	s.db.QueryRow("PRAGMA user_version").Scan(&version)
	s.db.QueryRow("SELECT count(*) FROM battles").Scan(&count)
	if version != 1 || count != 7 {
		t.Fatal("core version/7 records invariant broken")
	}
}

func TestBattleSourceManualScanKeepsOriginalContentAndReplays(t *testing.T) {
	s := backendService(t)
	content := " \n{\"battle_id\":18446744073709551615,\"extra\":[1.2300,1e+09,\"<>&\\u4e2d\"]}\n "
	path := scanTestCSV(t, filepath.Join(t.TempDir(), scanArchiveName), []string{"0x13f3", "preview", content}, []string{"0x13f3", "preview", content}, []string{"0x0102", "not-battle", `{}`})
	if sourceTestStatus(t, s).Count != 0 {
		t.Fatal("status auto-scanned")
	}
	for i := 0; i < 2; i++ {
		result, err := s.ScanArchive(context.Background(), path)
		if err != nil || result.Files != 1 || result.Completed != 0 || result.Ignored != 1 {
			t.Fatal(result, err)
		}
	}
	w := sourceTestExport(t, s, "json")
	want := "[{\"opencode\":\"0x13f3\",\"content\":" + content + "}]\n"
	if w.Code != 200 || w.Body.String() != want || sourceTestStatus(t, s).Count != 1 {
		t.Fatal("CSV content was compacted/re-serialized or replay duplicated")
	}
}

func TestBattleSourceScanParseFailureDoesNotCommitArchivePrefix(t *testing.T) {
	s := backendService(t)
	path := scanTestFrames(t, filepath.Join(t.TempDir(), scanArchiveName), liveTestStart("99"), liveTestFinish("99", 12, 0), liveTestFrame("0x0102", map[string]any{}))
	limits := scanDefaultLimits()
	limits.rows = 2
	if _, err := s.scanArchiveWithLimits(context.Background(), path, limits); !errors.Is(err, errScanLimit) {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatal("failed scan committed raw prefix")
	}
}

func TestBattleSourceArchiveFailureKeepsReceiverBattleImportAndFixedError(t *testing.T) {
	s := backendService(t)
	a := NewBattleStreamAssembler()
	sourceTestReceive(t, s, a, []byte(`{"opencode":"0x13f3","content":{}}`))
	if _, err := s.db.Exec(`CREATE TRIGGER source_fixture_failure BEFORE INSERT ON battle_source_events BEGIN SELECT RAISE(ABORT,'fixture-private-storage-text'); END`); err != nil {
		t.Fatal(err)
	}
	sourceTestReceive(t, s, a, liveTestStart("991"))
	sourceTestReceive(t, s, a, liveTestFinish("991", 12, 0))
	if _, err := s.Record(context.Background(), "rkpp:991"); err != nil {
		t.Fatal("source failure discarded normal battle import")
	}
	status := s.RelayStatus()
	if status.Imported != 1 || status.Error != errBattleSourceStore.Error() {
		t.Fatal("receiver failure not visible", status)
	}
	data, _ := json.Marshal(status)
	if bytes.Contains(data, []byte("fixture-private-storage-text")) {
		t.Fatal("SQL error leaked")
	}
}

func TestBattleSourceScanPartialStoreFailureReportsImportedFacts(t *testing.T) {
	s := backendService(t)
	if err := s.appendSourceFrames(context.Background(), [][]byte{[]byte(`{"opencode":"0x13f3","content":{}}`)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER source_fixture_failure BEFORE INSERT ON battle_source_events BEGIN SELECT RAISE(ABORT,'fixture-private-storage-text'); END`); err != nil {
		t.Fatal(err)
	}
	path := scanTestFrames(t, filepath.Join(t.TempDir(), scanArchiveName), liveTestStart("992"), liveTestFinish("992", 12, 0))
	mux := sourceTestMux(s)
	token := scanTestToken(t, mux)
	body, _ := json.Marshal(map[string]string{"path": path})
	w := scanTestRequest(mux, "POST", "/api/battles/scan", string(body), token)
	var result BattleScanResult
	if w.Code != 503 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Imported != 1 || result.Error != errBattleSourceStore.Error() || len(result.Issues) == 0 {
		t.Fatal("scan facts/source partial failure contract")
	}
	if _, err := s.Record(context.Background(), "rkpp:992"); err != nil {
		t.Fatal("scan discarded committed facts")
	}
	if strings.Contains(w.Body.String(), "fixture-private-storage-text") {
		t.Fatal("scan raw error leaked")
	}
}

func TestBattleSourceAppendIsTransactionalAndMalformedSchemaRefused(t *testing.T) {
	for _, setup := range []string{`CREATE TABLE battle_source_events (secret TEXT)`, `CREATE VIEW battle_source_events AS SELECT 'fixture-private' AS raw_frame`} {
		s := backendService(t)
		backendImport(t, s, backendBattle(t, "unchanged"))
		if _, err := s.db.Exec(setup); err != nil {
			t.Fatal(err)
		}
		if err := s.appendSourceFrames(context.Background(), [][]byte{[]byte(`{"opencode":"0x13f3","content":{}}`)}); !errors.Is(err, errBattleSourceStore) {
			t.Fatal("malformed source schema repaired")
		}
		w := sourceTestExport(t, s, "json")
		if w.Code != 503 || strings.Contains(w.Body.String(), "fixture-private") {
			t.Fatal("bad schema exported")
		}
		var n int
		s.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='battle_source_state'").Scan(&n)
		if n != 0 {
			t.Fatal("schema failure partially created auxiliary state")
		}
	}
	s := backendService(t)
	err := s.appendSourceFrames(context.Background(), [][]byte{[]byte(`{"opencode":"0x13f3","content":{}}`), []byte(`{"opencode":"0x13f3","content":{"key":"fixture-private"}}`)})
	if !errors.Is(err, errBattleSourceStore) {
		t.Fatal("unsafe append accepted")
	}
	var n int
	s.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name IN ('battle_source_events','battle_source_state')").Scan(&n)
	if n != 0 {
		t.Fatal("source transaction committed prefix/partial DDL")
	}
}

func TestBattleSourceCorruptPrivateRowRefusesWholeExport(t *testing.T) {
	s := backendService(t)
	safe := []byte(`{"opencode":"0x13f3","content":{}}`)
	if err := s.appendSourceFrames(context.Background(), [][]byte{safe}); err != nil {
		t.Fatal(err)
	}
	for _, corrupt := range [][]byte{[]byte(`{"opencode":"0x13f3","content":{"key":"fixture-private"}}`), []byte(`{"opencode":`), []byte(`{"id":"canonical","version":1,"events":[]}`)} {
		hash := sha256.Sum256(corrupt)
		if _, err := s.db.Exec("UPDATE battle_source_events SET frame_hash=?,raw_frame=? WHERE position=1", hex.EncodeToString(hash[:]), corrupt); err != nil {
			t.Fatal(err)
		}
		for _, format := range []string{"json", "ndjson"} {
			w := sourceTestExport(t, s, format)
			if w.Code != 503 || strings.Contains(w.Body.String(), "fixture-private") || w.Header().Get("Content-Disposition") != "" {
				t.Fatal("corrupt row silently skipped/partially exported")
			}
		}
	}
}

func TestBattleSourceArchiveAndExportQuotasAreExplicit(t *testing.T) {
	s := backendService(t)
	safe := []byte(`{"opencode":"0x13f3","content":{}}`)
	if err := s.appendSourceFrames(context.Background(), [][]byte{safe}); err != nil {
		t.Fatal(err)
	}
	// Populate a bounded TempDir fixture through a single statement, not 10000
	// receiver calls. Each frame is independently valid and byte-distinct.
	if _, err := s.db.Exec(`WITH RECURSIVE n(x) AS (SELECT 2 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO battle_source_events(position,frame_hash,raw_frame) SELECT x,printf('%064d',x),CAST('{"opencode":"0x13f3","content":{},"event_id":'||x||'}' AS BLOB) FROM n`); err != nil {
		t.Fatal(err)
	}
	if err := s.appendSourceFrames(context.Background(), [][]byte{safe}); err != nil {
		t.Fatal("dedup at capacity failed", err)
	}
	if err := s.appendSourceFrames(context.Background(), [][]byte{[]byte(`{"opencode":"0x13f3","content":{},"event_id":"new"}`)}); !errors.Is(err, errBattleSourceQuota) {
		t.Fatal("archive cap omitted without warning")
	}
	if len(sourceTestStatus(t, s).Issues) < 2 {
		t.Fatal("archive cap silent")
	}
	if _, err := s.db.Exec("INSERT INTO battle_source_events(position,frame_hash,raw_frame) VALUES(10001,?,?)", strings.Repeat("f", 64), safe); err != nil {
		t.Fatal(err)
	}
	status := sourceTestStatus(t, s)
	if status.Complete || status.Count != 10001 {
		t.Fatal("oversized archive mislabeled complete")
	}
	w := sourceTestExport(t, s, "json")
	if w.Code != 413 || w.Header().Get("Content-Disposition") != "" {
		t.Fatal("oversized export truncated silently")
	}
	candidate, warning := battlePrepareSourceFrame(bytes.Repeat([]byte("x"), battleSourceFrameLimit+1))
	if candidate != nil || warning != battleSourceLimit {
		t.Fatal("frame size unbounded")
	}
}

func TestBattleSourceReviewedRKPPEnvelopeAndAccountBearingOpening(t *testing.T) {
	// Public RKPP schema shapes, invented account values only. The user's
	// explicit account-preservation decision keeps the entire original opening.
	s := backendService(t)
	a := NewBattleStreamAssembler()
	envelope := []byte(`{"row_index":3,"captured_at":"2026-11-05T00:00:00Z","flow_id":"fixture-flow","direction":"s2c","seq":7,"opcode":5107,"opcode_name":"ZoneBattlePrePlayNotify","opencode":"0x13f3","meaning":"ZoneBattlePrePlayNotify","summary_kind":"battle_preplay","summary_text":null,"content":{}}`)
	id := "18446744073709551615"
	opening := append([]byte(`{"creater_uin":4294967295,"src_ip":"192.0.2.123","dst_ip":"127.0.0.1","account":{"uid":18446744073709551615,"userid":9007199254740993,"player_id":9007199254740995,"uin_brief":{"nickname":"fixture-brief"},"profile":{"nickname":"fixture-person","appearance_info":{"id":1}},"author":"fixture-account-author","auth":{"method":"account-metadata"}},`), liveTestStart(id)[1:]...)
	opening = bytes.Replace(opening, []byte(`"base":{"side":0}`), []byte(`"base":{"role_uin":4294967295,"name":[65,66],"side":0,"visit_owner_uin":0,"visit_owner_name":"fixture-owner","fri_uin_list":[1],"valid_shiny_catch_uins":[1]}`), 1)
	command := liveTestCommand(7, liveTestCast(1, 1, 700001000))
	finish := liveTestFinish(id, 12, 0)
	frames := [][]byte{envelope, opening, command, finish}
	for _, frame := range frames {
		sourceTestReceive(t, s, a, frame)
	}
	if status := sourceTestStatus(t, s); status.Count != 4 || len(status.Issues) != 1 {
		t.Fatal("authorized account/frame metadata rejected", status)
	}
	w := sourceTestExport(t, s, "json")
	want := []byte("[")
	for i, frame := range frames {
		if i > 0 {
			want = append(want, ',')
		}
		want = append(want, frame...)
	}
	want = append(want, []byte("]\n")...)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatal("account uint64/opening fields or exact source bytes changed")
	}
	// Reassemble exactly the exported source frames; no canonical records or
	// sanitized/missing opening are substituted into this round-trip.
	var exported []json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &exported); err != nil {
		t.Fatal(err)
	}
	replay := NewBattleStreamAssembler()
	var got []BattleRecord
	for _, frame := range exported {
		records, accepted, err := replay.Push(frame)
		if err != nil || !accepted {
			t.Fatal("exported account-bearing source cannot reassemble", err)
		}
		got = append(got, records...)
	}
	if len(got) != 1 || got[0].ID != "rkpp:"+id || got[0].Outcome != "loss" || len(got[0].Sides["me"].Pets) != 1 {
		t.Fatal("source account opening round-trip lost battle")
	}
	for _, frame := range frames {
		sourceTestReceive(t, s, a, frame)
	}
	if sourceTestStatus(t, s).Count != 4 {
		t.Fatal("account-bearing replay duplicated source")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewBattleService(s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if w := sourceTestExport(t, reopened, "json"); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), want) {
		t.Fatal("account source bytes changed on restart")
	}
	// Authentication material remains prohibited even inside authorized account
	// objects; warning persists across an unopened receiver's restart.
	sourceTestReceive(t, reopened, NewBattleStreamAssembler(), []byte(`{"opencode":"0x13f3","content":{},"account":{"profile":{"authToken":"fixture-secret"}}}`))
	if status := sourceTestStatus(t, reopened); status.Count != 4 || len(status.Issues) < 2 {
		t.Fatal("authentication token accepted or skip silent")
	}
}

type sourceChunkWriter struct {
	chunks []int
	data   bytes.Buffer
	fail   bool
}

func (w *sourceChunkWriter) Write(data []byte) (int, error) {
	w.chunks = append(w.chunks, len(data))
	if w.fail {
		return 0, io.ErrClosedPipe
	}
	return w.data.Write(data)
}

func TestBattleSourceSnapshotStableChunkedAndWriterCancellation(t *testing.T) {
	s := backendService(t)
	first := []byte(`{"opencode":"0x13f3","content":{},"event_id":1}`)
	second := []byte(`{"opencode":"0x13f3","content":{},"event_id":2}`)
	if err := s.appendSourceFrames(context.Background(), [][]byte{first}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal(err)
	}
	db, tx, status, err := s.sourceReadSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	defer tx.Rollback()
	if err := s.appendSourceFrames(context.Background(), [][]byte{second}); err != nil {
		t.Fatal(err)
	}
	if err := battleSourceCheckRows(context.Background(), tx, status); err != nil {
		t.Fatal(err)
	}
	writer := &sourceChunkWriter{}
	if err := battleSourceWrite(context.Background(), tx, status, writer, "json"); err != nil {
		t.Fatal(err)
	}
	if writer.data.String() != "["+string(first)+"]\n" || !reflect.DeepEqual(writer.chunks, []int{1, len(first), 2}) {
		t.Fatal("snapshot changed or aggregate heap/write")
	}
	bad := &sourceChunkWriter{fail: true}
	if err := battleSourceWrite(context.Background(), tx, status, bad, "json"); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal("writer failure hidden")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := battleSourceWrite(ctx, tx, status, &sourceChunkWriter{}, "json"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled writer kept snapshot active")
	}
}
