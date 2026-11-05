package main

import (
	"context"
	"path/filepath"
	"testing"
)

func TestBattleConfirmedLeadWithoutCastStillIsSkillSample(t *testing.T) {
	a := domainFixture("cast")
	b := domainFixture("lead-no-cast")
	b.Events = []BattleEvent{{ID: "me-only", Kind: "skill", Phase: "executed", Side: "me", Actor: "m1", SkillID: 20}}
	stats := BuildBattleStats([]BattleRecord{a, b}, nil)
	e := domainEnemy(t, stats, 2)
	if e.Appeared != 2 || len(e.Skills) != 1 || e.Skills[0].Samples != 2 || e.Skills[0].UsedBattles != 1 {
		t.Fatalf("confirmed lead with no use must count as an observed no: %+v", e)
	}
}

func TestBattleBenchEffectsAreNotAppearance(t *testing.T) {
	r := domainFixture("bench-passive")
	r.Events = append(r.Events,
		BattleEvent{ID: "heal-bench", Kind: "heal", Phase: "executed", Side: "me", Actor: "m1", Target: "e2", TargetSide: "enemy", Amount: domainFloat(5)},
		BattleEvent{ID: "bench-trait", Kind: "effect", Phase: "executed", Side: "enemy", Actor: "e2", Trigger: "passive"},
		BattleEvent{ID: "bench-growth", Kind: "growth", Phase: "executed", Side: "enemy", Actor: "e2", Trigger: "team-skill", Stacks: domainInt(1)},
		BattleEvent{ID: "damage-bench", Kind: "damage", Phase: "executed", Side: "me", Actor: "m1", Target: "e2", TargetSide: "enemy", Amount: domainFloat(10)})
	if e := domainEnemy(t, BuildBattleStats([]BattleRecord{r}, nil), 3); e.Appeared != 0 || e.Carried != 1 {
		t.Fatalf("bench effects imply appearance: %+v", e)
	}
	r.Events = append(r.Events, BattleEvent{ID: "switch", Kind: "switch", Phase: "executed", Side: "enemy", Actor: "e1", Target: "e2", TargetSide: "enemy"})
	if e := domainEnemy(t, BuildBattleStats([]BattleRecord{r}, nil), 3); e.Appeared != 1 {
		t.Fatalf("explicit switch lost: %+v", e)
	}
}

func TestBattlePreMatchRankingDoesNotBorrowPostMatchValues(t *testing.T) {
	r := domainFixture("rank-unknown")
	s := r.Sides["enemy"]
	s.After = BattleRank{Score: domainFloat(100), Rank: domainInt(5), Tier: "Gold"}
	r.Sides["enemy"] = s
	for _, f := range []BattleFilter{{RankSide: "enemy", RankMetric: "score", RankMin: domainFloat(0)}, {RankSide: "enemy", RankMetric: "rank", RankMin: domainFloat(1)}, {RankSide: "enemy", Tier: "Gold"}} {
		if MatchBattleRecord(r, f, nil) {
			t.Fatalf("unknown pre-match cohort inferred from post-match: %+v", f)
		}
	}
	if !MatchBattleRecord(r, BattleFilter{}, nil) {
		t.Fatal("unfiltered unknown rank must remain accessible")
	}
}

func TestBattleSQLTimeBoundsKeepNanosecondsAndTimezone(t *testing.T) {
	service, err := NewBattleService(filepath.Join(t.TempDir(), "battles.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	times := []string{"2026-10-28T02:00:00Z", "2026-10-28T02:00:00.1Z", "2026-10-28T02:00:00.100000001Z", "2026-10-28T10:00:01+08:00"}
	records := []BattleRecord{}
	for i, stamp := range times {
		r := domainFixture(string(rune('a' + i)))
		r.StartedAt = stamp
		records = append(records, r)
	}
	if _, err = service.Import(context.Background(), records); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		filter BattleFilter
		want   int
	}{{BattleFilter{To: times[1]}, 2}, {BattleFilter{From: times[1], To: times[2]}, 2}, {BattleFilter{From: times[3], To: times[3]}, 1}, {BattleFilter{From: "2026-10-28", To: "2026-10-28"}, 4}}
	for _, tc := range cases {
		list, e := service.List(context.Background(), tc.filter, 1, 25)
		if e != nil || list.Total != tc.want {
			t.Fatalf("time query %+v: got %d want %d err %v", tc.filter, list.Total, tc.want, e)
		}
		stats, e := service.Stats(context.Background(), tc.filter)
		if e != nil || stats.MatchedBattles != tc.want {
			t.Fatalf("time stats drift: %+v %v", stats, e)
		}
	}
}
