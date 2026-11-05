package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"

	"xhmwiki/internal/catalog"
)

// The shipped resource is also embedded: rules are available in a clean install,
// not only on the developer's machine or after a write-on-first-read migration.
//
//go:embed data/default-battle-rules.json
var battleDefaultRulesJSON []byte

const battleRuleSemanticsVersion = "explicit-ordinary-leader-families-and-or-v1"

// Immutable, private query view. Reads normalize equivalent conditions but keep
// detached source inputs for CAS and review. Main-form relationships and evolution_members are NOT edges:
// the former joins distinct regional branches, the latter is a display adjacency
// list that does not prove an ordinary evolution arrow.
type battleRuleFamilyMatch struct {
	revision string
	required []map[int]bool
	excluded map[int]bool
	core     map[int]bool
	source   *BattleTeamRule
}

func defaultBattleRules() ([]BattleTeamRule, error) {
	var rules []BattleTeamRule
	if json.Unmarshal(battleDefaultRulesJSON, &rules) != nil {
		return nil, errBattleSchema
	}
	out, err := normalizeBattleRules(rules)
	if err != nil {
		return nil, errBattleSchema
	}
	return out, nil
}

// battlePrepareRuleFamilies consumes only the supplied current catalog snapshot.
// No I/O/global catalog fallback, no catalog writes, no names/dex/source guessing.
// Unknown local IDs are deliberately valid and match themselves for compatibility.
func battlePrepareRuleFamilies(rules []BattleTeamRule, data []byte) ([]BattleTeamRule, error) {
	out := battleArchetypeRules(rules)
	if len(data) == 0 {
		index := battleBuildRuleFamilyIndex(nil)
		index.revision = ""
		return battleCompileRulesWithIndex(out, index), nil
	}
	if len(data) > 64<<20 {
		return nil, errBattleMapping
	}
	value, err := battleSharedCatalogDomain(data, "explicit-battle-rule-family-index-v1", func(c *catalog.Catalog, _ string) (any, error) {
		return battleBuildRuleFamilyIndex(c.Monsters), nil
	})
	if err != nil {
		return nil, errBattleMapping
	}
	return battleCompileRulesWithIndex(out, value.(*battleRuleFamilyIndex)), nil
}

type battleRuleFamilyIndex struct {
	revision string
	family   func(int) map[int]bool
	key      func(int) int
	prefer   func(int, int) int
}

func battleCompileRuleFamilies(rules []BattleTeamRule, monsters []catalog.Monster) []BattleTeamRule {
	return battleCompileRulesWithIndex(rules, battleBuildRuleFamilyIndex(monsters))
}

func battleBuildRuleFamilyIndex(monsters []catalog.Monster) *battleRuleFamilyIndex {
	adj := map[int][]int{}
	type relation struct{ ID, EvolvesFromID, LeaderOfID int }
	relations := make([]relation, 0, len(monsters))
	for _, m := range monsters {
		adj[m.ID] = nil
		relations = append(relations, relation{m.ID, m.EvolvesFromID, m.LeaderOfID})
	}
	for _, m := range monsters {
		for _, parent := range []int{m.EvolvesFromID, m.LeaderOfID} {
			if _, exists := adj[parent]; parent > 0 && exists {
				adj[m.ID] = append(adj[m.ID], parent)
				adj[parent] = append(adj[parent], m.ID)
			}
		}
	}
	sort.Slice(relations, func(i, j int) bool { return relations[i].ID < relations[j].ID })
	encoded, _ := json.Marshal(relations)
	revision := fmt.Sprintf("%x", sha256.Sum256(encoded))
	families := map[int]map[int]bool{}
	family := func(seed int) map[int]bool {
		if found := families[seed]; found != nil {
			return found
		}
		if _, known := adj[seed]; !known {
			return map[int]bool{seed: true}
		}
		members := map[int]bool{seed: true}
		queue := []int{seed}
		for i := 0; i < len(queue); i++ {
			for _, next := range adj[queue[i]] {
				if !members[next] {
					members[next] = true
					queue = append(queue, next)
				}
			}
		}
		for id := range members {
			families[id] = members
		}
		return members
	}
	parents := map[int][]int{}
	children := map[int]bool{}
	for _, m := range monsters {
		for _, parent := range []int{m.EvolvesFromID, m.LeaderOfID} {
			if _, exists := adj[parent]; parent > 0 && exists {
				parents[m.ID] = append(parents[m.ID], parent)
				children[parent] = true
			}
		}
	}
	depths := map[int]int{}
	var depth func(int, map[int]bool) int
	depth = func(id int, active map[int]bool) int {
		if _, known := adj[id]; !known {
			return 0
		}
		if d, ok := depths[id]; ok {
			return d
		}
		if active[id] {
			return 0
		}
		active[id] = true
		d := 0
		for _, parent := range parents[id] {
			if next := depth(parent, active) + 1; next > d {
				d = next
			}
		}
		delete(active, id)
		depths[id] = d
		return d
	}
	key := func(id int) int {
		least := id
		for member := range family(id) {
			if member < least {
				least = member
			}
		}
		return least
	}
	prefer := func(a, b int) int {
		if children[a] != children[b] {
			if !children[a] {
				return a
			}
			return b
		}
		da, db := depth(a, map[int]bool{}), depth(b, map[int]bool{})
		if da > db || da == db && a < b {
			return a
		}
		return b
	}
	// Populate every known component/depth before publishing. Later queries,
	// including unknown stable IDs, never mutate the shared domain index.
	for id := range adj {
		family(id)
		depth(id, map[int]bool{})
	}
	return &battleRuleFamilyIndex{revision: revision, family: family, key: key, prefer: prefer}
}

func battleCompileRulesWithIndex(rules []BattleTeamRule, index *battleRuleFamilyIndex) []BattleTeamRule {
	out := battleArchetypeRules(battleRuleSourceInputs(rules))
	for i := range out {
		rule := &out[i]
		source := battleRuleSourceInputs([]BattleTeamRule{*rule})[0]
		*rule = battleNormalizeFamilyConditions(*rule, index.key, index.prefer)
		view := &battleRuleFamilyMatch{revision: index.revision, source: &source, required: []map[int]bool{}, excluded: map[int]bool{}, core: map[int]bool{}}
		for _, id := range rule.MonsterIDs {
			members := map[int]bool{}
			for member := range index.family(id) {
				members[member] = true
			}
			view.required = append(view.required, members)
			for member := range members {
				view.core[member] = true
			}
		}
		for _, group := range rule.AnyOf {
			union := map[int]bool{}
			for _, id := range group {
				for member := range index.family(id) {
					union[member] = true
					view.core[member] = true
				}
			}
			view.required = append(view.required, union)
		}
		for _, id := range rule.ExcludedMonsterIDs {
			for member := range index.family(id) {
				view.excluded[member] = true
			}
		}
		rule.familyMatch = view
	}
	return out
}

// Source inputs are never aliased to normalized views. HTTP may expose these as
// sourceRules so a read-only cleanup is reviewable without rewriting saved rules.
func battleRuleSourceInputs(rules []BattleTeamRule) []BattleTeamRule {
	out := make([]BattleTeamRule, 0, len(rules))
	for _, rule := range rules {
		if rule.familyMatch != nil && rule.familyMatch.source != nil {
			rule = *rule.familyMatch.source
		}
		rule.MonsterIDs = append([]int{}, rule.MonsterIDs...)
		rule.ExcludedMonsterIDs = append([]int{}, rule.ExcludedMonsterIDs...)
		rule.AnyOf = battleCloneRuleGroups(rule.AnyOf)
		rule.familyMatch = nil
		out = append(out, rule)
	}
	return out
}

// Collapse only logically equivalent family predicates. OR alternatives remain
// separate positions; one-family OR becomes required. Exclusions stay exclusions.
func battleNormalizeFamilyConditions(rule BattleTeamRule, key func(int) int, prefer func(int, int) int) BattleTeamRule {
	original := battleRuleSourceInputs([]BattleTeamRule{rule})[0]
	collapse := func(ids []int) []int {
		out := []int{}
		positions := map[int]int{}
		for _, id := range ids {
			k := key(id)
			if pos, exists := positions[k]; exists {
				out[pos] = prefer(out[pos], id)
			} else {
				positions[k] = len(out)
				out = append(out, id)
			}
		}
		return out
	}
	required := append([]int{}, rule.MonsterIDs...)
	groups := [][]int{}
	for _, group := range rule.AnyOf {
		group = collapse(group)
		if len(group) == 1 {
			required = append(required, group[0])
		} else {
			groups = append(groups, group)
		}
	}
	rule.MonsterIDs = collapse(required)
	rule.ExcludedMonsterIDs = collapse(rule.ExcludedMonsterIDs)
	rule.AnyOf = nil
	included := map[int]bool{}
	for _, id := range rule.MonsterIDs {
		included[key(id)] = true
	}
	seenGroups := map[string]int{}
	for _, group := range groups {
		satisfied := false
		keys := make([]int, 0, len(group))
		for _, id := range group {
			k := key(id)
			keys = append(keys, k)
			satisfied = satisfied || included[k]
		}
		if satisfied {
			continue
		}
		sort.Ints(keys)
		encoded, _ := json.Marshal(keys)
		if position, exists := seenGroups[string(encoded)]; exists {
			// Equivalent repeated AND clauses share one position, but all their
			// explicitly selected representatives participate in the preference.
			for i, id := range rule.AnyOf[position] {
				for _, other := range group {
					if key(id) == key(other) {
						rule.AnyOf[position][i] = prefer(id, other)
					}
				}
			}
		} else {
			seenGroups[string(encoded)] = len(rule.AnyOf)
			rule.AnyOf = append(rule.AnyOf, group)
		}
	}
	// Preserve the established per-field budget. A formerly valid 24-core plus
	// 24-singleton-OR predicate must not normalize to an invalid 48-core DTO.
	// Keep its original representation; the private matcher still has all clauses.
	if len(rule.MonsterIDs) > 24 {
		return original
	}
	// An originally impossible predicate must not become a dropped rule or a
	// newly invalid save DTO because an OR was promoted across an exclusion.
	for _, a := range rule.MonsterIDs {
		for _, b := range rule.ExcludedMonsterIDs {
			if a == b {
				return original
			}
		}
	}
	return rule
}

func battleRuleMatches(rule BattleTeamRule, have map[int]bool) bool {
	if view := rule.familyMatch; view != nil {
		for id := range have {
			if view.excluded[id] {
				return false
			}
		}
		for _, alternatives := range view.required {
			found := false
			for id := range have {
				if alternatives[id] {
					found = true
					break
				}
			}
			if !found {
				return false
			}
		}
		return true
	}
	for _, id := range rule.MonsterIDs {
		if !have[id] {
			return false
		}
	}
	for _, id := range rule.ExcludedMonsterIDs {
		if have[id] {
			return false
		}
	}
	for _, group := range rule.AnyOf {
		found := false
		for _, id := range group {
			if have[id] {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func battleRuleCore(rule BattleTeamRule) map[int]bool {
	if rule.familyMatch != nil {
		return rule.familyMatch.core
	}
	out := map[int]bool{}
	for _, id := range rule.MonsterIDs {
		out[id] = true
	}
	for _, group := range rule.AnyOf {
		for _, id := range group {
			out[id] = true
		}
	}
	return out
}

func battleCloneRuleGroups(groups [][]int) [][]int {
	if groups == nil {
		return nil
	}
	out := make([][]int, len(groups))
	for i := range groups {
		out[i] = append([]int{}, groups[i]...)
	}
	return out
}
