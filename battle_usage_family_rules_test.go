package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func familyUsageCast(id, side, actor string, skill, seq int) BattleEvent {
	return BattleEvent{ID: id, Kind: "skill", Phase: "executed", Round: 1, Seq: seq, Side: side, Actor: actor, SkillID: skill}
}
func familyUsageInt(v int) *int           { return &v }
func familyUsageFloat(v float64) *float64 { return &v }
func familyUsageComponent(t *testing.T, out *BattleArchetypeStats, team string, species int) BattleArchetypeComponent {
	t.Helper()
	for _, row := range out.Teams {
		if row.ID == team {
			for _, c := range row.Components {
				if c.MonsterID == species {
					return c
				}
			}
		}
	}
	t.Fatalf("missing %s/%d", team, species)
	return BattleArchetypeComponent{}
}

func TestComponentFamilyRulesScopedExecutedUsagePartialWishChargeAndForms(t *testing.T) {
	r := familyRulesRecord("partial", 357, 357, 900001)
	// Instance IDs are side-scoped; an own-side cast by "a" must not leak.
	r.Sides["me"] = BattleSide{Pets: []BattlePet{{InstanceID: "a", MonsterID: 1}}}
	for i := 0; i < 2; i++ {
		p := &r.Sides["enemy"].Pets[i]
		p.InitialSkills = &BattleInitialSkills{SkillIDs: []int{20}, Complete: true}
		p.IV = map[string]BattleEvidence{"hp": {Value: familyUsageFloat(54), Certainty: "direct"}}
		p.Nature = map[string]BattleEvidence{"hp": {Value: familyUsageFloat(0), Certainty: "direct"}}
	}
	first := familyUsageCast("first", "enemy", "a", 492, 1)
	first.ExecIndex = familyUsageInt(0)
	charge := familyUsageCast("charge", "enemy", "a", 244, 10)
	charge.ProtocolSkillID = "700001000"
	selected := familyUsageCast("selected", "enemy", "a", 244, 11)
	selected.Phase = "selection"
	interrupted := familyUsageCast("interrupted", "enemy", "a", 244, 12)
	interrupted.Phase = "interrupted"
	r.Events = []BattleEvent{
		first, first,
		{ID: "hit-1", Kind: "damage", Phase: "executed", Round: 1, Seq: 1, ExecIndex: familyUsageInt(1), Side: "enemy", Actor: "a", TargetSide: "me", Target: "a", HPChange: familyUsageInt(-10), Combat: &BattleCombatEvidence{ActionID: "first"}},
		{ID: "form", Kind: "form", Phase: "executed", Round: 1, Seq: 2, Side: "enemy", Actor: "a", Form: &BattleFormChange{FromBaseID: "357", ToBaseID: "356", FromMonsterID: 357, ToMonsterID: 356}},
		familyUsageCast("after-form", "enemy", "a", 492, 3),
		familyUsageCast("twin", "enemy", "b", 492, 4),
		// No carrying inference: exchanged/acquired skill 244 remains a real cast
		// even though the complete initial declaration contains only skill 20.
		{ID: "exchange-observation", Kind: "effect", Phase: "executed", Round: 1, Seq: 5, Side: "enemy", Actor: "a", SkillClass: "system", Label: "exchange"},
		familyUsageCast("acquired", "enemy", "a", 244, 6),
		{ID: "wish-typed", Kind: "effect", Phase: "executed", Round: 1, Seq: 7, Side: "enemy", Actor: "a", SkillClass: "system", Combat: &BattleCombatEvidence{ActionKind: "wishImpact", TypeID: familyUsageInt(3)}},
		{ID: "wish-unknown", Kind: "skill", Phase: "executed", Round: 1, Seq: 8, Side: "enemy", Actor: "b", Combat: &BattleCombatEvidence{ActionKind: "wishImpact"}},
		familyUsageCast("own-collision", "me", "a", 999999, 9), charge, selected, interrupted,
	}
	other := familyRulesRecord("other-category", 357, 900002)
	other.Sides["enemy"].Pets[0].IV = map[string]BattleEvidence{"hp": {Value: familyUsageFloat(60), Certainty: "direct"}}
	other.Events = []BattleEvent{familyUsageCast("other-1", "enemy", "a", 99, 1), familyUsageCast("other-2", "enemy", "a", 99, 2)}
	bench := familyRulesRecord("carried-no-observation", 357, 900001)
	rules := []BattleTeamRule{{ID: "one", Name: "One", MonsterIDs: []int{900001}}, {ID: "two", Name: "Two", MonsterIDs: []int{900002}}}
	records := []BattleRecord{r, other, bench, r}
	for _, record := range records {
		clone, err := battleClone(record)
		if err == nil {
			err = ValidateBattleRecord(&clone)
		}
		if err != nil {
			t.Fatalf("invalid isolated fixture %s: %v", record.ID, err)
		}
	}
	before, _ := json.Marshal(records)
	out := BuildBattleArchetypeStats(records, rules)
	one := familyUsageComponent(t, out, "one", 357)
	if one.UsageTotalCasts != 6 || len(one.SkillUsage) != 4 || one.Carried != 2 {
		t.Fatalf("wrong executed denominator/counts: %+v", one)
	}
	counts := map[int]int{}
	var wishes, typed int
	for _, skill := range one.SkillUsage {
		if skill.TotalCasts != 6 || skill.MonsterID != 357 || skill.UsedBattles != 1 || skill.Samples != 1 {
			t.Fatalf("scope/sample mismatch %+v", skill)
		}
		if skill.Kind == "wishImpact" {
			wishes += skill.Casts
			if skill.TypeID != nil {
				if *skill.TypeID != 3 {
					t.Fatal("invented wish type")
				}
				typed += skill.Casts
			}
		} else {
			counts[skill.SkillID] = skill.Casts
		}
	}
	if !reflect.DeepEqual(counts, map[int]int{492: 3, 244: 1}) || wishes != 2 || typed != 1 {
		t.Fatal("charge/duplicate/side collision/carry contamination", counts, wishes, typed)
	}
	two := familyUsageComponent(t, out, "two", 357)
	if two.UsageTotalCasts != 2 || len(two.SkillUsage) != 1 || two.SkillUsage[0].SkillID != 99 || two.SkillUsage[0].Casts != 2 {
		t.Fatalf("cross-category leakage %+v", two)
	}
	if one.Profile.IVDistributions["hp"]["54"] != 1 || one.Profile.IVDistributions["hp"]["60"] != 0 || two.Profile.IVDistributions["hp"]["60"] != 1 {
		t.Fatal("profile cohort/precise IV lost")
	}
	for _, team := range out.Teams {
		for _, component := range team.Components {
			if component.MonsterID == 356 {
				t.Fatal("same instance form created component")
			}
		}
	}
	encoded, _ := json.Marshal(one)
	var wire map[string]json.RawMessage
	json.Unmarshal(encoded, &wire)
	if _, ok := wire["skillUsage"]; !ok {
		t.Fatal("missing usage array")
	}
	if _, ok := wire["usageTotalCasts"]; !ok {
		t.Fatal("missing usage denominator")
	}
	for _, deprecated := range []string{"skills", "skillSamples", "skillUnknown", "lifeProfiles", "lifeProfileSamples", "lifeProfileUnknown"} {
		if _, ok := wire[deprecated]; ok {
			t.Fatal("deprecated carry/joint-life still computed", deprecated)
		}
	}
	zero := familyUsageComponent(t, out, "one", 900001)
	if zero.SkillUsage == nil || len(zero.SkillUsage) != 0 || zero.UsageTotalCasts != 0 {
		t.Fatal("unobserved casts fabricated", zero)
	}
	after, _ := json.Marshal(records)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("component computation mutated evidence/quality")
	}
}
