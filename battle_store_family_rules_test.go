package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"xhmwiki/internal/catalog"
)

func familyRulesService(t *testing.T, path string, reader ...func() ([]byte, error)) *BattleService {
	t.Helper()
	s, err := NewBattleService(path, reader...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestStoreFamilyRulesDefaultsReadReloadCustomAndExplicitClear(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "battles.sqlite")
	s := familyRulesService(t, path)
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("constructor touched database", err)
	}
	initial, err := s.Rules(ctx)
	if err != nil || len(initial) != 15 {
		t.Fatal("first read", len(initial), err)
	}
	var stored, markers int
	if err = s.db.QueryRow("SELECT count(*) FROM battle_rules").Scan(&stored); err != nil || stored != 0 {
		t.Fatal("GET inserted default rows", stored, err)
	}
	if err = s.db.QueryRow("SELECT count(*) FROM battle_rule_state").Scan(&markers); err != nil || markers != 0 {
		t.Fatal("GET configured defaults", markers, err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = familyRulesService(t, path)
	reloaded, err := s.Rules(ctx)
	if err != nil || battleRulesRevision(reloaded) != battleRulesRevision(initial) {
		t.Fatal("reload defaults", err)
	}
	custom := []BattleTeamRule{{ID: "my-custom", Name: "Custom", MonsterIDs: []int{987654}, AnyOf: [][]int{{111, 109}}}}
	saved, err := s.PutRules(ctx, custom, battleRulesRevision(reloaded))
	if err != nil || len(saved) != 1 {
		t.Fatal(err)
	}
	if _, err = s.PutRules(ctx, nil, battleRulesRevision(reloaded)); !errors.Is(err, errBattleRuleConflict) {
		t.Fatal("stale CAS accepted", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = familyRulesService(t, path)
	current, err := s.Rules(ctx)
	if err != nil || len(current) != 1 || current[0].ID != "my-custom" {
		t.Fatal("custom reset", err, current)
	}
	cleared, err := s.PutRules(ctx, []BattleTeamRule{}, battleRulesRevision(current))
	if err != nil || len(cleared) != 0 {
		t.Fatal("clear", err)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	s = familyRulesService(t, path)
	clearedAgain, err := s.Rules(ctx)
	if err != nil || len(clearedAgain) != 0 || clearedAgain == nil {
		t.Fatal("explicit empty reset", clearedAgain, err)
	}
	if err = s.db.QueryRow("SELECT count(*) FROM battle_rule_state WHERE singleton=1 AND configured=1").Scan(&markers); err != nil || markers != 1 {
		t.Fatal("missing persistent configured marker", err)
	}
}

func TestStoreFamilyRulesExistingSchemaOneAndUnconfiguredZero(t *testing.T) {
	for _, hasCustom := range []bool{false, true} {
		t.Run(fmt.Sprint(hasCustom), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "legacy.sqlite")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			for _, ddl := range battleSchemaDDL {
				if _, err = db.Exec(ddl); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = db.Exec(fmt.Sprintf("PRAGMA user_version=%d", battleSchemaVersion)); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(fmt.Sprintf("PRAGMA application_id=%d", battleApplicationID)); err != nil {
				t.Fatal(err)
			}
			if hasCustom {
				if _, err = db.Exec(`INSERT INTO battle_rules VALUES('original',0,'{"id":"original","name":"Existing","monsterIds":[987654]}')`); err != nil {
					t.Fatal(err)
				}
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			s := familyRulesService(t, path)
			rules, err := s.Rules(context.Background())
			if err != nil {
				t.Fatal("schema1 incompatible", err)
			}
			if hasCustom && (len(rules) != 1 || rules[0].ID != "original") || !hasCustom && len(rules) != 15 {
				t.Fatal("legacy custom/default state", rules)
			}
			var version int
			if err = s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 1 {
				t.Fatal("unneeded schema version upgrade", version, err)
			}
		})
	}
}

func TestStoreFamilyRulesCatalogCASAndSharedSnapshotClassification(t *testing.T) {
	ctx := context.Background()
	data := familyRulesCatalog(t)
	s := familyRulesService(t, filepath.Join(t.TempDir(), "catalog.sqlite"), func() ([]byte, error) { return append([]byte{}, data...), nil })
	initial, err := s.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	oldRevision := battleRulesRevision(initial)
	c, err := catalog.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	for i := range c.Monsters {
		if c.Monsters[i].ID == 170 {
			c.Monsters[i].EvolvesFromID = 0
		}
	}
	data, err = json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = catalog.Parse(data); err != nil {
		t.Fatal("invalid isolated catalog fixture", err)
	}
	if _, err = s.PutRules(ctx, initial, oldRevision); !errors.Is(err, errBattleRuleConflict) {
		t.Fatal("stale classification CAS accepted", err)
	}
	current, err := s.Rules(ctx)
	if err != nil || battleRulesRevision(current) == oldRevision {
		t.Fatal("family revision unchanged", err)
	}
	data = familyRulesCatalog(t)
	records := []BattleRecord{familyRulesRecord("fire-family", 14), familyRulesRecord("star-branch", 385, 168), familyRulesRecord("moon-branch", 385, 169), familyRulesRecord("or-only", 298)}
	before, _ := json.Marshal(records)
	if _, err = s.Import(ctx, records); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ rule, record string }{{"fire-god", "fire-family"}, {"thunderstorm", "star-branch"}, {"earth-martial", "or-only"}, {"__other__", "moon-branch"}} {
		list, err := s.List(ctx, BattleFilter{TeamRuleID: tc.rule}, 1, 100)
		if err != nil || list.Total != 1 || list.Records[0].ID != tc.record {
			t.Fatalf("list %+v %v", list, err)
		}
		stats, err := s.Stats(ctx, BattleFilter{TeamRuleID: tc.rule})
		if err != nil || stats.MatchedBattles != 1 {
			t.Fatalf("stats %s %+v %v", tc.rule, stats, err)
		}
		found := false
		for _, team := range stats.Archetypes.Teams {
			if team.ID == tc.rule && team.Battles == 1 {
				found = true
			}
		}
		if !found {
			t.Fatal("filter/archetypes mismatch", tc.rule)
		}
		if tc.rule != battleOtherArchetypeID {
			found = false
			for _, team := range stats.Teams {
				if team.ID == tc.rule && team.Battles == 1 {
					found = true
				}
			}
			if !found {
				t.Fatal("filter/base stats mismatch", tc.rule)
			}
		}
		if len(stats.Archetypes.OwnMatchups) != 1 || len(stats.Archetypes.OwnMatchups[0].Teams) != 1 || stats.Archetypes.OwnMatchups[0].Teams[0].ID != tc.rule {
			t.Fatal("filter/own matchup mismatch", tc.rule)
		}
	}
	after, _ := json.Marshal(records)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("import/stats mutated caller")
	}
	stored, err := s.Record(ctx, "fire-family")
	if err != nil {
		t.Fatal(err)
	}
	storedBefore, _ := json.Marshal(stored)
	if _, err = s.Stats(ctx, BattleFilter{}); err != nil {
		t.Fatal(err)
	}
	stored, err = s.Record(ctx, "fire-family")
	if err != nil {
		t.Fatal(err)
	}
	storedAfter, _ := json.Marshal(stored)
	if !reflect.DeepEqual(storedBefore, storedAfter) {
		t.Fatal("inference/statistics persisted derived view")
	}
}

func TestStoreFamilyRulesExclusiveBoundSnapshot(t *testing.T) {
	ctx := context.Background()
	s := familyRulesService(t, filepath.Join(t.TempDir(), "bounds.sqlite"))
	a, b := familyRulesRecord("before", 1), familyRulesRecord("boundary", 1)
	a.StartedAt = "2026-11-02T23:59:59.999999999Z"
	b.StartedAt = "2026-11-03T00:00:00Z"
	if _, err := s.Import(ctx, []BattleRecord{a, b}); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(ctx, BattleFilter{To: "2026-11-03T00:00:00Z", ToExclusive: true}, 1, 100)
	if err != nil || list.Total != 1 || list.Records[0].ID != "before" {
		t.Fatal("exclusive date boundary", list, err)
	}
}
