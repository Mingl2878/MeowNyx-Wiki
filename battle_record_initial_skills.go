package main

import (
	"errors"
	"sort"
)

// InitialSkills is explicit initial-loadout evidence, not observed executions or
// skills acquired by copying/exchange. Absence means unknown, never an empty set.
type BattleInitialSkills struct {
	SkillIDs []int `json:"skillIds"`
	Complete bool  `json:"complete"`
}

func battleInitialSkillsValid(s *BattleInitialSkills) error {
	if s == nil {
		return nil
	}
	if s.SkillIDs == nil || len(s.SkillIDs) > 4 {
		return errors.New("invalid initial skill loadout")
	}
	seen := map[int]bool{}
	for _, id := range s.SkillIDs {
		if id <= 0 || id > 1000000000 || seen[id] {
			return errors.New("invalid initial skill identity")
		}
		seen[id] = true
	}
	return nil
}
func battleInitialSkillsClone(s *BattleInitialSkills) *BattleInitialSkills {
	if s == nil {
		return nil
	}
	out := &BattleInitialSkills{SkillIDs: append([]int{}, s.SkillIDs...), Complete: s.Complete}
	sort.Ints(out.SkillIDs)
	return out
}
func battleMergeInitialSkills(a, b *BattleInitialSkills) (*BattleInitialSkills, error) {
	if err := battleInitialSkillsValid(a); err != nil {
		return nil, err
	}
	if err := battleInitialSkillsValid(b); err != nil {
		return nil, err
	}
	if a == nil {
		return battleInitialSkillsClone(b), nil
	}
	if b == nil {
		return battleInitialSkillsClone(a), nil
	}
	left, right := battleInitialSkillsClone(a), battleInitialSkillsClone(b)
	contains := func(full, subset []int) bool {
		have := map[int]bool{}
		for _, id := range full {
			have[id] = true
		}
		for _, id := range subset {
			if !have[id] {
				return false
			}
		}
		return true
	}
	if left.Complete {
		if !contains(left.SkillIDs, right.SkillIDs) || (right.Complete && !contains(right.SkillIDs, left.SkillIDs)) {
			return nil, errors.New("conflicting initial skill loadouts")
		}
		return left, nil
	}
	if right.Complete {
		if !contains(right.SkillIDs, left.SkillIDs) {
			return nil, errors.New("conflicting initial skill loadouts")
		}
		return right, nil
	}
	have := map[int]bool{}
	for _, id := range left.SkillIDs {
		have[id] = true
	}
	for _, id := range right.SkillIDs {
		if !have[id] {
			left.SkillIDs = append(left.SkillIDs, id)
			have[id] = true
		}
	}
	sort.Ints(left.SkillIDs)
	if err := battleInitialSkillsValid(left); err != nil {
		return nil, err
	}
	return left, nil
}
