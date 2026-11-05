package mielicalibrate

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"xhmwiki/internal/catalog"
)

func fixture(t *testing.T) (*catalog.Catalog, *Tables) {
	t.Helper()
	power := 40.0
	c := &catalog.Catalog{SchemaVersion: 2, Types: []catalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}}, Traits: []catalog.Trait{{ID: "t", Name: "特性", Description: "效果"}}, Skills: []catalog.Skill{{ID: 1, Name: "撞击", Description: "伤害", TypeID: 1, Category: "Physical Attack", EnergyCost: 2, Power: &power}}}
	stats := catalog.Stats{HP: 50, PhyAtk: 50, PhyDef: 50, MagAtk: 50, MagDef: 50, Speed: 50}
	c.Monsters = []catalog.Monster{
		{ID: 1, Name: "甲", DexNumber: 1, TypeIDs: []int{1}, TraitID: "t", Stats: stats, Form: "Original", FormCategory: "主形态", EvolutionStage: "基础形态", EvolutionMembers: []int{1}},
		{ID: 2, Name: "乙", DexNumber: 2, TypeIDs: []int{1}, TraitID: "t", Stats: stats, Form: "default", FormCategory: "无多形态", EvolutionStage: "高级形态", EvolutionMembers: []int{2}},
		{ID: 3, Name: "甲", DexNumber: 1, TypeIDs: []int{1}, TraitID: "t", Stats: stats, Form: "春天", FormCategory: "变体形态", MainFormID: 1, EvolutionStage: "基础形态", EvolutionMembers: []int{3}},
		{ID: 4, Name: "首领乙", DexNumber: 2, TypeIDs: []int{1}, TraitID: "t", Stats: stats, Form: "default", FormCategory: "无多形态", EvolutionStage: "首领形态", EvolutionMembers: []int{4}, IsLeaderForm: true, LeaderOfID: 2},
	}
	row := []catalog.LearnedSkill{{SkillID: 1, Source: "默认"}}
	c.Learnsets = []catalog.Learnset{{MonsterID: 1, Mode: "own", Skills: row}, {MonsterID: 2, Mode: "inherit", FromID: 1, Skills: []catalog.LearnedSkill{}}, {MonsterID: 3, Mode: "own", Skills: row}, {MonsterID: 4, Mode: "inherit", FromID: 2, Skills: []catalog.LearnedSkill{}}}
	src := `{"Pets":[{"id":10,"name":"甲","form":"本来的样子","pictorial_book_id":1,"legal_petbase":1,"stage":1,"stength_stage":1,"pet_evolution_id":[1],"evolution_pet_id":[11]}, {"id":11,"name":"乙","pictorial_book_id":2,"legal_petbase":1,"stage":2,"stength_stage":3,"pet_evolution_id":[1],"degenerate_pet_id":10,"bosspetbase_id_arry":[13]}, {"id":12,"name":"甲","form":"春天","pictorial_book_id":1,"legal_petbase":1,"stage":1,"stength_stage":1,"pet_evolution_id":[2]}, {"id":13,"name":"首领乙","pictorial_book_id":2,"stage":4,"stength_stage":3,"pet_evolution_id":[1],"available_time":"2026-01-01 00:00:00"}],"Handbooks":[{"id":1,"include_petbase_id":[{"petbase_id":[10,12]}]},{"id":2,"include_petbase_id":[{"petbase_id":[11,13]}]}],"Evolutions":[{"id":1,"evolution_chain":[{"petbase_id":10},{"petbase_id":11}]},{"id":2,"evolution_chain":[{"petbase_id":12}]}],"Levels":[{"id":10,"level":[{"param":7001}]}],"Skills":[{"id":7001,"name":"撞击","desc":"伤害","energy_cost":[2],"dam_para":[40],"Skill_Type":1,"damage_type":2,"skill_dam_type":2},{"id":200,"name":"特性","desc":"效果"}]}`
	var tables Tables
	if err := json.Unmarshal([]byte(src), &tables); err != nil {
		t.Fatal(err)
	}
	for i := range tables.Pets {
		p := &tables.Pets[i]
		p.Feature = 200
		p.LevelSkills = 10
		p.Types = []int{2}
		p.HP = 50
		p.Attack = 50
		p.Magic = 50
		p.Defense = 50
		p.Resistance = 50
		p.Speed = 50
	}
	if err := catalog.Validate(c); err != nil {
		t.Fatal(err)
	}
	return c, &tables
}
func cutoff() time.Time { return time.Date(2026, 10, 30, 0, 0, 0, 0, time.FixedZone("UTC+8", 8*3600)) }
func TestCalibrationExplicitEdgesPreserveIDsAndEffectiveLearning(t *testing.T) {
	c, src := fixture(t)
	before, _ := catalog.Marshal(c)
	out, r, e := Calibrate(c, src, cutoff())
	if e != nil {
		t.Fatal(e)
	}
	after, _ := catalog.Marshal(c)
	if string(before) != string(after) {
		t.Fatal("mutated input")
	}
	if out.Monsters[1].EvolvesFromID != 1 || out.Monsters[3].LeaderOfID != 2 || out.Monsters[3].EvolvesFromID != 0 {
		t.Fatal("ordinary/boss relations mixed")
	}
	if !reflect.DeepEqual(out.Monsters[0].EvolutionMembers, []int{1, 2}) {
		t.Fatal("missing explicit family")
	}
	if !reflect.DeepEqual(c.Learnsets, out.Learnsets) {
		t.Fatal("rewrote equal inherited learning")
	}
	if out.Monsters[2].MainFormID != 1 || out.Monsters[0].Form != "Original" {
		t.Fatal("changed stable form identity")
	}
	if r.Counts["monsters_checked"] != 4 || r.Counts["learnsets_checked"] != 4 || r.Counts["ordinary_links_checked"] != 1 {
		t.Fatal(r.Counts)
	}
}
func TestRejectsBrokenMappingsAndRelations(t *testing.T) {
	for _, name := range []string{"name", "forward", "member", "empty", "duplicate"} {
		t.Run(name, func(t *testing.T) {
			c, s := fixture(t)
			switch name {
			case "name":
				s.Pets[0].Name = "不是甲"
			case "forward":
				s.Pets[0].Next = nil
			case "member":
				s.Evolutions[0].Chain = s.Evolutions[0].Chain[:1]
			case "empty":
				s.Levels[0].Level = nil
			case "duplicate":
				s.Pets = append(s.Pets, s.Pets[0])
			}
			if _, _, e := Calibrate(c, s, cutoff()); e == nil {
				t.Fatal("accepted corrupt client data")
			}
		})
	}
}
func TestIgnoresUnrelatedSameNameNpcSkillAndMarkupNoise(t *testing.T) {
	c, s := fixture(t)
	s.Skills = append(s.Skills, Skill{ID: 7999999, Name: "撞击", Description: "NPC攻击", Energy: []float64{8}, Power: []float64{999}})
	c.Traits[0].Description = "效 果"
	s.Skills[1].Description = "<desc_id=12>效果</>"
	out, r, e := Calibrate(c, s, cutoff())
	if e != nil {
		t.Fatal(e)
	}
	if out.Traits[0].Description != "效 果" || len(out.Traits) != 1 {
		t.Fatal("cosmetic trait rewrite")
	}
	if r.Counts["skill_power_changed"] != 0 {
		t.Fatal("used NPC power")
	}
}
func TestExtraGroupsUseIDsNotStaleDisplayNames(t *testing.T) {
	c, s := fixture(t)
	v := c.Skills[0]
	v.ID = 2
	v.Name = "新增技能"
	c.Skills = append(c.Skills, v)
	s.Skills = append(s.Skills, Skill{ID: 7002, Name: "新增技能", Description: "伤害", Energy: []float64{2}, Power: []float64{40}, Category: 1, DamageType: 2, Element: 2})
	s.Levels[0].ExtraGroup = 7
	s.Extras = []Extra{{ID: 1, Group: 7, Skill: 7002, Name: "过期旧名"}}
	out, _, e := Calibrate(c, s, cutoff())
	if e != nil {
		t.Fatal(e)
	}
	if len(out.Learnsets[0].Skills) != 2 || out.Learnsets[0].Skills[1].SkillID != 2 || out.Learnsets[0].Skills[1].Source != "技能石" {
		t.Fatal("extra IDs not resolved")
	}
	if out.Learnsets[1].Mode != "inherit" {
		t.Fatal("split equal inheritance")
	}
}
func TestRejectsUnknownMarkup(t *testing.T) {
	if _, e := plainText("<script>alert(1)</script>"); e == nil {
		t.Fatal("accepted arbitrary markup")
	}
}
