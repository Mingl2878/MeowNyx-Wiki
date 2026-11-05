package officialdex

import (
	"bytes"
	"testing"
)

func TestLegendSourceDoesNotGainUnprovenDefaultRelation(t *testing.T) {
	m := fixtureMonster(595, 1, "银月狼王", "default")
	local := fixtureLocal(t, []any{m}, []any{fixtureMove(5932, "月蚀", 60)}, object{"银月狼王": object{"monster_id": 595, "skills": []any{object{"name": "月蚀", "source": "传说", "desc": "旧描述", "type": "物攻", "element": "普通"}}}})
	d := fixtureDetail(1, "银月狼王", "")
	asObject(d["sk"])["s"] = []any{fixtureSkill("月蚀", "75"), fixtureSkill("月蚀", "75")}
	source := fixtureSource(t, object{"600": d})
	p := proposal(t, local, source)
	rows := asObject(decodeObject(t, p.Files.Wiki)["银月狼王"])["skills"].([]any)
	if len(rows) != 1 || text(asObject(rows[0])["source"]) != "传说" {
		t.Fatalf("legend gained a default duplicate: %+v", rows)
	}
	if hasIssue(p, "legend_source_mapping") || hasIssue(p, "local_learning_preserved") {
		t.Fatal("authorized legend classification requested review again")
	}
	if power, _ := integer(findID(t, p.Files.Moves, 5932)["power"]); power != 75 {
		t.Fatal("uncertain learning classification blocked valid master move update")
	}
	if text(asObject(rows[0])["desc"]) != "新描述" {
		t.Fatal("preserved legend row did not follow master description")
	}
	second := proposal(t, p.Files, source)
	if len(second.Changes) != 0 || !bytes.Equal(p.Files.Wiki, second.Files.Wiki) || !bytes.Equal(p.Files.Moves, second.Files.Moves) || !bytes.Equal(p.Files.Monsters, second.Files.Monsters) {
		t.Fatal("legend reconciliation is not idempotent")
	}
}

func TestLegendAllowsExplicitBloodlineAndStoneWithoutReordering(t *testing.T) {
	m := fixtureMonster(595, 1, "银月狼王", "default")
	local := fixtureLocal(t, []any{m}, []any{fixtureMove(5932, "月蚀", 60), fixtureMove(3, "冲撞", 60)}, object{"银月狼王": object{"monster_id": 595, "skills": []any{object{"name": "冲撞", "source": "默认"}, object{"name": "月蚀", "source": "传说"}}}})
	d := fixtureDetail(1, "银月狼王", "")
	sk := asObject(d["sk"])
	sk["s"] = []any{fixtureSkill("月蚀", "75")}
	sk["b"] = []any{fixtureSkill("月蚀", "75")}
	sk["t"] = []any{fixtureSkill("月蚀", "75")}
	p := proposal(t, local, fixtureSource(t, object{"600": d}))
	rows := asObject(decodeObject(t, p.Files.Wiki)["银月狼王"])["skills"].([]any)
	want := []string{"月蚀\x00传说", "月蚀\x00血脉", "月蚀\x00技能石"}
	if len(rows) != len(want) {
		t.Fatalf("explicit multi-source relations collapsed: %+v", rows)
	}
	for i, v := range rows {
		if learningKey(asObject(v)) != want[i] {
			t.Fatalf("learning order/source changed at %d: %+v", i, rows)
		}
	}
	if hasIssue(p, "legend_source_mapping") {
		t.Fatal("authorized legend equivalence still treated as ambiguity")
	}
}

func TestLegendGuardDoesNotDeleteExistingDefaultOrDeduplicateByName(t *testing.T) {
	m := fixtureMonster(595, 1, "银月狼王", "default")
	local := fixtureLocal(t, []any{m}, []any{fixtureMove(5932, "月蚀", 60)}, object{"银月狼王": object{"monster_id": 595, "skills": []any{object{"name": "月蚀", "source": "默认"}, object{"name": "月蚀", "source": "传说"}}}})
	d := fixtureDetail(1, "银月狼王", "")
	asObject(d["sk"])["s"] = []any{fixtureSkill("月蚀", "75")}
	p := proposal(t, local, fixtureSource(t, object{"600": d}))
	rows := asObject(decodeObject(t, p.Files.Wiki)["银月狼王"])["skills"].([]any)
	if len(rows) != 2 || text(asObject(rows[0])["source"]) != "默认" || text(asObject(rows[1])["source"]) != "传说" {
		t.Fatal("pre-existing explicit relationships were removed or reordered")
	}
	if hasIssue(p, "legend_source_mapping") {
		t.Fatal("an already present default was reported as an attempted addition")
	}
}

func TestLegendGuardIsPerMonsterNotGlobalPerSkill(t *testing.T) {
	local := fixtureLocal(t, []any{fixtureMonster(595, 1, "银月狼王", "default"), fixtureMonster(596, 2, "另一精灵", "default")}, []any{fixtureMove(5932, "月蚀", 60)}, object{"银月狼王": object{"monster_id": 595, "skills": []any{object{"name": "月蚀", "source": "传说"}}}, "另一精灵": object{"monster_id": 596, "skills": []any{}}})
	d1, d2 := fixtureDetail(1, "银月狼王", ""), fixtureDetail(2, "另一精灵", "")
	asObject(d1["sk"])["s"] = []any{fixtureSkill("月蚀", "75")}
	asObject(d2["sk"])["s"] = []any{fixtureSkill("月蚀", "75")}
	p := proposal(t, local, fixtureSource(t, object{"600": d1, "601": d2}))
	wiki := decodeObject(t, p.Files.Wiki)
	rows := asObject(wiki["另一精灵"])["skills"].([]any)
	if len(rows) != 1 || text(asObject(rows[0])["source"]) != "默认" {
		t.Fatal("another monster's explicit default was suppressed")
	}
	rows = asObject(wiki["银月狼王"])["skills"].([]any)
	if len(rows) != 1 || text(asObject(rows[0])["source"]) != "传说" {
		t.Fatal("legend monster gained default")
	}
}
