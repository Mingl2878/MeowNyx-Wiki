package officialdex

import (
	"fmt"
	"strings"
)

func (p *Proposal) mergeMoves(moves []any, c *catalog, types map[string]object) (map[string]object, []any, error) {
	byName := map[string]object{}
	duplicates := map[string]bool{}
	nextID := 0
	for _, v := range moves {
		m := asObject(v)
		key := NormalizeName(localName(m))
		if key == "" {
			return nil, nil, fmt.Errorf("local move #%d has no name", idOf(m))
		}
		if byName[key] != nil {
			duplicates[key] = true
			p.issue("blocking", "local_move_name_conflict", "move", idOf(m), "", localName(m), "name", "多个本地主技能共享同一规范名，拒绝自动关联")
		}
		byName[key] = m
		if idOf(m) > nextID {
			nextID = idOf(m)
		}
	}
	for _, key := range c.moveOrder {
		s := c.moves[key]
		if duplicates[key] {
			s.valid = false
			continue
		}
		if !s.valid {
			continue
		}
		t := types[text(s.raw["el"])]
		if t == nil {
			s.valid = false
			p.issue("review", "unknown_type", "move", 0, "", s.name, "move_type", "官方技能属性不在本地types；保留本地，拒绝新增")
			continue
		}
		m := byName[key]
		newMove := m == nil
		if newMove {
			nextID++
			m = object{"id": nextID, "localized": object{"zh": object{}}, "move_type": object{}, "power": nil, "base_combo": nil, "power_formula": nil, "season": ""}
			moves = append(moves, m)
			byName[key] = m
			p.Stats.AddedMoves++
		}
		id := idOf(m)
		oldName := localName(m)
		if newMove {
			oldName = s.name
		}
		newDesc := text(s.raw["ef"])
		if !newMove && semanticText(description(m)) != semanticText(newDesc) && hasRules(m) {
			p.issue("review", "special_rule_description_changed", "move", id, "", s.name, "localized.zh.description", "官方描述已变化；保留已有特殊威力/规则字段，需人工复核规则，不按描述猜新公式")
		}
		// Build changes through the same setters for ordinary and special moves.
		start := len(p.Changes)
		p.set(m, "move", id, oldName, "localized.zh.name", s.name)
		p.set(m, "move", id, s.name, "localized.zh.description", newDesc)
		p.set(m, "move", id, s.name, "energy_cost", mustNumeric(s.raw["ec"]))
		p.set(m, "move", id, s.name, "move_category", categoryToLegacy[text(s.raw["tp"])])
		if zhString(asObject(m["move_type"])) != text(s.raw["el"]) {
			// Type relations remain in local types, not rebuilt from source e.
			mt := asObject(clone(m["move_type"]))
			if mt == nil {
				mt = object{}
			}
			for _, f := range []string{"id", "name", "localized"} {
				mt[f] = clone(t[f])
			}
			p.set(m, "move", id, s.name, "move_type", mt)
		}
		if newMove || !protectedPower(m) {
			power, _ := numericString(s.raw["pw"], true)
			p.set(m, "move", id, s.name, "power", power)
		}
		if newMove {
			p.Changes = p.Changes[:start]
			p.Changes = append(p.Changes, Change{"move", id, s.name, "", nil, clone(m), "add"})
		}
		p.addImage("move", id, s.name, "move", text(c.images["_skm"][s.name]), text(m["image"]), "")
	}
	for _, v := range moves {
		m := asObject(v)
		key := NormalizeName(localName(m))
		if c.moves[key] == nil {
			p.issue("review", "local_only_move", "move", idOf(m), "", localName(m), "name", "主技能仅存在于本地，保留且待确认，不删除")
		}
	}
	for key := range duplicates {
		delete(byName, key)
	}
	return byName, moves, nil
}
func mustNumeric(v any) any        { n, _ := numericString(v, false); return n }
func semanticText(s string) string { return strings.Join(strings.Fields(s), "") }
func protectedPower(m object) bool {
	known := map[int]string{10: "吨位压制", 19: "彗星", 35: "魔能爆", 70: "以重制重", 195: "鸣沙陷阱", 358: "闪击", 376: "砂糖弹球"}
	if name, ok := known[idOf(m)]; ok && NormalizeName(localName(m)) == NormalizeName(name) {
		return true
	}
	if m["power_formula"] != nil && m["power_formula"] != "" {
		return true
	}
	if s, ok := m["power"].(string); ok && s != "" {
		return true
	}
	if n, ok := integer(m["power"]); ok && n == 0 && (m["move_category"] == "Physical Attack" || m["move_category"] == "Magic Attack") {
		return true
	}
	return false
}
func hasRules(m object) bool {
	if protectedPower(m) {
		return true
	}
	if statuses, ok := m["statuses"].([]any); ok && len(statuses) > 0 {
		return true
	}
	for k, v := range m {
		if v == nil || v == "" {
			continue
		}
		if k == "base_combo" || k == "counter_power_multiplier" || k == "alt_power_total" || k == "alt_condition_zh" || strings.Contains(k, "rule") || strings.Contains(k, "formula") {
			return true
		}
	}
	return false
}

func (p *Proposal) mergeAllLearning(c *catalog, mapped map[string]int, x *localIndex, wiki object, moves map[string]object) {
	byLocal := map[int]*sourceMonster{}
	before := map[int][]any{}
	for _, s := range c.monsters {
		if id := mapped[s.id]; id != 0 {
			before[id] = clone(effectiveLearning(id, x, map[int]bool{})).([]any)
		}
	}
	for _, s := range c.monsters {
		if id := mapped[s.id]; id != 0 {
			byLocal[id] = s
			if text(x.monsters[id]["learnset_mode"]) != "inherit" {
				p.mergeLearning(x.monsters[id], s, x, wiki, c, moves, before[id])
			}
		}
	}
	state := map[int]int{}
	var visit func(int) bool
	visit = func(id int) bool {
		if state[id] == 1 {
			p.issue("blocking", "inheritance_cycle", "monster", id, "", displayName(x.monsters[id]), "learnset_mode", "本地继承存在环；不替换学习面")
			return false
		}
		if state[id] == 2 {
			return true
		}
		state[id] = 1
		m := x.monsters[id]
		if text(m["learnset_mode"]) == "inherit" {
			parent, _ := integer(m["learnset_inherits_from_id"])
			if x.monsters[parent] == nil || !visit(parent) {
				return false
			}
			if s := byLocal[id]; s != nil {
				p.mergeLearning(m, s, x, wiki, c, moves, before[id])
			}
		}
		state[id] = 2
		return true
	}
	for _, s := range c.monsters {
		if id := mapped[s.id]; id != 0 {
			visit(id)
		}
	}
}

func (p *Proposal) mergeLearning(m object, s *sourceMonster, x *localIndex, wiki object, c *catalog, moves map[string]object, before []any) {
	id := idOf(m)
	name := displayName(m)
	entry := x.wikiByID[id]
	if !s.learnOK {
		return
	}
	for _, ref := range s.skills {
		if sm := c.moves[ref.key]; sm == nil || !sm.valid || moves[ref.key] == nil {
			p.issue("review", "learnset_contains_unresolved_move", "monster", id, s.id, name, "skills", "官方学习面含冲突/未确认技能，保留完整本地学习面，不部分替换")
			return
		}
	}
	mode := text(m["learnset_mode"])
	if mode != "own" && mode != "inherit" {
		p.issue("review", "unknown_learnset_mode", "monster", id, s.id, name, "learnset_mode", "本地未明确own/inherit，不推断继承或学习面")
		return
	}
	old := effectiveLearning(id, x, map[int]bool{})
	if len(s.skills) == 0 {
		if len(old) > 0 {
			p.issue("review", "empty_official_learnset", "monster", id, s.id, name, "skills", "官方明确空学习面仍不自动清空已有本地关系或改写继承")
		}
		return
	}
	if mode == "inherit" {
		if sameLearning(old, s.skills) {
			return
		}
		p.set(m, "monster", id, name, "learnset_mode", "own")
		prior := clone(m["learnset_inherits_from_id"])
		delete(m, "learnset_inherits_from_id")
		p.Changes = append(p.Changes, Change{"monster", id, name, "learnset_inherits_from_id", prior, nil, "update"})
	}
	if entry == nil {
		entry = object{"monster_id": id, "image": "", "skills": []any{}}
		wiki[name] = entry
		x.wikiByID[id] = entry
		x.wikiKey[id] = name
		p.Changes = append(p.Changes, Change{"wiki", id, name, "", nil, clone(entry), "add"})
	}
	rows := officialLearning(old, s.skills, moves)
	entry["skills"] = rows
	if !equal(learningReport(before), learningReport(rows)) {
		// Diff against the original effective surface, including its old order,
		// before any parent correction; never report the inactive Wiki cache.
		p.Changes = append(p.Changes, Change{"wiki", id, name, "skills", learningReport(before), learningReport(rows), "merge"})
	}
}

// Legend is a local display classification equivalent only to the official
// default group. Bloodline/stone stay independent relations, not name-only sets.
func equivalentLearningKey(row object) string {
	key := learningKey(row)
	if text(row["source"]) == "传说" {
		return NormalizeName(text(row["name"])) + "\x00默认"
	}
	return key
}

func officialLearning(old []any, refs []sourceLearning, moves map[string]object) []any {
	buckets := map[string][]any{}
	for _, value := range old {
		row := asObject(value)
		key := equivalentLearningKey(row)
		buckets[key] = append(buckets[key], value)
	}
	rows := []any{}
	seen := map[string]bool{}
	for _, ref := range refs {
		key := ref.key + "\x00" + ref.source
		if seen[key] {
			continue // repeated identical source evidence is not another relation
		}
		seen[key] = true
		if prior := buckets[key]; len(prior) > 0 {
			// Preserve valid existing duplicate rows and local legend/default
			// classifications, with their relative order and row extensions.
			for _, row := range prior {
				rows = append(rows, clone(row))
			}
		} else {
			row := wikiMove(moves[ref.key])
			row["source"] = ref.source
			rows = append(rows, row)
		}
	}
	return rows
}

// Reports contain relationships, not redundant copies of master descriptions.
func learningReport(rows []any) []any {
	out := make([]any, 0, len(rows))
	for _, v := range rows {
		row := asObject(v)
		source := text(row["source"])
		if source == "" {
			source = "默认"
		}
		out = append(out, object{"name": text(row["name"]), "source": source})
	}
	return out
}
func effectiveLearning(id int, x *localIndex, seen map[int]bool) []any {
	if seen[id] {
		return nil
	}
	seen[id] = true
	m := x.monsters[id]
	if m == nil {
		return nil
	}
	if text(m["learnset_mode"]) == "inherit" {
		target, _ := integer(m["learnset_inherits_from_id"])
		return effectiveLearning(target, x, seen)
	}
	rows, _ := x.wikiByID[id]["skills"].([]any)
	return rows
}
func sameLearning(rows []any, refs []sourceLearning) bool {
	a, b := map[string]bool{}, map[string]bool{}
	for _, v := range rows {
		a[equivalentLearningKey(asObject(v))] = true
	}
	for _, r := range refs {
		b[r.key+"\x00"+r.source] = true
	}
	return equal(a, b)
}
func wikiMove(m object) object {
	return object{"name": localName(m), "desc": description(m), "type": categoryToWiki[text(m["move_category"])], "element": zhString(asObject(m["move_type"]))}
}
func (p *Proposal) syncWiki(wiki object, moves map[string]object) {
	for _, key := range keys(wiki) {
		e := asObject(wiki[key])
		id, _ := integer(e["monster_id"])
		if id == 9001 {
			continue
		}
		rows, _ := e["skills"].([]any)
		for i, v := range rows {
			r := asObject(v)
			move := moves[NormalizeName(text(r["name"]))]
			if move == nil {
				p.issue("review", "unresolved_wiki_move", "wiki", id, "", key, fmt.Sprintf("skills[%d]", i), "无法唯一对应主技能；保留该行")
				continue
			}
			master := wikiMove(move)
			refreshed := false
			for _, f := range []string{"name", "desc", "type", "element"} {
				val := text(master[f])
				if val == "" {
					continue
				}
				if !equal(r[f], val) {
					r[f] = val
					refreshed = true
				}
			}
			if refreshed {
				p.Stats.RefreshedLearningRows++
			}
		}
	}
}
