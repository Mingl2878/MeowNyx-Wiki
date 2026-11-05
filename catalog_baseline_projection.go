package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/officialdex"
)

func baselineText(s string) string { return strings.Join(strings.Fields(s), "") }
func baselineSameLearningSet(a, b []catalog.LearnedSkill) bool {
	keys := func(rows []catalog.LearnedSkill) map[string]bool {
		out := map[string]bool{}
		for _, row := range rows {
			out[fmt.Sprintf("%d|%s", row.SkillID, row.Source)] = true
		}
		return out
	}
	left, right := keys(a), keys(b)
	if len(left) != len(right) {
		return false
	}
	for key := range left {
		if !right[key] {
			return false
		}
	}
	return true
}
func baselineLearningDisplay(c *catalog.Catalog, id int) any {
	l := choiceLearnset(c, id)
	if l == nil {
		return nil
	}
	value := choiceFields(l, learningChoiceFields)
	if face, err := baselineEffectiveLearning(c, id); err == nil {
		value["skills"], _ = json.Marshal(face.Skills)
	}
	return value
}
func baselineDecode(value any) any {
	b, _ := json.Marshal(value)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// A changed source can now equal calibrated local data. That is a valid no-op
// source revision, not an unavailable value. Compare source evidence with the
// field's source-domain projection to distinguish it from a suppressed patch.
func (p *catalogChoicePlan) sourceAgrees(entity string, id int, field string, proposed any) bool {
	o, ok := p.observations[catalogCandidateKey(entity, id, field)]
	if !ok || !o.Available {
		return false
	}
	var observed struct {
		Value any `json:"value"`
	}
	if json.Unmarshal(o.Value, &observed) != nil {
		return false
	}
	if strings.HasPrefix(field, "stats.") || entity == "skill" && (field == "power" || field == "energy_cost" || field == "category") {
		return choiceEqual(proposed, observed.Value)
	}
	if entity == "skill" && field == "description" {
		value, _ := baselineDecode(proposed).(string)
		return choiceEqual(baselineText(value), observed.Value)
	}
	if entity == "skill" && field == "identity" {
		skill := choiceSkill(p.sourceCatalog, id)
		return skill != nil && choiceEqual(officialdex.NormalizeName(skill.Name), observed.Value)
	}
	if field == "type_ids" || field == "type_id" {
		names := map[int]string{}
		for _, typ := range p.sourceCatalog.Types {
			names[typ.ID] = typ.Name
		}
		if field == "type_id" {
			value, ok := baselineDecode(proposed).(float64)
			return ok && choiceEqual(names[int(value)], observed.Value)
		}
		ids, ok := baselineDecode(proposed).([]any)
		if !ok {
			return false
		}
		values := []string{"", ""}
		if len(ids) > 2 {
			return false
		}
		for i, v := range ids {
			n, ok := v.(float64)
			if !ok {
				return false
			}
			values[i] = names[int(n)]
		}
		return choiceEqual(values, observed.Value)
	}
	if field == "evolution_stage" {
		raw, ok := observed.Value.(map[string]any)
		if !ok {
			return false
		}
		stage, ok := raw["stage"].(string)
		if !ok {
			return false
		}
		form, _ := raw["form"].(string)
		value := ""
		switch stage {
		case "一阶", "二阶":
			value = "基础形态"
		case "最终形态":
			value = "高级形态"
		}
		if form == "首领形态" {
			value = "首领形态"
		}
		return value != "" && choiceEqual(proposed, value)
	}
	if field == "trait" {
		m := choiceMonster(p.sourceCatalog, id)
		if m == nil {
			return false
		}
		trait := choiceTrait(p.sourceCatalog, m.TraitID)
		if trait == nil {
			return false
		}
		return choiceEqual(map[string]any{"name": officialdex.NormalizeName(trait.Name), "description": baselineText(trait.Description)}, observed.Value)
	}
	if field == "learning" {
		face, err := baselineEffectiveLearning(p.sourceCatalog, id)
		if err != nil {
			return false
		}
		values := []string{}
		seen := map[string]bool{}
		for _, row := range face.Skills {
			skill := choiceSkill(p.sourceCatalog, row.SkillID)
			if skill == nil {
				return false
			}
			source := row.Source
			if source == "传说" {
				source = "默认"
			}
			key := officialdex.NormalizeName(skill.Name) + "|" + source
			if !seen[key] {
				values = append(values, key)
				seen[key] = true
			}
		}
		sort.Strings(values)
		return choiceEqual(values, observed.Value)
	}
	if field == "evolution" {
		raw, ok := observed.Value.(map[string]any)
		if !ok {
			return false
		}
		members, ok := raw["members"].([]any)
		if !ok {
			return false
		}
		m := choiceMonster(p.sourceCatalog, id)
		if m == nil || len(members) != len(m.EvolutionMembers) {
			return false
		}
		for i, member := range m.EvolutionMembers {
			target, ok := p.observations[catalogCandidateKey("monster", member, "identity")]
			value, vok := members[i].(map[string]any)
			if !ok || !vok || value["identity"] != target.Identity {
				return false
			}
		}
		return true // no source-provided directional arrow is invented
	}
	return false
}
func baselineEffectiveLearning(c *catalog.Catalog, id int) (*catalog.Learnset, error) {
	seen := map[int]bool{}
	for {
		if seen[id] {
			return nil, fmt.Errorf("学习继承候选形成循环")
		}
		seen[id] = true
		l := choiceLearnset(c, id)
		if l == nil {
			return nil, fmt.Errorf("学习继承候选缺少目标")
		}
		if l.Mode == "own" {
			return l, nil
		}
		if l.Mode != "inherit" || l.FromID == 0 {
			return nil, fmt.Errorf("学习模式无效")
		}
		id = l.FromID
	}
}

// A parent's source update must not change an unchanged/declined child's
// effective learning through inheritance. Conversely an explicitly selected
// child's source face must not depend on selecting its parent's unrelated row.
// Visit parent-first, retaining inherit whenever the resulting face still agrees;
// otherwise materialize ONLY that child, preserving its unknown metadata.
func (p *catalogChoicePlan) reconcileBaselineLearning(c *catalog.Catalog, selected map[string]string) error {
	if p.baseline == nil {
		return nil
	}
	sourceWanted := map[int]bool{}
	for _, item := range p.candidates {
		if item.Entity != "monster" || (item.Field != "learning" && item.Field != "entity") {
			continue
		}
		choice := selected[item.Key]
		if choice == "" {
			if memory, ok := p.remembered(item); ok {
				choice = memory.Choice
			}
		}
		if choice == "source" && item.SourceAvailable {
			sourceWanted[item.ID] = true
		}
	}
	desired := map[int]*catalog.Learnset{}
	for _, l := range c.Learnsets {
		owner := p.localCatalog
		if sourceWanted[l.MonsterID] || choiceLearnset(owner, l.MonsterID) == nil {
			owner = p.sourceCatalog
		}
		face, err := baselineEffectiveLearning(owner, l.MonsterID)
		if err != nil {
			return err
		}
		desired[l.MonsterID] = face
	}
	state := map[int]int{}
	var visit func(int) error
	visit = func(id int) error {
		if state[id] == 2 {
			return nil
		}
		if state[id] == 1 {
			return fmt.Errorf("学习继承候选形成循环")
		}
		state[id] = 1
		l := choiceLearnset(c, id)
		if l == nil {
			return fmt.Errorf("学习继承候选缺少目标")
		}
		if l.Mode == "inherit" {
			if err := visit(l.FromID); err != nil {
				return err
			}
			actual, err := baselineEffectiveLearning(c, id)
			if err != nil {
				return err
			}
			want := desired[id]
			if !baselineSameLearningSet(actual.Skills, want.Skills) {
				raw, _ := json.Marshal(want.Skills)
				if err := json.Unmarshal(raw, &l.Skills); err != nil {
					return err
				}
				l.Mode = "own"
				l.FromID = 0
				if l.Extensions == nil {
					l.Extensions = catalog.Extensions{}
				}
				for _, key := range []string{"legacy_skills", "legacy_skill_omit"} {
					if value, ok := want.Extensions[key]; ok {
						l.Extensions[key] = append(json.RawMessage(nil), value...)
					} else {
						delete(l.Extensions, key)
					}
				}
			}
		}
		state[id] = 2
		return nil
	}
	for _, l := range c.Learnsets {
		if err := visit(l.MonsterID); err != nil {
			return err
		}
	}
	return nil
}
