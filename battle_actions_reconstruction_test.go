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

// Read explicitly selected, frozen source evidence; ALL DB writes use t.TempDir.
func TestBattleActionsActualSourceFixture(t *testing.T) {
	if os.Getenv("XHM_ACTION_INPUT") == "" {
		t.Skip("explicit offline fixture not supplied")
	}
	read := func(key string) []byte {
		p := os.Getenv(key)
		if !filepath.IsAbs(p) {
			t.Fatal("absolute frozen fixture path required", key)
		}
		b, e := os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	originalBytes := read("XHM_ACTION_BEFORE")
	cat := read("XHM_ACTION_CATALOG")
	database := read("XHM_ACTION_DB_BEFORE")
	var original BattleRecord
	if e := json.Unmarshal(originalBytes, &original); e != nil {
		t.Fatal(e)
	}
	incoming, _, e := DecodeBattleImport(read("XHM_ACTION_INPUT"))
	if e != nil {
		t.Fatal(e)
	}
	if len(incoming) != 1 || incoming[0].ID != original.ID {
		t.Fatal("must enrich existing battle only")
	}
	path := filepath.Join(t.TempDir(), "行动验证.sqlite")
	if e = os.WriteFile(path, database, 0600); e != nil {
		t.Fatal(e)
	}
	s, e := NewBattleService(path, func() ([]byte, error) { return cat, nil })
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	expected := fmt.Sprintf("%x", sha256.Sum256(originalBytes))
	first, e := s.Import(context.Background(), incoming, map[string]string{original.ID: expected})
	if e != nil || first.Imported != 1 {
		t.Fatalf("guarded merge %+v: %v", first, e)
	}
	r, e := s.Record(context.Background(), original.ID)
	if e != nil {
		t.Fatal(e)
	}
	if r.Rounds != 36 || len(r.Events) != 200 || len(r.Sides["me"].Pets) != 6 || len(r.Sides["enemy"].Pets) != 6 || r.ImportedAt != original.ImportedAt || r.Outcome != original.Outcome {
		t.Fatal("identity/history changed")
	}
	if r.Quality.Actions || r.Quality.Lead["me"] || r.Quality.Lead["enemy"] {
		t.Fatal("unproven quality elevated")
	}
	if !reflect.DeepEqual(r.Sides, original.Sides) {
		t.Fatal("initial identity/config was changed")
	}
	counts := map[string]int{}
	lifecycles, interrupts, unmappedResponse := 0, 0, 0
	firstDamage, overkill := false, false
	heals := []float64{}
	byID := map[string]BattleEvent{}
	for _, event := range r.Events {
		byID[event.ID] = event
		counts[event.Kind]++
		if event.Lifecycle != "" {
			lifecycles++
		}
		if event.Phase == "interrupted" {
			interrupts++
			if event.Kind != "skill" {
				t.Fatal("invalid interruption")
			}
		}
		if event.ProtocolSkillID == "702111100" {
			unmappedResponse++
			if event.SkillID != 0 {
				t.Fatal("source-family candidate mapped as definite")
			}
		}
		if event.SkillClass == "passive" || event.SkillClass == "system" {
			if event.Kind == "skill" || event.SkillID != 0 {
				t.Fatal("passive/system inflated ordinary skill usage")
			}
		}
		if event.Kind == "damage" {
			if event.Amount == nil || event.HPChange == nil || event.HPAfter == nil {
				t.Fatal("explicit damage evidence omitted")
			}
			if event.Round == 1 {
				firstDamage = *event.Amount == 115 && *event.HPChange == -115 && *event.HPAfter == 343 && event.Actor == "401" && event.Target == "3"
			}
			if event.Round == 8 && *event.Amount == 642 {
				overkill = *event.HPChange == -340 && *event.HPAfter == 0
			}
		}
		if event.Kind == "heal" {
			if event.Amount == nil {
				t.Fatal("heal missing")
			}
			heals = append(heals, *event.Amount)
		}
		if event.Round > 36 {
			t.Fatal("outside battle")
		}
	}
	expectedCounts := map[string]int{"note": 38, "form": 7, "skill": 42, "damage": 26, "heal": 3, "switch": 10, "effect": 40, "resource": 34}
	if !reflect.DeepEqual(counts, expectedCounts) || lifecycles != 38 || interrupts != 3 || unmappedResponse != 2 || !firstDamage || !overkill || !reflect.DeepEqual(heals, []float64{21, 20, 195}) {
		t.Fatalf("action evidence mismatch: %+v life%d interrupt%d unresolved%d first%v overkill%v heals%v", counts, lifecycles, interrupts, unmappedResponse, firstDamage, overkill, heals)
	}
	for _, old := range original.Events {
		event, ok := byID[old.ID]
		if !ok {
			t.Fatal("old event deleted", old.ID)
		}
		event.ExecIndex = nil
		event.Lifecycle = ""
		if !reflect.DeepEqual(old, event) {
			t.Fatal("old event altered", old.ID)
		}
	}
	second, e := s.Import(context.Background(), incoming)
	if e != nil || second.Imported != 0 || second.Duplicates != 1 {
		t.Fatalf("duplicate changed result: %+v %v", second, e)
	}
	bad := append([]BattleRecord(nil), incoming...)
	bad[0], e = battleClone(incoming[0])
	if e != nil {
		t.Fatal(e)
	}
	for i := range bad[0].Events {
		if bad[0].Events[i].Kind == "damage" {
			value := 999.0
			bad[0].Events[i].Amount = &value
			break
		}
	}
	if _, e = s.Import(context.Background(), bad); e == nil {
		t.Fatal("conflicting known damage overwrote evidence")
	}
	after, e := s.Record(context.Background(), original.ID)
	if e != nil || !reflect.DeepEqual(r, after) {
		t.Fatal("conflict was not atomic")
	}
	output := os.Getenv("XHM_ACTION_OUTPUT")
	if !filepath.IsAbs(output) {
		t.Fatal("explicit isolated output required")
	}
	encoded, _ := json.MarshalIndent(r, "", "  ")
	if e = os.WriteFile(output, encoded, 0600); e != nil {
		t.Fatal(e)
	}
}
