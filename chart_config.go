package main

import (
	"encoding/json"
	"errors"
	"strings"
)

// Presets persist only their reserved selection ID, never derived member lists.
func validChartPresetID(id string) bool {
	for _, name := range []string{"Survivors", "Favorites", "Normal", "Grass", "Fire", "Water", "Light", "Ground", "Ice", "Dragon", "Electric", "Poison", "Bug", "Fighting", "Flying", "Cute", "Ghost", "Dark", "Mechanical", "Illusion"} {
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
	var revision int
	if value, exists := obj["controlsRevision"]; exists {
		if nullJSON(value) || json.Unmarshal(value, &revision) != nil || revision < 0 || revision > 2 {
			return invalid()
		}
	}
	modern := revision == 2
	var active string
	if json.Unmarshal(obj["activeGroupId"], &active) != nil || strings.TrimSpace(active) == "" || len(active) > 128 {
		return invalid()
	}
	var imported bool
	if v, exists := obj["legacyImported"]; exists && (nullJSON(v) || json.Unmarshal(v, &imported) != nil) {
		return invalid()
	}
	if modern && !imported {
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
	// v1 doubleLife remains an input compatibility alias for HP positive nature.
	// New clients migrate to hpNature and mirror the alias; neither controls HP IV.
	if _, modern := controls["hpNature"]; !modern {
		if _, legacy := controls["doubleLife"]; !legacy {
			return invalid()
		}
	}
	if modern {
		var nature, alias bool
		if nullJSON(controls["hpNature"]) || nullJSON(controls["doubleLife"]) ||
			json.Unmarshal(controls["hpNature"], &nature) != nil ||
			json.Unmarshal(controls["doubleLife"], &alias) != nil || nature != alias {
			return invalid()
		}
	}
	for _, field := range []string{"hpNature", "doubleLife", "hpIV"} {
		if value, exists := controls[field]; exists {
			var enabled bool
			if nullJSON(value) || json.Unmarshal(value, &enabled) != nil || (field == "hpIV" && !enabled) {
				return invalid()
			}
		}
	}
	for _, field := range []string{"atkIV", "atkNature", "defIV"} {
		stats, err := parseObject(controls[field])
		if err != nil {
			return invalid()
		}
		// Legacy API/read fixtures may omit stats; revision 2 must be a complete
		// linked control snapshot, never a partial field patch.
		if modern && len(stats) != 2 {
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
				if json.Unmarshal(value, &n) != nil || n < 0 || n > 2 || (modern && n > 1) {
					return invalid()
				}
				if modern && n == 1 {
					ivs, err := parseObject(controls["atkIV"])
					var enabled bool
					if err != nil || json.Unmarshal(ivs[stat], &enabled) != nil || !enabled {
						return invalid()
					}
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
