package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func backendRequest(mux http.Handler, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:8080"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}
func backendMux(t *testing.T) (*BattleService, *http.ServeMux) {
	t.Helper()
	s := backendService(t)
	mux := http.NewServeMux()
	s.Register(mux)
	return s, mux
}

// HTTP CAS uses the server's loaded revision, which includes effective defaults
// and the current catalog family fingerprint, not a hash of a wire-only draft.
func backendLoadedRules(t *testing.T, mux http.Handler) ([]BattleTeamRule, string) {
	t.Helper()
	response := backendRequest(mux, "GET", "/api/battles/rules", "")
	var loaded struct {
		Rules    []BattleTeamRule `json:"rules"`
		Revision string           `json:"revision"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &loaded) != nil || len(loaded.Revision) != 64 {
		t.Fatalf("load rules: %d %s", response.Code, response.Body.String())
	}
	return loaded.Rules, loaded.Revision
}

func TestBackendHTTPRegistrationLazy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent", "battle.sqlite")
	mux := http.NewServeMux()
	closeService := RegisterBattleRecordRoutes(mux, path)
	if code := backendRequest(mux, "GET", "/unrelated", "").Code; code != 404 {
		t.Fatal(code)
	}
	if code := backendRequest(mux, "GET", "/api/battles/status", "").Code; code != 200 {
		t.Fatal(code)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("lazy registration/status touched path", err)
	}
	if code := backendRequest(mux, "GET", "/api/battles/list", "").Code; code != 200 {
		t.Fatal(code)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := closeService(); err != nil {
		t.Fatal(err)
	}
	if code := backendRequest(mux, "GET", "/api/battles/list", "").Code; code != 503 {
		t.Fatal(code)
	}
	bad := http.NewServeMux()
	defer RegisterBattleRecordRoutes(bad, "relative.sqlite")()
	if w := backendRequest(bad, "GET", "/api/battles/list", ""); w.Code != 503 || strings.Contains(w.Body.String(), "relative.sqlite") {
		t.Fatal(w)
	}
}

func TestBackendHTTPMethodsOriginsAndContentTypes(t *testing.T) {
	_, mux := backendMux(t)
	for _, path := range []string{"list", "record", "stats", "status", "rules", "import", "relay/start", "relay/stop"} {
		w := backendRequest(mux, "DELETE", "/api/battles/"+path, "{}")
		if w.Code != 405 || w.Header().Get("Allow") == "" {
			t.Fatal(path, w)
		}
	}
	tests := []struct {
		host, origin, site, remote string
		status                     int
	}{
		{"127.0.0.1:8080", "http://127.0.0.1:8080", "same-origin", "127.0.0.1:1", 200},
		{"localhost:8080", "http://localhost:8080", "same-origin", "[::1]:1", 200},
		{"127.0.0.1:8080", "http://evil.example", "", "127.0.0.1:1", 403},
		{"127.0.0.1:8080", "null", "", "127.0.0.1:1", 403},
		{"127.0.0.1:8080", "http://127.0.0.1:8081", "", "127.0.0.1:1", 403},
		{"127.0.0.1:8080", "https://127.0.0.1:8080", "", "127.0.0.1:1", 403},
		{"evil.example:8080", "", "", "127.0.0.1:1", 403},
		{"127.0.0.1:8080", "", "cross-site", "127.0.0.1:1", 403},
		{"127.0.0.1:8080", "", "", "192.0.2.2:1", 403},
	}
	for _, test := range tests {
		r := httptest.NewRequest("GET", "http://"+test.host+"/api/battles/status", nil)
		r.RemoteAddr = test.remote
		if test.origin != "" {
			r.Header.Set("Origin", test.origin)
		}
		if test.site != "" {
			r.Header.Set("Sec-Fetch-Site", test.site)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%+v: %d %s", test, w.Code, w.Body.String())
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("CORS enabled")
		}
	}
	for _, content := range []string{"text/plain", "application/x-www-form-urlencoded", "", "application/json; charset=latin1"} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/battles/import", strings.NewReader("{}"))
		r.RemoteAddr = "127.0.0.1:1"
		r.Header.Set("Content-Type", content)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 415 {
			t.Fatal(content, w)
		}
	}
}

func TestBackendHTTPImportRawBytesDedupAndSafeErrors(t *testing.T) {
	s, mux := backendMux(t)
	r := backendBattle(t, "http")
	data, _ := json.Marshal(r)
	var obj map[string]any
	json.Unmarshal(data, &obj)
	obj["rawPayload"] = "never-store-this-payload"
	obj["aesKey"] = "never-store-this-key"
	obj["ip"] = "203.0.113.99"
	data, _ = json.Marshal(obj)
	for i := 0; i < 2; i++ {
		w := backendRequest(mux, "POST", "/api/battles/import", string(data))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var result BattleImportResult
		json.Unmarshal(w.Body.Bytes(), &result)
		if i == 0 && result.Imported != 1 || i == 1 && result.Duplicates != 1 {
			t.Fatal(result)
		}
	}
	stored, err := s.Record(context.Background(), "http")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(stored)
	for _, secret := range []string{"never-store", "203.0.113.99", "aesKey", "rawPayload"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatal("secret retained", secret)
		}
	}
	// Raw body is passed to decoder (no envelope imposed by HTTP). NDJSON is
	// accepted independently of ordinary JSON content type.
	second, _ := json.Marshal(backendBattle(t, "second"))
	req := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/battles/import", bytes.NewReader(append(second, '\n')))
	req.RemoteAddr = "127.0.0.1:1"
	req.Header.Set("Content-Type", "application/x-ndjson")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = backendRequest(mux, "POST", "/api/battles/import", `{"secret":"never-return-this-raw-key"}`)
	if w.Code != 400 || strings.Contains(w.Body.String(), "never-return") {
		t.Fatal(w)
	}
	w = backendRequest(mux, "POST", "/api/battles/import", strings.Repeat(" ", battleImportLimit+1))
	if w.Code != 413 {
		t.Fatal(w.Code)
	}
	w = backendRequest(mux, "GET", "/api/battles/record?id=http", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "event-1") {
		t.Fatal(w)
	}
	if w = backendRequest(mux, "GET", "/api/battles/record?id=missing", ""); w.Code != 404 {
		t.Fatal(w)
	}
	if w = backendRequest(mux, "PUT", "/api/battles/rules", `{"rules":[],"secret":true}`); w.Code != 400 {
		t.Fatal(w)
	}
	if w = backendRequest(mux, "PUT", "/api/battles/rules", `{}`); w.Code != 400 {
		t.Fatal(w)
	}
	loadedRules, loadedRevision := backendLoadedRules(t, mux)
	if len(loadedRules) != 15 {
		t.Fatal("unconfigured HTTP rules did not expose bundled defaults")
	}
	if w = backendRequest(mux, "PUT", "/api/battles/rules", `{"rules":[],"baseRevision":"`+loadedRevision+`"}`); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	clearedRules, clearedRevision := backendLoadedRules(t, mux)
	if len(clearedRules) != 0 || clearedRevision == loadedRevision {
		t.Fatal("explicit HTTP clear did not persist")
	}
	if w = backendRequest(mux, "PUT", "/api/battles/rules", `{"rules":[],"baseRevision":"`+loadedRevision+`"}`); w.Code != 409 {
		t.Fatal("stale default revision accepted", w.Code, w.Body.String())
	}
	preservedRules, preservedRevision := backendLoadedRules(t, mux)
	if cbJSON(preservedRules) != cbJSON(clearedRules) || preservedRevision != clearedRevision {
		t.Fatal("stale HTTP replacement changed committed empty state")
	}
	if w = backendRequest(mux, "POST", "/api/battles/relay/stop", `{} {}`); w.Code != 400 {
		t.Fatal(w)
	}
}

func TestBackendHTTPFilterValidation(t *testing.T) {
	_, mux := backendMux(t)
	invalid := []string{"outcome=bad", "monsterId=0", "monsterId=no", "rankSide=other", "rankMin=NaN&rankMetric=score&rankSide=me", "rankMin=1", "rankMetric=rank&rankSide=enemy&rankMin=0", "rankMetric=score&rankSide=me&rankMin=2&rankMax=1", "from=bad", "from=2026-10-28T00:00:00Z&to=2026-10-27T00:00:00Z", "outcome=win&outcome=loss", "typo=1", "tier=x&rankMetric=score", "rankMetric=score", "page=0", "pageSize=101"}
	for _, q := range invalid {
		w := backendRequest(mux, "GET", "/api/battles/list?"+q, "")
		if w.Code != 400 {
			t.Fatal(q, w.Code, w.Body.String())
		}
	}
	for _, q := range []string{"", "outcome=unknown", "monsterId=2", "rankMetric=score&rankSide=me&rankMin=1.5", "rankMetric=tier&rankSide=enemy&tier=Gold", "from=" + url.QueryEscape("2026-10-28T00:00:00+08:00")} {
		v, err := url.ParseQuery(q)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseBattleFilter(v); err != nil {
			t.Fatal(q, err)
		}
	}
}

type backendDeadlineWriter struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *backendDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}
func TestBackendHTTPBodyReadDeadline(t *testing.T) {
	_, mux := backendMux(t)
	r := httptest.NewRequest("POST", "http://127.0.0.1:8080/api/battles/relay/stop", strings.NewReader("{}"))
	r.RemoteAddr = "127.0.0.1:1"
	r.Header.Set("Content-Type", "application/json")
	w := &backendDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
	mux.ServeHTTP(w, r)
	if len(w.deadlines) != 2 || w.deadlines[0].IsZero() || !w.deadlines[1].IsZero() {
		t.Fatal(fmt.Sprint(w.deadlines))
	}
}

func TestBackendHTTPBackpressureAndSafeDiagnostics(t *testing.T) {
	s, mux := backendMux(t)
	s.requests <- struct{}{}
	s.requests <- struct{}{}
	if w := backendRequest(mux, "POST", "/api/battles/import", `{}`); w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal(w)
	}
	if w := backendRequest(mux, "GET", "/api/battles/status", ""); w.Code != 200 {
		t.Fatal("status blocked by admission limit", w)
	}
	if w := backendRequest(mux, "POST", "/api/battles/relay/stop", `{}`); w.Code != 200 {
		t.Fatal("stop blocked by admission limit", w)
	}
	<-s.requests
	<-s.requests
	w := backendRequest(mux, "POST", "/api/battles/import", `{"rawPayload":"secret-content","key":"secret-key"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "No supported battle records") || strings.Contains(w.Body.String(), "secret-") {
		t.Fatal(w)
	}
}

func TestBackendHTTPConstraintsAndEvidencePersist(t *testing.T) {
	s, mux := backendMux(t)
	r := backendBattle(t, "enrichment")
	damage := 42
	r.Constraints = []BattleConstraint{{ID: "constraint-1", Side: "me", InstanceID: "self", Kind: "damageDealt", Stat: "attack", KnownStat: 200, Power: 80, Damage: &damage, Level: 60, Effectiveness: 1, ModifiersKnown: true, Provenance: "normalized test declaration"}}
	side := r.Sides["me"]
	side.Pets[0].IV = map[string]BattleEvidence{"attack": {Certainty: "unknown"}}
	r.Sides["me"] = side
	data, _ := json.Marshal(r)
	w := backendRequest(mux, "POST", "/api/battles/import", string(data))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	value := 60.0
	side = r.Sides["me"]
	side.Pets[0].IV["attack"] = BattleEvidence{Certainty: "direct", Value: &value}
	r.Sides["me"] = side
	data, _ = json.Marshal(r)
	w = backendRequest(mux, "POST", "/api/battles/import", string(data))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	saved, err := s.Record(context.Background(), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Constraints) != 1 || saved.Constraints[0].KnownStat != 200 || saved.Constraints[0].Damage == nil || *saved.Constraints[0].Damage != 42 || saved.Sides["me"].Pets[0].IV["attack"].Value == nil || *saved.Sides["me"].Pets[0].IV["attack"].Value != 60 {
		t.Fatal("conditions/evidence not persisted", saved)
	}
	value = 0
	data, _ = json.Marshal(r)
	w = backendRequest(mux, "POST", "/api/battles/import", string(data))
	if w.Code != 400 {
		t.Fatal("conflicting direct evidence accepted", w.Code, w.Body.String())
	}
	saved, err = s.Record(context.Background(), r.ID)
	if err != nil || *saved.Sides["me"].Pets[0].IV["attack"].Value != 60 {
		t.Fatal("conflict overwrote evidence", err)
	}
}
