package main

import (
	"encoding/json"
	"errors"
	"strings"
)

// Presets persist only their reserved selection ID, never derived member lists.
func validChartPresetID(id string) bool {
	for _, name := range []string{"Normal", "Grass", "Fire", "Water", "Light", "Ground", "Ice", "Dragon", "Electric", "Poison", "Bug", "Fighting", "Flying", "Cute", "Ghost", "Dark", "Mechanical", "Illusion"} {
		if id == "preset:"+name {
			return true
		}
	}
	return false
}

// Independent chart state is atomic: membership, active group and controls cannot
// be partially saved. No damage-page personal configuration is merged into it.
func validateChartWorkspace(raw json.RawMessage) error {
	invalid := func() error { return errors.New("invalid independent chart workspace") }
	obj, err := parseObject(raw)
	if err != nil {
		return invalid()
	}
	var version int
	if json.Unmarshal(obj["version"], &version) != nil || version != 1 {
		return invalid()
	}
	var active string
	if json.Unmarshal(obj["activeGroupId"], &active) != nil || strings.TrimSpace(active) == "" || len(active) > 128 {
		return invalid()
	}
	var imported bool
	if v, exists := obj["legacyImported"]; exists && (nullJSON(v) || json.Unmarshal(v, &imported) != nil) {
		return invalid()
	}
	var groups []json.RawMessage
	if nullJSON(obj["groups"]) || json.Unmarshal(obj["groups"], &groups) != nil || len(groups) > 200 {
		return invalid()
	}
	groupIDs := map[string]bool{}
	for _, group := range groups {
		g, err := parseObject(group)
		if err != nil {
			return invalid()
		}
		var id, name string
		if json.Unmarshal(g["id"], &id) != nil || strings.TrimSpace(id) == "" || len(id) > 128 || groupIDs[id] || strings.HasPrefix(id, "preset:") {
			return invalid()
		}
		if json.Unmarshal(g["name"], &name) != nil || strings.TrimSpace(name) == "" || len([]rune(name)) > 80 {
			return invalid()
		}
		groupIDs[id] = true
		var ids []int64
		if nullJSON(g["petIds"]) || json.Unmarshal(g["petIds"], &ids) != nil || len(ids) > 10000 {
			return invalid()
		}
		seen := map[int64]bool{}
		for _, petID := range ids {
			if petID <= 0 || petID > (1<<53)-1 || seen[petID] {
				return invalid()
			}
			seen[petID] = true
		}
	}
	if strings.HasPrefix(active, "preset:") && !validChartPresetID(active) {
		return invalid()
	}
	controls, err := parseObject(obj["controls"])
	if err != nil {
		return invalid()
	}
	var doubleLife bool
	if nullJSON(controls["doubleLife"]) || json.Unmarshal(controls["doubleLife"], &doubleLife) != nil {
		return invalid()
	}
	for _, field := range []string{"atkIV", "atkNature", "defIV"} {
		stats, err := parseObject(controls[field])
		if err != nil {
			return invalid()
		}
		for stat, value := range stats {
			if field == "defIV" {
				if stat != "defense" && stat != "magic_defense" {
					return invalid()
				}
			} else if stat != "attack" && stat != "magic_attack" {
				return invalid()
			}
			if nullJSON(value) {
				return invalid()
			}
			if field == "atkNature" {
				var n int
				if json.Unmarshal(value, &n) != nil || n < 0 || n > 2 {
					return invalid()
				}
			} else {
				var b bool
				if json.Unmarshal(value, &b) != nil {
					return invalid()
				}
			}
		}
	}
	return nil
}
