package main

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

func validateDamageLevels(raw json.RawMessage) error {
	invalid := func() error { return errors.New("invalid independent damage level controls") }
	obj, err := parseObject(raw)
	if err != nil {
		return invalid()
	}
	for _, side := range []string{"attacker", "defender"} {
		value, exists := obj[side]
		if !exists {
			continue
		}
		role, err := parseObject(value)
		if err != nil {
			return invalid()
		}
		var slider int
		var manual string
		if nullJSON(role["slider"]) || json.Unmarshal(role["slider"], &slider) != nil || (slider < 1 || slider > 99) {
			return invalid()
		}
		if nullJSON(role["manual"]) || json.Unmarshal(role["manual"], &manual) != nil || len(manual) > 2 || strings.TrimSpace(manual) != manual {
			return invalid()
		}
		if manual != "" {
			level, err := strconv.Atoi(manual)
			if err != nil || level < 1 || level > 99 || strconv.Itoa(level) != manual {
				return invalid()
			}
		}
	}
	return nil
}
