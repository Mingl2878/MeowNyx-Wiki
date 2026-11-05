package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPageRevisionExactSourceInvalidationAndReadOnly(t *testing.T) {
	ctx := context.Background()
	catalogData, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	reads := 0
	s, err := NewBattleService(filepath.Join(t.TempDir(), "battle.sqlite"), func() ([]byte, error) { reads++; return append([]byte(nil), catalogData...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r := backendBattle(t, "page-revision-record")
	backendImport(t, s, r)
	getRevision := func() string {
		t.Helper()
		v, e := s.QueryRevision(ctx)
		if e != nil || v == "" {
			t.Fatal("revision", v, e)
		}
		return v
	}
	before := getRevision()
	reads = 0
	stats, err := s.Stats(ctx, BattleFilter{})
	if err != nil || reads != 1 || stats.Revision != before {
		t.Fatal("Stats not same snapshot", err, reads, stats.Revision, before)
	}
	reads = 0
	list, err := s.List(ctx, BattleFilter{}, 1, 25)
	if err != nil || reads != 1 || list.Revision != before {
		t.Fatal("List not same snapshot", err, reads, list.Revision, before)
	}
	var original string
	if err = s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", r.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if getRevision() != before {
		t.Fatal("read-only query changed source")
	}
	var afterRead string
	s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", r.ID).Scan(&afterRead)
	if afterRead != original {
		t.Fatal("statistics/revision rewrote source")
	}
	external, err := sql.Open("sqlite", s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer external.Close()
	var record map[string]any
	if err = json.Unmarshal([]byte(original), &record); err != nil {
		t.Fatal(err)
	}
	// A same-count, same-length raw edit must invalidate. No weak count/length token.
	record["source"] = "canonxxxx"
	changed, _ := json.Marshal(record)
	if _, err = external.Exec("UPDATE battles SET record_json=? WHERE id=?", string(changed), r.ID); err != nil {
		t.Fatal(err)
	}
	v2 := getRevision()
	if v2 == before {
		t.Fatal("external raw edit invisible")
	}
	if _, err = external.Exec("UPDATE battles SET started_at=? WHERE id=?", "2026-10-29T03:00:00Z", r.ID); err != nil {
		t.Fatal(err)
	}
	v3 := getRevision()
	if v3 == v2 {
		t.Fatal("indexed date change invisible")
	}
	if _, err = external.Exec("UPDATE battles SET outcome='loss' WHERE id=?", r.ID); err != nil {
		t.Fatal(err)
	}
	v4 := getRevision()
	if v4 == v3 {
		t.Fatal("indexed outcome change invisible")
	}
	rules, err := s.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PutRules(ctx, []BattleTeamRule{{ID: "one", Name: "First", MonsterIDs: []int{2}}}, battleRulesRevision(rules)); err != nil {
		t.Fatal(err)
	}
	v5 := getRevision()
	if v5 == v4 {
		t.Fatal("rules update invisible")
	}
	if _, err = external.Exec(`UPDATE battle_rules SET rule_json='{"id":"one","name":"Other","monsterIds":[2]}' WHERE id='one'`); err != nil {
		t.Fatal(err)
	}
	v6 := getRevision()
	if v6 == v5 {
		t.Fatal("same-length external rule edit invisible")
	}
	catalogData = append(catalogData, '\n')
	v7 := getRevision()
	if v7 == v6 {
		t.Fatal("exact catalog bytes change invisible")
	}
	mux := http.NewServeMux()
	s.Register(mux)
	req := httptest.NewRequest("GET", "http://127.0.0.1/api/battles/revision", nil)
	req.RemoteAddr = "127.0.0.1:1"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var reply struct {
		Revision string `json:"revision"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &reply); err != nil || reply.Revision != v7 {
		t.Fatal("HTTP revision", err, reply)
	}
	req = httptest.NewRequest("POST", "http://127.0.0.1/api/battles/revision", nil)
	req.RemoteAddr = "127.0.0.1:1"
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if w.Code != 405 {
		t.Fatal("revision endpoint accepted write", w.Code)
	}
}
