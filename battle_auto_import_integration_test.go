package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutoImportSystemInterruptionAndSkillBindings(t *testing.T) {
	e := BattleEvent{ID: "charge", Kind: "effect", Phase: "interrupted", Side: "me", Actor: "p", SkillClass: "system", ProtocolSkillID: "700001000"}
	if err := battleValidateActionFields(&e); err != nil {
		t.Fatal("interrupted charge rejected", err)
	}
	bad := e
	amount := float64(5)
	bad.Amount = &amount
	if battleValidateActionFields(&bad) == nil {
		t.Fatal("interrupted action carried effect amount")
	}
	bad = e
	bad.SkillClass = "passive"
	if battleValidateActionFields(&bad) == nil {
		t.Fatal("passive interrupted event accepted")
	}
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	identities, err := battleReadIdentityMap(data)
	if err != nil {
		t.Fatal(err)
	}
	r := BattleRecord{Events: []BattleEvent{{ID: "water", Kind: "skill", Phase: "executed", ProtocolSkillID: "705032000", ProtocolSkillConfigID: "7050320"}}}
	if err = identities.apply(&r, false); err != nil || r.Events[0].SkillID != 155 {
		t.Fatal("explicit config not mapped", r.Events, err)
	}
	r.Events[0].SkillID = 113
	if identities.apply(&r, false) == nil {
		t.Fatal("conflicting explicit local skill silently overwritten")
	}
}

func TestAutoImportActualFourAndReplay(t *testing.T) {
	archive, dbpath, catpath := os.Getenv("AUTO_IMPORT_ACTUAL_CSV"), os.Getenv("AUTO_IMPORT_ACTUAL_DB"), os.Getenv("AUTO_IMPORT_ACTUAL_CATALOG")
	if archive == "" || dbpath == "" || catpath == "" {
		t.Skip("explicit read-only actual fixture paths not supplied")
	}
	dbbytes, err := os.ReadFile(dbpath)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := os.ReadFile(catpath)
	if err != nil {
		t.Fatal(err)
	}
	dbfile := filepath.Join(t.TempDir(), "battle.sqlite")
	if err = os.WriteFile(dbfile, dbbytes, 0600); err != nil {
		t.Fatal(err)
	}
	service, err := NewBattleService(dbfile, func() ([]byte, error) { return append([]byte(nil), catalog...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ctx := context.Background()
	before, err := service.List(ctx, BattleFilter{}, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if before.Total != 1 {
		t.Fatalf("unexpected baseline=%d", before.Total)
	}
	oldID := "rkpp:1876469132858231449"
	var original string
	if err = service.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", oldID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	rules, err := service.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rulesBefore, _ := json.Marshal(rules)
	mux := http.NewServeMux()
	service.Register(mux)
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, "http://127.0.0.1"+path, strings.NewReader(body))
		request.RemoteAddr = "127.0.0.1:12345"
		if method != "GET" {
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Battle-Scan-Token", token)
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	metadata := call("GET", "/api/battles/scan", "", "")
	var settings struct {
		Path  string `json:"path"`
		Token string `json:"scanToken"`
	}
	if metadata.Code != 200 || json.Unmarshal(metadata.Body.Bytes(), &settings) != nil || settings.Token == "" {
		t.Fatal("scan metadata", metadata.Code, metadata.Body.String())
	}
	afterGet, err := service.List(ctx, BattleFilter{}, 1, 100)
	if err != nil || afterGet.Total != 1 {
		t.Fatal("GET triggered archive import", err)
	}
	payload, _ := json.Marshal(map[string]string{"path": archive})
	scan := call("POST", "/api/battles/scan", string(payload), settings.Token)
	if scan.Code != 200 {
		t.Fatal("actual manual scan failed", scan.Code, scan.Body.String())
	}
	var result struct {
		Imported, Updated, Unchanged, Completed, Pending int
		Issues                                           []string
	}
	if err = json.Unmarshal(scan.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Imported != 4 || result.Updated != 0 {
		t.Fatalf("expected four new records: %+v", result)
	}
	expected := map[string]struct {
		Rounds, Seconds int
		Outcome         string
	}{
		"rkpp:2306377934505522485": {29, 403, "win"}, "rkpp:1876469132858231472": {3, 47, "loss"},
		"rkpp:1876469132858231473": {8, 161, "loss"}, "rkpp:1876469132858231474": {31, 551, "win"},
	}
	records := []BattleRecord{}
	mappedSkills := 0
	for _, id := range []string{"rkpp:2306377934505522485", "rkpp:1876469132858231472", "rkpp:1876469132858231473", "rkpp:1876469132858231474"} {
		r, e := service.Record(ctx, id)
		if e != nil {
			t.Fatal(e)
		}
		want := expected[id]
		if r.Outcome != want.Outcome || r.Rounds != want.Rounds || r.DurationSeconds == nil || *r.DurationSeconds != want.Seconds {
			t.Fatalf("incorrect normalized settlement %s: outcome=%s rounds=%d duration=%v", id, r.Outcome, r.Rounds, r.DurationSeconds)
		}
		if len(r.Sides["me"].Pets) != 6 || len(r.Sides["enemy"].Pets) != 6 || !r.Quality.Roster["me"] || !r.Quality.Roster["enemy"] {
			t.Fatalf("explicit initial roster lost %s %+v", id, r.Quality)
		}
		if r.Quality.Actions {
			t.Fatal("partial capture upgraded to complete actions")
		}
		if len(r.Events) < 20 {
			t.Fatalf("lifecycle-only import %s: %d events", id, len(r.Events))
		}
		for _, event := range r.Events {
			if event.Kind == "skill" && event.SkillID > 0 {
				mappedSkills++
			}
		}
		raw, _ := json.Marshal(r)
		for _, forbidden := range []string{"role_uin", "owner_uin", "player_uin", "flow_id", "decoded_json", "raw_packet"} {
			if strings.Contains(string(raw), forbidden) {
				t.Fatalf("private field leaked into normalized record: %s", forbidden)
			}
		}
		records = append(records, r)
	}
	if mappedSkills == 0 {
		t.Fatal("no actual skills mapped into local identities")
	}
	after, err := service.List(ctx, BattleFilter{}, 1, 100)
	if err != nil || after.Total != 5 {
		t.Fatal("wrong final total", after.Total, err)
	}
	var preserved string
	if err = service.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", oldID).Scan(&preserved); err != nil || preserved != original {
		t.Fatal("old Oct29 record modified", err)
	}
	replay := call("POST", "/api/battles/scan", string(payload), settings.Token)
	if replay.Code != 200 {
		t.Fatal("replay failure", replay.Code, replay.Body.String())
	}
	if err = json.Unmarshal(replay.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Imported != 0 || result.Updated != 0 || result.Unchanged != 4 {
		t.Fatalf("non-idempotent archive replay %+v", result)
	}
	currentRules, err := service.Rules(ctx)
	rulesAfter, _ := json.Marshal(currentRules)
	if err != nil || string(rulesBefore) != string(rulesAfter) {
		t.Fatal("scan changed rules", err)
	}
	stats, err := service.Stats(ctx, BattleFilter{})
	if err != nil || stats.MatchedBattles != 5 {
		t.Fatal("five battle statistics failed", err)
	}
	if output := os.Getenv("AUTO_IMPORT_NORMALIZED_OUTPUT"); output != "" {
		data, e := json.MarshalIndent(map[string]any{"version": 1, "records": records}, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		file, e := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			t.Fatal(e)
		}
		_, e = file.Write(data)
		closeErr := file.Close()
		if e != nil || closeErr != nil {
			t.Fatal(e, closeErr)
		}
	}
	t.Logf("4 imported, replay4 unchanged, 6v6 each, mapped skill events=%d; original SHA256=%x", mappedSkills, sha256.Sum256([]byte(original)))
}
