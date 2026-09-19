package main

import (
	"bytes"
	"testing"
)

func testMoveData(t *testing.T, names ...string) []byte {
	t.Helper()
	moves := []map[string]interface{}{}
	for i, name := range names {
		moves = append(moves, map[string]interface{}{
			"id": i + 1, "move_category": "Physical Attack",
			"localized": map[string]interface{}{"zh": map[string]interface{}{"name": name, "description": "测试效果"}},
			"move_type": map[string]interface{}{"localized": map[string]interface{}{"zh": "机械"}},
		})
	}
	return testJSON(t, moves)
}

func TestNewUnknownSkillIsRejectedWithoutAnyWrite(t *testing.T) {
	monster := testMonster(434, "圣剑-X", "default")
	p := makeTestData(t, []interface{}{monster}, map[string]interface{}{"圣剑-X": testEntry(testSkill("旧"))})
	beforeMonsters, beforeWiki := readTestFile(t, p.monsters), readTestFile(t, p.wiki)
	response := editTestMonster(t, p, `{"id":434,"skillList":[{"name":"旧"},{"name":"不存在的技能"}]}`)
	assertJSONError(t, response)
	if !bytes.Equal(beforeMonsters, readTestFile(t, p.monsters)) || !bytes.Equal(beforeWiki, readTestFile(t, p.wiki)) {
		t.Fatal("invalid skill modified a data file")
	}
}

func TestLegacyWinterFallbackProtectsEmptyAndUnchangedEdits(t *testing.T) {
	monster := testMonster(40, "雪绒鸟", "冬天的样子")
	monster["learnset_mode"] = "own"
	input := testJSON(t, map[string]interface{}{"雪绒鸟": testEntry(testSkill("冬季技能"))})
	monsters := []map[string]interface{}{monster}
	if _, _, err := prepareWikiSkills(input, nil, monster, monsters, []wikiSkillRef{}, false); err == nil {
		t.Fatal("legacy fallback could be cleared without explicit confirmation")
	}
	out, changed, err := prepareWikiSkills(input, nil, monster, monsters, []wikiSkillRef{{"冬季技能", "默认"}}, false)
	if err != nil || changed || out != nil {
		t.Fatalf("unchanged legacy fallback was rewritten: %v %v", changed, err)
	}
	out, changed, err = prepareWikiSkills(input, nil, monster, monsters, []wikiSkillRef{}, true)
	if err != nil || !changed {
		t.Fatalf("explicit winter edit failed: %v", err)
	}
	wiki, _ := decodeWiki(out)
	if wiki["雪绒鸟"] == nil || wiki["雪绒鸟（冬天的样子）"] == nil {
		t.Fatal("must preserve legacy record and create an exact independent form")
	}
	skills, err := effectiveWikiSkills(wiki, monster, monsters)
	if err != nil || len(skills) != 0 {
		t.Fatal("explicitly empty form incorrectly fell back to legacy skills")
	}
}
