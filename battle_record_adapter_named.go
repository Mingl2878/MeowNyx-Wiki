package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf8"
)

// Independently implemented against the named field definitions in the reviewed
// rkpp_data.sqlite proto_schema (opened read-only), NOT against a numeric protobuf
// tree. Checked types: BattleInitInfo/BattleStateInfo, BattleRoleInfo,
// BattlePetInfo, BattleInsidePetInfo, PetData, BattlePerformCmd/BattlePerformInfo,
// BattleSkillCast, BattleDamageInfo, BattleHealInfo, BattleChangePet,
// BattleBuffChange/BattleBuffTrigger and BattleWeatherChange.
// Note the distinctions: PetData.gid is not assumed equal to inside.pet_id;
// conf_id is not a Wiki ID; damage_info.source_id is NOT a skill or damage amount;
// first_team, pos, enter_index and grow_times are NOT lead/growth evidence.
func battleNamedArray(v any, limit int) ([]any, error) {
	if v == nil {
		return nil, nil
	}
	a, ok := v.([]any)
	if !ok || len(a) > limit {
		return nil, errors.New("invalid or oversized named-schema repeated field")
	}
	return a, nil
}
func battleNamedID(v any) (string, error) {
	if v == nil {
		return "", nil
	}
	s, err := battleIdentifier(v)
	if err != nil {
		return "", err
	}
	if s == "0" {
		return "", nil
	}
	return s, nil
}
func battleNamedInt(v any, hi int) (int, error) {
	if v == nil {
		return 0, nil
	}
	n, ok := v.(json.Number)
	if !ok {
		return 0, errors.New("invalid named-schema integer")
	}
	i, err := strconv.Atoi(n.String())
	if err != nil || i < 0 || i > hi {
		return 0, errors.New("named-schema integer out of bounds")
	}
	return i, nil
}
func battleNamedPet(raw map[string]any, r *BattleRecord) (BattlePet, bool, error) {
	p := BattlePet{}
	inside, common := battleObject(raw["battle_inside_pet_info"]), battleObject(raw["battle_common_pet_info"])
	var err error
	p.InstanceID, err = battleNamedID(inside["pet_id"])
	if err != nil {
		return p, false, err
	}
	if p.InstanceID == "" {
		gid, e := battleNamedID(common["gid"])
		if e != nil {
			return p, false, e
		}
		if gid != "" {
			p.InstanceID = "gid:" + gid
			battleIssue(r, "PetData gid retained with a gid: namespace; it is not a verified battle caster ID.")
		}
	}
	if p.InstanceID == "" {
		battleIssue(r, "Named-schema pet lacks a stable pet_id/gid and was omitted.")
		return p, false, nil
	}
	// Common data is the initial species. Inside data can already reflect a
	// form change; it must not overwrite the roster's original identity.
	p.ProtocolBaseID, err = battleNamedID(common["base_conf_id"])
	if err != nil {
		return p, false, err
	}
	insideBase, err := battleNamedID(inside["base_conf_id"])
	if err != nil {
		return p, false, err
	}
	if p.ProtocolBaseID == "" {
		p.ProtocolBaseID = insideBase
	}
	p.ProtocolID, err = battleNamedID(common["conf_id"])
	if err != nil {
		return p, false, err
	}
	alternate, err := battleNamedID(inside["conf_id"])
	if err != nil {
		return p, false, err
	}
	if p.ProtocolID != "" && alternate != "" && p.ProtocolID != alternate {
		return p, false, errors.New("conflicting named-schema pet conf_id")
	}
	if p.ProtocolID == "" {
		p.ProtocolID = alternate
	}
	if common["level"] != nil {
		level, e := battleNamedInt(common["level"], 100)
		if e != nil {
			return p, false, e
		}
		if level > 0 {
			p.Level = &level
		}
	}
	// rkpp_codec serializes protobuf bytes as hex, not decoded display strings.
	// Decode only the known pet-name bytes; never retain owner/account names.
	name := common["name"]
	if name == nil {
		name = inside["name"]
	}
	if name != nil {
		s, ok := name.(string)
		if ok && len(s) <= 256 {
			b, e := hex.DecodeString(s)
			if e == nil && utf8.Valid(b) {
				p.Name = string(b)
			} else {
				battleIssue(r, "Pet name bytes were not valid UTF-8 hex; display name omitted.")
			}
		} else {
			battleIssue(r, "Invalid or oversized pet name omitted.")
		}
	}
	if common["nature"] != nil || common["talent_rank"] != nil || common["attribute_info"] != nil || common["grow_times"] != nil {
		battleIssue(r, "Protocol nature/talent/attribute/grow_times fields are not normalized IV, nature or explicit growth events; omitted.")
	}
	return p, true, nil
}

func battleAdaptNamed(r *BattleRecord, state, cmd map[string]any, opening ...bool) error {
	haveData := false
	teams := map[string][]any{}
	type owner struct {
		side  string
		count int
	}
	owners := map[string]owner{}
	for _, pair := range [][2]string{{"player_team", "me"}, {"enemy_team", "enemy"}} {
		roles, err := battleNamedArray(state[pair[0]], 24)
		if err != nil {
			return err
		}
		teams[pair[1]] = append([]any{}, roles...)
		for _, raw := range roles {
			role := battleObject(raw)
			if role == nil {
				return errors.New("invalid named-schema role")
			}
			if len(opening) != 1 || !opening[0] {
				continue
			}
			id, err := battleNamedID(battleObject(role["base"])["role_uin"])
			if err != nil {
				return err
			}
			if id != "" {
				o := owners[id]
				o.side = pair[1]
				o.count++
				owners[id] = o
			}
		}
	}
	// Only opening others has the reviewed direct role_uin + pets shape.
	// Owners exist only in this local join index and never enter stored data.
	if len(opening) == 1 && opening[0] {
		others, err := battleNamedArray(state["others"], 24)
		if err != nil {
			return err
		}
		for _, raw := range others {
			role := battleObject(raw)
			if role == nil {
				return errors.New("invalid named-schema opening other")
			}
			id, err := battleNamedID(role["role_uin"])
			if err != nil {
				return err
			}
			o := owners[id]
			if id == "" || o.count != 1 {
				battleIssue(r, "Opening others omitted: no unique explicit side owner match.")
				continue
			}
			teams[o.side] = append(teams[o.side], role)
		}
	}
	for _, pair := range [][2]string{{"player_team", "me"}, {"enemy_team", "enemy"}} {
		roles := teams[pair[1]]
		side := r.Sides[pair[1]]
		seen := map[string]BattlePet{}
		for _, roleRaw := range roles {
			role := battleObject(roleRaw)
			if role == nil {
				return errors.New("invalid named-schema role")
			}
			pets, err := battleNamedArray(role["pets"], 24)
			if err != nil {
				return err
			}
			for _, petRaw := range pets {
				raw := battleObject(petRaw)
				if raw == nil {
					return errors.New("invalid named-schema pet")
				}
				p, ok, err := battleNamedPet(raw, r)
				if err != nil {
					return err
				}
				if !ok {
					continue
				}
				if old, exists := seen[p.InstanceID]; exists {
					merged, err := battleMergePet(old, p)
					if err != nil {
						return err
					}
					seen[p.InstanceID] = merged
					for i := range side.Pets {
						if side.Pets[i].InstanceID == p.InstanceID {
							side.Pets[i] = merged
							break
						}
					}
				} else {
					seen[p.InstanceID] = p
					side.Pets = append(side.Pets, p)
				}
				haveData = true
			}
		}
		if len(side.Pets) > 24 {
			return errors.New("named-schema side exceeds pet limit")
		}
		r.Sides[pair[1]] = side
	}
	if haveData {
		r.Source = "rkpp-named-schema"
		battleIssue(r, "Sides come from explicit teams or uniquely owner-matched opening others; protocol species IDs require explicit Wiki mapping. Roster and lead coverage remain incomplete.")
	}
	if cmd == nil {
		return nil
	}
	entries, err := battleNamedArray(cmd["perform_info"], BattleMaxEvents)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return nil
	}
	// The containing 0x131A state_info supplies the battle ID. Standalone performs
	// have no such ID in the checked schema and are never associated by flow/time.
	if cmd["seq_num"] == nil || cmd["round"] == nil {
		battleIssue(r, "Named perform lacks explicit round/seq_num; actions omitted because stable deduplication cannot be established.")
		return nil
	}
	seq, err := battleNamedInt(cmd["seq_num"], 1000000000)
	if err != nil {
		return err
	}
	round, err := battleNamedInt(cmd["round"], 1000000)
	if err != nil {
		return err
	}
	r.Source = "rkpp-named-schema"
	for index, raw := range entries {
		item := battleObject(raw)
		if item == nil {
			return errors.New("invalid named perform entry")
		}
		ordinal := index
		tag := "index"
		if item["exec_index"] != nil {
			ordinal, err = battleNamedInt(item["exec_index"], 1000000000)
			if err != nil {
				return err
			}
			tag = "exec"
		}
		e := BattleEvent{ID: fmt.Sprintf("rkpp:perform:%d:%d:%s:%d", round, seq, tag, ordinal), Round: round, Seq: seq, Phase: "executed", Side: "unknown"}
		branches := []struct {
			field, kind string
			number      int
		}{{"skill_cast", "skill", 1}, {"buff_change", "effect", 2}, {"buff_trigger", "effect", 3}, {"damage_info", "damage", 4}, {"heal_info", "heal", 5}, {"change_pet", "switch", 13}, {"weather_change", "weather", 22}}
		selected := -1
		for i, b := range branches {
			if item[b.field] != nil {
				if selected >= 0 {
					return errors.New("multiple conflicting named perform branches")
				}
				selected = i
			}
		}
		if selected < 0 {
			e.Kind = "note"
			e.Phase = "unknown"
			e.Text = "Unsupported named perform entry; gameplay effects not decoded."
			r.Events = append(r.Events, e)
			battleIssue(r, "Some named perform branches are unsupported; capture remains incomplete.")
			continue
		}
		branch := branches[selected]
		body := battleObject(item[branch.field])
		if body == nil {
			return errors.New("invalid named perform branch")
		}
		if item["type"] != nil {
			v := item["type"]
			if enum := battleObject(v); enum != nil {
				v = enum["value"]
			}
			n, er := battleNamedInt(v, 1000)
			if er != nil || n != branch.number {
				return errors.New("named perform type conflicts with branch")
			}
		}
		e.Kind = branch.kind
		casterKey, targetKey := "caster_id", "target_id"
		if branch.kind == "switch" {
			casterKey, targetKey = "battle_pet_id", "rest_pet_id"
		}
		e.Actor, err = battleNamedID(body[casterKey])
		if err != nil {
			return err
		}
		if branch.kind == "skill" {
			e.ProtocolSkillID, err = battleNamedID(body["skill_id"])
			if err != nil {
				return err
			}
			targets, er := battleNamedArray(body["target_id"], 48)
			if er != nil {
				return er
			}
			ids := []string{}
			for _, target := range targets {
				id, er := battleNamedID(target)
				if er != nil {
					return er
				}
				if id != "" && !battleOneOf(id, ids...) {
					ids = append(ids, id)
				}
			}
			if len(ids) == 1 {
				e.Target = ids[0]
			} else if len(ids) > 1 {
				battleIssue(r, "Multi-target skill retained as one cast; target list is not represented by the single-target model, so target attribution remains incomplete.")
			}
			if interrupted, ok := body["is_interupt"].(bool); ok && interrupted {
				e.Phase = "unknown"
				e.Text = "Interrupted skill notification; not a confirmed executed cast."
			}
		} else {
			e.Target, err = battleNamedID(body[targetKey])
			if err != nil {
				return err
			}
			// damage/heal source_id is not known to be a Wiki/protocol skill ID.
			if branch.kind == "damage" || branch.kind == "heal" {
				e.Text = "Named damage/heal event; amount and source semantics are not verified."
			}
		}
		if branch.kind == "weather" {
			e.ProtocolSkillID, err = battleNamedID(body["skill_id"])
			if err != nil {
				return err
			}
			e.Text = "Named weather change; weather enum mapping not verified."
		}
		// Actor/target IDs are resolved against explicit team instances by validation.
		// No role_uin, player_id, side number, order or displayed name is used.
		r.Events = append(r.Events, e)
	}
	battleIssue(r, "Named perform notifications retained with protocol IDs; only skill_cast entries are casts. No raw profile inference or automatic growth rules are applied.")
	return nil
}
