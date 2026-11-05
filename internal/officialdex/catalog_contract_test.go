package officialdex

import (
	"strings"
	"testing"

	canonical "xhmwiki/internal/catalog"
)

// Synthetic cross-package contract: a safely proven new ordinary monster must
// remain convertible to the canonical model without guessing required fields.
func TestProposalCanonicalContractForProvenOrdinaryAddition(t *testing.T) {
	typ := fixtureType()
	typ["vulnerable_to"] = []any{}
	typ["resistant_to"] = []any{}
	m := fixtureMonster(1, 1, "小猫", "default")
	m["form_category"] = "无多形态"
	m["evolves_from_id"] = nil
	m["main_type"] = typ
	m["default_legacy_type"] = typ
	move := fixtureMove(3, "冲撞", 60)
	move["move_type"] = typ
	move["base_combo"] = nil
	move["power_formula"] = nil
	local := LegacyFiles{Monsters: jsonBytes(t, []any{m}), Moves: jsonBytes(t, []any{move}), Types: jsonBytes(t, []any{typ}), Wiki: jsonBytes(t, object{"小猫": object{"monster_id": 1, "skills": []any{object{"name": "冲撞", "source": "默认", "desc": "旧描述", "type": "物攻", "element": "普通"}}}})}
	detail := fixtureDetail(2, "小狗", "")
	asObject(detail["sk"])["s"] = []any{fixtureSkill("冲撞", "75"), fixtureSkill("新招", "45")}
	source := fixtureSource(t, object{"40": fixtureDetail(1, "小猫", ""), "41": detail})
	p := proposal(t, local, source)
	if p.Stats.AddedMonsters != 1 {
		t.Fatalf("safe addition missing: %+v", p.Issues)
	}
	c, e := canonical.ImportLegacy(canonical.LegacyFiles{Monsters: p.Files.Monsters, Moves: p.Files.Moves, Types: p.Files.Types, Wiki: p.Files.Wiki})
	if e != nil {
		t.Fatal(e)
	}
	if len(c.Monsters) != 2 || c.Monsters[1].ID != 2 || c.Monsters[1].FormCategory != "无多形态" {
		t.Fatal("canonical identity mismatch")
	}
	if p.Stats.RefreshedLearningRows != 1 {
		t.Fatalf("derived row count %d", p.Stats.RefreshedLearningRows)
	}
	for _, ch := range p.Changes {
		if ch.Entity == "wiki" && strings.Contains(ch.Field, "skills[") {
			t.Fatal("derived row reported as business change")
		}
	}
	if p.Stats.AddedMoves != 1 || len(c.Skills) != 2 || c.Skills[1].ID != 4 || c.Skills[1].Season != "" {
		t.Fatal("new skill identity or unspecified season contract lost")
	}
	p2 := proposal(t, p.Files, source)
	if len(p2.Changes) != 0 || p2.Stats.RefreshedLearningRows != 0 {
		t.Fatal("contract not idempotent")
	}
}

func TestNewFormWithoutProvenCategoryIsReviewOnly(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(1, 1, "旧精灵", "default")}, []any{fixtureMove(3, "冲撞", 60)}, object{})
	for _, form := range []string{"本来的样子", "变身的样子", "首领形态"} {
		d := fixtureDetail(2, "新精灵", form)
		p := proposal(t, local, fixtureSource(t, object{"99": d}))
		if p.Stats.AddedMonsters != 0 || !hasIssue(p, "new_form_identity_not_proven") {
			t.Fatalf("unknown form %s assigned ID", form)
		}
	}
	d := fixtureDetail(2, "新精灵", "")
	delete(d, "forms")
	p := proposal(t, local, fixtureSource(t, object{"99": d}))
	if p.Stats.AddedMonsters != 0 || !hasIssue(p, "new_form_identity_not_proven") {
		t.Fatal("missing forms treated as explicitly empty")
	}
}
