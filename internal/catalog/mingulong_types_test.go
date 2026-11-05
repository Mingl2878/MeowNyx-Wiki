package catalog

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func mingulongTypeFixture(stats [6]int, types []int) *Catalog {
	c := mingulongValidationFixture(stats)
	c.Types = append(c.Types,
		Type{ID: 8, Code: "Dragon", Name: "龙", VulnerableTo: []int{}, ResistantTo: []int{}},
		Type{ID: 15, Code: "Ghost", Name: "幽", VulnerableTo: []int{}, ResistantTo: []int{}})
	c.Monsters[2].TypeIDs = append([]int(nil), types...)
	return c
}

func TestMingulongTypesAreIndependentOfAdmittedStatTuples(t *testing.T) {
	approved := [6]int{118, 128, 81, 42, 63, 70}
	for _, types := range [][]int{{0}, {8, 15}} {
		for mask := 0; mask < 64; mask++ {
			t.Run(fmt.Sprintf("types-%v-tuple-%02d", types, mask), func(t *testing.T) {
				stats := [6]int{100, 100, 100, 100, 100, 100}
				for i := range stats {
					if mask&(1<<i) != 0 {
						stats[i] = approved[i]
					}
				}
				c := mingulongTypeFixture(stats, types)
				valid := mask == 0 || mask == 63
				if err := Validate(c); (err == nil) != valid {
					t.Fatal("type approval relaxed stat tuple guard", err)
				}
				b, err := Marshal(c)
				if (err == nil) != valid {
					t.Fatal("marshal stat/type validation mismatch", err)
				}
				if _, err := Parse(mustJSON(c)); (err == nil) != valid {
					t.Fatal("parse stat/type validation mismatch", err)
				}
				if valid {
					parsed, err := Parse(b)
					if err != nil || !reflect.DeepEqual(parsed.Monsters[2].TypeIDs, types) {
						t.Fatal("type order changed on roundtrip", err)
					}
					f, err := ExportLegacy(parsed)
					if err != nil {
						t.Fatal(err)
					}
					imported, err := ImportLegacy(f)
					if err != nil || !reflect.DeepEqual(indexCatalog(imported).monsters[619].TypeIDs, types) {
						t.Fatal("legacy roundtrip changed type order", err)
					}
					var monsters []struct {
						ID       int `json:"id"`
						MainType struct {
							ID int `json:"id"`
						} `json:"main_type"`
						SubType *struct {
							ID int `json:"id"`
						} `json:"sub_type"`
					}
					if err := json.Unmarshal(f.Monsters, &monsters); err != nil {
						t.Fatal(err)
					}
					found := false
					for _, m := range monsters {
						if m.ID != 619 {
							continue
						}
						found = true
						if m.MainType.ID != types[0] || (len(types) == 2 && (m.SubType == nil || m.SubType.ID != types[1])) || (len(types) == 1 && m.SubType != nil) {
							t.Fatal("projection changed main/secondary order")
						}
					}
					if !found {
						t.Fatal("projection lost 619")
					}
				}
			})
		}
	}
}

func TestMingulongRejectsEveryOtherAvailableTypeCombination(t *testing.T) {
	possibilities := [][]int{nil, {}, {8, 15, 1}}
	for _, first := range []int{0, 1, 8, 13, 15, 999} {
		possibilities = append(possibilities, []int{first})
		for _, second := range []int{0, 1, 8, 13, 15, 999} {
			possibilities = append(possibilities, []int{first, second})
		}
	}
	for _, stats := range [][6]int{{100, 100, 100, 100, 100, 100}, {118, 128, 81, 42, 63, 70}} {
		for _, types := range possibilities {
			c := mingulongTypeFixture(stats, types)
			valid := reflect.DeepEqual(types, []int{0}) || reflect.DeepEqual(types, []int{8, 15})
			if err := Validate(c); (err == nil) != valid {
				t.Fatalf("unexpected type acceptance %v: %v", types, err)
			}
			if _, err := Parse(mustJSON(c)); (err == nil) != valid {
				t.Fatalf("parser unexpected type acceptance %v: %v", types, err)
			}
		}
	}
}

func TestMingulongApprovedTypesRequireRealCodes(t *testing.T) {
	cases := map[string]func(*Catalog){
		"swapped codes":     func(c *Catalog) { c.Types[3].Code, c.Types[4].Code = "Ghost", "Dragon" },
		"wrong Dragon code": func(c *Catalog) { c.Types[3].Code = "OtherDragon" },
		"wrong Ghost code":  func(c *Catalog) { c.Types[4].Code = "OtherGhost" },
		"case is exact":     func(c *Catalog) { c.Types[3].Code = "dragon" },
		"missing Dragon":    func(c *Catalog) { c.Types = append(c.Types[:3], c.Types[4:]...) },
		"missing Ghost":     func(c *Catalog) { c.Types = c.Types[:4] },
		"runtime-only type": func(c *Catalog) { c.Types[3].RuntimeOnly = true },
		"wrong stable IDs":  func(c *Catalog) { c.Types[3].ID, c.Types[4].ID = 15, 8 },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			for _, stats := range [][6]int{{100, 100, 100, 100, 100, 100}, {118, 128, 81, 42, 63, 70}} {
				c := mingulongTypeFixture(stats, []int{8, 15})
				modify(c)
				if err := Validate(c); err == nil {
					t.Fatal("accepted wrong type codes/IDs")
				}
				if _, err := Parse(mustJSON(c)); err == nil {
					t.Fatal("parser accepted wrong type codes/IDs")
				}
			}
		})
	}
}

func TestMingulongApprovedTypesKeepMetadataGuards(t *testing.T) {
	cases := map[string]func(*Catalog){
		"name":                  func(c *Catalog) { c.Monsters[2].Name = "别名" },
		"default level":         func(c *Catalog) { c.Monsters[2].DefaultLevel = 60 },
		"configurable":          func(c *Catalog) { c.Monsters[2].LevelConfigurable = false },
		"invalid level range":   func(c *Catalog) { c.Monsters[2].LevelMin = 100 },
		"invalid level step":    func(c *Catalog) { c.Monsters[2].LevelStep = 99 },
		"inherit learning":      func(c *Catalog) { c.Learnsets[2].Mode = "inherit"; c.Learnsets[2].FromID = 1 },
		"own nonempty learning": func(c *Catalog) { c.Learnsets[2].Skills = []LearnedSkill{{SkillID: 7, Source: "默认"}} },
		"own with from":         func(c *Catalog) { c.Learnsets[2].FromID = 1 },
		"nil learning":          func(c *Catalog) { c.Learnsets[2].Skills = nil },
		"avatar":                func(c *Catalog) { c.Monsters[2].Images.Avatar = "guessed.png" },
		"portrait":              func(c *Catalog) { c.Monsters[2].Images.Portrait = "guessed.png" },
		"missing note":          func(c *Catalog) { c.Monsters[2].DataNote = "" },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			for _, stats := range [][6]int{{100, 100, 100, 100, 100, 100}, {118, 128, 81, 42, 63, 70}} {
				c := mingulongTypeFixture(stats, []int{8, 15})
				modify(c)
				if err := Validate(c); err == nil {
					t.Fatal("type approval relaxed metadata guard")
				}
				if _, err := Parse(mustJSON(c)); err == nil {
					t.Fatal("parser type approval relaxed metadata guard")
				}
			}
		})
	}
}
