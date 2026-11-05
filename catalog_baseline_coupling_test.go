package main

import (
	"testing"
	"xhmwiki/internal/catalog"
)

func TestTencentBaselineSourceNowEqualsCalibratedLocalIsAvailableNoop(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, baselineTestHP(t, 90), func(c *catalog.Catalog) { c.Monsters[0].Stats.HP = 100 })
	s := catalogTestPreview(t, fx, baselineTestHP(t, 100))
	found := false
	for _, item := range s.Candidates {
		if item.Key == "monster:1:stats.hp" {
			found = true
			if !item.SourceAvailable || item.Kind != "source_revision" {
				t.Fatal("valid source-equivalent revision unavailable", item)
			}
		}
	}
	if !found {
		t.Fatal("source revision lost because equal local")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "source", AcknowledgeOnly: true}})
	if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 100 {
		t.Fatal("no-op revision changed data")
	}
	s = catalogTestPreview(t, fx, baselineTestHP(t, 90))
	if !choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("source reversion suppressed by initial seed")
	}
}
func baselineTestInheritance(t *testing.T) *catalogTestFixture {
	fx := catalogTestNew(t, 3, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 3, false), func(c *catalog.Catalog) {
		copy := c.Skills[0]
		copy.ID = 4
		copy.Name = "招架"
		c.Skills = append(c.Skills, copy)
		c.Learnsets[1].Mode = "inherit"
		c.Learnsets[1].FromID = 1
		c.Learnsets[2].Mode = "inherit"
		c.Learnsets[2].FromID = 2
	})
	return fx
}
func baselineTestLearningChange(t *testing.T, ids ...string) []byte {
	return choiceTestSourceChange(t, 3, func(s map[string]any) {
		for _, id := range ids {
			row := s["d"].(map[string]any)[id].(map[string]any)
			skills := row["sk"].(map[string]any)
			first := skills["s"].([]any)[0].(map[string]any)
			next := map[string]any{}
			for key, value := range first {
				next[key] = value
			}
			next["nm"] = "招架"
			skills["s"] = append(skills["s"].([]any), next)
		}
	})
}
func TestTencentBaselineChangedParentCannotMutateUnchangedInheritedChild(t *testing.T) {
	fx := baselineTestInheritance(t)
	source := baselineTestLearningChange(t, "101")
	s := catalogTestPreview(t, fx, source)
	if !choiceTestHas(s, "monster:1:learning") || choiceTestHas(s, "monster:2:learning") {
		t.Fatal("unexpected source delta candidates", s)
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:learning", Choice: "source", AcknowledgeOnly: true}})
	c := choiceTestCurrent(t, fx)
	parent, _ := baselineEffectiveLearning(c, 1)
	child, _ := baselineEffectiveLearning(c, 2)
	grandchild, _ := baselineEffectiveLearning(c, 3)
	if len(parent.Skills) != 2 || len(child.Skills) != 1 || len(grandchild.Skills) != 1 {
		t.Fatal("parent selection leaked into unchanged descendants")
	}
	if choiceLearnset(c, 2).Mode != "own" || choiceLearnset(c, 3).Mode != "inherit" || choiceLearnset(c, 3).FromID != 2 {
		t.Fatal("did not detach minimal affected child")
	}
	s = catalogTestPreview(t, fx, source)
	if choiceTestHas(s, "monster:1:learning") || choiceTestHas(s, "monster:2:learning") {
		t.Fatal("reconciled face repeated")
	}
}
func TestTencentBaselineSelectedChildDoesNotRequireSelectingParent(t *testing.T) {
	fx := baselineTestInheritance(t)
	source := baselineTestLearningChange(t, "101", "102")
	s := catalogTestPreview(t, fx, source)
	childAvailable := false
	for _, item := range s.Candidates {
		if item.Key == "monster:2:learning" {
			childAvailable = item.SourceAvailable
		}
	}
	if !childAvailable {
		t.Fatal("coupled equal inherit source revision unavailable", s)
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:2:learning", Choice: "source", AcknowledgeOnly: true}})
	c := choiceTestCurrent(t, fx)
	parent, _ := baselineEffectiveLearning(c, 1)
	child, _ := baselineEffectiveLearning(c, 2)
	grandchild, _ := baselineEffectiveLearning(c, 3)
	if len(parent.Skills) != 1 || len(child.Skills) != 2 || len(grandchild.Skills) != 1 {
		t.Fatal("selected child's effective source face lost or leaked")
	}
	if choiceLearnset(c, 2).Mode != "own" || choiceLearnset(c, 3).Mode != "own" {
		t.Fatal("coupled inheritance not safely materialized")
	}
	s = catalogTestPreview(t, fx, source)
	if choiceTestHas(s, "monster:2:learning") || !choiceTestHas(s, "monster:1:learning") {
		t.Fatal("selected child acknowledgement touched parent")
	}
}
func TestTencentBaselineParentAndChildSourceKeepCompatibleInheritance(t *testing.T) {
	fx := baselineTestInheritance(t)
	source := baselineTestLearningChange(t, "101", "102", "103")
	s := catalogTestPreview(t, fx, source)
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:learning", Choice: "source", AcknowledgeOnly: true}, {Key: "monster:2:learning", Choice: "source", AcknowledgeOnly: true}, {Key: "monster:3:learning", Choice: "source", AcknowledgeOnly: true}})
	c := choiceTestCurrent(t, fx)
	if choiceLearnset(c, 2).Mode != "inherit" || choiceLearnset(c, 3).Mode != "inherit" {
		t.Fatal("compatible source inheritance unnecessarily detached")
	}
	child, _ := baselineEffectiveLearning(c, 3)
	if len(child.Skills) != 2 {
		t.Fatal("source effective learning not applied")
	}
}
func TestTencentBaselineLearningOrderDuplicatesAndMetadataDoNotDetach(t *testing.T) {
	fx := baselineTestInheritance(t)
	before := choiceTestCurrent(t, fx)
	before.Learnsets[0].Skills = append(before.Learnsets[0].Skills, catalog.LearnedSkill{SkillID: 4, Source: "默认"})
	raw, err := catalog.Marshal(before)
	if err != nil {
		t.Fatal(err)
	}
	out, err := catalog.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	out.Learnsets[0].Skills = []catalog.LearnedSkill{out.Learnsets[0].Skills[1], out.Learnsets[0].Skills[0], out.Learnsets[0].Skills[0]}
	out.Learnsets[0].Skills[0].Extensions = catalog.Extensions{"representation": []byte(`true`)}
	p := &catalogChoicePlan{baseline: baselineTestRead(t, fx), localCatalog: before, sourceCatalog: before}
	if err = p.reconcileBaselineLearning(out, map[string]string{}); err != nil {
		t.Fatal(err)
	}
	if choiceLearnset(out, 2).Mode != "inherit" || choiceLearnset(out, 3).Mode != "inherit" {
		t.Fatal("same effective set unnecessarily detached")
	}
}
