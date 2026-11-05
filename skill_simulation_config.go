package main

import (
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
)

// Counters and special inputs belong to a stable species/skill pair, not the
// last active skill alone. They never alter personal IV/nature or master data.
func validateSkillSimulation(key string, raw json.RawMessage) error {
	invalid := func() error { return errors.New("invalid per-species skill simulation state") }
	pair := strings.Split(key, ":")
	if len(pair) != 2 {
		return invalid()
	}
	for _, part := range pair {
		id, err := strconv.ParseUint(part, 10, 53)
		if err != nil || id == 0 || strconv.FormatUint(id, 10) != part {
			return invalid()
		}
	}
	obj, err := parseObject(raw)
	if err != nil {
		return invalid()
	}
	for field, value := range obj {
		switch field {
		case "powerCount", "comboCount":
			var n float64
			if nullJSON(value) || json.Unmarshal(value, &n) != nil || n < 0 || n > 9007199254740991 || math.Trunc(n) != n {
				return invalid()
			}
		case "fireAttackCount":
			// Compatibility mirror of powerCount for 烈火战神/吹火; only an
			// explicit manual-power edit detaches retained growth. Never migrate on read.
			var n int
			if key != "14:113" || nullJSON(value) || json.Unmarshal(value, &n) != nil || n < 0 || n > 1_000_000 {
				return invalid()
			}
		case "firePowerDetached", "fireBuffOverridden":
			var flag bool
			if key != "14:113" || nullJSON(value) || json.Unmarshal(value, &flag) != nil {
				return invalid()
			}
		case "energy":
			var n int
			if nullJSON(value) || json.Unmarshal(value, &n) != nil || n < 0 || n > 10 {
				return invalid()
			}
		case "counterMode":
			var flag bool
			if nullJSON(value) || json.Unmarshal(value, &flag) != nil {
				return invalid()
			}
		case "hpRatio":
			var text string
			if nullJSON(value) || json.Unmarshal(value, &text) != nil || len(text) > 128 {
				return invalid()
			}
			parts := strings.Split(text, "/")
			if len(parts) != 2 {
				return invalid()
			}
			current, err1 := strconv.ParseUint(parts[0], 10, 53)
			maximum, err2 := strconv.ParseUint(parts[1], 10, 53)
			if err1 != nil || err2 != nil || maximum == 0 || current > maximum || strconv.FormatUint(current, 10) != parts[0] || strconv.FormatUint(maximum, 10) != parts[1] {
				return invalid()
			}
		}
	}
	return nil
}
