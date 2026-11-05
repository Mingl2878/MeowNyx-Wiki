package officialdex

import (
	"crypto/sha256"
	"fmt"
	"strconv"

	"xhmwiki/internal/catalogrecovery"
)

// BuildProposal validates both inputs and computes conservative, deterministic
// differences. Fatal JSON/local integrity/schema failures return no proposal.
// Item-level conflicts are blocking Issues and leave that item unmapped/unchanged.
// Callers own backup, locking, review, HTTP, images, and atomic file replacement.
func BuildProposal(local LegacyFiles, source []byte) (*Proposal, error) {
	return buildProposal(local, source, nil)
}

func buildProposal(local LegacyFiles, source []byte, reservations *catalogrecovery.Reservations) (*Proposal, error) {
	p := &Proposal{Changes: []Change{}, Issues: []Issue{}, Images: []ImageCandidate{}, SourceSHA256: fmt.Sprintf("%x", sha256.Sum256(source))}
	monsters, e := objectArray(local.Monsters, "monsters")
	if e != nil {
		return nil, e
	}
	moves, e := objectArray(local.Moves, "moves")
	if e != nil {
		return nil, e
	}
	types, e := objectArray(local.Types, "types")
	if e != nil {
		return nil, e
	}
	wv, e := decode(local.Wiki)
	if e != nil {
		return nil, fmt.Errorf("wiki: %w", e)
	}
	wiki := asObject(wv)
	if wiki == nil {
		return nil, fmt.Errorf("wiki must be an object")
	}
	beforeM, beforeS, beforeW := clone(monsters), clone(moves), clone(wiki)
	x, e := makeLocalIndex(monsters, wiki, p)
	if e != nil {
		return nil, e
	}
	c, e := parseSource(source, p)
	if e != nil {
		return nil, e
	}
	p.Stats.SourceDetails = len(c.monsters)
	p.Stats.SourceList = c.listCount
	p.Stats.SourceMoves = len(c.moves)
	typeMap := map[string]object{}
	for _, v := range types {
		m := asObject(v)
		n := zhString(m)
		if n == "" || typeMap[n] != nil {
			return nil, fmt.Errorf("invalid or duplicate local type name")
		}
		typeMap[n] = m
	}
	moveMap, moves, e := p.mergeMoves(moves, c, typeMap)
	if e != nil {
		return nil, e
	}
	// Refuse every member of a duplicate identity, not just whichever is second.
	identities := map[string][]*sourceMonster{}
	fullNames := map[string][]*sourceMonster{}
	for _, s := range c.monsters {
		identities[sourceIdentity(s)] = append(identities[sourceIdentity(s)], s)
		fullNames[normalizedDisplay(s.full)] = append(fullNames[normalizedDisplay(s.full)], s)
	}
	for _, s := range c.monsters {
		if len(identities[sourceIdentity(s)]) > 1 || len(fullNames[normalizedDisplay(s.full)]) > 1 {
			s.identityOK = false
			p.issue("blocking", "duplicate_source_identity", "monster", 0, s.id, s.full, "identity", "官方存在重复规范身份，不能选择或分配新ID")
		}
	}
	mapped := map[string]int{}
	matched := map[int]bool{}
	newIDs := map[int]bool{}
	nextID := reservations.MaxID()
	for _, m := range x.monsters {
		if id := idOf(m); id != 9001 && id > nextID {
			nextID = id
		}
	}
	candidates := map[string]int{}
	candidateCounts := map[int]int{}
	recoveryIDs := map[string]int{}
	for _, s := range c.monsters {
		if !s.identityOK {
			continue
		}
		reservedID, err := reservations.Match(Provider, s.id, sourceIdentity(s))
		if err != nil {
			return nil, err
		}
		id, ok := x.match(s, p)
		if ok && reservedID != 0 && id != 0 && id != reservedID {
			return nil, fmt.Errorf("reserved identity %s matched different local ID %d", s.id, id)
		}
		recoveryIDs[s.id] = reservedID
		if !ok {
			continue
		}
		candidates[s.id] = id
		if id != 0 {
			candidateCounts[id]++
		}
	}
	for _, s := range c.monsters {
		id, ok := candidates[s.id]
		if !ok {
			continue
		}
		if id != 0 {
			if candidateCounts[id] > 1 {
				p.issue("blocking", "multiple_source_matches", "monster", id, s.id, s.full, "identity", "多个源条目命中同一本地ID；全部拒绝映射")
				continue
			}
			mapped[s.id] = id
			matched[id] = true
			p.Stats.MatchedMonsters++
			continue
		}
		orphanConflict := false
		for key := range wiki {
			if normalizedDisplay(key) == normalizedDisplay(s.full) {
				orphanConflict = true
			}
		}
		if orphanConflict {
			p.issue("review", "new_monster_wiki_collision", "monster", 0, s.id, s.full, "identity", "已有未归属的同名Wiki资料，不能以新条目覆盖")
			continue
		}
		if (s.name == "烈焰狂战士" || s.name == "满月砣") && !reviewedAddition(s) {
			p.issue("review", "reviewed_addition_crosscheck_failed", "monster", 0, s.id, s.full, "identity", "已审核新增来源的ID、名称、编号或形态不一致；拒绝扩大白名单")
			continue
		}
		if !newIdentityProven(s, c, x, candidates) {
			p.issue("review", "new_identity_not_proven", "monster", 0, s.id, s.full, "identity", "同图鉴编号/明确形态存在本地不同名称且未由源中的另一独立身份交叉核实；可能是改名，暂不新增")
			continue
		}
		forms, formsOK := s.raw["forms"].([]any)
		if !reviewedAddition(s) && (s.form != "" || !formsOK || len(forms) != 0) {
			p.issue("review", "new_form_identity_not_proven", "monster", 0, s.id, s.full, "form_category", "新增候选具有形态或缺少明确空形态列表；主/变体归属尚未证明，不分配新ID")
			continue
		}
		if !completeNewMonster(s, c, typeMap) {
			p.issue("review", "incomplete_new_monster", "monster", 0, s.id, s.full, "identity", "唯一候选缺少完整资质/属性/特性/学习面，暂不分配本地ID")
			continue
		}
		id = recoveryIDs[s.id]
		if id == 0 {
			nextID++
			if nextID == 9001 {
				nextID++
			}
			id = nextID
		}
		if x.monsters[id] != nil {
			return nil, fmt.Errorf("recovery local ID %d is already occupied", id)
		}
		candidates[s.id] = id
		m := newMonster(id, s, typeMap)
		monsters = append(monsters, m)
		x.monsters[id] = m
		mapped[s.id] = id
		matched[id] = true
		newIDs[id] = true
		p.Stats.AddedMonsters++
		name := displayName(m)
		entry := object{"monster_id": id, "image": "", "skills": []any{}}
		wiki[name] = entry
		x.wikiByID[id] = entry
		x.wikiKey[id] = name
	}
	for _, s := range c.monsters {
		id := mapped[s.id]
		if id == 0 {
			continue
		}
		m := x.monsters[id]
		if !newIDs[id] {
			if err := p.migrateReviewedIdentity(s, x, wiki); err != nil {
				return nil, err
			}
			p.mergeMonster(m, s, typeMap)
		}
	}
	p.mergeRelationships(c, mapped, x, newIDs)
	// Correct each proven own table first; then process inheritance parent-first
	// so source/list order cannot cause unnecessary child detachment.
	p.mergeAllLearning(c, mapped, x, wiki, moveMap)
	for _, s := range c.monsters {
		id := mapped[s.id]
		if id == 0 {
			continue
		}
		m := x.monsters[id]
		name := displayName(m)
		p.addImage("monster", id, name, "monster", text(s.raw["img"]), text(m["image"]), s.id)
		p.addImage("wiki", id, name, "wiki", text(s.raw["img"]), text(x.wikiByID[id]["image"]), s.id)
		if s.valid["tn"] {
			traitName := text(s.raw["tn"])
			p.addImage("trait", id, traitName, "trait", text(c.images["_tm"][traitName]), text(asObject(m["trait"])["image"]), s.id)
		}
		if newIDs[id] {
			p.Changes = append(p.Changes, Change{"monster", id, name, "", nil, clone(m), "add"})
			p.Changes = append(p.Changes, Change{"wiki", id, name, "", nil, clone(x.wikiByID[id]), "add"})
		}
	}
	for _, v := range monsters {
		m := asObject(v)
		id := idOf(m)
		if !matched[id] && id != 9001 {
			p.Stats.PreservedLocalMonsters++
			p.issue("review", "local_only_monster", "monster", id, "", displayName(m), "identity", "未找到唯一可证的官方对应；完整保留本地")
		}
	}
	p.syncWiki(wiki, moveMap)
	for _, v := range types {
		m := asObject(v)
		n := zhString(m)
		p.addImage("type", idOf(m), n, "type", text(c.images["_em"][n]), text(m["image"]), "")
	}
	p.Files.Monsters, e = encodePreserving(local.Monsters, beforeM, monsters)
	if e != nil {
		return nil, e
	}
	p.Files.Moves, e = encodePreserving(local.Moves, beforeS, moves)
	if e != nil {
		return nil, e
	}
	p.Files.Wiki, e = encodePreserving(local.Wiki, beforeW, wiki)
	if e != nil {
		return nil, e
	}
	p.Files.Types = append([]byte(nil), local.Types...)
	for i := range p.Issues {
		if p.Issues[i].Entity == "monster" && p.Issues[i].ID == 0 {
			p.Issues[i].ID = mapped[p.Issues[i].SourceID]
		}
	}
	// Merge validation can mark a source move unavailable because of LOCAL
	// unknown types/name conflicts. Reparse only for immutable source evidence;
	// source baselines must not change when local context changes.
	observed, err := parseSource(source, &Proposal{})
	if err != nil {
		return nil, err
	}
	p.observeSource(observed, mapped, moveMap, x)
	return p, nil
}

// A name mismatch at the same dex/form may be a rename, not a new monster.
// New siblings are only safe when the old sibling has its own distinct,
// independently matched source detail in this same catalog.
func newIdentityProven(s *sourceMonster, c *catalog, x *localIndex, candidates map[string]int) bool {
	for id, m := range x.monsters {
		if id == 9001 {
			continue
		}
		dex, ok := integer(m["dex_number"])
		if !ok || dex != s.dex {
			continue
		}
		form, formOK := m["form"].(string)
		if !formOK || form == "" {
			return false
		}
		if NormalizeName(explicitLocalForm(m)) != NormalizeName(s.form) {
			continue
		}
		separate := false
		for _, other := range c.monsters {
			if other.id != s.id && other.identityOK && candidates[other.id] == id {
				separate = true
				break
			}
		}
		if !separate {
			return false
		}
	}
	return true
}

func completeNewMonster(s *sourceMonster, c *catalog, types map[string]object) bool {
	if !s.identityOK || !s.learnOK || len(s.skills) == 0 {
		return false
	}
	for _, key := range []string{"e", "e2", "s", "tn", "te"} {
		if !s.valid[key] {
			// Reviewed moon forms have an explicitly empty (not corrupt) stage.
			if raw, ok := s.raw[key].(string); key == "s" && ok && raw == "" && reviewedAddition(s) {
				continue
			}
			return false
		}
	}
	for _, pair := range statFields {
		if !s.valid[pair[0]] {
			return false
		}
	}
	if types[text(s.raw["e"])] == nil {
		return false
	}
	if sub := text(s.raw["e2"]); sub != "" && types[sub] == nil {
		return false
	}
	for _, ref := range s.skills {
		if move := c.moves[ref.key]; move == nil || !move.valid {
			return false
		}
	}
	// Evidence beyond a detail's own spelling: a main list row, or a named
	// forms/evo reference whose target has already passed cross-checking.
	if c.listed[s.id] {
		return true
	}
	for _, other := range c.monsters {
		if !other.identityOK {
			continue
		}
		for _, field := range []string{"evo", "forms"} {
			refs, _ := other.raw[field].([]any)
			for _, v := range refs {
				i, _ := integer(asObject(v)["i"])
				if strconv.Itoa(i) == s.id {
					return true
				}
			}
		}
	}
	return false
}
func stage(s *sourceMonster) string {
	if s.form == "首领形态" || confirmedMoon(s) {
		return "首领形态"
	}
	if !s.valid["s"] {
		return "未确认"
	}
	if text(s.raw["s"]) == "最终形态" {
		return "高级形态"
	}
	return "基础形态"
}
func newMonster(id int, s *sourceMonster, types map[string]object) object {
	form := s.form
	if form == "" || form == "首领形态" {
		form = "default"
	} else if form == "本来的样子" {
		form = "Original"
	}
	m := object{"id": id, "localized": object{"zh": object{"name": s.name}}, "dex_number": s.dex, "form": form, "form_category": "无多形态", "is_leader_form": s.form == "首领形态" || confirmedMoon(s), "evolution_members": []any{id}, "leader_of_id": nil, "evolution_stage": stage(s), "learnset_mode": "own", "image": "", "_source_ref": sourceRef(s)}
	for _, pair := range statFields {
		m[pair[1]] = s.raw[pair[0]]
	}
	m["evolves_from_id"] = nil // canonical unknown reference; never a guessed predecessor
	m["main_type"] = clone(types[text(s.raw["e"])])
	m["sub_type"] = nil
	if sub := text(s.raw["e2"]); sub != "" {
		m["sub_type"] = clone(types[sub])
	}
	m["trait"] = object{"localized": object{"zh": object{"name": s.raw["tn"], "description": s.raw["te"]}}}
	if reviewedAddition(s) && !s.valid["s"] {
		m["data_note"] = independentFormNote
	}
	// No guessed default bloodline type, attack style, family root, season,
	// leader potential, background, image filename, or levels. Complex additions
	// require an exact reviewed tuple and never gain an inferred parent.
	return m
}
func (p *Proposal) mergeMonster(m object, s *sourceMonster, types map[string]object) {
	id := idOf(m)
	name := displayName(m)
	p.set(m, "monster", id, name, "_source_ref", sourceRef(s))
	for _, pair := range statFields {
		if s.valid[pair[0]] {
			p.set(m, "monster", id, name, pair[1], s.raw[pair[0]])
		}
	}
	for _, pair := range [][2]string{{"e", "main_type"}, {"e2", "sub_type"}} {
		if !s.valid[pair[0]] {
			continue
		}
		n := text(s.raw[pair[0]])
		if n == "" && pair[0] == "e2" {
			p.set(m, "monster", id, name, pair[1], nil)
			continue
		}
		t := types[n]
		if t == nil {
			p.issue("review", "unknown_type", "monster", id, s.id, name, pair[1], "官方属性在本地types中不存在；不重造弱点抵抗")
			continue
		}
		if zhString(asObject(m[pair[1]])) != n {
			p.set(m, "monster", id, name, pair[1], t)
		}
	}
	if s.valid["tn"] {
		p.set(m, "monster", id, name, "trait.localized.zh.name", s.raw["tn"])
	}
	if s.valid["te"] {
		p.preserveTraitNotes(m, s)
		p.set(m, "monster", id, name, "trait.localized.zh.description", s.raw["te"])
	}
	if s.valid["s"] {
		value := stage(s)
		leader, _ := m["is_leader_form"].(bool)
		leaderOf, _ := integer(m["leader_of_id"])
		if leader || leaderOf != 0 {
			value = "首领形态"
		}
		p.set(m, "monster", id, name, "evolution_stage", value)
	}
	// General display spelling stays local-authoritative. Only the caller's
	// individually reviewed migrations may rename display/form and Wiki keys.
}
func (p *Proposal) addImage(entity string, id int, name, purpose, raw, existing, sourceID string) {
	if raw == "" {
		return
	}
	u, err := TrustedImageURL(raw, purpose)
	if err != nil {
		p.issue("warning", "untrusted_image", "image", id, sourceID, name, purpose, err.Error())
		return
	}
	p.Images = append(p.Images, ImageCandidate{entity, id, name, purpose, u, existing, sourceID})
}
