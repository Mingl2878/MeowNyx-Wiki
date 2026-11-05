package officialdex

import (
	"fmt"
	"sort"
	"strings"
)

// NormalizeName mirrors js/monster-identity.js and wiki_identity.go: deliberately
// bounded compatibility, never a general base-name/form-suffix stripper.
func NormalizeName(name string) string {
	roman := [...]string{"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			b.WriteRune(r - 0xFEE0)
		case r == 0x3000:
			b.WriteByte(' ')
		case r >= 0x2160 && r <= 0x216B:
			b.WriteString(roman[r-0x2160])
		case r >= 0x2170 && r <= 0x217B:
			b.WriteString(roman[r-0x2170])
		case r >= 0x200B && r <= 0x200D || r == 0xFEFF:
		case strings.ContainsRune("‐‑‒–—−﹣", r):
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	r := []rune(strings.TrimFunc(b.String(), nameSpace))
	i := len(r)
	for i > 0 && strings.ContainsRune("ivxIVX", r[i-1]) {
		i--
	}
	if i == len(r) {
		return string(r)
	}
	j := i
	for j > 0 && (r[j-1] == '-' || r[j-1] == '_' || nameSpace(r[j-1])) {
		j--
	}
	return string(r[:j]) + strings.ToUpper(string(r[i:]))
}
func nameSpace(r rune) bool {
	return r == 0x20 || r >= 9 && r <= 13 || r == 0xa0 || r == 0x1680 || r >= 0x2000 && r <= 0x200a || r == 0x2028 || r == 0x2029 || r == 0x202f || r == 0x205f || r == 0x3000 || r == 0xfeff
}
func normalizedDisplay(s string) string {
	s = NormalizeName(s)
	if i := strings.LastIndex(s, "("); i >= 0 && strings.HasSuffix(s, ")") {
		return NormalizeName(s[:i]) + "(" + NormalizeName(s[i+1:len(s)-1]) + ")"
	}
	return s
}
func displayName(m object) string {
	n := localName(m)
	f := text(m["form"])
	if f != "" && f != "default" && f != "Original" {
		n += "（" + f + "）"
	}
	return n
}
func explicitLocalForm(m object) string {
	f := text(m["form"])
	if f == "Original" {
		return "本来的样子"
	}
	if f == "default" || f == "" {
		if leader, _ := m["is_leader_form"].(bool); leader {
			return "首领形态"
		}
		return ""
	}
	return f
}
func sourceIdentity(s *sourceMonster) string {
	return fmt.Sprintf("NO.%03d|%s|%s", s.dex, NormalizeName(s.name), NormalizeName(s.form))
}
func sourceRef(s *sourceMonster) object {
	return object{"provider": Provider, "id": s.id, "identity": sourceIdentity(s)}
}

type localIndex struct {
	monsters map[int]object
	byName   map[string][]int
	wikiByID map[int]object
	wikiKey  map[int]string
}

func appendUnique(ids []int, id int) []int {
	for _, i := range ids {
		if i == id {
			return ids
		}
	}
	return append(ids, id)
}
func makeLocalIndex(monsters []any, wiki object, p *Proposal) (*localIndex, error) {
	x := &localIndex{map[int]object{}, map[string][]int{}, map[int]object{}, map[int]string{}}
	register := func(n string, id int) {
		if n != "" {
			k := normalizedDisplay(n)
			x.byName[k] = appendUnique(x.byName[k], id)
		}
	}
	for _, v := range monsters {
		m := asObject(v)
		id := idOf(m)
		if localName(m) == "" {
			return nil, fmt.Errorf("local monster #%d lacks name", id)
		}
		x.monsters[id] = m
		register(displayName(m), id)
		if values, exists := m["aliases"]; exists {
			aliases, ok := values.([]any)
			if !ok {
				return nil, fmt.Errorf("monster #%d aliases must be an array", id)
			}
			for _, value := range aliases {
				alias, ok := value.(string)
				if !ok {
					return nil, fmt.Errorf("monster #%d alias must be a string", id)
				}
				register(alias, id)
			}
		}
		name := localName(m)
		if f := explicitLocalForm(m); f != "" {
			name += "（" + f + "）"
		}
		register(name, id)
	}
	groups := map[int][]string{}
	for _, key := range keys(wiki) {
		entry := asObject(wiki[key])
		if entry == nil {
			return nil, fmt.Errorf("wiki %q is not an object", key)
		}
		if v, ok := entry["skills"]; ok {
			a, ok := v.([]any)
			if !ok {
				return nil, fmt.Errorf("wiki %q skills is not an array", key)
			}
			for _, v := range a {
				m := asObject(v)
				if text(m["name"]) == "" {
					return nil, fmt.Errorf("wiki %q contains unnamed skill", key)
				}
				if v, exists := m["source"]; exists && v != nil {
					if _, ok := v.(string); !ok {
						return nil, fmt.Errorf("wiki %q has invalid learning source", key)
					}
				}
			}
		}
		aliases := []string{}
		if val, exists := entry["aliases"]; exists {
			a, ok := val.([]any)
			if !ok {
				return nil, fmt.Errorf("wiki aliases must be an array")
			}
			for _, v := range a {
				s, ok := v.(string)
				if !ok {
					return nil, fmt.Errorf("wiki alias must be a string")
				}
				aliases = append(aliases, s)
			}
		}
		id := 0
		if val, exists := entry["monster_id"]; exists {
			var ok bool
			id, ok = integer(val)
			if !ok || x.monsters[id] == nil {
				return nil, fmt.Errorf("wiki %q references unknown monster_id", key)
			}
		} else {
			ids := x.byName[normalizedDisplay(key)]
			if len(ids) == 1 {
				id = ids[0]
			}
		}
		if id == 0 {
			p.issue("review", "orphan_wiki", "wiki", 0, "", key, "monster_id", "无法按稳定身份归属；保留条目")
			continue
		}
		groups[id] = append(groups[id], key)
		register(key, id)
		for _, a := range aliases {
			register(a, id)
		}
	}
	for _, key := range keys(wiki) {
		entry := asObject(wiki[key])
		id, _ := integer(entry["monster_id"])
		if id == 0 {
			continue
		}
		if ids := x.byName[normalizedDisplay(key)]; len(ids) > 1 {
			return nil, fmt.Errorf("wiki name %q collides across IDs", key)
		}
	}
	for _, v := range monsters {
		m := asObject(v)
		id := idOf(m)
		g := groups[id]
		if len(g) == 0 {
			continue
		}
		canonical := displayName(m)
		if len(g) == 1 && g[0] == canonical {
			entry := asObject(wiki[g[0]])
			x.wikiByID[id] = entry
			x.wikiKey[id] = canonical
			continue
		}
		merged, err := mergeAliases(wiki, g, canonical, id)
		if err != nil {
			return nil, err
		}
		before := object{}
		for _, key := range g {
			before[key] = clone(wiki[key])
			delete(wiki, key)
		}
		if prior, exists := wiki[canonical]; exists && !equal(prior, merged) {
			return nil, fmt.Errorf("canonical wiki key collision %q", canonical)
		}
		wiki[canonical] = merged
		x.wikiByID[id] = merged
		x.wikiKey[id] = canonical
		p.Changes = append(p.Changes, Change{"wiki", id, canonical, "aliases", before, clone(merged), "merge"})
	}
	return x, nil
}

func mergeAliases(wiki object, group []string, canonical string, id int) (object, error) {
	out := object{}
	skills := []any{}
	seen := map[string]object{}
	aliases := []any{}
	aliasSet := map[string]bool{}
	addAlias := func(s string) {
		if s != "" && s != canonical && !aliasSet[s] {
			aliasSet[s] = true
			aliases = append(aliases, s)
		}
	}
	for _, key := range group {
		e := asObject(wiki[key])
		addAlias(key)
		a, _ := e["aliases"].([]any)
		for _, v := range a {
			addAlias(text(v))
		}
		for _, f := range keys(e) {
			if f == "skills" || f == "aliases" || f == "monster_id" || f == "image" {
				continue
			}
			if prior, exists := out[f]; exists && !equal(prior, e[f]) {
				return nil, fmt.Errorf("wiki alias field conflict %s.%s", canonical, f)
			}
			out[f] = clone(e[f])
		}
		if text(e["image"]) != "" && (text(out["image"]) == "" || key == canonical) {
			out["image"] = e["image"]
		}
		rows, _ := e["skills"].([]any)
		for _, v := range rows {
			row := asObject(clone(v))
			k := learningKey(row)
			if old := seen[k]; old != nil {
				for _, f := range keys(row) {
					if f == "source" {
						continue
					}
					if prior, exists := old[f]; exists && !equal(prior, row[f]) {
						return nil, fmt.Errorf("wiki alias skill conflict %s/%s.%s", canonical, k, f)
					}
					old[f] = clone(row[f])
				}
			} else {
				skills = append(skills, row)
				seen[k] = row
			}
		}
	}
	out["skills"] = skills
	out["monster_id"] = id
	if out["image"] == nil {
		out["image"] = ""
	}
	if len(aliases) > 0 {
		out["aliases"] = aliases
	}
	return out, nil
}
func learningKey(m object) string {
	s := text(m["source"])
	if s == "" {
		s = "默认"
	}
	return NormalizeName(text(m["name"])) + "\x00" + s
}

func sortedMonsterIDs(x *localIndex) []int {
	ids := make([]int, 0, len(x.monsters))
	for id := range x.monsters {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// Match on full normalized name plus independently checked dex and explicit
// form. A source reference is retained as provenance, never an ID-only fallback.
func (x *localIndex) match(s *sourceMonster, p *Proposal) (int, bool) {
	for _, r := range reviewedIdentities {
		m := x.monsters[r.localID]
		context := s.name == r.name && s.form == r.form || s.id == r.sourceID && (s.name == r.name || localName(m) == r.oldName || localName(m) == r.name)
		if context && !r.sourceMatches(s) {
			p.issue("review", "reviewed_identity_crosscheck_failed", "monster", r.localID, s.id, s.full, "identity", "已审核来源的ID、名称、图鉴编号或形态发生变化；不扩大批准范围，不按数字兜底")
			return 0, false
		}
	}
	if r := reviewedMapping(s); r != nil {
		if !r.localMatches(x.monsters[r.localID]) {
			p.issue("review", "reviewed_identity_crosscheck_failed", "monster", r.localID, s.id, s.full, "identity", "已审核映射的稳定ID、旧/新名称、图鉴编号或明确形态不一致；拒绝映射及重建ID")
			return 0, false
		}
		for _, id := range x.byName[normalizedDisplay(s.full)] {
			if id != r.localID {
				p.issue("blocking", "ambiguous_identity", "monster", r.localID, s.id, s.full, "identity", "已审核名称同时命中另一本地身份；拒绝映射")
				return 0, false
			}
		}
		return r.localID, true
	}
	ids := x.byName[normalizedDisplay(s.full)]
	if len(ids) == 0 {
		name := s.name
		if s.form != "" {
			name += "（" + s.form + "）"
		}
		ids = x.byName[normalizedDisplay(name)]
	}
	if len(ids) > 1 {
		p.issue("blocking", "ambiguous_identity", "monster", 0, s.id, s.full, "identity", "规范名命中多个本地稳定ID")
		return 0, false
	}
	if len(ids) == 1 {
		id := ids[0]
		m := x.monsters[id]
		if id == 9001 {
			p.issue("blocking", "reserved_monster", "monster", id, s.id, s.full, "id", "9001是本地木桩保留ID")
			return 0, false
		}
		dex, ok := integer(m["dex_number"])
		form, formOK := m["form"].(string)
		if !ok || !formOK || form == "" || dex != s.dex || NormalizeName(explicitLocalForm(m)) != NormalizeName(s.form) {
			p.issue("review", "identity_crosscheck_failed", "monster", id, s.id, s.full, "identity", "名称虽命中，但图鉴编号或明确形态不一致；保留本地")
			return 0, false
		}
		return id, true
	}
	// A malformed/unknown local form for the same base cannot prove a new form.
	for _, id := range sortedMonsterIDs(x) {
		m := x.monsters[id]
		if NormalizeName(localName(m)) == NormalizeName(s.name) {
			if _, exists := m["form"]; !exists {
				p.issue("review", "ambiguous_new_form", "monster", idOf(m), s.id, s.full, "form", "同基础名本地缺少明确形态，不自动新增")
				return 0, false
			}
			if NormalizeName(explicitLocalForm(m)) == NormalizeName(s.form) {
				p.issue("blocking", "ambiguous_identity", "monster", idOf(m), s.id, s.full, "identity", "同基础名形态存在但无法唯一交叉核对")
				return 0, false
			}
		}
	}
	return 0, true
}
