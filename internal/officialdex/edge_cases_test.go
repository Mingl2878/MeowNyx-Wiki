package officialdex

import (
	"bytes"
	"testing"
)

func TestSameDexRenamedMonsterIsNotInventedAsNew(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(4, 12, "旧名", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, l, fixtureSource(t, object{"4": fixtureDetail(12, "新名", "")}))
	if p.Stats.AddedMonsters != 0 || !hasIssue(p, "new_identity_not_proven") {
		t.Fatalf("renamed monster invented: %+v", p.Stats)
	}
	if localName(findID(t, p.Files.Monsters, 4)) != "旧名" {
		t.Fatal("renamed without evidence")
	}
}

func TestExplicitLeaderFormMatchesWithoutBorrowingBaseAttributes(t *testing.T) {
	base := fixtureMonster(1, 1, "迪莫", "default")
	leader := fixtureMonster(2, 1, "圣光迪莫", "default")
	leader["is_leader_form"] = true
	d1, d2 := fixtureDetail(1, "迪莫", ""), fixtureDetail(1, "圣光迪莫", "首领形态")
	d2["hp"] = 222
	d2["s"] = ""
	d2["rt"] = 737
	l := fixtureLocal(t, []any{base, leader}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, l, fixtureSource(t, object{"80": d1, "81": d2}))
	if n, _ := integer(findID(t, p.Files.Monsters, 2)["base_hp"]); n != 222 {
		t.Fatal("leader stats borrowed from shared NO")
	}
	if findID(t, p.Files.Monsters, 2)["evolution_stage"] != "首领形态" {
		t.Fatal("leader stage ignored")
	}
}

func TestMultipleSourceAliasesCannotRaceForOneLocalID(t *testing.T) {
	m := fixtureMonster(10, 1, "原名", "default")
	l := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{"原名": object{"monster_id": 10, "aliases": []any{"别名甲", "别名乙"}, "skills": []any{}}})
	p := proposal(t, l, fixtureSource(t, object{"100": fixtureDetail(1, "别名甲", ""), "101": fixtureDetail(1, "别名乙", "")}))
	if p.Stats.MatchedMonsters != 0 || p.Stats.AddedMonsters != 0 || !hasIssue(p, "multiple_source_matches") {
		t.Fatal("first alias won conflicting mapping")
	}
	if !equal(findID(t, p.Files.Monsters, 10), m) {
		t.Fatal("ambiguous monster mutated")
	}
}

func TestSourceRefAloneCannotMapAndUnknownFormCannotMatch(t *testing.T) {
	m := fixtureMonster(10, 1, "本地名", "default")
	m["_source_ref"] = object{"provider": Provider, "id": "99", "identity": "NO.001|源名字|"}
	l := fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p := proposal(t, l, fixtureSource(t, object{"99": fixtureDetail(1, "源名字", "")}))
	if p.Stats.MatchedMonsters != 0 || p.Stats.AddedMonsters != 0 {
		t.Fatal("source ID was used as identity")
	}
	delete(m, "form")
	l = fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	p = proposal(t, l, fixtureSource(t, object{"99": fixtureDetail(1, "本地名", "")}))
	if p.Stats.MatchedMonsters != 0 || !hasIssue(p, "identity_crosscheck_failed") {
		t.Fatal("missing form silently treated as default")
	}
}

func TestListIdentityConflictAndDuplicateSourceIdentityAreRejected(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	src := decodeObject(t, fixtureSource(t, object{"9": fixtureDetail(1, "小猫", "")}))
	asObject(src["l"].([]any)[0])["fn"] = "wrong"
	p := proposal(t, l, jsonBytes(t, src))
	if p.Stats.MatchedMonsters != 0 || !hasIssue(p, "list_identity_conflict") {
		t.Fatal("conflicting list ignored")
	}
	p = proposal(t, l, fixtureSource(t, object{"9": fixtureDetail(1, "小猫", ""), "10": fixtureDetail(1, "小猫", "")}))
	if p.Stats.MatchedMonsters != 0 || !hasIssue(p, "duplicate_source_identity") {
		t.Fatal("duplicate source identity picked by ID order")
	}
}

func TestIncompleteSkillDoesNotZeroMoveOrPartiallyReplaceLearning(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "传说"}}}})
	d := fixtureDetail(1, "小猫", "")
	skill := fixtureSkill("冲撞", "75")
	delete(skill, "ec")
	asObject(d["sk"])["s"] = []any{skill, fixtureSkill("新招", "40")}
	p := proposal(t, l, fixtureSource(t, object{"100": d}))
	if !equal(findID(t, p.Files.Moves, 3), fixtureMove(3, "冲撞", 60)) {
		t.Fatal("invalid energy overwritten")
	}
	rows := asObject(decodeObject(t, p.Files.Wiki)["小猫"])["skills"].([]any)
	if len(rows) != 1 {
		t.Fatal("partial learning face appended")
	}
	if !hasIssue(p, "invalid_move") {
		t.Fatal("invalid definition unreported")
	}
}

func TestOrdinaryPowerStillUpdatesWithConditionalRuleFields(t *testing.T) {
	m := fixtureMove(3, "冲撞", 60)
	m["alt_power_total"] = 180
	m["alt_condition_zh"] = "原条件"
	m["statuses"] = []any{object{"rule": "keep"}}
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{m}, object{})
	p := proposal(t, l, fixtureSource(t, object{"1": fixtureDetail(1, "小猫", "")}))
	got := findID(t, p.Files.Moves, 3)
	if n, _ := integer(got["power"]); n != 75 {
		t.Fatal("conditional rules froze ordinary base power")
	}
	if !equal(got["alt_power_total"], 180) || !equal(got["statuses"], m["statuses"]) {
		t.Fatal("rule field changed")
	}
	if !hasIssue(p, "special_rule_description_changed") {
		t.Fatal("conditional rule description review absent")
	}
}

func TestMalformedEnvelopeRejectsDeepAndDuplicateJSON(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	for _, src := range [][]byte{[]byte("{\"d\":{\"1\":{\"hp\":1,\"hp\":2}}}"), append([]byte("{\"name\":\""), 0xff), bytes.Repeat([]byte("["), 100)} {
		if _, e := BuildProposal(l, src); e == nil {
			t.Fatal("malformed/deep JSON accepted")
		}
	}
	d := object{"n": "NO.001", "nm": "小猫", "fn": "小猫", "f": ""}
	if _, e := BuildProposal(l, fixtureSource(t, object{"1": d})); e == nil {
		t.Fatal("recognizable names hid replaced detail schema")
	}
}

func TestLocalBytesUnmodifiedAndUnknownTypeDoesNotRebuildRelationships(t *testing.T) {
	l := fixtureLocal(t, []any{fixtureMonster(1, 1, "小猫", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	before := LegacyFiles{bytes.Clone(l.Monsters), bytes.Clone(l.Moves), bytes.Clone(l.Types), bytes.Clone(l.Wiki)}
	d := fixtureDetail(1, "小猫", "")
	d["e"] = "全新系"
	p := proposal(t, l, fixtureSource(t, object{"1": d}))
	if !bytes.Equal(before.Monsters, l.Monsters) || !bytes.Equal(before.Moves, l.Moves) || !bytes.Equal(before.Wiki, l.Wiki) || !bytes.Equal(before.Types, l.Types) {
		t.Fatal("input bytes mutated")
	}
	if !bytes.Equal(l.Types, p.Files.Types) || zhString(asObject(findID(t, p.Files.Monsters, 1)["main_type"])) != "普通" || !hasIssue(p, "unknown_type") {
		t.Fatal("unknown type replaced local relationships")
	}
}
