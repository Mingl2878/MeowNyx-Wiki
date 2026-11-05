package catalog

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestValidateRejectsInvalidCatalogs(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Catalog)
	}{
		{"future version", func(c *Catalog) { c.SchemaVersion = 3 }},
		{"empty monsters", func(c *Catalog) { c.Monsters = nil }},
		{"empty skills", func(c *Catalog) { c.Skills = nil }},
		{"empty types", func(c *Catalog) { c.Types = nil }},
		{"empty traits", func(c *Catalog) { c.Traits = nil }},
		{"empty learnsets", func(c *Catalog) { c.Learnsets = nil }},
		{"duplicate monster", func(c *Catalog) { c.Monsters[1].ID = 1 }},
		{"duplicate skill", func(c *Catalog) { c.Skills[1].ID = 7 }},
		{"duplicate type", func(c *Catalog) { c.Types[1].ID = 1 }},
		{"duplicate trait", func(c *Catalog) { c.Traits[1].ID = "a" }},
		{"duplicate learnset", func(c *Catalog) { c.Learnsets[1].MonsterID = 1 }},
		{"duplicate rules", func(c *Catalog) { c.SkillRules = append(c.SkillRules, c.SkillRules[0]) }},
		{"duplicate trait definition", func(c *Catalog) { c.Traits[1].Description = c.Traits[0].Description }},
		{"missing trait", func(c *Catalog) { c.Monsters[0].TraitID = "missing" }},
		{"missing monster type", func(c *Catalog) { c.Monsters[0].TypeIDs = []int{999} }},
		{"missing skill type", func(c *Catalog) { c.Skills[0].TypeID = 999 }},
		{"missing relation type", func(c *Catalog) { c.Types[0].VulnerableTo = []int{999} }},
		{"contradictory relation", func(c *Catalog) { c.Types[0].ResistantTo = []int{13} }},
		{"null relations", func(c *Catalog) { c.Types[0].ResistantTo = nil }},
		{"invalid None", func(c *Catalog) { c.Types[0].ID = 0 }},
		{"runtime-only other type", func(c *Catalog) { c.Types[0].RuntimeOnly = true }},
		{"missing learned skill", func(c *Catalog) { c.Learnsets[0].Skills[0].SkillID = 999 }},
		{"missing learnset monster", func(c *Catalog) { c.Learnsets[0].MonsterID = 999 }},
		{"missing rule skill", func(c *Catalog) { c.SkillRules[0].SkillID = 999 }},
		{"missing evolution", func(c *Catalog) { c.Monsters[0].EvolvesFromID = 999 }},
		{"evolution cycle", func(c *Catalog) { c.Monsters[0].EvolvesFromID = 2 }},
		{"inheritance cycle", func(c *Catalog) { c.Learnsets[0].Mode = "inherit"; c.Learnsets[0].FromID = 2 }},
		{"own must not inherit", func(c *Catalog) { c.Learnsets[0].FromID = 2 }},
		{"inherit missing parent", func(c *Catalog) { c.Learnsets[1].FromID = 999 }},
		{"unknown mode", func(c *Catalog) { c.Learnsets[0].Mode = "auto" }},
		{"null skills not empty", func(c *Catalog) { c.Learnsets[1].Skills = nil }},
		{"source not blank", func(c *Catalog) { c.Learnsets[0].Skills[0].Source = " " }},
		{"no types", func(c *Catalog) { c.Monsters[0].TypeIDs = nil }},
		{"duplicate types", func(c *Catalog) { c.Monsters[0].TypeIDs = []int{1, 1} }},
		{"invalid stat", func(c *Catalog) { c.Monsters[0].Stats.HP = -1 }},
		{"missing stat", func(c *Catalog) { c.Monsters[0].Stats.HP = 0 }},
		{"bad level", func(c *Catalog) { c.Monsters[0].DefaultLevel = 100 }},
		{"configurable no default", func(c *Catalog) { c.Monsters[0].LevelConfigurable = true }},
		{"placeholder no note", func(c *Catalog) { c.Monsters[0].Placeholder = true }},
		{"bad power", func(c *Catalog) { v := -1.0; c.Skills[0].Power = &v }},
		{"infinite power", func(c *Catalog) { v := math.Inf(1); c.Skills[0].Power = &v }},
		{"nan energy", func(c *Catalog) { c.Skills[0].EnergyCost = math.NaN() }},
		{"negative energy", func(c *Catalog) { c.Skills[0].EnergyCost = -1 }},
		{"bad combo", func(c *Catalog) { v := 0; c.SkillRules[0].BaseCombo = &v }},
		{"invalid category", func(c *Catalog) { c.Skills[0].Category = "unknown" }},
		{"empty source ref", func(c *Catalog) { c.Monsters[0].SourceRef = &SourceRef{Provider: "tencent-compendium", ID: "100"} }},
		{"variant no primary", func(c *Catalog) { c.Monsters[0].FormCategory = "变体形态" }},
		{"self main form", func(c *Catalog) { c.Monsters[0].FormCategory = "变体形态"; c.Monsters[0].MainFormID = 1 }},
		{"unknown main form", func(c *Catalog) { c.Monsters[0].FormCategory = "变体形态"; c.Monsters[0].MainFormID = 999 }},
		{"ambiguous alias", func(c *Catalog) { c.Monsters[0].Aliases = []string{"小乙"} }},
		{"invalid extension", func(c *Catalog) { c.Extensions = Extensions{"bad": json.RawMessage(`{"oops":`)} }},
		{"nil extension", func(c *Catalog) { c.Extensions = Extensions{"bad": nil} }},
		{"duplicate extension JSON", func(c *Catalog) { c.Extensions = Extensions{"bad": json.RawMessage(`{"x":1,"x":2}`)} }},
		{"core legacy override", func(c *Catalog) { c.Monsters[0].Extensions = Extensions{"legacy": json.RawMessage(`{"id":999}`)} }},
		{"core legacy omission", func(c *Catalog) { c.Skills[0].Extensions = Extensions{"legacy_omit": json.RawMessage(`["power"]`)} }},
		{"legacy patch wrong type", func(c *Catalog) { c.Skills[0].Extensions = Extensions{"legacy": json.RawMessage(`[]`)} }},
		{"legacy row out of range", func(c *Catalog) {
			c.Learnsets[0].Extensions = Extensions{"legacy_skills": json.RawMessage(`{"999":{"desc":"x"}}`)}
		}},
		{"legacy row ID override", func(c *Catalog) {
			c.Learnsets[0].Extensions = Extensions{"legacy_skills": json.RawMessage(`{"0":{"name":"other"}}`)}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := testCatalog()
			tc.change(c)
			if e := Validate(c); e == nil {
				t.Fatal("Validate accepted invalid catalog")
			}
			if _, e := Marshal(c); e == nil {
				t.Fatal("Marshal accepted invalid catalog")
			}
			if f, e := ExportLegacy(c); e == nil || len(f.Monsters) != 0 {
				t.Fatal("ExportLegacy returned success/partial data")
			}
		})
	}
	if e := Validate(nil); e == nil {
		t.Fatal("nil catalog accepted")
	}
}
func TestParseRejectsMalformedJSON(t *testing.T) {
	valid := mustJSON(testCatalog())
	for _, raw := range []string{"", `null`, `[]`, `{}`, `{"schema_version":1,"schema_version":2}`, string(valid) + ` {}`, strings.Repeat("[", 102) + strings.Repeat("]", 102)} {
		if c, e := Parse([]byte(raw)); e == nil || c != nil {
			t.Fatalf("accepted %q", raw)
		}
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"future schema", func(v map[string]any) { v["schema_version"] = 3 }},
		{"missing power", func(v map[string]any) { delete(v["skills"].([]any)[0].(map[string]any), "power") }},
		{"missing type ID", func(v map[string]any) { delete(v["skills"].([]any)[0].(map[string]any), "type_id") }},
		{"null energy", func(v map[string]any) { v["skills"].([]any)[0].(map[string]any)["energy_cost"] = nil }},
		{"fractional ID", func(v map[string]any) { v["monsters"].([]any)[0].(map[string]any)["id"] = 1.5 }},
		{"string number", func(v map[string]any) { v["skills"].([]any)[0].(map[string]any)["power"] = "0" }},
		{"null monster", func(v map[string]any) { v["monsters"].([]any)[0] = nil }},
		{"unknown conflict", func(v map[string]any) { v["foo"] = 1; v["extensions"] = map[string]any{"foo": 2} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var v map[string]any
			json.Unmarshal(valid, &v)
			tc.change(v)
			if c, e := Parse(mustJSON(v)); e == nil || c != nil {
				t.Fatal("accepted malformed typed JSON")
			}
		})
	}
}
func TestImportRejectsFailuresAndUnknownIdentities(t *testing.T) {
	cases := []struct {
		name   string
		change func(*LegacyFiles)
	}{
		{"blank monsters", func(f *LegacyFiles) { f.Monsters = nil }},
		{"null moves", func(f *LegacyFiles) { f.Moves = []byte("null") }},
		{"empty types", func(f *LegacyFiles) { f.Types = []byte("[]") }},
		{"empty wiki", func(f *LegacyFiles) { f.Wiki = []byte("{}") }},
		{"malformed wiki", func(f *LegacyFiles) { f.Wiki = []byte(`{"a":`) }},
		{"missing wiki row", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			delete(v, "小乙")
			f.Wiki = mustJSON(v)
		}},
		{"missing skill list", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			delete(v["小甲"], "skills")
			f.Wiki = mustJSON(v)
		}},
		{"null skill list", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			v["小甲"]["skills"] = mustJSON(nil)
			f.Wiki = mustJSON(v)
		}},
		{"unknown skill", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			v["小甲"]["skills"] = mustJSON([]object{obj("name", "不存在", "source", "默认")})
			f.Wiki = mustJSON(v)
		}},
		{"unknown monster ID", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			v["小甲"]["monster_id"] = mustJSON(999)
			f.Wiki = mustJSON(v)
		}},
		{"image is not identity", func(f *LegacyFiles) {
			var v map[string]object
			json.Unmarshal(f.Wiki, &v)
			v["另一只"] = v["小甲"]
			delete(v, "小甲")
			delete(v["另一只"], "monster_id")
			f.Wiki = mustJSON(v)
		}},
		{"unknown relation", func(f *LegacyFiles) {
			var rows []object
			json.Unmarshal(f.Types, &rows)
			rows[0]["vulnerable_to"] = mustJSON([]string{"missing"})
			f.Types = mustJSON(rows)
		}},
		{"missing required stats", func(f *LegacyFiles) {
			var rows []object
			json.Unmarshal(f.Monsters, &rows)
			delete(rows[0], "base_hp")
			f.Monsters = mustJSON(rows)
		}},
		{"missing learnset mode", func(f *LegacyFiles) {
			var rows []object
			json.Unmarshal(f.Monsters, &rows)
			delete(rows[0], "learnset_mode")
			f.Monsters = mustJSON(rows)
		}},
		{"duplicate raw keys", func(f *LegacyFiles) { f.Types = []byte(`[{"id":1,"id":2}]`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := mustLegacy(t, testCatalog())
			tc.change(&f)
			if c, e := ImportLegacy(f); e == nil || c != nil {
				t.Fatal("failed import became successful/empty catalog")
			}
		})
	}
}
