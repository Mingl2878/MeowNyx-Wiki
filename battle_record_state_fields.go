package main

import (
	"errors"
	"fmt"
)

const battleStateMaxInt32 int64 = 1<<31 - 1

// battleValidateStateFields checks only explicit, additive state measurements.
// It does not infer a skill cost, active pet, lead, appearance or completeness.
// The enclosing record validator owns actor membership in the declared roster.
func battleValidateStateFields(e *BattleEvent) error {
	if e == nil {
		return errors.New("missing battle event")
	}
	if e.HPMax != nil {
		if v := int64(*e.HPMax); v <= 0 || v > battleStateMaxInt32 {
			return errors.New("invalid event hpMax")
		}
		if !battleOneOf(e.Kind, "resource", "damage", "heal") {
			return errors.New("hpMax requires resource, damage or heal event")
		}
		if e.HPAfter != nil && *e.HPAfter > *e.HPMax {
			return errors.New("event hpAfter exceeds hpMax")
		}
	}
	if e.EnergyCost != nil {
		if v := int64(*e.EnergyCost); v < 0 || v > battleStateMaxInt32 {
			return errors.New("invalid event energyCost")
		}
		if e.Kind != "skill" && !(e.Kind == "effect" && e.SkillClass == "system") {
			return errors.New("energyCost requires skill or system effect event")
		}
		if !battleOneOf(e.Phase, "executed", "interrupted") {
			return errors.New("energyCost requires executed or interrupted phase")
		}
	}
	if !battleOneOf(e.StateStage, "", "initial", "snapshot", "entry") {
		return errors.New("invalid event stateStage")
	}
	if e.StateStage != "" {
		if e.Kind != "resource" || e.Phase != "executed" ||
			!battleOneOf(e.Side, "me", "enemy") || !battleID(e.Actor, true) {
			return errors.New("stateStage requires executed resource event with known actor and side")
		}
		if e.StateStage == "initial" && e.Round != 0 || e.StateStage != "initial" && e.Round <= 0 {
			return errors.New("stateStage conflicts with event round")
		}
	}
	if e.StateActive != nil && (e.StateStage == "" || !battleID(e.Actor, true)) {
		return errors.New("stateActive requires stateStage and actor")
	}
	return nil
}

// battleMergeStateFields fills only absent metadata in both copies. In
// particular, a measured zero cost and measured false active state are known
// facts, not missing values. Reconciliation is atomic and creates independent
// pointers; the caller still validates the whole enriched event before saving.
func battleMergeStateFields(a, b *BattleEvent) error {
	if a == nil || b == nil {
		return errors.New("missing battle event to merge")
	}
	x, y := *a, *b
	for _, pair := range []struct {
		name string
		a, b **int
	}{
		{"hpMax", &x.HPMax, &y.HPMax},
		{"energyCost", &x.EnergyCost, &y.EnergyCost},
	} {
		if *pair.a != nil && *pair.b != nil && **pair.a != **pair.b {
			return fmt.Errorf("conflicting event %s", pair.name)
		}
		value := *pair.a
		if value == nil {
			value = *pair.b
		}
		if value != nil {
			left, right := *value, *value
			*pair.a, *pair.b = &left, &right
		}
	}
	if x.StateStage == "" {
		x.StateStage = y.StateStage
	}
	if y.StateStage == "" {
		y.StateStage = x.StateStage
	}
	if x.StateStage != y.StateStage {
		return errors.New("conflicting event stateStage")
	}
	if x.StateActive != nil && y.StateActive != nil && *x.StateActive != *y.StateActive {
		return errors.New("conflicting event stateActive")
	}
	active := x.StateActive
	if active == nil {
		active = y.StateActive
	}
	if active != nil {
		left, right := *active, *active
		x.StateActive, y.StateActive = &left, &right
	}
	*a, *b = x, y
	return nil
}
