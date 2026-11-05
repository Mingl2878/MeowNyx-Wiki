package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
)

func confirmedSkillExpectations() map[string]int {
	return map[string]int{"705021100": 164, "713022100": 444, "704018100": 132, "709013100": 213, "702078100": 12, "702111100": 74, "707027100": 491, "715011100": 356, "705020100": 163, "705027100": 161, "712009100": 283, "705026100": 148}
}
func confirmedCatalogBytes(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func confirmedStun(side, actor string) BattleEvent {
	return BattleEvent{ID: "stun:" + side, Kind: "skill", Phase: "executed", SkillClass: "ordinary", ProtocolSkillID: "700001200", Side: side, Actor: actor, Target: actor, TargetSide: side, Round: 1, Seq: 5, ExecIndex: performanceInt(2)}
}

func TestBattleUserConfirmedWhitelistExactAndFailClosed(t *testing.T) {
	data := []byte(battleUserConfirmedSkillsJSON)
	table, err := battleUserConfirmedDecode(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(table.skills, confirmedSkillExpectations()) || !reflect.DeepEqual(table.noOps, map[string]bool{"700001200": true}) {
		t.Fatal("not the exact final user confirmations")
	}
	var doc battleUserConfirmedSkillDocument
	if err = json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Source != "user_confirmed" || doc.ConfirmedAt != "2026-11-03" || !strings.Contains(doc.Policy, "not independently proven") {
		t.Fatal("confirmation incorrectly presented as static proof")
	}
	for runtime, local := range confirmedSkillExpectations() {
		if battleUserConfirmedSkillLocal(runtime) != local || battleStreamSkillLocal(runtime) != 0 {
			t.Fatal("runtime/config namespaces mixed", runtime)
		}
		for _, other := range []string{runtime[:len(runtime)-1] + "1", runtime[:len(runtime)-1], "0" + runtime, " " + runtime, runtime + "0"} {
			if battleUserConfirmedSkillLocal(other) != 0 {
				t.Fatal("guessed neighboring/malformed runtime", other)
			}
		}
	}
	mutations := map[string][]byte{
		"unknownVersion":   bytes.Replace(data, []byte(`"version": 1`), []byte(`"version": 2`), 1),
		"unknownField":     bytes.Replace(data, []byte(`"version": 1`), []byte(`"extra":true,"version": 1`), 1),
		"duplicateField":   bytes.Replace(data, []byte(`"version": 1`), []byte(`"version":1,"version": 1`), 1),
		"wrongProvenance":  bytes.ReplaceAll(data, []byte("user_confirmed"), []byte("static_proof")),
		"unknownRuntime":   bytes.Replace(data, []byte("705021100"), []byte("705021101"), 1),
		"duplicateRuntime": bytes.Replace(data, []byte("713022100"), []byte("705021100"), 1),
		"wrongStableID":    bytes.Replace(data, []byte(`"localSkillId":12,`), []byte(`"localSkillId":13,`), 1),
		"unknownDate":      bytes.ReplaceAll(data, []byte("2026-11-03"), []byte("2026-11-04")),
		"trailing":         append(append([]byte(nil), data...), []byte(`{}`)...),
		"null":             []byte(`null`),
	}
	for name, b := range mutations {
		t.Run(name, func(t *testing.T) {
			if x, err := battleUserConfirmedDecode(b); err == nil || x != nil {
				t.Fatal("corrupt whitelist accepted")
			}
		})
	}
	// The old frozen proof still has exactly 503 independently reviewed entries.
	old, err := battleStreamSkillDecode([]byte(battleStreamSkillProofJSON))
	if err != nil || len(old) != 503 {
		t.Fatal("reviewed503 changed", len(old), err)
	}
	b, err := os.ReadFile("data/battle-protocol-skills.json")
	if err != nil || !bytes.Equal(b, []byte(battleStreamSkillProofJSON)) {
		t.Fatal("embedded503 differs", err)
	}
}

func TestBattleUserConfirmedIdentityOnlyProvenanceAndConflicts(t *testing.T) {
	b := confirmedCatalogBytes(t)
	identities, err := battleReadIdentityMap(b)
	if err != nil {
		t.Fatal(err)
	}
	// Renaming a live skill never rematches its stable identity.
	c, err := catalog.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	for i := range c.Skills {
		if c.Skills[i].ID == 12 {
			c.Skills[i].Name = "重命名的稳定技能"
		}
	}
	renamed, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	identities, err = battleReadIdentityMap(renamed)
	if err != nil {
		t.Fatal(err)
	}
	for runtime, local := range confirmedSkillExpectations() {
		for _, class := range []string{"", "ordinary", "response", "unknown"} {
			for _, phase := range []string{"executed", "interrupted", "selection"} {
				before := BattleEvent{ID: "original", Kind: "skill", Phase: phase, ProtocolSkillID: runtime, SkillClass: class, Label: "原始标签", Round: 3, Seq: 9, ExecIndex: performanceInt(2)}
				r := BattleRecord{Source: "original-source", Events: []BattleEvent{before}}
				if err := identities.apply(&r, true); err != nil {
					t.Fatal(err)
				}
				before.SkillID = local
				if !reflect.DeepEqual(before, r.Events[0]) {
					t.Fatal("changed facts beyond missing local identity", runtime, r.Events[0])
				}
				if err := identities.apply(&r, true); err != nil || !reflect.DeepEqual(before, r.Events[0]) {
					t.Fatal("not idempotent", err)
				}
			}
		}
		for _, class := range []string{"passive", "system"} {
			e := BattleEvent{ID: "effect", Kind: "effect", Phase: "executed", SkillClass: class, ProtocolSkillID: runtime}
			r := BattleRecord{Events: []BattleEvent{e}}
			if err := identities.apply(&r, false); err != nil || !reflect.DeepEqual(e, r.Events[0]) {
				t.Fatal("ordinary identity leaked into system/passive", err)
			}
		}
	}
	for name, e := range map[string]BattleEvent{
		"knownLocal":   {Kind: "skill", Phase: "executed", ProtocolSkillID: "702078100", SkillID: 13},
		"directConfig": {Kind: "skill", Phase: "executed", ProtocolSkillID: "702078100", ProtocolSkillConfigID: "7050320"},
		"stunLocal":    {Kind: "skill", Phase: "executed", ProtocolSkillID: "700001200", SkillID: 12},
		"stunDirect":   {Kind: "skill", Phase: "executed", ProtocolSkillID: "700001200", ProtocolSkillConfigID: "7050320"},
		"stunWish":     {Kind: "skill", Phase: "executed", ProtocolSkillID: "700001200", Combat: &BattleCombatEvidence{ActionKind: "wishImpact"}},
	} {
		t.Run(name, func(t *testing.T) {
			before := e
			if battleApplyUserConfirmedSkill(&e, identities.skills) == nil || !reflect.DeepEqual(before, e) {
				t.Fatal("conflict overwritten")
			}
			if battleValidateActionFields(&e) == nil {
				t.Fatal("conflict passed validation")
			}
		})
	}
	e := BattleEvent{Kind: "skill", Phase: "executed", ProtocolSkillID: "705021100", ProtocolSkillConfigID: "7050211", Label: "unknown direct config is retained"}
	before := e
	if err := battleApplyUserConfirmedSkill(&e, identities.skills); err != nil {
		t.Fatal(err)
	}
	before.SkillID = 164
	if !reflect.DeepEqual(before, e) {
		t.Fatal("base configuration overwritten")
	}
	// Missing current IDs never rematch by name or erase known historical IDs.
	e = BattleEvent{Kind: "skill", Phase: "executed", ProtocolSkillID: "705021100"}
	if err := battleApplyUserConfirmedSkill(&e, map[int]bool{}); err != nil || e.SkillID != 0 {
		t.Fatal("nonexistent target mapped", err)
	}
	e.SkillID = 164
	if err := battleApplyUserConfirmedSkill(&e, map[int]bool{}); err != nil || e.SkillID != 164 {
		t.Fatal("known historical ID erased", err)
	}
}

func TestBattleUserConfirmedAssemblerMappingNoOpAndAtomicConflict(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	seq := 1
	for runtime := range confirmedSkillExpectations() {
		n, _ := strconv.Atoi(runtime)
		liveTestPush(t, a, liveTestCommand(seq, liveTestCast(0, 1, n)))
		seq++
	}
	liveTestPush(t, a, liveTestCommand(seq, liveTestCast(0, 1, 705021101)))
	seq++
	for _, class := range []int{1, 2} {
		cast := liveTestCast(0, 1, 700001200)
		cast["skill_cast"].(map[string]any)["type"] = class
		liveTestPush(t, a, liveTestCommand(seq, cast))
		seq++
	}
	r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	n, noOps := 0, 0
	for _, e := range r.Events {
		if local := confirmedSkillExpectations()[e.ProtocolSkillID]; local > 0 && e.Kind == "skill" {
			n++
			if e.SkillID != local || e.ProtocolSkillConfigID != "" || e.EnergyCost != nil {
				t.Fatal("mapping fabricated config/cost", e)
			}
		}
		if e.ProtocolSkillID == "705021101" && e.SkillID != 0 {
			t.Fatal("neighbor mapped")
		}
		if battleIsStunSkip(e) {
			noOps++
			if e.Kind != "skill" || e.SkillClass != "ordinary" || e.Phase != "executed" || e.EnergyCost != nil || e.Combat != nil {
				t.Fatal("stun source rewritten", e)
			}
		}
	}
	if n != 12 || noOps != 1 {
		t.Fatal("missing exact mappings/no-op", n, noOps)
	}
	for _, runtime := range []int{702078100, 700001200} {
		a = NewBattleStreamAssembler()
		liveTestPush(t, a, liveTestStart("124"))
		liveTestPush(t, a, liveAliasBinding(runtime, 7050320))
		liveTestPush(t, a, liveTestCommand(5, liveTestCast(0, 1, runtime)))
		liveAliasRejectAtomic(t, a, liveTestFinish("124", 12, 0))
	}
	// Even an explicit preceding energy-cost observation cannot create stun cost.
	s := battleLiveNewState("cost")
	stun := confirmedStun("me", "a")
	r = BattleRecord{Events: []BattleEvent{stun}}
	s.Costs["cost"] = battleLiveCost{Actor: "a", Skill: "700001200", Round: 1, Seq: 1, Index: 0, Cost: performanceInt(3)}
	if err := s.enrichFinal(&r); err != nil || r.Events[0].EnergyCost != nil || !reflect.DeepEqual(stun, r.Events[0]) {
		t.Fatal("inferred cost for no-op", err, r.Events)
	}
}

func TestBattleUserConfirmedStunPredicateAndDerivedViews(t *testing.T) {
	e := confirmedStun("me", "a")
	for _, phase := range []string{"executed", "interrupted"} {
		for _, class := range []string{"", "unknown", "ordinary", "response"} {
			x := e
			x.Phase = phase
			x.SkillClass = class
			if !battleIsStunSkip(x) {
				t.Fatal("valid no-op not recognized", phase, class)
			}
		}
	}
	for name, mutate := range map[string]func(*BattleEvent){
		"positiveLocal": func(x *BattleEvent) { x.SkillID = 12 }, "neighbor": func(x *BattleEvent) { x.ProtocolSkillID = "700001201" }, "truncated": func(x *BattleEvent) { x.ProtocolSkillID = "7000012" }, "charge": func(x *BattleEvent) { x.ProtocolSkillID = "700001000" }, "resource": func(x *BattleEvent) { x.Kind = "resource" }, "passive": func(x *BattleEvent) { x.Kind = "effect"; x.SkillClass = "passive" }, "system": func(x *BattleEvent) { x.Kind = "effect"; x.SkillClass = "system" }, "preview": func(x *BattleEvent) { x.Phase = "preview" }, "unknownPhase": func(x *BattleEvent) { x.Phase = "unknown" },
	} {
		t.Run(name, func(t *testing.T) {
			x := e
			mutate(&x)
			if battleIsStunSkip(x) {
				t.Fatal("unconfirmed no-op guessed")
			}
		})
	}
	cat := performanceCatalog(t)
	baseline := performanceRecord("stun-derived")
	baseline.Events = []BattleEvent{performanceSkill("known-me", "me", "a", "enemy", "b", 1, true), performanceSkill("known-enemy", "enemy", "b", "me", "a", 2, true)}
	if err := ValidateBattleRecord(&baseline); err != nil {
		t.Fatal(err)
	}
	with, _ := battleClone(baseline)
	for _, who := range []struct{ side, actor string }{{"me", "a"}, {"enemy", "b"}} {
		stun := confirmedStun(who.side, who.actor)
		stun.EnergyCost = performanceInt(3)
		stun.Combat = &BattleCombatEvidence{IsAttack: performanceBool(true), ResponseAttempt: performanceBool(true)}
		with.Events = append(with.Events, stun)
	}
	before, _ := json.Marshal(with)
	if err := ValidateBattleRecord(&with); err != nil || !with.Quality.Actions {
		t.Fatal("no-op treated as unknown executed skill", err)
	}
	after, _ := json.Marshal(with)
	if !bytes.Equal(before, after) {
		t.Fatal("raw no-op/quality changed")
	}
	for _, side := range []string{"me", "enemy"} {
		if !reflect.DeepEqual(battleSideSkillUsage(baseline, side), battleSideSkillUsage(with, side)) {
			t.Fatal("usage numerator/denominator includes no-op", side)
		}
		acc := battleSelfSkillAccumulator{}
		acc.add(battleSideSkillUsage(with, side))
		for _, row := range acc.stats() {
			if row.Casts != 1 || row.TotalCasts != 1 {
				t.Fatal("usage denominator polluted", row)
			}
		}
	}
	if !reflect.DeepEqual(BuildBattleStats([]BattleRecord{baseline}, nil), BuildBattleStats([]BattleRecord{with}, nil)) {
		t.Fatal("shared statistics changed for no-op")
	}
	if !reflect.DeepEqual(BuildBattlePerformance([]BattleRecord{baseline}, cat), BuildBattlePerformance([]BattleRecord{with}, cat)) || !reflect.DeepEqual(BuildBattleEnemyPerformance([]BattleRecord{baseline}, cat), BuildBattleEnemyPerformance([]BattleRecord{with}, cat)) {
		t.Fatal("stun affected performance actions/attempts/classification")
	}
	if !reflect.DeepEqual(BuildBattleGrowthStats([]BattleRecord{baseline}, cat), BuildBattleGrowthStats([]BattleRecord{with}, cat)) {
		t.Fatal("stun inferred growth")
	}
	for _, stun := range with.Events[2:] {
		if battlePerformanceIsAction(stun) || battleGrowthIsUse(stun) {
			t.Fatal("no-op is eligible action/use")
		}
		pc := battlePerformanceReadCatalog(cat)
		if attack, known, _ := pc.attack(stun); attack || !known {
			t.Fatal("no-op inferred attack")
		}
		if response, known, _ := pc.response(stun); response || !known {
			t.Fatal("no-op inferred response")
		}
		if pc.category(stun, true, true) != "" {
			t.Fatal("no-op category inferred")
		}
	}
	// An unrelated ordinary unknown stays present and remains explicitly unknown.
	for _, who := range []struct {
		side, actor string
		species     int
	}{{"me", "a", 1}, {"enemy", "b", 2}} {
		unknown := confirmedStun(who.side, who.actor)
		unknown.ID = "unknown:" + who.side
		unknown.ProtocolSkillID = "700001201"
		unknown.Seq = 7
		r, _ := battleClone(with)
		r.Events = append(r.Events, unknown)
		if err := ValidateBattleRecord(&r); err != nil || r.Quality.Actions {
			t.Fatal("ordinary unknown hidden", err)
		}
		var p *BattlePerformance
		if who.side == "me" {
			p = BuildBattlePerformance([]BattleRecord{r}, cat)
		} else {
			p = BuildBattleEnemyPerformance([]BattleRecord{r}, cat)
		}
		row := performanceSpecies(t, p, who.species)
		if row.Coverage.AttackClassificationUnknown != 1 || row.Coverage.ResponseCapabilityUnknown != 1 || row.Totals.AttackActions != 1 || row.Totals.AttackAttempts != 1 || row.Totals.StatusActions != 0 || row.Totals.DefenseActions != 0 {
			t.Fatal("no-op/ordinary unknown classification conflated", row)
		}
	}
	final, _ := json.Marshal(with)
	if !bytes.Equal(before, final) {
		t.Fatal("derived views mutated raw record")
	}
}

func TestBattleUserConfirmedStunKeepsMeasuredEffectsWithoutOffensiveActions(t *testing.T) {
	cat := performanceCatalog(t)
	for _, side := range []string{"me", "enemy"} {
		actor, target, opposite, sourceSpecies, targetSpecies := "a", "b", "enemy", 1, 2
		if side == "enemy" {
			actor, target, opposite, sourceSpecies, targetSpecies = "b", "a", "me", 2, 1
		}
		r := performanceRecord("no-op-effects:" + side)
		stun := confirmedStun(side, actor)
		stun.Combat = &BattleCombatEvidence{IsAttack: performanceBool(true)}
		hit := performanceHit("measured", stun.ID, side, actor, opposite, target, 6, 0, 20, "advantage")
		resource := BattleEvent{ID: "actual-energy", Kind: "resource", Phase: "executed", Side: side, Actor: actor, Round: 1, Seq: 6, ExecIndex: performanceInt(1), EnergyChange: performanceInt(-3), EnergyAfter: performanceInt(7)}
		defense := performanceSkill("defense", opposite, target, side, actor, 7, false)
		defense.SkillID, defense.SkillClass = 12, "response"
		defense.Combat = &BattleCombatEvidence{ResponseAttempt: performanceBool(true), CounteredActionID: stun.ID}
		r.Events = []BattleEvent{stun, hit, resource, defense}
		before, _ := json.Marshal(r)
		performanceValid(t, r)
		var src, dst *BattlePerformance
		if side == "me" {
			src, dst = BuildBattlePerformance([]BattleRecord{r}, cat), BuildBattleEnemyPerformance([]BattleRecord{r}, cat)
		} else {
			src, dst = BuildBattleEnemyPerformance([]BattleRecord{r}, cat), BuildBattlePerformance([]BattleRecord{r}, cat)
		}
		a, b := performanceSpecies(t, src, sourceSpecies), performanceSpecies(t, dst, targetSpecies)
		if a.Totals.AttackActions != 0 || a.Totals.AttackAttempts != 0 || a.Totals.CounteredActions != 0 || a.Totals.OutgoingAdvantage != 0 || a.Totals.StatusActions != 0 || a.Totals.DefenseActions != 0 || a.Coverage.AttackClassificationUnknown != 0 || a.Coverage.ResponseCapabilityUnknown != 0 {
			t.Fatal("no-op became action/unknown/offensive eligibility", a)
		}
		if a.Totals.DamageDealt.Actual != 20 || b.Totals.DamageReceived.Actual != 20 || b.Totals.ReceivedActions != 0 || b.Totals.DefenseSuccess != 0 {
			t.Fatal("measured effects lost or no-op became a received attack", a, b)
		}
		after, _ := json.Marshal(r)
		if !bytes.Equal(before, after) {
			t.Fatal("effect/history/resource facts changed")
		}
	}
	// The direct-config provisional cleanup must not erase a user-confirmed ID.
	r := BattleRecord{Source: "rkpp-live-v1", Events: []BattleEvent{{ID: "known", Kind: "skill", Phase: "executed", ProtocolSkillID: "705027100", ProtocolSkillConfigID: "7050270", SkillID: 161}}}
	m := &battleIdentityMap{skills: map[int]bool{}, monsters: map[string]int{}}
	if err := m.apply(&r, false); err != nil || r.Events[0].SkillID != 161 {
		t.Fatal("user-confirmed positive identity erased", err)
	}
}

// Explicit normalized snapshot opt-in; no actual DB, API, capture or app access.
// Every write, including fixture seeding, is confined to t.TempDir().
func TestBattleUserConfirmedCurrentSevenSnapshotTempDB(t *testing.T) {
	path := os.Getenv("BATTLE_USER_CONFIRMED_SNAPSHOT")
	if path == "" {
		t.Skip("explicit current seven normalized snapshot path required")
	}
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Version int            `json:"version"`
		Records []BattleRecord `json:"records"`
	}
	if err = json.Unmarshal(source, &fixture); err != nil || fixture.Version != 1 || len(fixture.Records) != 7 {
		t.Fatal("requires current seven snapshot", err)
	}
	temp := t.TempDir()
	copied := filepath.Join(temp, "records-before.json")
	if err = os.WriteFile(copied, source, 0600); err != nil {
		t.Fatal(err)
	}
	catalogData := confirmedCatalogBytes(t)
	s, err := NewBattleService(filepath.Join(temp, "records.sqlite"), func() ([]byte, error) { return append([]byte(nil), catalogData...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err = s.List(ctx, BattleFilter{}, 1, 100); err != nil {
		t.Fatal(err)
	}
	before := map[string][]byte{}
	for _, r := range fixture.Records {
		raw, _ := json.Marshal(r)
		before[r.ID] = raw
		if _, err = s.db.ExecContext(ctx, "INSERT INTO battles(id,started_at,outcome,record_json) VALUES(?,?,?,?)", r.ID, r.StartedAt, r.Outcome, string(raw)); err != nil {
			t.Fatal(err)
		}
	}
	// Read-only stats already recognize the raw stun without rewriting its bytes.
	if _, err = s.Stats(ctx, BattleFilter{}); err != nil {
		t.Fatal(err)
	}
	for id, raw := range before {
		var stored string
		if err = s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", id).Scan(&stored); err != nil || stored != string(raw) {
			t.Fatal("stats rewrote history", id, err)
		}
	}
	result, err := s.Import(ctx, fixture.Records)
	if err != nil {
		t.Fatal(err)
	}
	changes, noOps := 0, 0
	afterByID := map[string][]byte{}
	var derivedRecords []BattleRecord
	for _, old := range fixture.Records {
		var stored string
		if err = s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", old.ID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		var got BattleRecord
		if err = json.Unmarshal([]byte(stored), &got); err != nil {
			t.Fatal(err)
		}
		want, _ := battleClone(old)
		for i := range want.Events {
			e := &want.Events[i]
			if local := confirmedSkillExpectations()[e.ProtocolSkillID]; local > 0 && e.SkillID == 0 && battleUserConfirmedSkillEvent(*e) {
				e.SkillID = local
				changes++
			}
		}
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("snapshot facts changed beyond missing SkillIDs: %s", old.ID)
		}
		for _, e := range got.Events {
			if battleIsStunSkip(e) {
				noOps++
				if got.ID != "rkpp:2306377934505522485" || e.ID != "rkpp:2306377934505522485:live:15:83:2:cast:1" || e.Round != 15 || e.Seq != 83 || e.ExecIndex == nil || *e.ExecIndex != 2 || e.Actor != "1" || e.Target != "1" || e.Side != "enemy" || e.TargetSide != "enemy" || e.Kind != "skill" || e.Phase != "executed" || e.SkillClass != "ordinary" || e.SkillID != 0 {
					t.Fatal("actual stun source changed", e)
				}
			}
		}
		afterByID[old.ID] = []byte(stored)
		derivedRecords = append(derivedRecords, got)
	}
	// A fresh snapshot may already contain the completed user-confirmed
	// enrichment. Both states must preserve all other facts and the raw no-op.
	if (changes != 26 && changes != 0) || noOps != 1 {
		t.Fatal("wrong current snapshot deltas", changes, noOps)
	}
	if changes == 0 && (result.Imported != 0 || result.Updated != 0 || result.Duplicates != 7) {
		t.Fatal("enriched snapshot should replay without a rewrite", result)
	}
	// A test-only control omits the single no-op. Every action-based derived
	// projection must be identical; the real records/database retain the event.
	var control []BattleRecord
	for _, r := range derivedRecords {
		copy, _ := battleClone(r)
		kept := []BattleEvent{}
		for _, e := range copy.Events {
			if !battleIsStunSkip(e) {
				kept = append(kept, e)
			}
		}
		copy.Events = kept
		control = append(control, copy)
	}
	if !reflect.DeepEqual(BuildBattleStats(derivedRecords, nil), BuildBattleStats(control, nil)) || !reflect.DeepEqual(BuildBattlePerformance(derivedRecords, catalogData), BuildBattlePerformance(control, catalogData)) || !reflect.DeepEqual(BuildBattleEnemyPerformance(derivedRecords, catalogData), BuildBattleEnemyPerformance(control, catalogData)) || !reflect.DeepEqual(BuildBattleGrowthStats(derivedRecords, catalogData), BuildBattleGrowthStats(control, catalogData)) {
		t.Fatal("actual stun counted in derived skill/action/performance/growth views")
	}
	if _, err = s.Stats(ctx, BattleFilter{}); err != nil {
		t.Fatal(err)
	}
	again, err := s.Import(ctx, fixture.Records)
	if err != nil || again.Imported != 0 || again.Duplicates != 7 {
		t.Fatal("reimport not idempotent", again, err)
	}
	for id, raw := range afterByID {
		var stored string
		if err = s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", id).Scan(&stored); err != nil || stored != string(raw) {
			t.Fatal("repeat/read altered raw facts", id, err)
		}
	}
	end, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(source, end) {
		t.Fatal("source snapshot changed", err)
	}
	t.Logf("sourceSHA256=%x records=7 addedSkillIDs=%d derivedNoOps=%d import=%+v; no other stored facts changed", sha256.Sum256(source), changes, noOps, result)
}
