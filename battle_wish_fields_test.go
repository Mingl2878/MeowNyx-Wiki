package main

import (
	"encoding/json"
	"testing"
)

func wishFieldFixture() BattleRecord {
	r := cbFixture()
	r.Events = append(r.Events, BattleEvent{ID: "wish", Round: 1, Seq: 2, ExecIndex: cbPtr(0), Kind: "effect", Phase: "executed", SkillClass: "system", Side: "me", Actor: "a", ProtocolSkillID: "900002000", Combat: &BattleCombatEvidence{ActionKind: "wishImpact", TypeID: cbPtr(13)}})
	return r
}
func TestBattleWishFieldsValidationAndClone(t *testing.T) {
	for _, typ := range []int{1, 13, 18} {
		r := wishFieldFixture()
		r.Events[4].Combat.TypeID = cbPtr(typ)
		if err := ValidateBattleRecord(&r); err != nil {
			t.Fatal(err)
		}
	}
	r := wishFieldFixture()
	r.Events[4].Combat.TypeID = nil
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(*BattleEvent){
		"unknown kind":      func(e *BattleEvent) { e.Combat.ActionKind = "guessed" },
		"type without kind": func(e *BattleEvent) { e.Combat.ActionKind = "" },
		"zero type":         func(e *BattleEvent) { e.Combat.TypeID = cbPtr(0) },
		"negative type":     func(e *BattleEvent) { e.Combat.TypeID = cbPtr(-1) },
		"unknown type":      func(e *BattleEvent) { e.Combat.TypeID = cbPtr(19) },
		"passive":           func(e *BattleEvent) { e.SkillClass = "passive" },
		"resource":          func(e *BattleEvent) { e.Kind = "resource" },
		"preview":           func(e *BattleEvent) { e.Phase = "preview" },
		"selection":         func(e *BattleEvent) { e.Phase = "selection" },
		"charge":            func(e *BattleEvent) { e.ProtocolSkillID = "700001000" },
	}
	for name, change := range bad {
		t.Run(name, func(t *testing.T) {
			r := wishFieldFixture()
			change(&r.Events[4])
			if ValidateBattleRecord(&r) == nil {
				t.Fatal("accepted invalid special-action evidence")
			}
		})
	}
	r = wishFieldFixture()
	clone, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	*clone.Events[4].Combat.TypeID = 4
	if *r.Events[4].Combat.TypeID != 13 {
		t.Fatal("type pointer aliased")
	}
	encoded, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var roundtrip BattleRecord
	if err = json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if roundtrip.Events[4].Combat.ActionKind != "wishImpact" || *roundtrip.Events[4].Combat.TypeID != 13 {
		t.Fatal("lost normalized wish fields")
	}
}
func TestBattleWishMetadataMergeConflicts(t *testing.T) {
	a := wishFieldFixture()
	b, _ := battleClone(a)
	a.Events[4].Combat = nil
	merged, err := MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Events[4].Combat == nil || *merged.Events[4].Combat.TypeID != 13 {
		t.Fatal("lost type")
	}
	other, _ := battleClone(b)
	other.Events[4].Combat.TypeID = cbPtr(4)
	if _, err = MergeBattleRecord(b, other); err == nil {
		t.Fatal("known actual type overwritten")
	}
	unknown, _ := battleClone(b)
	unknown.Events[4].Combat.TypeID = nil
	merged, err = MergeBattleRecord(b, unknown)
	if err != nil || *merged.Events[4].Combat.TypeID != 13 {
		t.Fatal("stale unknown erased type", err)
	}
}
func TestBattleDepartureUnknownCanBeFilledButKnownCauseCannot(t *testing.T) {
	a := cbFixture()
	side := a.Sides["me"]
	side.Pets = append(side.Pets, BattlePet{InstanceID: "c", MonsterID: 501})
	a.Sides["me"] = side
	a.Events = append(a.Events, BattleEvent{ID: "withdraw", Round: 1, Seq: 2, Kind: "switch", Phase: "executed", Side: "me", Actor: "c", Target: "a", Combat: &BattleCombatEvidence{LeaveReason: "unknown"}})
	b, _ := battleClone(a)
	b.Events[4].Combat.LeaveReason = "self"
	b.Events[4].Combat.ActionID = "cast"
	oldA, oldB := cbJSON(a), cbJSON(b)
	first, err := MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	second, err := MergeBattleRecord(b, a)
	if err != nil {
		t.Fatal(err)
	}
	if cbJSON(first) != cbJSON(second) || first.Events[4].Combat.LeaveReason != "self" || first.Events[4].Combat.ActionID != "cast" {
		t.Fatal("unknown must fill symmetrically")
	}
	if cbJSON(a) != oldA || cbJSON(b) != oldB {
		t.Fatal("mutated caller")
	}
	conflict, _ := battleClone(b)
	conflict.Events[4].Combat.LeaveReason = "forced"
	if _, err = MergeBattleRecord(b, conflict); err == nil {
		t.Fatal("overwrote a known cause")
	}
	stale, _ := battleClone(a)
	stale.Events[4].Combat = nil
	retained, err := MergeBattleRecord(first, stale)
	if err != nil || retained.Events[4].Combat.LeaveReason != "self" {
		t.Fatal("stale absent evidence erased cause", err)
	}
}
