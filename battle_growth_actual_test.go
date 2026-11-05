package main

import (
	"crypto/sha256"
	"encoding/json"
	"os"
	"testing"
	canonicalcatalog "xhmwiki/internal/catalog"
)

// Optional explicit-path audit only. No defaults to real player directories,
// no database access and no writes; normal unit test runs skip it.
func TestBattleGrowthFrozenAudit(t *testing.T) {
	recordPath, catalogPath := os.Getenv("BATTLE_GROWTH_AUDIT_RECORD"), os.Getenv("BATTLE_GROWTH_AUDIT_CATALOG")
	if recordPath == "" || catalogPath == "" {
		t.Skip("set explicit frozen snapshot paths for read-only availability audit")
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	var r BattleRecord
	if err = json.Unmarshal(data, &r); err != nil {
		t.Fatal(err)
	}
	parsed, parseErr := canonicalcatalog.Parse(catalog)
	if parseErr != nil {
		t.Logf("catalog unavailable: %v", parseErr)
	} else {
		t.Logf("catalog monsters=%d selectedTraits=%d", len(parsed.Monsters), len(battleGrowthReadCatalog(catalog).traits))
	}
	before, _ := json.Marshal(r)
	out := BuildBattleGrowthStats([]BattleRecord{r}, catalog)
	after, _ := json.Marshal(r)
	if string(before) != string(after) {
		t.Fatal("audit mutated the input record")
	}
	counts := map[string]int{}
	typed, initial := 0, 0
	for _, e := range r.Events {
		counts[e.Kind]++
		if e.Growth != nil {
			typed++
		}
	}
	for _, s := range r.Sides {
		for _, p := range s.Pets {
			if p.InitialSkills != nil {
				initial++
			}
		}
	}
	encoded, _ := json.Marshal(out)
	t.Logf("recordSHA256=%x events=%d kinds=%v actions=%v typedGrowth=%d initialSkills=%d", sha256.Sum256(data), len(r.Events), counts, r.Quality.Actions, typed, initial)
	t.Logf("growth=%s", encoded)
}
