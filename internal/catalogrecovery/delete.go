package catalogrecovery

import (
	"encoding/json"
	"fmt"
	"sort"

	"xhmwiki/internal/catalog"
)

type DeletionReport struct {
	Removed          []Reservation `json:"removed"`
	DetachedLearning []int         `json:"detached_learning"`
	CleanedRelations []int         `json:"cleaned_relations"`
	MonstersBefore   int           `json:"monsters_before"`
	MonstersAfter    int           `json:"monsters_after"`
}

// DeleteMonsters clones its input and removes only the explicitly named monster
// records and learnsets. All other tables, source baselines and policy metadata
// remain intact. This has no I/O and is never invoked automatically at startup.
func DeleteMonsters(c *catalog.Catalog, names []string) (*catalog.Catalog, *DeletionReport, error) {
	if len(names) == 0 {
		return nil, nil, fmt.Errorf("explicit monster names required")
	}
	if err := Validate(c); err != nil {
		return nil, nil, err
	}
	raw, err := catalog.Marshal(c)
	if err != nil {
		return nil, nil, err
	}
	out, err := catalog.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	reservations, err := Read(out)
	if err != nil {
		return nil, nil, err
	}
	report := &DeletionReport{Removed: []Reservation{}, DetachedLearning: []int{}, CleanedRelations: []int{}, MonstersBefore: len(out.Monsters)}
	remove := map[int]bool{}
	seen := map[string]bool{}
	for _, name := range names {
		if name == "" || seen[name] {
			return nil, nil, fmt.Errorf("blank or duplicate deletion name %q", name)
		}
		seen[name] = true
		matches := []catalog.Monster{}
		for _, m := range out.Monsters {
			if m.Name == name {
				matches = append(matches, m)
			}
		}
		if len(matches) != 1 {
			return nil, nil, fmt.Errorf("deletion name %q must identify exactly one existing monster (got %d)", name, len(matches))
		}
		m := matches[0]
		if m.ID == 9001 || m.SourceRef == nil || m.SourceRef.Provider != Provider {
			return nil, nil, fmt.Errorf("monster %d has no recoverable official identity", m.ID)
		}
		e := Reservation{LocalID: m.ID, Provider: m.SourceRef.Provider, SourceID: m.SourceRef.ID, Identity: m.SourceRef.Identity}
		id, err := reservations.Match(e.Provider, e.SourceID, e.Identity)
		if err != nil || id != 0 && id != m.ID {
			return nil, nil, fmt.Errorf("monster %d reservation conflicts: %v", m.ID, err)
		}
		if id == 0 {
			reservations.Entries = append(reservations.Entries, e)
		}
		remove[m.ID] = true
		report.Removed = append(report.Removed, e)
	}

	// Resolve inherited surfaces BEFORE deleting parents. Stale stored rows on
	// inherit records are not their effective learning. Keep descendants of a
	// surviving detached child inherited from that child, without flattening them.
	learnsets := map[int]*catalog.Learnset{}
	for i := range out.Learnsets {
		learnsets[out.Learnsets[i].MonsterID] = &out.Learnsets[i]
	}
	for i := range out.Learnsets {
		l := &out.Learnsets[i]
		if remove[l.MonsterID] || l.Mode != "inherit" || !remove[l.FromID] {
			continue
		}
		root := l
		for root.Mode == "inherit" {
			root = learnsets[root.FromID] // catalog validation proved a complete acyclic graph
		}
		l.Mode, l.FromID = "own", 0
		l.Skills = append([]catalog.LearnedSkill{}, root.Skills...)
		for _, key := range []string{"legacy_skills", "legacy_skill_omit"} {
			delete(l.Extensions, key)
			if value, ok := root.Extensions[key]; ok {
				if l.Extensions == nil {
					l.Extensions = catalog.Extensions{}
				}
				l.Extensions[key] = append(json.RawMessage(nil), value...)
			}
		}
		report.DetachedLearning = append(report.DetachedLearning, l.MonsterID)
	}
	monsters := make([]catalog.Monster, 0, len(out.Monsters)-len(remove))
	for _, m := range out.Monsters {
		if remove[m.ID] {
			continue
		}
		if remove[m.MainFormID] {
			// Choosing a new main form or changing form classification is not a
			// dangling-reference cleanup. Require a separately reviewed operation.
			return nil, nil, fmt.Errorf("surviving variant %d depends on deleted main form %d", m.ID, m.MainFormID)
		}
		changed := false
		members := make([]int, 0, len(m.EvolutionMembers))
		for _, id := range m.EvolutionMembers {
			if !remove[id] {
				members = append(members, id)
			} else {
				changed = true
			}
		}
		if changed {
			m.EvolutionMembers = members
		}
		if remove[m.EvolvesFromID] {
			m.EvolvesFromID = 0
			m.EvolutionChainName = ""
			changed = true
		}
		if remove[m.LeaderOfID] {
			m.LeaderOfID = 0
			changed = true
		}
		if changed {
			report.CleanedRelations = append(report.CleanedRelations, m.ID)
		}
		monsters = append(monsters, m)
	}
	out.Monsters = monsters
	remaining := make([]catalog.Learnset, 0, len(out.Learnsets)-len(remove))
	for _, l := range out.Learnsets {
		if !remove[l.MonsterID] {
			remaining = append(remaining, l)
		}
	}
	out.Learnsets = remaining
	sort.Slice(reservations.Entries, func(i, j int) bool { return reservations.Entries[i].LocalID < reservations.Entries[j].LocalID })
	raw, err = json.Marshal(reservations)
	if err != nil {
		return nil, nil, err
	}
	if out.Extensions == nil {
		out.Extensions = catalog.Extensions{}
	}
	out.Extensions[Extension] = raw
	if err := Validate(out); err != nil {
		return nil, nil, err
	}
	if err := catalog.Validate(out); err != nil {
		return nil, nil, err
	}
	report.MonstersAfter = len(out.Monsters)
	return out, report, nil
}
