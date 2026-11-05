package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func backendBattle(t *testing.T, id string) BattleRecord {
	t.Helper()
	r := BattleRecord{Version: 1, ID: id, StartedAt: "2026-10-28T03:00:00Z", Mode: "pvp", Outcome: "win", Source: "canonical", Sides: map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "self", MonsterID: 1}}, Lead: "self"},
		"enemy": {Pets: []BattlePet{{InstanceID: "enemy", MonsterID: 2}}, Lead: "enemy"},
	}, Events: []BattleEvent{{ID: "event-1", Seq: 1, Round: 1, Kind: "skill", Phase: "executed", Side: "me", Actor: "self", SkillID: 10}}, Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": true, "enemy": true}, Actions: true}}
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	return r
}
func backendService(t *testing.T) *BattleService {
	t.Helper()
	s, err := NewBattleService(filepath.Join(t.TempDir(), "battle.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}
func backendImport(t *testing.T, s *BattleService, rs ...BattleRecord) BattleImportResult {
	t.Helper()
	result, err := s.Import(context.Background(), rs)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestBackendBattleLazyAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "battle.sqlite")
	s, err := NewBattleService(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("construction touched filesystem", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatal("unused close touched filesystem", err)
	}
	s, err = NewBattleService(path)
	if err != nil {
		t.Fatal(err)
	}
	r := backendBattle(t, "persist")
	got := backendImport(t, s, r)
	if got.Imported != 1 || got.Duplicates != 0 {
		t.Fatal(got)
	}
	got = backendImport(t, s, r)
	if got.Imported != 0 || got.Duplicates != 1 {
		t.Fatalf("duplicate changed: %+v", got)
	}
	saved, err := s.Record(context.Background(), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.ImportedAt == "" {
		t.Fatal("no first import timestamp")
	}
	if _, err := s.PutRules(context.Background(), []BattleTeamRule{{ID: "team", Name: "Team", MonsterIDs: []int{2, 2}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = NewBattleService(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	again, err := s.Record(context.Background(), r.ID)
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(saved)
	b, _ := json.Marshal(again)
	if string(a) != string(b) {
		t.Fatal("restart changed record")
	}
	rules, err := s.Rules(context.Background())
	if err != nil || len(rules) != 1 || len(rules[0].MonsterIDs) != 1 {
		t.Fatal(rules, err)
	}
	if status := s.RelayStatus(); status.State != "stopped" || status.URL != "" {
		t.Fatal("relay auto resumed", status)
	}
}

func TestBackendBattleAtomicMergeRollbackAndConcurrent(t *testing.T) {
	s := backendService(t)
	ctx := context.Background()
	r := backendBattle(t, "same")
	backendImport(t, s, r)
	conflict := backendBattle(t, "same")
	conflict.Events[0].SkillID = 99
	result, err := s.Import(ctx, []BattleRecord{backendBattle(t, "must-rollback"), conflict})
	if !errors.Is(err, errBattleInvalid) || result.Imported != 0 {
		t.Fatal(result, err)
	}
	if _, err := s.Record(ctx, "must-rollback"); !errors.Is(err, errBattleNotFound) {
		t.Fatal("partial transaction", err)
	}
	// A second connection/service exercises database-level serialization, not just
	// the per-service mutex. No lost read/modify/write updates are allowed.
	other, err := NewBattleService(s.path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	const n = 16
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			copy := backendBattle(t, "same")
			copy.Events[0].ID = fmt.Sprintf("extra-%d", i)
			copy.Events[0].Seq = i + 2
			target := s
			if i%2 == 1 {
				target = other
			}
			_, err := target.Import(ctx, []BattleRecord{copy})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	saved, err := s.Record(ctx, "same")
	if err != nil || len(saved.Events) != n+1 {
		t.Fatal("lost event", len(saved.Events), err)
	}
	got := backendImport(t, s, r)
	if got.Duplicates != 1 {
		t.Fatal("duplicate subset changed", got)
	}
}

func TestBackendBattleSQLFailureRollback(t *testing.T) {
	s := backendService(t)
	ctx := context.Background()
	backendImport(t, s, backendBattle(t, "old"))
	// Injection is confined to this test's temp database, not a production seam.
	if _, err := s.db.Exec(`CREATE TRIGGER reject_test BEFORE INSERT ON battles WHEN NEW.id='fail' BEGIN SELECT RAISE(ABORT,'secret-failure-payload'); END`); err != nil {
		t.Fatal(err)
	}
	result, err := s.Import(ctx, []BattleRecord{backendBattle(t, "rollback"), backendBattle(t, "fail")})
	if !errors.Is(err, errBattleStorage) || result.Imported != 0 {
		t.Fatal(result, err)
	}
	if _, err := s.Record(ctx, "rollback"); !errors.Is(err, errBattleNotFound) {
		t.Fatal(err)
	}
	if _, err := s.Record(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	rules := []BattleTeamRule{{ID: "old", Name: "Old", MonsterIDs: []int{1}}}
	if _, err := s.PutRules(ctx, rules); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER reject_rule BEFORE INSERT ON battle_rules WHEN NEW.id='bad' BEGIN SELECT RAISE(ABORT,'private'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutRules(ctx, []BattleTeamRule{{ID: "bad", Name: "Bad", MonsterIDs: []int{2}}}); err == nil {
		t.Fatal("expected failure")
	}
	saved, err := s.Rules(ctx)
	if err != nil || len(saved) != 1 || saved[0].ID != "old" {
		t.Fatal(saved, err)
	}
}

func TestBackendBattleSchemaRefusesReset(t *testing.T) {
	for _, setup := range []string{"PRAGMA user_version=999", "CREATE TABLE unrelated(secret TEXT)", "PRAGMA user_version=1"} {
		t.Run(setup, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "battle.sqlite")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(setup); err != nil {
				t.Fatal(err)
			}
			db.Close()
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			s, err := NewBattleService(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if _, err := s.Rules(context.Background()); !errors.Is(err, errBattleSchema) {
				t.Fatal(err)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("incompatible database changed")
			}
		})
	}
}

func TestBackendBattleFiltersPaginationAndStats(t *testing.T) {
	s := backendService(t)
	ctx := context.Background()
	a := backendBattle(t, "a")
	b := backendBattle(t, "b")
	b.Outcome = "loss"
	b.StartedAt = "2026-10-27T03:00:00Z"
	c := backendBattle(t, "c")
	c.StartedAt = ""
	c.Outcome = "unknown"
	score := 123.0
	side := a.Sides["enemy"]
	side.After.Score = &score
	a.Sides["enemy"] = side
	backendImport(t, s, c, b, a)
	if _, err := s.PutRules(ctx, []BattleTeamRule{{ID: "team", Name: "Pair", MonsterIDs: []int{2}}}); err != nil {
		t.Fatal(err)
	}
	filters := []BattleFilter{{}, {Outcome: "win"}, {From: "2026-10-28T00:00:00Z"}, {To: "2026-10-27T23:59:59Z"}, {MonsterID: 2}, {MonsterID: 999}, {TeamRuleID: "team"}, {RankSide: "enemy", RankMetric: "score", RankMin: &score}}
	for _, filter := range filters {
		list, err := s.List(ctx, filter, 1, 1)
		if err != nil {
			t.Fatal(err)
		}
		stats, err := s.Stats(ctx, filter)
		if err != nil {
			t.Fatal(err)
		}
		if list.Total != stats.MatchedBattles {
			t.Fatalf("list/stats disagree %+v %+v", list, stats)
		}
		if len(list.Records) > 1 {
			t.Fatal("page overflow")
		}
	}
	list, err := s.List(ctx, BattleFilter{}, 2, 1)
	if err != nil || list.Total != 3 || len(list.Records) != 1 || list.Records[0].ID != "b" || len(list.Records[0].Events) != 0 {
		t.Fatal(list, err)
	}
	empty, err := s.List(ctx, BattleFilter{}, 100, 25)
	if err != nil || len(empty.Records) != 0 || empty.Records == nil {
		t.Fatal(empty, err)
	}
	if _, err := s.List(ctx, BattleFilter{}, 0, 25); err == nil {
		t.Fatal("invalid page accepted")
	}
	if _, err := s.List(ctx, BattleFilter{TeamRuleID: "missing"}, 1, 25); err == nil {
		t.Fatal("missing rule silently matched")
	}
}

func TestBackendBattleRulesLimitsAndCancelledImport(t *testing.T) {
	s := backendService(t)
	ctx := context.Background()
	bad := [][]BattleTeamRule{{{ID: "x", Name: "X", MonsterIDs: []int{0}}}, {{ID: "x", Name: "", MonsterIDs: []int{1}}}, {{ID: "x", Name: "X", MonsterIDs: []int{1}}, {ID: "x", Name: "Y", MonsterIDs: []int{2}}}, {{ID: "x\n", Name: "X", MonsterIDs: []int{1}}}}
	for _, rules := range bad {
		if _, err := s.PutRules(ctx, rules); err == nil {
			t.Fatal("unsafe rules accepted", rules)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := s.Import(cancelled, []BattleRecord{backendBattle(t, "cancel")}); err == nil {
		t.Fatal("cancelled import succeeded")
	}
	if _, err := s.Import(ctx, make([]BattleRecord, battleBatchLimit+1)); !errors.Is(err, errBattleLimit) {
		t.Fatal(err)
	}
}

func TestBackendBattleRecordSizeAndNoPartialBatch(t *testing.T) {
	s := backendService(t)
	large := backendBattle(t, "too-large")
	large.Events = nil
	for i := 0; i < 600; i++ {
		large.Events = append(large.Events, BattleEvent{ID: fmt.Sprintf("large-%d", i), Kind: "note", Phase: "unknown", Side: "unknown", Text: strings.Repeat("x", 2048)})
	}
	result, err := s.Import(context.Background(), []BattleRecord{backendBattle(t, "small-first"), large})
	if !errors.Is(err, errBattleLimit) || result.Imported != 0 {
		t.Fatal(result, err)
	}
	if _, err := s.Record(context.Background(), "small-first"); !errors.Is(err, errBattleNotFound) {
		t.Fatal("record limit broke atomicity", err)
	}
}
