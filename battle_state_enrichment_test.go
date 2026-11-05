package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBattleStateEnrichmentActualFixture(t *testing.T) {
	if os.Getenv("XHM_STATE_INPUT") == "" {
		t.Skip("explicit frozen state fixture required")
	}
	read := func(key string) []byte {
		p := os.Getenv(key)
		if !filepath.IsAbs(p) {
			t.Fatal("absolute fixture path required", key)
		}
		b, e := os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	before := read("XHM_STATE_BEFORE")
	var original BattleRecord
	if e := json.Unmarshal(before, &original); e != nil {
		t.Fatal(e)
	}
	input, _, err := DecodeBattleImport(read("XHM_STATE_INPUT"))
	if err != nil {
		t.Fatal(err)
	}
	if len(input) != 1 || input[0].ID != original.ID {
		t.Fatal("wrong record")
	}
	db := filepath.Join(t.TempDir(), "状态验证.sqlite")
	if err = os.WriteFile(db, read("XHM_STATE_DB_BEFORE"), 0600); err != nil {
		t.Fatal(err)
	}
	catalog := read("XHM_STATE_CATALOG")
	s, err := NewBattleService(db, func() ([]byte, error) { return catalog, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	result, err := s.Import(context.Background(), input, map[string]string{original.ID: fmt.Sprintf("%x", sha256.Sum256(before))})
	if err != nil || result.Imported != 1 {
		t.Fatalf("merge %+v %v", result, err)
	}
	r, err := s.Record(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Events) != 283 || r.Rounds != 36 || !reflect.DeepEqual(r.Sides, original.Sides) || r.ImportedAt != original.ImportedAt || r.Outcome != original.Outcome || !reflect.DeepEqual(r.Quality, original.Quality) {
		t.Fatal("record identity/history/quality changed")
	}
	byID := map[string]BattleEvent{}
	initial, entries, snapshots, costs, approved := 0, 0, 0, 0, 0
	for _, e := range r.Events {
		byID[e.ID] = e
		switch e.StateStage {
		case "initial":
			initial++
		case "entry":
			entries++
		case "snapshot":
			snapshots++
		}
		if e.EnergyCost != nil {
			costs++
		}
		if e.ProtocolSkillID == "702111100" {
			approved++
			if e.SkillID != 74 {
				t.Fatal("approved mapping not applied")
			}
		}
	}
	if initial != 12 || entries != 3 || snapshots != 68 || costs != 59 || approved != 2 {
		t.Fatalf("wrong coverage %d %d %d %d %d", initial, entries, snapshots, costs, approved)
	}
	wind := byID["rkpp:action:5:26:1:cast"]
	if wind.Actor != "3" || wind.SkillID != 351 || wind.EnergyCost == nil || *wind.EnergyCost != 0 {
		t.Fatal("Wind current cost lost")
	}
	for _, id := range []string{"rkpp:action:3:15:12:cast", "rkpp:action:35:192:110:cast"} {
		e := byID[id]
		if e.EnergyCost == nil || *e.EnergyCost != 0 {
			t.Fatal("approved original-runtime cost inheritance lost", id)
		}
	}
	for _, old := range original.Events {
		got, ok := byID[old.ID]
		if !ok {
			t.Fatal("old event deleted")
		}
		got.EnergyCost = old.EnergyCost
		if old.ProtocolSkillID == "702111100" && old.SkillID == 0 {
			old.SkillID = 74
		}
		if !reflect.DeepEqual(old, got) {
			t.Fatal("old event core changed", old.ID)
		}
	}
	second, err := s.Import(context.Background(), input)
	if err != nil || second.Imported != 0 || second.Duplicates != 1 {
		t.Fatalf("not idempotent %+v %v", second, err)
	}
	bad, _ := battleClone(input[0])
	for i := range bad.Events {
		if bad.Events[i].ID == wind.ID {
			n := 1
			bad.Events[i].EnergyCost = &n
		}
	}
	if _, err = s.Import(context.Background(), []BattleRecord{bad}); err == nil {
		t.Fatal("known cost was overwritten")
	}
	after, err := s.Record(context.Background(), original.ID)
	if err != nil || !reflect.DeepEqual(r, after) {
		t.Fatal("conflict changed database")
	}
	output := os.Getenv("XHM_STATE_OUTPUT")
	if !filepath.IsAbs(output) {
		t.Fatal("isolated output path required")
	}
	data, _ := json.MarshalIndent(r, "", "  ")
	if err = os.WriteFile(output, data, 0600); err != nil {
		t.Fatal(err)
	}
}
