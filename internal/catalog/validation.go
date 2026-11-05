package catalog

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"

	"xhmwiki/internal/sourcebaseline"
)

// Validate checks a complete catalog, not a partial update. An intentionally
// empty own learning surface is valid; missing/null learning data is not.
func Validate(c *Catalog) error {
	if c == nil {
		return fmt.Errorf("catalog is nil")
	}
	if c.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported schema_version %d (expected %d)", c.SchemaVersion, SchemaVersion)
	}
	if len(c.Monsters) == 0 || len(c.Skills) == 0 || len(c.Types) == 0 || len(c.Traits) == 0 || len(c.Learnsets) == 0 {
		return fmt.Errorf("catalog collections must all be nonempty")
	}
	if err := validateExtensions(reflect.ValueOf(c), "catalog"); err != nil {
		return err
	}
	if _, err := sourcebaseline.Decode(c.Extensions[sourcebaseline.Extension]); err != nil {
		return err
	}
	x := indexCatalog(c)
	if len(x.monsters) != len(c.Monsters) {
		return fmt.Errorf("duplicate monster ID")
	}
	if len(x.skills) != len(c.Skills) {
		return fmt.Errorf("duplicate skill ID")
	}
	if len(x.types) != len(c.Types) {
		return fmt.Errorf("duplicate type ID")
	}
	if len(x.traits) != len(c.Traits) {
		return fmt.Errorf("duplicate trait ID")
	}
	if len(x.learnsets) != len(c.Learnsets) {
		return fmt.Errorf("duplicate learnset monster_id")
	}
	if len(x.rules) != len(c.SkillRules) {
		return fmt.Errorf("duplicate skill rule skill_id")
	}
	codes := map[string]bool{}
	for _, t := range c.Types {
		if t.ID < 0 || t.ID > maxID || blank(t.Code) || blank(t.Name) {
			return fmt.Errorf("invalid type %d", t.ID)
		}
		if codes[t.Code] {
			return fmt.Errorf("duplicate type code %q", t.Code)
		}
		codes[t.Code] = true
		if t.ID == 0 {
			if t.Code != "None" || len(t.VulnerableTo) > 0 || len(t.ResistantTo) > 0 {
				return fmt.Errorf("type 0 must be neutral None")
			}
		} else if t.Code == "None" || t.RuntimeOnly {
			return fmt.Errorf("runtime-only/None type must have ID 0")
		}
		if t.VulnerableTo == nil || t.ResistantTo == nil {
			return fmt.Errorf("type %d relations must be explicit arrays", t.ID)
		}
		seen := map[int]bool{}
		for _, ids := range [][]int{t.VulnerableTo, t.ResistantTo} {
			for _, id := range ids {
				if x.types[id] == nil {
					return fmt.Errorf("type %d references missing type %d", t.ID, id)
				}
				if seen[id] {
					return fmt.Errorf("type %d duplicate/contradictory relation %d", t.ID, id)
				}
				seen[id] = true
			}
		}
		if err := validateRef(t.SourceRef); err != nil {
			return fmt.Errorf("type %d: %w", t.ID, err)
		}
		if err := protectPatch(t.Extensions, []string{"id", "name"}); err != nil {
			return err
		}
	}
	traitDefinitions := map[string]bool{}
	for _, t := range c.Traits {
		if blank(t.ID) || blank(t.Name) || blank(t.Description) {
			return fmt.Errorf("invalid trait %q", t.ID)
		}
		def := t.Name + "\x00" + t.Description
		if traitDefinitions[def] {
			return fmt.Errorf("duplicate trait definition %q", t.Name)
		}
		traitDefinitions[def] = true
		if err := validateRef(t.SourceRef); err != nil {
			return fmt.Errorf("trait %s: %w", t.ID, err)
		}
	}
	names := map[string]int{}
	register := func(name string, id int) error {
		key := normalizeName(name)
		if key == "" {
			return fmt.Errorf("empty alias for monster %d", id)
		}
		if prior, ok := names[key]; ok && prior != id {
			return fmt.Errorf("ambiguous monster name/alias %q (%d/%d)", name, prior, id)
		}
		names[key] = id
		return nil
	}
	for _, m := range c.Monsters {
		if !validID(m.ID) || blank(m.Name) || m.DexNumber < 0 || m.DexNumber > maxID {
			return fmt.Errorf("invalid monster identity %d", m.ID)
		}
		if err := register(displayName(m), m.ID); err != nil {
			return err
		}
		for _, alias := range m.Aliases {
			if err := register(alias, m.ID); err != nil {
				return err
			}
		}
		if len(m.TypeIDs) < 1 || len(m.TypeIDs) > 2 {
			return fmt.Errorf("monster %d must have one or two types", m.ID)
		}
		for i, id := range m.TypeIDs {
			if x.types[id] == nil {
				return fmt.Errorf("monster %d references missing type %d", m.ID, id)
			}
			if i == 1 && (id == m.TypeIDs[0] || id == 0 || m.TypeIDs[0] == 0) {
				return fmt.Errorf("monster %d invalid secondary type", m.ID)
			}
		}
		if x.traits[m.TraitID] == nil {
			return fmt.Errorf("monster %d references missing trait %q", m.ID, m.TraitID)
		}
		for _, v := range []int{m.Stats.HP, m.Stats.PhyAtk, m.Stats.PhyDef, m.Stats.MagAtk, m.Stats.MagDef, m.Stats.Speed} {
			if v < 1 || v > 10000 {
				return fmt.Errorf("monster %d stat outside 1..10000", m.ID)
			}
		}
		switch m.FormCategory {
		case "无多形态", "主形态":
			if m.MainFormID != 0 {
				return fmt.Errorf("monster %d nonvariant has main_form_id", m.ID)
			}
		case "变体形态":
			if m.MainFormID == 0 {
				return fmt.Errorf("monster %d variant missing main_form_id", m.ID)
			}
		default:
			return fmt.Errorf("monster %d invalid form_category %q", m.ID, m.FormCategory)
		}
		if blank(m.Form) || blank(m.EvolutionStage) {
			return fmt.Errorf("monster %d missing form/evolution stage", m.ID)
		}
		if m.MainFormID != 0 {
			p := x.monsters[m.MainFormID]
			if p == nil || p.ID == m.ID {
				return fmt.Errorf("monster %d invalid main_form_id %d", m.ID, m.MainFormID)
			}
			if p.Name != m.Name || p.FormCategory != "主形态" {
				return fmt.Errorf("monster %d main form must reference same-name primary form", m.ID)
			}
		}
		if m.EvolutionMembers == nil {
			return fmt.Errorf("monster %d evolution_members must be an explicit array", m.ID)
		}
		members := map[int]bool{}
		for _, id := range m.EvolutionMembers {
			if x.monsters[id] == nil || members[id] {
				return fmt.Errorf("monster %d duplicate/missing evolution member %d", m.ID, id)
			}
			members[id] = true
		}
		if m.EvolvesFromID != 0 {
			if x.monsters[m.EvolvesFromID] == nil || m.EvolvesFromID == m.ID || !members[m.EvolvesFromID] {
				return fmt.Errorf("monster %d invalid evolves_from_id %d (must belong to evolution_members)", m.ID, m.EvolvesFromID)
			}
		}
		if m.LeaderOfID != 0 && m.EvolvesFromID != 0 {
			return fmt.Errorf("monster %d: leader_of_id 与 evolves_from_id 不可并存；请同时选择对应普通进化候选或清除普通前置", m.ID)
		}
		if m.LeaderOfID != 0 && (x.monsters[m.LeaderOfID] == nil || m.LeaderOfID == m.ID) {
			return fmt.Errorf("monster %d invalid leader_of_id %d", m.ID, m.LeaderOfID)
		}
		if m.DefaultLevel != 0 && (m.DefaultLevel < 1 || m.DefaultLevel > 99) {
			return fmt.Errorf("monster %d level outside 1..99", m.ID)
		}
		if m.LevelConfigurable && m.DefaultLevel == 0 {
			return fmt.Errorf("monster %d configurable level requires explicit default", m.ID)
		}
		if err := ValidateLevelRange(m.DefaultLevel, m.LevelMin, m.LevelMax, m.LevelStep); err != nil {
			return fmt.Errorf("monster %d: %w", m.ID, err)
		}
		if m.Placeholder && blank(m.DataNote) {
			return fmt.Errorf("monster %d placeholder requires data_note", m.ID)
		}
		for _, tag := range m.SearchTags {
			if blank(tag) {
				return fmt.Errorf("monster %d empty search tag", m.ID)
			}
		}
		if x.learnsets[m.ID] == nil {
			return fmt.Errorf("monster %d has no explicit learnset", m.ID)
		}
		if err := validateRef(m.SourceRef); err != nil {
			return fmt.Errorf("monster %d: %w", m.ID, err)
		}
		if err := protectPatch(m.Extensions, []string{"id", "base_hp", "base_phy_atk", "base_phy_def", "base_mag_atk", "base_mag_def", "base_spd", "main_type/id", "sub_type/id", "learnset_mode", "learnset_inherits_from_id", "evolves_from_id", "evolution_members", "leader_of_id", "main_form_id", "default_level", "level_configurable", "level_min", "level_max", "level_step", "season"}); err != nil {
			return fmt.Errorf("monster %d: %w", m.ID, err)
		}
	}
	skillNames := map[string]bool{}
	for _, s := range c.Skills {
		if !validID(s.ID) || blank(s.Name) || blank(s.Description) {
			return fmt.Errorf("invalid skill %d", s.ID)
		}
		if skillNames[s.Name] {
			return fmt.Errorf("ambiguous master skill name %q", s.Name)
		}
		skillNames[s.Name] = true
		if x.types[s.TypeID] == nil {
			return fmt.Errorf("skill %d references missing type %d", s.ID, s.TypeID)
		}
		switch s.Category {
		case "Physical Attack", "Magic Attack", "Status", "Defense":
		default:
			return fmt.Errorf("skill %d invalid category %q", s.ID, s.Category)
		}
		if !bounded(s.EnergyCost, 0, 10000) {
			return fmt.Errorf("skill %d invalid energy_cost", s.ID)
		}
		if s.Power != nil && !bounded(*s.Power, 0, 1e9) {
			return fmt.Errorf("skill %d invalid power", s.ID)
		}
		if err := validateRef(s.SourceRef); err != nil {
			return fmt.Errorf("skill %d: %w", s.ID, err)
		}
		if err := protectPatch(s.Extensions, []string{"id", "power", "energy_cost", "move_category", "move_type/id", "base_combo", "power_formula", "season"}); err != nil {
			return fmt.Errorf("skill %d: %w", s.ID, err)
		}
	}
	for _, r := range c.SkillRules {
		if x.skills[r.SkillID] == nil {
			return fmt.Errorf("rule references missing skill %d", r.SkillID)
		}
		if r.BaseCombo != nil && (*r.BaseCombo < 1 || *r.BaseCombo > 10000) {
			return fmt.Errorf("skill %d invalid base_combo", r.SkillID)
		}
		// Formula identifiers are preserved as supplied, not interpreted or guessed.
		if r.PowerFormula != "" && blank(r.PowerFormula) {
			return fmt.Errorf("skill %d blank power_formula", r.SkillID)
		}
	}
	for _, l := range c.Learnsets {
		if x.monsters[l.MonsterID] == nil {
			return fmt.Errorf("learnset references missing monster %d", l.MonsterID)
		}
		if l.Skills == nil {
			return fmt.Errorf("learnset %d skills must be an explicit array", l.MonsterID)
		}
		switch l.Mode {
		case "own":
			if l.FromID != 0 {
				return fmt.Errorf("own learnset %d must not inherit", l.MonsterID)
			}
		case "inherit":
			if l.FromID == 0 || l.FromID == l.MonsterID || x.monsters[l.FromID] == nil {
				return fmt.Errorf("inherit learnset %d has invalid from_id", l.MonsterID)
			}
		default:
			return fmt.Errorf("learnset %d invalid mode %q", l.MonsterID, l.Mode)
		}
		for j, s := range l.Skills {
			if x.skills[s.SkillID] == nil {
				return fmt.Errorf("learnset %d row %d missing skill %d", l.MonsterID, j, s.SkillID)
			}
			if blank(s.Source) {
				return fmt.Errorf("learnset %d row %d empty source", l.MonsterID, j)
			}
		}
		if err := validateRef(l.SourceRef); err != nil {
			return fmt.Errorf("learnset %d: %w", l.MonsterID, err)
		}
		if err := validateLearnsetExtensions(l); err != nil {
			return err
		}
		if err := protectPatch(l.Extensions, []string{"monster_id", "skills", "aliases"}); err != nil {
			return err
		}
	}
	for _, graph := range []struct {
		name string
		next func(int) int
	}{{"leader", func(id int) int { return x.monsters[id].LeaderOfID }}, {"evolution", func(id int) int { return x.monsters[id].EvolvesFromID }}, {"main form", func(id int) int { return x.monsters[id].MainFormID }}, {"learnset inheritance", func(id int) int { return x.learnsets[id].FromID }}} {
		state := map[int]uint8{}
		var visit func(int) error
		visit = func(id int) error {
			if id == 0 {
				return nil
			}
			if state[id] == 1 {
				return fmt.Errorf("%s cycle at monster %d", graph.name, id)
			}
			if state[id] == 2 {
				return nil
			}
			state[id] = 1
			if e := visit(graph.next(id)); e != nil {
				return e
			}
			state[id] = 2
			return nil
		}
		for _, m := range c.Monsters {
			if e := visit(m.ID); e != nil {
				return e
			}
		}
	}
	// The authorized local placeholder has an explicit, unambiguous learning
	// surface and level metadata. Keep this guard conditional on placeholder so a
	// future reviewed replacement by real data can be represented normally.
	if m := x.monsters[619]; m != nil && m.Placeholder {
		l := x.learnsets[619]
		// Type approval is independent of the two historical stat tuples below.
		// Preserve legacy None; the only real types approved are Dragon MAIN,
		// Ghost SECONDARY, with both stable IDs and actual type codes checked.
		legacyTypes := len(m.TypeIDs) == 1 && m.TypeIDs[0] == 0
		approvedTypes := len(m.TypeIDs) == 2 && m.TypeIDs[0] == 8 && m.TypeIDs[1] == 15 &&
			x.types[8] != nil && x.types[8].Code == "Dragon" && x.types[15] != nil && x.types[15].Code == "Ghost"
		if m.Name != "冥古龙" || m.DefaultLevel != 99 || !m.LevelConfigurable || (!legacyTypes && !approvedTypes) || l.Mode != "own" || len(l.Skills) != 0 || m.Images.Avatar != "" || m.Images.Portrait != "" {
			return fmt.Errorf("monster 619 placeholder metadata/learning/images changed")
		}
		// Keep legacy immutable versions readable while accepting only the
		// complete user-approved replacement, never mixed/partial stat edits.
		stats := [6]int{m.Stats.HP, m.Stats.PhyAtk, m.Stats.PhyDef, m.Stats.MagAtk, m.Stats.MagDef, m.Stats.Speed}
		if stats != ([6]int{100, 100, 100, 100, 100, 100}) && stats != ([6]int{118, 128, 81, 42, 63, 70}) {
			return fmt.Errorf("monster 619 placeholder stats must match the legacy or approved complete tuple")
		}
	}
	return nil
}

const maxID = 2147483647

func validID(id int) bool { return id > 0 && id <= maxID }
func blank(s string) bool { return strings.TrimSpace(s) == "" }
func bounded(v, min, max float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= min && v <= max
}
func validateRef(r *SourceRef) error {
	if r != nil {
		if blank(r.Provider) || blank(r.ID) || blank(r.Identity) {
			return fmt.Errorf("source_ref requires nonempty provider, id and identity")
		}
		for _, key := range []string{"provider", "id", "identity"} {
			if _, exists := r.Extensions[key]; exists {
				return fmt.Errorf("source_ref extension cannot override %s", key)
			}
		}
	}
	return nil
}

// Raw extension values must themselves be well-formed single JSON values; nil
// RawMessage would otherwise become null silently during marshaling.
func validateExtensions(v reflect.Value, path string) error {
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		return validateExtensions(v.Elem(), path)
	}
	if v.Type() == reflect.TypeOf(Extensions{}) {
		for _, key := range v.MapKeys() {
			k := key.String()
			if blank(k) {
				return fmt.Errorf("%s empty extension key", path)
			}
			raw := v.MapIndex(key).Interface().(json.RawMessage)
			if e := checkJSON(raw); e != nil {
				return fmt.Errorf("%s extension %q: %w", path, k, e)
			}
		}
		return nil
	}
	switch v.Kind() {
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if e := validateExtensions(v.Field(i), path+"."+v.Type().Field(i).Name); e != nil {
				return e
			}
		}
	case reflect.Slice:
		for i := 0; i < v.Len(); i++ {
			if e := validateExtensions(v.Index(i), path+"[]"); e != nil {
				return e
			}
		}
	}
	return nil
}
func protectPatch(ext Extensions, paths []string) error {
	var patch object
	if b := ext["legacy"]; len(b) > 0 {
		if e := json.Unmarshal(b, &patch); e != nil || patch == nil {
			return fmt.Errorf("legacy extension must be an object")
		}
	}
	for _, path := range paths {
		cur := patch
		parts := strings.Split(path, "/")
		for i, p := range parts {
			b, ok := cur[p]
			if !ok {
				break
			}
			if i == len(parts)-1 {
				return fmt.Errorf("legacy patch must not override core field %s", path)
			}
			if json.Unmarshal(b, &cur) != nil || cur == nil {
				break
			}
		}
	}
	if b := ext["legacy_omit"]; len(b) > 0 {
		var omits []string
		if e := json.Unmarshal(b, &omits); e != nil || omits == nil {
			return fmt.Errorf("legacy_omit must be a string array")
		}
		for _, omit := range omits {
			if omit == "" {
				return fmt.Errorf("empty legacy omission path")
			}
			for _, path := range paths {
				if omit == path || strings.HasPrefix(path, omit+"/") {
					return fmt.Errorf("legacy omission must not remove core field %s", path)
				}
			}
		}
	}
	return nil
}
func validateLearnsetExtensions(l Learnset) error {
	for _, key := range []string{"legacy_skills", "legacy_skill_omit"} {
		if b := l.Extensions[key]; len(b) > 0 {
			var values map[string]json.RawMessage
			if e := json.Unmarshal(b, &values); e != nil || values == nil {
				return fmt.Errorf("learnset %d %s must be object", l.MonsterID, key)
			}
			for k, v := range values {
				i, e := strconv.Atoi(k)
				if e != nil || i < 0 || i >= len(l.Skills) || strconv.Itoa(i) != k {
					return fmt.Errorf("learnset %d invalid legacy row index %q", l.MonsterID, k)
				}
				if key == "legacy_skills" {
					var row object
					if e := json.Unmarshal(v, &row); e != nil || row == nil {
						return fmt.Errorf("invalid legacy row patch")
					}
					if _, ok := row["name"]; ok {
						return fmt.Errorf("legacy row patch cannot override skill identity")
					}
					if _, ok := row["source"]; ok {
						var source string
						if e := json.Unmarshal(row["source"], &source); e != nil || source != "" {
							return fmt.Errorf("legacy row patch cannot change learning source")
						}
					}
				} else {
					var paths []string
					if e := json.Unmarshal(v, &paths); e != nil || paths == nil {
						return fmt.Errorf("invalid legacy row omission")
					}
					for _, path := range paths {
						if path == "name" {
							return fmt.Errorf("legacy row omission cannot remove skill identity")
						}
					}
				}
			}
		}
	}
	return nil
}
