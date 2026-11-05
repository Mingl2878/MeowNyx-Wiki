package main

import (
	"encoding/json"
	"errors"
)

var errBattleLiveMerge = errors.New("conflicting live battle event complement")

// battleMergeLiveEvent is intentionally NOT the general event merger. The caller
// must gate it on BOTH enclosing records having Source == rkpp-live-v1. Normalized
// legacy imports retain battleMergeEvent's strict immutable-core comparison.
// Only absent observations are complemented; a measured zero is a known amount.
func battleMergeLiveEvent(a, b BattleEvent) (BattleEvent, error) {
	if a.ID != b.ID || a.Kind != b.Kind || a.Phase != b.Phase || a.Round != b.Round || a.Seq != b.Seq || a.ProtocolSkillID != b.ProtocolSkillID {
		return BattleEvent{}, errBattleLiveMerge
	}
	if !battleLiveMergeSchema(a) || !battleLiveMergeSchema(b) {
		return BattleEvent{}, errBattleLiveMerge
	}
	// Clone the complete typed schema, not only fields being filled. Delegated
	// mergers and returned pointers must never alias either input's nested state.
	clone := func(e BattleEvent) (BattleEvent, error) {
		data, err := json.Marshal(e)
		if err != nil {
			return BattleEvent{}, errBattleLiveMerge
		}
		var out BattleEvent
		if err = json.Unmarshal(data, &out); err != nil {
			return BattleEvent{}, errBattleLiveMerge
		}
		return out, nil
	}
	var err error
	a, err = clone(a)
	if err != nil {
		return BattleEvent{}, err
	}
	b, err = clone(b)
	if err != nil {
		return BattleEvent{}, err
	}
	align := func(left, right *string, side bool) error {
		unknown := func(v string) bool { return v == "" || side && v == "unknown" }
		if unknown(*left) && !unknown(*right) {
			*left = *right
		}
		if unknown(*right) && !unknown(*left) {
			*right = *left
		}
		if unknown(*left) && unknown(*right) {
			value := ""
			if side && (*left == "unknown" || *right == "unknown") {
				value = "unknown"
			}
			*left, *right = value, value
		}
		if *left != *right {
			return errBattleLiveMerge
		}
		return nil
	}
	for _, p := range []struct {
		a, b *string
		side bool
	}{{&a.Actor, &b.Actor, false}, {&a.Target, &b.Target, false}, {&a.Side, &b.Side, true}, {&a.TargetSide, &b.TargetSide, true}, {&a.ProtocolSkillConfigID, &b.ProtocolSkillConfigID, false}} {
		if err = align(p.a, p.b, p.side); err != nil {
			return BattleEvent{}, err
		}
	}
	if a.Amount == nil != (b.Amount == nil) {
		if !battleOneOf(a.Kind, "damage", "heal") {
			return BattleEvent{}, errBattleLiveMerge
		}
		value := a.Amount
		if value == nil {
			value = b.Amount
		}
		left, right := *value, *value
		a.Amount, b.Amount = &left, &right
	}
	// Strict merger still owns known amount conflicts, execution indices, skill
	// mapping, form/growth/HP/energy/combat evidence, labels and every other field.
	out, err := battleMergeEvent(a, b)
	if err != nil {
		return BattleEvent{}, errBattleLiveMerge
	}
	return out, nil
}
func battleLiveMergeSchema(e BattleEvent) bool {
	if !battleID(e.ID, true) || !battleID(e.Actor, false) || !battleID(e.Target, false) || !battleID(e.ProtocolSkillID, false) || !battleBaseID(e.ProtocolSkillConfigID, false) || e.ProtocolSkillConfigID != "" && e.ProtocolSkillID == "" {
		return false
	}
	if e.Round < 0 || e.Round > 1000000 || e.Seq < 0 || e.Seq > 1000000000 || e.SkillID < 0 || e.SkillID > 1000000000 {
		return false
	}
	if !battleOneOf(e.Kind, "skill", "damage", "switch", "effect", "growth", "heal", "weather", "note", "order", "form", "resource") || !battleOneOf(e.Phase, "executed", "preview", "selection", "unknown", "interrupted") || !battleOneOf(e.Side, "", "me", "enemy", "unknown") || !battleOneOf(e.TargetSide, "", "me", "enemy", "unknown") {
		return false
	}
	if e.Amount != nil && !battleFinite(*e.Amount, 0, 1e12) {
		return false
	}
	if battleValidateActionFields(&e) != nil || battleValidateStateFields(&e) != nil {
		return false
	}
	return true
}
