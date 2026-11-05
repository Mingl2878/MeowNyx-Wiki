package catalog

import (
	"fmt"
	"testing"
)

func mingulongValidationFixture(stats [6]int) *Catalog {
	c := testCatalog()
	c.Types = append(c.Types, Type{ID: 0, Code: "None", Name: "无", RuntimeOnly: true, VulnerableTo: []int{}, ResistantTo: []int{}})
	c.Monsters = append(c.Monsters, Monster{
		ID: 619, Name: "冥古龙", TypeIDs: []int{0}, TraitID: "a",
		Stats: Stats{HP: stats[0], PhyAtk: stats[1], PhyDef: stats[2], MagAtk: stats[3], MagDef: stats[4], Speed: stats[5]},
		Form:  "default", FormCategory: "无多形态", EvolutionStage: "待定", EvolutionMembers: []int{619},
		DefaultLevel: 99, LevelConfigurable: true, Placeholder: true, DataNote: "保留待补充说明",
	})
	c.Learnsets = append(c.Learnsets, Learnset{MonsterID: 619, Mode: "own", Skills: []LearnedSkill{}})
	return c
}

func TestMingulongAcceptsOnlyCompleteOldOrApprovedStats(t *testing.T) {
	approved := [6]int{118, 128, 81, 42, 63, 70}
	for mask := 0; mask < 64; mask++ {
		t.Run(fmt.Sprintf("tuple-%02d", mask), func(t *testing.T) {
			stats := [6]int{100, 100, 100, 100, 100, 100}
			for i := range stats {
				if mask&(1<<i) != 0 {
					stats[i] = approved[i]
				}
			}
			c := mingulongValidationFixture(stats)
			valid := mask == 0 || mask == 63
			if err := Validate(c); (err == nil) != valid {
				t.Fatalf("Validate mask %d: %v", mask, err)
			}
			b, err := Marshal(c)
			if (err == nil) != valid {
				t.Fatalf("Marshal mask %d: %v", mask, err)
			}
			if _, err = Parse(mustJSON(c)); (err == nil) != valid {
				t.Fatalf("Parse mask %d: %v", mask, err)
			}
			if valid {
				parsed, err := Parse(b)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = ExportLegacy(parsed); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
	for i := range approved {
		stats := approved
		stats[i]++
		if err := Validate(mingulongValidationFixture(stats)); err == nil {
			t.Fatalf("arbitrary stat %d accepted", i)
		}
	}
}

func TestMingulongStatApprovalKeepsMetadataGuards(t *testing.T) {
	cases := map[string]func(*Catalog){
		"name":                  func(c *Catalog) { c.Monsters[2].Name = "别名" },
		"default level":         func(c *Catalog) { c.Monsters[2].DefaultLevel = 60 },
		"configurable":          func(c *Catalog) { c.Monsters[2].LevelConfigurable = false },
		"attribute":             func(c *Catalog) { c.Monsters[2].TypeIDs = []int{1} },
		"inherit learning":      func(c *Catalog) { c.Learnsets[2].Mode = "inherit"; c.Learnsets[2].FromID = 1 },
		"own nonempty learning": func(c *Catalog) { c.Learnsets[2].Skills = []LearnedSkill{{SkillID: 7, Source: "默认"}} },
		"avatar":                func(c *Catalog) { c.Monsters[2].Images.Avatar = "guessed.png" },
		"portrait":              func(c *Catalog) { c.Monsters[2].Images.Portrait = "guessed.png" },
		"missing note":          func(c *Catalog) { c.Monsters[2].DataNote = "" },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			for _, stats := range [][6]int{{100, 100, 100, 100, 100, 100}, {118, 128, 81, 42, 63, 70}} {
				c := mingulongValidationFixture(stats)
				modify(c)
				if err := Validate(c); err == nil {
					t.Fatal("metadata guard was loosened")
				}
				if _, err := Parse(mustJSON(c)); err == nil {
					t.Fatal("parser metadata guard was loosened")
				}
			}
		})
	}
}
