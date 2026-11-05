package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSkillBackfillActualHTTPPreservesAllOtherFacts(t *testing.T) {
	dbPath, catPath, payloadPath := os.Getenv("SKILL_BACKFILL_DB"), os.Getenv("SKILL_BACKFILL_CATALOG"), os.Getenv("SKILL_BACKFILL_PAYLOAD")
	if dbPath == "" || catPath == "" || payloadPath == "" {
		t.Skip("explicit read-only snapshot inputs not provided")
	}
	raw, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "battles.sqlite")
	if err = os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	cat, err := os.ReadFile(catPath)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(payloadPath)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewBattleService(file, func() ([]byte, error) { return append([]byte(nil), cat...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ctx := context.Background()
	list, err := service.List(ctx, BattleFilter{}, 1, 100)
	if err != nil || list.Total != 7 {
		t.Fatal("baseline", list.Total, err)
	}
	snapshot := func() map[string]string {
		rows, e := service.db.QueryContext(ctx, "SELECT id,record_json FROM battles")
		if e != nil {
			t.Fatal(e)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var id, data string
			if e = rows.Scan(&id, &data); e != nil {
				t.Fatal(e)
			}
			out[id] = data
		}
		if e = rows.Err(); e != nil {
			t.Fatal(e)
		}
		return out
	}
	before := snapshot()
	rules, err := service.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rulesBefore, _ := json.Marshal(rules)
	var envelope struct {
		Version int            `json:"version"`
		Records []BattleRecord `json:"records"`
	}
	if err = json.Unmarshal(payload, &envelope); err != nil || envelope.Version != 1 || len(envelope.Records) != 5 {
		t.Fatal("payload", err)
	}
	expected := map[string]BattleRecord{}
	identityCount := 0
	for _, r := range envelope.Records {
		var old BattleRecord
		if err = json.Unmarshal([]byte(before[r.ID]), &old); err != nil {
			t.Fatal(err)
		}
		if len(r.Events) != len(old.Events) {
			t.Fatal("event count changed")
		}
		for i, event := range r.Events {
			if event.SkillID != old.Events[i].SkillID {
				if old.Events[i].SkillID != 0 || event.SkillID <= 0 {
					t.Fatal("known identity overwritten")
				}
				identityCount++
			}
		}
		expected[r.ID] = r
	}
	if identityCount != 19 {
		t.Fatal("expected nineteen identity-only additions", identityCount)
	}
	mux := http.NewServeMux()
	service.Register(mux)
	post := func() BattleImportResult {
		req := httptest.NewRequest("POST", "http://127.0.0.1/api/battles/import", strings.NewReader(string(payload)))
		req.RemoteAddr = "127.0.0.1:12345"
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal("HTTP import", w.Code, w.Body.String())
		}
		var result BattleImportResult
		if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := post(); result.Imported != 5 || result.Updated != 5 || result.Duplicates != 0 {
		t.Fatal("first enrichment", result)
	}
	after := snapshot()
	if len(after) != 7 {
		t.Fatal("new battle accidentally added")
	}
	for id, prior := range before {
		want, changed := expected[id]
		if !changed {
			if after[id] != prior {
				t.Fatal("unaffected record raw bytes changed", id)
			}
			continue
		}
		battleIssue(&want, battleCanonicalWarning)
		var got BattleRecord
		if err = json.Unmarshal([]byte(after[id]), &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("unexpected fact change in %s; only planned skill IDs and normalized-import notice allowed", id)
		}
	}
	if result := post(); result.Imported != 0 || result.Updated != 0 || result.Duplicates != 5 {
		t.Fatal("replay not idempotent", result)
	}
	if !reflect.DeepEqual(after, snapshot()) {
		t.Fatal("replay changed stored bytes")
	}
	rules, err = service.Rules(ctx)
	rulesAfter, _ := json.Marshal(rules)
	if err != nil || string(rulesBefore) != string(rulesAfter) {
		t.Fatal("rules changed", err)
	}
	stats, err := service.Stats(ctx, BattleFilter{})
	if err != nil || stats.MatchedBattles != 7 {
		t.Fatal("statistics failed", err)
	}
	if !reflect.DeepEqual(after, snapshot()) {
		t.Fatal("derived statistics mutated stored records")
	}
	t.Log("19 confirmed skill identities enriched across 5/7 records; replay no-op; all other facts and rules preserved")
}
