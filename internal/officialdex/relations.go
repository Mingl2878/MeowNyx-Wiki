package officialdex

import "strconv"

// Individually confirmed local/source pairs, not a rule based on list position.
// The first fourteen entries are the reviewed candidates; the last four repair
// the old reversed ordinary chains. Source membership still wins for ordinary
// edges. Source/local mapping must establish BOTH stable identities first.
type reviewedRelation struct {
	id, parent                                     int
	source, parentSource, identity, parentIdentity string
	leader                                         bool
}

var reviewedRelations = []reviewedRelation{
	{123, 122, "123", "121", "NO.056|幽冥眼|睁眼的样子", "NO.055|暗影灵面|睁眼的样子", false},
	{124, 121, "124", "122", "NO.056|幽冥眼|闭眼的样子", "NO.055|暗影灵面|闭眼的样子", false},
	{371, 367, "372", "368", "NO.236|圣代甜甜|蓝莓巧克力口味", "NO.235|香草甜甜|蓝莓饰品", false},
	{372, 367, "373", "368", "NO.236|圣代甜甜|蓝莓草莓口味", "NO.235|香草甜甜|蓝莓饰品", false},
	{373, 367, "374", "368", "NO.236|圣代甜甜|蓝莓抹茶口味", "NO.235|香草甜甜|蓝莓饰品", false},
	{374, 366, "375", "367", "NO.236|圣代甜甜|杨桃巧克力口味", "NO.235|香草甜甜|杨桃饰品", false},
	{375, 366, "376", "367", "NO.236|圣代甜甜|杨桃草莓口味", "NO.235|香草甜甜|杨桃饰品", false},
	{376, 366, "377", "367", "NO.236|圣代甜甜|杨桃抹茶口味", "NO.235|香草甜甜|杨桃饰品", false},
	{166, 164, "166", "164", "NO.078|千棘海针|磨损的样子", "NO.078|千棘盔|磨损的样子", true},
	{198, 199, "199", "198", "NO.107|深渊罗隐|首领形态", "NO.107|罗隐|", true},
	{330, 331, "331", "330", "NO.206|风暴酷拉|首领形态", "NO.206|酷拉|", true},
	{362, 363, "364", "363", "NO.233|高帽鹬者|首领形态", "NO.233|高脚鹬|", true},
	{437, 438, "441", "440", "NO.288|淤泥乌泽|首领形态", "NO.288|泥吼牙|", true},
	{480, 479, "483", "482", "NO.329|暗夜颅主|首领形态", "NO.329|夜枭|", true},
	{199, 197, "198", "197", "NO.107|罗隐|", "NO.106|阿米樱|", false},
	{331, 329, "330", "329", "NO.206|酷拉|", "NO.205|拉特|", false},
	{363, 361, "363", "362", "NO.233|高脚鹬|", "NO.232|鄙目鹬|", false},
	{438, 436, "440", "439", "NO.288|泥吼牙|", "NO.287|吸泥鸥|", false},
}

func confirmedMoon(s *sourceMonster) bool {
	return reviewedAddition(s) && s.name == "满月砣"
}

func (p *Proposal) mergeRelationships(c *catalog, mapped map[string]int, x *localIndex, newIDs map[int]bool) {
	byLocal := map[int]*sourceMonster{}
	for _, s := range c.monsters {
		if id := mapped[s.id]; id != 0 {
			byLocal[id] = s
		}
	}
	// Work on independent rows until all ordinary/leader graph checks complete.
	proposed := map[int]object{}
	confirmedEvidence := map[int]bool{}
	for _, id := range sortedMonsterIDs(x) {
		proposed[id] = clone(x.monsters[id]).(map[string]any)
	}
	for _, s := range c.monsters {
		id := mapped[s.id]
		if id == 0 {
			continue
		}
		m := proposed[id]
		prior, _ := integer(m["evolves_from_id"])
		candidate := prior
		confirmedLeader := false
		for _, r := range reviewedRelations {
			parent := byLocal[r.parent]
			if id == r.id && s.id == r.source && mapped[r.parentSource] == r.parent && parent != nil && sourceIdentity(s) == r.identity && sourceIdentity(parent) == r.parentIdentity {
				candidate, confirmedLeader = r.parent, r.leader
				break
			}
		}
		leader, _ := m["is_leader_form"].(bool)
		leader = leader || s.form == "首领形态" || confirmedMoon(s) || confirmedLeader
		leaderParent, _ := integer(m["leader_of_id"])
		// Explicit reviewed additions are cross-name leader forms. Moon roles are
		// user-confirmed even though the source has an empty stage string.
		explicitParent := 0
		if reviewedAddition(s) {
			parentSource := map[string]string{"344": "343", "382": "380", "383": "381"}[s.id]
			parentID := map[string]int{"344": 343, "382": 379, "383": 380}[s.id]
			childID := map[string]int{"344": 620, "382": 621, "383": 622}[s.id]
			parentIdentity := map[string]string{"344": "NO.218|烈火守护|", "382": "NO.238|月亮砣|上弦的样子", "383": "NO.238|月亮砣|下弦的样子"}[s.id]
			parent := byLocal[parentID]
			if (id == childID || newIDs[id]) && mapped[parentSource] == parentID && parent != nil && sourceIdentity(parent) == parentIdentity {
				explicitParent = parentID
				confirmedLeader = confirmedMoon(s) // flame still needs source forms on first registration
			}
		}
		if explicitParent != 0 {
			candidate = explicitParent
		}
		parent := byLocal[candidate]
		// No arbitrary same-dex search: only a reviewed candidate, already stored
		// ordinary parent, or the exact reviewed addition pair may be considered.
		// Its role and dex must agree; forms are required unless this exact
		// source/local identity pair has independent human confirmation.
		if leader && candidate != 0 && candidate != id && parent != nil && parent.dex == s.dex &&
			!isLeader(proposed[candidate], parent) && (confirmedLeader || formsConnect(s, parent)) {
			leaderParent = candidate
			confirmedEvidence[id] = confirmedLeader
			m["leader_of_id"] = candidate
			m["is_leader_form"], m["evolution_stage"] = true, "首领形态"
			m["evolves_from_id"] = nil // clear BEFORE any reversed ordinary repair
			prior, candidate = 0, 0
		}
		if confirmedMoon(s) {
			m["is_leader_form"], m["evolution_stage"] = true, "首领形态"
			if text(m["data_note"]) == independentFormNote {
				m["data_note"] = confirmedLeaderNote
			}
		}
		if leaderParent != 0 {
			// A known leader relation is never also an ordinary predecessor, and
			// a missing future source stage cannot undo its confirmed role.
			m["is_leader_form"], m["evolution_stage"] = true, "首领形态"
			m["evolves_from_id"] = nil
			candidate = 0
		}
		members, ok := mappedMembers(s, mapped)
		if !ok {
			if s.valid["evo"] {
				p.issue("warning", "source_relationship_unavailable", "monster", id, s.id, displayName(m), "evolution_members", "官方成员未能完整映射到本地身份；没有可用源候选，保留本地成员与普通前置")
			}
			continue
		}
		m["evolution_members"] = members
		allowed := false
		for _, v := range members {
			n, _ := integer(v)
			allowed = allowed || n == candidate
		}
		if candidate > 0 && candidate != id && allowed && x.monsters[candidate] != nil && !leader {
			m["evolves_from_id"] = candidate
		} else if prior != 0 || candidate != 0 {
			m["evolves_from_id"] = nil
		}
	}
	// Individual confirmed repairs are normally acyclic. Corrupt/future source
	// combinations must nevertheless disable the affected source candidates,
	// never create an invalid proposal. Existing local relationships stay intact.
	for _, field := range []string{"evolves_from_id", "leader_of_id", "relationships"} {
		for {
			cycle := relationCycle(proposed, field)
			if len(cycle) == 0 {
				break
			}
			changed := false
			for _, id := range cycle {
				if !equal(proposed[id], x.monsters[id]) {
					proposed[id] = clone(x.monsters[id]).(map[string]any)
					s := byLocal[id]
					sid := ""
					if s != nil {
						sid = s.id
					}
					p.issue("warning", "source_relationship_cycle", "monster", id, sid, displayName(proposed[id]), "evolution_members", "关系候选将形成循环；没有可用源关系候选，保留该条目本地关系")
					changed = true
				}
			}
			if !changed {
				break
			} // existing invalid legacy graphs are caller validation errors
		}
	}
	for _, id := range sortedMonsterIDs(x) {
		m, desired := x.monsters[id], proposed[id]
		leaderID, _ := integer(desired["leader_of_id"])
		if confirmedEvidence[id] && leaderID != 0 {
			for i := range p.Issues {
				issue := &p.Issues[i]
				if issue.SourceID == byLocal[id].id && issue.Code == "source_relationship_unavailable" && issue.Field == "leader_of_id" {
					issue.Code, issue.Field = "confirmed_leader_source_incomplete", "forms"
					issue.Message = "官方forms不可用；此关系由已核验双方身份的用户明示登记支持，不据此推断其他首领"
				}
			}
		}
		if s := byLocal[id]; s != nil && confirmedMoon(s) && text(desired["evolution_stage"]) == "首领形态" {
			for i := range p.Issues {
				issue := &p.Issues[i]
				if issue.SourceID == s.id && issue.Field == "s" && (issue.Code == "stage_source_incomplete" || issue.Code == "invalid_field" || issue.Code == "unknown_stage") {
					issue.Code, issue.Field = "confirmed_leader_stage_source_incomplete", "source_stage"
					issue.Message = "官方阶段本身未提供可用值；此首领阶段由已核验身份的用户明确确认支持，不宣称来自源s值"
				}
			}
		}
		for _, field := range []string{"evolution_members", "evolves_from_id", "leader_of_id", "is_leader_form", "evolution_stage", "data_note"} {
			if value, exists := desired[field]; exists {
				if newIDs[id] {
					m[field] = value
				} else {
					p.set(m, "monster", id, displayName(m), field, value)
				}
			}
		}
	}
}

const confirmedLeaderNote = "已确认对应月亮砣的首领化；保留独立记录、图片及学习面，首领化来源单独登记，不作为普通进化前置。"

func isLeader(m object, s *sourceMonster) bool {
	leader, _ := m["is_leader_form"].(bool)
	return leader || s.form == "首领形态" || confirmedMoon(s)
}
func formsConnect(a, b *sourceMonster) bool {
	if a == nil || b == nil || !a.valid["forms"] || !b.valid["forms"] {
		return false
	}
	for _, pair := range [][2]*sourceMonster{{a, b}, {b, a}} {
		refs, _ := pair[0].raw["forms"].([]any)
		for _, ref := range refs {
			id, _ := integer(asObject(ref)["i"])
			if strconv.Itoa(id) == pair[1].id {
				return true
			}
		}
	}
	return false
}
func mappedMembers(s *sourceMonster, mapped map[string]int) ([]any, bool) {
	if !s.valid["evo"] {
		return nil, false
	}
	refs, _ := s.raw["evo"].([]any)
	members, seen := []any{}, map[int]bool{}
	for _, value := range refs {
		ref, _ := integer(asObject(value)["i"])
		id := mapped[strconv.Itoa(ref)]
		if id == 0 || seen[id] {
			return nil, false
		}
		seen[id] = true
		members = append(members, id)
	}
	return members, true
}
func relationCycle(rows map[int]object, field string) []int {
	state := map[int]int{}
	var stack []int
	var visit func(int) []int
	visit = func(id int) []int {
		if id == 0 || rows[id] == nil || state[id] == 2 {
			return nil
		}
		if state[id] == 1 {
			for i, n := range stack {
				if n == id {
					return append([]int{}, stack[i:]...)
				}
			}
		}
		state[id] = 1
		stack = append(stack, id)
		next, _ := integer(rows[id][field])
		if field == "relationships" {
			next, _ = integer(rows[id]["leader_of_id"])
			if next == 0 {
				next, _ = integer(rows[id]["evolves_from_id"])
			}
		}
		if cycle := visit(next); len(cycle) > 0 {
			return cycle
		}
		stack = stack[:len(stack)-1]
		state[id] = 2
		return nil
	}
	// Sorted source-local order makes cycle warnings reproducible.
	for _, id := range sortedRelationIDs(rows) {
		if cycle := visit(id); len(cycle) > 0 {
			return cycle
		}
	}
	return nil
}
func sortedRelationIDs(rows map[int]object) []int {
	return sortedMonsterIDs(&localIndex{monsters: rows})
}
