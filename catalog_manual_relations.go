package main

import (
	"encoding/json"
	"fmt"
)

// The legacy editor sends a form label, not an entity name. Resolve it once at
// the save boundary and keep the explicit stable-ID projection in sync.
func applyManualMainForm(monster map[string]interface{}, monsters []map[string]interface{}, category, formLabel string) error {
	if category == "" && formLabel == "" {
		return nil // a partial non-form edit must retain the current pairing
	}
	if category == "" {
		category, _ = monster["form_category"].(string)
	}
	switch category {
	case "无多形态", "主形态":
		monster["form_category"] = category
		monster["main_form_name"] = ""
		monster["main_form_id"] = nil
		return nil
	case "变体形态":
	default:
		return fmt.Errorf("无效的形态分类")
	}
	if formLabel == "" {
		return fmt.Errorf("变体形态必须指定主形态")
	}
	baseName := func(m map[string]interface{}) string {
		loc, _ := m["localized"].(map[string]interface{})
		zh, _ := loc["zh"].(map[string]interface{})
		name, _ := zh["name"].(string)
		return name
	}
	id, err := numericMonsterID(monster["id"])
	if err != nil {
		return err
	}
	mainID := 0
	for _, candidate := range monsters {
		if baseName(candidate) != baseName(monster) || candidate["form"] != formLabel || candidate["form_category"] != "主形态" {
			continue
		}
		candidateID, err := numericMonsterID(candidate["id"])
		if err != nil {
			return err
		}
		if candidateID == id {
			return fmt.Errorf("主形态不能指向自身")
		}
		if mainID != 0 {
			return fmt.Errorf("主形态存在歧义")
		}
		mainID = candidateID
	}
	if mainID == 0 {
		return fmt.Errorf("找不到对应的同名主形态")
	}
	monster["form_category"], monster["main_form_name"], monster["main_form_id"] = category, formLabel, mainID
	return nil
}

// A missing relation field is not a request to clear it. The canonical transaction
// performs the final cross-record/cycle validation before any active write.
func applyManualRelationFields(monster map[string]interface{}, id int, known map[int]bool, membersJSON, predecessorJSON, leaderJSON json.RawMessage) error {
	if len(membersJSON) == 0 && len(predecessorJSON) == 0 && len(leaderJSON) == 0 {
		return nil
	}
	var members []int
	hasMembers := false
	if len(membersJSON) > 0 {
		if err := json.Unmarshal(membersJSON, &members); err != nil || members == nil {
			return fmt.Errorf("进化成员必须是明确的ID数组，不能为null")
		}
		hasMembers = true
	} else if existing, ok := monster["evolution_members"]; ok {
		encoded, err := json.Marshal(existing)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(encoded, &members); err != nil || members == nil {
			return fmt.Errorf("已有进化成员无效")
		}
		hasMembers = true
	}
	if hasMembers {
		seen := map[int]bool{}
		for _, member := range members {
			if member <= 0 || !known[member] || seen[member] {
				return fmt.Errorf("进化成员含无效、重复或不存在的ID: %d", member)
			}
			seen[member] = true
		}
	}
	decodeRef := func(raw json.RawMessage, label string) (*int, error) {
		var value *int
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("%s必须是整数ID或null", label)
		}
		if value != nil && (*value <= 0 || *value == id || !known[*value]) {
			return nil, fmt.Errorf("%s不存在或指向自身", label)
		}
		return value, nil
	}
	var predecessor, leader *int
	var err error
	if len(predecessorJSON) > 0 {
		predecessor, err = decodeRef(predecessorJSON, "普通进化前置")
		if err != nil {
			return err
		}
		if predecessor != nil && hasMembers {
			found := false
			for _, member := range members {
				if member == *predecessor {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("普通进化前置不在当前进化成员中，请先明确成员关系")
			}
		}
	}
	if len(leaderJSON) > 0 {
		leader, err = decodeRef(leaderJSON, "首领化来源")
		if err != nil {
			return err
		}
	}
	if len(membersJSON) > 0 {
		monster["evolution_members"] = members
	}
	if len(predecessorJSON) > 0 {
		if predecessor == nil {
			monster["evolves_from_id"] = nil
		} else {
			monster["evolves_from_id"] = *predecessor
		}
	}
	if len(leaderJSON) > 0 {
		if leader == nil {
			monster["leader_of_id"] = nil
		} else {
			monster["leader_of_id"] = *leader
			monster["is_leader_form"] = true
		}
	}
	return nil
}
