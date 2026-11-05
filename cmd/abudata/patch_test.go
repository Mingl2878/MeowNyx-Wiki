package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/sourcebaseline"
)

func extensions() catalog.Extensions {
	return catalog.Extensions{"unrelated": json.RawMessage(`{"large":9007199254740993,"nested":[true,null,"keep"]}`)}
}

// Synthetic only: no test reads or writes the real catalog/AppData/backup roots.
func testCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	p60, p100 := float64(60), float64(100)
	c := &catalog.Catalog{SchemaVersion: 2,
		Monsters: []catalog.Monster{
			{ID: 5, Name: "保留猫", DexNumber: 1, TypeIDs: []int{8}, TraitID: "other-trait",
				Stats:  catalog.Stats{HP: 9, PhyAtk: 8, PhyDef: 7, MagAtk: 6, MagDef: 5, Speed: 4, Extensions: extensions()},
				Images: catalog.Images{Avatar: "keep.png", Extensions: extensions()},
				Form:   "default", FormCategory: "无多形态", EvolutionStage: "基础形态", EvolutionMembers: []int{5},
				SourceRef: &catalog.SourceRef{Provider: catalogrecovery.Provider, ID: "10", Identity: "NO.001|保留猫|", Extensions: extensions()}, Extensions: extensions()},
		},
		Skills: []catalog.Skill{
			{ID: 244, Name: "龙吼", Description: "对敌方精灵造成物理伤害。", TypeID: 8, Category: "Physical Attack", EnergyCost: 1, Power: &p60, Season: "S1", Extensions: extensions()},
			{ID: 245, Name: "龙炮", Description: "对敌方精灵造成物理伤害。", TypeID: 8, Category: "Physical Attack", EnergyCost: 3, Power: &p100, Season: "S1", Extensions: extensions()},
		},
		Types: []catalog.Type{
			{ID: 0, Name: "无", Code: "None", VulnerableTo: []int{}, ResistantTo: []int{}, RuntimeOnly: true, Extensions: extensions()},
			{ID: 8, Name: "龙", Code: "Dragon", VulnerableTo: []int{}, ResistantTo: []int{}, Extensions: extensions()},
			{ID: 15, Name: "幽", Code: "Ghost", VulnerableTo: []int{}, ResistantTo: []int{}, Extensions: extensions()},
		},
		Traits:     []catalog.Trait{{ID: "other-trait", Name: "保留特性", Description: "保留说明", Extensions: extensions()}},
		Learnsets:  []catalog.Learnset{{MonsterID: 5, Mode: "own", Skills: []catalog.LearnedSkill{{SkillID: 244, Source: "本地", Extensions: extensions()}, {SkillID: 245, Source: "传说"}}, Extensions: extensions()}},
		SkillRules: []catalog.SkillRule{{SkillID: 244, PowerFormula: "preserved-explicit-rule", Extensions: extensions()}},
		Extensions: extensions(),
	}
	for _, entry := range []struct {
		id   int
		name string
	}{{595, "银月狼王"}, {616, "诅咒狼灵"}, {617, "新月狼灵"}} {
		m := c.Monsters[0]
		m.ID, m.Name, m.SourceRef = entry.id, entry.name, nil
		m.EvolutionMembers = []int{595, 616, 617}
		m.Stats.Speed, m.Images.Portrait = entry.id, "wolf-untouched.png"
		c.Monsters = append(c.Monsters, m)
		c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: entry.id, Mode: "inherit", FromID: 5, Skills: []catalog.LearnedSkill{}, Extensions: extensions()})
	}
	c.Monsters = append(c.Monsters, catalog.Monster{ID: 619, Name: "冥古龙", TypeIDs: []int{8, 15}, TraitID: "other-trait",
		Stats: catalog.Stats{HP: 118, PhyAtk: 128, PhyDef: 81, MagAtk: 42, MagDef: 63, Speed: 70}, Images: catalog.Images{},
		Form: "default", FormCategory: "无多形态", EvolutionStage: "待定", EvolutionMembers: []int{619},
		DefaultLevel: 99, LevelConfigurable: true, Placeholder: true, DataNote: "保留冥古龙说明"})
	c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: 619, Mode: "own", Skills: []catalog.LearnedSkill{}})
	b := sourcebaseline.New(strings.Repeat("a", 64))
	b.Put(sourcebaseline.Observation{Entry: sourcebaseline.Entry{Entity: "monster", Identity: "NO.001|保留猫|", Field: "stats.hp", Value: json.RawMessage(`{"available":true,"value":120}`)}})
	baseline, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	c.Extensions[sourcebaseline.Extension] = baseline
	c.Extensions["catalog_choices"] = json.RawMessage(`{"version":1,"entries":{"arbitrary-user-policy":{"choice":"local"}}}`)
	c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":1,"entries":[{"local_id":408,"provider":"tencent-compendium","source_id":"9998","identity":"NO.123|保留身份一|"},{"local_id":409,"provider":"tencent-compendium","source_id":"9999","identity":"NO.124|保留身份二|"},{"local_id":410,"provider":"tencent-compendium","source_id":"10000","identity":"NO.125|保留身份三|"}]}`)
	return c
}

func marshalTest(t *testing.T, c *catalog.Catalog) []byte {
	t.Helper()
	b, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func addApproved(c *catalog.Catalog) {
	c.Monsters = append(c.Monsters, approvedMonster())
	c.Traits = append(c.Traits, approvedTrait())
	c.Learnsets = append(c.Learnsets, approvedLearnset())
}

// Independent of approvedDiffOnly: reverse the three additions by stable keys,
// asserting their exact full JSON and original position/count before comparison.
func assertOnlyAddition(t *testing.T, before, after []byte) {
	t.Helper()
	a, err := jsonObject(before)
	if err != nil {
		t.Fatal(err)
	}
	b, err := jsonObject(after)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		collection, idKey string
		id                any
		expected          string
	}{
		{"monsters", "id", json.Number("623"), `{"id":623,"name":"超能阿布","dex_number":0,"type_ids":[8],"trait_id":"trait-2d62e65c758af0457fe3fcdc3054ae81","stats":{"hp":126,"phy_atk":122,"phy_def":80,"mag_atk":45,"mag_def":100,"speed":105},"images":{},"form":"default","form_category":"无多形态","evolution_stage":"首领形态","evolution_members":[623],"is_leader_form":true,"default_level":60,"level_configurable":true,"level_min":60,"level_max":99,"level_step":2,"data_note":"用户补充的独立首领形态；图鉴编号、图片、对应普通形态待补。"}`},
		{"traits", "id", "trait-2d62e65c758af0457fe3fcdc3054ae81", `{"id":"trait-2d62e65c758af0457fe3fcdc3054ae81","name":"圣龙的守护","description":"己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。"}`},
		{"learnsets", "monster_id", json.Number("623"), `{"monster_id":623,"mode":"own","skills":[{"skill_id":244,"source":"默认"},{"skill_id":245,"source":"默认"}]}`},
	} {
		var keep []any
		found := 0
		items := b[row.collection].([]any)
		for i, item := range items {
			if item.(map[string]any)[row.idKey] != row.id {
				keep = append(keep, item)
				continue
			}
			found++
			want, err := jsonValue([]byte(row.expected))
			if err != nil {
				t.Fatal(err)
			}
			if i != len(items)-1 || !reflect.DeepEqual(item, want) {
				t.Fatalf("wrong appended %s: %#v", row.collection, item)
			}
		}
		if found != 1 {
			t.Fatalf("wrong added %s count: %d", row.collection, found)
		}
		b[row.collection] = keep
	}
	if !reflect.DeepEqual(a, b) {
		t.Fatal("unapproved record/extension/global/learnset change")
	}
	if err := validateCatalog(after); err != nil {
		t.Fatal(err)
	}
}

func TestPatchExactAdditionAndByteIdempotence(t *testing.T) {
	original := marshalTest(t, testCatalog(t))
	before := bytes.Clone(original)
	candidate, changes, err := patch(original)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 3 || !bytes.Equal(original, before) {
		t.Fatal("incorrect changes/input mutation")
	}
	assertOnlyAddition(t, original, candidate)
	candidate = append(candidate, '\n')
	again, changes, err := patch(candidate)
	if err != nil || len(changes) != 0 || !bytes.Equal(candidate, again) {
		t.Fatal("not byte-idempotent", err)
	}
	sum := sha256.Sum256([]byte(traitName + "\x00" + traitDescription))
	if traitID != "trait-"+hex.EncodeToString(sum[:16]) {
		t.Fatal("nondeterministic trait ID")
	}
}

func TestPatchRefusesAllConflictsWithoutMutation(t *testing.T) {
	cases := map[string]func(*catalog.Catalog){
		"occupied 623": func(c *catalog.Catalog) {
			m := approvedMonster()
			m.Name = "用户623"
			m.TraitID = "other-trait"
			c.Monsters = append(c.Monsters, m)
			c.Learnsets = append(c.Learnsets, approvedLearnset())
		},
		"same base name on other form": func(c *catalog.Catalog) { c.Monsters[0].Name = monsterName; c.Monsters[0].Form = "其他形态" },
		"normalized name collision":    func(c *catalog.Catalog) { c.Monsters[0].Name = "\u3000超能\u200b阿布\ufeff " },
		"alias collision":              func(c *catalog.Catalog) { c.Monsters[0].Aliases = []string{monsterName} },
		"same trait name":              func(c *catalog.Catalog) { c.Traits[0].Name = traitName },
		"normalized trait name":        func(c *catalog.Catalog) { c.Traits[0].Name = "\u3000圣龙的\u200c守护\ufeff" },
		"orphan exact trait":           func(c *catalog.Catalog) { c.Traits = append(c.Traits, approvedTrait()) },
		"colliding trait ID": func(c *catalog.Catalog) {
			c.Traits = append(c.Traits, catalog.Trait{ID: traitID, Name: "原有特性", Description: "保留"})
		},
		"missing trait":         func(c *catalog.Catalog) { addApproved(c); c.Traits = c.Traits[:len(c.Traits)-1] },
		"missing learnset":      func(c *catalog.Catalog) { addApproved(c); c.Learnsets = c.Learnsets[:len(c.Learnsets)-1] },
		"shared approved trait": func(c *catalog.Catalog) { addApproved(c); c.Monsters[0].TraitID = traitID },
		"reserved 623": func(c *catalog.Catalog) {
			c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":1,"entries":[{"local_id":623,"provider":"tencent-compendium","source_id":"9999","identity":"NO.123|保留身份|"}]}`)
		},
		"future reservations": func(c *catalog.Catalog) {
			c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":999,"entries":[]}`)
		},
		"unknown reservation source": func(c *catalog.Catalog) {
			c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":1,"entries":[{"local_id":408,"provider":"unknown-source","source_id":"9999","identity":"NO.123|保留身份|"}]}`)
		},
		"future baseline": func(c *catalog.Catalog) { c.Extensions[sourcebaseline.Extension] = json.RawMessage(`{"version":999}`) },
		"unknown baseline source": func(c *catalog.Catalog) {
			c.Extensions[sourcebaseline.Extension] = bytes.ReplaceAll(c.Extensions[sourcebaseline.Extension], []byte(`"tencent-compendium"`), []byte(`"unknown-source"`))
		},
		"missing required skill": func(c *catalog.Catalog) { c.Skills = c.Skills[:1]; c.Learnsets[0].Skills = c.Learnsets[0].Skills[:1] },
		"wrong skill name":       func(c *catalog.Catalog) { c.Skills[0].Name = "原技能" },
		"wrong skill type":       func(c *catalog.Catalog) { c.Skills[0].TypeID = 15 },
		"wrong skill category":   func(c *catalog.Catalog) { c.Skills[0].Category = "Magic Attack" },
		"unknown skill power":    func(c *catalog.Catalog) { c.Skills[0].Power = nil },
		"wrong skill power":      func(c *catalog.Catalog) { v := float64(61); c.Skills[0].Power = &v },
		"wrong skill cost":       func(c *catalog.Catalog) { c.Skills[1].EnergyCost = 2 },
		"wrong Dragon type": func(c *catalog.Catalog) {
			c.Types[1].Code = "NotDragon"
			c.Monsters[len(c.Monsters)-1].TypeIDs = []int{0}
		},
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			c := testCatalog(t)
			modify(c)
			raw, err := json.Marshal(c) // deliberately permits invalid fixtures
			if err != nil {
				t.Fatal(err)
			}
			before := bytes.Clone(raw)
			if _, _, err = patch(raw); err == nil {
				t.Fatal("accepted conflict")
			}
			if !bytes.Equal(raw, before) {
				t.Fatal("mutated rejected input")
			}
		})
	}
}

func TestExisting623MustMatchEveryApprovedField(t *testing.T) {
	for name, modify := range map[string]func(*catalog.Catalog){
		"stats":        func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].Stats.Speed = 106 },
		"dex":          func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].DexNumber = 623 },
		"image":        func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].Images.Avatar = "guessed.png" },
		"type order":   func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].TypeIDs = []int{8, 15} },
		"stage":        func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].EvolutionStage = "高级形态" },
		"leader flag":  func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].IsLeaderForm = false },
		"level":        func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].DefaultLevel = 62 },
		"range":        func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].LevelMin = 59 },
		"step":         func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].LevelStep = 1 },
		"configurable": func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].LevelConfigurable = false },
		"note":         func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].DataNote = "本地备注" },
		"source guess": func(c *catalog.Catalog) {
			c.Monsters[len(c.Monsters)-1].SourceRef = &catalog.SourceRef{Provider: "tencent-compendium", ID: "623", Identity: "NO.623|超能阿布|"}
		},
		"leader relation": func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].LeaderOfID = 5 },
		"evolution": func(c *catalog.Catalog) {
			c.Monsters[len(c.Monsters)-1].EvolutionMembers = []int{5, 623}
			c.Monsters[len(c.Monsters)-1].EvolvesFromID = 5
		},
		"unknown field":          func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].Extensions = extensions() },
		"placeholder":            func(c *catalog.Catalog) { c.Monsters[len(c.Monsters)-1].Placeholder = true },
		"trait text":             func(c *catalog.Catalog) { c.Traits[len(c.Traits)-1].Description += "本地补充" },
		"unknown learner source": func(c *catalog.Catalog) { c.Learnsets[len(c.Learnsets)-1].Skills[0].Source = "未知" },
		"missing learner":        func(c *catalog.Catalog) { l := &c.Learnsets[len(c.Learnsets)-1]; l.Skills = l.Skills[:1] },
		"extra learner": func(c *catalog.Catalog) {
			l := &c.Learnsets[len(c.Learnsets)-1]
			l.Skills = append(l.Skills, catalog.LearnedSkill{SkillID: 244, Source: "传说"})
		},
		"inheritance": func(c *catalog.Catalog) { l := &c.Learnsets[len(c.Learnsets)-1]; l.Mode = "inherit"; l.FromID = 5 },
	} {
		t.Run(name, func(t *testing.T) {
			c := testCatalog(t)
			addApproved(c)
			modify(c)
			raw, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err = patch(raw); err == nil {
				t.Fatal("accepted nonexact existing 623")
			}
		})
	}
}

func TestDiffGuardRejectsUnrelatedChanges(t *testing.T) {
	original := marshalTest(t, testCatalog(t))
	candidate, _, err := patch(original)
	if err != nil {
		t.Fatal(err)
	}
	for name, modify := range map[string]func(map[string]any){
		"master skill": func(root map[string]any) { root["skills"].([]any)[0].(map[string]any)["power"] = json.Number("999") },
		"wolf":         func(root map[string]any) { root["monsters"].([]any)[1].(map[string]any)["name"] = "changed" },
		"baseline":     func(root map[string]any) { delete(root["extensions"].(map[string]any), sourcebaseline.Extension) },
		"choices":      func(root map[string]any) { delete(root["extensions"].(map[string]any), "catalog_choices") },
		"reservations": func(root map[string]any) { delete(root["extensions"].(map[string]any), catalogrecovery.Extension) },
		"old learnset": func(root map[string]any) { root["learnsets"].([]any)[0].(map[string]any)["skills"] = []any{} },
		"added unexpected field": func(root map[string]any) {
			rows := root["monsters"].([]any)
			rows[len(rows)-1].(map[string]any)["source_ref"] = "guessed"
		},
		"extra monster": func(root map[string]any) {
			root["monsters"] = append(root["monsters"].([]any), map[string]any{"id": json.Number("624")})
		},
	} {
		t.Run(name, func(t *testing.T) {
			root, err := jsonObject(candidate)
			if err != nil {
				t.Fatal(err)
			}
			modify(root)
			mutated, err := json.Marshal(root)
			if err != nil {
				t.Fatal(err)
			}
			if err = approvedDiffOnly(original, mutated); err == nil {
				t.Fatal("accepted nonapproved diff")
			}
		})
	}
}

func TestRefusesNormalizationAndKeepsMingulongGuard(t *testing.T) {
	raw := marshalTest(t, testCatalog(t))
	unknown := append([]byte(`{"unmodeled":true,`), raw[1:]...)
	if _, _, err := patch(unknown); err == nil || !strings.Contains(err.Error(), "nonapproved") {
		t.Fatal("normalized unrelated field", err)
	}
	v1 := bytes.Replace(raw, []byte(`"schema_version":2`), []byte(`"schema_version":1`), 1)
	if _, _, err := patch(v1); err == nil {
		t.Fatal("silently migrated v1")
	}
	future := bytes.Replace(raw, []byte(`"schema_version":2`), []byte(`"schema_version":99`), 1)
	if _, _, err := patch(future); err == nil {
		t.Fatal("accepted future schema")
	}
	for _, old := range []bool{true, false} {
		c := testCatalog(t)
		m := &c.Monsters[len(c.Monsters)-1]
		if old {
			m.TypeIDs = []int{0}
			m.Stats = catalog.Stats{HP: 100, PhyAtk: 100, PhyDef: 100, MagAtk: 100, MagDef: 100, Speed: 100}
		}
		before := marshalTest(t, c)
		after, _, err := patch(before)
		if err != nil {
			t.Fatal(err)
		}
		assertOnlyAddition(t, before, after)
		m.Stats.Speed++
		bad, _ := json.Marshal(c)
		if _, _, err = patch(bad); err == nil {
			t.Fatal(fmt.Sprintf("Ming guard loosened (legacy=%v)", old))
		}
	}
}
