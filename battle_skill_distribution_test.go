package main

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
)

func skillDistributionInt(v int) *int    { return &v }
func skillDistributionBool(v bool) *bool { return &v }

// These are isolated normalized declarations, not samples read from a profile,
// database, catalog or a live capture. Synthetic form bases are not runtime maps.
func skillDistributionRecord(id string) BattleRecord {
	return BattleRecord{Version: 1, ID: id, Mode: "pvp", Outcome: "win",
		Quality: BattleQuality{Actions: false, Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": true, "enemy": true}},
		Sides: map[string]BattleSide{
			"me":    {Pets: []BattlePet{{InstanceID: "own", MonsterID: 501}, {InstanceID: "own-backup", MonsterID: 488}}, Lead: "own"},
			"enemy": {Pets: []BattlePet{{InstanceID: "enemy", MonsterID: 225}, {InstanceID: "enemy-backup", MonsterID: 595}}, Lead: "enemy"},
		}, Events: []BattleEvent{}, Issues: []string{},
	}
}
func skillDistributionCast(id, side, actor string, skill, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "skill", Phase: "executed", Round: 1, Seq: seq, ExecIndex: skillDistributionInt(0), Side: side, Actor: actor, SkillID: skill,
		Combat: &BattleCombatEvidence{IsAttack: skillDistributionBool(false), ResponseAttempt: skillDistributionBool(false)}}
}
func skillDistributionSwitch(id, side, incoming, outgoing, reason, source string, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "switch", Phase: "executed", Round: 1, Seq: seq, ExecIndex: skillDistributionInt(0), Side: side, Actor: incoming, TargetSide: side, Target: outgoing,
		Combat: &BattleCombatEvidence{LeaveReason: reason, ActionID: source}}
}
func skillDistributionForm(id, side, actor string, from, to, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "form", Phase: "executed", Round: 1, Seq: seq, ExecIndex: skillDistributionInt(0), Side: side, Actor: actor,
		Form: &BattleFormChange{FromBaseID: strconv.Itoa(from), ToBaseID: strconv.Itoa(to), FromMonsterID: from, ToMonsterID: to, ExecIndex: 0}}
}
func skillDistributionValid(t *testing.T, r BattleRecord) {
	t.Helper()
	copy, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateBattleRecord(&copy); err != nil {
		t.Fatalf("invalid isolated fixture: %v", err)
	}
}
func skillDistributionPerformanceRow(t *testing.T, out *BattlePerformance, species int) BattleSpeciesPerformance {
	t.Helper()
	if out.Coverage.InvalidBattles != 0 || out.Coverage.ConflictingBattles != 0 {
		t.Fatalf("fixture unexpectedly excluded: %+v", out.Coverage)
	}
	for _, row := range out.Species {
		if row.MonsterID == species {
			return row
		}
	}
	t.Fatalf("missing initial species %d", species)
	return BattleSpeciesPerformance{}
}

func TestBattleSkillDistributionOwnWindSourceTimeFacing(t *testing.T) {
	r := skillDistributionRecord("own-wind")
	r.Events = []BattleEvent{
		skillDistributionForm("enemy-before-source", "enemy", "enemy", 225, 226, 1),
		skillDistributionForm("own-form", "me", "own", 501, 500, 2),
		skillDistributionCast("wind", "me", "own", 351, 3),
		// A later form and enemy replacement both precede our switch notice.
		skillDistributionForm("enemy-after-source", "enemy", "enemy", 226, 227, 4),
		skillDistributionSwitch("enemy-forced", "enemy", "enemy-backup", "enemy", "forced", "wind", 5),
		skillDistributionSwitch("own-self", "me", "own-backup", "own", "self", "wind", 6),
	}
	skillDistributionValid(t, r)
	before, _ := json.Marshal(r)
	out := BuildBattlePerformance([]BattleRecord{r}, nil)
	row := skillDistributionPerformanceRow(t, out, 501)
	if row.Totals.Departures != (BattleDepartureTotals{Total: 1, Self: 1}) || row.Totals.Deaths != 0 || row.Totals.Entries != 1 || row.EnteredBattles != 1 {
		t.Fatalf("own wind counted an enemy exit or a death: %+v", row)
	}
	if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 226 || row.DeparturesByOpponent[0].Attribution != "facing" || row.DeparturesByOpponent[0].Totals.Self != 1 {
		t.Fatalf("self exit did not use source-time opponent form: %+v", row.DeparturesByOpponent)
	}
	backup := skillDistributionPerformanceRow(t, out, 488)
	if backup.Totals.Entries != 1 || backup.Totals.Departures.Total != 0 || backup.Totals.Deaths != 0 || row.Totals.AttackActions != 0 {
		t.Fatalf("wind changed entry, death or attack semantics: own=%+v backup=%+v", row.Totals, backup.Totals)
	}
	if len(out.Species) != 2 {
		t.Fatalf("same-instance form created a new initial row: %+v", out.Species)
	}
	after, _ := json.Marshal(r)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("performance projection mutated source record")
	}
}

func TestBattleSkillDistributionEnemyWindUsesSourceForm(t *testing.T) {
	r := skillDistributionRecord("enemy-wind")
	r.Events = []BattleEvent{
		skillDistributionForm("enemy-before-source", "enemy", "enemy", 225, 226, 1),
		skillDistributionCast("enemy-wind", "enemy", "enemy", 351, 2),
		skillDistributionForm("enemy-after-source", "enemy", "enemy", 226, 227, 3),
		skillDistributionSwitch("enemy-self", "enemy", "enemy-backup", "enemy", "self", "enemy-wind", 4),
		skillDistributionSwitch("own-forced", "me", "own-backup", "own", "forced", "enemy-wind", 5),
	}
	skillDistributionValid(t, r)
	row := skillDistributionPerformanceRow(t, BuildBattlePerformance([]BattleRecord{r}, nil), 501)
	if row.Totals.Departures != (BattleDepartureTotals{Total: 1, Forced: 1}) || row.Totals.Deaths != 0 || row.Totals.Entries != 1 {
		t.Fatalf("opposite wind exit totals changed: %+v", row.Totals)
	}
	if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 226 || row.DeparturesByOpponent[0].Attribution != "cause" || row.DeparturesByOpponent[0].Totals.Forced != 1 {
		t.Fatalf("forced exit borrowed later form/replacement: %+v", row.DeparturesByOpponent)
	}
}

func TestBattleSkillDistributionWindUnknownReasonIsNotInferred(t *testing.T) {
	for _, linked := range []bool{false, true} {
		t.Run(strconv.FormatBool(linked), func(t *testing.T) {
			r := skillDistributionRecord("unknown-wind")
			source := ""
			if linked {
				source = "wind"
			}
			r.Events = []BattleEvent{
				skillDistributionCast("wind", "me", "own", 351, 1),
				skillDistributionSwitch("enemy-out", "enemy", "enemy-backup", "enemy", "unknown", source, 2),
				skillDistributionSwitch("own-out", "me", "own-backup", "own", "unknown", source, 3),
			}
			skillDistributionValid(t, r)
			out := BuildBattlePerformance([]BattleRecord{r}, nil)
			row := skillDistributionPerformanceRow(t, out, 501)
			if row.Totals.Departures.Total != 0 || row.Totals.Deaths != 0 || len(row.DeparturesByOpponent) != 0 || skillDistributionPerformanceRow(t, out, 488).Totals.Entries != 1 {
				t.Fatalf("unknown reason inferred or state not advanced: %+v", row)
			}
		})
	}
}

func skillDistributionWish(id, kind string, typeID *int, seq int) BattleEvent {
	e := BattleEvent{ID: id, Kind: kind, Phase: "executed", Round: 1, Seq: seq, ExecIndex: skillDistributionInt(0), Side: "me", Actor: "own",
		Combat: &BattleCombatEvidence{ActionKind: "wishImpact", TypeID: typeID, IsAttack: skillDistributionBool(true)}}
	if kind == "effect" {
		e.SkillClass = "system"
	}
	return e
}

func TestBattleSkillDistributionWishBucketsInitialSpeciesAndObservedSamples(t *testing.T) {
	r := skillDistributionRecord("wish-buckets")
	normal := skillDistributionCast("normal-before-form", "me", "own", 492, 1)
	selected := skillDistributionCast("selected", "me", "own", 244, 13)
	selected.Phase, selected.Combat = "selection", nil
	interrupted := skillDistributionCast("interrupted", "me", "own", 244, 14)
	interrupted.Phase = "interrupted"
	interruptedWish := skillDistributionWish("interrupted-wish", "skill", skillDistributionInt(3), 15)
	interruptedWish.Phase = "interrupted"
	r.Events = []BattleEvent{
		normal, normal, // Canonical duplicate event ID is one cast.
		{ID: "normal-hit-1", Kind: "damage", Phase: "executed", Round: 1, Seq: 1, ExecIndex: skillDistributionInt(1), Side: "me", Actor: "own", TargetSide: "enemy", Target: "enemy", SkillID: 492, HPChange: skillDistributionInt(-10), Combat: &BattleCombatEvidence{ActionID: normal.ID}},
		{ID: "normal-hit-2", Kind: "damage", Phase: "executed", Round: 1, Seq: 1, ExecIndex: skillDistributionInt(2), Side: "me", Actor: "own", TargetSide: "enemy", Target: "enemy", SkillID: 492, HPChange: skillDistributionInt(-10), Combat: &BattleCombatEvidence{ActionID: normal.ID}},
		skillDistributionForm("own-form", "me", "own", 501, 500, 2),
		skillDistributionCast("normal-after-form", "me", "own", 492, 3),
		skillDistributionWish("wish-3-effect", "effect", skillDistributionInt(3), 4),
		{ID: "wish-hit", Kind: "damage", Phase: "executed", Round: 1, Seq: 4, ExecIndex: skillDistributionInt(1), Side: "me", Actor: "own", TargetSide: "enemy", Target: "enemy", HPChange: skillDistributionInt(-20), Combat: &BattleCombatEvidence{ActionID: "wish-3-effect"}},
		skillDistributionWish("wish-3-skill", "skill", skillDistributionInt(3), 5),
		skillDistributionWish("wish-12", "effect", skillDistributionInt(12), 6),
		skillDistributionWish("wish-unknown-effect", "effect", nil, 7),
		skillDistributionWish("wish-unknown-skill", "skill", nil, 8),
		{ID: "charge", Kind: "effect", Phase: "executed", Round: 1, Seq: 9, Side: "me", Actor: "own", SkillClass: "system", ProtocolSkillID: "700001000"},
		skillDistributionCast("unmapped-normal", "me", "own", 0, 10),
		{ID: "wish-label-not-evidence", Kind: "effect", Phase: "executed", Round: 1, Seq: 11, Side: "me", Actor: "own", SkillClass: "system", Label: "wishImpact"},
		{ID: "passive", Kind: "effect", Phase: "executed", Round: 1, Seq: 12, Side: "me", Actor: "own", SkillClass: "passive"},
		selected, interrupted, interruptedWish,
	}
	second := skillDistributionRecord("second-wish")
	second.Events = []BattleEvent{skillDistributionWish("second-wish-3", "effect", skillDistributionInt(3), 1), skillDistributionCast("second-normal", "me", "own", 492, 2)}
	observed := skillDistributionRecord("observed-no-cast")
	observed.Quality.Lead["me"] = false
	observed.Events = []BattleEvent{{ID: "active-snapshot", Kind: "resource", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "own", StateStage: "snapshot", StateActive: skillDistributionBool(true)}}
	bench := skillDistributionRecord("bench-not-observed")
	bench.Quality.Lead["me"] = false
	bench.Events = []BattleEvent{
		{ID: "bench-snapshot", Kind: "resource", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "own", StateStage: "snapshot", StateActive: skillDistributionBool(false)},
		{ID: "bench-damage", Kind: "damage", Phase: "executed", Round: 1, Seq: 2, Side: "enemy", Actor: "enemy", TargetSide: "me", Target: "own", HPChange: skillDistributionInt(-10)},
		{ID: "bench-form", Kind: "form", Phase: "executed", Round: 1, Seq: 3, Side: "me", Actor: "own", Form: &BattleFormChange{FromBaseID: "501", ToBaseID: "500", FromMonsterID: 501, ToMonsterID: 500}},
	}
	records := []BattleRecord{r, second, observed, bench, r}
	for _, record := range records {
		skillDistributionValid(t, record)
	}
	before, _ := json.Marshal(records)
	stats := BuildBattleStats(records, nil)
	if stats.MatchedBattles != 4 {
		t.Fatalf("duplicate battle counted or fixture excluded: %+v", stats)
	}
	want := []BattleSelfSkillStats{
		{MonsterID: 501, SkillID: 492, Casts: 3, UsedBattles: 2, Samples: 3, TotalCasts: 9},
		{MonsterID: 501, Kind: "wishImpact", Casts: 2, UsedBattles: 1, Samples: 3, TotalCasts: 9},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 3, UsedBattles: 2, Samples: 3, TotalCasts: 9},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(12), Casts: 1, UsedBattles: 1, Samples: 3, TotalCasts: 9},
	}
	if !reflect.DeepEqual(stats.SelfSkills, want) {
		t.Fatalf("typed/unknown wish grouping, initial species or counts:\n got %+v\nwant %+v", stats.SelfSkills, want)
	}
	after, _ := json.Marshal(records)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("skill statistics mutated normalized inputs")
	}
	data, _ := json.Marshal(stats.SelfSkills)
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	if _, exists := rows[0]["kind"]; exists {
		t.Fatal("normal row serialized optional wish kind")
	}
	if _, exists := rows[0]["typeId"]; exists {
		t.Fatal("normal row serialized optional wish type")
	}
	if _, exists := rows[1]["typeId"]; exists || string(rows[1]["skillId"]) != "0" {
		t.Fatal("unknown wish invented a type or canonical skill")
	}
}

func TestBattleSkillDistributionWishAloneProvesObservedAppearance(t *testing.T) {
	for _, kind := range []string{"effect", "skill"} {
		t.Run(kind, func(t *testing.T) {
			r := skillDistributionRecord("wish-alone")
			r.Quality.Lead["me"] = false
			r.Events = []BattleEvent{skillDistributionWish("wish", kind, skillDistributionInt(18), 1)}
			skillDistributionValid(t, r)
			stats := BuildBattleStats([]BattleRecord{r}, nil)
			if len(stats.SelfSkills) != 1 || stats.SelfSkills[0].Casts != 1 || stats.SelfSkills[0].Samples != 1 || stats.SelfSkills[0].UsedBattles != 1 || stats.SelfSkills[0].TotalCasts != 1 {
				t.Fatalf("completed wish without a lead was hidden: %+v", stats.SelfSkills)
			}
		})
	}
}

func TestBattleSkillDistributionSameSpeciesInstancesAndChargeExclusion(t *testing.T) {
	r := skillDistributionRecord("same-species")
	me := r.Sides["me"]
	me.Pets = append(me.Pets, BattlePet{InstanceID: "own-twin", MonsterID: 501})
	r.Sides["me"] = me
	first := skillDistributionWish("wish-first", "effect", skillDistributionInt(3), 1)
	second := skillDistributionWish("wish-twin", "skill", skillDistributionInt(3), 2)
	second.Actor = "own-twin"
	other := skillDistributionWish("wish-other-species", "effect", skillDistributionInt(3), 3)
	other.Actor = "own-backup"
	// Even an old ordinary-skill mapping cannot turn the explicitly known
	// charge action into a pie slice. No labels or monster types are inspected.
	charge := skillDistributionCast("mapped-charge", "me", "own", 244, 4)
	charge.ProtocolSkillID = "700001000"
	r.Events = []BattleEvent{first, second, other, charge}
	skillDistributionValid(t, r)
	stats := BuildBattleStats([]BattleRecord{r}, nil)
	want := []BattleSelfSkillStats{
		{MonsterID: 488, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 1, UsedBattles: 1, Samples: 1, TotalCasts: 1},
		{MonsterID: 501, Kind: "wishImpact", TypeID: skillDistributionInt(3), Casts: 2, UsedBattles: 1, Samples: 1, TotalCasts: 2},
	}
	if !reflect.DeepEqual(stats.SelfSkills, want) {
		t.Fatalf("same-species instances counted per battle incorrectly or charge included: %+v", stats.SelfSkills)
	}
}

func TestBattleSkillDistributionWishMetadataMergeAndConflict(t *testing.T) {
	base := skillDistributionRecord("merge-wish")
	base.Events = []BattleEvent{skillDistributionWish("wish", "effect", nil, 1)}
	enriched, _ := battleClone(base)
	enriched.Events[0].Combat.TypeID = skillDistributionInt(3)
	for _, inputs := range [][]BattleRecord{{base, enriched, base}, {enriched, base, enriched}} {
		stats := BuildBattleStats(inputs, nil)
		if stats.MatchedBattles != 1 || len(stats.SelfSkills) != 1 || stats.SelfSkills[0].TypeID == nil || *stats.SelfSkills[0].TypeID != 3 || stats.SelfSkills[0].Casts != 1 || stats.SelfSkills[0].TotalCasts != 1 {
			t.Fatalf("enriched canonical wish split into two buckets/casts: %+v", stats)
		}
	}
	conflict, _ := battleClone(enriched)
	conflict.Events[0].Combat.TypeID = skillDistributionInt(12)
	for _, inputs := range [][]BattleRecord{{enriched, conflict}, {conflict, enriched}} {
		stats := BuildBattleStats(inputs, nil)
		if stats.MatchedBattles != 0 || len(stats.SelfSkills) != 0 {
			t.Fatalf("conflicting type metadata admitted a cast: %+v", stats)
		}
	}
}

func TestBattleSkillDistributionEnemyCohortAndIdentityUnchanged(t *testing.T) {
	complete := skillDistributionRecord("enemy-complete")
	complete.Quality.Actions = true
	complete.Events = []BattleEvent{
		skillDistributionCast("enemy-before-form", "enemy", "enemy", 351, 1),
		skillDistributionForm("enemy-form", "enemy", "enemy", 225, 226, 2),
		skillDistributionCast("enemy-after-form", "enemy", "enemy", 351, 3),
	}
	partial := skillDistributionRecord("enemy-partial")
	partial.Events = []BattleEvent{skillDistributionCast("partial-enemy", "enemy", "enemy", 244, 1)}
	before := BuildBattleStats([]BattleRecord{complete, partial}, nil)
	complete.Events = append(complete.Events, skillDistributionWish("own-wish", "effect", skillDistributionInt(3), 4))
	partial.Events = append(partial.Events, skillDistributionWish("partial-own-wish", "effect", nil, 2))
	skillDistributionValid(t, complete)
	skillDistributionValid(t, partial)
	after := BuildBattleStats([]BattleRecord{complete, partial}, nil)
	if !reflect.DeepEqual(before.Enemy, after.Enemy) || len(after.SelfSkills) != 2 {
		t.Fatalf("own wish changed legacy enemy statistics or partial own visibility: before=%+v after=%+v", before, after)
	}
	for _, enemy := range after.Enemy {
		if enemy.MonsterID == 225 && !reflect.DeepEqual(enemy.Skills, []BattleSkillStats{{SkillID: 351, UsedBattles: 1, Samples: 1, Casts: 2}}) {
			t.Fatalf("legacy enemy initial identity or complete-action gate changed: %+v", enemy)
		}
	}
}

func TestBattleSkillDistributionUnknownSourceFacingStaysUnknown(t *testing.T) {
	r := skillDistributionRecord("unknown-source-facing")
	r.Quality.Lead["enemy"] = false
	r.Events = []BattleEvent{
		skillDistributionCast("wind", "me", "own", 351, 1),
		skillDistributionSwitch("enemy-out", "enemy", "enemy-backup", "enemy", "forced", "wind", 2),
		skillDistributionSwitch("own-out", "me", "own-backup", "own", "self", "wind", 3),
	}
	skillDistributionValid(t, r)
	row := skillDistributionPerformanceRow(t, BuildBattlePerformance([]BattleRecord{r}, nil), 501)
	if row.Totals.Departures.Self != 1 || row.Coverage.OpponentAtExitUnknown != 1 || len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 0 || row.DeparturesByOpponent[0].Attribution != "unknown" {
		t.Fatalf("unknown source facing borrowed newly entered opponent: %+v", row)
	}
}
