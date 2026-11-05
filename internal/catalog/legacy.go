package catalog

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

type object map[string]json.RawMessage

// ImportLegacy is an all-or-error, in-memory migration. It never reads files,
// fills failed requests with empty collections, or changes existing local IDs.
func ImportLegacy(files LegacyFiles) (*Catalog, error) {
	c := &Catalog{SchemaVersion: SchemaVersion}
	var mr, sr, tr []object
	var wr map[string]object
	for _, part := range []struct {
		name string
		data []byte
		out  any
	}{{"monsters", files.Monsters, &mr}, {"moves", files.Moves, &sr}, {"types", files.Types, &tr}, {"wiki", files.Wiki, &wr}} {
		if err := checkJSON(part.data); err != nil {
			return nil, fmt.Errorf("legacy %s: %w", part.name, err)
		}
		if err := json.Unmarshal(part.data, part.out); err != nil {
			return nil, fmt.Errorf("legacy %s: %w", part.name, err)
		}
	}
	if len(mr) == 0 || len(sr) == 0 || len(tr) == 0 || len(wr) == 0 {
		return nil, fmt.Errorf("legacy collections must all be nonempty")
	}
	typeByCode := map[string]int{}
	for i, r := range tr {
		var t Type
		if err := fields(r, req("id", &t.ID), req("name", &t.Code), opt("_source_ref", &t.SourceRef)); err != nil {
			return nil, fmt.Errorf("type[%d]: %w", i, err)
		}
		if err := localized(r, &t.Name, nil); err != nil {
			return nil, err
		}
		if _, ok := typeByCode[t.Code]; ok {
			return nil, fmt.Errorf("duplicate type code %q", t.Code)
		}
		typeByCode[t.Code] = t.ID
		c.Types = append(c.Types, t)
	}
	for i, r := range tr {
		var vulnerable, resistant []string
		if err := fields(r, req("vulnerable_to", &vulnerable), req("resistant_to", &resistant)); err != nil {
			return nil, err
		}
		for _, pair := range []struct {
			codes []string
			out   *[]int
		}{{vulnerable, &c.Types[i].VulnerableTo}, {resistant, &c.Types[i].ResistantTo}} {
			*pair.out = []int{}
			for _, code := range pair.codes {
				id, ok := typeByCode[code]
				if !ok {
					return nil, fmt.Errorf("unknown type relation %q", code)
				}
				*pair.out = append(*pair.out, id)
			}
		}
	}
	needNone := false
	skillByName := map[string]*Skill{}
	for i, r := range sr {
		var s Skill
		var typ object
		var combo *int
		var formula *string
		if err := fields(r, req("id", &s.ID), req("move_type", &typ), req("move_category", &s.Category), req("energy_cost", &s.EnergyCost), reqNullable("power", &s.Power), opt("season", &s.Season), opt("base_combo", &combo), opt("power_formula", &formula), opt("_source_ref", &s.SourceRef)); err != nil {
			return nil, fmt.Errorf("move[%d]: %w", i, err)
		}
		if err := fields(typ, req("id", &s.TypeID)); err != nil {
			return nil, err
		}
		if s.TypeID == 0 {
			needNone = true
		}
		if err := localized(r, &s.Name, &s.Description); err != nil {
			return nil, err
		}
		if _, ok := skillByName[s.Name]; ok {
			return nil, fmt.Errorf("ambiguous master skill name %q", s.Name)
		}
		// Pointers are rebuilt after append; this map is only a duplicate-name set here.
		skillByName[s.Name] = nil
		c.Skills = append(c.Skills, s)
		rule := SkillRule{SkillID: s.ID, BaseCombo: combo}
		if formula != nil {
			rule.PowerFormula = *formula
		}
		if combo != nil || formula != nil && *formula != "" {
			c.SkillRules = append(c.SkillRules, rule)
		}
	}
	for i := range c.Skills {
		skillByName[c.Skills[i].Name] = &c.Skills[i]
	}
	traitByDefinition := map[string]string{}
	monsterByID := map[int]*Monster{}
	mainFormNames := map[int]string{}
	for i, r := range mr {
		var m Monster
		var main, sub, trait object
		var mainForm, status, projectedTraitID string
		var mode string
		var from int
		if err := fields(r, req("id", &m.ID), req("dex_number", &m.DexNumber), opt("season", &m.Season), req("main_type", &main), opt("sub_type", &sub), req("trait", &trait), opt("_trait_id", &projectedTraitID), req("base_hp", &m.Stats.HP), req("base_phy_atk", &m.Stats.PhyAtk), req("base_phy_def", &m.Stats.PhyDef), req("base_mag_atk", &m.Stats.MagAtk), req("base_mag_def", &m.Stats.MagDef), req("base_spd", &m.Stats.Speed), opt("image", &m.Images.Avatar), req("form", &m.Form), req("form_category", &m.FormCategory), opt("main_form_name", &mainForm), opt("main_form_id", &m.MainFormID), req("evolution_stage", &m.EvolutionStage), opt("evolution_chain_name", &m.EvolutionChainName), opt("evolves_from_id", &m.EvolvesFromID), opt("leader_of_id", &m.LeaderOfID), opt("is_leader_form", &m.IsLeaderForm), opt("hidden", &m.Hidden), opt("aliases", &m.Aliases), opt("search_tags", &m.SearchTags), opt("default_level", &m.DefaultLevel), opt("level_configurable", &m.LevelConfigurable), opt("level_min", &m.LevelMin), opt("level_max", &m.LevelMax), opt("level_step", &m.LevelStep), opt("data_status", &status), opt("data_note", &m.DataNote), opt("_source_ref", &m.SourceRef), req("learnset_mode", &mode), opt("learnset_inherits_from_id", &from)); err != nil {
			return nil, fmt.Errorf("monster[%d]: %w", i, err)
		}
		if _, present := r["evolution_members"]; present {
			if err := fields(r, req("evolution_members", &m.EvolutionMembers)); err != nil {
				return nil, fmt.Errorf("monster[%d]: %w", i, err)
			}
		}
		if err := localized(r, &m.Name, nil); err != nil {
			return nil, err
		}
		var typeID int
		if err := fields(main, req("id", &typeID)); err != nil {
			return nil, err
		}
		m.TypeIDs = []int{typeID}
		if typeID == 0 {
			needNone = true
		}
		if sub != nil {
			if err := fields(sub, req("id", &typeID)); err != nil {
				return nil, err
			}
			m.TypeIDs = append(m.TypeIDs, typeID)
			if typeID == 0 {
				needNone = true
			}
		}
		var t Trait
		if err := localized(trait, &t.Name, &t.Description); err != nil {
			return nil, err
		}
		if err := fields(trait, opt("_source_ref", &t.SourceRef)); err != nil {
			return nil, err
		}
		definition := t.Name + "\x00" + t.Description
		if id, ok := traitByDefinition[definition]; ok {
			m.TraitID = id
		} else {
			sum := sha256.Sum256([]byte(definition))
			t.ID = "trait-" + hex.EncodeToString(sum[:16])
			m.TraitID = t.ID
			traitByDefinition[definition] = t.ID
			c.Traits = append(c.Traits, t)
		}
		m.Placeholder = status == "placeholder"
		mainFormNames[m.ID] = mainForm
		c.Monsters = append(c.Monsters, m)
		c.Learnsets = append(c.Learnsets, Learnset{MonsterID: m.ID, Mode: mode, FromID: from, Skills: []LearnedSkill{}})
	}
	if needNone {
		if _, exists := typeByCode["None"]; !exists {
			c.Types = append(c.Types, Type{ID: 0, Code: "None", Name: "无", RuntimeOnly: true, VulnerableTo: []int{}, ResistantTo: []int{}})
		}
	}
	byName := map[string]int{}
	register := func(name string, id int) error {
		key := normalizeName(name)
		if key == "" {
			return fmt.Errorf("empty identity for monster %d", id)
		}
		if prior, ok := byName[key]; ok && prior != id {
			return fmt.Errorf("ambiguous monster identity %q (%d/%d)", name, prior, id)
		}
		byName[key] = id
		return nil
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		if monsterByID[m.ID] != nil {
			return nil, fmt.Errorf("duplicate monster ID %d", m.ID)
		}
		monsterByID[m.ID] = m
		if err := register(displayName(*m), m.ID); err != nil {
			return nil, err
		}
		for _, alias := range m.Aliases {
			if err := register(alias, m.ID); err != nil {
				return nil, err
			}
		}
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		// Current projections carry stable IDs. Only historical input without
		// that field may resolve the old form label; explicit null never guesses.
		if _, explicit := mr[i]["main_form_id"]; explicit {
			continue
		}
		if form := mainFormNames[m.ID]; form != "" {
			for j := range c.Monsters {
				candidate := &c.Monsters[j]
				if candidate.Name == m.Name && candidate.Form == form {
					if m.MainFormID != 0 {
						return nil, fmt.Errorf("ambiguous main form for %d", m.ID)
					}
					m.MainFormID = candidate.ID
				}
			}
			if m.MainFormID == 0 {
				return nil, fmt.Errorf("main form %q missing for %d", form, m.ID)
			}
		}
	}
	// The four historical bare-name rows were used by the old suffix fallback.
	// Bind ONLY the verified winter main identities, never a filename or an
	// arbitrary first same-name form. A changed fixture makes migration fail.
	winter := map[string]int{"雪绒鸟": 40, "冬羽雀": 44, "岚鸟": 48, "霜翼领主": 49}
	keys := make([]string, 0, len(wr))
	for k := range wr {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	resolved := map[string]int{}
	for _, key := range keys {
		r := wr[key]
		if r == nil {
			return nil, fmt.Errorf("wiki %q is null", key)
		}
		var id int
		var aliases []string
		if err := fields(r, opt("monster_id", &id), opt("aliases", &aliases)); err != nil {
			return nil, err
		}
		if id == 0 {
			id = byName[normalizeName(key)]
			if id == 0 {
				if candidate, ok := winter[key]; ok {
					m := monsterByID[candidate]
					if m == nil || m.Name != key || m.Form != "冬天的样子" || m.FormCategory != "主形态" {
						return nil, fmt.Errorf("winter migration identity mismatch for %q -> %d", key, candidate)
					}
					id = candidate
				}
			}
		}
		if id == 0 {
			continue
		} // A later explicit-ID alias may resolve it in pass two.
		if monsterByID[id] == nil {
			return nil, fmt.Errorf("wiki %q references unknown monster %d", key, id)
		}
		if err := register(key, id); err != nil {
			return nil, err
		}
		for _, alias := range aliases {
			if err := register(alias, id); err != nil {
				return nil, err
			}
		}
		resolved[key] = id
	}
	grouped := map[int]object{}
	for _, key := range keys {
		id := resolved[key]
		if id == 0 {
			id = byName[normalizeName(key)]
		}
		if id == 0 {
			return nil, fmt.Errorf("wiki identity %q cannot be resolved", key)
		}
		m := monsterByID[id]
		var aliases []string
		if err := fields(wr[key], opt("aliases", &aliases)); err != nil {
			return nil, err
		}
		if key != displayName(*m) {
			m.Aliases = appendUnique(m.Aliases, key)
		}
		for _, alias := range aliases {
			if alias != displayName(*m) {
				m.Aliases = appendUnique(m.Aliases, alias)
			}
		}
		if prior := grouped[id]; prior != nil {
			merged, e := mergeWiki(prior, wr[key])
			if e != nil {
				return nil, fmt.Errorf("wiki aliases for %d: %w", id, e)
			}
			grouped[id] = merged
		} else {
			grouped[id] = cloneObject(wr[key])
		}
	}
	for i := range c.Learnsets {
		l := &c.Learnsets[i]
		m := monsterByID[l.MonsterID]
		r := grouped[m.ID]
		if r == nil {
			return nil, fmt.Errorf("missing explicit Wiki learning data for monster %d", m.ID)
		}
		var rows []object
		if err := fields(r, req("skills", &rows), opt("image", &m.Images.Portrait), opt("_source_ref", &l.SourceRef)); err != nil {
			return nil, fmt.Errorf("wiki %d: %w", m.ID, err)
		}
		for j, row := range rows {
			var name, source string
			if err := fields(row, req("name", &name), opt("source", &source)); err != nil {
				return nil, err
			}
			if source == "" {
				source = "默认"
			}
			s := skillByName[name]
			if s == nil {
				return nil, fmt.Errorf("wiki %d skills[%d] unknown master skill %q", m.ID, j, name)
			}
			l.Skills = append(l.Skills, LearnedSkill{SkillID: s.ID, Source: source})
		}
	}
	allMissing := true
	for _, m := range c.Monsters {
		allMissing = allMissing && m.EvolutionMembers == nil
	}
	if err := initializeEvolutionMembers(c, allMissing); err != nil {
		return nil, err
	}
	// Store sparse differences against the typed projection. Known dead fields
	// are intentionally retired, not copied into the active core or extensions.
	idx := indexCatalog(c)
	for i, r := range tr {
		savePatch(&c.Types[i].Extensions, r, typeLegacy(c.Types[i], idx), nil)
	}
	for i, r := range sr {
		savePatch(&c.Skills[i].Extensions, r, skillLegacy(c.Skills[i], idx), map[string]bool{"statuses": true})
	}
	for i, r := range mr {
		m := &c.Monsters[i]
		base := monsterLegacy(*m, idx)
		ignore := map[string]bool{"preferred_attack_style": true, "leader_potential": true, "aliases": true, "evolution_members": true, "leader_of_id": true, "main_form_id": true, "season": true}
		if equalJSON(r["default_legacy_type"], r["main_type"]) {
			ignore["default_legacy_type"] = true
		}
		savePatch(&m.Extensions, r, base, ignore)
	}
	for i := range c.Learnsets {
		l := &c.Learnsets[i]
		r := grouped[l.MonsterID]
		base := wikiLegacy(*l, idx)
		savePatch(&l.Extensions, r, base, map[string]bool{"skills": true, "monster_id": true, "aliases": true})
		var rows, defaults []object
		_ = json.Unmarshal(r["skills"], &rows)
		_ = json.Unmarshal(base["skills"], &defaults)
		patches := map[string]object{}
		omits := map[string][]string{}
		for j, row := range rows {
			patch, omit := difference(row, defaults[j], nil)
			if len(patch) > 0 {
				patches[strconv.Itoa(j)] = patch
			}
			if len(omit) > 0 {
				omits[strconv.Itoa(j)] = omit
			}
		}
		if len(patches) > 0 {
			setExtension(&l.Extensions, "legacy_skills", rawJSON(patches))
		}
		if len(omits) > 0 {
			setExtension(&l.Extensions, "legacy_skill_omit", rawJSON(omits))
		}
	}
	if err := Validate(c); err != nil {
		return nil, fmt.Errorf("legacy import: %w", err)
	}
	return c, nil
}

// ExportLegacy projects compatible views without restoring dead historical
// fields. Unknown fields and actual legacy description/rule differences survive.
func ExportLegacy(c *Catalog) (LegacyFiles, error) {
	if err := Validate(c); err != nil {
		return LegacyFiles{}, err
	}
	idx := indexCatalog(c)
	monsters := []object{}
	skills := []object{}
	types := []object{}
	wiki := map[string]object{}
	for _, t := range c.Types {
		if !t.RuntimeOnly {
			r := typeLegacy(t, idx)
			if e := applyExtensions(r, t.Extensions); e != nil {
				return LegacyFiles{}, e
			}
			types = append(types, r)
		}
	}
	for _, s := range c.Skills {
		r := skillLegacy(s, idx)
		if e := applyExtensions(r, s.Extensions); e != nil {
			return LegacyFiles{}, e
		}
		skills = append(skills, r)
	}
	for _, m := range c.Monsters {
		r := monsterLegacy(m, idx)
		if e := applyExtensions(r, m.Extensions); e != nil {
			return LegacyFiles{}, e
		}
		monsters = append(monsters, r)
	}
	for _, l := range c.Learnsets {
		r := wikiLegacy(l, idx)
		if e := applyExtensions(r, l.Extensions); e != nil {
			return LegacyFiles{}, e
		}
		var rows []object
		_ = json.Unmarshal(r["skills"], &rows)
		var patches map[string]object
		var omits map[string][]string
		if b := l.Extensions["legacy_skills"]; len(b) > 0 {
			if e := json.Unmarshal(b, &patches); e != nil {
				return LegacyFiles{}, e
			}
		}
		if b := l.Extensions["legacy_skill_omit"]; len(b) > 0 {
			if e := json.Unmarshal(b, &omits); e != nil {
				return LegacyFiles{}, e
			}
		}
		for key, p := range patches {
			j, e := strconv.Atoi(key)
			if e != nil || j < 0 || j >= len(rows) {
				return LegacyFiles{}, fmt.Errorf("legacy row patch index %q invalid", key)
			}
			mergePatch(rows[j], p)
		}
		for key, paths := range omits {
			j, e := strconv.Atoi(key)
			if e != nil || j < 0 || j >= len(rows) {
				return LegacyFiles{}, fmt.Errorf("legacy row omit index %q invalid", key)
			}
			for _, path := range paths {
				deletePath(rows[j], strings.Split(path, "/"))
			}
		}
		r["skills"] = rawJSON(rows)
		wiki[displayName(*idx.monsters[l.MonsterID])] = r
	}
	return LegacyFiles{Monsters: rawJSON(monsters), Moves: rawJSON(skills), Types: rawJSON(types), Wiki: rawJSON(wiki)}, nil
}

type catalogIndex struct {
	monsters  map[int]*Monster
	skills    map[int]*Skill
	types     map[int]*Type
	traits    map[string]*Trait
	learnsets map[int]*Learnset
	rules     map[int]*SkillRule
}

func indexCatalog(c *Catalog) catalogIndex {
	x := catalogIndex{map[int]*Monster{}, map[int]*Skill{}, map[int]*Type{}, map[string]*Trait{}, map[int]*Learnset{}, map[int]*SkillRule{}}
	for i := range c.Monsters {
		x.monsters[c.Monsters[i].ID] = &c.Monsters[i]
	}
	for i := range c.Skills {
		x.skills[c.Skills[i].ID] = &c.Skills[i]
	}
	for i := range c.Types {
		x.types[c.Types[i].ID] = &c.Types[i]
	}
	for i := range c.Traits {
		x.traits[c.Traits[i].ID] = &c.Traits[i]
	}
	for i := range c.Learnsets {
		x.learnsets[c.Learnsets[i].MonsterID] = &c.Learnsets[i]
	}
	for i := range c.SkillRules {
		x.rules[c.SkillRules[i].SkillID] = &c.SkillRules[i]
	}
	return x
}
func typeLegacy(t Type, x catalogIndex) object {
	vulnerable, resistant := []string{}, []string{}
	for _, id := range t.VulnerableTo {
		if v := x.types[id]; v != nil {
			vulnerable = append(vulnerable, v.Code)
		}
	}
	for _, id := range t.ResistantTo {
		if v := x.types[id]; v != nil {
			resistant = append(resistant, v.Code)
		}
	}
	r := obj("id", t.ID, "name", t.Code, "localized", obj("zh", t.Name), "vulnerable_to", vulnerable, "resistant_to", resistant)
	putRef(r, t.SourceRef)
	return r
}
func skillLegacy(s Skill, x catalogIndex) object {
	var typ any
	if t := x.types[s.TypeID]; t != nil {
		typ = obj("id", t.ID, "name", t.Code, "localized", obj("zh", t.Name))
	}
	r := obj("id", s.ID, "move_type", typ, "localized", obj("zh", obj("name", s.Name, "description", s.Description)), "move_category", s.Category, "energy_cost", s.EnergyCost, "power", s.Power, "base_combo", nil, "power_formula", nil, "counter_power_multiplier", nil, "alt_power_total", nil, "alt_condition_zh", nil, "season", s.Season)
	if rule := x.rules[s.ID]; rule != nil {
		if rule.BaseCombo != nil {
			r["base_combo"] = rawJSON(rule.BaseCombo)
		}
		if rule.PowerFormula != "" {
			r["power_formula"] = rawJSON(rule.PowerFormula)
		}
	}
	putRef(r, s.SourceRef)
	return r
}
func monsterLegacy(m Monster, x catalogIndex) object {
	var main, sub, trait any
	if len(m.TypeIDs) > 0 {
		if t := x.types[m.TypeIDs[0]]; t != nil {
			main = typeLegacy(*t, x)
		}
	}
	if len(m.TypeIDs) > 1 {
		if t := x.types[m.TypeIDs[1]]; t != nil {
			sub = typeLegacy(*t, x)
		}
	}
	if t := x.traits[m.TraitID]; t != nil {
		r := obj("localized", obj("zh", obj("name", t.Name, "description", t.Description)))
		putRef(r, t.SourceRef)
		trait = r
	}
	var from any
	if m.EvolvesFromID != 0 {
		from = m.EvolvesFromID
	}
	var leader any
	if m.LeaderOfID != 0 {
		leader = m.LeaderOfID
	}
	mainForm := ""
	var mainFormID any
	if m.MainFormID != 0 && x.monsters[m.MainFormID] != nil {
		mainForm = x.monsters[m.MainFormID].Form
		mainFormID = m.MainFormID
	}
	r := obj("id", m.ID, "dex_number", m.DexNumber, "localized", obj("zh", obj("name", m.Name)), "base_hp", m.Stats.HP, "base_phy_atk", m.Stats.PhyAtk, "base_phy_def", m.Stats.PhyDef, "base_mag_atk", m.Stats.MagAtk, "base_mag_def", m.Stats.MagDef, "base_spd", m.Stats.Speed, "main_type", main, "sub_type", sub, "trait", trait, "_trait_id", m.TraitID, "image", m.Images.Avatar, "form", m.Form, "form_category", m.FormCategory, "main_form_id", mainFormID, "main_form_name", mainForm, "evolution_stage", m.EvolutionStage, "evolution_chain_name", m.EvolutionChainName, "evolves_from_id", from, "evolution_members", m.EvolutionMembers, "leader_of_id", leader, "is_leader_form", m.IsLeaderForm)
	if l := x.learnsets[m.ID]; l != nil {
		r["learnset_mode"] = rawJSON(l.Mode)
		if l.FromID != 0 {
			r["learnset_inherits_from_id"] = rawJSON(l.FromID)
		}
	}
	if m.Season != "" {
		r["season"] = rawJSON(m.Season)
	}
	if m.DefaultLevel != 0 {
		r["default_level"] = rawJSON(m.DefaultLevel)
	}
	if m.LevelConfigurable {
		r["level_configurable"] = rawJSON(true)
	}
	if m.LevelMin != 0 {
		r["level_min"] = rawJSON(m.LevelMin)
		r["level_max"] = rawJSON(m.LevelMax)
		r["level_step"] = rawJSON(m.LevelStep)
	}
	if m.Placeholder {
		r["data_status"] = rawJSON("placeholder")
	}
	if m.DataNote != "" {
		r["data_note"] = rawJSON(m.DataNote)
	}
	if m.Hidden {
		r["hidden"] = rawJSON(true)
	}
	if len(m.SearchTags) > 0 {
		r["search_tags"] = rawJSON(m.SearchTags)
	}
	putRef(r, m.SourceRef)
	return r
}
func wikiLegacy(l Learnset, x catalogIndex) object {
	m := x.monsters[l.MonsterID]
	rows := []object{}
	for _, learned := range l.Skills {
		s := x.skills[learned.SkillID]
		if s == nil {
			continue
		}
		element := ""
		if t := x.types[s.TypeID]; t != nil {
			element = t.Name
		}
		category := map[string]string{"Physical Attack": "物攻", "Magic Attack": "魔攻", "Status": "状态", "Defense": "防御"}[s.Category]
		rows = append(rows, obj("name", s.Name, "source", learned.Source, "desc", s.Description, "element", element, "type", category))
	}
	r := obj("monster_id", l.MonsterID, "image", m.Images.Portrait, "skills", rows)
	if len(m.Aliases) > 0 {
		r["aliases"] = rawJSON(m.Aliases)
	}
	putRef(r, l.SourceRef)
	return r
}

func putRef(r object, ref *SourceRef) {
	if ref != nil {
		x := obj("provider", ref.Provider, "id", ref.ID, "identity", ref.Identity)
		for k, v := range ref.Extensions {
			x[k] = v
		}
		r["_source_ref"] = rawJSON(x)
	}
}
func rawJSON(v any) json.RawMessage {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		panic(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
}
func obj(pairs ...any) object {
	r := object{}
	for i := 0; i < len(pairs); i += 2 {
		r[pairs[i].(string)] = rawJSON(pairs[i+1])
	}
	return r
}
func cloneObject(r object) object {
	out := object{}
	for k, v := range r {
		out[k] = append(json.RawMessage(nil), v...)
	}
	return out
}

type field struct {
	key                string
	out                any
	required, nullable bool
}

func req(k string, v any) field         { return field{k, v, true, false} }
func reqNullable(k string, v any) field { return field{k, v, true, true} }
func opt(k string, v any) field         { return field{k, v, false, true} }
func fields(r object, fs ...field) error {
	if r == nil {
		return fmt.Errorf("expected non-null legacy object")
	}
	for _, f := range fs {
		b, ok := r[f.key]
		if !ok {
			if f.required {
				return fmt.Errorf("missing %s", f.key)
			}
			continue
		}
		if bytes.Equal(bytes.TrimSpace(b), []byte("null")) && !f.nullable {
			return fmt.Errorf("%s cannot be null", f.key)
		}
		if e := json.Unmarshal(b, f.out); e != nil {
			return fmt.Errorf("%s: %w", f.key, e)
		}
	}
	return nil
}
func localized(r object, name, description *string) error {
	var loc object
	if e := fields(r, req("localized", &loc)); e != nil {
		return e
	}
	if description == nil {
		var text string
		if json.Unmarshal(loc["zh"], &text) == nil {
			*name = text
			return nil
		}
	}
	var zh object
	if e := fields(loc, req("zh", &zh)); e != nil {
		return e
	}
	if e := fields(zh, req("name", name)); e != nil {
		return e
	}
	if description != nil {
		if e := fields(zh, req("description", description)); e != nil {
			return e
		}
	}
	return nil
}
func appendUnique(items []string, s string) []string {
	for _, v := range items {
		if v == s {
			return items
		}
	}
	return append(items, s)
}
func displayName(m Monster) string {
	if m.Form != "" && m.Form != "default" && m.Form != "Original" {
		return m.Name + "（" + m.Form + "）"
	}
	return m.Name
}

var romanSuffix = regexp.MustCompile(`(?i)[\s_-]*([ivx]+)$`)

func normalizeName(s string) string {
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
	s = strings.TrimFunc(b.String(), unicode.IsSpace)
	return romanSuffix.ReplaceAllStringFunc(s, func(v string) string {
		return strings.ToUpper(strings.TrimLeftFunc(v, func(r rune) bool { return r == '-' || r == '_' || unicode.IsSpace(r) }))
	})
}

func equalJSON(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var x, y any
	dx := json.NewDecoder(bytes.NewReader(a))
	dx.UseNumber()
	dy := json.NewDecoder(bytes.NewReader(b))
	dy.UseNumber()
	return dx.Decode(&x) == nil && dy.Decode(&y) == nil && equalJSONValues(x, y)
}

// Compare number values rather than their lexical spellings (1, 1.0, 1e0).
// Exact rationals avoid rounding unknown large local numbers through float64.
func equalJSONValues(a, b any) bool {
	switch x := a.(type) {
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		if x == y {
			return true
		}
		// A huge opaque number is retained as a difference instead of allocating an
		// unbounded rational merely to compare compatibility metadata.
		for _, number := range []json.Number{x, y} {
			text := string(number)
			if len(text) > 4096 {
				return false
			}
			if at := strings.IndexAny(text, "eE"); at >= 0 {
				exponent, err := strconv.Atoi(text[at+1:])
				if err != nil || exponent < -4096 || exponent > 4096 {
					return false
				}
			}
		}
		xr, xok := new(big.Rat).SetString(string(x))
		yr, yok := new(big.Rat).SetString(string(y))
		return xok && yok && xr.Cmp(yr) == 0
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for key, value := range x {
			other, exists := y[key]
			if !exists || !equalJSONValues(value, other) {
				return false
			}
		}
		return true
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i, value := range x {
			if !equalJSONValues(value, y[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}
func difference(original, base object, ignore map[string]bool) (object, []string) {
	patch := object{}
	omits := []string{}
	for k, v := range original {
		if ignore[k] {
			continue
		}
		prior, ok := base[k]
		if ok && equalJSON(v, prior) {
			continue
		}
		var a, b object
		if ok && len(v) > 0 && v[0] == '{' && len(prior) > 0 && prior[0] == '{' && json.Unmarshal(v, &a) == nil && json.Unmarshal(prior, &b) == nil {
			nested, missing := difference(a, b, nil)
			if len(nested) > 0 {
				patch[k] = rawJSON(nested)
			}
			for _, path := range missing {
				omits = append(omits, escapePath(k)+"/"+path)
			}
		} else {
			patch[k] = v
		}
	}
	for k := range base {
		if ignore[k] {
			continue
		}
		if _, ok := original[k]; !ok {
			omits = append(omits, escapePath(k))
		}
	}
	sort.Strings(omits)
	return patch, omits
}
func escapePath(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
func unescapePath(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
}
func savePatch(ext *Extensions, original, base object, ignore map[string]bool) {
	patch, omits := difference(original, base, ignore)
	if len(patch) > 0 {
		setExtension(ext, "legacy", rawJSON(patch))
	}
	if len(omits) > 0 {
		setExtension(ext, "legacy_omit", rawJSON(omits))
	}
}
func setExtension(ext *Extensions, key string, v json.RawMessage) {
	if *ext == nil {
		*ext = Extensions{}
	}
	(*ext)[key] = v
}
func mergePatch(base, patch object) {
	for k, v := range patch {
		var a, b object
		if len(v) > 0 && v[0] == '{' && len(base[k]) > 0 && base[k][0] == '{' && json.Unmarshal(base[k], &a) == nil && json.Unmarshal(v, &b) == nil {
			mergePatch(a, b)
			base[k] = rawJSON(a)
		} else {
			base[k] = v
		}
	}
}
func deletePath(r object, path []string) {
	if len(path) == 0 {
		return
	}
	key := unescapePath(path[0])
	if len(path) == 1 {
		delete(r, key)
		return
	}
	var next object
	if json.Unmarshal(r[key], &next) == nil && next != nil {
		deletePath(next, path[1:])
		r[key] = rawJSON(next)
	}
}
func applyExtensions(r object, ext Extensions) error {
	if b := ext["legacy"]; len(b) > 0 {
		var patch object
		if e := json.Unmarshal(b, &patch); e != nil {
			return e
		}
		mergePatch(r, patch)
	}
	if b := ext["legacy_omit"]; len(b) > 0 {
		var paths []string
		if e := json.Unmarshal(b, &paths); e != nil {
			return e
		}
		for _, path := range paths {
			deletePath(r, strings.Split(path, "/"))
		}
	}
	return nil
}
func mergeWiki(a, b object) (object, error) {
	out := cloneObject(a)
	for k, v := range b {
		if k == "skills" || k == "aliases" || k == "monster_id" {
			continue
		}
		if prior, ok := out[k]; ok && !equalJSON(prior, v) {
			return nil, fmt.Errorf("conflicting alias field %q", k)
		}
		out[k] = v
	}
	var first, second []object
	if e := fields(a, req("skills", &first)); e != nil {
		return nil, e
	}
	if e := fields(b, req("skills", &second)); e != nil {
		return nil, e
	}
	keyFor := func(row object) (string, error) {
		var name, source string
		if e := fields(row, req("name", &name), opt("source", &source)); e != nil {
			return "", e
		}
		if source == "" {
			source = "默认"
		}
		return name + "\x00" + source, nil
	}
	seen := map[string]object{}
	for _, row := range first {
		k, e := keyFor(row)
		if e != nil {
			return nil, e
		}
		seen[k] = row
	}
	for _, row := range second {
		k, e := keyFor(row)
		if e != nil {
			return nil, e
		}
		if prior, ok := seen[k]; ok {
			for field, value := range row {
				if field == "source" {
					continue
				}
				if prev, exists := prior[field]; exists && !equalJSON(prev, value) {
					return nil, fmt.Errorf("conflicting alias skill %q field %q", k, field)
				}
				prior[field] = value
			}
		} else {
			first = append(first, row)
			seen[k] = row
		}
	}
	out["skills"] = rawJSON(first)
	return out, nil
}
