package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// The client supplies the current complete, loaded species catalog (including the
// training dummy). Existing saved IDs are also cleared; no identity data is changed.
func clearPetIDs(raw json.RawMessage) ([]int64, error) {
	var ids []int64
	if nullJSON(raw) || json.Unmarshal(raw, &ids) != nil || len(ids) == 0 || len(ids) > 10000 {
		return nil, errors.New("clear_pet_configs requires loaded species IDs")
	}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id <= 0 || id > (1<<53)-1 || seen[id] {
			return nil, errors.New("invalid clear_pet_configs species IDs")
		}
		seen[id] = true
	}
	return ids, nil
}

func clearPersonalRecords(data jsonObject, ids []int64) (bool, error) {
	pets := jsonObject{}
	if raw, exists := data["rk_pet_configs"]; exists {
		var err error
		pets, err = parseObject(raw)
		if err != nil {
			return false, err
		}
	}
	for _, id := range ids {
		key := strconv.FormatInt(id, 10)
		if _, exists := pets[key]; !exists {
			pets[key] = json.RawMessage(`{}`)
		}
	}
	changed := false
	for id, raw := range pets {
		record, err := parseObject(raw)
		if err != nil {
			return false, fmt.Errorf("invalid personal record %s: %w", id, err)
		}
		dirty := !bytes.Equal(bytes.TrimSpace(record["mode"]), []byte("1"))
		record["mode"] = json.RawMessage(`1`)
		for _, field := range []string{"iv", "nature"} {
			stats := jsonObject{}
			if old, exists := record[field]; exists {
				stats, err = parseObject(old)
				if err != nil {
					return false, fmt.Errorf("invalid personal %s.%s", id, field)
				}
			}
			value := json.RawMessage(`false`)
			if field == "nature" {
				value = json.RawMessage(`0`)
			}
			for _, stat := range []string{"hp", "attack", "magic_attack", "defense", "magic_defense", "speed"} {
				if !bytes.Equal(bytes.TrimSpace(stats[stat]), value) {
					stats[stat] = value
					dirty = true
				}
			}
			record[field], _ = json.Marshal(stats)
		}
		if dirty {
			pets[id], _ = json.Marshal(record)
			changed = true
		}
	}
	if changed {
		data["rk_pet_configs"], _ = json.Marshal(pets)
	}
	return changed, nil
}
