package main

import "testing"

func TestBattleLiveDeletedCatalogSkillDoesNotLeakProducerLookup(t *testing.T) {
	m := &battleIdentityMap{monsters: map[string]int{}, skills: map[int]bool{}}
	r := BattleRecord{Source: "rkpp-live-v1", Events: []BattleEvent{{ID: "cast", Kind: "skill", Phase: "executed", ProtocolSkillID: "705032000", ProtocolSkillConfigID: "7050320", SkillID: 155}}}
	if e := m.apply(&r, false); e != nil || r.Events[0].SkillID != 0 {
		t.Fatal("provisional deleted skill treated as currently mapped", e, r.Events)
	}
	r.Events[0].SkillID = 155
	if e := m.apply(&r, true); e != nil || r.Events[0].SkillID != 155 {
		t.Fatal("stored historical mapping erased", e, r.Events)
	}
}
