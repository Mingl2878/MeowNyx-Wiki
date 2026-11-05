package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"testing"
	canonicalcatalog "xhmwiki/internal/catalog"
)

func performanceInt(v int) *int            { return &v }
func performanceBool(v bool) *bool         { return &v }
func performanceNumber(v float64) *float64 { return &v }
func performanceRecord(id string) BattleRecord {
	return BattleRecord{Version: 1, ID: id, Mode: "pvp", Outcome: "win", Quality: BattleQuality{Actions: true, Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": true, "enemy": true}}, Sides: map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "a", MonsterID: 1, Level: performanceInt(60)}, {InstanceID: "a2", MonsterID: 1, Level: performanceInt(60)}, {InstanceID: "c", MonsterID: 3, Level: performanceInt(60)}}, Lead: "a"},
		"enemy": {Pets: []BattlePet{{InstanceID: "b", MonsterID: 2, Level: performanceInt(60)}, {InstanceID: "b2", MonsterID: 4, Level: performanceInt(60)}}, Lead: "b"},
	}, Events: []BattleEvent{}, Issues: []string{}}
}
func performanceSkill(id, side, actor, targetSide, target string, seq int, attack bool) BattleEvent {
	return BattleEvent{ID: id, Kind: "skill", Phase: "executed", Round: 1, Seq: seq, ExecIndex: performanceInt(0), Side: side, Actor: actor, TargetSide: targetSide, Target: target, SkillID: 10, Combat: &BattleCombatEvidence{IsAttack: performanceBool(attack), ResponseAttempt: performanceBool(false)}}
}
func performanceHit(id, action, side, actor, targetSide, target string, seq, index, loss int, tag string) BattleEvent {
	return BattleEvent{ID: id, Kind: "damage", Phase: "executed", Round: 1, Seq: seq, ExecIndex: performanceInt(index), Side: side, Actor: actor, TargetSide: targetSide, Target: target, HPChange: performanceInt(-loss), Amount: performanceNumber(99999), Combat: &BattleCombatEvidence{ActionID: action, EffectivenessClass: tag}}
}
func performanceDeath(id, action, side, actor string, seq, index int) BattleEvent {
	return BattleEvent{ID: id, Kind: "effect", Phase: "executed", Round: 1, Seq: seq, ExecIndex: performanceInt(index), Side: side, Actor: actor, Combat: &BattleCombatEvidence{ActionID: action, LeaveReason: "defeat"}}
}
func performanceSwitch(id, side, incoming, outgoing, reason string, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "switch", Phase: "executed", Round: 1, Seq: seq, ExecIndex: performanceInt(0), Side: side, Actor: incoming, TargetSide: side, Target: outgoing, Combat: &BattleCombatEvidence{LeaveReason: reason}}
}
func performanceForm(id, side, actor string, from, to, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "form", Phase: "executed", Round: 1, Seq: seq, ExecIndex: performanceInt(0), Side: side, Actor: actor, Form: &BattleFormChange{FromBaseID: strconv.Itoa(from), ToBaseID: strconv.Itoa(to), FromMonsterID: from, ToMonsterID: to, ExecIndex: 0}}
}
func performanceSpecies(t *testing.T, p *BattlePerformance, id int) BattleSpeciesPerformance {
	t.Helper()
	for _, r := range p.Species {
		if r.MonsterID == id {
			return r
		}
	}
	t.Fatalf("missing species %d: %+v", id, p)
	return BattleSpeciesPerformance{}
}
func performanceValid(t *testing.T, r BattleRecord) {
	t.Helper()
	c, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	if err = ValidateBattleRecord(&c); err != nil {
		t.Fatalf("fixture invalid: %v", err)
	}
}
func performanceCatalog(t *testing.T) []byte {
	t.Helper()
	c := &canonicalcatalog.Catalog{SchemaVersion: 2, Types: []canonicalcatalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}}, Traits: []canonicalcatalog.Trait{{ID: "trait", Name: "特性", Description: "测试特性。"}}, Skills: []canonicalcatalog.Skill{
		{ID: 10, Name: "攻击", Description: "直接攻击。", TypeID: 1, Category: "Physical Attack", EnergyCost: 1, Power: performanceNumber(80)},
		{ID: 11, Name: "魔法", Description: "魔法攻击。", TypeID: 1, Category: "Magic Attack", EnergyCost: 1, Power: performanceNumber(80)},
		{ID: 12, Name: "应对", Description: "应对：成功时反击。", TypeID: 1, Category: "Defense", EnergyCost: 1},
		{ID: 13, Name: "状态", Description: "提升自己状态。", TypeID: 1, Category: "Status", EnergyCost: 1},
		{ID: 14, Name: "提及敌方应对", Description: "使对手无法应对。", TypeID: 1, Category: "Status", EnergyCost: 1},
	}}
	for id, hp := range []int{100, 100, 200, 50} {
		id++
		c.Monsters = append(c.Monsters, canonicalcatalog.Monster{ID: id, Name: "物种" + strconv.Itoa(id), DexNumber: id, TypeIDs: []int{1}, TraitID: "trait", Stats: canonicalcatalog.Stats{HP: hp, PhyAtk: 80, PhyDef: 80, MagAtk: 80, MagDef: 80, Speed: 80}, Form: "default", FormCategory: "无多形态", EvolutionStage: "高级形态", EvolutionMembers: []int{id}})
		c.Learnsets = append(c.Learnsets, canonicalcatalog.Learnset{MonsterID: id, Mode: "own", Skills: []canonicalcatalog.LearnedSkill{}})
	}
	data, err := canonicalcatalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBattlePerformanceCarryActionDedupMixedMultihitsAndPartialRatio(t *testing.T) {
	r := performanceRecord("observed")
	a := performanceSkill("cast", "me", "a", "enemy", "b", 1, true)
	e := performanceSkill("enemy", "enemy", "b", "me", "a", 3, true)
	r.Events = []BattleEvent{a, a,
		performanceHit("hit1", "cast", "me", "a", "enemy", "b", 1, 1, 20, "advantage"),
		performanceHit("hit2", "cast", "me", "a", "enemy", "b", 1, 2, 30, "advantage"),
		performanceHit("hit3", "cast", "me", "a", "enemy", "b2", 1, 3, 10, "resisted"),
		performanceSkill("cast-second-instance", "me", "a2", "enemy", "b", 2, true),
		performanceHit("hit4", "cast-second-instance", "me", "a2", "enemy", "b", 2, 1, 5, ""), e,
		performanceHit("received1", "enemy", "enemy", "b", "me", "a", 3, 1, 10, "usual"),
		performanceHit("received2", "enemy", "enemy", "b", "me", "a", 3, 2, 10, "usual"),
		performanceHit("received3", "enemy", "enemy", "b", "me", "a2", 3, 3, 20, "resisted"),
		{ID: "heal", Kind: "heal", Phase: "executed", Round: 1, Seq: 4, Side: "enemy", Actor: "b", TargetSide: "enemy", Target: "b", HPChange: performanceInt(100)},
	}
	partial := performanceRecord("partial")
	partial.Quality.Actions = false
	performanceValid(t, r)
	before, _ := json.Marshal([]BattleRecord{r, partial})
	out := BuildBattlePerformance([]BattleRecord{r, partial}, nil)
	row := performanceSpecies(t, out, 1)
	if row.CarriedBattles != 2 || row.EnteredBattles != 2 || row.Totals.Entries != 3 {
		t.Fatalf("carry/instance/entry denominator: %+v", row)
	}
	if row.Totals.AttackActions != 2 || row.Totals.OutgoingAdvantage != 1 || row.Totals.OutgoingResisted != 1 || row.Totals.OutgoingUsual != 0 {
		t.Fatalf("action tags/dedup: %+v", row.Totals)
	}
	if row.Totals.DamageDealt.Actual != 65 || row.Totals.DamageDealt.Estimated != 0 || row.Averages.DamageDealt.Actual != 32.5 || row.Averages.AttackActions != 1 {
		t.Fatalf("observed counts and carried denominator: %+v", row)
	}
	if row.Totals.ReceivedActions != 2 || row.Totals.ReceivedUsual != 1 || row.Totals.ReceivedResisted != 1 || row.Totals.DamageReceived.Actual != 40 || row.Totals.ReceivedUsualDamage.Actual != 20 {
		t.Fatalf("receiver-instance dedup: %+v", row.Totals)
	}
	if row.Coverage.CompleteActionBattles != 1 || row.Coverage.PartialActionBattles != 1 || row.Coverage.OutgoingEffectivenessUnknown != 1 {
		t.Fatalf("coverage: %+v", row.Coverage)
	}
	if bench := performanceSpecies(t, out, 3); bench.Totals.Entries != 0 || bench.CarriedBattles != 2 || bench.EnteredBattles != 0 {
		t.Fatalf("bench: %+v", bench)
	}
	after, _ := json.Marshal([]BattleRecord{r, partial})
	if !bytes.Equal(before, after) {
		t.Fatal("input records mutated")
	}
}

func TestBattlePerformanceResponseCounteredAnyActionNoAdjacency(t *testing.T) {
	r := performanceRecord("responses")
	status := performanceSkill("own-status", "me", "a", "me", "a", 1, false)
	interrupted := performanceSkill("own-interrupted", "me", "a", "enemy", "b", 2, true)
	interrupted.Phase = "interrupted"
	interrupted.Combat.ResponseAttempt = performanceBool(true)
	success := performanceSkill("own-response", "me", "a", "enemy", "b", 3, false)
	success.SkillClass = "response"
	success.Combat.ResponseAttempt = performanceBool(true)
	miss := performanceSkill("own-failed-response", "me", "a", "enemy", "b", 4, false)
	miss.Combat.ResponseAttempt = performanceBool(true)
	counter := performanceSkill("enemy-counter", "enemy", "b", "enemy", "b", 5, false)
	counter.SkillClass = "response"
	counter.Combat = &BattleCombatEvidence{IsAttack: performanceBool(false), ResponseAttempt: performanceBool(true), CounteredActionID: "own-status"}
	counterCopy := counter
	counterCopy.ID = "enemy-counter-copy" // Multiple trigger evidence must still count own action once.
	adjacent := performanceSkill("enemy-response-adjacent", "enemy", "b", "me", "a", 6, false)
	adjacent.SkillClass = "response"
	adjacent.Combat.ResponseAttempt = performanceBool(true)
	r.Events = []BattleEvent{status, interrupted, success, miss, counter, counterCopy, adjacent}
	r.Quality.Actions = false
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if row.Totals.AttackActions != 0 || row.Totals.CounteredActions != 1 || row.Totals.ResponseAttempts != 3 || row.Totals.ResponseSuccess != 1 || row.ResponseRate == nil || *row.ResponseRate != 1.0/3 {
		t.Fatalf("response semantics: %+v", row)
	}
	if row.Coverage.PartialActionBattles != 1 {
		t.Fatal("partial capture hidden")
	}
}

func TestBattlePerformanceCatalogFallbackExplicitPriorityAndMissing(t *testing.T) {
	r := performanceRecord("catalog")
	for i, id := range []int{10, 11, 12, 13, 14} {
		e := performanceSkill("skill"+strconv.Itoa(i), "me", "a", "enemy", "b", i+1, false)
		e.SkillID = id
		e.Combat = nil
		r.Events = append(r.Events, e)
	}
	explicit := performanceSkill("explicit-no", "me", "a", "enemy", "b", 6, false)
	r.Events = append(r.Events, explicit)
	cat := performanceCatalog(t)
	copyCat := append([]byte(nil), cat...)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, cat), 1)
	if row.Totals.AttackActions != 2 || row.Totals.ResponseAttempts != 1 || row.Totals.ResponseSuccess != 0 || row.Coverage.CatalogAttackClassifications != 5 || row.Coverage.ResponseCapabilityUnknown != 1 {
		t.Fatalf("catalog classification: %+v", row)
	}
	if !bytes.Equal(cat, copyCat) {
		t.Fatal("catalog bytes mutated")
	}
	for _, data := range [][]byte{nil, []byte(`{"schema_version":999}`), []byte(`not json`)} {
		out := BuildBattlePerformance([]BattleRecord{r}, data)
		row := performanceSpecies(t, out, 1)
		if out.Coverage.CatalogAvailable || row.Totals.AttackActions != 0 || row.Coverage.AttackClassificationUnknown != 5 || row.Totals.Entries != 1 || row.ResponseRate != nil {
			t.Fatalf("missing catalog: %+v / %+v", out.Coverage, row)
		}
	}
}

func TestBattlePerformanceDamageActualPriorityEstimatesAndCurrentForm(t *testing.T) {
	cat := performanceCatalog(t)
	cases := []struct {
		name                      string
		change, before, after     *int
		full                      *bool
		kill, level, catalog      bool
		wantActual, wantEstimated int64
		wantUnresolved            int
	}{
		{name: "estimate-current-form", full: performanceBool(true), kill: true, level: true, catalog: true, wantEstimated: 561},
		{name: "actual-loss-wins", change: performanceInt(-17), full: performanceBool(true), kill: true, level: true, catalog: true, wantActual: 17},
		{name: "before-after", before: performanceInt(40), after: performanceInt(0), full: performanceBool(true), kill: true, level: true, catalog: true, wantActual: 40},
		{name: "cap-overkill", before: performanceInt(40), change: performanceInt(-999), kill: true, level: true, catalog: true, wantActual: 40},
		{name: "after-alone-not-fallback", after: performanceInt(0), full: performanceBool(true), kill: true, level: true, catalog: true, wantUnresolved: 1},
		{name: "unknown-full", kill: true, level: true, catalog: true, wantUnresolved: 1},
		{name: "not-full", full: performanceBool(false), kill: true, level: true, catalog: true, wantUnresolved: 1},
		{name: "no-ko", full: performanceBool(true), level: true, catalog: true, wantUnresolved: 1},
		{name: "no-level", full: performanceBool(true), kill: true, catalog: true, wantUnresolved: 1},
		{name: "no-catalog", full: performanceBool(true), kill: true, level: true, wantUnresolved: 1},
		{name: "zero-actual", change: performanceInt(0), full: performanceBool(true), kill: true, level: true, catalog: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := performanceRecord(tc.name)
			enemy := r.Sides["enemy"]
			if !tc.level {
				enemy.Pets[0].Level = nil
			}
			r.Sides["enemy"] = enemy
			r.Events = []BattleEvent{performanceForm("enemy-form", "enemy", "b", 2, 3, 1), performanceForm("own-form", "me", "a", 1, 4, 2), performanceSkill("attack", "me", "a", "enemy", "b", 3, true)}
			hit := performanceHit("damage", "attack", "me", "a", "enemy", "b", 3, 1, 0, "advantage")
			hit.HPChange = tc.change
			hit.HPAfter = tc.after
			hit.Combat.HPBefore = tc.before
			hit.Combat.FullHPBefore = tc.full
			r.Events = append(r.Events, hit)
			if tc.kill {
				r.Events = append(r.Events, performanceDeath("faint", "attack", "enemy", "b", 3, 2))
			}
			performanceValid(t, r)
			before, _ := json.Marshal(r)
			data := cat
			if !tc.catalog {
				data = nil
			}
			out := BuildBattlePerformance([]BattleRecord{r}, data)
			row := performanceSpecies(t, out, 1)
			if got := row.Totals.DamageDealt; got.Actual != tc.wantActual || got.Estimated != tc.wantEstimated || got.Unresolved != tc.wantUnresolved {
				t.Fatalf("damage %+v want actual=%d estimate=%d unresolved=%d", got, tc.wantActual, tc.wantEstimated, tc.wantUnresolved)
			}
			if row.Totals.AttackActions != 1 || row.Totals.Entries != 1 {
				t.Fatalf("form changed initial row/entries: %+v", row)
			}
			if tc.kill && row.Totals.Kills != 1 {
				t.Fatalf("linked KO missing: %+v", row)
			}
			after, _ := json.Marshal(r)
			if !bytes.Equal(before, after) {
				t.Fatal("estimate or classification mutated actor HP/profile/record")
			}
		})
	}
}

func TestBattlePerformancePriorHPAndHealing(t *testing.T) {
	for _, complete := range []bool{true, false} {
		t.Run(strconv.FormatBool(complete), func(t *testing.T) {
			r := performanceRecord("prior")
			r.Quality.Actions = complete
			r.Events = []BattleEvent{{ID: "snapshot", Kind: "resource", Phase: "executed", Round: 0, Seq: 0, Side: "enemy", Actor: "b", StateStage: "initial", HPAfter: performanceInt(100)}, performanceSkill("a1", "me", "a", "enemy", "b", 1, true)}
			h := performanceHit("h1", "a1", "me", "a", "enemy", "b", 1, 1, 0, "usual")
			h.HPChange = nil
			h.HPAfter = performanceInt(40)
			r.Events = append(r.Events, h,
				BattleEvent{ID: "heal", Kind: "heal", Phase: "executed", Round: 1, Seq: 2, Side: "enemy", Actor: "b", TargetSide: "enemy", Target: "b", HPChange: performanceInt(20), HPAfter: performanceInt(60)},
				performanceSkill("a2", "me", "a", "enemy", "b", 3, true))
			h2 := performanceHit("h2", "a2", "me", "a", "enemy", "b", 3, 1, 0, "usual")
			h2.HPChange = nil
			h2.HPAfter = performanceInt(10)
			r.Events = append(r.Events, h2)
			performanceValid(t, r)
			row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
			if complete && row.Totals.DamageDealt.Actual != 110 {
				t.Fatalf("HP tracking/healing: %+v", row.Totals.DamageDealt)
			}
			if !complete && (row.Totals.DamageDealt.Actual != 0 || row.Totals.DamageDealt.Unresolved != 2) {
				t.Fatalf("stale partial HP guessed: %+v", row.Totals.DamageDealt)
			}
		})
	}
}

func TestBattlePerformanceExitPeriodsOpponentCurrentFormAndSupplyDedup(t *testing.T) {
	r := performanceRecord("exits")
	r.Events = []BattleEvent{
		performanceForm("enemy-form", "enemy", "b", 2, 3, 1),
		performanceSwitch("own-out", "me", "c", "a", "voluntary", 2),
		performanceSwitch("enemy-out", "enemy", "b2", "b", "voluntary", 3),
		performanceSwitch("own-return", "me", "a", "c", "self", 4),
		performanceSkill("enemy-attack", "enemy", "b2", "me", "a", 5, true),
		performanceHit("death-damage", "enemy-attack", "enemy", "b2", "me", "a", 5, 1, 20, "resisted"),
		performanceDeath("dead", "enemy-attack", "me", "a", 5, 2),
		performanceDeath("duplicate-dead", "enemy-attack", "me", "a", 5, 3),
		{ID: "rkpp:action:1:6:0:supply:a2", Kind: "effect", Phase: "executed", Round: 1, Seq: 6, ExecIndex: performanceInt(0), Side: "me", Actor: "a2", Label: "补位通知", Text: "同一既有实例的 supply_pet 通知；不增加初始队员。"},
		performanceSwitch("late-swap-notice", "me", "a2", "a", "defeat", 7),
		performanceSwitch("forced", "me", "c", "a2", "forced", 8),
	}
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if row.Totals.Entries != 3 || row.EnteredBattles != 1 || row.Totals.Departures != (BattleDepartureTotals{Total: 3, Self: 1, Defeat: 1, Forced: 1}) {
		t.Fatalf("entry/exit periods: %+v", row)
	}
	// Neither supply nor the later same-incoming switch starts a second period.
	by := map[int]BattleDepartureTotals{}
	for _, m := range row.DeparturesByOpponent {
		by[m.MonsterID] = m.Totals
	}
	if by[3].Self != 1 || by[2].Total != 0 || by[4].Defeat != 1 || by[0].Forced != 1 {
		t.Fatalf("opponent at exit current form: %+v", by)
	}
}

func TestBattlePerformancePassiveBenchStateAndIdenticalSideInstances(t *testing.T) {
	r := performanceRecord("safe-ids")
	me := r.Sides["me"]
	enemy := r.Sides["enemy"]
	me.Pets[0].InstanceID = "__proto__"
	me.Lead = "__proto__"
	me.Pets[1].InstanceID = "constructor"
	enemy.Pets[0].InstanceID = "__proto__"
	enemy.Lead = "__proto__"
	r.Sides["me"], r.Sides["enemy"] = me, enemy
	r.Events = []BattleEvent{
		{ID: "bench-state", Kind: "resource", Phase: "executed", Round: 0, Seq: 0, Side: "me", Actor: "c", StateStage: "initial", StateActive: performanceBool(false), HPAfter: performanceInt(100)},
		{ID: "bench-passive", Kind: "effect", Phase: "executed", Round: 1, Seq: 1, Side: "me", Actor: "c", SkillClass: "passive"},
		performanceHit("bench-damage", "", "enemy", "__proto__", "me", "c", 2, 1, 20, "usual"),
		performanceForm("bench-form", "me", "c", 3, 4, 3),
		performanceSkill("constructor", "me", "__proto__", "enemy", "__proto__", 4, true),
		performanceHit("__proto__", "constructor", "me", "__proto__", "enemy", "__proto__", 4, 1, 10, "advantage"),
	}
	performanceValid(t, r)
	out := BuildBattlePerformance([]BattleRecord{r}, nil)
	bench := performanceSpecies(t, out, 3)
	if bench.EnteredBattles != 0 || bench.Totals.Entries != 0 || bench.Totals.DamageReceived.Actual != 20 {
		t.Fatalf("bench notifications prove entry: %+v", bench)
	}
	if own := performanceSpecies(t, out, 1); own.Totals.DamageDealt.Actual != 10 || own.Totals.DamageReceived.Actual != 0 {
		t.Fatalf("side or reserved-ID collision: %+v", own)
	}
}

func TestBattlePerformanceExactLegacyAssociationNeverNearest(t *testing.T) {
	for _, ambiguous := range []bool{false, true} {
		t.Run(strconv.FormatBool(ambiguous), func(t *testing.T) {
			r := performanceRecord("legacy")
			cast := performanceSkill("cast", "me", "a", "enemy", "b", 1, true)
			cast.ProtocolSkillID = "777"
			hit := performanceHit("rkpp:action:1:1:2:damage_info", "", "me", "a", "enemy", "b", 1, 2, 30, "advantage")
			hit.Text = "同一条执行消息、同一目标的数值同步；来源标识 777（不直接当作技能ID）。CSV逻辑行 9。 报告伤害与实际生命变化分开保留，不推导隐藏配置。"
			r.Events = []BattleEvent{cast}
			if ambiguous {
				other := cast
				other.ID = "cast-other"
				other.ExecIndex = performanceInt(1)
				r.Events = append(r.Events, other)
			}
			r.Events = append(r.Events, hit)
			performanceValid(t, r)
			row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
			if row.Totals.DamageDealt.Actual != 30 {
				t.Fatal("unlinked actual damage lost")
			}
			if !ambiguous && row.Totals.OutgoingAdvantage != 1 || ambiguous && (row.Totals.OutgoingAdvantage != 0 || row.Coverage.UnresolvedActionLinks != 1) {
				t.Fatalf("legacy exact association: %+v", row)
			}
		})
	}
}

func TestBattlePerformanceCompleteLineupsMultisetKnownSamples(t *testing.T) {
	first := performanceRecord("one")
	first.Rounds = 5
	first.DurationSeconds = performanceInt(0)
	second := performanceRecord("two")
	second.Outcome = "draw"
	second.Rounds = 9
	second.StartedAt = "2026-01-01T00:00:00Z"
	second.EndedAt = "2026-01-01T00:01:00Z"
	me := second.Sides["me"]
	me.Pets[0], me.Pets[2] = me.Pets[2], me.Pets[0]
	me.Lead = "c"
	me.Pets[0].Level = performanceInt(99)
	second.Sides["me"] = me
	third := performanceRecord("three")
	third.Outcome = "unknown"
	different := performanceRecord("different")
	me = different.Sides["me"]
	me.Pets = me.Pets[:2]
	different.Sides["me"] = me
	different.Outcome = "loss"
	partial := performanceRecord("partial")
	partial.Quality.Roster["me"] = false
	unknown := performanceRecord("unknown-id")
	me = unknown.Sides["me"]
	me.Pets[2].MonsterID = 0
	unknown.Sides["me"] = me
	out := BuildBattlePerformance([]BattleRecord{first, second, third, different, partial, unknown}, nil)
	if len(out.CompleteLineups) != 2 || out.Coverage.CompleteLineupBattles != 4 || out.Coverage.IncompleteLineupBattles != 2 {
		t.Fatalf("complete multiset selection: %+v", out)
	}
	var row BattleCompleteLineup
	for _, l := range out.CompleteLineups {
		if reflect.DeepEqual(l.MonsterIDs, []int{1, 1, 3}) {
			row = l
		}
	}
	if row.Battles != 3 || row.Wins != 1 || row.Draws != 1 || row.Unknown != 1 || row.KnownOutcomes != 2 || row.WinRate == nil || *row.WinRate != .5 {
		t.Fatalf("known outcome denominator: %+v", row)
	}
	if row.RoundSamples != 2 || row.AverageRounds == nil || *row.AverageRounds != 7 || row.DurationSamples != 2 || row.AverageDurationSeconds == nil || *row.AverageDurationSeconds != 30 {
		t.Fatalf("known means and duration zero: %+v", row)
	}
}

func TestBattlePerformanceDedupConflictInvalidImmutable(t *testing.T) {
	good := performanceRecord("good")
	good.Events = []BattleEvent{performanceSkill("cast", "me", "a", "enemy", "b", 1, true)}
	partial := good
	partial.Events = nil
	partial.Quality.Actions = false
	conflict := performanceRecord("conflict")
	other := conflict
	other.Outcome = "loss"
	invalid := performanceRecord("invalid")
	invalid.Version = 999
	validInvalid := performanceRecord("invalid")
	inputs := []BattleRecord{good, partial, good, conflict, other, validInvalid, invalid}
	before, _ := json.Marshal(inputs)
	out := BuildBattlePerformance(inputs, nil)
	after, _ := json.Marshal(inputs)
	if !bytes.Equal(before, after) {
		t.Fatal("clone/validate/merge mutated input")
	}
	if out.Coverage.IncludedBattles != 1 || out.Coverage.ConflictingBattles != 1 || out.Coverage.InvalidBattles != 1 {
		t.Fatalf("bad battle exclusion: %+v", out.Coverage)
	}
	row := performanceSpecies(t, out, 1)
	if row.CarriedBattles != 1 || row.Totals.AttackActions != 1 {
		t.Fatalf("duplicate counts: %+v", row)
	}
	reverse := append([]BattleRecord(nil), inputs...)
	for i, j := 0, len(reverse)-1; i < j; i, j = i+1, j-1 {
		reverse[i], reverse[j] = reverse[j], reverse[i]
	}
	again := BuildBattlePerformance(reverse, nil)
	if !reflect.DeepEqual(out, again) {
		t.Fatalf("input-order changed projection:\n%+v\n%+v", out, again)
	}
}

func TestBattlePerformanceReceivedOnlyAttacksAndCounteredSystemOrSwitch(t *testing.T) {
	r := performanceRecord("non-attacks")
	passive := BattleEvent{ID: "dot", Kind: "effect", Phase: "executed", Round: 1, Seq: 1, ExecIndex: performanceInt(0), Side: "enemy", Actor: "b", SkillClass: "passive"}
	charge := BattleEvent{ID: "charge", Kind: "effect", Phase: "executed", Round: 1, Seq: 2, ExecIndex: performanceInt(0), Side: "enemy", Actor: "b", SkillClass: "system", Combat: &BattleCombatEvidence{IsAttack: performanceBool(false)}}
	swap := performanceSwitch("swap", "me", "c", "a", "voluntary", 3)
	response := performanceSkill("counter-swap", "enemy", "b", "enemy", "b", 4, false)
	response.SkillClass = "response"
	response.Combat.ResponseAttempt = performanceBool(true)
	response.Combat.CounteredActionID = "swap"
	ownCharge := charge
	ownCharge.ID = "own-charge"
	ownCharge.Side = "me"
	ownCharge.Actor = "c"
	ownCharge.Seq = 5
	response2 := response
	response2.ID = "counter-charge"
	response2.Seq = 6
	response2.Combat = &BattleCombatEvidence{IsAttack: performanceBool(false), ResponseAttempt: performanceBool(true), CounteredActionID: "own-charge"}
	r.Events = []BattleEvent{passive, performanceHit("dot-loss", "dot", "enemy", "b", "me", "a", 1, 1, 15, "usual"), charge, performanceHit("charge-loss", "charge", "enemy", "b", "me", "a", 2, 1, 9, "usual"), swap, response, ownCharge, response2, performanceSkill("no-hit-evidence", "enemy", "b", "me", "c", 7, true), {ID: "hp-cost", Kind: "resource", Phase: "executed", Round: 1, Seq: 8, Side: "me", Actor: "c", HPChange: performanceInt(-10)}}
	performanceValid(t, r)
	out := BuildBattlePerformance([]BattleRecord{r}, nil)
	one := performanceSpecies(t, out, 1)
	three := performanceSpecies(t, out, 3)
	if one.Totals.ReceivedActions != 0 || one.Totals.ReceivedUsual != 0 || one.Totals.DamageReceived.Actual != 24 {
		t.Fatalf("non-attack effects became received attacks: %+v", one.Totals)
	}
	if three.Totals.AttackActions != 0 || three.Totals.CounteredActions != 2 || three.Totals.ReceivedActions != 0 || three.Coverage.ReceivedHitEvidenceUnknown != 1 || three.Totals.DamageReceived.Actual != 0 {
		t.Fatalf("system/switch/hit-evidence semantics: %+v", three)
	}
}

func TestBattlePerformanceEstimateDoesNotFillPartialActualMultihit(t *testing.T) {
	r := performanceRecord("partial-actual")
	a := performanceSkill("cast", "me", "a", "enemy", "b", 1, true)
	h1 := performanceHit("unknown-hit", "cast", "me", "a", "enemy", "b", 1, 1, 0, "advantage")
	h1.HPChange = nil
	h1.Combat.FullHPBefore = performanceBool(true)
	h2 := performanceHit("actual-hit", "cast", "me", "a", "enemy", "b", 1, 2, 8, "advantage")
	r.Events = []BattleEvent{a, h1, h2, performanceDeath("faint", "cast", "enemy", "b", 1, 3)}
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, performanceCatalog(t)), 1)
	if row.Totals.DamageDealt != (BattleDamageTotals{Actual: 8, Unresolved: 1}) {
		t.Fatalf("full-HP estimate inflated partially measured action: %+v", row.Totals.DamageDealt)
	}
	r.Events[0] = performanceForm("unknown-form", "enemy", "b", 2, 999, 0)
	r.Events = append([]BattleEvent{r.Events[0], a}, r.Events[1:]...)
	r.Events[3].HPChange = nil
	performanceValid(t, r)
	row = performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, performanceCatalog(t)), 1)
	if row.Totals.DamageDealt.Estimated != 0 || row.Totals.DamageDealt.Unresolved != 2 {
		t.Fatalf("missing current-form base HP was invented: %+v", row.Totals.DamageDealt)
	}
}

func TestBattlePerformanceKnownFullMaximumIsActualNotCatalogEstimate(t *testing.T) {
	for _, tracked := range []bool{false, true} {
		for _, after := range []*int{nil, performanceInt(100)} {
			t.Run(strconv.FormatBool(tracked)+"-"+strconv.FormatBool(after != nil), func(t *testing.T) {
				r := performanceRecord("full-max")
				r.Quality.Actions = false
				if tracked {
					r.Events = append(r.Events, BattleEvent{ID: "max", Kind: "resource", Phase: "executed", Round: 0, Seq: 0, Side: "enemy", Actor: "b", StateStage: "initial", HPMax: performanceInt(513)})
				}
				h := performanceHit("hit", "cast", "me", "a", "enemy", "b", 1, 1, 0, "usual")
				h.HPChange = nil
				h.HPAfter = after
				h.Combat.FullHPBefore = performanceBool(true)
				if !tracked {
					h.HPMax = performanceInt(513)
				}
				r.Events = append(r.Events, performanceSkill("cast", "me", "a", "enemy", "b", 1, true), h)
				if after == nil {
					r.Events = append(r.Events, performanceDeath("dead", "cast", "enemy", "b", 1, 2))
				}
				performanceValid(t, r)
				row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, performanceCatalog(t)), 1)
				want := int64(513)
				if after != nil {
					want -= int64(*after)
				}
				if row.Totals.DamageDealt != (BattleDamageTotals{Actual: want}) {
					t.Fatalf("known maximum was ignored or estimated: %+v", row.Totals.DamageDealt)
				}
			})
		}
	}
}

func TestBattlePerformanceOutgoingOnlyProvesDepartureNotEntryCount(t *testing.T) {
	r := performanceRecord("outgoing-only")
	r.Quality.Lead["me"] = false
	r.Quality.Actions = false
	r.Events = []BattleEvent{performanceSwitch("out1", "me", "c", "a", "voluntary", 1), performanceSwitch("out2", "me", "c", "a", "voluntary", 2)}
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if row.Totals.Entries != 0 || row.EnteredBattles != 1 || row.Totals.Departures.Self != 2 || row.Coverage.UnresolvedDepartures != 2 {
		t.Fatalf("explicit outgoing evidence lost or fabricated entries: %+v", row)
	}
	if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].Attribution != "facing" || row.DeparturesByOpponent[0].MonsterID != 2 {
		t.Fatalf("voluntary face-only attribution: %+v", row.DeparturesByOpponent)
	}
	r.Events = []BattleEvent{performanceSkill("enemy", "enemy", "b", "me", "a", 1, true), performanceDeath("faint", "enemy", "me", "a", 1, 1)}
	performanceValid(t, r)
	row = performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if row.Totals.Entries != 0 || row.EnteredBattles != 0 || row.Totals.Departures.Total != 0 || row.Coverage.UnresolvedDepartures != 1 {
		t.Fatalf("bench/unknown faint invented presence: %+v", row)
	}
}

func TestBattlePerformanceDepartureCauseUsesSourceFormNotReplacement(t *testing.T) {
	r := performanceRecord("dot-cause")
	source := BattleEvent{ID: "dot", Kind: "effect", Phase: "executed", Round: 1, Seq: 2, ExecIndex: performanceInt(0), Side: "enemy", Actor: "b", SkillClass: "passive"}
	r.Events = []BattleEvent{performanceForm("source-form", "enemy", "b", 2, 3, 1), source, performanceForm("later-form", "enemy", "b", 3, 4, 3), performanceSwitch("foe-replacement", "enemy", "b2", "b", "voluntary", 4), performanceDeath("ko", "dot", "me", "a", 5, 1)}
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 3 || row.DeparturesByOpponent[0].Attribution != "cause" {
		t.Fatalf("replacement or initial species was called the cause: %+v", row.DeparturesByOpponent)
	}
	r.Events = r.Events[:4]
	r.Events = append(r.Events, performanceSwitch("unknown-exit", "me", "c", "a", "unknown", 5))
	performanceValid(t, r)
	row = performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if len(row.DeparturesByOpponent) != 0 || row.Totals.Departures != (BattleDepartureTotals{}) || row.Averages.Departures != (BattleDepartureAverages{}) {
		t.Fatalf("unknown exit was included in known departures: %+v", row)
	}
}

func TestBattlePerformanceUnknownDamageAttributionRetainsMeasuredOwnLoss(t *testing.T) {
	r := performanceRecord("unknown-damage")
	r.Events = []BattleEvent{{ID: "unknown", Kind: "damage", Phase: "executed", Round: 1, Seq: 1, Side: "unknown", TargetSide: "me", Target: "a", HPChange: performanceInt(-10)}}
	performanceValid(t, r)
	out := BuildBattlePerformance([]BattleRecord{r}, nil)
	row := performanceSpecies(t, out, 1)
	if out.Coverage.UnattributedDamageEvents != 1 || row.Totals.DamageReceived.Actual != 10 || row.Totals.ReceivedActions != 0 || row.Totals.ReceivedUsual != 0 || row.Coverage.UnresolvedActionLinks != 1 {
		t.Fatalf("unknown source was guessed or known loss discarded: %+v / %+v", out.Coverage, row)
	}
}

func TestBattlePerformanceZeroHPFormResetIsNotAKillOrAnEntry(t *testing.T) {
	r := performanceRecord("zero-form")
	hit := performanceHit("zero", "cast", "me", "a", "enemy", "b", 1, 1, 50, "usual")
	hit.HPAfter = performanceInt(0)
	r.Events = []BattleEvent{performanceSkill("cast", "me", "a", "enemy", "b", 1, true), hit, performanceForm("restore-form", "enemy", "b", 2, 3, 2), {ID: "restore-hp", Kind: "resource", Phase: "executed", Round: 1, Seq: 3, Side: "enemy", Actor: "b", StateStage: "snapshot", StateActive: performanceBool(true), HPAfter: performanceInt(100)}}
	own := r.Sides["me"]
	own.Pets[0].IV = map[string]BattleEvidence{"hp": {Certainty: "candidate", Candidates: []float64{60, 0, 60}}}
	r.Sides["me"] = own
	performanceValid(t, r)
	before, _ := json.Marshal(r)
	out := BuildBattlePerformance([]BattleRecord{r}, performanceCatalog(t))
	after, _ := json.Marshal(r)
	row := performanceSpecies(t, out, 1)
	if row.Totals.Kills != 0 || row.Totals.DamageDealt.Actual != 50 || row.Totals.Entries != 1 || out.Coverage.UnattributedKills != 0 {
		t.Fatalf("zero HP/form reset invented KO or entry: %+v", row)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("normalizing cloned profile evidence mutated original IV or HP data")
	}
}

// An explicit opt-in audit can read a disposable candidate and catalog fixture.
// There are no default paths and no profile/database access or writes. Normal
// test runs remain entirely synthetic and independent of local player data.
func TestBattlePerformanceOptInCatalogRecordAudit(t *testing.T) {
	recordPath, catalogPath := os.Getenv("BATTLE_PERFORMANCE_AUDIT_RECORD"), os.Getenv("BATTLE_PERFORMANCE_AUDIT_CATALOG")
	if recordPath == "" || catalogPath == "" {
		t.Skip("explicit disposable audit inputs not supplied")
	}
	data, err := os.ReadFile(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	var record BattleRecord
	if err = json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	catalogData, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(record)
	out := BuildBattlePerformance([]BattleRecord{record}, catalogData)
	after, _ := json.Marshal(record)
	if !bytes.Equal(before, after) {
		t.Fatal("candidate mutated")
	}
	if out.Coverage.IncludedBattles != 1 {
		t.Fatalf("audit record excluded: %+v", out.Coverage)
	}
	attack, attempt, success, kills, countered := 0, 0, 0, 0, 0
	dealt, received := int64(0), int64(0)
	for _, row := range out.Species {
		v := row.Totals
		attack += v.AttackActions
		attempt += v.ResponseAttempts
		success += v.ResponseSuccess
		kills += v.Kills
		countered += v.CounteredActions
		dealt += v.DamageDealt.Actual
		received += v.DamageReceived.Actual
		t.Logf("species %d carry=%d entries=%d attack=%d response=%d/%d countered=%d damage=%+v received=%+v kills=%d departures=%+v", row.MonsterID, row.CarriedBattles, v.Entries, v.AttackActions, v.ResponseSuccess, v.ResponseAttempts, v.CounteredActions, v.DamageDealt, v.DamageReceived, v.Kills, row.DeparturesByOpponent)
		t.Logf("NEW species %d deaths=%d status=%d/%d defense=%d/%d attackAttempts=%d attackCountered=%d statusCountered=%d defenseSuccess=%d rollerCoaster=%+v", row.MonsterID, v.Deaths, v.StatusActions, v.StatusAttempts, v.DefenseActions, v.DefenseAttempts, v.AttackAttempts, v.AttackCountered, v.StatusCountered, v.DefenseSuccess, row.RollerCoaster)
	}
	t.Logf("TOTAL attacks=%d attempts=%d success=%d countered=%d dealt=%d received=%d kills=%d coverage=%+v", attack, attempt, success, countered, dealt, received, kills, out.Coverage)
	// This extra opt-in asserts the frozen, audited 2026-11-01 record rather
	// than imposing one battle's expected numbers on arbitrary future audits.
	if os.Getenv("BATTLE_PERFORMANCE_AUDIT_EXPECT_CURRENT") == "1" {
		if attack != 14 || attempt != 11 || success != 5 || countered != 5 || dealt != 1594 || received != 1728 || kills != 1 {
			t.Fatal("approved existing actual-record baseline changed")
		}
		got := [9]int{}
		for _, row := range out.Species {
			v := row.Totals
			values := [9]int{v.Deaths, v.StatusActions, v.DefenseActions, v.AttackAttempts, v.StatusAttempts, v.DefenseAttempts, v.AttackCountered, v.StatusCountered, v.DefenseSuccess}
			for i, n := range values {
				got[i] += n
			}
		}
		if got != ([9]int{2, 12, 4, 14, 15, 4, 1, 4, 4}) {
			t.Fatalf("approved deaths/status/defense/attempt/counter totals changed: %v", got)
		}
		mech := performanceSpecies(t, out, 501)
		rc := mech.RollerCoaster
		if mech.Totals.Departures != (BattleDepartureTotals{}) || len(mech.DeparturesByOpponent) != 0 {
			t.Fatalf("unconfirmed mech exit included in known departures: %+v", mech)
		}
		if rc == nil || rc.CarriedBattles != 1 || rc.SuccessBattles != 1 || rc.KnownOutcomeBattles != 1 || rc.Wins != 0 || rc.SuccessRate == nil || *rc.SuccessRate != 1 || rc.WinRate == nil || *rc.WinRate != 0 {
			t.Fatalf("r4 completed ordinary roller cast lost (r1/r2 were interrupted): %+v", rc)
		}
		mechs := map[string]bool{}
		for _, pet := range record.Sides["me"].Pets {
			mechs[pet.InstanceID] = pet.MonsterID == 501
		}
		completed, interrupted := 0, 0
		for _, e := range record.Events {
			if e.Side == "me" && mechs[e.Actor] && e.Kind == "skill" && e.SkillID == 492 {
				if e.Phase == "executed" {
					completed++
				} else if e.Phase == "interrupted" {
					interrupted++
				}
			}
		}
		if completed != 1 || interrupted != 2 {
			t.Fatalf("audited actual roller fixture changed: executed=%d interrupted=%d", completed, interrupted)
		}
	}
}

func performanceCategorizedSkill(id string, skillID, seq int, phase string) BattleEvent {
	e := performanceSkill(id, "me", "a", "enemy", "b", seq, false)
	e.SkillID, e.Phase, e.SkillClass, e.Combat = skillID, phase, "ordinary", nil
	return e
}

func TestBattlePerformanceTypedActionsAttemptsCounteredAndRatios(t *testing.T) {
	r := performanceRecord("typed-actions")
	attack := performanceCategorizedSkill("attack", 10, 1, "executed")
	attackInterrupted := performanceCategorizedSkill("attack-interrupted", 10, 2, "interrupted")
	status := performanceCategorizedSkill("status", 13, 3, "executed")
	statusInterrupted := performanceCategorizedSkill("status-interrupted", 13, 4, "interrupted")
	defense := performanceCategorizedSkill("defense-release", 12, 5, "executed")
	defenseInterrupted := performanceCategorizedSkill("defense-interrupted", 12, 6, "interrupted")
	enemy := performanceSkill("enemy-attack", "enemy", "b", "me", "a", 7, true)
	response := func(id string, skillID, seq int, link string) BattleEvent {
		e := performanceCategorizedSkill(id, skillID, seq, "executed")
		e.SkillClass = "response"
		e.Combat = &BattleCombatEvidence{ResponseAttempt: performanceBool(true), CounteredActionID: link}
		return e
	}
	counter := func(id, link string, seq int) BattleEvent {
		e := response(id, 13, seq, link)
		e.Side, e.Actor = "enemy", "b"
		e.TargetSide, e.Target = "me", "a"
		return e
	}
	r.Events = []BattleEvent{attack, attack, attackInterrupted, status, statusInterrupted, defense, defenseInterrupted, enemy,
		response("defense-confirmed", 12, 8, "enemy-attack"),
		response("defense-unlinked", 12, 9, ""),
		response("status-counter", 13, 10, "enemy-attack"),
		response("attack-counter", 10, 11, "enemy-attack"),
		counter("foe-counter-attack", "attack-interrupted", 12),
		counter("foe-counter-attack-repeat", "attack-interrupted", 13),
		counter("foe-counter-status", "status-interrupted", 14),
		{ID: "charge", Kind: "effect", Phase: "executed", Round: 1, Seq: 15, Side: "me", Actor: "a", SkillClass: "system", ProtocolSkillID: "700001000"},
		{ID: "charge-resource", Kind: "resource", Phase: "executed", Round: 1, Seq: 15, Side: "me", Actor: "a", SkillClass: "system", ProtocolSkillID: "700001000", EnergyChange: performanceInt(3)},
		{ID: "passive-charge-id", Kind: "effect", Phase: "executed", Round: 1, Seq: 16, Side: "me", Actor: "a", SkillClass: "passive", ProtocolSkillID: "700001000"},
		{ID: "other-system", Kind: "effect", Phase: "executed", Round: 1, Seq: 17, Side: "me", Actor: "a", SkillClass: "system", Label: "聚能", ProtocolSkillID: "999"},
		performanceCategorizedSkill("preview-attack", 10, 18, "preview"),
		performanceCategorizedSkill("planned-defense", 12, 19, "selection"),
		performanceCategorizedSkill("selected-status", 13, 20, "selection"),
		performanceHit("small-loss-not-defense-proof", "enemy-attack", "enemy", "b", "me", "a", 21, 0, 1, "usual"),
		performanceDeath("own-death", "enemy-attack", "me", "a", 22, 0),
		performanceDeath("same-death-again", "enemy-attack", "me", "a", 23, 0),
		performanceSwitch("replacement", "me", "c", "a", "defeat", 24),
	}
	performanceValid(t, r)
	carried := performanceRecord("typed-carried-without-action")
	cat := performanceCatalog(t)
	before, _ := json.Marshal([]BattleRecord{r, carried})
	catBefore := append([]byte(nil), cat...)
	out := BuildBattlePerformance([]BattleRecord{r, carried}, cat)
	row := performanceSpecies(t, out, 1)
	v := row.Totals
	if v.AttackActions != 2 || v.StatusActions != 3 || v.DefenseActions != 3 || v.AttackAttempts != 3 || v.StatusAttempts != 4 || v.DefenseAttempts != 4 {
		t.Fatalf("executed/attempt/non-action classification: %+v", v)
	}
	if v.AttackCountered != 1 || v.StatusCountered != 1 || v.CounteredActions != 2 || v.DefenseSuccess != 1 || v.Deaths != 1 || v.ReceivedActions != 1 {
		t.Fatalf("distinct interrupted counter targets or defense/death proof: %+v", v)
	}
	if row.Averages.AttackAttempts != 1.5 || row.Averages.StatusActions != 1.5 || row.Averages.DefenseActions != 1.5 || row.Averages.StatusAttempts != 2 || row.Averages.DefenseAttempts != 2 || row.Averages.Deaths != .5 || row.Averages.AttackCountered != .5 || row.Averages.StatusCountered != .5 || row.Averages.DefenseSuccess != .5 {
		t.Fatalf("new averages must divide by carried battles: %+v", row.Averages)
	}
	for name, pair := range map[string]struct {
		got  *float64
		want float64
	}{
		"attackPerDeath": {row.AttackPerDeath, 2}, "receivedPerDeath": {row.ReceivedPerDeath, 1},
		"attackCounteredRate": {row.AttackCounteredRate, 1.0 / 3}, "statusCounteredRate": {row.StatusCounteredRate, .25}, "defenseSuccessRate": {row.DefenseSuccessRate, .25},
	} {
		if pair.got == nil || *pair.got != pair.want {
			t.Fatalf("%s ratio uses wrong denominator: %v want %v", name, pair.got, pair.want)
		}
	}
	after, _ := json.Marshal([]BattleRecord{r, carried})
	if !bytes.Equal(before, after) || !bytes.Equal(catBefore, cat) {
		t.Fatal("typed metrics mutated records or current catalog")
	}
}

func TestBattlePerformanceDefenseSuccessRequiresKnownOpposingAttack(t *testing.T) {
	cases := []struct {
		name   string
		target BattleEvent
		want   int
	}{
		{name: "physical-executed", target: performanceCategorizedSkill("target", 10, 1, "executed"), want: 1},
		{name: "physical-interrupted", target: performanceCategorizedSkill("target", 10, 1, "interrupted"), want: 1},
		{name: "magic-executed", target: performanceCategorizedSkill("target", 11, 1, "executed"), want: 1},
		{name: "status-executed", target: performanceCategorizedSkill("target", 13, 1, "executed")},
		{name: "status-interrupted", target: performanceCategorizedSkill("target", 13, 1, "interrupted")},
		{name: "defense", target: performanceCategorizedSkill("target", 12, 1, "executed")},
		{name: "unknown-skill", target: performanceCategorizedSkill("target", 999999, 1, "executed")},
		{name: "charge", target: BattleEvent{ID: "target", Kind: "effect", Phase: "executed", Round: 1, Seq: 1, Side: "enemy", Actor: "b", SkillClass: "system", ProtocolSkillID: "700001000"}},
		{name: "switch", target: performanceSwitch("target", "enemy", "b2", "b", "voluntary", 1)},
		{name: "passive", target: BattleEvent{ID: "target", Kind: "effect", Phase: "executed", Round: 1, Seq: 1, Side: "enemy", Actor: "b", SkillClass: "passive"}},
	}
	cat := performanceCatalog(t)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := performanceRecord("defense-target-" + tc.name)
			target := tc.target
			if target.Kind == "skill" {
				target.Side, target.Actor, target.TargetSide, target.Target = "enemy", "b", "me", "a"
			}
			defense := performanceCategorizedSkill("confirmed-defense-response", 12, 2, "executed")
			defense.SkillClass = "response"
			defense.Combat = &BattleCombatEvidence{ResponseAttempt: performanceBool(true), CounteredActionID: "target"}
			r.Events = []BattleEvent{target, defense}
			performanceValid(t, r)
			before, _ := json.Marshal(r)
			// Repeated fresh maps also protect against an order-dependent first
			// pass reading an opposing action before it has been classified.
			for i := 0; i < 12; i++ {
				row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, cat), 1)
				if row.Totals.DefenseActions != 1 || row.Totals.DefenseAttempts != 1 || row.Totals.DefenseSuccess != tc.want || row.DefenseSuccessRate == nil || *row.DefenseSuccessRate != float64(tc.want) {
					t.Fatalf("defense protected non-attack, lost interrupted attack, or depended on map order: %+v", row)
				}
				if row.Totals.ResponseSuccess != 1 {
					t.Fatal("new defense metric changed legacy response evidence")
				}
			}
			after, _ := json.Marshal(r)
			if !bytes.Equal(before, after) {
				t.Fatal("defense classification mutated action evidence")
			}
		})
	}
}

func TestBattlePerformanceUnknownExitsAdvancePresenceWithoutHidingDeaths(t *testing.T) {
	r := performanceRecord("unknown-exits-known-deaths")
	r.Events = []BattleEvent{
		performanceSwitch("unknown-out", "me", "c", "a", "unknown", 1),
		performanceDeath("bench-death-unknown-killer", "", "me", "a", 2, 0),
		performanceDeath("bench-death-duplicate", "", "me", "a", 3, 0),
		performanceSwitch("enemy-out", "enemy", "b2", "b", "voluntary", 4),
		performanceSwitch("known-c-exit", "me", "a2", "c", "voluntary", 5),
		{ID: "zero-not-death", Kind: "resource", Phase: "executed", Round: 1, Seq: 6, Side: "me", Actor: "a2", HPAfter: performanceInt(0)},
		{ID: "unknown-state-exit", Kind: "resource", Phase: "executed", Round: 1, Seq: 7, Side: "me", Actor: "a2", StateStage: "snapshot", StateActive: performanceBool(false)},
		performanceSkill("a2-return-cast", "me", "a2", "enemy", "b2", 8, true),
		performanceDeath("active-death-unknown-killer", "", "me", "a2", 9, 0),
		performanceDeath("active-death-duplicate", "", "me", "a2", 10, 0),
		performanceSwitch("death-replacement", "me", "c", "a2", "defeat", 11),
	}
	performanceValid(t, r)
	out := BuildBattlePerformance([]BattleRecord{r, performanceRecord("extra-carry")}, nil)
	row := performanceSpecies(t, out, 1)
	if row.Totals.Deaths != 2 || row.Totals.Departures != (BattleDepartureTotals{Total: 1, Defeat: 1}) || row.Averages.Deaths != 1 || row.Averages.Departures.Total != .5 {
		t.Fatalf("death evidence conflated with known field departures: %+v", row)
	}
	if row.Totals.Entries != 4 || row.EnteredBattles != 2 || row.Totals.AttackActions != 1 {
		t.Fatalf("unknown exits did not advance active/period state: %+v", row)
	}
	if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 0 || row.DeparturesByOpponent[0].Totals.Total != 1 || row.DeparturesByOpponent[0].Attribution != "unknown" {
		t.Fatalf("unknown reasons counted, or unknown killer death discarded: %+v", row.DeparturesByOpponent)
	}
	c := performanceSpecies(t, out, 3)
	if len(c.DeparturesByOpponent) != 1 || c.DeparturesByOpponent[0].MonsterID != 4 || c.DeparturesByOpponent[0].Attribution != "facing" || c.Totals.Deaths != 0 {
		t.Fatalf("known voluntary departure lost correct facing or became death: %+v", c)
	}
	if c.AttackPerDeath != nil || c.ReceivedPerDeath != nil {
		t.Fatal("a field departure is not a death denominator")
	}
	if row.AttackPerDeath == nil || *row.AttackPerDeath != .5 || row.ReceivedPerDeath == nil || *row.ReceivedPerDeath != 0 {
		t.Fatalf("death ratios redivided by carry or unknown killer discarded: %+v", row)
	}
}

func performanceRollerRecord(id, outcome string) BattleRecord {
	r := performanceRecord(id)
	r.Outcome = outcome
	me := r.Sides["me"]
	me.Pets[0].MonsterID, me.Pets[1].MonsterID = battlePerformanceRollerCoasterSpecies, battlePerformanceRollerCoasterSpecies
	me.Lead = "c" // Two carried mechs, neither is assumed to have entered.
	r.Sides["me"] = me
	enemy := r.Sides["enemy"]
	enemy.Pets[0].MonsterID = battlePerformanceRollerCoasterSpecies
	r.Sides["enemy"] = enemy
	return r
}

func performanceRollerCast(id, actor, phase string, seq int) BattleEvent {
	e := performanceCategorizedSkill(id, battlePerformanceRollerCoasterSkill, seq, phase)
	e.Actor = actor
	return e
}

func TestBattlePerformanceRollerCoasterBattleSetsExactInitialInstanceAndOutcomes(t *testing.T) {
	win := performanceRollerRecord("win-multiple", "win")
	win.Events = []BattleEvent{performanceRollerCast("first", "a", "executed", 1), performanceRollerCast("first", "a", "executed", 1), performanceRollerCast("second", "a", "executed", 2), performanceRollerCast("other-mech-instance", "a2", "executed", 3)}
	loss := performanceRollerRecord("loss", "loss")
	loss.Events = []BattleEvent{performanceRollerCast("completed-ordinary", "a", "executed", 1)}
	draw := performanceRollerRecord("draw", "draw")
	// The initial mech identity owns its cast even after a form transition.
	draw.Events = []BattleEvent{performanceForm("mech-new-form", "me", "a", 501, 3, 1), performanceRollerCast("cast-after-form", "a", "executed", 2)}
	unknown := performanceRollerRecord("unknown", "unknown")
	unknown.Events = []BattleEvent{performanceRollerCast("completed-unknown-outcome", "a", "executed", 1)}
	failure := performanceRollerRecord("interrupted-failure", "win")
	failure.Events = []BattleEvent{performanceRollerCast("interrupted-one", "a", "interrupted", 1), performanceRollerCast("interrupted-two", "a", "interrupted", 2)}
	bench := performanceRollerRecord("carried-no-entry", "win")
	wrong := performanceRollerRecord("wrong-actor-or-phase", "win")
	enemyCast := performanceRollerCast("opposite-side", "b", "executed", 1)
	enemyCast.Side, enemyCast.TargetSide, enemyCast.Target = "enemy", "me", "a"
	wrong.Events = []BattleEvent{enemyCast,
		performanceRollerCast("own-other-species", "c", "executed", 2),
		performanceForm("non-mech-becomes-mech", "me", "c", 3, 501, 3),
		performanceRollerCast("cast-by-transformed-other-species", "c", "executed", 4),
		performanceRollerCast("mech-preview", "a", "preview", 5),
		performanceRollerCast("mech-selected", "a", "selection", 6),
		performanceRollerCast("mech-unknown", "a", "unknown", 7),
		{ID: "same-label-system", Kind: "effect", Phase: "executed", Round: 1, Seq: 8, Side: "me", Actor: "a", SkillClass: "system", Label: "过山车", ProtocolSkillID: "707029000"},
		{ID: "same-label-resource", Kind: "resource", Phase: "executed", Round: 1, Seq: 9, Side: "me", Actor: "a", Label: "过山车", ProtocolSkillID: "707029000", EnergyChange: performanceInt(-8)},
	}
	fakeName := performanceCategorizedSkill("same-name-different-id", 13, 10, "executed")
	fakeName.Label = "过山车"
	wrong.Events = append(wrong.Events, fakeName)
	partialWin := win
	partialWin.Events = nil
	partialWin.Quality.Actions = false
	inputs := []BattleRecord{win, partialWin, win, loss, draw, unknown, failure, bench, wrong}
	for _, r := range inputs {
		performanceValid(t, r)
	}
	before, _ := json.Marshal(inputs)
	out := BuildBattlePerformance(inputs, nil)
	row := performanceSpecies(t, out, 501)
	rc := row.RollerCoaster
	if rc == nil || rc.CarriedBattles != 7 || rc.SuccessBattles != 4 || rc.KnownOutcomeBattles != 3 || rc.Wins != 1 || rc.SuccessRate == nil || *rc.SuccessRate != 4.0/7 || rc.WinRate == nil || *rc.WinRate != 1.0/3 {
		t.Fatalf("roller battle-set or successful-subset outcome denominator: %+v", rc)
	}
	if row.CarriedBattles != 7 || row.EnteredBattles != 5 {
		t.Fatalf("same-species instances or no-entry sample inflated carry/entry: %+v", row)
	}
	for _, other := range out.Species {
		if other.MonsterID != 501 {
			data, _ := json.Marshal(other)
			if other.RollerCoaster != nil || bytes.Contains(data, []byte(`"rollerCoaster"`)) {
				t.Fatalf("roller metric leaked to other species: %s", data)
			}
		}
	}
	after, _ := json.Marshal(inputs)
	if !bytes.Equal(before, after) {
		t.Fatal("roller projection mutated records, forms, instances or action phases")
	}
}

func TestBattlePerformanceRollerCoasterTwoInterruptedZeroAndUnknownWinRate(t *testing.T) {
	for _, unknownSuccess := range []bool{false, true} {
		r := performanceRollerRecord("two-interrupted", "unknown")
		r.Events = []BattleEvent{performanceRollerCast("r1-interrupted", "a", "interrupted", 1), performanceRollerCast("r2-interrupted", "a", "interrupted", 2)}
		if unknownSuccess {
			r.Events = append(r.Events, performanceRollerCast("r4-completed", "a", "executed", 4))
		}
		performanceValid(t, r)
		rc := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 501).RollerCoaster
		want := 0
		if unknownSuccess {
			want = 1
		}
		if rc == nil || rc.CarriedBattles != 1 || rc.SuccessBattles != want || rc.KnownOutcomeBattles != 0 || rc.Wins != 0 || rc.SuccessRate == nil || *rc.SuccessRate != float64(want) || rc.WinRate != nil {
			t.Fatalf("interrupted-only or unknown successful outcome fabricated win-rate: %+v", rc)
		}
		data, _ := json.Marshal(rc)
		if !bytes.Contains(data, []byte(`"winRate":null`)) {
			t.Fatalf("unknown roller win-rate must serialize null: %s", data)
		}
	}
}

func TestBattlePerformanceRollerCoasterOpposingIdenticalInstanceIsNotOwner(t *testing.T) {
	r := performanceRollerRecord("opposite-identical-instance", "win")
	enemy := r.Sides["enemy"]
	enemy.Pets[0].InstanceID, enemy.Lead = "a", "a"
	r.Sides["enemy"] = enemy
	e := performanceRollerCast("enemy-roller", "a", "executed", 1)
	e.Side, e.TargetSide, e.Target = "enemy", "me", "a"
	r.Events = []BattleEvent{e}
	performanceValid(t, r)
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 501)
	rc := row.RollerCoaster
	if rc == nil || rc.CarriedBattles != 1 || rc.SuccessBattles != 0 || rc.SuccessRate == nil || *rc.SuccessRate != 0 || rc.WinRate != nil || row.EnteredBattles != 0 {
		t.Fatalf("opposite side identical instance/skill counted as own success: %+v", row)
	}
}

func TestBattlePerformanceCurrentCatalogDefenseAndRollerIdentity(t *testing.T) {
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	before := append([]byte(nil), data...)
	cat := battlePerformanceReadCatalog(data)
	if !cat.available {
		t.Fatal("current canonical unavailable")
	}
	s := cat.skills[battlePerformanceRollerCoasterSkill]
	if s.Name != "过山车" || s.Category != "Status" || s.EnergyCost != 8 {
		t.Fatalf("reviewed local roller identity changed: %+v", s)
	}
	parsed, err := canonicalcatalog.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	mechFound := false
	for _, m := range parsed.Monsters {
		if m.ID == battlePerformanceRollerCoasterSpecies {
			mechFound = m.Name == "机幕方舟"
		}
	}
	if !mechFound {
		t.Fatal("reviewed initial local species 501 changed")
	}
	defenses := 0
	r := performanceRecord("ordinary-defenses")
	for id, s := range cat.skills {
		if s.Category != "Defense" {
			continue
		}
		defenses++
		e := performanceCategorizedSkill("defense-"+strconv.Itoa(id), id, id, "executed")
		response, known, derived := cat.response(e)
		if !response || !known || !derived || cat.category(e, false, true) != "defense" {
			t.Fatalf("current Defense lacks known response capability: %+v", s)
		}
		r.Events = append(r.Events, e)
	}
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, data), 1)
	if row.Totals.DefenseActions != defenses || row.Totals.DefenseAttempts != defenses || row.Totals.ResponseAttempts != defenses || row.Totals.DefenseSuccess != 0 || row.DefenseSuccessRate == nil || *row.DefenseSuccessRate != 0 {
		t.Fatalf("ordinary Defense was omitted or became success without execution proof: %+v", row)
	}
	if defenses == 0 || !bytes.Equal(before, data) {
		t.Fatal("missing defenses or mutable catalog projection")
	}
}

func TestBattlePerformanceEmptyOutputsAndUnknownNotZero(t *testing.T) {
	out := BuildBattlePerformance(nil, nil)
	data, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Species) != 0 || len(out.CompleteLineups) != 0 || !bytes.Contains(data, []byte(`"species":[]`)) {
		t.Fatalf("empty DTO: %s", data)
	}
	r := performanceRecord("no-measurements")
	r.Outcome = "unknown"
	r.Quality.Lead["me"] = false
	r.Sides["me"] = BattleSide{Pets: r.Sides["me"].Pets}
	row := performanceSpecies(t, BuildBattlePerformance([]BattleRecord{r}, nil), 1)
	if row.ResponseRate != nil || row.EnteredBattles != 0 || row.Coverage.PartialActionBattles != 1 || row.CarriedBattles != 1 {
		t.Fatalf("missing coverage/rate: %+v", row)
	}
	if row.AttackPerDeath != nil || row.ReceivedPerDeath != nil || row.AttackCounteredRate != nil || row.StatusCounteredRate != nil || row.DefenseSuccessRate != nil {
		t.Fatalf("missing denominator became numeric rate: %+v", row)
	}
	data, err = json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var public map[string]json.RawMessage
	if err = json.Unmarshal(data, &public); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"attackPerDeath", "receivedPerDeath", "attackCounteredRate", "statusCounteredRate", "defenseSuccessRate"} {
		if string(public[key]) != "null" {
			t.Fatalf("public row ratio %s missing or non-null: %s", key, data)
		}
	}
	for _, group := range []string{"totals", "averages"} {
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(public[group], &fields); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"deaths", "statusActions", "defenseActions", "attackAttempts", "statusAttempts", "defenseAttempts", "attackCountered", "statusCountered", "defenseSuccess"} {
			if string(fields[key]) != "0" {
				t.Fatalf("public %s.%s missing or not zero: %s", group, key, data)
			}
		}
	}
}
