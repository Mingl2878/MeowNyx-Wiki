package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

func inferenceRecord() BattleRecord {
	r := performanceRecord("inference")
	r.Sides["me"] = BattleSide{Pets: []BattlePet{{InstanceID: "a", MonsterID: 1, Level: performanceInt(60), IV: map[string]BattleEvidence{}, Nature: map[string]BattleEvidence{}}}}
	r.Sides["enemy"] = BattleSide{Pets: []BattlePet{{InstanceID: "b", MonsterID: 2, Level: performanceInt(60)}}}
	r.Quality.Lead = map[string]bool{}
	r.Quality.Actions = false
	p := &r.Sides["me"].Pets[0]
	for _, s := range battleStatKeys {
		p.IV[s] = BattleEvidence{Value: performanceNumber(0), Certainty: "direct"}
		p.Nature[s] = BattleEvidence{Value: performanceNumber(0), Certainty: "direct"}
	}
	p.IV["hp"] = BattleEvidence{Value: performanceNumber(54), Certainty: "direct", Evidence: []string{"actual IV54"}}
	return r
}
func inferenceInitialHP(side, actor string, hp int) BattleEvent {
	return BattleEvent{ID: "hp:" + actor, Kind: "resource", Phase: "executed", Side: side, Actor: actor, StateStage: "initial", HPMax: performanceInt(hp), HPAfter: performanceInt(hp)}
}
func inferenceDecision(t *testing.T, out BattleInferenceDTO, side, actor, stat string) BattleInferenceDecision {
	t.Helper()
	for _, d := range out.Decisions {
		if d.Side == side && d.InstanceID == actor && d.Stat == stat {
			return d
		}
	}
	t.Fatalf("missing decision %s/%s/%s", side, actor, stat)
	return BattleInferenceDecision{}
}
func inferenceDamageRecord(category, direction string, nature int) BattleRecord {
	r := inferenceRecord()
	stat, ownStat := "attack", "defense"
	side, actor, targetSide, target := "enemy", "b", "me", "a"
	attackerID, defenderID := 2, 1
	if direction == "received" {
		stat, ownStat = "defense", "attack"
		side, actor, targetSide, target = "me", "a", "enemy", "b"
		attackerID, defenderID = 1, 2
	}
	if category == "magic" {
		stat = "magic_" + stat
		ownStat = "magic_" + ownStat
	}
	r.Sides["me"].Pets[0].IV[ownStat] = BattleEvidence{Value: performanceNumber(54), Certainty: "direct"}
	own := battleInferenceStat(80, ownStat, 0, 54, 60)
	unknown := battleInferenceStat(80, stat, nature, 60, 60)
	atk, def := float64(unknown), float64(own)
	if direction == "received" {
		atk, def = def, atk
	}
	loss := battleInferenceDamage(atk, 600, def, 1, 1, 1, 1, 60)
	a := performanceSkill("cast", side, actor, targetSide, target, 1, true)
	a.SkillClass = "ordinary"
	h := performanceHit("hit", "cast", side, actor, targetSide, target, 1, 1, loss, "usual")
	h.Combat.HPBefore = performanceInt(2000)
	h.HPAfter = performanceInt(2000 - loss)
	h.Combat.DamageFormula = &BattleDamageFormula{AttackCategory: category, Power: performanceNumber(600), AttackMultiplier: performanceNumber(1), DefenseMultiplier: performanceNumber(1), Reduction: performanceNumber(1), Effectiveness: performanceNumber(1), AttackerMonsterID: attackerID, DefenderMonsterID: defenderID, AttackerLevel: 60, DefenderLevel: 60, ModifiersVerified: true, SingleHit: true, HPLossVerified: true, Evidence: []string{"verified synthetic hit conditions"}}
	r.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 391), a, h}
	return r
}
func TestBattleInferenceAutomaticInitialHPConditionalAndPure(t *testing.T) {
	r := inferenceRecord()
	r.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 391), inferenceInitialHP("me", "a", 386)}
	before, _ := json.Marshal(r)
	view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) {
		t.Fatal("raw record mutated")
	}
	d := inferenceDecision(t, dto, "enemy", "b", "hp")
	if d.Status != "unique" || !d.ProfileApplied || len(d.Candidates) != 1 || d.Candidates[0].IV != 60 || d.Candidates[0].Nature != 0 {
		t.Fatalf("conditional HP: %+v", d)
	}
	p := view[0].Sides["enemy"].Pets[0]
	if p.IV["hp"].Condition != battleInferenceCondition || !strings.Contains(p.Nature["hp"].Evidence[0], "不证明") {
		t.Fatalf("assumption marker lost: %+v", p)
	}
	if err := ValidateBattleRecord(&view[0]); err != nil {
		t.Fatal(err)
	}
	if view[0].Sides["enemy"].Pets[0].IV["hp"].Condition != battleInferenceCondition {
		t.Fatal("validator stripped condition")
	}
	own := view[0].Sides["me"].Pets[0]
	if *own.IV["hp"].Value != 54 || own.IV["hp"].Certainty != "direct" {
		t.Fatal("actual own IV54 overwritten")
	}
	if view[0].Quality.Actions {
		t.Fatal("partial capture upgraded")
	}
	*view[0].Events[0].HPMax = 1
	view[0].Sides["me"].Pets[0].IV["hp"].Evidence[0] = "changed"
	after, _ = json.Marshal(r)
	if !bytes.Equal(before, after) {
		t.Fatal("nested pointers/maps/slices alias raw")
	}
}
func TestBattleInferenceAutomaticDamageDirectionsAndExactOwnIV(t *testing.T) {
	for _, category := range []string{"physical", "magic"} {
		for _, direction := range []string{"dealt", "received"} {
			t.Run(category+direction, func(t *testing.T) {
				r := inferenceDamageRecord(category, direction, 1)
				view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
				stat := "attack"
				if direction == "received" {
					stat = "defense"
				}
				if category == "magic" {
					stat = "magic_" + stat
				}
				d := inferenceDecision(t, dto, "enemy", "b", stat)
				if d.Status != "unique" || !d.ProfileApplied || d.Candidates[0].Nature != 1 {
					t.Fatalf("%s %+v", stat, d)
				}
				if *view[0].Sides["enemy"].Pets[0].IV[stat].Value != 60 {
					t.Fatal("conditional IV not applied")
				}
				if err := ValidateBattleRecord(&view[0]); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
func TestBattleInferenceUnknownDamageModifiersAndHPClipExcludeOnlyAttribute(t *testing.T) {
	cases := map[string]func(*BattleRecord){
		"missing formula":          func(r *BattleRecord) { r.Events[2].Combat.DamageFormula = nil },
		"buff unknown":             func(r *BattleRecord) { r.Events[2].Combat.DamageFormula.AttackMultiplier = nil },
		"unverified modifiers":     func(r *BattleRecord) { r.Events[2].Combat.DamageFormula.ModifiersVerified = false },
		"shield heal ambiguity":    func(r *BattleRecord) { r.Events[2].Combat.DamageFormula.HPLossVerified = false },
		"dynamic unverified power": func(r *BattleRecord) { r.Events[2].Combat.DamageFormula.Power = nil },
		"clipped HP0": func(r *BattleRecord) {
			r.Events[2].HPAfter = performanceInt(0)
			r.Events[2].HPChange = performanceInt(-2000)
		},
		"no actual hp":       func(r *BattleRecord) { r.Events[2].HPAfter = nil },
		"unknown own nature": func(r *BattleRecord) { delete(r.Sides["me"].Pets[0].Nature, "defense") },
		"form mismatch":      func(r *BattleRecord) { r.Events[2].Combat.DamageFormula.AttackerMonsterID = 3 },
		"multi hit":          func(r *BattleRecord) { h := r.Events[2]; h.ID = "second-hit"; r.Events = append(r.Events, h) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			r := inferenceDamageRecord("physical", "dealt", 0)
			change(&r)
			view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
			d := inferenceDecision(t, dto, "enemy", "b", "attack")
			if d.ProfileApplied || d.Status != "insufficient" {
				t.Fatalf("unsafe certainty: %+v", d)
			}
			if _, ok := view[0].Sides["enemy"].Pets[0].IV["attack"]; ok {
				t.Fatal("invalid attribute counted")
			}
			if !inferenceDecision(t, dto, "enemy", "b", "hp").ProfileApplied {
				t.Fatal("valid HP incorrectly excluded with damage")
			}
		})
	}
}
func TestBattleInferenceNoSolutionMultipleAndDirectNon60(t *testing.T) {
	r := inferenceRecord()
	r.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 999)}
	c := BattleConstraint{ID: "tiny", Side: "enemy", InstanceID: "b", Stat: "attack", Kind: "damageDealt", KnownStat: 1000, Power: 1, Damage: performanceInt(0), Level: 60, Reduction: 1, Effectiveness: 1, ModifiersKnown: true, Provenance: "verified exact weak single hit, no clip", Round: 1}
	r.Constraints = []BattleConstraint{c}
	view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	if d := inferenceDecision(t, dto, "enemy", "b", "hp"); d.Status != "no_solution" || d.ProfileApplied || !strings.Contains(d.Reason, "不证明") {
		t.Fatalf("no solution false claim: %+v", d)
	}
	if d := inferenceDecision(t, dto, "enemy", "b", "attack"); d.Status != "multiple" || len(d.Candidates) != 3 || d.ProfileApplied {
		t.Fatalf("multiple: %+v", d)
	}
	if len(view[0].Sides["enemy"].Pets[0].IV) > 0 {
		t.Fatal("fixed assumption IV60 alone became unique despite multiple natures")
	}
	r.Sides["enemy"].Pets[0].IV = map[string]BattleEvidence{"attack": {Value: performanceNumber(54), Certainty: "direct"}}
	view, dto = PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	if d := inferenceDecision(t, dto, "enemy", "b", "attack"); d.Status != "direct_non60" {
		t.Fatalf("non60: %+v", d)
	}
	if *view[0].Sides["enemy"].Pets[0].IV["attack"].Value != 54 {
		t.Fatal("direct fact replaced")
	}
}
func TestBattleInferenceDirectNatureNeverOverwrittenByConditionalFit(t *testing.T) {
	r := inferenceDamageRecord("physical", "dealt", 0)
	r.Sides["enemy"].Pets[0].Nature = map[string]BattleEvidence{"attack": {Value: performanceNumber(1), Certainty: "direct", Evidence: []string{"actual nature"}}}
	view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	d := inferenceDecision(t, dto, "enemy", "b", "attack")
	if d.Status != "no_solution" || d.ProfileApplied {
		t.Fatalf("direct nature ignored: %+v", d)
	}
	if !reflect.DeepEqual(view[0].Sides["enemy"].Pets[0].Nature["attack"], r.Sides["enemy"].Pets[0].Nature["attack"]) {
		t.Fatal("direct nature overwritten")
	}
	if _, ok := view[0].Sides["enemy"].Pets[0].IV["attack"]; ok {
		t.Fatal("failed assumption asserted IV")
	}
}

func TestBattleInferenceExactMathRounding(t *testing.T) {
	if got := battleInferenceStat(120, "attack", 0, 60, 69); got != 239 {
		t.Fatalf("178.5 rounds up: %d", got)
	}
	if got := battleInferenceStat(25, "attack", 0, 0, 8); got != 75 {
		t.Fatalf("14.5 rounds up: %d", got)
	}
	if got := battleInferenceDamage(41, 1, 1, 1, 1, 1, 1, 60); got != 37 {
		t.Fatalf("exact integer damage: %d", got)
	}
	if got := battleInferenceDamage(41, 1, 1, .1, .5, 1, 1, 60); got != 1 {
		t.Fatalf("final floor after decimal factors: %d", got)
	}
}
func inferenceSpeedRows(r *BattleRecord, known int, orders ...string) {
	for i, first := range orders {
		round := i + 1
		mi, ei := 0, 1
		if first == "enemy" {
			mi, ei = 1, 0
		}
		me := performanceSkill(fmt.Sprintf("me%d", i), "me", "a", "enemy", "b", round, true)
		me.Round = round
		me.ExecIndex = performanceInt(mi)
		me.SkillClass = "ordinary"
		en := performanceSkill(fmt.Sprintf("en%d", i), "enemy", "b", "me", "a", round, true)
		en.Round = round
		en.ExecIndex = performanceInt(ei)
		en.SkillClass = "ordinary"
		r.Events = append(r.Events, me, en)
		r.SpeedObservations = append(r.SpeedObservations, BattleSpeedObservation{ID: fmt.Sprintf("speed%d", i), Round: round, MeEvent: me.ID, EnemyEvent: en.ID, MeMonsterID: 1, EnemyMonsterID: 2, MeLevel: 60, EnemyLevel: 60, MeSpeed: known, MePriority: performanceInt(0), EnemyPriority: performanceInt(0), First: first, Conditions: "normal", PrioritiesVerified: true, SpeedConditionsVerified: true, Evidence: []string{"same frame exact ordering verified"}})
	}
}
func TestBattleInferenceSpeedKeepsTiesAndConditionalCohorts(t *testing.T) {
	r := inferenceRecord()
	inferenceSpeedRows(&r, 181, "me", "me")
	view, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	d := inferenceDecision(t, dto, "enemy", "b", "speed")
	if d.Status != "multiple" || d.ProfileApplied {
		t.Fatalf("two-order heuristic promoted: %+v", d)
	}
	tie := false
	for _, c := range d.Candidates {
		if c.Value == 181 {
			tie = true
		}
	}
	if !tie {
		t.Fatal("ties removed by repeated ordering")
	}
	if len(view[0].Sides["enemy"].Pets[0].IV) > 0 {
		t.Fatal("speed assumption applied")
	}
	r = inferenceRecord()
	inferenceSpeedRows(&r, 207, "enemy")
	view, dto = PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	d = inferenceDecision(t, dto, "enemy", "b", "speed")
	if d.Status != "unique" || !d.ProfileApplied || d.Candidates[0].IV != 60 || d.Condition != "" {
		t.Fatalf("strict boundary singleton: %+v", d)
	}
	r = inferenceRecord()
	inferenceSpeedRows(&r, 181, "me", "enemy")
	r.SpeedObservations[1].Conditions = "different-context"
	_, dto = PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	count := 0
	for _, d := range dto.Decisions {
		if d.Side == "enemy" && d.Stat == "speed" {
			count++
			if d.ProfileApplied {
				t.Fatal("changed conditions pooled")
			}
		}
	}
	if count != 2 {
		t.Fatalf("cohorts=%d", count)
	}
	r = inferenceRecord()
	inferenceSpeedRows(&r, 207, "enemy")
	r.Events[1].Seq++
	_, dto = PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	if inferenceDecision(t, dto, "enemy", "b", "speed").Status != "insufficient" {
		t.Fatal("different frames compared")
	}
}
func TestBattleInferenceInitialDirectSpeedAndDedup(t *testing.T) {
	r := inferenceRecord()
	r.Sides["enemy"].Pets[0].Speed = performanceInt(207)
	inferenceSpeedRows(&r, 50, "me")
	r.Events = append(r.Events, inferenceInitialHP("enemy", "b", 391), inferenceInitialHP("enemy", "b", 391))
	view, dto := PrepareBattleInference([]BattleRecord{r, r}, performanceCatalog(t))
	d := inferenceDecision(t, dto, "enemy", "b", "speed")
	if d.Status != "unique" || !d.ProfileApplied {
		t.Fatalf("direct recorded speed suppressed by weaker guess: %+v", d)
	}
	h := inferenceDecision(t, dto, "enemy", "b", "hp")
	if len(h.SourceIDs) != 1 {
		t.Fatal("duplicate observation counted twice")
	}
	stats := BuildBattleStats(view, nil)
	if stats.MatchedBattles != 1 || stats.Enemy[0].IVSamples["hp"] != 1 {
		t.Fatalf("duplicate battle/profile: %+v", stats)
	}
}
func TestBattleInferenceIgnoresLaterHPAndClearsStaleCondition(t *testing.T) {
	r := inferenceRecord()
	e := inferenceInitialHP("enemy", "b", 391)
	e.StateStage = "snapshot"
	e.Round = 1
	r.Events = []BattleEvent{e}
	_, dto := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	if inferenceDecision(t, dto, "enemy", "b", "hp").Status != "insufficient" {
		t.Fatal("late snapshot borrowed initial level")
	}
	r.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 391)}
	view, _ := PrepareBattleInference([]BattleRecord{r}, performanceCatalog(t))
	view[0].Events = nil
	again, dto := PrepareBattleInference(view, performanceCatalog(t))
	if len(again[0].Sides["enemy"].Pets[0].IV) > 0 {
		t.Fatal("stale derived HP survived missing evidence")
	}
	if inferenceDecision(t, dto, "enemy", "b", "hp").Status != "insufficient" {
		t.Fatal("stale decision")
	}
}
func TestBattleInferenceProfilesStayInArchetypeCohort(t *testing.T) {
	a := inferenceRecord()
	a.ID = "group-a"
	a.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 391)}
	b := inferenceRecord()
	b.ID = "group-b"
	s := b.Sides["enemy"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "c", MonsterID: 3, Level: performanceInt(60)})
	b.Sides["enemy"] = s
	b.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 449)} // positive HP nature for Q100, IV60
	view, _ := PrepareBattleInference([]BattleRecord{a, b}, performanceCatalog(t))
	rules := []BattleTeamRule{{ID: "pair", Name: "pair", MonsterIDs: []int{2, 3}}, {ID: "single", Name: "single", MonsterIDs: []int{2}}}
	stats := BuildBattleArchetypeStats(view, rules)
	for _, name := range []string{"pair", "single"} {
		team := archetypeTeam(t, stats, name)
		c := archetypeComponent(t, team, 2)
		wantSamples, wantNeutral, wantPositive := 2, 1, 1
		if name == "pair" {
			wantSamples, wantNeutral, wantPositive = 1, 0, 1
		}
		// Single matches both a and b under multi-label membership; pair only b.
		// Existing per-stat profile counts remain independent of the new chart.
		if c.Profile.IVSamples["hp"] != wantSamples || c.Profile.IVDistributions["hp"]["60"] != wantSamples || c.Profile.NatureSamples["hp"] != wantSamples || c.Profile.NatureDistributions["hp"]["0"] != wantNeutral || c.Profile.NatureDistributions["hp"]["1"] != wantPositive || c.Profile.ProfileSamples != wantSamples || c.Profile.UnknownProfiles != wantSamples || c.NatureSamples != wantSamples || c.NatureUnknown != wantSamples {
			t.Fatalf("profile leaked across cohort: %+v", c)
		}
	}
}
func TestBattleInferenceOptionalFrozenRecordAudit(t *testing.T) {
	// Opt-in only: CI and all regular tests use isolated synthetic fixtures. This
	// read-only audit never discovers or opens the user's live battle database.
	path := os.Getenv("BATTLE_INFERENCE_AUDIT_RECORD")
	if path == "" {
		t.Skip("optional frozen audit")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var r BattleRecord
	if err = json.Unmarshal(raw, &r); err != nil {
		t.Fatal(err)
	}
	cat, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(r)
	view, dto := PrepareBattleInference([]BattleRecord{r}, cat)
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) {
		t.Fatal("audit mutated frozen data")
	}
	n := 0
	for _, d := range dto.Decisions {
		if d.Side == "enemy" && d.ProfileApplied {
			if d.Stat != "hp" {
				t.Fatalf("unexpected actual inference %+v", d)
			}
			n++
		}
	}
	if n != 6 {
		t.Fatalf("expected six conditional initial HP attributes, got %d", n)
	}
	if !reflect.DeepEqual(view[0].Sides["me"], r.Sides["me"]) {
		t.Fatal("direct own configuration changed")
	}
	if view[0].Quality.Actions {
		t.Fatal("actual action coverage promoted")
	}
	if out := os.Getenv("BATTLE_INFERENCE_AUDIT_OUTPUT"); out != "" {
		b, _ := json.MarshalIndent(dto, "", "  ")
		if err = os.WriteFile(out, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
