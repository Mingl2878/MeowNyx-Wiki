package main

import (
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func chartNature(p *BattlePet, positive ...string) {
	p.Nature = map[string]BattleEvidence{}
	for _, attr := range battleChartAttributes {
		v := 0.0
		for _, stat := range positive {
			if stat == attr.stat {
				v = 1
			}
		}
		p.Nature[attr.stat] = BattleEvidence{Value: archetypeFloat(v), Certainty: "direct"}
	}
}

func TestMemberNatureConfigurationPieIncludesUnknownAndCombinationsOnce(t *testing.T) {
	records := []BattleRecord{}
	for i := 0; i < 100; i++ {
		r := archetypeRecord("pie"+strconv.Itoa(i), []int{1}, []int{2, 7})
		pet := &r.Sides["enemy"].Pets[1]
		if i >= 60 && i < 90 {
			chartNature(pet, "speed")
		}
		if i >= 90 {
			chartNature(pet, "hp")
		}
		records = append(records, r)
	}
	before := archetypeEncode(t, records)
	stats := BuildBattleArchetypeStats(records, []BattleTeamRule{{ID: "a", Name: "A", MonsterIDs: []int{2}}})
	c := archetypeComponent(t, archetypeTeam(t, stats, "a"), 7)
	if c.NatureSamples != 100 || c.NatureUnknown != 60 || len(c.NatureConfigurations) != 3 {
		t.Fatal(c.NatureSamples, c.NatureUnknown, c.NatureConfigurations)
	}
	sum := 0
	counts := map[string]int{}
	for _, bucket := range c.NatureConfigurations {
		sum += bucket.Battles
		counts[bucket.Label] = bucket.Battles
		if bucket.Key == "unknown" {
			archetypeRate(t, bucket.Rate, .6)
			if bucket.Complete || len(bucket.UnknownAttributes) != 6 || len(bucket.Selected) != 0 {
				t.Fatal(bucket)
			}
		}
	}
	if sum != 100 || counts["未知"] != 60 || counts["速度"] != 30 || counts["生命"] != 10 {
		t.Fatal("mutually exclusive pie", counts, sum)
	}
	if string(before) != string(archetypeEncode(t, records)) {
		t.Fatal("charts wrote facts")
	}
	for _, choice := range c.IndividualChoices {
		if choice.Samples != 0 || choice.Selected != 0 || choice.Unselected != 0 || choice.Unknown != 100 || choice.Rate != nil {
			t.Fatal("missing IV became fake zero", choice)
		}
	}
}

func TestMemberNaturePartialNegativeAndComboNeverPretendNeutral(t *testing.T) {
	unknown := archetypeRecord("unknown", []int{1}, []int{2, 7})
	partial := archetypeRecord("partial", []int{1}, []int{2, 7})
	partial.Sides["enemy"].Pets[1].Nature = map[string]BattleEvidence{"speed": {Value: archetypeFloat(1), Certainty: "unique"}}
	combo := archetypeRecord("combo", []int{1}, []int{2, 7})
	chartNature(&combo.Sides["enemy"].Pets[1], "hp", "speed")
	negative := archetypeRecord("negative", []int{1}, []int{2, 7})
	negative.Sides["enemy"].Pets[1].Nature = map[string]BattleEvidence{"speed": {Value: archetypeFloat(2), Certainty: "direct"}}
	neutral := archetypeRecord("neutral", []int{1}, []int{2, 7})
	chartNature(&neutral.Sides["enemy"].Pets[1])
	c := archetypeComponent(t, archetypeTeam(t, BuildBattleArchetypeStats([]BattleRecord{unknown, partial, combo, negative, neutral}, []BattleTeamRule{{ID: "a", Name: "A", MonsterIDs: []int{2}}}), "a"), 7)
	if c.NatureSamples != 5 || c.NatureUnknown != 3 || len(c.NatureConfigurations) != 5 {
		t.Fatal(c)
	}
	sum := 0
	for _, bucket := range c.NatureConfigurations {
		sum += bucket.Battles
		archetypeRate(t, bucket.Rate, .2)
		if !bucket.Complete && bucket.Key != "unknown" && !strings.Contains(bucket.Label, "未确认") {
			t.Fatal("partial not marked", bucket)
		}
		if bucket.Complete && len(bucket.Selected) == 2 && !reflect.DeepEqual(bucket.Selected, []string{"hp", "speed"}) {
			t.Fatal("combo order", bucket)
		}
		if bucket.Values["speed"] == 2 && len(bucket.Selected) != 0 {
			t.Fatal("negative counted positive", bucket)
		}
	}
	if sum != 5 {
		t.Fatal("combination double counted", sum)
	}
}

func TestMemberIndividualIndependentConfirmedDenominatorsAndPrecise54(t *testing.T) {
	records := []BattleRecord{}
	for i := 0; i < 30; i++ {
		r := archetypeRecord("iv"+strconv.Itoa(i), []int{1}, []int{2, 7})
		p := &r.Sides["enemy"].Pets[1]
		if i < 20 {
			v := 0.0
			if i < 10 {
				v = 54
			}
			p.IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(v), Certainty: "direct"}}
		}
		if i == 29 {
			p.IV = map[string]BattleEvidence{"attack": {Certainty: "candidate", Candidates: []float64{0, 60}}}
		}
		records = append(records, r)
	}
	c := archetypeComponent(t, archetypeTeam(t, BuildBattleArchetypeStats(records, []BattleTeamRule{{ID: "a", Name: "A", MonsterIDs: []int{2}}}), "a"), 7)
	if len(c.IndividualChoices) != 6 {
		t.Fatal(c.IndividualChoices)
	}
	order := []string{}
	for _, choice := range c.IndividualChoices {
		order = append(order, choice.Attribute)
		if choice.Attribute == "hp" {
			if choice.Selected != 10 || choice.Unselected != 10 || choice.Unknown != 10 || choice.Samples != 20 {
				t.Fatal(choice)
			}
			archetypeRate(t, choice.Rate, .5)
		} else if choice.Rate != nil || choice.Samples != 0 || choice.Unknown != 30 {
			t.Fatal("unknown denominator", choice)
		}
	}
	if !reflect.DeepEqual(order, []string{"hp", "attack", "magicAttack", "defense", "magicDefense", "speed"}) {
		t.Fatal(order)
	}
	if c.Profile.IVDistributions["hp"]["54"] != 10 || c.Profile.IVDistributions["hp"]["60"] != 0 {
		t.Fatal("54 was coerced", c.Profile.IVDistributions)
	}
}

func TestMemberSameSpeciesPerBattleConsensusAndTeamCohorts(t *testing.T) {
	agree := archetypeRecord("agree", []int{1}, []int{2, 7, 7})
	for i := 1; i < 3; i++ {
		chartNature(&agree.Sides["enemy"].Pets[i], "hp", "speed")
		agree.Sides["enemy"].Pets[i].IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(54), Certainty: "direct"}}
	}
	conflict := archetypeRecord("conflict", []int{1}, []int{2, 7, 7})
	chartNature(&conflict.Sides["enemy"].Pets[1], "hp")
	chartNature(&conflict.Sides["enemy"].Pets[2], "speed")
	conflict.Sides["enemy"].Pets[1].IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(54), Certainty: "direct"}}
	other := archetypeRecord("other", []int{1}, []int{3, 7})
	chartNature(&other.Sides["enemy"].Pets[1], "attack")
	other.Sides["enemy"].Pets[1].IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(0), Certainty: "direct"}}
	stats := BuildBattleArchetypeStats([]BattleRecord{agree, conflict, other}, []BattleTeamRule{{ID: "a", Name: "A", MonsterIDs: []int{2}}, {ID: "b", Name: "B", MonsterIDs: []int{3}}})
	a := archetypeComponent(t, archetypeTeam(t, stats, "a"), 7)
	b := archetypeComponent(t, archetypeTeam(t, stats, "b"), 7)
	if a.NatureSamples != 2 || a.NatureUnknown != 1 || a.IndividualChoices[0].Selected != 1 || a.IndividualChoices[0].Unknown != 1 || b.NatureSamples != 1 || b.IndividualChoices[0].Unselected != 1 {
		t.Fatal("instance duplication or cohort bleed", a, b)
	}
	for _, bucket := range a.NatureConfigurations {
		if len(bucket.Selected) == 2 && bucket.Battles != 1 {
			t.Fatal("same species doubled", bucket)
		}
	}
	filtered := BuildBattleArchetypeStats([]BattleRecord{other}, []BattleTeamRule{{ID: "a", Name: "A", MonsterIDs: []int{2}}, {ID: "b", Name: "B", MonsterIDs: []int{3}}})
	if len(archetypeTeam(t, filtered, "a").Components) != 0 {
		t.Fatal("filter cohort widened")
	}
}

func TestMultiLabelWolfKavaSharkWaterFullConsumersAndOrderIndependence(t *testing.T) {
	rules := []BattleTeamRule{{ID: "wolf", Name: "狼", MonsterIDs: []int{233}}, {ID: "kava", Name: "卡瓦", AnyOf: [][]int{{111, 109}}}, {ID: "shark", Name: "鲨", MonsterIDs: []int{202}}, {ID: "water", Name: "水", MonsterIDs: []int{17}}}
	a := archetypeRecord("wolf-kava", []int{1, 1, 5}, []int{232, 103, 7})
	b := archetypeRecord("shark-water", []int{1, 1, 5}, []int{202, 17, 7})
	unknown := archetypeRecord("unknown", []int{1, 1, 5}, []int{233, 111})
	unknown.Quality.Roster["enemy"] = false
	prepared, err := battlePrepareRuleFamilies(rules, familyRulesCatalog(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		record BattleRecord
		ids    []string
	}{{a, []string{"wolf", "kava"}}, {b, []string{"shark", "water"}}} {
		matched, ok := battleMatchedArchetypes(tc.record, prepared)
		if !ok || !reflect.DeepEqual(matched, tc.ids) {
			t.Fatal(matched, ok)
		}
		for _, id := range tc.ids {
			if !MatchBattleRecord(tc.record, BattleFilter{TeamRuleID: id}, prepared) {
				t.Fatal("filter missed secondary label", id)
			}
		}
	}
	input := []BattleRecord{a, a, b, unknown}
	stats := BuildBattleArchetypeStats(input, prepared)
	base := BuildBattleStats(input, prepared)
	if stats.Samples != 2 || stats.AssignmentCount != 4 || stats.UnknownBattles != 1 || base.MatchedBattles != 3 || len(stats.OwnMatchups) != 1 || stats.OwnMatchups[0].Battles != 2 || len(stats.OwnMatchups[0].Teams) != 4 {
		t.Fatal("global/own dedup", stats, base.MatchedBattles)
	}
	for _, id := range []string{"wolf", "kava", "shark", "water"} {
		team := archetypeTeam(t, stats, id)
		if team.Battles != 1 || len(team.Components) != 3 {
			t.Fatal("full cohort not consumed", team)
		}
		archetypeRate(t, archetypeComponent(t, team, 7).Rate, 1)
		archetypeRate(t, stats.Environment[0].Rate, .5)
	}
	for _, team := range base.Teams {
		if team.Battles != 1 || team.Samples != 2 {
			t.Fatal("legacy count first match", team)
		}
	}
	for i, j := 0, len(prepared)-1; i < j; i, j = i+1, j-1 {
		prepared[i], prepared[j] = prepared[j], prepared[i]
	}
	reordered := BuildBattleArchetypeStats(input, prepared)
	for _, team := range reordered.Teams {
		if team.Battles != archetypeTeam(t, stats, team.ID).Battles {
			t.Fatal("rule order changed membership", team.ID)
		}
	}
	if MatchBattleRecord(unknown, BattleFilter{TeamRuleID: battleOtherArchetypeID}, prepared) {
		t.Fatal("unknown counted other")
	}
}
