package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func cbPtr[T any](v T) *T { return &v }
func cbFixture() BattleRecord {
	return BattleRecord{Version: 1, ID: "combat:test", Mode: "pvp", Outcome: "win", Rounds: 1, Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": true, "enemy": true}}, Sides: map[string]BattleSide{
		"me": {Pets: []BattlePet{{InstanceID: "a", MonsterID: 348, Level: cbPtr(60)}}, Lead: "a"}, "enemy": {Pets: []BattlePet{{InstanceID: "b", MonsterID: 132, Level: cbPtr(60)}}, Lead: "b"}}, Events: []BattleEvent{
		{ID: "cast", Round: 1, Seq: 1, ExecIndex: cbPtr(0), Kind: "skill", Phase: "executed", SkillClass: "ordinary", Side: "me", Actor: "a", Target: "b", TargetSide: "enemy", SkillID: 1, Combat: &BattleCombatEvidence{IsAttack: cbPtr(true), ResponseAttempt: cbPtr(false)}},
		{ID: "counter", Round: 1, Seq: 1, ExecIndex: cbPtr(1), Kind: "skill", Phase: "executed", SkillClass: "response", Side: "enemy", Actor: "b", Target: "b", TargetSide: "enemy", SkillID: 74, Combat: &BattleCombatEvidence{IsAttack: cbPtr(false), ResponseAttempt: cbPtr(true), CounteredActionID: "cast"}},
		{ID: "damage", Round: 1, Seq: 1, ExecIndex: cbPtr(2), Kind: "damage", Phase: "executed", Side: "me", Actor: "a", Target: "b", TargetSide: "enemy", Amount: cbPtr(642.0), HPChange: cbPtr(-100), HPAfter: cbPtr(0), Combat: &BattleCombatEvidence{ActionID: "cast", EffectivenessClass: "advantage", HPBefore: cbPtr(100), FullHPBefore: cbPtr(true)}},
		{ID: "defeat", Round: 1, Seq: 1, ExecIndex: cbPtr(3), Kind: "effect", Phase: "executed", Side: "enemy", Actor: "b", Combat: &BattleCombatEvidence{ActionID: "cast", LeaveReason: "defeat"}},
	}}
}
func cbJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestBattleCombatEvidenceValidation(t *testing.T) {
	r := cbFixture()
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	tests := map[string]func(*BattleRecord){
		"unknown class":          func(r *BattleRecord) { r.Events[2].Combat.EffectivenessClass = "normal" },
		"contradictory class":    func(r *BattleRecord) { r.Events[2].Combat.Effectiveness = cbPtr(0.5) },
		"negative effectiveness": func(r *BattleRecord) { r.Events[2].Combat.Effectiveness = cbPtr(-1.0) },
		"infinite effectiveness": func(r *BattleRecord) { r.Events[2].Combat.Effectiveness = cbPtr(math.Inf(1)) },
		"huge effectiveness":     func(r *BattleRecord) { r.Events[2].Combat.Effectiveness = cbPtr(65.0) },
		"negative before":        func(r *BattleRecord) { r.Events[2].Combat.HPBefore = cbPtr(-1) },
		"before conflicts delta": func(r *BattleRecord) { r.Events[2].Combat.HPBefore = cbPtr(150) },
		"zero full HP":           func(r *BattleRecord) { r.Events[2].Combat.HPBefore = cbPtr(0) },
		"effectiveness on cast":  func(r *BattleRecord) { r.Events[0].Combat.EffectivenessClass = "usual" },
		"attack on damage":       func(r *BattleRecord) { r.Events[2].Combat.IsAttack = cbPtr(true) },
		"attempt on damage":      func(r *BattleRecord) { r.Events[2].Combat.ResponseAttempt = cbPtr(true) },
		"response not attempt":   func(r *BattleRecord) { r.Events[1].Combat.ResponseAttempt = cbPtr(false) },
		"unknown source":         func(r *BattleRecord) { r.Events[2].Combat.ActionID = "absent" },
		"self source":            func(r *BattleRecord) { r.Events[2].Combat.ActionID = "damage" },
		"future source":          func(r *BattleRecord) { r.Events[0].ExecIndex = cbPtr(5) },
		"wrong caster":           func(r *BattleRecord) { r.Events[2].Actor = "absent" },
		"wrong target":           func(r *BattleRecord) { r.Events[2].Target = "absent" },
		"unknown counter target": func(r *BattleRecord) { r.Events[1].Combat.CounteredActionID = "absent" },
		"same side counter":      func(r *BattleRecord) { r.Events[1].Side = "me"; r.Events[1].Actor = "a" },
		"counter preview":        func(r *BattleRecord) { r.Events[1].Phase = "preview" },
		"wrong counter round":    func(r *BattleRecord) { r.Events[1].Round = 2 },
		"unknown leave reason":   func(r *BattleRecord) { r.Events[3].Combat.LeaveReason = "wind" },
		"forced on non-switch":   func(r *BattleRecord) { r.Events[3].Combat.LeaveReason = "forced" },
		"counter cycle": func(r *BattleRecord) {
			r.Events[0].SkillClass = "response"
			r.Events[0].Combat.ResponseAttempt = cbPtr(true)
			r.Events[0].Combat.CounteredActionID = "counter"
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			r := cbFixture()
			mutate(&r)
			if ValidateBattleRecord(&r) == nil {
				t.Fatal("accepted invalid evidence")
			}
		})
	}
}
func TestBattleCombatEvidenceExactZeroAndFalse(t *testing.T) {
	r := cbFixture()
	c := r.Events[2].Combat
	c.Effectiveness = cbPtr(0.0)
	c.EffectivenessClass = "resisted"
	c.FullHPBefore = cbPtr(false)
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	clone, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	if clone.Events[0].Combat.ResponseAttempt == nil || *clone.Events[0].Combat.ResponseAttempt || clone.Events[2].Combat.Effectiveness == nil || *clone.Events[2].Combat.Effectiveness != 0 || clone.Events[2].Combat.FullHPBefore == nil || *clone.Events[2].Combat.FullHPBefore {
		t.Fatal("lost explicit false/zero")
	}
	// After-event maximum may differ from pre-hit maximum. Do not reject valid full-before evidence.
	r = cbFixture()
	r.Events[2].HPMax = cbPtr(80)
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
}
func TestBattleCombatAdditiveMergeAtomicAndDetached(t *testing.T) {
	enriched := cbFixture()
	bare, _ := battleClone(enriched)
	for i := range bare.Events {
		bare.Events[i].Combat = nil
	}
	a0, b0 := cbJSON(bare), cbJSON(enriched)
	merged, err := MergeBattleRecord(bare, enriched)
	if err != nil {
		t.Fatal(err)
	}
	again, err := MergeBattleRecord(merged, enriched)
	if err != nil || cbJSON(again) != cbJSON(merged) {
		t.Fatalf("non-idempotent: %v", err)
	}
	reverse, err := MergeBattleRecord(enriched, bare)
	if err != nil || cbJSON(reverse) != cbJSON(merged) {
		t.Fatalf("asymmetric: %v", err)
	}
	if cbJSON(bare) != a0 || cbJSON(enriched) != b0 {
		t.Fatal("mutated caller")
	}
	*merged.Events[0].Combat.IsAttack = false
	if !*enriched.Events[0].Combat.IsAttack {
		t.Fatal("aliased caller pointer")
	}
	bad, _ := battleClone(enriched)
	bad.Events[0].Combat.IsAttack = cbPtr(false)
	if _, err := MergeBattleRecord(enriched, bad); err == nil {
		t.Fatal("overwrote known classification")
	}
	if cbJSON(enriched) != b0 {
		t.Fatal("conflict mutated original")
	}
}
func TestBattleCombatDefeatSwitchRequiresOutgoingInstance(t *testing.T) {
	r := cbFixture()
	s := r.Sides["enemy"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "c", MonsterID: 485})
	r.Sides["enemy"] = s
	r.Events = append(r.Events, BattleEvent{ID: "replacement", Round: 1, Seq: 2, ExecIndex: cbPtr(0), Kind: "switch", Phase: "executed", Side: "enemy", Actor: "c", Target: "b", Combat: &BattleCombatEvidence{LeaveReason: "defeat", ActionID: "cast"}})
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	r.Events[len(r.Events)-1].Target = ""
	if ValidateBattleRecord(&r) == nil {
		t.Fatal("accepted defeat of an unspecified outgoing actor")
	}
}
func TestBattleCombatActualEnrichment(t *testing.T) {
	input, before, dbfile, catfile := os.Getenv("XHM_COMBAT_INPUT"), os.Getenv("XHM_COMBAT_BEFORE"), os.Getenv("XHM_COMBAT_DB"), os.Getenv("XHM_COMBAT_CATALOG")
	if input == "" || before == "" || dbfile == "" || catfile == "" {
		t.Skip("explicit actual-fixture opt-in")
	}
	inputs := map[string][]byte{}
	for _, p := range []string{input, before, dbfile, catfile} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		inputs[p] = b
	}
	var old BattleRecord
	if err := json.Unmarshal(inputs[before], &old); err != nil {
		t.Fatal(err)
	}
	parsed, _, err := DecodeBattleImport(inputs[input])
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != 1 {
		t.Fatal("expected one candidate")
	}
	candidate := parsed[0]
	stripped, _ := battleClone(candidate)
	for i := range stripped.Events {
		stripped.Events[i].Combat = nil
	}
	expectedOld, _ := battleClone(old)
	if !reflect.DeepEqual(stripped, expectedOld) {
		t.Fatal("changed original non-combat evidence")
	}
	counts := map[string]int{}
	for _, e := range candidate.Events {
		if e.Combat == nil {
			continue
		}
		c := e.Combat
		if c.ActionID != "" {
			counts["source"]++
		}
		if c.CounteredActionID != "" {
			counts["counter"]++
		}
		if c.EffectivenessClass != "" {
			counts["class"]++
		}
		if c.IsAttack != nil {
			counts["attack"]++
		}
		if c.ResponseAttempt != nil {
			counts["attempt"]++
		}
	}
	if !reflect.DeepEqual(counts, map[string]int{"source": 29, "counter": 10, "class": 26, "attack": 61, "attempt": 42}) {
		t.Fatal(counts)
	}
	dst := filepath.Join(t.TempDir(), "battle.sqlite")
	if err = os.WriteFile(dst, inputs[dbfile], 0600); err != nil {
		t.Fatal(err)
	}
	reads := 0
	s, err := NewBattleService(dst, func() ([]byte, error) { reads++; return append([]byte{}, inputs[catfile]...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err = s.Record(ctx, old.ID); err != nil {
		t.Fatal(err)
	}
	var oldJSON string
	if err = s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", old.ID).Scan(&oldJSON); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(oldJSON)))
	summary, err := s.Import(ctx, parsed, map[string]string{old.ID: hash})
	if err != nil || summary.Imported != 1 {
		t.Fatalf("import: %+v %v", summary, err)
	}
	stored, err := s.Record(ctx, old.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Events) != 283 || stored.Quality.Actions || stored.DurationSeconds == nil || *stored.DurationSeconds != 613 || stored.Outcome != "loss" {
		t.Fatal("changed record metadata")
	}
	stats, err := s.Stats(ctx, BattleFilter{})
	if err != nil || stats.SelfPerformance == nil {
		t.Fatalf("stats missing: %v", err)
	}
	var attacks, attempts, success, countered, kills int
	var dealt, received, est int64
	for _, p := range stats.SelfPerformance.Species {
		attacks += p.Totals.AttackActions
		attempts += p.Totals.ResponseAttempts
		success += p.Totals.ResponseSuccess
		countered += p.Totals.CounteredActions
		kills += p.Totals.Kills
		dealt += p.Totals.DamageDealt.Actual
		received += p.Totals.DamageReceived.Actual
		est += p.Totals.DamageDealt.Estimated
	}
	if attacks != 14 || attempts != 11 || success != 5 || countered != 5 || kills != 1 || dealt != 1594 || received != 1728 || est != 0 {
		t.Fatalf("actual stats: attacks%d attempts%d success%d countered%d kills%d damage%d/%d estimated%d", attacks, attempts, success, countered, kills, dealt, received, est)
	}
	if len(stats.SelfPerformance.CompleteLineups) != 1 || reads < 2 {
		t.Fatal("lineup or explicit catalog read missing")
	}
	encoded := cbJSON(stored)
	again, err := s.Import(ctx, parsed)
	if err != nil || again.Duplicates != 1 {
		t.Fatalf("replay: %+v %v", again, err)
	}
	stored2, err := s.Record(ctx, old.ID)
	if err != nil || cbJSON(stored2) != encoded {
		t.Fatal("non-idempotent actual replay")
	}
	conflict, _ := battleClone(candidate)
	for i := range conflict.Events {
		if c := conflict.Events[i].Combat; c != nil && c.IsAttack != nil {
			c.IsAttack = cbPtr(!*c.IsAttack)
			break
		}
	}
	if _, err = s.Import(ctx, []BattleRecord{conflict}); err == nil {
		t.Fatal("accepted conflicting evidence")
	}
	stored3, _ := s.Record(ctx, old.ID)
	if cbJSON(stored3) != encoded {
		t.Fatal("failed import altered record")
	}
	if output := os.Getenv("XHM_COMBAT_OUTPUT"); output != "" {
		f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.MarshalIndent(stored, "", "  ")
		_, err = f.Write(b)
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("output: %v %v", err, closeErr)
		}
	}
	for p, b := range inputs {
		after, err := os.ReadFile(p)
		if err != nil || !reflect.DeepEqual(b, after) {
			t.Fatalf("actual input changed: %s", p)
		}
	}
}
