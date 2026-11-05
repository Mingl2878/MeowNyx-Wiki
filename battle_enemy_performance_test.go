package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
)

// Only test fixtures are mirrored. The production builder is side-aware and
// never rewrites the normalized record. Speed-bearing fixtures below explicitly
// give both sides the same known speed; no unknown enemy speed is fabricated.
func enemyPerformanceMirror(t *testing.T, input BattleRecord) BattleRecord {
	t.Helper()
	r, err := battleClone(input)
	if err != nil {
		t.Fatal(err)
	}
	flip := func(side string) string {
		switch side {
		case "me":
			return "enemy"
		case "enemy":
			return "me"
		}
		return side
	}
	r.Sides["me"], r.Sides["enemy"] = r.Sides["enemy"], r.Sides["me"]
	r.Quality.Roster["me"], r.Quality.Roster["enemy"] = r.Quality.Roster["enemy"], r.Quality.Roster["me"]
	r.Quality.Lead["me"], r.Quality.Lead["enemy"] = r.Quality.Lead["enemy"], r.Quality.Lead["me"]
	for i := range r.Events {
		e := &r.Events[i]
		e.Side, e.TargetSide = flip(e.Side), flip(e.TargetSide)
	}
	for i := range r.Constraints {
		r.Constraints[i].Side = flip(r.Constraints[i].Side)
	}
	for i := range r.SpeedObservations {
		o := &r.SpeedObservations[i]
		if o.MeSpeed != 120 {
			t.Fatal("mirror fixture must explicitly declare equal 120 speeds")
		}
		o.MeEvent, o.EnemyEvent = o.EnemyEvent, o.MeEvent
		o.MeMonsterID, o.EnemyMonsterID = o.EnemyMonsterID, o.MeMonsterID
		o.MeLevel, o.EnemyLevel = o.EnemyLevel, o.MeLevel
		o.MePriority, o.EnemyPriority = o.EnemyPriority, o.MePriority
		o.First = flip(o.First)
	}
	switch r.Outcome {
	case "win":
		r.Outcome = "loss"
	case "loss":
		r.Outcome = "win"
	}
	performanceValid(t, r)
	return r
}

func enemyPerformanceAssertMirror(t *testing.T, r BattleRecord, catalog []byte) *BattlePerformance {
	t.Helper()
	performanceValid(t, r)
	before, _ := json.Marshal(r)
	catalogBefore := append([]byte(nil), catalog...)
	out := BuildBattleEnemyPerformance([]BattleRecord{r}, catalog)
	mirrored := enemyPerformanceMirror(t, r)
	want := BuildBattlePerformance([]BattleRecord{mirrored}, catalog)
	// Enemy-only carry/outcome fields are tested separately. Enemy lineups have
	// no own skill charts; never accidentally expose the original own charts.
	data, _ := json.Marshal(out)
	var common BattlePerformance
	if err := json.Unmarshal(data, &common); err != nil {
		t.Fatal(err)
	}
	for i := range common.Species {
		row := &common.Species[i]
		row.CarryRate, row.WinRate = nil, nil
		row.CarrySamples, row.CarryOccurrences, row.Wins, row.KnownOutcomeBattles = 0, 0, 0, 0
	}
	for i := range want.CompleteLineups {
		want.CompleteLineups[i].SelfSkills = []BattleSelfSkillStats{}
	}
	gotJSON, _ := json.Marshal(common)
	wantJSON, _ := json.Marshal(want)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("enemy view differs from independently valid own-view mirror:\ngot %s\nwant %s", gotJSON, wantJSON)
	}
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) || !bytes.Equal(catalog, catalogBefore) {
		t.Fatal("building or fixture mirroring mutated input records/catalog")
	}
	return out
}

func enemyPerformanceCombatRecord() BattleRecord {
	r := performanceRecord("same-instance-ids-and-forms")
	r.Outcome = "loss"
	r.Sides = map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "same", MonsterID: 1, Level: performanceInt(60)}, {InstanceID: "bench", MonsterID: 4, Level: performanceInt(60)}}, Lead: "same"},
		"enemy": {Pets: []BattlePet{{InstanceID: "same", MonsterID: 2, Level: performanceInt(60)}, {InstanceID: "twin", MonsterID: 2, Level: performanceInt(60)}, {InstanceID: "bench", MonsterID: 3, Level: performanceInt(60)}}, Lead: "same"},
	}
	defense := performanceSkill("enemy-defense", "enemy", "same", "me", "same", 2, false)
	defense.SkillID, defense.SkillClass = 12, "response"
	defense.Combat.ResponseAttempt, defense.Combat.CounteredActionID = performanceBool(true), "own-attack"
	charge := performanceSkill("enemy-charge", "enemy", "same", "enemy", "same", 9, false)
	charge.SkillID, charge.ProtocolSkillID, charge.SkillClass = 0, "700001000", "system"
	charge.Kind, charge.Combat.ResponseAttempt = "effect", nil
	counterCharge := performanceSkill("own-counter-charge", "me", "bench", "enemy", "same", 10, false)
	counterCharge.SkillID, counterCharge.SkillClass = 12, "response"
	counterCharge.Combat.ResponseAttempt, counterCharge.Combat.CounteredActionID = performanceBool(true), charge.ID
	interrupted := performanceSkill("enemy-interrupted", "enemy", "same", "me", "bench", 11, true)
	interrupted.Phase = "interrupted"
	counterAttack := performanceSkill("own-counter-attack", "me", "bench", "enemy", "same", 12, false)
	counterAttack.SkillID, counterAttack.SkillClass = 12, "response"
	counterAttack.Combat.ResponseAttempt, counterAttack.Combat.CounteredActionID = performanceBool(true), interrupted.ID
	forced := performanceSwitch("enemy-forced", "enemy", "twin", "same", "forced", 14)
	forced.Combat.ActionID = "own-bench-attack"
	zero := performanceHit("zero-not-death", "own-bench-attack", "me", "bench", "enemy", "same", 6, 1, 15, "resisted")
	zero.HPAfter = performanceInt(0)
	r.Events = []BattleEvent{
		performanceSkill("own-attack", "me", "same", "enemy", "same", 1, true),
		performanceHit("own-hit", "own-attack", "me", "same", "enemy", "same", 1, 1, 10, "usual"), defense,
		performanceSkill("enemy-attack", "enemy", "same", "me", "same", 3, true),
		performanceHit("enemy-hit1", "enemy-attack", "enemy", "same", "me", "same", 3, 1, 20, "advantage"),
		performanceHit("enemy-hit2", "enemy-attack", "enemy", "same", "me", "same", 3, 2, 30, "advantage"),
		performanceDeath("own-death", "enemy-attack", "me", "same", 3, 3),
		performanceSwitch("own-replace", "me", "bench", "same", "defeat", 4),
		performanceForm("enemy-form", "enemy", "same", 2, 4, 5),
		performanceSkill("own-bench-attack", "me", "bench", "enemy", "same", 6, true), zero,
		performanceForm("enemy-reset-form", "enemy", "same", 4, 2, 7),
		{ID: "enemy-reset-hp", Kind: "resource", Phase: "executed", Round: 1, Seq: 8, Side: "enemy", Actor: "same", StateStage: "snapshot", StateActive: performanceBool(true), HPAfter: performanceInt(100)},
		charge, counterCharge, interrupted, counterAttack,
		performanceForm("later-own-source-form", "me", "bench", 4, 3, 13), forced,
		performanceSkill("enemy-twin-attack", "enemy", "twin", "me", "bench", 15, true),
		performanceHit("enemy-twin-hit", "enemy-twin-attack", "enemy", "twin", "me", "bench", 15, 1, 5, ""),
		performanceDeath("enemy-unknown-death", "", "enemy", "twin", 16, 0),
		performanceDeath("enemy-unknown-death-again", "", "enemy", "twin", 16, 1),
		performanceSwitch("enemy-replace", "enemy", "bench", "twin", "defeat", 17),
		performanceSwitch("enemy-manual", "enemy", "same", "bench", "voluntary", 18),
		performanceSwitch("enemy-unknown-exit", "enemy", "bench", "same", "unknown", 19),
		performanceDeath("enemy-bench-death", "", "enemy", "same", 20, 0),
	}
	return r
}

func TestBattleEnemyPerformanceSameInstanceIDsFormsCountersDeathsAndHP(t *testing.T) {
	r := enemyPerformanceCombatRecord()
	out := enemyPerformanceAssertMirror(t, r, performanceCatalog(t))
	row := performanceSpecies(t, out, 2)
	v := row.Totals
	if row.CarriedBattles != 1 || row.EnteredBattles != 1 || v.Entries != 3 || v.AttackActions != 2 || v.AttackAttempts != 3 || v.AttackCountered != 1 {
		t.Fatalf("side/instance/action identity leaked: %+v", row)
	}
	if v.StatusActions != 1 || v.StatusAttempts != 1 || v.StatusCountered != 1 || v.DefenseActions != 1 || v.DefenseSuccess != 1 {
		t.Fatalf("charge or proven defense classification changed: %+v", v)
	}
	if v.Kills != 1 || v.Deaths != 2 || v.ReceivedActions != 2 || v.DamageDealt.Actual != 55 || v.DamageReceived.Actual != 25 || v.DamageDealt.Estimated != 0 || v.DamageReceived.Estimated != 0 {
		t.Fatalf("death/HP/multihit attribution changed: %+v", v)
	}
	if v.Departures != (BattleDepartureTotals{Total: 2, Defeat: 1, Forced: 1}) || len(row.DeparturesByOpponent) != 2 {
		t.Fatalf("unknown exits or duplicate deaths counted: %+v", row)
	}
	if d := row.DeparturesByOpponent[1]; d.MonsterID != 4 || d.Attribution != "cause" || d.Totals.Forced != 1 {
		t.Fatalf("source-time form replaced by later form: %+v", d)
	}
	bench := performanceSpecies(t, out, 3)
	if bench.Totals.Departures.Self != 1 || bench.Totals.Departures.Voluntary != 0 || bench.Totals.Deaths != 0 || bench.Totals.Entries != 2 {
		t.Fatalf("manual exit must be self, not death: %+v", bench)
	}
	if len(out.Species) != 2 || len(out.CompleteLineups) != 1 || !reflect.DeepEqual(out.CompleteLineups[0].MonsterIDs, []int{2, 2, 3}) || out.CompleteLineups[0].Wins != 1 || len(out.CompleteLineups[0].SelfSkills) != 0 {
		t.Fatalf("initial species/multiplicity/outcome/own skill leak: %+v", out)
	}
	if row.WinRate == nil || *row.WinRate != 1 || row.AttackPerDeath == nil || *row.AttackPerDeath != 1 {
		t.Fatalf("enemy results or death denominator: %+v", row)
	}
}

func TestBattleEnemyPerformancePreservesAsymmetricNormalizedMetadata(t *testing.T) {
	r := performanceRecord("speed-and-constraints")
	r.Quality.Roster["me"], r.Quality.Lead["enemy"] = false, false
	me, enemy := r.Sides["me"], r.Sides["enemy"]
	me.Pets[0].Speed = performanceInt(120)
	enemy.Pets[0].Speed, enemy.Pets[0].Level = performanceInt(120), performanceInt(99)
	me.Pets[0].IV = map[string]BattleEvidence{"hp": {Certainty: "candidate", Candidates: []float64{60, 0, 60}, Evidence: []string{"kept me evidence"}}}
	r.Sides["me"], r.Sides["enemy"] = me, enemy
	a := performanceSkill("me-speed-action", "me", "a", "enemy", "b", 1, true)
	b := performanceSkill("enemy-speed-action", "enemy", "b", "me", "a", 2, true)
	a.SkillClass, b.SkillClass = "ordinary", "ordinary"
	r.Events = []BattleEvent{a, b}
	r.Constraints = []BattleConstraint{
		{ID: "me-only", Side: "me", InstanceID: "a2", Kind: "speedOrder", Stat: "speed", KnownStat: 120, Level: 60, Before: true, SamePriority: true, ModifiersKnown: true, Provenance: "fixture"},
		{ID: "enemy-only", Side: "enemy", InstanceID: "b2", Kind: "damageReceived", Stat: "defense", Level: 60},
	}
	r.SpeedObservations = []BattleSpeedObservation{{ID: "speed", Round: 1, MeEvent: a.ID, EnemyEvent: b.ID, MeMonsterID: 1, EnemyMonsterID: 2, MeLevel: 60, EnemyLevel: 99, MeSpeed: 120, MePriority: performanceInt(0), EnemyPriority: performanceInt(0), First: "me", Conditions: "verified fixture", PrioritiesVerified: true, SpeedConditionsVerified: true, Evidence: []string{"action-order refs stay unchanged"}}}
	out := enemyPerformanceAssertMirror(t, r, nil)
	if out.Coverage.IncludedBattles != 1 || out.Coverage.InvalidBattles != 0 || out.Coverage.CompleteLineupBattles != 1 || performanceSpecies(t, out, 4).EnteredBattles != 0 {
		t.Fatalf("enemy view invalidated unrelated normalized fields: %+v", out)
	}
	// An original asymmetric observation does not require known enemy speed at
	// all. The side-aware builder must include it without attempting to mirror.
	enemy.Pets[0].Speed = nil
	r.Sides["enemy"] = enemy
	r.SpeedObservations[0].MeSpeed = 137
	performanceValid(t, r)
	before, _ := json.Marshal(r)
	out = BuildBattleEnemyPerformance([]BattleRecord{r}, nil)
	after, _ := json.Marshal(r)
	if out.Coverage.IncludedBattles != 1 || !bytes.Equal(before, after) || r.SpeedObservations[0].MeSpeed != 137 {
		t.Fatal("asymmetric speed observation rewritten/dropped or input mutated")
	}
}

func enemyPerformanceRosterRecord(id, outcome string, complete bool, species ...int) BattleRecord {
	r := performanceRecord(id)
	r.Outcome = outcome
	r.Quality.Roster["enemy"], r.Quality.Lead["enemy"] = complete, false
	side := BattleSide{Pets: []BattlePet{}}
	for i, speciesID := range species {
		side.Pets = append(side.Pets, BattlePet{InstanceID: "enemy-" + strconv.Itoa(i), MonsterID: speciesID})
	}
	r.Sides["enemy"] = side
	return r
}

func TestBattleEnemyPerformanceCarryRateStrictEligiblePopulationAndBenchWins(t *testing.T) {
	full := enemyPerformanceRosterRecord("full", "loss", true, 2, 2, 3)
	other := enemyPerformanceRosterRecord("other", "win", true, 4)
	partial := enemyPerformanceRosterRecord("partial", "draw", false, 2, 5)
	unknown := enemyPerformanceRosterRecord("unknown", "unknown", false, 5)
	unmapped := enemyPerformanceRosterRecord("unmapped", "loss", true, 2, 0)
	empty := enemyPerformanceRosterRecord("empty", "loss", true)
	noResult := enemyPerformanceRosterRecord("no-result", "", true, 2)
	noResult.DurationSeconds = performanceInt(0)
	records := []BattleRecord{full, other, partial, unknown, unmapped, empty, noResult, full}
	for _, r := range records {
		performanceValid(t, r)
	}
	out := BuildBattleEnemyPerformance(records, nil)
	if out.Coverage.IncludedBattles != 7 || out.Coverage.CompleteLineupBattles != 3 {
		t.Fatalf("dedup/eligible roster population: %+v", out.Coverage)
	}
	type counts struct{ carried, occurrences, wins, outcomes int }
	for id, want := range map[int]counts{2: {4, 2, 2, 3}, 3: {1, 1, 1, 1}, 4: {1, 1, 0, 1}, 5: {2, 0, 0, 1}} {
		row := performanceSpecies(t, out, id)
		if row.CarriedBattles != want.carried || row.CarryOccurrences != want.occurrences || row.CarrySamples != 3 || row.Wins != want.wins || row.KnownOutcomeBattles != want.outcomes || row.EnteredBattles != 0 {
			t.Fatalf("species %d carried not appeared / dedup evidence: %+v", id, row)
		}
		if row.CarryRate == nil || *row.CarryRate != float64(want.occurrences)/3 || row.WinRate == nil || *row.WinRate != float64(want.wins)/float64(want.outcomes) {
			t.Fatalf("species %d rate numerator/denominator mismatch: %+v", id, row)
		}
	}
	for _, group := range out.CompleteLineups {
		if reflect.DeepEqual(group.MonsterIDs, []int{2}) && (group.AverageDurationSeconds == nil || *group.AverageDurationSeconds != 0 || group.AverageRounds != nil || group.WinRate != nil) {
			t.Fatalf("explicit zero duration vs unknown rounds/result lost: %+v", group)
		}
	}
	own := BuildBattlePerformance(records, nil)
	for _, row := range own.Species {
		if row.CarryRate != nil || row.WinRate != nil || row.CarrySamples != 0 || row.CarryOccurrences != 0 || row.Wins != 0 || row.KnownOutcomeBattles != 0 {
			t.Fatalf("enemy-only rates leaked into own DTO: %+v", row)
		}
	}
}

func TestBattleEnemyPerformanceEmptyUnknownAndConflictingSamples(t *testing.T) {
	empty := BuildBattleEnemyPerformance(nil, nil)
	if empty.Species == nil || len(empty.Species) != 0 || empty.CompleteLineups == nil || len(empty.CompleteLineups) != 0 {
		t.Fatalf("empty output must contain arrays: %+v", empty)
	}
	r := enemyPerformanceRosterRecord("unknown", "unknown", false, 2)
	row := performanceSpecies(t, BuildBattleEnemyPerformance([]BattleRecord{r}, nil), 2)
	if row.CarryRate != nil || row.WinRate != nil || row.CarryOccurrences != 0 || row.CarrySamples != 0 || row.KnownOutcomeBattles != 0 || row.AttackPerDeath != nil || row.ReceivedPerDeath != nil {
		t.Fatalf("unknown denominator became zero-valued observation: %+v", row)
	}
	full := enemyPerformanceRosterRecord("conflict", "loss", true, 2)
	conflict, err := battleClone(full)
	if err != nil {
		t.Fatal(err)
	}
	conflict.Outcome = "win"
	invalid := enemyPerformanceRosterRecord("invalid", "loss", true, 4)
	invalid.Version = 999
	inputs := []BattleRecord{r, full, conflict, invalid}
	out := BuildBattleEnemyPerformance(inputs, nil)
	inputs[0], inputs[3], inputs[1], inputs[2] = inputs[3], inputs[0], inputs[2], inputs[1]
	outReverse := BuildBattleEnemyPerformance(inputs, nil)
	if !reflect.DeepEqual(out, outReverse) || out.Coverage.ConflictingBattles != 1 || out.Coverage.InvalidBattles != 1 || out.Coverage.IncludedBattles != 1 || performanceSpecies(t, out, 2).CarryRate != nil {
		t.Fatalf("bad battles leaked into strict rate populations or depended on order: %+v", out)
	}
}

func TestBattleEnemyPerformanceDeterministicGroupingIgnoresNamesAndLabels(t *testing.T) {
	r := enemyPerformanceCombatRecord()
	cat := performanceCatalog(t)
	baseline, _ := json.Marshal(BuildBattleEnemyPerformance([]BattleRecord{r}, cat))
	for run := 0; run < 16; run++ {
		copy, err := battleClone(r)
		if err != nil {
			t.Fatal(err)
		}
		for side, team := range copy.Sides {
			for i := range team.Pets {
				team.Pets[i].Name = "irrelevant me enemy label " + strconv.Itoa(run+i)
			}
			team.Pets[0], team.Pets[len(team.Pets)-1] = team.Pets[len(team.Pets)-1], team.Pets[0]
			copy.Sides[side] = team
		}
		for i := range copy.Events {
			copy.Events[i].Label, copy.Events[i].Text = "irrelevant display label", "not a side or identity"
		}
		for i, j := 0, len(copy.Events)-1; i < j; i, j = i+1, j-1 {
			copy.Events[i], copy.Events[j] = copy.Events[j], copy.Events[i]
		}
		got, _ := json.Marshal(BuildBattleEnemyPerformance([]BattleRecord{copy}, cat))
		if !bytes.Equal(got, baseline) {
			t.Fatalf("run %d depends on labels, input order or map iteration:\n%s\n%s", run, got, baseline)
		}
	}
}

func TestBattleEnemyPerformanceRollerUsesEnemySuccessAndEnemyOutcome(t *testing.T) {
	records := []BattleRecord{}
	for i, outcome := range []string{"loss", "win", "draw", "unknown", "loss"} {
		r := enemyPerformanceRosterRecord("roller-"+strconv.Itoa(i), outcome, true, 501, 501)
		own := r.Sides["me"]
		own.Pets[0].MonsterID = 501
		r.Sides["me"] = own
		cast := performanceSkill("enemy-roller", "enemy", "enemy-0", "me", "a", 2, false)
		cast.SkillID = 492
		r.Events = []BattleEvent{performanceForm("enemy-form", "enemy", "enemy-0", 501, 3, 1), cast, cast}
		if i == 4 {
			r.Events[1].Phase, r.Events[2].Phase = "interrupted", "interrupted"
			ownCast := performanceSkill("own-only-success", "me", "a", "enemy", "enemy-0", 3, false)
			ownCast.SkillID = 492
			r.Events = append(r.Events, ownCast)
		}
		performanceValid(t, r)
		records = append(records, r)
	}
	row := performanceSpecies(t, BuildBattleEnemyPerformance(records, nil), 501)
	rc := row.RollerCoaster
	if rc == nil || rc.CarriedBattles != 5 || rc.SuccessBattles != 4 || rc.KnownOutcomeBattles != 3 || rc.Wins != 1 || rc.SuccessRate == nil || *rc.SuccessRate != .8 || rc.WinRate == nil || *rc.WinRate != 1.0/3 {
		t.Fatalf("enemy roller was contaminated by own casts/forms/outcomes: %+v", rc)
	}
	if row.KnownOutcomeBattles != 4 || row.Wins != 2 || row.WinRate == nil || *row.WinRate != .5 {
		t.Fatalf("hero carried win denominator incorrectly used successful roller battles: %+v", row)
	}
}

func TestBattleEnemyPerformanceVoluntaryMergesIntoSelfWithoutChangingSourceFacing(t *testing.T) {
	r := performanceRecord("self-and-manual")
	own := r.Sides["me"]
	own.Pets[0].MonsterID = 501
	r.Sides["me"] = own
	source := performanceSkill("source-roller", "me", "a", "enemy", "b", 1, false)
	source.SkillID = 492
	self := performanceSwitch("self-out", "me", "c", "a", "self", 3)
	self.Combat.ActionID = source.ID
	r.Events = []BattleEvent{source, performanceSwitch("enemy-out", "enemy", "b2", "b", "forced", 2), self,
		performanceSwitch("manual-return", "me", "a", "c", "voluntary", 4),
		performanceSwitch("manual-out", "me", "a2", "a", "voluntary", 5)}
	performanceValid(t, r)
	before, _ := json.Marshal(r)
	extra, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	extra.ID, extra.Events = "extra-carry", []BattleEvent{}
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r, extra}, nil), 501)
	if row.Totals.Departures != (BattleDepartureTotals{Total: 2, Self: 2}) || row.Averages.Departures.Self != 1 || row.Averages.Departures.Total != 1 || row.Totals.Deaths != 0 {
		t.Fatalf("voluntary not merged once with existing self totals/means: %+v", row)
	}
	if len(row.DeparturesByOpponent) != 2 || row.DeparturesByOpponent[0].MonsterID != 2 || row.DeparturesByOpponent[1].MonsterID != 4 {
		t.Fatalf("source-time versus current-facing attribution changed: %+v", row.DeparturesByOpponent)
	}
	for _, matchup := range row.DeparturesByOpponent {
		if matchup.Attribution != "facing" || matchup.Totals.Self != 1 || matchup.Averages.Self != .5 || matchup.Totals.Voluntary != 0 || matchup.Averages.Voluntary != 0 {
			t.Fatalf("self matchup populations not merged: %+v", matchup)
		}
	}
	data, _ := json.Marshal(row)
	if bytes.Contains(data, []byte(`"voluntary":`)) {
		t.Fatalf("independent legacy voluntary JSON count leaked: %s", data)
	}
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) || r.Events[3].Combat.LeaveReason != "voluntary" {
		t.Fatal("raw accepted voluntary reason was rewritten")
	}
	mirrored := enemyPerformanceMirror(t, r)
	enemyRow := performanceSpecies(t, enemyPerformanceAssertMirror(t, mirrored, nil), 501)
	if enemyRow.Totals.Departures.Self != 2 || len(enemyRow.DeparturesByOpponent) != 2 || enemyRow.DeparturesByOpponent[0].MonsterID != 2 || enemyRow.DeparturesByOpponent[1].MonsterID != 4 {
		t.Fatalf("enemy self source-time versus manual exit-time facing changed: %+v", enemyRow)
	}
	legacyMean := battleDepartureMean(BattleDepartureTotals{Total: 3, Self: 1, Voluntary: 2}, 2)
	if legacyMean.Total != 1.5 || legacyMean.Self != 1.5 || legacyMean.Voluntary != 0 {
		t.Fatalf("legacy mean compatibility not merged: %+v", legacyMean)
	}
}

func TestBattleEnemyPerformanceHPFallbackNeverReplacesKnownActualOrUnknownSource(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		change, after                 *int
		full, knownSource, knownLevel bool
		want                          BattleDamageTotals
	}{
		{name: "current-form-estimate", full: true, knownSource: true, knownLevel: true, want: BattleDamageTotals{Estimated: 561}},
		{name: "known-actual", full: true, knownSource: true, knownLevel: true, change: performanceInt(-17), want: BattleDamageTotals{Actual: 17}},
		{name: "known-zero", full: true, knownSource: true, knownLevel: true, change: performanceInt(0)},
		{name: "after-zero-only", full: true, knownSource: true, knownLevel: true, after: performanceInt(0), want: BattleDamageTotals{Unresolved: 1}},
		{name: "unknown-source", full: true, knownLevel: true, want: BattleDamageTotals{Unresolved: 1}},
		{name: "unknown-level", full: true, knownSource: true, want: BattleDamageTotals{Unresolved: 1}},
		{name: "not-full", knownSource: true, knownLevel: true, want: BattleDamageTotals{Unresolved: 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := performanceRecord(tc.name)
			me := r.Sides["me"]
			if !tc.knownLevel {
				me.Pets[0].Level = nil
			}
			r.Sides["me"] = me
			ref := "enemy-attack"
			if !tc.knownSource {
				ref = ""
			}
			hit := performanceHit("damage", ref, "enemy", "b", "me", "a", 3, 1, 0, "advantage")
			hit.HPChange, hit.HPAfter = tc.change, tc.after
			hit.Combat.FullHPBefore = performanceBool(tc.full)
			r.Events = []BattleEvent{performanceForm("victim-form", "me", "a", 1, 3, 1), performanceForm("actor-form", "enemy", "b", 2, 4, 2),
				performanceSkill("enemy-attack", "enemy", "b", "me", "a", 3, true), hit, performanceDeath("own-death", ref, "me", "a", 3, 2)}
			out := enemyPerformanceAssertMirror(t, r, performanceCatalog(t))
			row := performanceSpecies(t, out, 2)
			wantKills := 0
			if tc.knownSource {
				wantKills = 1
			}
			if row.Totals.DamageDealt != tc.want || row.Totals.Kills != wantKills || row.Totals.AttackActions != 1 || len(out.Species) != 2 {
				t.Fatalf("initial species or HP evidence fallback changed: %+v", row)
			}
		})
	}
}

func TestBattleEnemyPerformanceDefenseRequiresKnownOpposingAttack(t *testing.T) {
	for _, tc := range []struct {
		name, phase, kind, skillClass string
		attack                        *bool
		want                          int
	}{
		{name: "executed-attack", phase: "executed", kind: "skill", attack: performanceBool(true), want: 1},
		{name: "interrupted-attack", phase: "interrupted", kind: "skill", attack: performanceBool(true), want: 1},
		{name: "status", phase: "executed", kind: "skill", attack: performanceBool(false)},
		{name: "unknown", phase: "executed", kind: "skill"},
		{name: "charge", phase: "executed", kind: "effect", skillClass: "system", attack: performanceBool(false)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := performanceRecord(tc.name)
			target := performanceSkill("target", "me", "a", "enemy", "b", 1, true)
			target.Phase, target.Kind, target.SkillClass, target.SkillID = tc.phase, tc.kind, tc.skillClass, 999
			target.Combat = &BattleCombatEvidence{IsAttack: tc.attack}
			if tc.name == "charge" {
				target.SkillID, target.ProtocolSkillID = 0, "700001000"
			}
			defense := performanceSkill("enemy-defense", "enemy", "b", "me", "a", 2, false)
			defense.SkillID, defense.SkillClass = 12, "response"
			defense.Combat.ResponseAttempt, defense.Combat.CounteredActionID = performanceBool(true), "target"
			r.Events = []BattleEvent{target, defense}
			out := enemyPerformanceAssertMirror(t, r, performanceCatalog(t))
			row := performanceSpecies(t, out, 2)
			if row.Totals.DefenseActions != 1 || row.Totals.DefenseAttempts != 1 || row.Totals.DefenseSuccess != tc.want || row.DefenseSuccessRate == nil || *row.DefenseSuccessRate != float64(tc.want) {
				t.Fatalf("defense assumed success without known attack: %+v", row)
			}
		})
	}
}
