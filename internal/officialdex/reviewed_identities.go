package officialdex

import "fmt"

// Reviewed on 2026-10-30. These are individual identity decisions, NOT spelling
// normalization rules. Both the source tuple and the stable local old/new tuple
// must match; source IDs alone never confer identity or migration permission.
type reviewedIdentity struct {
	sourceID, name, form string
	dex, localID         int
	oldName, oldForm     string
	category             string
}

var reviewedIdentities = []reviewedIdentity{
	{"43", "雪绒鸟", "本来的样子", 18, 40, "雪绒鸟", "冬天的样子", "主形态"},
	{"44", "冬羽雀", "本来的样子", 19, 44, "冬羽雀", "冬天的样子", "主形态"},
	{"48", "岚鸟", "本来的样子", 20, 48, "岚鸟", "冬天的样子", "主形态"},
	{"55", "霜翼领主", "本来的样子", 20, 49, "霜翼领主", "冬天的样子", "主形态"},
	{"366", "香草甜甜", "樱桃饰品", 235, 365, "香草甜甜", "Original", "主形态"},
	{"369", "圣代甜甜", "樱桃巧克力口味", 236, 368, "圣代甜甜", "Original", "主形态"},
	{"515", "加油蟹", "两只海葵的样子", 361, 512, "加油蟹", "Original", "主形态"},
	{"572", "黑化加尔", "黑化的样子", 417, 569, "黑化加尔", "default", "无多形态"},
	{"601", "新月鹭", "", 446, 615, "新月鸷", "default", "无多形态"},
	{"602", "月辉鹭", "", 447, 606, "月辉鸠", "default", "无多形态"},
	{"603", "月使鹭纳", "", 448, 604, "月使鸷纳", "default", "无多形态"},
	{"610", "玳龟", "", 455, 610, "斑鱼", "default", "无多形态"},
}

func (r reviewedIdentity) newForm() string {
	if r.form == "" {
		return "default"
	}
	return r.form
}
func (r reviewedIdentity) sourceMatches(s *sourceMonster) bool {
	return s.identityOK && s.id == r.sourceID && s.name == r.name && s.form == r.form && s.dex == r.dex
}
func (r reviewedIdentity) localMatches(m object) bool {
	dex, ok := integer(m["dex_number"])
	return m != nil && idOf(m) == r.localID && ok && dex == r.dex && text(m["form_category"]) == r.category &&
		(localName(m) == r.oldName && text(m["form"]) == r.oldForm || localName(m) == r.name && text(m["form"]) == r.newForm())
}
func reviewedMapping(s *sourceMonster) *reviewedIdentity {
	for i := range reviewedIdentities {
		if reviewedIdentities[i].sourceMatches(s) {
			return &reviewedIdentities[i]
		}
	}
	return nil
}

// migrateReviewedIdentity also updates the legacy name/form parent reference,
// which ImportLegacy resolves to MainFormID. Wiki aliases are the canonical
// export location for aliases; do not manufacture a monster aliases field on
// every run (ExportLegacy intentionally projects aliases into Wiki).
func (p *Proposal) migrateReviewedIdentity(s *sourceMonster, x *localIndex, wiki object) error {
	r := reviewedMapping(s)
	if r == nil {
		return nil
	}
	m := x.monsters[r.localID]
	if !r.localMatches(m) {
		return fmt.Errorf("reviewed local identity changed for source %s", s.id)
	}
	oldName, oldForm, oldDisplay := localName(m), text(m["form"]), displayName(m)
	newDisplay := r.name
	if r.newForm() != "default" && r.newForm() != "Original" {
		newDisplay += "（" + r.newForm() + "）"
	}
	entry := x.wikiByID[r.localID]
	if entry == nil {
		entry = object{"monster_id": r.localID, "image": "", "skills": []any{}}
	}
	aliases := []any{}
	seen := map[string]bool{}
	add := func(value string) {
		if value != "" && value != newDisplay && !seen[value] {
			aliases = append(aliases, value)
			seen[value] = true
		}
	}
	for _, record := range []object{entry, m} {
		values, _ := record["aliases"].([]any)
		for _, value := range values {
			add(text(value))
		}
	}
	// The verified old bare names belong to these exact primary/standalone IDs.
	add(r.oldName)
	oldIdentity := r.oldName
	if r.oldForm != "default" && r.oldForm != "Original" {
		oldIdentity += "（" + r.oldForm + "）"
	}
	add(oldIdentity)
	add(oldDisplay)
	add(x.wikiKey[r.localID])
	for _, name := range append(append([]any{}, aliases...), newDisplay) {
		for _, id := range x.byName[normalizedDisplay(text(name))] {
			if id != r.localID {
				return fmt.Errorf("reviewed alias %q collides with local ID %d", name, id)
			}
		}
	}
	if other := asObject(wiki[newDisplay]); other != nil && newDisplay != x.wikiKey[r.localID] {
		return fmt.Errorf("reviewed wiki key %q already exists", newDisplay)
	}
	// Change parent labels only for references resolving to this exact old
	// name/form pair, not all winter labels or all records with the same NO.
	if oldForm != r.newForm() {
		for _, id := range sortedMonsterIDs(x) {
			child := x.monsters[id]
			if localName(child) == oldName && text(child["main_form_name"]) == oldForm {
				p.set(child, "monster", id, displayName(child), "main_form_name", r.newForm())
			}
		}
	}
	p.set(m, "monster", r.localID, oldDisplay, "localized.zh.name", r.name)
	p.set(m, "monster", r.localID, newDisplay, "form", r.newForm())
	oldKey := x.wikiKey[r.localID]
	if oldKey != newDisplay {
		before := clone(wiki[oldKey])
		delete(wiki, oldKey)
		wiki[newDisplay] = entry
		x.wikiKey[r.localID] = newDisplay
		x.wikiByID[r.localID] = entry
		p.Changes = append(p.Changes, Change{"wiki", r.localID, newDisplay, "key", object{"key": oldKey, "entry": before}, object{"key": newDisplay}, "update"})
	}
	if len(aliases) > 0 {
		p.set(entry, "wiki", r.localID, newDisplay, "aliases", aliases)
	}
	return nil
}

// Only these three reviewed complex additions bypass the generic f/forms gate.
// They are independent records, not inferred variants or evolution edges.
func reviewedAddition(s *sourceMonster) bool {
	if !s.identityOK {
		return false
	}
	return s.id == "344" && s.dex == 218 && s.name == "烈焰狂战士" && s.form == "首领形态" ||
		s.id == "382" && s.dex == 238 && s.name == "满月砣" && s.form == "上弦的样子" ||
		s.id == "383" && s.dex == 238 && s.name == "满月砣" && s.form == "下弦的样子"
}

const independentFormNote = "官方已单列并经审核确认新增；当前保守独立呈现（无多形态、独立学习面），不指定主形态或进化前置。官方没有可用阶段候选，阶段暂记未确认，不推断高级或首领。"
