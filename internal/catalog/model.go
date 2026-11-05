// Package catalog defines the versioned, local-ID compendium. It has no I/O or
// runtime dependencies; callers own atomic storage and backups.
package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"
	"strings"
)

const SchemaVersion = 2

// Extensions retain unrecognized data. The "legacy" key contains a sparse
// patch in the original record's shape, not a second copy of the record.
type Extensions map[string]json.RawMessage

type Catalog struct {
	SchemaVersion int         `json:"schema_version"`
	Monsters      []Monster   `json:"monsters"`
	Skills        []Skill     `json:"skills"`
	Types         []Type      `json:"types"`
	Traits        []Trait     `json:"traits"`
	Learnsets     []Learnset  `json:"learnsets"`
	SkillRules    []SkillRule `json:"skill_rules,omitempty"`
	Extensions    Extensions  `json:"extensions,omitempty"`
}

type SourceRef struct {
	Provider   string     `json:"provider"`
	ID         string     `json:"id"`
	Identity   string     `json:"identity"`
	Extensions Extensions `json:"extensions,omitempty"`
}

type Monster struct {
	ID                 int        `json:"id"`
	Name               string     `json:"name"`
	DexNumber          int        `json:"dex_number"`
	Season             string     `json:"season,omitempty"`
	TypeIDs            []int      `json:"type_ids"`
	TraitID            string     `json:"trait_id"`
	Stats              Stats      `json:"stats"`
	Images             Images     `json:"images"`
	Form               string     `json:"form,omitempty"`
	FormCategory       string     `json:"form_category"`
	MainFormID         int        `json:"main_form_id,omitempty"`
	EvolutionStage     string     `json:"evolution_stage"`
	EvolvesFromID      int        `json:"evolves_from_id,omitempty"`
	EvolutionMembers   []int      `json:"evolution_members"` // ordered, per-entry; never a transitive family
	LeaderOfID         int        `json:"leader_of_id,omitempty"`
	EvolutionChainName string     `json:"evolution_chain_name,omitempty"`
	IsLeaderForm       bool       `json:"is_leader_form,omitempty"`
	Hidden             bool       `json:"hidden,omitempty"`
	Aliases            []string   `json:"aliases,omitempty"`
	SearchTags         []string   `json:"search_tags,omitempty"`
	DefaultLevel       int        `json:"default_level,omitempty"` // absent means the runtime default (60), not zero
	LevelConfigurable  bool       `json:"level_configurable,omitempty"`
	LevelMin           int        `json:"level_min,omitempty"`
	LevelMax           int        `json:"level_max,omitempty"`
	LevelStep          int        `json:"level_step,omitempty"`
	Placeholder        bool       `json:"placeholder,omitempty"`
	DataNote           string     `json:"data_note,omitempty"`
	SourceRef          *SourceRef `json:"source_ref,omitempty"`
	Extensions         Extensions `json:"extensions,omitempty"`
}

type Stats struct {
	HP         int        `json:"hp"`
	PhyAtk     int        `json:"phy_atk"`
	PhyDef     int        `json:"phy_def"`
	MagAtk     int        `json:"mag_atk"`
	MagDef     int        `json:"mag_def"`
	Speed      int        `json:"speed"`
	Extensions Extensions `json:"extensions,omitempty"`
}

// Avatar is the monster-list image; Portrait is the Wiki illustration. Never
// substitute one for the other, including for placeholders and missing images.
type Images struct {
	Avatar     string     `json:"avatar,omitempty"`
	Portrait   string     `json:"portrait,omitempty"`
	Extensions Extensions `json:"extensions,omitempty"`
}

type Skill struct {
	ID          int        `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	TypeID      int        `json:"type_id"`
	Category    string     `json:"category"`
	EnergyCost  float64    `json:"energy_cost"`
	Power       *float64   `json:"power"` // null is unknown / not applicable; zero is a known zero
	Season      string     `json:"season,omitempty"`
	SourceRef   *SourceRef `json:"source_ref,omitempty"`
	Extensions  Extensions `json:"extensions,omitempty"`
}

// SkillRule contains only explicitly supplied rules. Legacy counter/alt hints
// stay in Skill.Extensions["legacy"] and never generate simulation rules.
type SkillRule struct {
	SkillID      int        `json:"skill_id"`
	BaseCombo    *int       `json:"base_combo,omitempty"`
	PowerFormula string     `json:"power_formula,omitempty"`
	Extensions   Extensions `json:"extensions,omitempty"`
}

type Type struct {
	ID           int        `json:"id"`
	Code         string     `json:"code"`
	Name         string     `json:"name"`
	VulnerableTo []int      `json:"vulnerable_to"`
	ResistantTo  []int      `json:"resistant_to"`
	RuntimeOnly  bool       `json:"runtime_only,omitempty"` // only the explicit None/0 sentinel
	SourceRef    *SourceRef `json:"source_ref,omitempty"`
	Extensions   Extensions `json:"extensions,omitempty"`
}

type Trait struct {
	ID          string     `json:"id"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	SourceRef   *SourceRef `json:"source_ref,omitempty"`
	Extensions  Extensions `json:"extensions,omitempty"`
}

type Learnset struct {
	MonsterID  int            `json:"monster_id"`
	Mode       string         `json:"mode"` // "own" or "inherit"; inheritance is never inferred
	FromID     int            `json:"from_id,omitempty"`
	Skills     []LearnedSkill `json:"skills"` // ordered; duplicate source rows are deliberately preserved
	SourceRef  *SourceRef     `json:"source_ref,omitempty"`
	Extensions Extensions     `json:"extensions,omitempty"`
}

type LearnedSkill struct {
	SkillID int    `json:"skill_id"`
	Source  string `json:"source"`
	// New-schema unknown fields remain here; legacy row extras are sparse patches
	// in Learnset.Extensions["legacy_skills"], keyed by decimal array index.
	Extensions Extensions `json:"extensions,omitempty"`
}

type LegacyFiles struct{ Monsters, Moves, Types, Wiki []byte }

func Parse(data []byte) (*Catalog, error) {
	if err := checkJSON(data); err != nil {
		return nil, err
	}
	var c Catalog
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	if c.SchemaVersion == 1 {
		if err := initializeEvolutionMembers(&c, true); err != nil {
			return nil, err
		}
		c.SchemaVersion = SchemaVersion
	}
	if err := Validate(&c); err != nil {
		return nil, err
	}
	return &c, nil
}

func Marshal(c *Catalog) ([]byte, error) {
	if err := Validate(c); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(c); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'}), nil
}

// Reject duplicate JSON keys and trailing documents before encoding/json could
// silently choose the last value. Bound nesting to reject pathological input.
func checkJSON(data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("empty JSON input")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 100 {
			return fmt.Errorf("JSON nesting exceeds 100")
		}
		tok, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			keys := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return e
				}
				s, ok := k.(string)
				if !ok {
					return fmt.Errorf("invalid object key")
				}
				if keys[s] {
					return fmt.Errorf("duplicate JSON key %q", s)
				}
				keys[s] = true
				if e = walk(depth + 1); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e = walk(depth + 1); e != nil {
					return e
				}
			}
		default:
			return fmt.Errorf("unexpected JSON delimiter %q", delim)
		}
		_, e = d.Token()
		return e
	}
	if e := walk(0); e != nil {
		return fmt.Errorf("invalid JSON: %w", e)
	}
	if _, e := d.Token(); e != io.EOF {
		return fmt.Errorf("JSON must contain exactly one document")
	}
	return nil
}

// decodeExtended moves unknown schema fields into extensions, including nested
// objects, rather than accepting them and discarding their values.
func decodeExtended(data []byte, out any, ext *Extensions) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return fmt.Errorf("expected object, got null")
	}
	if e := json.Unmarshal(data, out); e != nil {
		return e
	}
	var raw map[string]json.RawMessage
	if e := json.Unmarshal(data, &raw); e != nil {
		return e
	}
	typ := reflect.TypeOf(out).Elem()
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag := field.Tag.Get("json")
		required := !strings.Contains(tag, ",omitempty")
		for j, c := range tag {
			if c == ',' {
				tag = tag[:j]
				break
			}
		}
		if required {
			value, present := raw[tag]
			// A missing members field is decoded for v1 migration only. Validate
			// rejects it on v2; explicit null is invalid in either version.
			if !present && field.Name == "EvolutionMembers" {
				continue
			}
			if !present {
				return fmt.Errorf("%s.%s is required", typ.Name(), tag)
			}
			if field.Type.Kind() != reflect.Pointer && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return fmt.Errorf("%s.%s cannot be null", typ.Name(), tag)
			}
		}
		delete(raw, tag)
	}
	for k, v := range raw {
		if *ext == nil {
			*ext = Extensions{}
		}
		if _, ok := (*ext)[k]; ok {
			return fmt.Errorf("unknown field %q conflicts with extensions", k)
		}
		(*ext)[k] = v
	}
	return nil
}

func (v *Catalog) UnmarshalJSON(b []byte) error {
	type plain Catalog
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Monster) UnmarshalJSON(b []byte) error {
	type plain Monster
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Stats) UnmarshalJSON(b []byte) error {
	type plain Stats
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Images) UnmarshalJSON(b []byte) error {
	type plain Images
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Skill) UnmarshalJSON(b []byte) error {
	type plain Skill
	var raw map[string]json.RawMessage
	if e := json.Unmarshal(b, &raw); e != nil {
		return e
	}
	if _, ok := raw["power"]; !ok {
		return fmt.Errorf("skill.power is required (use null for unknown)")
	}
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *SkillRule) UnmarshalJSON(b []byte) error {
	type plain SkillRule
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Type) UnmarshalJSON(b []byte) error {
	type plain Type
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Trait) UnmarshalJSON(b []byte) error {
	type plain Trait
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *Learnset) UnmarshalJSON(b []byte) error {
	type plain Learnset
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *LearnedSkill) UnmarshalJSON(b []byte) error {
	type plain LearnedSkill
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
func (v *SourceRef) UnmarshalJSON(b []byte) error {
	type plain SourceRef
	return decodeExtended(b, (*plain)(v), &v.Extensions)
}
