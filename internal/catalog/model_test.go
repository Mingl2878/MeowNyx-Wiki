package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func readLegacyFixture(t *testing.T) LegacyFiles {
	t.Helper()
	var f LegacyFiles
	missing := 0
	for _, p := range []struct {
		name string
		out  *[]byte
	}{{"monsters.json", &f.Monsters}, {"moves.json", &f.Moves}, {"types.json", &f.Types}, {"wiki_monster_data.json", &f.Wiki}} {
		b, e := os.ReadFile(filepath.Join("..", "..", "data", p.name))
		if os.IsNotExist(e) {
			missing++
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		*p.out = b
	}
	if missing == 0 {
		return f
	}
	b, err := os.ReadFile(filepath.Join("..", "..", "data", "catalog.json"))
	if os.IsNotExist(err) && missing == 4 {
		t.Skip("optional source fixture is entirely absent")
	}
	if err != nil {
		t.Fatalf("incomplete source fixture (%d legacy files missing): %v", missing, err)
	}
	c, err := Parse(b)
	if err != nil {
		t.Fatalf("invalid canonical fixture: %v", err)
	}
	f, err = ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// TestEmitJSProjectionFixture is a read-only bridge for the Node projection
// parity test. It emits in-memory JSON to stdout only when explicitly requested.
func TestEmitJSProjectionFixture(t *testing.T) {
	if os.Getenv("CATALOG_JS_FIXTURE") != "1" {
		t.Skip("Node parity bridge not requested")
	}
	var real *Catalog
	if b, err := os.ReadFile(filepath.Join("..", "..", "data", "catalog.json")); err == nil {
		var parseErr error
		real, parseErr = Parse(b)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
	} else if os.IsNotExist(err) {
		real = mustImport(t, readLegacyFixture(t))
	} else {
		t.Fatal(err)
	}
	synthetic := testCatalog()
	synthetic.Monsters[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "9001", Identity: "小甲", Extensions: Extensions{"revision": json.RawMessage(`{"v":2}`)}}
	synthetic.Traits[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "trait-a", Identity: "同名特性/第一份"}
	synthetic.Types[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "type-1", Identity: "普通"}
	synthetic.Skills[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "skill-7", Identity: "未知威力"}
	synthetic.Learnsets[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "learnset-1", Identity: "小甲"}
	synthetic.Monsters[0].Aliases = []string{"旧甲名"}
	synthetic.Monsters[0].Extensions = Extensions{"legacy": json.RawMessage(`{"localized":{"zh":{"other_label":"旧名"}},"unknown":{"__proto__":{"polluted":true},"a/b":{"~key":1}}}`)}
	synthetic.Skills[0].Extensions = Extensions{"legacy": json.RawMessage(`{"alt_power_total":999,"counter_power_multiplier":5,"display_rule":{"symbol":"?"}}`)}
	synthetic.Learnsets[0].Extensions = Extensions{"legacy_skills": json.RawMessage(`{"0":{"desc":"独立旧描述","extra":{"a/b":{"~key":1}}}}`), "legacy_skill_omit": json.RawMessage(`{"0":["element","extra/a~1b/~0key"]}`)}
	fixtures := []object{}
	for _, c := range []*Catalog{real, synthetic} {
		f := mustLegacy(t, c)
		b, err := Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, object{"catalog": b, "legacy": rawJSON(object{"monsters": f.Monsters, "moves": f.Moves, "types": f.Types, "wiki": f.Wiki})})
	}
	// Include a genuine v1 payload so Node tests compare the migration boundary,
	// not only already-upgraded Go values.
	var v1 object
	json.Unmarshal(mustJSON(synthetic), &v1)
	v1["schema_version"] = rawJSON(1)
	var oldMonsters []object
	json.Unmarshal(v1["monsters"], &oldMonsters)
	for _, m := range oldMonsters {
		delete(m, "evolution_members")
		delete(m, "leader_of_id")
	}
	v1["monsters"] = rawJSON(oldMonsters)
	oldBytes := rawJSON(v1)
	upgraded, err := Parse(oldBytes)
	if err != nil {
		t.Fatal(err)
	}
	f := mustLegacy(t, upgraded)
	fixtures = append(fixtures, object{"catalog": oldBytes, "legacy": rawJSON(object{"monsters": f.Monsters, "moves": f.Moves, "types": f.Types, "wiki": f.Wiki})})
	fmt.Printf("CATALOG_JS_FIXTURE=%s\n", rawJSON(fixtures))
}

func TestLegacyEquivalentNumericSpellings(t *testing.T) {
	f := mustLegacy(t, testCatalog())
	var rows []object
	if err := json.Unmarshal(f.Moves, &rows); err != nil {
		t.Fatal(err)
	}
	rows[0]["energy_cost"] = json.RawMessage(`0.0`)
	rows[1]["power"] = json.RawMessage(`0e0`)
	f.Moves = mustJSON(rows)
	c := mustImport(t, f)
	if c.Skills[0].EnergyCost != 0 || c.Skills[1].Power == nil || *c.Skills[1].Power != 0 {
		t.Fatal("numeric spellings changed meaning")
	}
	if !equalJSON(json.RawMessage(`9007199254740993`), json.RawMessage(`9007199254740993.0`)) || equalJSON(json.RawMessage(`9007199254740993`), json.RawMessage(`9007199254740992`)) {
		t.Fatal("large JSON numbers lost precision")
	}
}

func testCatalog() *Catalog {
	zero := float64(0)
	combo := 2
	return &Catalog{
		SchemaVersion: SchemaVersion,
		Types:         []Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{13}, ResistantTo: []int{}}, {ID: 13, Code: "Flying", Name: "翼", VulnerableTo: []int{}, ResistantTo: []int{1}}},
		Traits:        []Trait{{ID: "a", Name: "同名特性", Description: "第一份完整定义"}, {ID: "b", Name: "同名特性", Description: "第二份完整定义"}},
		Monsters: []Monster{
			{ID: 1, Name: "小甲", DexNumber: 1, TypeIDs: []int{1}, TraitID: "a", Stats: Stats{HP: 100, PhyAtk: 80, PhyDef: 70, MagAtk: 60, MagDef: 50, Speed: 90}, Images: Images{Avatar: "甲头像.png", Portrait: "wiki/甲立绘.png"}, Form: "default", FormCategory: "无多形态", EvolutionMembers: []int{1, 2}, EvolutionStage: "基础形态"},
			{ID: 2, Name: "小乙", DexNumber: 2, TypeIDs: []int{13, 1}, TraitID: "b", Stats: Stats{HP: 110, PhyAtk: 90, PhyDef: 80, MagAtk: 70, MagDef: 60, Speed: 100}, Images: Images{Avatar: "乙头像.png"}, Form: "default", FormCategory: "无多形态", EvolutionMembers: []int{1, 2}, EvolutionStage: "高级形态", EvolvesFromID: 1},
		},
		Skills:     []Skill{{ID: 7, Name: "未知威力", Description: "不确定威力原文。", TypeID: 1, Category: "Status", EnergyCost: 0, Power: nil, Season: "S1"}, {ID: 9, Name: "零威力", Description: "零威力也是已知威力。", TypeID: 13, Category: "Physical Attack", EnergyCost: 2, Power: &zero, Season: "S2"}},
		SkillRules: []SkillRule{{SkillID: 9, BaseCombo: &combo, PowerFormula: "speed_diff"}},
		Learnsets:  []Learnset{{MonsterID: 1, Mode: "own", Skills: []LearnedSkill{{SkillID: 7, Source: "默认"}, {SkillID: 9, Source: "传说"}, {SkillID: 9, Source: "血脉"}, {SkillID: 9, Source: "血脉"}}}, {MonsterID: 2, Mode: "inherit", FromID: 1, Skills: []LearnedSkill{}}},
	}
}
func mustJSON(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}
func mustLegacy(t *testing.T, c *Catalog) LegacyFiles {
	t.Helper()
	f, e := ExportLegacy(c)
	if e != nil {
		t.Fatal(e)
	}
	return f
}
func mustImport(t *testing.T, f LegacyFiles) *Catalog {
	t.Helper()
	c, e := ImportLegacy(f)
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func assertJSONEqual(t *testing.T, a, b []byte) {
	t.Helper()
	var x, y any
	if e := json.Unmarshal(a, &x); e != nil {
		t.Fatal(e)
	}
	if e := json.Unmarshal(b, &y); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("JSON differs\nwant: %s\ngot:  %s", a, b)
	}
}

func TestModelMemoryRoundTrip(t *testing.T) {
	c := testCatalog()
	b, e := Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(b, []byte("localized")) {
		t.Fatal("localized leaked into core")
	}
	if bytes.Contains(b, []byte("\n")) {
		t.Fatal("Marshal should be compact")
	}
	p, e := Parse(b)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(c, p) {
		t.Fatal("typed roundtrip changed data")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	if e = os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
	read, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = Parse(read); e != nil {
		t.Fatal(e)
	}
}
func TestUnknownSchemaFieldsPreserved(t *testing.T) {
	var raw map[string]any
	json.Unmarshal(mustJSON(testCatalog()), &raw)
	raw["future_catalog"] = map[string]any{"a": []any{1, "hello", nil}}
	monster := raw["monsters"].([]any)[0].(map[string]any)
	monster["future_monster"] = true
	monster["images"].(map[string]any)["licence"] = "local"
	monster["stats"].(map[string]any)["provenance"] = "manual"
	skill := raw["skills"].([]any)[0].(map[string]any)
	skill["future_skill"] = 7
	row := raw["learnsets"].([]any)[0].(map[string]any)["skills"].([]any)[0].(map[string]any)
	row["future_row"] = "preserved"
	c, e := Parse(mustJSON(raw))
	if e != nil {
		t.Fatal(e)
	}
	for _, ext := range []Extensions{c.Extensions, c.Monsters[0].Extensions, c.Monsters[0].Images.Extensions, c.Monsters[0].Stats.Extensions, c.Skills[0].Extensions, c.Learnsets[0].Skills[0].Extensions} {
		if len(ext) == 0 {
			t.Fatal("unknown schema field discarded")
		}
	}
	b, e := Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	again, e := Parse(b)
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(c, again) {
		t.Fatal("unknown extension values not stable")
	}
}
func TestRealFixtureRoundTrip(t *testing.T) {
	f := readLegacyFixture(t)
	c := mustImport(t, f)
	b, e := Marshal(c)
	if e != nil {
		t.Fatal(e)
	}
	parsed, e := Parse(b)
	if e != nil {
		t.Fatal(e)
	}
	out := mustLegacy(t, parsed)
	again := mustImport(t, out)
	b2, e := Marshal(again)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(b, b2) {
		t.Fatal("catalog not stable after legacy roundtrip")
	}
	var monsters, writtenMonsters, skills, writtenSkills, types, writtenTypes []object
	json.Unmarshal(f.Monsters, &monsters)
	json.Unmarshal(out.Monsters, &writtenMonsters)
	json.Unmarshal(f.Moves, &skills)
	json.Unmarshal(out.Moves, &writtenSkills)
	json.Unmarshal(f.Types, &types)
	json.Unmarshal(out.Types, &writtenTypes)
	if len(monsters) != len(c.Monsters) || len(skills) != len(c.Skills) || len(types) != len(writtenTypes) {
		t.Fatal("collection count changed")
	}
	// Full functional JSON equality, excluding only explicitly retired fields.
	for i, m := range monsters {
		for _, key := range []string{"default_legacy_type", "preferred_attack_style", "leader_potential"} {
			if key != "default_legacy_type" || equalJSON(m[key], m["main_type"]) {
				delete(m, key)
			}
		}
		assertJSONEqual(t, mustJSON(m), mustJSON(writtenMonsters[i]))
	}
	for i, s := range skills {
		delete(s, "statuses")
		assertJSONEqual(t, mustJSON(s), mustJSON(writtenSkills[i]))
	}
	assertJSONEqual(t, mustJSON(types), mustJSON(writtenTypes))
	var wiki, writtenWiki map[string]object
	json.Unmarshal(f.Wiki, &wiki)
	json.Unmarshal(out.Wiki, &writtenWiki)
	for key, row := range wiki {
		canonical := key
		if id, ok := map[string]int{"冬羽雀": 44, "岚鸟": 48, "雪绒鸟": 40, "霜翼领主": 49}[key]; ok {
			canonical = key + "（冬天的样子）"
			row["monster_id"] = mustJSON(id)
			var aliases []string
			json.Unmarshal(row["aliases"], &aliases)
			row["aliases"] = mustJSON(appendUnique(aliases, key))
		}
		assertJSONEqual(t, mustJSON(row), mustJSON(writtenWiki[canonical]))
	}
	// No deduplication of existing same-name+source rows and no source regrouping.
	rowsBefore, rowsAfter := 0, 0
	for _, row := range wiki {
		var rows []object
		json.Unmarshal(row["skills"], &rows)
		rowsBefore += len(rows)
	}
	for _, l := range c.Learnsets {
		rowsAfter += len(l.Skills)
	}
	if rowsBefore != rowsAfter {
		t.Fatal("learning rows were lost")
	}
	definitions := map[string]bool{}
	for _, m := range monsters {
		var tr object
		json.Unmarshal(m["trait"], &tr)
		var name, desc string
		if e := localized(tr, &name, &desc); e != nil {
			t.Fatal(e)
		}
		definitions[name+"\x00"+desc] = true
	}
	if len(definitions) != len(c.Traits) {
		t.Fatal("traits not deduplicated by full definition")
	}
	original := len(f.Monsters) + len(f.Moves) + len(f.Types) + len(f.Wiki)
	compact := 0
	for _, data := range [][]byte{f.Monsters, f.Moves, f.Types, f.Wiki} {
		var buf bytes.Buffer
		if e := json.Compact(&buf, data); e != nil {
			t.Fatal(e)
		}
		compact += buf.Len()
	}
	if len(b) >= compact/2 {
		t.Fatalf("catalog insufficiently compact: %d / %d", len(b), compact)
	}
	t.Logf("monsters=%d skills=%d traits=%d types=%d learnsets=%d learning_rows=%d legacy=%d compact_legacy=%d catalog=%d reduction=%.1f%%", len(c.Monsters), len(c.Skills), len(c.Traits), len(c.Types), len(c.Learnsets), rowsAfter, original, compact, len(b), 100*(1-float64(len(b))/float64(original)))
}
