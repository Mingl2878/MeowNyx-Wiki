package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
)

const battleActionMinInt32 int64 = -1 << 31
const battleActionMaxInt32 int64 = 1<<31 - 1

// battleValidateActionFields validates only the additive timeline metadata. The
// enclosing record validator remains responsible for identities and core enums.
func battleValidateActionFields(e *BattleEvent) error {
	if e == nil {
		return errors.New("missing battle event")
	}
	if err := battleValidateUserConfirmedSkill(*e); err != nil {
		return err
	}
	if e.ExecIndex != nil && (*e.ExecIndex < 0 || *e.ExecIndex > 1000000000) {
		return errors.New("invalid event execution index")
	}
	for _, field := range []struct {
		name  string
		value *int
		after bool
	}{
		{"hpChange", e.HPChange, false}, {"hpAfter", e.HPAfter, true},
		{"energyChange", e.EnergyChange, false}, {"energyAfter", e.EnergyAfter, true},
	} {
		if field.value == nil {
			continue
		}
		v := int64(*field.value)
		if v < battleActionMinInt32 || v > battleActionMaxInt32 || field.after && v < 0 {
			return fmt.Errorf("invalid event %s", field.name)
		}
	}
	label, err := battleText(e.Label, 256)
	if err != nil {
		return err
	}
	if !battleOneOf(e.Lifecycle, "", "enter", "round_start", "finish") {
		return errors.New("invalid event lifecycle")
	}
	if !battleOneOf(e.SkillClass, "", "ordinary", "response", "passive", "system", "unknown") {
		return errors.New("invalid event skill class")
	}
	hasHP := e.HPChange != nil || e.HPAfter != nil
	hasEnergy := e.EnergyChange != nil || e.EnergyAfter != nil
	if e.Lifecycle != "" {
		if e.Kind != "note" || e.Phase != "unknown" || e.Actor != "" || e.Target != "" ||
			e.TargetSide != "" || e.SkillID != 0 || e.ProtocolSkillID != "" || e.SkillClass != "" ||
			e.Amount != nil || e.Stacks != nil || hasHP || hasEnergy || e.Form != nil || e.Trigger != "" {
			return errors.New("lifecycle requires an unknown-phase note without gameplay fields")
		}
	}
	if e.Phase == "interrupted" && (!(e.Kind == "skill" || e.Kind == "effect" && e.SkillClass == "system") || e.Amount != nil || e.Stacks != nil || hasHP || hasEnergy) {
		return errors.New("interrupted event requires a skill or system action without effect amounts")
	}
	if battleOneOf(e.SkillClass, "passive", "system") && (e.Kind == "skill" || e.SkillID != 0) {
		return errors.New("passive or system action must not assert an ordinary skill")
	}
	if battleOneOf(e.SkillClass, "ordinary", "response") && e.Kind != "skill" {
		return errors.New("ordinary or response class requires a skill event")
	}
	if hasHP && !battleOneOf(e.Kind, "damage", "heal", "resource") {
		return errors.New("HP fields require damage, heal or resource event")
	}
	if hasEnergy && e.Kind != "resource" {
		return errors.New("energy fields require a resource event")
	}
	if e.HPChange != nil && (e.Kind == "damage" && *e.HPChange > 0 || e.Kind == "heal" && *e.HPChange < 0) {
		return errors.New("HP change conflicts with damage or healing direction")
	}
	if e.Form != nil {
		if hasHP || hasEnergy || e.Lifecycle != "" {
			return errors.New("form transition must not carry resource or lifecycle fields")
		}
		if e.Form.ExecIndex < 0 || e.Form.ExecIndex > 1000000000 || e.ExecIndex != nil && *e.ExecIndex != e.Form.ExecIndex {
			return errors.New("form and event execution indices conflict")
		}
	}
	e.Label = label
	return nil
}

// battleMergeActionFields fills both copies before the caller compares their
// remaining immutable facts. Work on copies so conflicts cannot partially enrich
// either input. Pointer values distinguish an absent measurement from measured 0.
func battleMergeActionFields(a, b *BattleEvent) error {
	if a == nil || b == nil {
		return errors.New("missing battle event to merge")
	}
	x, y := *a, *b
	for _, pair := range []struct {
		name string
		a, b **int
	}{
		{"execIndex", &x.ExecIndex, &y.ExecIndex},
		{"hpChange", &x.HPChange, &y.HPChange}, {"hpAfter", &x.HPAfter, &y.HPAfter},
		{"energyChange", &x.EnergyChange, &y.EnergyChange}, {"energyAfter", &x.EnergyAfter, &y.EnergyAfter},
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
	for _, pair := range []struct {
		name string
		a, b *string
	}{
		{"lifecycle", &x.Lifecycle, &y.Lifecycle},
		{"skillClass", &x.SkillClass, &y.SkillClass}, {"label", &x.Label, &y.Label},
	} {
		left, right := *pair.a, *pair.b
		// Unknown classification carries no known skill-family assertion.
		if pair.name == "skillClass" && left != right {
			if left == "unknown" && right != "" {
				left = right
			} else if right == "unknown" && left != "" {
				right = left
			}
		}
		if left == "" {
			left = right
		}
		if right == "" {
			right = left
		}
		if left != right {
			return fmt.Errorf("conflicting event %s", pair.name)
		}
		*pair.a, *pair.b = left, right
	}
	*a, *b = x, y
	return nil
}

// battleNamedSigned32 accepts exact integer representations of a signed 32-bit
// delta. The supplied decoder can render protobuf negative int32 values as their
// sign-extended uint64 bit pattern. A uint32 wrap is NOT sufficient evidence of a
// negative number and is rejected. Missing values are errors, not measured zero.
func battleNamedSigned32(value any) (int, error) {
	fail := func() (int, error) { return 0, errors.New("invalid named-schema signed 32-bit integer") }
	bounded := func(v int64) (int, error) {
		if v < battleActionMinInt32 || v > battleActionMaxInt32 {
			return fail()
		}
		return int(v), nil
	}
	unsigned := func(v uint64) (int, error) {
		if v <= uint64(battleActionMaxInt32) {
			return int(v), nil
		}
		// Only the final 2^31 uint64 values are sign-extended negative int32.
		if v < ^uint64(0)-uint64(1<<31)+1 {
			return fail()
		}
		return bounded(int64(v))
	}
	floating := func(v float64) (int, error) {
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 9007199254740991 || math.Trunc(v) != v || v == 0 && math.Signbit(v) {
			return fail()
		}
		return bounded(int64(v))
	}
	var text string
	switch v := value.(type) {
	case json.Number:
		text = v.String()
	case string:
		text = v
	case int:
		return bounded(int64(v))
	case int8:
		return bounded(int64(v))
	case int16:
		return bounded(int64(v))
	case int32:
		return bounded(int64(v))
	case int64:
		return bounded(v)
	case uint:
		return unsigned(uint64(v))
	case uint8:
		return unsigned(uint64(v))
	case uint16:
		return unsigned(uint64(v))
	case uint32:
		return unsigned(uint64(v))
	case uint64:
		return unsigned(v)
	case float32:
		return floating(float64(v))
	case float64:
		return floating(v)
	default:
		return fail()
	}
	if text == "" || len(text) > 20 || text == "-0" {
		return fail()
	}
	digits := text
	if digits[0] == '-' {
		digits = digits[1:]
	}
	if digits == "" || len(digits) > 1 && digits[0] == '0' {
		return fail()
	}
	for _, c := range digits {
		if c < '0' || c > '9' {
			return fail()
		}
	}
	if text[0] == '-' {
		v, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return fail()
		}
		return bounded(v)
	}
	v, err := strconv.ParseUint(text, 10, 64)
	if err != nil {
		return fail()
	}
	return unsigned(v)
}
