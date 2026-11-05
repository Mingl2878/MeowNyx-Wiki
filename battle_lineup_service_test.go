package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func lineupServiceFind(t *testing.T, s BattleStats, ids []int) BattleCompleteLineup {
	t.Helper()
	if s.SelfPerformance == nil {
		t.Fatal("missing performance")
	}
	for _, g := range s.SelfPerformance.CompleteLineups {
		if reflect.DeepEqual(g.MonsterIDs, ids) {
			return g
		}
	}
	t.Fatalf("missing lineup %v", ids)
	return BattleCompleteLineup{}
}
func lineupServiceOwnCasts(rows []BattleSelfSkillStats) map[int]int {
	m := map[int]int{}
	for _, r := range rows {
		m[r.SkillID] += r.Casts
	}
	return m
}
func TestBattleLineupSkillsRespectServiceFilters(t *testing.T) {
	a, b, c := domainFixture("lineup-win"), domainFixture("lineup-loss"), domainFixture("lineup-other")
	a.StartedAt = "2026-10-28T02:00:00Z"
	b.StartedAt = "2026-10-29T02:00:00Z"
	c.StartedAt = "2026-10-30T02:00:00Z"
	a.Quality.Actions = false
	b.Quality.Actions = false
	c.Quality.Actions = false
	b.Outcome = "loss"
	b.Events[1].SkillID = 21
	c.Events[1].SkillID = 22
	side := c.Sides["me"]
	side.Pets = append(side.Pets, BattlePet{InstanceID: "m2", MonsterID: 501})
	side.Before.Score = domainFloat(200)
	c.Sides["me"] = side
	s, err := NewBattleService(filepath.Join(t.TempDir(), "records.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err = s.Import(ctx, []BattleRecord{a, b, c}); err != nil {
		t.Fatal(err)
	}
	snapshots := map[string]string{}
	for _, r := range []BattleRecord{a, b, c} {
		stored, e := s.Record(ctx, r.ID)
		if e != nil {
			t.Fatal(e)
		}
		snapshots[r.ID] = cbJSON(stored)
	}
	all, err := s.Stats(ctx, BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(lineupServiceOwnCasts(lineupServiceFind(t, all, []int{1}).SelfSkills), map[int]int{20: 1, 21: 1}) {
		t.Fatal("mixed exact lineups")
	}
	if !reflect.DeepEqual(lineupServiceOwnCasts(lineupServiceFind(t, all, []int{1, 501}).SelfSkills), map[int]int{22: 1}) {
		t.Fatal("other lineup leaked")
	}
	wins, err := s.Stats(ctx, BattleFilter{Outcome: "win"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(lineupServiceOwnCasts(lineupServiceFind(t, wins, []int{1}).SelfSkills), map[int]int{20: 1}) {
		t.Fatal("outcome filter not applied")
	}
	recent, err := s.Stats(ctx, BattleFilter{From: "2026-10-29T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(lineupServiceOwnCasts(lineupServiceFind(t, recent, []int{1}).SelfSkills), map[int]int{21: 1}) {
		t.Fatal("date filter not applied")
	}
	ranked, err := s.Stats(ctx, BattleFilter{RankSide: "me", RankMetric: "score", RankMin: domainFloat(150)})
	if err != nil {
		t.Fatal(err)
	}
	if len(ranked.SelfPerformance.CompleteLineups) != 1 || !reflect.DeepEqual(ranked.SelfPerformance.CompleteLineups[0].MonsterIDs, []int{1, 501}) {
		t.Fatal("rank filter not applied")
	}
	none, err := s.Stats(ctx, BattleFilter{Outcome: "draw"})
	if err != nil {
		t.Fatal(err)
	}
	if len(none.SelfPerformance.CompleteLineups) != 0 {
		t.Fatal("empty filters leaked lineups")
	}
	if !reflect.DeepEqual(lineupServiceOwnCasts(all.SelfSkills), map[int]int{20: 1, 21: 1, 22: 1}) {
		t.Fatal("top-level global usage changed")
	}
	for id, old := range snapshots {
		now, e := s.Record(ctx, id)
		if e != nil || cbJSON(now) != old {
			t.Fatal("statistics changed a stored record")
		}
	}
}
func TestBattleLineupSkillsActualService(t *testing.T) {
	dbfile, catfile := os.Getenv("LINEUP_ACTUAL_DATABASE"), os.Getenv("LINEUP_ACTUAL_CATALOG")
	if dbfile == "" || catfile == "" {
		t.Skip("explicit frozen actual fixture opt-in")
	}
	dbdata, err := os.ReadFile(dbfile)
	if err != nil {
		t.Fatal(err)
	}
	cat, err := os.ReadFile(catfile)
	if err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "records.sqlite")
	if err = os.WriteFile(dest, dbdata, 0600); err != nil {
		t.Fatal(err)
	}
	s, err := NewBattleService(dest, func() ([]byte, error) { return append([]byte{}, cat...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	before, err := s.Record(ctx, "rkpp:1876469132858231449")
	if err != nil {
		t.Fatal(err)
	}
	beforeJSON := cbJSON(before)
	stats, err := s.Stats(ctx, BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if stats.MatchedBattles != 1 || stats.SelfPerformance == nil || len(stats.SelfPerformance.CompleteLineups) != 1 {
		t.Fatal("wrong real scope")
	}
	g := stats.SelfPerformance.CompleteLineups[0]
	if !reflect.DeepEqual(g.MonsterIDs, []int{129, 182, 202, 348, 501, 599}) || g.Battles != 1 || g.Wins != 0 || g.KnownOutcomes != 1 {
		t.Fatal("real lineup changed")
	}
	sum := 0
	for _, x := range g.SelfSkills {
		sum += x.Casts
		if x.Kind == "wishImpact" {
			t.Fatal("invented unproven wish")
		}
	}
	if sum != 26 || !reflect.DeepEqual(g.SelfSkills, stats.SelfSkills) {
		t.Fatal("real per-lineup skill scope differs")
	}
	if len(stats.Issues) == 0 {
		t.Fatal("presentation hiding must not delete stored historical issues")
	}
	after, _ := s.Record(ctx, before.ID)
	if cbJSON(after) != beforeJSON {
		t.Fatal("stats changed original facts")
	}
	if out := os.Getenv("LINEUP_ACTUAL_OUTPUT"); out != "" {
		f, e := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := json.MarshalIndent(stats, "", "  ")
		_, e = f.Write(body)
		ce := f.Close()
		if e != nil || ce != nil {
			t.Fatal(e, ce)
		}
	}
	for p, old := range map[string][]byte{dbfile: dbdata, catfile: cat} {
		now, e := os.ReadFile(p)
		if e != nil || !reflect.DeepEqual(now, old) {
			t.Fatal("fixture changed")
		}
	}
}
