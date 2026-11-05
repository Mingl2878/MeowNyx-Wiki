package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestPageRevisionActualSevenIntegration(t *testing.T) {
	dbpath, catpath := os.Getenv("PAGE_REVISION_ACTUAL_DB"), os.Getenv("PAGE_REVISION_ACTUAL_CATALOG")
	if dbpath == "" || catpath == "" {
		t.Skip("explicit immutable seven-record backup paths not supplied")
	}
	dbbytes, err := os.ReadFile(dbpath)
	if err != nil {
		t.Fatal(err)
	}
	cat, err := os.ReadFile(catpath)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "battle.sqlite")
	if err = os.WriteFile(file, dbbytes, 0600); err != nil {
		t.Fatal(err)
	}
	reads := 0
	s, err := NewBattleService(file, func() ([]byte, error) { reads++; return append([]byte(nil), cat...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	// Explicit read opens the service; no import/re-encoding of frozen records.
	list, err := s.List(ctx, BattleFilter{}, 1, 100)
	if err != nil || list.Total != 7 {
		t.Fatal("seven-record baseline", err, list.Total)
	}
	rawSnapshot := func() map[string]string {
		rows, e := s.db.Query("SELECT id,record_json FROM battles")
		if e != nil {
			t.Fatal(e)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var id, raw string
			if e = rows.Scan(&id, &raw); e != nil {
				t.Fatal(e)
			}
			out[id] = raw
		}
		return out
	}
	rules, err := s.Rules(ctx)
	if err != nil || len(rules) != 15 {
		t.Fatal("fifteen rules", err, len(rules))
	}
	rulesBefore := battleRuleSourceInputs(rules)
	before := rawSnapshot()
	reads = 0
	start := time.Now()
	stats, err := s.Stats(ctx, BattleFilter{})
	first := time.Since(start)
	if err != nil || reads != 1 {
		t.Fatal("single immutable catalogue reader", err, reads)
	}
	if stats.MatchedBattles != 7 || stats.Archetypes.Samples != 7 || stats.Archetypes.AssignmentCount != 8 {
		t.Fatal("multilabel counts", stats.MatchedBattles, stats.Archetypes)
	}
	if stats.Revision == "" || stats.Revision != list.Revision {
		t.Fatal("same exact version", stats.Revision, list.Revision)
	}
	ownRecord, err := s.Record(ctx, "rkpp:1876469132858231449")
	if err != nil {
		t.Fatal(err)
	}
	singleGrowth := BuildBattleGrowthStats([]BattleRecord{ownRecord}, cat)
	var shark *BattleTraitGrowth
	for _, p := range singleGrowth.Me {
		if p.MonsterID == 202 {
			shark = p.Trait
		}
	}
	if shark == nil || shark.Average == nil || *shark.Average != 9 || shark.Total != 9 || shark.ObservedPrefixSamples != 1 {
		t.Fatal("entry water-history nine", shark)
	}
	history := BuildBattleGrowthHistory(ownRecord, cat)
	found := false
	for _, entry := range history.Entries {
		if entry.Side == "me" && entry.Actor == "5" && entry.Round == 22 {
			if !entry.Known || entry.Count == nil || *entry.Count != 9 || len(entry.EvidenceEventIDs) != 9 {
				t.Fatal("R22 history evidence", entry)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("missing R22 entry snapshot")
	}
	start = time.Now()
	warm, err := s.Stats(ctx, BattleFilter{})
	duration := time.Since(start)
	if err != nil || !reflect.DeepEqual(stats, warm) {
		t.Fatal("warm statistics differ", err)
	}
	if !reflect.DeepEqual(before, rawSnapshot()) {
		t.Fatal("derived statistics rewrote actual frozen JSON")
	}
	rules, err = s.Rules(ctx)
	if err != nil || !reflect.DeepEqual(rulesBefore, battleRuleSourceInputs(rules)) {
		t.Fatal("original rules changed", err)
	}
	if path := os.Getenv("PAGE_REVISION_STATS_OUTPUT"); path != "" {
		raw, _ := json.MarshalIndent(stats, "", "  ")
		if err = os.WriteFile(path, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("7 distinct battles / 8 assignments; R22 nine observed-prefix layers; sourceSHA=%x; first Stats=%s, warm Stats=%s; raw records/rules unchanged", sha256.Sum256(dbbytes), first, duration)
}
