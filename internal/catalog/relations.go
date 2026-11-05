package catalog

import "fmt"

// initializeEvolutionMembers is a migration boundary, not a runtime family API.
// Only a wholly old input may take a snapshot of the old parent graph. Mixed
// legacy edits get a minimal default on missing rows; explicit v2 rows (even [])
// are never rebuilt, completed, symmetrized, or reordered.
func initializeEvolutionMembers(c *Catalog, oldGraph bool) error {
	if !oldGraph {
		for i := range c.Monsters {
			m := &c.Monsters[i]
			if m.EvolutionMembers == nil {
				m.EvolutionMembers = []int{m.ID}
				if m.EvolvesFromID != 0 && m.EvolvesFromID != m.ID {
					m.EvolutionMembers = append(m.EvolutionMembers, m.EvolvesFromID)
				}
			}
		}
		return nil
	}
	byID := map[int]*Monster{}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		if !validID(m.ID) || byID[m.ID] != nil {
			return fmt.Errorf("invalid/duplicate monster ID %d during v1 migration", m.ID)
		}
		byID[m.ID] = m
	}
	roots, state := map[int]int{}, map[int]uint8{}
	var root func(int) (int, error)
	root = func(id int) (int, error) {
		m := byID[id]
		if m == nil {
			return 0, fmt.Errorf("v1 evolution references missing monster %d", id)
		}
		if state[id] == 1 {
			return 0, fmt.Errorf("v1 evolution cycle at monster %d", id)
		}
		if state[id] == 2 {
			return roots[id], nil
		}
		state[id] = 1
		r := id
		if m.EvolvesFromID != 0 {
			var err error
			r, err = root(m.EvolvesFromID)
			if err != nil {
				return 0, err
			}
		}
		state[id], roots[id] = 2, r
		return r, nil
	}
	groups := map[int][]int{}
	for _, m := range c.Monsters {
		r, err := root(m.ID)
		if err != nil {
			return err
		}
		groups[r] = append(groups[r], m.ID)
	}
	for i := range c.Monsters {
		m := &c.Monsters[i]
		if m.EvolutionMembers == nil {
			m.EvolutionMembers = append([]int{}, groups[roots[m.ID]]...)
		}
	}
	return nil
}
