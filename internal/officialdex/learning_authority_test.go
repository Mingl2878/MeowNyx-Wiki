package officialdex

import "testing"

func TestOwnParentsCorrectedBeforeComparingInheritAndLegend(t *testing.T) {
	parent := fixtureMonster(10, 10, "共同父", "default")
	child := fixtureMonster(11, 11, "相同子", "default")
	different := fixtureMonster(12, 12, "不同子", "default")
	grandchild := fixtureMonster(13, 13, "继承不同子", "default")
	for _, m := range []object{child, different, grandchild} {
		m["learnset_mode"], m["learnset_inherits_from_id"] = "inherit", 10
	}
	grandchild["learnset_inherits_from_id"] = 12
	local := canonicalFixture(t, []any{parent, child, different, grandchild}, []any{fixtureMove(3, "冲撞", 60), fixtureMove(4, "多余", 60), fixtureMove(5, "独有", 60)}, object{
		"共同父":   object{"monster_id": 10, "skills": []any{object{"name": "冲撞", "source": "传说"}, object{"name": "多余", "source": "技能石"}}},
		"相同子":   object{"monster_id": 11, "skills": []any{}},
		"不同子":   object{"monster_id": 12, "skills": []any{}},
		"继承不同子": object{"monster_id": 13, "skills": []any{}},
	})
	d1, d2 := fixtureDetail(10, "共同父", ""), fixtureDetail(11, "相同子", "")
	d3, d4 := fixtureDetail(12, "不同子", ""), fixtureDetail(13, "继承不同子", "")
	for _, d := range []object{d3, d4} {
		asObject(d["sk"])["s"] = []any{fixtureSkill("独有", "45")}
	}
	// The source order deliberately puts grandchildren and children first.
	source := fixtureSource(t, object{"1": d4, "2": d2, "3": d3, "99": d1})
	p := proposal(t, local, source)
	for _, id := range []int{11, 13} {
		if findID(t, p.Files.Monsters, id)["learnset_mode"] != "inherit" {
			t.Fatalf("parent-first comparison detached equal child %d", id)
		}
	}
	if findID(t, p.Files.Monsters, 12)["learnset_mode"] != "own" {
		t.Fatal("true difference not detached")
	}
	wiki := decodeObject(t, p.Files.Wiki)
	parentRows := asObject(wiki["共同父"])["skills"].([]any)
	if len(parentRows) != 1 || text(asObject(parentRows[0])["name"]) != "冲撞" || text(asObject(parentRows[0])["source"]) != "传说" {
		t.Fatal("child polluted parent or legend classification lost")
	}
	foundBefore := false
	for _, change := range p.Changes {
		if change.Entity == "wiki" && change.ID == 12 && change.Field == "skills" {
			foundBefore = true
			if !equal(change.Before, []any{object{"name": "冲撞", "source": "传说"}, object{"name": "多余", "source": "技能石"}}) || !equal(change.After, []any{object{"name": "独有", "source": "默认"}}) {
				t.Fatalf("inherit diff lacks before effective surface: %+v", change)
			}
		}
	}
	if !foundBefore {
		t.Fatal("missing complete relation diff")
	}
	second := proposal(t, exportCanonical(t, importProposal(t, p)), source)
	if len(second.Changes) != 0 {
		t.Fatalf("learning correction not canonical-idempotent: %+v", second.Changes)
	}
}

func TestOfficialLearningOrderPreservesValidLocalDuplicatesAndThreeSources(t *testing.T) {
	m := fixtureMonster(1, 1, "小猫", "default")
	local := canonicalFixture(t, []any{m}, []any{fixtureMove(3, "冲撞", 60), fixtureMove(4, "保留", 60), fixtureMove(5, "移出", 60)}, object{"小猫": object{"monster_id": 1, "skills": []any{
		object{"name": "保留", "source": "血脉"},
		object{"name": "冲撞", "source": "默认", "custom_row": "first"},
		object{"name": "冲撞", "source": "传说", "custom_row": "legend"},
		object{"name": "冲撞", "source": "默认", "custom_row": "duplicate"},
		object{"name": "移出", "source": "传说"},
		object{"name": "冲撞", "source": "技能石"},
	}}})
	d := fixtureDetail(1, "小猫", "")
	asObject(d["sk"])["s"] = []any{fixtureSkill("冲撞", "75"), fixtureSkill("冲撞", "75")}
	asObject(d["sk"])["b"] = []any{fixtureSkill("保留", "75")}
	asObject(d["sk"])["t"] = []any{fixtureSkill("冲撞", "75")}
	source := fixtureSource(t, object{"99": d})
	p := proposal(t, local, source)
	rows := asObject(decodeObject(t, p.Files.Wiki)["小猫"])["skills"].([]any)
	want := []string{"冲撞\x00默认", "冲撞\x00传说", "冲撞\x00默认", "保留\x00血脉", "冲撞\x00技能石"}
	if len(rows) != len(want) {
		t.Fatalf("duplicate preservation incorrect: %+v", rows)
	}
	for i, key := range want {
		if learningKey(asObject(rows[i])) != key {
			t.Fatalf("official order/group mismatch at %d: %+v", i, rows)
		}
	}
	if text(asObject(rows[2])["custom_row"]) != "duplicate" || localName(findID(t, p.Files.Moves, 5)) != "移出" {
		t.Fatal("row extension or master skill lost")
	}
	c := importProposal(t, p)
	if second := proposal(t, exportCanonical(t, c), source); len(second.Changes) != 0 {
		t.Fatalf("duplicate order changed on repeat: %+v", second.Changes)
	}
}

func TestEmptyOrCorruptOfficialSourceNeverClearsInheritedOrOwnLearning(t *testing.T) {
	for _, mode := range []string{"own", "inherit"} {
		for _, corrupt := range []string{"empty", "missing_group", "conflict", "invalid_move"} {
			t.Run(mode+"/"+corrupt, func(t *testing.T) {
				parent := fixtureMonster(10, 10, "本地父", "default")
				m := fixtureMonster(11, 11, "目标", "default")
				m["learnset_mode"] = mode
				if mode == "inherit" {
					m["learnset_inherits_from_id"] = 10
				}
				rows := []any{object{"name": "冲撞", "source": "传说"}}
				local := fixtureLocal(t, []any{parent, m}, []any{fixtureMove(3, "冲撞", 60)}, object{"本地父": object{"monster_id": 10, "skills": clone(rows)}, "目标": object{"monster_id": 11, "skills": clone(rows)}})
				d := fixtureDetail(11, "目标", "")
				sk := asObject(d["sk"])
				switch corrupt {
				case "empty":
					sk["s"] = []any{}
				case "missing_group":
					delete(sk, "b")
				case "conflict":
					sk["s"] = []any{fixtureSkill("冲撞", "75"), fixtureSkill("冲撞", "76")}
				case "invalid_move":
					sk["s"] = []any{object{"nm": "坏技能"}}
				}
				p := proposal(t, local, fixtureSource(t, object{"99": d}))
				out := findID(t, p.Files.Monsters, 11)
				if out["learnset_mode"] != mode || !equal(out["learnset_inherits_from_id"], m["learnset_inherits_from_id"]) {
					t.Fatal("unusable source changed inheritance")
				}
				got := asObject(decodeObject(t, p.Files.Wiki)["目标"])["skills"].([]any)
				if !equal(learningReport(got), learningReport(rows)) {
					t.Fatal("unusable source cleared/replaced learning")
				}
			})
		}
	}
}

func TestSelfOnlyEvolutionClearsPredecessorButEmptyStagePreservesKnown(t *testing.T) {
	m := fixtureMonster(10, 1, "小猫", "default")
	m["evolves_from_id"] = 9
	d := fixtureDetail(1, "小猫", "")
	d["s"] = ""
	d["evo"] = []any{object{"i": 99, "nm": "小猫", "fn": "小猫"}}
	p := proposal(t, fixtureLocal(t, []any{m}, []any{fixtureMove(3, "冲撞", 60)}, object{}), fixtureSource(t, object{"99": d}))
	if hasIssue(p, "source_relationship_unavailable") || !hasIssue(p, "stage_source_incomplete") {
		t.Fatal("information gap treated as manual correction")
	}
	got := findID(t, p.Files.Monsters, 10)
	if got["evolves_from_id"] != nil || !equal(got["evolution_members"], []any{10}) || got["evolution_stage"] != "高级形态" {
		t.Fatal("self-only source did not clear ordinary edge or empty stage changed known stage")
	}
}
