package officialdex

import "strings"

// A legacy trait may contain the official one-line summary followed by locally
// supplied per-element effects. Keep that suffix on this monster, not in the
// shared authoritative trait definition. Only an exact whitespace-insensitive
// first-line match proves this specific split; never infer notes from prose.
func (p *Proposal) preserveTraitNotes(m object, s *sourceMonster) {
	old := text(field(m, "trait.localized.zh.description"))
	lineEnd := strings.IndexAny(old, "\r\n")
	if lineEnd < 0 || semanticText(old[:lineEnd]) != semanticText(text(s.raw["te"])) {
		return
	}
	tail := old[lineEnd+1:]
	if old[lineEnd] == '\r' && strings.HasPrefix(tail, "\n") {
		tail = tail[1:]
	}
	if strings.TrimSpace(tail) == "" {
		return
	}
	id, name := idOf(m), displayName(m)
	if existing, exists := m["_trait_notes"]; exists {
		// An explicit local notes field remains authoritative, even if empty.
		// The before value of the description Change retains conflicting old
		// suffix evidence for review; never silently concatenate it again.
		if notes, ok := existing.(string); !ok || notes != tail {
			p.issue("review", "local_trait_notes_conflict", "monster", id, s.id, name, "_trait_notes", "旧特性描述尾部包含本地补充，但与已有_trait_notes不同；保留已有补充，不覆盖或重复拼接，请根据描述变更前全文人工核对。官方特性原文仍以腾讯te为准。")
			return
		}
	} else {
		p.set(m, "monster", id, name, "_trait_notes", tail)
	}
	p.issue("review", "local_trait_notes_preserved", "monster", id, s.id, name, "_trait_notes", "旧特性摘要后的全文已保留为此精灵独立的本地补充_trait_notes；它不属于腾讯特性原文，官方trait.description仍仅保存te。")
}
