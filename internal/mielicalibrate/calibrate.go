package mielicalibrate

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"xhmwiki/internal/catalog"
)

type Mapping struct {
	LocalID  int    `json:"local_id"`
	ClientID int    `json:"client_id"`
	Method   string `json:"method"`
}
type Change struct {
	Entity string `json:"entity"`
	ID     int    `json:"id"`
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}
type Note struct {
	Entity string `json:"entity"`
	ID     int    `json:"id"`
	Code   string `json:"code"`
	Detail string `json:"detail"`
}
type Report struct {
	Version      int               `json:"version"`
	Repository   string            `json:"repository"`
	Revision     string            `json:"revision"`
	AsOf         string            `json:"as_of"`
	SourceHashes map[string]string `json:"source_hashes"`
	Mapping      []Mapping         `json:"mapping"`
	Counts       map[string]int    `json:"counts"`
	Changes      []Change          `json:"changes"`
	Notes        []Note            `json:"notes"`
}

func (r *Report) change(entity string, id int, field string, before, after any) {
	if reflect.DeepEqual(before, after) {
		return
	}
	r.Changes = append(r.Changes, Change{entity, id, field, before, after})
	r.Counts[entity+"_"+field+"_changed"]++
}
func (r *Report) note(entity string, id int, code, detail string) {
	r.Notes = append(r.Notes, Note{entity, id, code, detail})
}
func Calibrate(input *catalog.Catalog, t *Tables, asOf time.Time) (*catalog.Catalog, *Report, error) {
	b, err := catalog.Marshal(input)
	if err != nil {
		return nil, nil, err
	}
	c, err := catalog.Parse(b)
	if err != nil {
		return nil, nil, err
	}
	r := &Report{Version: 1, Repository: Repository, Revision: Revision, AsOf: asOf.Format(time.RFC3339), SourceHashes: t.Hashes, Counts: map[string]int{}, Mapping: []Mapping{}, Changes: []Change{}, Notes: []Note{}}
	fail := func(err error) (*catalog.Catalog, *Report, error) { return nil, r, err }
	pets := map[int]Pet{}
	skills := map[int]Skill{}
	levels := map[int]Level{}
	chains := map[int]Evolution{}
	book := map[int]map[int]bool{}
	for _, p := range t.Pets {
		if p.ID <= 0 || pets[p.ID].ID != 0 {
			return fail(fmt.Errorf("duplicate/invalid pet ID %d", p.ID))
		}
		pets[p.ID] = p
	}
	for _, s := range t.Skills {
		if s.ID <= 0 || skills[s.ID].ID != 0 {
			return fail(fmt.Errorf("duplicate/invalid skill ID %d", s.ID))
		}
		skills[s.ID] = s
	}
	for _, l := range t.Levels {
		if l.ID <= 0 || levels[l.ID].ID != 0 {
			return fail(fmt.Errorf("duplicate/invalid learning ID %d", l.ID))
		}
		levels[l.ID] = l
	}
	for _, e := range t.Evolutions {
		if e.ID <= 0 || chains[e.ID].ID != 0 {
			return fail(fmt.Errorf("duplicate/invalid chain ID %d", e.ID))
		}
		chains[e.ID] = e
	}
	for _, h := range t.Handbooks {
		if h.ID <= 0 || book[h.ID] != nil {
			return fail(fmt.Errorf("duplicate/invalid handbook ID %d", h.ID))
		}
		book[h.ID] = map[int]bool{}
		for _, g := range h.Groups {
			for _, id := range g.Pets {
				book[h.ID][id] = true
			}
		}
	}
	eligible := func(p Pet) bool {
		if !book[p.Handbook][p.ID] || p.Stage < 1 || p.Stage > 4 {
			return false
		}
		if p.Available != "" {
			d, e := time.ParseInLocation("2006-01-02 15:04:05", p.Available, asOf.Location())
			return e == nil && !d.After(asOf)
		}
		return p.Legal == 1 && p.Stage != 4
	}
	mapped := map[int]Pet{}
	reverse := map[int]int{}
	local := map[int]*catalog.Monster{}
	add := func(m *catalog.Monster, p Pet, method string) error {
		if prior := reverse[p.ID]; prior != 0 {
			return fmt.Errorf("client %d maps to both %d and %d", p.ID, prior, m.ID)
		}
		mapped[m.ID] = p
		reverse[p.ID] = m.ID
		r.Mapping = append(r.Mapping, Mapping{m.ID, p.ID, method})
		return nil
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		local[m.ID] = m
		if m.Placeholder {
			r.note("monster", m.ID, "protected_placeholder", "用户授权占位保持不变")
			continue
		}
		if m.IsLeaderForm {
			continue
		}
		var matches []Pet
		for _, p := range t.Pets {
			if eligible(p) && p.Stage != 4 && normalize(p.Name) == normalize(m.Name) && normalForm(p.Form) == normalForm(m.Form) && p.Handbook == m.DexNumber {
				matches = append(matches, p)
			}
		}
		if len(matches) != 1 {
			return fail(fmt.Errorf("monster %d %s/%s: expected one exact client identity, found %d", m.ID, m.Name, m.Form, len(matches)))
		}
		if e := add(m, matches[0], "name_form_handbook"); e != nil {
			return fail(e)
		}
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		if m.Placeholder || !m.IsLeaderForm {
			continue
		}
		base, ok := mapped[m.LeaderOfID]
		if !ok {
			return fail(fmt.Errorf("leader %d has no mapped base", m.ID))
		}
		var matches []Pet
		for _, id := range base.Bosses {
			p := pets[id]
			if eligible(p) && p.Stage == 4 && normalize(p.Name) == normalize(m.Name) && p.Handbook == m.DexNumber {
				matches = append(matches, p)
			}
		}
		if len(matches) != 1 {
			return fail(fmt.Errorf("leader %d: expected one explicit stage4 target, found %d", m.ID, len(matches)))
		}
		if e := add(m, matches[0], "explicit_boss_target_of_mapped_base"); e != nil {
			return fail(e)
		}
	}
	sort.Slice(r.Mapping, func(i, j int) bool { return r.Mapping[i].LocalID < r.Mapping[j].LocalID })
	r.Counts["monsters_checked"] = len(mapped)
	for _, p := range t.Pets {
		if eligible(p) && reverse[p.ID] == 0 {
			r.note("client_pet", p.ID, "not_added_without_release_identity_review", p.Name+" / "+p.Form+"：配置存在但没有现有本地/腾讯身份，本次不据此猜测新增")
		}
	}
	// Only skills reachable through explicitly mapped pets are eligible. This excludes
	// test/NPC skills with identical names (e.g. the second 疾风涡轮 definition).
	referenced := map[int]bool{}
	addRef := func(id int) error {
		if id <= 0 {
			return nil
		}
		if skills[id].ID == 0 {
			return fmt.Errorf("missing referenced skill %d", id)
		}
		referenced[id] = true
		return nil
	}
	for _, p := range mapped {
		l, ok := levels[p.LevelSkills]
		if !ok {
			return fail(fmt.Errorf("pet %d missing learning table %d", p.ID, p.LevelSkills))
		}
		ids := learningIDs(l)
		if l.ExtraGroup != 0 {
			found := false
			for _, e := range t.Extras {
				if e.Group == l.ExtraGroup {
					found = true
					ids = append(ids, e.Skill)
				}
			}
			if !found {
				return fail(fmt.Errorf("missing extra skill group %d", l.ExtraGroup))
			}
		}
		for _, id := range ids {
			if e := addRef(id); e != nil {
				return fail(e)
			}
		}
	}
	skillLocal := map[int]int{}
	localSkill := map[int]*catalog.Skill{}
	rules := map[int]bool{}
	for _, v := range c.SkillRules {
		rules[v.SkillID] = true
	}
	for i := range c.Skills {
		s := &c.Skills[i]
		localSkill[s.ID] = s
		var candidates []Skill
		for id := range referenced {
			v := skills[id]
			if normalize(v.Name) == normalize(s.Name) {
				candidates = append(candidates, v)
			}
		}
		if len(candidates) == 0 {
			return fail(fmt.Errorf("local skill %d %s has no mapped client reference", s.ID, s.Name))
		}
		sort.Slice(candidates, func(i, j int) bool { return candidates[i].ID < candidates[j].ID })
		v := candidates[0]
		text, e := plainText(v.Description)
		if e != nil {
			return fail(fmt.Errorf("skill %d: %w", v.ID, e))
		}
		cat := skillCategory(v)
		typ, ok := typeMap[v.Element]
		if !ok || cat == "" || len(v.Energy) == 0 || len(v.Power) == 0 {
			return fail(fmt.Errorf("skill %d has unsupported semantics", v.ID))
		}
		for _, candidate := range candidates {
			d, e := plainText(candidate.Description)
			if e != nil || semanticText(d) != semanticText(text) || skillCategory(candidate) != cat || candidate.Element != v.Element || !reflect.DeepEqual(candidate.Energy, v.Energy) || !reflect.DeepEqual(candidate.Power, v.Power) {
				return fail(fmt.Errorf("ambiguous active skill %s", s.Name))
			}
			skillLocal[candidate.ID] = s.ID
		}
		r.change("skill", s.ID, "type_id", s.TypeID, typ)
		s.TypeID = typ
		r.change("skill", s.ID, "category", s.Category, cat)
		s.Category = cat
		r.change("skill", s.ID, "energy_cost", s.EnergyCost, v.Energy[0])
		s.EnergyCost = v.Energy[0]
		if semanticText(s.Description) != semanticText(text) {
			r.change("skill", s.ID, "description", s.Description, text)
			s.Description = text
		}
		// nil power and registered dynamic mechanisms are deliberate local semantics.
		if s.Power != nil && *s.Power != v.Power[0] {
			if rules[s.ID] {
				r.note("skill", s.ID, "protected_dynamic_power", "保留已审核动态计算；客户端参数不覆盖公式")
			} else {
				r.change("skill", s.ID, "power", *s.Power, v.Power[0])
				value := v.Power[0]
				s.Power = &value
			}
		}
	}
	r.Counts["skills_checked"] = len(c.Skills)
	for id := range referenced {
		if skillLocal[id] == 0 {
			return fail(fmt.Errorf("client learning skill %d %s is unmapped", id, skills[id].Name))
		}
	}
	traitByID := map[string]catalog.Trait{}
	for _, tr := range c.Traits {
		traitByID[tr.ID] = tr
	}
	traitByDef := map[string]string{}
	for _, tr := range c.Traits {
		traitByDef[tr.Name+"\x00"+tr.Description] = tr.ID
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		p, ok := mapped[m.ID]
		if !ok {
			continue
		}
		stats := catalog.Stats{HP: p.HP, PhyAtk: p.Attack, PhyDef: p.Defense, MagAtk: p.Magic, MagDef: p.Resistance, Speed: p.Speed, Extensions: m.Stats.Extensions}
		r.change("monster", m.ID, "stats", m.Stats, stats)
		m.Stats = stats
		types := []int{}
		for _, id := range p.Types {
			v, ok := typeMap[id]
			if !ok {
				return fail(fmt.Errorf("pet %d has unknown element %d", p.ID, id))
			}
			types = append(types, v)
		}
		r.change("monster", m.ID, "type_ids", m.TypeIDs, types)
		m.TypeIDs = types
		feat, ok := skills[p.Feature]
		if !ok {
			return fail(fmt.Errorf("pet %d missing trait %d", p.ID, p.Feature))
		}
		desc, e := plainText(feat.Description)
		if e != nil {
			return fail(fmt.Errorf("trait %d: %w", feat.ID, e))
		}
		prior := traitByID[m.TraitID]
		if prior.Name != feat.Name || semanticText(prior.Description) != semanticText(desc) {
			def := feat.Name + "\x00" + desc
			id := traitByDef[def]
			if id == "" {
				id = fmt.Sprintf("trait-%x", sha256.Sum256([]byte(def)))[:38]
				tr := catalog.Trait{ID: id, Name: feat.Name, Description: desc}
				c.Traits = append(c.Traits, tr)
				traitByDef[def] = id
				traitByID[id] = tr
			}
			r.change("monster", m.ID, "trait_id", m.TraitID, id)
			m.TraitID = id
		}
		stage := "基础形态"
		if p.Strength == 3 {
			stage = "高级形态"
		}
		if p.Stage == 4 {
			stage = "首领形态"
		}
		if p.Strength < 1 || p.Strength > 3 {
			return fail(fmt.Errorf("pet %d invalid strength stage", p.ID))
		}
		r.change("monster", m.ID, "evolution_stage", m.EvolutionStage, stage)
		m.EvolutionStage = stage
		members := []int{}
		for _, chainID := range p.Chains {
			chain, ok := chains[chainID]
			if !ok {
				return fail(fmt.Errorf("pet %d missing chain %d", p.ID, chainID))
			}
			for _, entry := range chain.Chain {
				id := reverse[entry.Pet]
				if id == 0 {
					return fail(fmt.Errorf("chain %d has unmapped member %d", chainID, entry.Pet))
				}
				members = appendUnique(members, id)
			}
		}
		if len(members) == 0 {
			return fail(fmt.Errorf("pet %d has no explicit evolution membership", p.ID))
		}
		predecessor := 0
		if p.Stage != 4 {
			if !contains(members, m.ID) {
				return fail(fmt.Errorf("pet %d chain omits itself", p.ID))
			}
			if p.Previous != 0 {
				predecessor = reverse[p.Previous]
				parent := pets[p.Previous]
				if predecessor == 0 || !contains(parent.Next, p.ID) || !contains(members, predecessor) {
					return fail(fmt.Errorf("pet %d has contradictory ordinary predecessor", p.ID))
				}
			}
			for _, other := range mapped {
				if contains(other.Next, p.ID) && other.ID != p.Previous {
					return fail(fmt.Errorf("pet %d ambiguous predecessor", p.ID))
				}
			}
			if m.LeaderOfID != 0 {
				return fail(fmt.Errorf("ordinary pet %d has leader relation", m.ID))
			}
		} else {
			base := mapped[m.LeaderOfID]
			if !contains(base.Bosses, p.ID) {
				return fail(fmt.Errorf("leader %d lost explicit base", m.ID))
			}
		}
		r.change("monster", m.ID, "evolution_members", m.EvolutionMembers, members)
		m.EvolutionMembers = members
		r.change("monster", m.ID, "evolves_from_id", m.EvolvesFromID, predecessor)
		m.EvolvesFromID = predecessor
		r.Counts["traits_checked"]++
		if p.Stage == 4 {
			r.Counts["leader_links_checked"]++
		} else if predecessor != 0 {
			r.Counts["ordinary_links_checked"]++
		}
	}
	if e := calibrateLearning(c, levels, t.Extras, mapped, skillLocal, r); e != nil {
		return fail(e)
	}
	// Evidence is auxiliary to the one canonical catalog. No client table, binary
	// assets, unsupported game fields, or second mutable database is distributed.
	metadata := map[string]any{"version": 1, "repository": Repository, "revision": Revision, "as_of": r.AsOf, "source_hashes": r.SourceHashes, "mapping": r.Mapping, "counts": r.Counts, "notes": r.Notes}
	mb, _ := json.Marshal(metadata)
	if c.Extensions == nil {
		c.Extensions = catalog.Extensions{}
	}
	c.Extensions["mieli_calibration"] = mb
	if err := catalog.Validate(c); err != nil {
		return fail(err)
	}
	return c, r, nil
}
func learningIDs(l Level) []int {
	ids := []int{}
	for _, v := range l.Level {
		ids = append(ids, v.Skill)
	}
	for _, v := range l.Machines {
		ids = append(ids, v.ID)
	}
	for _, key := range BloodFields {
		ids = append(ids, l.Blood[key])
	}
	if l.Legend != 0 {
		ids = append(ids, l.Legend)
	}
	return ids
}
func learnKey(v catalog.LearnedSkill) string { return fmt.Sprintf("%d:%s", v.SkillID, v.Source) }
func sameLearning(a, b []catalog.LearnedSkill) bool {
	ma := map[string]bool{}
	mb := map[string]bool{}
	for _, v := range a {
		ma[learnKey(v)] = true
	}
	for _, v := range b {
		mb[learnKey(v)] = true
	}
	return reflect.DeepEqual(ma, mb)
}
func effectiveLearning(sets map[int]*catalog.Learnset, id int, seen map[int]bool) ([]catalog.LearnedSkill, error) {
	s := sets[id]
	if s == nil || seen[id] {
		return nil, fmt.Errorf("invalid learning inheritance at %d", id)
	}
	if s.Mode == "own" {
		return s.Skills, nil
	}
	seen[id] = true
	return effectiveLearning(sets, s.FromID, seen)
}
func calibrateLearning(c *catalog.Catalog, levels map[int]Level, extras []Extra, mapped map[int]Pet, skillLocal map[int]int, r *Report) error {
	sets := map[int]*catalog.Learnset{}
	for i := range c.Learnsets {
		sets[c.Learnsets[i].MonsterID] = &c.Learnsets[i]
	}
	before := map[int][]catalog.LearnedSkill{}
	desired := map[int][]catalog.LearnedSkill{}
	for _, m := range c.Monsters {
		v, e := effectiveLearning(sets, m.ID, map[int]bool{})
		if e != nil {
			return e
		}
		before[m.ID] = v
		desired[m.ID] = v
	}
	for _, m := range c.Monsters {
		p, ok := mapped[m.ID]
		if !ok {
			continue
		}
		l := levels[p.LevelSkills]
		rows := []catalog.LearnedSkill{}
		seen := map[string]bool{}
		prior := map[string]catalog.LearnedSkill{}
		for _, v := range before[m.ID] {
			prior[learnKey(v)] = v
		}
		add := func(id int, source string) error {
			if id <= 0 {
				return nil
			}
			local := skillLocal[id]
			if local == 0 {
				return fmt.Errorf("unmapped learning skill %d for monster %d", id, m.ID)
			}
			row := catalog.LearnedSkill{SkillID: local, Source: source}
			key := learnKey(row)
			if seen[key] {
				return nil
			}
			seen[key] = true
			if v, ok := prior[key]; ok {
				row = v
			}
			rows = append(rows, row)
			return nil
		}
		for _, v := range l.Level {
			if e := add(v.Skill, "默认"); e != nil {
				return e
			}
		}
		for _, key := range BloodFields {
			if e := add(l.Blood[key], "血脉"); e != nil {
				return e
			}
		}
		for _, v := range l.Machines {
			if e := add(v.ID, "技能石"); e != nil {
				return e
			}
		}
		if l.ExtraGroup != 0 {
			for _, v := range extras {
				if v.Group == l.ExtraGroup {
					if e := add(v.Skill, "技能石"); e != nil {
						return e
					}
				}
			}
		}
		if l.Legend != 0 {
			key := fmt.Sprintf("%d:传说", skillLocal[l.Legend])
			if l.LegendCondition == 0 || l.LegendCondition == p.ID || prior[key].SkillID != 0 {
				if e := add(l.Legend, "传说"); e != nil {
					return e
				}
			} else {
				r.note("monster", m.ID, "conditional_legend_preserved", "客户端传说技能含未确认条件，不推断新增可学习关系")
			}
		}
		if len(rows) == 0 {
			return fmt.Errorf("client learning for monster %d is empty", m.ID)
		}
		// A source may list the same legendary skill in its level group. Preserve the
		// existing user's classification rather than creating a second default row.
		legend := map[int]bool{}
		for _, v := range rows {
			if v.Source == "传说" {
				legend[v.SkillID] = true
			}
		}
		filtered := rows[:0]
		for _, v := range rows {
			if v.Source == "默认" && legend[v.SkillID] {
				continue
			}
			filtered = append(filtered, v)
		}
		rows = filtered
		desired[m.ID] = rows
		r.Counts["learnsets_checked"]++
	}
	// Compute all targets first. An inherited child must match the calibrated
	// target parent, not yesterday's effective parent or its stale stored rows.
	for _, m := range c.Monsters {
		s := sets[m.ID]
		target := desired[m.ID]
		if _, ok := mapped[m.ID]; !ok {
			continue
		}
		old := *s
		newSet := *s
		if s.Mode == "inherit" && sameLearning(target, desired[s.FromID]) { /* keep explicit inheritance and stored compatibility snapshot */
		} else {
			newSet.Mode = "own"
			newSet.FromID = 0
			if sameLearning(target, before[m.ID]) && s.Mode == "own" {
				newSet.Skills = s.Skills
			} else {
				newSet.Skills = target
			}
		}
		if !sameLearning(before[m.ID], target) {
			r.change("learnset", m.ID, "effective_skills", before[m.ID], target)
		}
		if old.Mode != newSet.Mode || old.FromID != newSet.FromID {
			r.change("learnset", m.ID, "inheritance", map[string]any{"mode": old.Mode, "from_id": old.FromID}, map[string]any{"mode": newSet.Mode, "from_id": newSet.FromID})
		}
		*s = newSet
	}
	// Verify committed effective sets, including transitively inherited parents.
	for id := range mapped {
		actual, e := effectiveLearning(sets, id, map[int]bool{})
		if e != nil {
			return e
		}
		if !sameLearning(actual, desired[id]) {
			return fmt.Errorf("calibrated inheritance mismatch for %d", id)
		}
	}
	return nil
}

// Summary gives a concise development result, not a claim about live release status.
func (r *Report) Summary() string {
	keys := []string{}
	for k := range r.Counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, r.Counts[k]))
	}
	return strings.Join(parts, ", ")
}
