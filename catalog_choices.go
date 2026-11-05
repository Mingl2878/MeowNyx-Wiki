package main

// Choices are server-owned patches over a pinned canonical snapshot, never JSON
// paths supplied by a client. The root extension is committed with the data.
import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
	"xhmwiki/internal/sourcebaseline"
)

const catalogChoicesExtension = "catalog_choices"

type catalogChoice struct {
	Key             string `json:"key"`
	Choice          string `json:"choice"`
	AcknowledgeOnly bool   `json:"acknowledge_only,omitempty"`
}
type catalogRememberedChoice struct {
	Key    string `json:"key"`
	Entity string `json:"entity"`
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Field  string `json:"field"`
	Choice string `json:"choice"`
	// For a not-yet-created entity, ID is reserved only within a preview. Bind
	// its policy to the verified semantic identity too, never to source numeric ID.
	Identity string `json:"identity,omitempty"`
}
type catalogChoiceMemory struct {
	Version int                                `json:"version"`
	Entries map[string]catalogRememberedChoice `json:"entries"`
}
type catalogCandidate struct {
	Key             string          `json:"key"`
	Entity          string          `json:"entity"`
	ID              int             `json:"id"`
	Name            string          `json:"name"`
	Field           string          `json:"field"`
	Kind            string          `json:"kind"`
	LocalValue      any             `json:"local_value"`
	SourceValue     any             `json:"source_value"`
	LocalAvailable  bool            `json:"local_available"`
	SourceAvailable bool            `json:"source_available"`
	SourceRevision  json.RawMessage `json:"source_revision,omitempty"`
	Identity        string          `json:"-"`
	apply           func(*catalog.Catalog) error
	images          []officialdex.ImageCandidate
}
type catalogChoicePlan struct {
	before            []byte
	candidates        []catalogCandidate
	memory            catalogChoiceMemory
	baseline          *sourcebaseline.Baseline
	observations      map[string]sourcebaseline.Observation
	sourceHash        string
	issueFingerprints map[string]string
	issues            []officialdex.Issue
	localCatalog      *catalog.Catalog
	sourceCatalog     *catalog.Catalog
}

func readCatalogChoiceMemory(c *catalog.Catalog) (catalogChoiceMemory, error) {
	out := catalogChoiceMemory{Version: 1, Entries: map[string]catalogRememberedChoice{}}
	raw := c.Extensions[catalogChoicesExtension]
	if len(raw) == 0 {
		return out, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return out, fmt.Errorf("选择记忆无效: %w", err)
	}
	if out.Version != 1 || out.Entries == nil {
		return out, errors.New("不支持的选择记忆版本")
	}
	for key, value := range out.Entries {
		if value.Key != key || key == "" || (value.ID <= 0 && !(value.Entity == "catalog" && value.ID == 0 && value.Field == "image_policy")) || !catalogChoiceFieldKnown(value.Entity, value.Field) || (value.Choice != "local" && value.Choice != "source") || key != catalogMemoryKey(value.Entity, value.ID, value.Field, value.Choice, value.Identity) {
			return out, errors.New("选择记忆条目无效")
		}
	}
	return out, nil
}
func writeCatalogChoiceMemory(c *catalog.Catalog, memory catalogChoiceMemory) error {
	b, err := json.Marshal(memory)
	if err != nil {
		return err
	}
	if c.Extensions == nil {
		c.Extensions = catalog.Extensions{}
	}
	c.Extensions[catalogChoicesExtension] = b
	return nil
}
func rememberedCatalogChoices(memory catalogChoiceMemory) []catalogRememberedChoice {
	result := make([]catalogRememberedChoice, 0, len(memory.Entries))
	for _, item := range memory.Entries {
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}
func catalogCandidateKey(entity string, id int, field string) string {
	return entity + ":" + strconv.Itoa(id) + ":" + field
}
func catalogNewEntityKey(entity, identity string) string {
	return fmt.Sprintf("%s:new:%x:entity", entity, sha256.Sum256([]byte(identity)))
}
func catalogMemoryKey(entity string, id int, field, choice, identity string) string {
	if field == "entity" && choice == "local" && identity != "" {
		return catalogNewEntityKey(entity, identity)
	}
	return catalogCandidateKey(entity, id, field)
}
func choiceJSON(value any) map[string]json.RawMessage {
	b, _ := json.Marshal(value)
	var result map[string]json.RawMessage
	_ = json.Unmarshal(b, &result)
	return result
}
func choiceFields(value any, fields []string) map[string]json.RawMessage {
	raw := choiceJSON(value)
	result := map[string]json.RawMessage{}
	for _, field := range fields {
		if v, ok := raw[field]; ok {
			result[field] = v
		}
	}
	return result
}
func patchChoiceFields(target any, values map[string]json.RawMessage, fields []string) error {
	raw := choiceJSON(target)
	for _, field := range fields {
		if value, ok := values[field]; ok {
			raw[field] = value
		} else {
			delete(raw, field)
		}
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	// Unmarshal into a fresh value: omitted optional fields mean a deliberate
	// clear, not "retain the destination's old value".
	fresh := reflect.New(reflect.TypeOf(target).Elem())
	if err := json.Unmarshal(b, fresh.Interface()); err != nil {
		return err
	}
	reflect.ValueOf(target).Elem().Set(fresh.Elem())
	return nil
}
func choiceEqual(a, b any) bool {
	// Compare decoded canonical values (including numeric null), not raw JSON formatting.
	aa, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	var av, bv any
	_ = json.Unmarshal(aa, &av)
	_ = json.Unmarshal(bb, &bv)
	return reflect.DeepEqual(av, bv)
}
func choiceMonster(c *catalog.Catalog, id int) *catalog.Monster {
	for i := range c.Monsters {
		if c.Monsters[i].ID == id {
			return &c.Monsters[i]
		}
	}
	return nil
}
func choiceSkill(c *catalog.Catalog, id int) *catalog.Skill {
	for i := range c.Skills {
		if c.Skills[i].ID == id {
			return &c.Skills[i]
		}
	}
	return nil
}
func choiceLearnset(c *catalog.Catalog, id int) *catalog.Learnset {
	for i := range c.Learnsets {
		if c.Learnsets[i].MonsterID == id {
			return &c.Learnsets[i]
		}
	}
	return nil
}
func choiceTrait(c *catalog.Catalog, id string) *catalog.Trait {
	for i := range c.Traits {
		if c.Traits[i].ID == id {
			return &c.Traits[i]
		}
	}
	return nil
}
func choiceIdentity(m catalog.Monster) string {
	return m.Name + "|" + m.Form + "|" + strconv.Itoa(m.DexNumber)
}

var monsterIdentityFields = []string{"name", "dex_number", "form", "form_category", "main_form_id", "aliases", "source_ref"}
var monsterEvolutionFields = []string{"evolution_members", "evolves_from_id"}
var monsterLeaderFields = []string{"leader_of_id", "is_leader_form"}
var learningChoiceFields = []string{"mode", "from_id", "skills", "source_ref"}

// Only explicit missing/unusable-field issues can manufacture an unavailable
// row. Ordinary identical values do not create a difference.
func unavailableChoiceField(issue officialdex.Issue) string {
	switch issue.Code {
	case "invalid_field", "unknown_stage", "stage_source_incomplete", "unknown_type":
		return map[string]string{"hp": "stats.hp", "atk": "stats.phy_atk", "matk": "stats.mag_atk", "df": "stats.phy_def", "mdf": "stats.mag_def", "spd": "stats.speed", "s": "evolution_stage", "e": "type_ids", "e2": "type_ids", "main_type": "type_ids", "sub_type": "type_ids", "tn": "trait", "te": "trait"}[issue.Field]
	case "evolution_source_incomplete", "unresolved_source_relationship", "invalid_relationships", "source_relationship_unavailable", "source_relationship_cycle":
		if issue.Field == "evo" || issue.Field == "evolves_from_id" || issue.Field == "evolution_members" {
			return "evolution"
		}
		if issue.Field == "forms" || issue.Field == "leader_of_id" {
			return "leader_form"
		}
	case "incomplete_learnset", "learnset_contains_unresolved_move", "empty_official_learnset", "unknown_learnset_source":
		return "learning"
	case "local_only_monster", "identity_crosscheck_failed", "reviewed_identity_crosscheck_failed", "ambiguous_new_form":
		return "identity"
	case "local_only_move":
		return "identity"
	}
	return ""
}

func buildCatalogChoicePlan(before []byte, proposal *officialdex.Proposal) (*catalogChoicePlan, error) {
	local, err := catalog.Parse(before)
	if err != nil {
		return nil, err
	}
	source, err := catalog.ImportLegacy(catalog.LegacyFiles{Monsters: proposal.Files.Monsters, Moves: proposal.Files.Moves, Types: proposal.Files.Types, Wiki: proposal.Files.Wiki})
	if err != nil {
		return nil, err
	}
	memory, err := readCatalogChoiceMemory(local)
	if err != nil {
		return nil, err
	}
	p := &catalogChoicePlan{before: bytes.Clone(before), memory: memory, candidates: []catalogCandidate{}, localCatalog: local, sourceCatalog: source}
	if err := p.initBaseline(local, proposal); err != nil {
		return nil, err
	}
	unavailable := map[string]bool{}
	for _, issue := range proposal.Issues {
		if issue.ID <= 0 {
			continue
		}
		entity := issue.Entity
		if entity == "move" {
			entity = "skill"
		}
		if entity == "wiki" {
			entity = "monster"
		}
		if field := unavailableChoiceField(issue); field != "" {
			unavailable[catalogCandidateKey(entity, issue.ID, field)] = true
		}
	}
	add := func(entity string, id int, name, field, kind string, a, b any, apply func(*catalog.Catalog) error) {
		key := catalogCandidateKey(entity, id, field)
		available := !unavailable[key]
		if choiceEqual(a, b) && available {
			if !p.sourceChanged(entity, id, field) {
				return
			}
			// A real source revision can be hidden by Build's conservative merge
			// (protected power, local leader role, equivalent inheritance). Never
			// present the retained local value as if it were the new source value.
			if p.sourceAgrees(entity, id, field, b) {
				kind = "source_revision"
			} else {
				available, kind = false, "source_review"
			}
		}
		if !available {
			b = nil
		}
		p.candidates = append(p.candidates, catalogCandidate{Key: key, Entity: entity, ID: id, Name: name, Field: field, Kind: kind, LocalValue: a, SourceValue: b, LocalAvailable: true, SourceAvailable: available, apply: apply})
	}
	for _, next := range source.Monsters {
		next := next
		id := next.ID
		old := choiceMonster(local, id)
		if old == nil {
			learning := choiceLearnset(source, id)
			trait := choiceTrait(source, next.TraitID)
			if learning == nil || trait == nil {
				return nil, errors.New("新增精灵缺少完整候选")
			}
			bundle := map[string]any{"monster": next, "learning": learning, "trait": trait}
			add("monster", id, next.Name, "entity", "add", nil, bundle, func(c *catalog.Catalog) error {
				if choiceMonster(c, id) != nil {
					return errors.New("新增精灵ID已占用")
				}
				c.Monsters = append(c.Monsters, next)
				c.Learnsets = append(c.Learnsets, *learning)
				if choiceTrait(c, trait.ID) == nil {
					c.Traits = append(c.Traits, *trait)
				}
				return nil
			})
			p.candidates[len(p.candidates)-1].Identity = choiceIdentity(next)
			p.candidates[len(p.candidates)-1].Key = catalogNewEntityKey("monster", choiceIdentity(next))
			continue
		}
		for _, group := range []struct {
			field string
			keys  []string
		}{{"identity", monsterIdentityFields}, {"evolution", monsterEvolutionFields}, {"leader_form", monsterLeaderFields}, {"evolution_stage", []string{"evolution_stage"}}, {"type_ids", []string{"type_ids"}}, {"data_note", []string{"data_note"}}} {
			group := group
			a, b := choiceFields(old, group.keys), choiceFields(next, group.keys)
			var av, bv any = a, b
			if len(group.keys) == 1 {
				av = a[group.keys[0]]
				bv = b[group.keys[0]]
			}
			add("monster", id, old.Name, group.field, "update", av, bv, func(c *catalog.Catalog) error { return patchChoiceFields(choiceMonster(c, id), b, group.keys) })
		}
		for _, stat := range []string{"hp", "phy_atk", "mag_atk", "phy_def", "mag_def", "speed"} {
			stat := stat
			a, b := choiceFields(old.Stats, []string{stat}), choiceFields(next.Stats, []string{stat})
			add("monster", id, old.Name, "stats."+stat, "update", a[stat], b[stat], func(c *catalog.Catalog) error {
				return patchChoiceFields(&choiceMonster(c, id).Stats, b, []string{stat})
			})
		}
		oldTrait, newTrait := choiceTrait(local, old.TraitID), choiceTrait(source, next.TraitID)
		// The local trait-note extraction travels with the trait, not with unrelated stats.
		oldNotes, newNotes := choiceTraitNotes(old), choiceTraitNotes(&next)
		av, bv := map[string]any{"trait": oldTrait, "notes": oldNotes}, map[string]any{"trait": newTrait, "notes": newNotes}
		add("monster", id, old.Name, "trait", "update", av, bv, func(c *catalog.Catalog) error {
			if newTrait == nil {
				return errors.New("无可用特性")
			}
			if choiceTrait(c, newTrait.ID) == nil {
				c.Traits = append(c.Traits, *newTrait)
			}
			target := choiceMonster(c, id)
			target.TraitID = newTrait.ID
			return setChoiceTraitNotes(target, newNotes)
		})
		a, b := choiceLearnset(local, id), choiceLearnset(source, id)
		if a == nil || b == nil {
			return nil, errors.New("精灵缺少学习面")
		}
		add("monster", id, old.Name, "learning", "update", choiceFields(a, learningChoiceFields), choiceFields(b, learningChoiceFields), func(c *catalog.Catalog) error {
			// Preserve unknown canonical metadata; replace only the chosen learning face
			// and its legacy row patches (indexes are meaningful only for this face).
			target := choiceLearnset(c, id)
			target.Mode = b.Mode
			target.FromID = b.FromID
			target.Skills = b.Skills
			target.SourceRef = b.SourceRef
			for _, key := range []string{"legacy_skills", "legacy_skill_omit"} {
				if target.Extensions == nil {
					target.Extensions = catalog.Extensions{}
				}
				if raw, ok := b.Extensions[key]; ok {
					target.Extensions[key] = raw
				} else {
					delete(target.Extensions, key)
				}
			}
			return nil
		})
	}
	for _, next := range source.Skills {
		next := next
		id := next.ID
		old := choiceSkill(local, id)
		if old == nil {
			add("skill", id, next.Name, "entity", "add", nil, next, func(c *catalog.Catalog) error {
				if choiceSkill(c, id) != nil {
					return errors.New("新增技能ID已占用")
				}
				c.Skills = append(c.Skills, next)
				for _, rule := range source.SkillRules {
					if rule.SkillID == id {
						c.SkillRules = append(c.SkillRules, rule)
					}
				}
				return nil
			})
			p.candidates[len(p.candidates)-1].Identity = next.Name
			p.candidates[len(p.candidates)-1].Key = catalogNewEntityKey("skill", next.Name)
			continue
		}
		groups := []struct {
			field string
			keys  []string
		}{{"identity", []string{"name", "source_ref"}}, {"description", []string{"description"}}, {"type_id", []string{"type_id"}}, {"category", []string{"category"}}, {"energy_cost", []string{"energy_cost"}}, {"power", []string{"power"}}, {"season", []string{"season"}}}
		for _, group := range groups {
			group := group
			a, b := choiceFields(old, group.keys), choiceFields(next, group.keys)
			var av, bv any = a, b
			if len(group.keys) == 1 {
				av = a[group.keys[0]]
				bv = b[group.keys[0]]
			}
			add("skill", id, old.Name, group.field, "update", av, bv, func(c *catalog.Catalog) error { return patchChoiceFields(choiceSkill(c, id), b, group.keys) })
		}
	}
	imageCandidates := []officialdex.ImageCandidate{}
	for _, image := range proposal.Images {
		if image.Purpose == "wiki" {
			imageCandidates = append(imageCandidates, image)
		}
	}
	if len(imageCandidates) > 0 {
		p.candidates = append(p.candidates, catalogCandidate{Key: "catalog:0:image_policy", Entity: "catalog", ID: 0, Name: "普通立绘更新策略", Field: "image_policy", Kind: "policy", LocalValue: "保留本地图片，不下载", SourceValue: "经安全校验后仅补缺或采用更大普通立绘；不降尺寸，不替换已有裁切头像", LocalAvailable: true, SourceAvailable: true, images: imageCandidates})
	}
	p.shieldAcknowledgedSource()
	sort.Slice(p.candidates, func(i, j int) bool { return p.candidates[i].Key < p.candidates[j].Key })
	return p, nil
}

func choiceTraitNotes(m *catalog.Monster) json.RawMessage {
	var legacy map[string]json.RawMessage
	_ = json.Unmarshal(m.Extensions["legacy"], &legacy)
	return legacy["_trait_notes"]
}
func setChoiceTraitNotes(m *catalog.Monster, note json.RawMessage) error {
	var legacy map[string]json.RawMessage
	if b := m.Extensions["legacy"]; len(b) > 0 {
		if err := json.Unmarshal(b, &legacy); err != nil {
			return err
		}
	}
	if legacy == nil {
		legacy = map[string]json.RawMessage{}
	}
	if note == nil {
		delete(legacy, "_trait_notes")
	} else {
		legacy["_trait_notes"] = note
	}
	if m.Extensions == nil {
		m.Extensions = catalog.Extensions{}
	}
	if len(legacy) == 0 {
		delete(m.Extensions, "legacy")
		return nil
	}
	b, err := json.Marshal(legacy)
	if err == nil {
		m.Extensions["legacy"] = b
	}
	return err
}
func (p *catalogChoicePlan) remembered(item catalogCandidate) (catalogRememberedChoice, bool) {
	memory, ok := p.memory.Entries[item.Key]
	if ok && (item.Identity == "" || memory.Identity == item.Identity) {
		return memory, true
	}
	if item.Identity != "" {
		// A declined new entity has no allocated local ID yet. If other new
		// records shift the proposal's provisional ID, match only the same
		// verified semantic identity, never the source's numeric identifier.
		for _, prior := range p.memory.Entries {
			if prior.Entity == item.Entity && prior.Field == "entity" && prior.Identity == item.Identity {
				return prior, true
			}
		}
	} else if item.Field != "entity" {
		// Choosing a complete new record as source also covers its future
		// constituent fields; an explicit per-field preference wins above.
		if prior, exists := p.memory.Entries[catalogCandidateKey(item.Entity, item.ID, "entity")]; exists && prior.Choice == "source" {
			return prior, true
		}
	}
	return memory, false
}
func (p *catalogChoicePlan) visibleIssues(issues []officialdex.Issue) []officialdex.Issue {
	result := []officialdex.Issue{}
	for _, issue := range issues {
		entity := issue.Entity
		if entity == "move" {
			entity = "skill"
		}
		if entity == "wiki" {
			entity = "monster"
		}
		field := unavailableChoiceField(issue)
		if field == "" {
			if entity == "skill" {
				field = map[string]string{"name": "identity", "localized.zh.name": "identity", "localized.zh.description": "description", "description": "description", "power": "power", "energy_cost": "energy_cost"}[issue.Field]
			}
			if entity == "monster" && issue.Field == "_trait_notes" {
				field = "trait"
			}
		}
		if p.issueAcknowledged(issue) {
			continue
		}
		remembered, ok := p.memory.Entries[catalogCandidateKey(entity, issue.ID, field)]
		if issue.Severity != "blocking" && field != "" && ok && remembered.Choice == "local" {
			continue
		}
		result = append(result, issue)
	}
	return result
}
func (p *catalogChoicePlan) pending() ([]catalogCandidate, int) {
	result := []catalogCandidate{}
	automatic := 0
	for _, item := range p.candidates {
		remembered, ok := p.remembered(item)
		if !ok {
			result = append(result, item)
		} else if remembered.Choice == "source" && item.SourceAvailable {
			automatic++
		} else if remembered.Choice == "source" && item.Kind == "source_review" {
			result = append(result, item)
		}
	}
	return result, automatic
}
func (p *catalogChoicePlan) resolve(choices []catalogChoice) (*catalog.Catalog, []officialdex.ImageCandidate, error) {
	if choices == nil {
		return nil, nil, errors.New("请求缺少choices；不会自动采用全部来源")
	}
	c, err := catalog.Parse(p.before)
	if err != nil {
		return nil, nil, err
	}
	memory, err := readCatalogChoiceMemory(c)
	if err != nil {
		return nil, nil, err
	}
	byKey := map[string]catalogCandidate{}
	for _, item := range p.candidates {
		byKey[item.Key] = item
	}
	selected := map[string]string{}
	for _, choice := range choices {
		item, ok := byKey[choice.Key]
		if !ok {
			return nil, nil, fmt.Errorf("未知候选 %q", choice.Key)
		}
		if _, ok := selected[choice.Key]; ok {
			return nil, nil, fmt.Errorf("重复候选 %q", choice.Key)
		}
		if choice.Choice != "local" && choice.Choice != "source" {
			return nil, nil, errors.New("选择只能是local或source")
		}
		if choice.Choice == "source" && !item.SourceAvailable || choice.Choice == "local" && !item.LocalAvailable {
			return nil, nil, errors.New("所选候选不可用")
		}
		if choice.AcknowledgeOnly && p.baseline == nil {
			return nil, nil, errors.New("当前资料没有来源基线，不能仅确认来源版本")
		}
		selected[choice.Key] = choice.Choice
		if choice.AcknowledgeOnly {
			continue
		}
		if prior, ok := p.remembered(item); ok && item.Identity != "" && prior.Key != item.Key {
			delete(memory.Entries, prior.Key)
		}
		memoryKey := catalogMemoryKey(item.Entity, item.ID, item.Field, choice.Choice, item.Identity)
		if memoryKey != choice.Key {
			delete(memory.Entries, choice.Key)
		}
		memory.Entries[memoryKey] = catalogRememberedChoice{Key: memoryKey, Entity: item.Entity, ID: item.ID, Name: item.Name, Field: item.Field, Choice: choice.Choice, Identity: item.Identity}
	}
	images := []officialdex.ImageCandidate{}
	applied := 0
	for _, item := range p.candidates {
		choice := selected[item.Key]
		if choice == "" {
			if old, ok := p.remembered(item); ok {
				choice = old.Choice
				if item.Identity != "" && choice == "source" {
					delete(memory.Entries, old.Key)
					old.Key = catalogMemoryKey(item.Entity, item.ID, item.Field, choice, item.Identity)
					old.ID = item.ID
					memory.Entries[old.Key] = old
				}
			}
		}
		if choice != "source" || !item.SourceAvailable {
			continue
		}
		if item.images != nil {
			images = append(images, item.images...)
		} else if item.apply != nil {
			if err = item.apply(c); err != nil {
				return nil, nil, err
			}
		}
		applied++
	}
	if len(choices) == 0 && applied == 0 {
		return nil, nil, errors.New("尚未选择，且没有已记忆的来源变化")
	}
	if err = writeCatalogChoiceMemory(c, memory); err != nil {
		return nil, nil, err
	}
	if err = p.reconcileBaselineLearning(c, selected); err != nil {
		return nil, nil, err
	}
	if err = p.commitBaseline(c, selected); err != nil {
		return nil, nil, err
	}
	// No implicit dependency selection: missing new skills/monsters or mixed
	// incompatible relationship choices fail the whole operation before any write.
	b, err := catalog.Marshal(c)
	if err != nil {
		return nil, nil, fmt.Errorf("候选组合无效: %w", err)
	}
	c, err = catalog.Parse(b)
	if err != nil {
		return nil, nil, fmt.Errorf("候选组合无效: %w", err)
	}
	filtered := images[:0]
	for _, image := range images {
		if choiceMonster(c, image.ID) != nil {
			filtered = append(filtered, image)
		}
	}
	return c, filtered, nil
}

func (m *catalogUpdateManager) ClearChoices(base string, keys []string, all bool) error {
	// Match apply's mutation -> manager lock order. Status/Start never acquire
	// mutationMu while holding manager.mu, so a manual write cannot deadlock this.
	m.rt.mutationMu.Lock()
	defer m.rt.mutationMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.busy() {
		return errors.New("更新任务进行中，不能清除记忆")
	}
	snap := m.rt.store.Current()
	if base == "" || base != snap.Revision {
		return catalogstore.ErrConflict
	}
	if all && len(keys) > 0 || !all && len(keys) == 0 {
		return errors.New("请指定keys或all")
	}
	c, err := catalog.Parse(snap.Data)
	if err != nil {
		return err
	}
	memory, err := readCatalogChoiceMemory(c)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, key := range keys {
		if seen[key] {
			return errors.New("重复记忆key")
		}
		seen[key] = true
		if _, ok := memory.Entries[key]; !ok {
			return errors.New("未知记忆key")
		}
		delete(memory.Entries, key)
	}
	if all {
		memory.Entries = map[string]catalogRememberedChoice{}
	}
	if err = writeCatalogChoiceMemory(c, memory); err != nil {
		return err
	}
	b, err := catalog.Marshal(c)
	if err != nil {
		return err
	}
	committed, err := m.rt.store.Commit(b, base, nil)
	if err != nil {
		return err
	}
	m.proposal = nil
	m.choicePlan = nil
	m.status = catalogUpdateStatus{OK: true, State: "idle", CurrentRevision: committed.Revision, SourceURL: officialdex.SourceURL, Changes: []officialdex.Change{}, Candidates: []catalogCandidate{}, Issues: []officialdex.Issue{}, Summary: map[string]any{}, Message: "选择记忆已清除，请重新检查。"}
	return nil
}

// A policy is metadata, never executable text, a destination path, or a source
// numeric-ID matcher. Keep this helper local to the known schema.
func catalogChoiceFieldKnown(entity, field string) bool {
	return sourcebaseline.FieldKnown(entity, field)
}
