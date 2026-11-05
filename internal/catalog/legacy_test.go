package catalog

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestLegacyTypedSemantics(t *testing.T) {
	c := mustImport(t, mustLegacy(t, testCatalog()))
	if len(c.Traits) != 2 || c.Monsters[0].TraitID == c.Monsters[1].TraitID {
		t.Fatal("same-name different-description traits collapsed")
	}
	if c.Skills[0].Power != nil || c.Skills[1].Power == nil || *c.Skills[1].Power != 0 {
		t.Fatal("unknown/null became zero")
	}
	if c.Skills[1].Season != "S2" || len(c.SkillRules) != 1 || *c.SkillRules[0].BaseCombo != 2 || c.SkillRules[0].PowerFormula != "speed_diff" {
		t.Fatal("skill season/rules lost")
	}
	if len(c.Learnsets[0].Skills) != 4 || c.Learnsets[0].Skills[1].Source != "传说" || c.Learnsets[1].Mode != "inherit" || c.Learnsets[1].FromID != 1 {
		t.Fatal("source order, duplicates, or inheritance lost")
	}
	if c.Monsters[0].Images.Avatar != "甲头像.png" || c.Monsters[0].Images.Portrait != "wiki/甲立绘.png" || c.Monsters[1].Images.Portrait != "" {
		t.Fatal("portrait/avatar conflated")
	}
	f := mustLegacy(t, c)
	var monsters []object
	json.Unmarshal(f.Monsters, &monsters)
	monsters[0], monsters[1] = monsters[1], monsters[0]
	f.Monsters = mustJSON(monsters)
	reordered := mustImport(t, f)
	before := indexCatalog(c)
	after := indexCatalog(reordered)
	for id, m := range before.monsters {
		if after.monsters[id].TraitID != m.TraitID {
			t.Fatal("trait IDs depend on import ordering")
		}
	}
}
func TestLegacyUnknownFieldsAndSourceRefs(t *testing.T) {
	f := mustLegacy(t, testCatalog())
	var monsters, skills, types []object
	var wiki map[string]object
	json.Unmarshal(f.Monsters, &monsters)
	json.Unmarshal(f.Moves, &skills)
	json.Unmarshal(f.Types, &types)
	json.Unmarshal(f.Wiki, &wiki)
	ref := obj("provider", "tencent-compendium", "id", "upstream-999", "identity", "小甲（原始）", "future_ref", obj("version", 3))
	monsters[0]["_source_ref"] = mustJSON(ref)
	skills[0]["_source_ref"] = mustJSON(obj("provider", "tencent-compendium", "id", "skill-998", "identity", "未知威力"))
	types[0]["_source_ref"] = mustJSON(obj("provider", "tencent-compendium", "id", "type-99", "identity", "普通"))
	wiki["小甲"]["_source_ref"] = mustJSON(ref)
	monsters[0]["unknown_local"] = mustJSON(obj("keep", []any{nil, 1, "x"}))
	monsters[0]["localized"] = mustJSON(obj("zh", obj("name", "小甲", "historical_label", "要保留"), "en", obj("name", "A")))
	monsters[0]["trait"] = mustJSON(obj("localized", obj("zh", obj("name", "同名特性", "description", "第一份完整定义", "extra_trait", true)), "future_trait", 42))
	monsters[0]["main_type"] = mustJSON(obj("id", 1, "name", "Normal", "localized", obj("zh", "普通", "en", "Normal"), "vulnerable_to", []string{"Flying"}, "resistant_to", []string{}, "icon", "icon.png"))
	monsters[0]["default_legacy_type"] = monsters[0]["main_type"]
	monsters[0]["preferred_attack_style"] = mustJSON("Physical")
	monsters[0]["leader_potential"] = mustJSON(true)
	skills[0]["statuses"] = mustJSON([]string{"retired"})
	skills[0]["future_display_rule"] = mustJSON(obj("symbol", "?", "kind", "reviewed"))
	skills[0]["alt_power_total"] = mustJSON(999)
	skills[0]["counter_power_multiplier"] = mustJSON(5)
	types[0]["local_type_metadata"] = mustJSON([]int{9, 8, 7})
	wiki["小甲"]["extra_wiki"] = mustJSON(obj("key", "value"))
	var rows []object
	json.Unmarshal(wiki["小甲"]["skills"], &rows)
	rows[0]["desc"] = mustJSON("独立保留的旧描述")
	rows[0]["unknown_skill_data"] = mustJSON(obj("flag", true))
	delete(rows[0], "element")
	wiki["小甲"]["skills"] = mustJSON(rows)
	f = LegacyFiles{mustJSON(monsters), mustJSON(skills), mustJSON(types), mustJSON(wiki)}
	c := mustImport(t, f)
	b, e := Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(b, []byte("preferred_attack_style")) || bytes.Contains(b, []byte("leader_potential")) || bytes.Contains(b, []byte("statuses")) || bytes.Contains(b, []byte("default_legacy_type")) {
		t.Fatal("retired fields persisted")
	}
	if c.Monsters[0].ID != 1 || c.Monsters[0].SourceRef.ID != "upstream-999" || c.Learnsets[0].SourceRef.Identity != "小甲（原始）" {
		t.Fatal("upstream identity replaced local identity")
	}
	if len(c.SkillRules) != 1 || c.SkillRules[0].SkillID != 9 {
		t.Fatal("inferred rule from old alt/counter hint")
	}
	p, e := Parse(b)
	if e != nil {
		t.Fatal(e)
	}
	out := mustLegacy(t, p)
	delete(monsters[0], "preferred_attack_style")
	delete(monsters[0], "leader_potential")
	delete(monsters[0], "default_legacy_type")
	delete(skills[0], "statuses")
	assertJSONEqual(t, mustJSON(monsters), out.Monsters)
	assertJSONEqual(t, mustJSON(skills), out.Moves)
	assertJSONEqual(t, mustJSON(types), out.Types)
	assertJSONEqual(t, mustJSON(wiki), out.Wiki)
}
func TestLegacyAliasMergeAndConflict(t *testing.T) {
	f := mustLegacy(t, testCatalog())
	var wiki map[string]object
	json.Unmarshal(f.Wiki, &wiki)
	extra := cloneObject(wiki["小甲"])
	var rows []object
	json.Unmarshal(extra["skills"], &rows)
	extra["skills"] = mustJSON(rows[:1])
	wiki["旧甲名"] = extra
	f.Wiki = mustJSON(wiki)
	c := mustImport(t, f)
	if len(c.Learnsets[0].Skills) != 4 || !reflect.DeepEqual(c.Monsters[0].Aliases, []string{"旧甲名"}) {
		t.Fatal("alias merge lost original rows/alias")
	}
	rows[0]["desc"] = mustJSON("冲突")
	extra["skills"] = mustJSON(rows[:1])
	wiki["旧甲名"] = extra
	f.Wiki = mustJSON(wiki)
	if _, e := ImportLegacy(f); e == nil {
		t.Fatal("alias conflict silently accepted")
	}
}
func TestLegacyNormalizedIdentity(t *testing.T) {
	for _, pair := range [][2]string{{"权杖-Ⅱ", "权杖_II"}, {"权杖-Ⅴ", "权杖-V"}, {"圣剑-Ⅹ", "圣剑_X"}, {"　Ａ—ⅱ\u200b ", "A-II"}, {"雪绒鸟（春天的样子）", "雪绒鸟(春天的样子)"}} {
		if normalizeName(pair[0]) != normalizeName(pair[1]) {
			t.Errorf("identity mismatch %q %q", pair[0], pair[1])
		}
	}
	if normalizeName("雪绒鸟（春天的样子）") == normalizeName("雪绒鸟（冬天的样子）") {
		t.Fatal("form suffix collapsed")
	}
	c := testCatalog()
	c.Monsters[0].Name = "权杖-Ⅱ"
	f := mustLegacy(t, c)
	var wiki map[string]object
	json.Unmarshal(f.Wiki, &wiki)
	wiki["权杖_II"] = wiki["权杖-Ⅱ"]
	delete(wiki, "权杖-Ⅱ")
	delete(wiki["权杖_II"], "monster_id")
	f.Wiki = mustJSON(wiki)
	imported := mustImport(t, f)
	if imported.Monsters[0].Aliases[0] != "权杖_II" {
		t.Fatal("historical alias lost")
	}
}
func TestRealSeasonalFormsAndHistoricalPlaceholder(t *testing.T) {
	c := mustImport(t, readLegacyFixture(t))
	x := indexCatalog(c)
	winter := map[int]string{40: "雪绒鸟", 44: "冬羽雀", 48: "岚鸟", 49: "霜翼领主"}
	for id, name := range winter {
		m := x.monsters[id]
		if m == nil || m.Name != name || m.Form != "本来的样子" || m.FormCategory != "主形态" {
			t.Fatalf("confirmed original-form mapping changed %d", id)
		}
		for _, expected := range []string{name, name + "（冬天的样子）"} {
			found := false
			for _, alias := range m.Aliases {
				if alias == expected {
					found = true
				}
			}
			if !found {
				t.Fatalf("historical winter alias missing %s", expected)
			}
		}
	}
	for _, pair := range [][2]int{{41, 40}, {42, 40}, {43, 40}, {45, 44}, {46, 44}, {47, 44}, {50, 48}, {51, 48}, {52, 48}, {53, 49}, {54, 49}, {55, 49}} {
		if x.monsters[pair[0]].MainFormID != pair[1] {
			t.Fatalf("seasonal main relation lost %v", pair)
		}
	}
	// One-time client calibration supplies explicit same-season chains; Tencent's
	// acknowledged self-only snapshot must no longer erase these ordinary links.
	for _, chain := range [][4]int{{40, 44, 48, 49}, {41, 45, 50, 53}, {42, 46, 51, 54}, {43, 47, 52, 55}} {
		for i, id := range chain {
			m := x.monsters[id]
			if len(m.EvolutionMembers) != 3 {
				t.Fatalf("calibrated seasonal members missing %d", id)
			}
			for j, member := range m.EvolutionMembers {
				if member != chain[j] {
					t.Fatalf("wrong seasonal member %d", id)
				}
			}
			want := 0
			if i == 1 || i == 2 {
				want = chain[i-1]
			}
			if m.EvolvesFromID != want {
				t.Fatalf("calibrated ordinary predecessor wrong %d", id)
			}
		}
	}
	for _, pair := range [][2]int{{49, 48}, {53, 50}, {54, 51}, {55, 52}} {
		if x.monsters[pair[0]].LeaderOfID != pair[1] {
			t.Fatalf("explicit seasonal leader pairing lost %v", pair)
		}
	}
	for _, id := range []int{40, 41, 42, 43, 44, 45, 46, 47, 48, 50, 51, 52} {
		if x.learnsets[id].Mode != "own" || x.learnsets[id].FromID != 0 {
			t.Fatalf("season own learning surface changed %d", id)
		}
	}
	for _, pair := range [][2]int{{49, 48}, {53, 50}, {54, 51}, {55, 52}} {
		if x.learnsets[pair[0]].Mode != "inherit" || x.learnsets[pair[0]].FromID != pair[1] {
			t.Fatalf("season inheritance changed %v", pair)
		}
	}
	// The shipped record has graduated; only test-local historical records are
	// required to retain the old placeholder/empty-learning restrictions.
	m := x.monsters[619]
	if m == nil || m.Placeholder || m.DexNumber != 470 || m.Season != "S5" || m.EvolvesFromID != 624 || m.Images.Portrait == "" || m.DefaultLevel != 99 || !m.LevelConfigurable || !reflect.DeepEqual(m.TypeIDs, []int{8, 15}) || x.learnsets[619].Mode != "own" || len(x.learnsets[619].Skills) != 45 {
		t.Fatal("graduated Mingulong metadata, own learning or preserved controls lost")
	}
	if !reflect.DeepEqual(m.Stats, Stats{HP: 118, PhyAtk: 128, PhyDef: 81, MagAtk: 42, MagDef: 63, Speed: 70}) {
		t.Fatal("approved complete Mingulong stats changed")
	}
	before := mustJSON(c)
	for _, types := range [][]int{{0}, {8, 15}} {
		historical, err := Parse(before)
		if err != nil {
			t.Fatal(err)
		}
		hx := indexCatalog(historical)
		// Legacy projection carries used traits only; restore the approved old
		// definition inside this historical fixture, not in production data.
		if hx.traits["trait-e6337fff38ccbd5fe07994daac0d1075"] == nil {
			historical.Traits = append(historical.Traits, Trait{ID: "trait-e6337fff38ccbd5fe07994daac0d1075", Name: "资料待补充", Description: "初始等级+39，回合结束时等级-10，低于80级时受到伤害+40%。"})
		}
		*hx.monsters[619] = Monster{ID: 619, Name: "冥古龙", TypeIDs: types, TraitID: "trait-e6337fff38ccbd5fe07994daac0d1075", Stats: Stats{HP: 118, PhyAtk: 128, PhyDef: 81, MagAtk: 42, MagDef: 63, Speed: 70}, Images: Images{}, Form: "default", FormCategory: "无多形态", EvolutionStage: "待定", EvolutionMembers: []int{619}, DefaultLevel: 99, LevelConfigurable: true, Placeholder: true, DataNote: "历史用户授权等级测试占位；正式图片与学习面待补。"}
		*hx.learnsets[619] = Learnset{MonsterID: 619, Mode: "own", Skills: []LearnedSkill{}}
		if types[0] == 0 && hx.types[0] == nil {
			historical.Types = append(historical.Types, Type{ID: 0, Code: "None", Name: "无", VulnerableTo: []int{}, ResistantTo: []int{}, RuntimeOnly: true})
		}
		roundTrip := indexCatalog(mustImport(t, mustLegacy(t, historical)))
		old := roundTrip.monsters[619]
		if !old.Placeholder || old.DefaultLevel != 99 || !old.LevelConfigurable || old.DataNote == "" || !reflect.DeepEqual(old.TypeIDs, types) || old.Images.Avatar != "" || old.Images.Portrait != "" || roundTrip.learnsets[619].Skills == nil || len(roundTrip.learnsets[619].Skills) != 0 {
			t.Fatal("historical placeholder special data lost")
		}
	}
	if !bytes.Equal(before, mustJSON(c)) {
		t.Fatal("historical fixture changed current catalog")
	}
	// Legacy projection omits runtime-only types. Re-import needs a None
	// sentinel only while an actual record still uses it; approved Dragon/Ghost
	// 619 no longer does. Any present sentinel must retain its exact semantics.
	needsNone := false
	for _, monster := range c.Monsters {
		for _, typeID := range monster.TypeIDs {
			needsNone = needsNone || typeID == 0
		}
	}
	if (needsNone && x.types[0] == nil) || (x.types[0] != nil && (!x.types[0].RuntimeOnly || x.types[0].Code != "None")) {
		t.Fatal("required runtime None sentinel missing or invalid")
	}
	leader := false
	for _, typ := range c.Types {
		if typ.Code == "Leader" {
			leader = true
		}
	}
	if !leader {
		t.Fatal("Leader type discarded")
	}
	// Replacing the winter identity invalidates its special migration rather than
	// silently guessing from the unchanged portrait or another seasonal member.
	f := readLegacyFixture(t)
	var monsters []object
	json.Unmarshal(f.Monsters, &monsters)
	for _, r := range monsters {
		var id int
		json.Unmarshal(r["id"], &id)
		if id == 40 {
			r["localized"] = mustJSON(obj("zh", obj("name", "并非雪绒鸟")))
		}
	}
	f.Monsters = mustJSON(monsters)
	if _, e := ImportLegacy(f); e == nil {
		t.Fatal("winter migration guessed mismatched identity")
	}
}
