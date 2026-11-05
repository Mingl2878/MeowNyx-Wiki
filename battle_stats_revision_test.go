package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestBattleOwnSkillUsageIncludesObservedPartial(t *testing.T) {
	partial := domainFixture("partial-own")
	partial.Quality.Actions = false
	partial.Events = append(partial.Events,
		BattleEvent{ID: "again", Round: 2, Seq: 2, Kind: "skill", Phase: "executed", Side: "me", Actor: "m1", SkillID: 20},
		BattleEvent{ID: "failed", Round: 3, Seq: 3, Kind: "skill", Phase: "interrupted", Side: "me", Actor: "m1", SkillID: 21},
		BattleEvent{ID: "planned", Round: 4, Seq: 4, Kind: "skill", Phase: "selection", Side: "me", Actor: "m1", SkillID: 22})
	before := domainEncode(t, partial)
	stats := BuildBattleStats([]BattleRecord{partial, partial}, nil)
	if stats.MatchedBattles != 1 || stats.Quality.Actions != 0 {
		t.Fatal("changed capture quality")
	}
	if len(stats.SelfSkills) != 1 || stats.SelfSkills[0] != (BattleSelfSkillStats{MonsterID: 1, SkillID: 20, Casts: 2, TotalCasts: 2, UsedBattles: 1, Samples: 1}) {
		t.Fatal(stats.SelfSkills)
	}
	for _, e := range stats.Enemy {
		if len(e.Skills) != 0 {
			t.Fatal("relaxed enemy cohort")
		}
	}
	if !reflect.DeepEqual(before, domainEncode(t, partial)) {
		t.Fatal("mutated input")
	}
}
func TestBattleOwnSkillSamplesUseExplicitActiveSnapshots(t *testing.T) {
	cast := domainFixture("cast-sample")
	cast.Quality.Actions = false
	active := domainFixture("active-sample")
	active.Quality.Actions = false
	active.Quality.Lead["me"] = false
	side := active.Sides["me"]
	side.Lead = ""
	active.Sides["me"] = side
	on := true
	active.Events = []BattleEvent{{ID: "snapshot", Round: 1, Seq: 1, Kind: "resource", Phase: "executed", Side: "me", Actor: "m1", StateStage: "snapshot", StateActive: &on}}
	bench := domainClone(t, active)
	bench.ID = "bench-sample"
	off := false
	bench.Events[0].StateActive = &off
	stats := BuildBattleStats([]BattleRecord{cast, active, bench}, nil)
	if len(stats.SelfSkills) != 1 || stats.SelfSkills[0].Casts != 1 || stats.SelfSkills[0].UsedBattles != 1 || stats.SelfSkills[0].Samples != 2 {
		t.Fatal(stats.SelfSkills)
	}
}
func TestBattleStatisticsRevisionActual(t *testing.T) {
	recordPath, catPath := os.Getenv("XHM_FINAL_RECORD"), os.Getenv("XHM_FINAL_CATALOG")
	if recordPath == "" || catPath == "" {
		t.Skip("explicit frozen fixture opt-in")
	}
	rb, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	cb, err := os.ReadFile(catPath)
	if err != nil {
		t.Fatal(err)
	}
	var record BattleRecord
	if err = json.Unmarshal(rb, &record); err != nil {
		t.Fatal(err)
	}
	before := domainEncode(t, record)
	stats := BuildBattleStats([]BattleRecord{record}, nil)
	stats.SelfPerformance = BuildBattlePerformance([]BattleRecord{record}, cb)
	if stats.MatchedBattles != 1 || stats.Quality.Actions != 0 || stats.Outcomes.Loss != 1 {
		t.Fatal("wrong population")
	}
	casts := 0
	for _, s := range stats.SelfSkills {
		casts += s.Casts
		if s.Samples != 1 || s.UsedBattles != 1 {
			t.Fatal(s)
		}
	}
	if casts != 26 {
		t.Fatalf("own executed skill records: %d", casts)
	}
	attacks, deaths, defenses := 0, 0, 0
	found := false
	for _, p := range stats.SelfPerformance.Species {
		attacks += p.Totals.AttackActions
		deaths += p.Totals.Deaths
		defenses += p.Totals.DefenseSuccess
		if p.Totals.Departures.Unknown != 0 {
			t.Fatal("unknown exit still counted")
		}
		if p.MonsterID == 501 {
			found = true
			x := p.RollerCoaster
			if x == nil || x.CarriedBattles != 1 || x.SuccessBattles != 1 || x.KnownOutcomeBattles != 1 || x.Wins != 0 || x.SuccessRate == nil || *x.SuccessRate != 1 || x.WinRate == nil || *x.WinRate != 0 {
				t.Fatalf("roller snapshot: %+v", x)
			}
			if p.Totals.Departures.Total != 0 || p.Totals.Entries != 1 {
				t.Fatalf("unknown reason exclusion changed entry: %+v", p.Totals)
			}
		} else if p.RollerCoaster != nil {
			t.Fatal("special metrics leaked to another species")
		}
	}
	if !found || attacks != 14 || deaths != 2 || defenses != 4 {
		t.Fatalf("actual stats attacks%d deaths%d defenses%d", attacks, deaths, defenses)
	}
	if !reflect.DeepEqual(before, domainEncode(t, record)) {
		t.Fatal("statistics mutated capture")
	}
	if output := os.Getenv("XHM_FINAL_STATS_OUTPUT"); output != "" {
		f, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			t.Fatal(e)
		}
		data, _ := json.MarshalIndent(stats, "", "  ")
		_, e = f.Write(data)
		ce := f.Close()
		if e != nil || ce != nil {
			t.Fatalf("output %v %v", e, ce)
		}
	}
	for path, old := range map[string][]byte{recordPath: rb, catPath: cb} {
		now, e := os.ReadFile(path)
		if e != nil || !reflect.DeepEqual(old, now) {
			t.Fatal("fixture input changed")
		}
	}
}
