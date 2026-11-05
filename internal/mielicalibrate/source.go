// Package mielicalibrate performs an offline, one-time client-table calibration.
// It is never called by the player's Tencent-only update path.
package mielicalibrate

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

const Repository = "https://github.com/mieli1722/roco_kingdom_world_conf"
const Revision = "727614cc195299cce6b3398c2dd82e23e4db9318"

type Pet struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Form        string `json:"form"`
	Legal       int    `json:"legal_petbase"`
	Stage       int    `json:"stage"`
	Strength    int    `json:"stength_stage"`
	Types       []int  `json:"unit_type"`
	Handbook    int    `json:"pictorial_book_id"`
	Feature     int    `json:"pet_feature"`
	LevelSkills int    `json:"level_skill_conf_id"`
	Chains      []int  `json:"pet_evolution_id"`
	Next        []int  `json:"evolution_pet_id"`
	Previous    int    `json:"degenerate_pet_id"`
	Bosses      []int  `json:"bosspetbase_id_arry"`
	Available   string `json:"available_time"`
	HP          int    `json:"hp_max_race"`
	Attack      int    `json:"phy_attack_race"`
	Magic       int    `json:"spe_attack_race"`
	Defense     int    `json:"phy_defence_race"`
	Resistance  int    `json:"spe_defence_race"`
	Speed       int    `json:"speed_race"`
}
type Handbook struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Groups []struct {
		Pets []int `json:"petbase_id"`
	} `json:"include_petbase_id"`
}
type Evolution struct {
	ID    int `json:"id"`
	Chain []struct {
		Pet int `json:"petbase_id"`
	} `json:"evolution_chain"`
}
type Skill struct {
	ID          int       `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"desc"`
	Energy      []float64 `json:"energy_cost"`
	Power       []float64 `json:"dam_para"`
	Type        int       `json:"type"`
	Category    int       `json:"Skill_Type"`
	DamageType  int       `json:"damage_type"`
	Element     int       `json:"skill_dam_type"`
}
type Extra struct {
	ID    int    `json:"id"`
	Group int    `json:"petbase_id"`
	Skill int    `json:"machine_skill_id"`
	Name  string `json:"machine_skill_name"`
}
type Level struct {
	ID    int `json:"id"`
	Level []struct {
		Skill int `json:"param"`
	} `json:"level"`
	Machines []struct {
		ID   int    `json:"machine_skill_id"`
		Name string `json:"machine_skill_name"`
	} `json:"machine_skill_group"`
	Legend          int            `json:"legendary_skill"`
	LegendCondition int            `json:"legendary_skill_condition"`
	ExtraGroup      int            `json:"extra_machine_skill_group_id"`
	Blood           map[string]int `json:"-"`
}

var BloodFields = []string{"COMMON", "GRASS", "FIRE", "WATER", "LIGHT", "STONE", "ICE", "DRAGON", "ELECTRIC", "TOXIC", "INSECT", "FIGHT", "WING", "MOE", "GHOST", "DEMON", "MECHANIC", "PHANTOM"}

func (l *Level) UnmarshalJSON(b []byte) error {
	type plain Level
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	*l = Level(v)
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	l.Blood = map[string]int{}
	for _, f := range BloodFields {
		if b, ok := raw["blood_skill_"+f]; ok {
			var id int
			if err := json.Unmarshal(b, &id); err != nil {
				return err
			}
			l.Blood[f] = id
		}
	}
	return nil
}

type Tables struct {
	Pets       []Pet
	Handbooks  []Handbook
	Evolutions []Evolution
	Skills     []Skill
	Levels     []Level
	Extras     []Extra
	Hashes     map[string]string
}

// This developer importer is deliberately pinned, not a second live updater.
// A different revision requires an explicit review of its schema and provenance.
var pinnedHashes = map[string]string{
	"PETBASE_CONF.json":           "dd82df4d55043407637718dcbd4624014fc6b0069009d3a479ecd66dbc5d485b",
	"PET_HANDBOOK.json":           "b69a00fad084d8b16d47846c6d8d6fb86e01424e8fe651e660648c06b467290d",
	"PET_EVOLUTION_CONF.json":     "f417d4dd1e4f7d53f83271f3313386fafb2e2bdeb954a07e9575b4c2879bd22f",
	"SKILL_CONF.json":             "9e91429400ba14e2a194d0c14c63b157cee0dcc049ced78c89b2042a414026c0",
	"LEVEL_SKILL_CONF.json":       "25da3fbff39092ffe0ec372c42cb4131317615b30c12366a5ce216c30e05c7f2",
	"LEVEL_SKILL_EXTRA_CONF.json": "7c55aeac65d8425d5666891c8ca40f312c7472942c967cdde3c3df2a729d30ff",
}

func Load(dir string) (*Tables, error) {
	t := &Tables{Hashes: map[string]string{}}
	for _, f := range []struct {
		name string
		out  any
	}{
		{"PETBASE_CONF.json", &t.Pets}, {"PET_HANDBOOK.json", &t.Handbooks}, {"PET_EVOLUTION_CONF.json", &t.Evolutions},
		{"SKILL_CONF.json", &t.Skills}, {"LEVEL_SKILL_CONF.json", &t.Levels}, {"LEVEL_SKILL_EXTRA_CONF.json", &t.Extras},
	} {
		b, err := os.ReadFile(filepath.Join(dir, f.name))
		if err != nil {
			return nil, err
		}
		if len(b) == 0 || len(b) > 16<<20 {
			return nil, fmt.Errorf("invalid table size: %s", f.name)
		}
		hash := fmt.Sprintf("%x", sha256.Sum256(b))
		if hash != pinnedHashes[f.name] {
			return nil, fmt.Errorf("%s does not match reviewed client revision %s", f.name, Revision)
		}
		if err = json.Unmarshal(b, f.out); err != nil {
			return nil, fmt.Errorf("%s: %w", f.name, err)
		}
		t.Hashes[f.name] = hash
	}
	if len(t.Pets) == 0 || len(t.Handbooks) == 0 || len(t.Evolutions) == 0 || len(t.Skills) == 0 || len(t.Levels) == 0 {
		return nil, fmt.Errorf("client tables cannot be empty")
	}
	return t, nil
}

var typeMap = map[int]int{2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 6, 9: 7, 10: 8, 11: 9, 12: 10, 13: 11, 14: 12, 15: 13, 16: 14, 17: 15, 18: 16, 19: 17, 20: 18}

func skillCategory(s Skill) string {
	if s.Category == 1 && s.DamageType == 2 {
		return "Physical Attack"
	}
	if s.Category == 1 && s.DamageType == 3 {
		return "Magic Attack"
	}
	if s.Category == 2 && s.DamageType == 1 {
		return "Status"
	}
	if s.Category == 3 && s.DamageType == 1 {
		return "Defense"
	}
	return ""
}

// Keep compatibility with catalog / MonsterIdentity, never remove a form suffix.
var romanSuffix = regexp.MustCompile(`(?i)[\s_-]*([ivx]+)$`)

func normalize(s string) string {
	roman := []string{"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"}
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 0xff01 && r <= 0xff5e:
			b.WriteRune(r - 0xfee0)
		case r == 0x3000:
			b.WriteByte(' ')
		case r >= 0x2160 && r <= 0x216b:
			b.WriteString(roman[r-0x2160])
		case r >= 0x2170 && r <= 0x217b:
			b.WriteString(roman[r-0x2170])
		case r >= 0x200b && r <= 0x200d || r == 0xfeff:
		case strings.ContainsRune("‐‑‒–—−﹣", r):
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	return romanSuffix.ReplaceAllStringFunc(strings.TrimSpace(b.String()), func(v string) string {
		return strings.ToUpper(strings.TrimLeftFunc(v, func(r rune) bool { return r == '-' || r == '_' || unicode.IsSpace(r) }))
	})
}
func normalForm(s string) string {
	switch s {
	case "", "default", "Original", "本来的样子":
		return ""
	}
	return normalize(s)
}

var clientMarkup = regexp.MustCompile(`<desc_id=[0-9]+>|<span fork_road="or">|</>`)

func plainText(s string) (string, error) {
	s = clientMarkup.ReplaceAllString(s, "")
	if strings.ContainsAny(s, "<>") {
		return "", fmt.Errorf("unrecognized client rich-text markup")
	}
	return strings.TrimSpace(s), nil
}
func semanticText(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}
func contains(a []int, id int) bool {
	for _, v := range a {
		if v == id {
			return true
		}
	}
	return false
}
func appendUnique(a []int, id int) []int {
	if !contains(a, id) {
		return append(a, id)
	}
	return a
}
