package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"testing"
)

// All default fixtures are isolated in-memory declarations, not captured games.
func lineupSkillsRecord(id string, species ...int) BattleRecord {
	r := skillDistributionRecord(id)
	me := r.Sides["me"]
	me.Pets = []BattlePet{}
	for i, speciesID := range species {
		instance := "own"
		if i > 0 {
			instance = "own-" + strconv.Itoa(i)
		}
		me.Pets = append(me.Pets, BattlePet{InstanceID: instance, MonsterID: speciesID})
	}
	r.Sides["me"] = me
	return r
}

func lineupSkillsGroup(t *testing.T, out *BattlePerformance, ids ...int) BattleCompleteLineup {
	t.Helper()
	for _, group := range out.CompleteLineups {
		if reflect.DeepEqual(group.MonsterIDs, ids) {
			return group
		}
	}
	t.Fatalf("missing lineup %v: %+v", ids, out.CompleteLineups)
	return BattleCompleteLineup{}
}

func lineupSkillsClone(t *testing.T, r BattleRecord) BattleRecord {
	t.Helper()
	out, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBattleLineupSkillsExactMultisetNoBleed(t *testing.T) {
	a := lineupSkillsRecord("lineup-a", 501, 488)
	a.Events = []BattleEvent{
		skillDistributionCast("ordinary-1", "me", "own", 492, 1),
		skillDistributionCast("ordinary-2", "me", "own", 492, 2),
		skillDistributionWish("wish-3", "effect", skillDistributionInt(3), 3),
		skillDistributionWish("wish-unknown", "skill", nil, 4),
	}
	permuted := lineupSkillsRecord("lineup-a-permuted", 501, 488)
	permuted.Outcome = "unknown"
	me := permuted.Sides["me"]
	me.Pets[0], me.Pets[1] = me.Pets[1], me.Pets[0]
	me.Lead = "own-1"
	me.Pets[1].Level = skillDistributionInt(99)
	me.Pets[1].IV = map[string]BattleEvidence{"hp": {Certainty: "direct", Value: performanceNumber(60)}}
	permuted.Sides["me"] = me
	permuted.Events = []BattleEvent{
		skillDistributionForm("form", "me", "own", 501, 500, 1),
		skillDistributionCast("ordinary-3", "me", "own", 351, 2),
		skillDistributionWish("wish-3", "skill", skillDistributionInt(3), 3),
	}
	observed := lineupSkillsRecord("lineup-a-no-casts", 501, 488)
	observed.Outcome = "draw"
	b := lineupSkillsRecord("lineup-b", 501, 595)
	b.Outcome = "loss"
	b.Events = []BattleEvent{
		skillDistributionCast("other-1", "me", "own", 244, 1),
		skillDistributionCast("other-2", "me", "own", 244, 2),
		skillDistributionCast("other-3", "me", "own", 244, 3),
		skillDistributionWish("other-wish-1", "effect", skillDistributionInt(12), 4),
		skillDistributionWish("other-wish-2", "skill", skillDistributionInt(12), 5),
	}
	twins := lineupSkillsRecord("lineup-twins", 501, 501, 488)
	twinWish := skillDistributionWish("twin-wish", "effect", skillDistributionInt(3), 3)
	twinWish.Actor = "own-1"
	twins.Events = []BattleEvent{
		skillDistributionCast("twin-1", "me", "own", 492, 1),
		skillDistributionCast("twin-2", "me", "own-1", 492, 2), twinWish,
		skillDistributionCast("other-species", "me", "own-2", 244, 4),
	}
	initialForm := lineupSkillsRecord("different-initial-form", 500, 488)
	initialForm.Events = []BattleEvent{skillDistributionCast("initial-form-cast", "me", "own", 492, 1)}
	records := []BattleRecord{b, permuted, initialForm, twins, observed, a}
	for _, r := range records {
		skillDistributionValid(t, r)
	}
	before, _ := json.Marshal(records)
	out := BuildBattlePerformance(records, nil)
	if len(out.CompleteLineups) != 4 || out.Coverage.CompleteLineupBattles != 6 {
		t.Fatalf("member/multiplicity/form identity changed: %+v", out)
	}
	group := lineupSkillsGroup(t, out, 488, 501)
	want := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 351, Casts: 1, UsedBattles: 1, Samples: 3, TotalCasts: 6},
		{MonsterID: 501, SkillID: 492, Casts: 2, UsedBattles: 1, Samples: 3, TotalCasts: 6},
		{MonsterID: 501, Kind: "wishImpact", Casts: 1, UsedBattles: 1, Samples: 3, TotalCasts: 6},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 2, UsedBattles: 2, Samples: 3, TotalCasts: 6},
	}
	if !reflect.DeepEqual(group.SelfSkills, want) || group.Battles != 3 || group.Wins != 1 || group.Draws != 1 || group.Unknown != 1 || group.KnownOutcomes != 2 || group.WinRate == nil || *group.WinRate != .5 {
		t.Fatalf("permutation, unknown outcome, partial actions, or cohort bleed: %+v", group)
	}
	wantOther := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 244, Casts: 3, UsedBattles: 1, Samples: 1, TotalCasts: 5},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(12), Casts: 2, UsedBattles: 1, Samples: 1, TotalCasts: 5},
	}
	if got := lineupSkillsGroup(t, out, 501, 595).SelfSkills; !reflect.DeepEqual(got, wantOther) {
		t.Fatalf("shared species leaked skills/wish types between lineups: %+v", got)
	}
	wantTwins := []BattleSelfSkillStats{
		{MonsterID: 488, SkillID: 244, Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 1},
		{MonsterID: 501, SkillID: 492, Casts: 2, UsedBattles: 1, Samples: 1, TotalCasts: 3},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 3},
	}
	if got := lineupSkillsGroup(t, out, 488, 501, 501).SelfSkills; !reflect.DeepEqual(got, wantTwins) {
		t.Fatalf("multiple instances changed battle-level samples or casts: %+v", got)
	}
	if got := lineupSkillsGroup(t, out, 488, 500).SelfSkills; !reflect.DeepEqual(got, []BattleSelfSkillStats{{MonsterID: 500, SkillID: 492, Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 1}}) {
		t.Fatalf("different initial form merged: %+v", got)
	}
	// Global compatibility statistics still combine every battle, not one selected
	// lineup. Existing enemy semantics are unaffected by adding the projection.
	globalBefore := BuildBattleStats(records, nil)
	for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
		records[i], records[j] = records[j], records[i]
	}
	if again := BuildBattlePerformance(records, nil); !reflect.DeepEqual(out, again) {
		t.Fatal("record order changed the projection")
	}
	for i, j := 0, len(records)-1; i < j; i, j = i+1, j-1 {
		records[i], records[j] = records[j], records[i]
	}
	if globalAfter := BuildBattleStats(records, nil); !reflect.DeepEqual(globalBefore, globalAfter) {
		t.Fatal("lineup projection changed legacy global statistics")
	}
	global501 := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 244, Casts: 3, UsedBattles: 1, Samples: 5, TotalCasts: 14},
		{MonsterID: 501, SkillID: 351, Casts: 1, UsedBattles: 1, Samples: 5, TotalCasts: 14},
		{MonsterID: 501, SkillID: 492, Casts: 4, UsedBattles: 2, Samples: 5, TotalCasts: 14},
		{MonsterID: 501, Kind: "wishImpact", Casts: 1, UsedBattles: 1, Samples: 5, TotalCasts: 14},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 3, UsedBattles: 3, Samples: 5, TotalCasts: 14},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(12), Casts: 2, UsedBattles: 1, Samples: 5, TotalCasts: 14},
	}
	if !reflect.DeepEqual(globalBefore.SelfSkills[2:], global501) {
		t.Fatalf("legacy global own counts changed: %+v", globalBefore.SelfSkills)
	}
	if row := skillDistributionPerformanceRow(t, out, 501); row.CarriedBattles != 5 {
		t.Fatalf("top-level performance was restricted to a selected lineup: %+v", row)
	}
	after, _ := json.Marshal(records)
	if !bytes.Equal(before, after) {
		t.Fatal("lineup aggregation changed caller records")
	}
}

func TestBattleLineupSkillsObservedActionsAndInitialSpecies(t *testing.T) {
	r := lineupSkillsRecord("observed-actions", 501, 488)
	r.Quality.Lead["me"] = false
	r.Outcome = "unknown"
	normal := skillDistributionCast("cast", "me", "own", 492, 2)
	wish := skillDistributionWish("wish", "effect", skillDistributionInt(18), 3)
	charge := skillDistributionCast("mapped-charge", "me", "own", 244, 4)
	charge.ProtocolSkillID = "700001000"
	selected := skillDistributionCast("selection", "me", "own", 244, 5)
	selected.Phase, selected.Combat = "selection", nil
	preparing := skillDistributionCast("preparing", "me", "own", 244, 6)
	preparing.Phase, preparing.Combat = "preview", nil
	interrupted := skillDistributionWish("interrupted", "skill", skillDistributionInt(12), 7)
	interrupted.Phase = "interrupted"
	r.Events = []BattleEvent{
		skillDistributionForm("form", "me", "own", 501, 500, 1), normal, normal, wish,
		{ID: "hit-1", Kind: "damage", Phase: "executed", Round: 1, Seq: 2, ExecIndex: skillDistributionInt(1), Side: "me", Actor: "own", TargetSide: "enemy", Target: "enemy", SkillID: 492, HPChange: skillDistributionInt(-10), Combat: &BattleCombatEvidence{ActionID: "cast"}},
		{ID: "hit-2", Kind: "damage", Phase: "executed", Round: 1, Seq: 2, ExecIndex: skillDistributionInt(2), Side: "me", Actor: "own", TargetSide: "enemy", Target: "enemy", SkillID: 492, HPChange: skillDistributionInt(-10), Combat: &BattleCombatEvidence{ActionID: "cast"}},
		charge, selected, preparing, interrupted,
		{ID: "passive", Kind: "effect", Phase: "executed", Round: 1, Seq: 8, Side: "me", Actor: "own", SkillClass: "passive"},
		{ID: "wish-label", Kind: "effect", Phase: "executed", Round: 1, Seq: 9, Side: "me", Actor: "own", SkillClass: "system", Label: "wishImpact"},
		skillDistributionCast("unmapped", "me", "own", 0, 10),
	}
	observed := lineupSkillsRecord("observed-no-casts", 501, 488)
	observed.Quality.Lead["me"] = false
	observed.Events = []BattleEvent{{ID: "active", Kind: "resource", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "own", StateStage: "snapshot", StateActive: skillDistributionBool(true)}}
	bench := lineupSkillsRecord("bench", 501, 488)
	bench.Quality.Lead["me"] = false
	bench.Events = []BattleEvent{{ID: "inactive", Kind: "resource", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "own", StateStage: "snapshot", StateActive: skillDistributionBool(false)}}
	for _, record := range []BattleRecord{r, observed, bench} {
		skillDistributionValid(t, record)
	}
	out := BuildBattlePerformance([]BattleRecord{r, observed, bench}, nil)
	want := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 492, Casts: 1, UsedBattles: 1, Samples: 2, TotalCasts: 2},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(18), Casts: 1, UsedBattles: 1, Samples: 2, TotalCasts: 2},
	}
	if got := lineupSkillsGroup(t, out, 488, 501).SelfSkills; !reflect.DeepEqual(got, want) {
		t.Fatalf("counted nonexecutions/charge/fragments, lost partial evidence, or changed initial identity: %+v", got)
	}
}

func TestBattleLineupSkillsIncompleteRosterExcludedOnlyFromLineups(t *testing.T) {
	complete := lineupSkillsRecord("complete", 501, 488)
	complete.Events = []BattleEvent{skillDistributionCast("good", "me", "own", 492, 1)}
	partial := lineupSkillsRecord("partial-roster", 501, 488)
	partial.Quality.Roster["me"] = false
	partial.Events = []BattleEvent{skillDistributionCast("partial", "me", "own", 244, 1)}
	unknown := lineupSkillsRecord("unknown-member", 501, 0)
	unknown.Events = []BattleEvent{skillDistributionCast("unknown", "me", "own", 351, 1)}
	empty := lineupSkillsRecord("empty-roster")
	empty.Quality.Lead["me"] = false
	me := empty.Sides["me"]
	me.Lead = ""
	empty.Sides["me"] = me
	records := []BattleRecord{partial, complete, unknown, empty}
	for _, r := range records {
		skillDistributionValid(t, r)
	}
	out := BuildBattlePerformance(records, nil)
	if len(out.CompleteLineups) != 1 || out.Coverage.CompleteLineupBattles != 1 || out.Coverage.IncompleteLineupBattles != 3 {
		t.Fatalf("incomplete/unknown/empty roster included: %+v", out.Coverage)
	}
	want := []BattleSelfSkillStats{{MonsterID: 501, SkillID: 492, Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 1}}
	if !reflect.DeepEqual(out.CompleteLineups[0].SelfSkills, want) {
		t.Fatalf("incomplete roster leaked casts: %+v", out.CompleteLineups)
	}
	if global := BuildBattleStats(records, nil); len(global.SelfSkills) != 3 {
		t.Fatalf("incomplete rosters disappeared from global compatibility counts: %+v", global.SelfSkills)
	}
	if row := skillDistributionPerformanceRow(t, out, 501); row.CarriedBattles != 3 {
		t.Fatalf("incomplete roster disappeared from global performance: %+v", row)
	}
}

func TestBattleLineupSkillsDuplicateFragmentsConflictsAndImmutability(t *testing.T) {
	base := lineupSkillsRecord("fragmented", 501, 488)
	base.Events = []BattleEvent{skillDistributionWish("wish", "effect", nil, 1)}
	enriched := lineupSkillsClone(t, base)
	enriched.Events[0].Combat.TypeID = skillDistributionInt(3)
	enriched.Events = append(enriched.Events, skillDistributionCast("ordinary", "me", "own", 492, 2))
	fragment := lineupSkillsClone(t, enriched)
	fragment.Quality.Roster["me"] = false
	fragment.Events = fragment.Events[1:]
	conflict := lineupSkillsRecord("conflicting", 501, 595)
	conflict.Events = []BattleEvent{skillDistributionWish("wish", "effect", skillDistributionInt(3), 1)}
	other := lineupSkillsClone(t, conflict)
	other.Events[0].Combat.TypeID = skillDistributionInt(12)
	invalid := lineupSkillsRecord("invalid", 501, 488)
	validInvalid := lineupSkillsClone(t, invalid)
	invalid.Version = 999
	inputs := []BattleRecord{base, fragment, enriched, base, conflict, other, validInvalid, invalid}
	before, _ := json.Marshal(inputs)
	cat := performanceCatalog(t)
	catBefore := append([]byte(nil), cat...)
	out := BuildBattlePerformance(inputs, cat)
	if out.Coverage.IncludedBattles != 1 || out.Coverage.ConflictingBattles != 1 || out.Coverage.InvalidBattles != 1 || len(out.CompleteLineups) != 1 {
		t.Fatalf("canonical duplicate conflict handling changed: %+v", out)
	}
	want := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 492, Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 2},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 2},
	}
	if got := out.CompleteLineups[0].SelfSkills; !reflect.DeepEqual(got, want) {
		t.Fatalf("compatible fragments/duplicates overcounted or lost metadata: %+v", got)
	}
	for i, j := 0, len(inputs)-1; i < j; i, j = i+1, j-1 {
		inputs[i], inputs[j] = inputs[j], inputs[i]
	}
	if again := BuildBattlePerformance(inputs, cat); !reflect.DeepEqual(out, again) {
		t.Fatal("duplicate input order changed lineup skills")
	}
	for i, j := 0, len(inputs)-1; i < j; i, j = i+1, j-1 {
		inputs[i], inputs[j] = inputs[j], inputs[i]
	}
	// Returned IDs and optional type pointers cannot alias caller record storage.
	out.CompleteLineups[0].MonsterIDs[0] = 999
	*out.CompleteLineups[0].SelfSkills[1].TypeID = 18
	after, _ := json.Marshal(inputs)
	if !bytes.Equal(before, after) || !bytes.Equal(catBefore, cat) {
		t.Fatal("projection or returned slices/pointers mutated records or catalog bytes")
	}
}

func TestBattleLineupSkillsEmptyArrayJSON(t *testing.T) {
	r := lineupSkillsRecord("no-observed-cast", 501, 488)
	r.Events = []BattleEvent{{ID: "charge", Kind: "effect", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "own", SkillClass: "system", ProtocolSkillID: "700001000"}}
	skillDistributionValid(t, r)
	out := BuildBattlePerformance([]BattleRecord{r}, nil)
	if len(out.CompleteLineups) != 1 || out.CompleteLineups[0].SelfSkills == nil || len(out.CompleteLineups[0].SelfSkills) != 0 {
		t.Fatalf("empty skills must remain a non-nil array: %+v", out.CompleteLineups)
	}
	data, err := json.Marshal(out.CompleteLineups[0])
	if err != nil {
		t.Fatal(err)
	}
	var contract map[string]json.RawMessage
	if err = json.Unmarshal(data, &contract); err != nil || string(contract["selfSkills"]) != "[]" {
		t.Fatalf("selfSkills absent or null in public contract: %s (%v)", data, err)
	}
	if global := BuildBattleStats([]BattleRecord{r}, nil); global.SelfSkills == nil || len(global.SelfSkills) != 0 {
		t.Fatal("global empty array compatibility changed")
	}
}

func TestBattleLineupSkillsUsesSuppliedSharedFilterCohort(t *testing.T) {
	one := lineupSkillsRecord("filter-one", 501, 488)
	one.StartedAt, one.Outcome = "2026-11-01T01:00:00Z", "win"
	me, enemy := one.Sides["me"], one.Sides["enemy"]
	me.Before = BattleRank{Score: performanceNumber(1500), Rank: skillDistributionInt(10), Tier: "gold"}
	enemy.Before = BattleRank{Score: performanceNumber(1600), Rank: skillDistributionInt(20), Tier: "silver"}
	one.Sides["me"], one.Sides["enemy"] = me, enemy
	one.Events = []BattleEvent{skillDistributionCast("one-cast", "me", "own", 492, 1)}
	two := lineupSkillsClone(t, one)
	two.ID, two.StartedAt, two.Outcome = "filter-two", "2026-11-02T01:00:00Z", "loss"
	two.Events = []BattleEvent{skillDistributionCast("two-cast", "me", "own", 244, 1)}
	me, enemy = two.Sides["me"], two.Sides["enemy"]
	me.Before = BattleRank{Score: performanceNumber(900), Rank: skillDistributionInt(100), Tier: "silver"}
	enemy.Before = BattleRank{Score: performanceNumber(800), Rank: skillDistributionInt(200), Tier: "bronze"}
	enemy.Pets[0].MonsterID = 226
	two.Sides["me"], two.Sides["enemy"] = me, enemy
	rules := []BattleTeamRule{{ID: "opponent-team", MonsterIDs: []int{225, 595}}}
	cases := []struct {
		name   string
		filter BattleFilter
	}{
		{"time", BattleFilter{From: "2026-11-01", To: "2026-11-01"}},
		{"outcome", BattleFilter{Outcome: "win"}},
		{"monster", BattleFilter{MonsterID: 225}},
		{"team", BattleFilter{TeamRuleID: "opponent-team"}},
		{"own-score", BattleFilter{RankSide: "me", RankMetric: "score", RankMin: performanceNumber(1400)}},
		{"own-rank", BattleFilter{RankSide: "me", RankMetric: "rank", RankMax: performanceNumber(10)}},
		{"own-tier", BattleFilter{RankSide: "me", Tier: "gold"}},
		{"enemy-score", BattleFilter{RankSide: "enemy", RankMetric: "score", RankMin: performanceNumber(1500)}},
		{"enemy-rank", BattleFilter{RankSide: "enemy", RankMetric: "rank", RankMax: performanceNumber(20)}},
		{"enemy-tier", BattleFilter{RankSide: "enemy", Tier: "silver"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// The service applies MatchBattleRecord before passing these records;
			// the pure projection must never reload or broaden that population.
			filtered := []BattleRecord{}
			for _, r := range []BattleRecord{one, two} {
				if MatchBattleRecord(r, tc.filter, rules) {
					filtered = append(filtered, r)
				}
			}
			if len(filtered) != 1 || filtered[0].ID != one.ID {
				t.Fatal("invalid filter fixture")
			}
			out := BuildBattlePerformance(filtered, nil)
			want := []BattleSelfSkillStats{{MonsterID: 501, SkillID: 492, Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 1}}
			if len(out.CompleteLineups) != 1 || !reflect.DeepEqual(out.CompleteLineups[0].SelfSkills, want) {
				t.Fatalf("broadened supplied shared-filter cohort: %+v", out.CompleteLineups)
			}
		})
	}
}

// Explicit opt-in reads frozen external evidence only; it never opens a database,
// writes the fixture/catalog/profile, or depends on a developer's absolute path.
func TestBattleLineupSkillsFrozenActualRecord(t *testing.T) {
	recordPath, catalogPath := os.Getenv("LINEUP_SKILLS_RECORD"), os.Getenv("LINEUP_SKILLS_CATALOG")
	if recordPath == "" || catalogPath == "" {
		t.Skip("explicit frozen lineup skill fixture opt-in")
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	if hash := fmt.Sprintf("%x", sha256.Sum256(data)); hash != "5277b7a667b06fc90d30da528aadd95c7d0285476d79bffed19cc0f1f46b52e5" {
		t.Fatalf("unexpected frozen record SHA256: %s", hash)
	}
	cat, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	catBefore := append([]byte(nil), cat...)
	var r BattleRecord
	if err = json.Unmarshal(data, &r); err != nil {
		t.Fatal(err)
	}
	if r.Outcome != "loss" || len(r.Events) != 283 {
		t.Fatalf("unexpected actual fixture: outcome=%s events=%d", r.Outcome, len(r.Events))
	}
	before, _ := json.Marshal(r)
	legacyBefore := BuildBattleStats([]BattleRecord{r}, nil)
	out := BuildBattlePerformance([]BattleRecord{r}, cat)
	if out.Coverage.IncludedBattles != 1 || len(out.CompleteLineups) != 1 || out.CompleteLineups[0].Battles != 1 {
		t.Fatalf("actual complete lineup missing: %+v", out)
	}
	casts := 0
	for _, skill := range out.CompleteLineups[0].SelfSkills {
		casts += skill.Casts
		if skill.Kind == "wishImpact" {
			t.Fatal("fabricated an actual wish cast")
		}
	}
	if casts != 26 || !reflect.DeepEqual(out.CompleteLineups[0].SelfSkills, legacyBefore.SelfSkills) {
		t.Fatalf("actual ordinary casts changed: total=%d rows=%+v", casts, out.CompleteLineups[0].SelfSkills)
	}
	mech := skillDistributionPerformanceRow(t, out, 501)
	if mech.Totals.Departures.Total != 1 || mech.Totals.Departures.Self != 1 || mech.Totals.Deaths != 0 || mech.Totals.Entries != 1 || mech.CarriedBattles != 1 {
		t.Fatalf("actual mechanical ark performance changed: %+v", mech)
	}
	if mech.RollerCoaster == nil || mech.RollerCoaster.SuccessRate == nil || *mech.RollerCoaster.SuccessRate != 1 || mech.RollerCoaster.WinRate == nil || *mech.RollerCoaster.WinRate != 0 {
		t.Fatalf("actual roller coaster rates changed: %+v", mech.RollerCoaster)
	}
	if after := BuildBattleStats([]BattleRecord{r}, nil); !reflect.DeepEqual(legacyBefore, after) {
		t.Fatal("actual legacy global statistics mutated")
	}
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) || !bytes.Equal(catBefore, cat) {
		t.Fatal("projection mutated actual record or catalog bytes")
	}
	for path, original := range map[string][]byte{recordPath: data, catalogPath: catBefore} {
		current, readErr := os.ReadFile(path)
		if readErr != nil || !bytes.Equal(original, current) {
			t.Fatalf("frozen input changed: %s (%v)", path, readErr)
		}
	}
	t.Logf("actual lineup verified: 26 ordinary casts, no wishes; 501 self exit=1; roller success=100%%, win=0%%")
}
