package main

import (
	"fmt"
	"sort"
)

// Initial auxiliary rosters are joined only through unique explicit battle-pet
// overlap, disjoint opposing instances, and (when present) team base.side.
// No account, nickname, gid, owner or protocol display annotation is consumed.
func (s *battleLiveState) opening(info, body map[string]any) error {
	if info == nil {
		return errBattleLive
	}
	started, e := battleLiveTime(info["battle_start_time"])
	if e != nil {
		return e
	}
	if e = battleMergeKnown(&s.Record.StartedAt, started); e != nil {
		return e
	}
	teams := map[string][]any{"me": {}, "enemy": {}}
	known := map[string]map[string]bool{"me": {}, "enemy": {}}
	for _, pair := range [][2]string{{"player_team", "me"}, {"enemy_team", "enemy"}} {
		rows, er := battleLiveArray(info[pair[0]], 24)
		if er != nil {
			return er
		}
		teams[pair[1]] = append(teams[pair[1]], rows...)
		for _, raw := range rows {
			role := battleObject(raw)
			if role == nil {
				return errBattleLive
			}
			if v := battleObject(role["base"])["side"]; v != nil {
				code, er := battleLiveInt(v, 0, 1, true)
				if er != nil {
					return er
				}
				if old := s.SideCodes[code]; old != "" && old != pair[1] {
					return errBattleLive
				}
				s.SideCodes[code] = pair[1]
			}
			pets, er := battleLiveArray(role["pets"], 24)
			if er != nil {
				return er
			}
			for _, raw := range pets {
				id, er := battleLivePetID(battleObject(battleObject(raw)["battle_inside_pet_info"])["pet_id"], true)
				if er != nil {
					return er
				}
				known[pair[1]][id] = true
			}
		}
	}
	for id := range known["me"] {
		if known["enemy"][id] {
			return errBattleLive
		}
	}
	others, e := battleLiveArray(info["others"], 24)
	if e != nil {
		return e
	}
	candidates := map[string][]any{}
	for _, raw := range others {
		role := battleObject(raw)
		if role == nil {
			return errBattleLive
		}
		pets, er := battleLiveArray(role["pets"], 24)
		if er != nil {
			return er
		}
		overlap := map[string]bool{}
		for _, raw := range pets {
			id, er := battleLivePetID(battleObject(battleObject(raw)["battle_inside_pet_info"])["pet_id"], true)
			if er != nil {
				return er
			}
			for _, side := range []string{"me", "enemy"} {
				if known[side][id] {
					overlap[side] = true
				}
			}
		}
		if len(overlap) == 1 {
			for side := range overlap {
				candidates[side] = append(candidates[side], role)
			}
		} else {
			battleIssue(&s.Record, "Opening auxiliary roster omitted: no unique battle-instance side overlap.")
		}
	}
	for _, side := range []string{"me", "enemy"} {
		if len(candidates[side]) == 1 {
			teams[side] = append(teams[side], candidates[side][0])
		} else if len(candidates[side]) > 1 {
			battleIssue(&s.Record, "Ambiguous initial auxiliary roster candidates omitted.")
		}
	}
	for _, side := range []string{"me", "enemy"} {
		initial := map[string]bool{}
		full := map[string]bool{}
		leads := map[string]bool{}
		for _, role := range teams[side] {
			pets, e := battleLiveArray(battleObject(role)["pets"], 24)
			if e != nil {
				return e
			}
			for _, raw := range pets {
				m := battleObject(raw)
				if m == nil {
					return errBattleLive
				}
				p, e := battleLivePet(m, side)
				if e != nil {
					return e
				}
				if p.InstanceID == "" {
					continue
				}
				if other := s.actor(p.InstanceID); other != "unknown" && other != side {
					return errBattleLive
				}
				team := s.Record.Sides[side]
				found := false
				for i, old := range team.Pets {
					if old.InstanceID == p.InstanceID {
						p, e = battleMergePet(old, p)
						if e != nil {
							return e
						}
						team.Pets[i] = p
						found = true
						break
					}
				}
				if !found {
					team.Pets = append(team.Pets, p)
				}
				if len(team.Pets) > 24 {
					return errBattleLive
				}
				s.Record.Sides[side] = team
				initial[p.InstanceID] = true
				if v, ok := m["full_for_data_level"].(bool); ok && v {
					full[p.InstanceID] = true
				}
				if e = s.snapshot(m, 0, 0, 0, "initial"); e != nil {
					return e
				}
				if ev, ok := s.Events[s.key(0, 0, 0, "state-initial", p.InstanceID)]; ok && ev.StateActive != nil && *ev.StateActive {
					leads[p.InstanceID] = true
				}
			}
		}
		// Six explicitly disclosed unique initial slots are the reviewed full roster.
		// Neither a single visible enemy nor a later snapshot can confer this flag.
		if len(initial) == 6 && len(full) == 6 {
			s.Record.Quality.Roster[side] = true
		}
		if len(leads) > 1 {
			return errBattleLive
		}
		for id := range leads {
			team := s.Record.Sides[side]
			if e = battleMergeKnown(&team.Lead, id); e != nil {
				return e
			}
			s.Record.Sides[side] = team
			s.Record.Quality.Lead[side] = true
		}
	}
	return s.lifecycle("enter", 0, 0)
}

func battleLivePet(raw map[string]any, side string) (BattlePet, error) {
	var p BattlePet
	inside := battleObject(raw["battle_inside_pet_info"])
	common := battleObject(raw["battle_common_pet_info"])
	var e error
	p.InstanceID, e = battleLivePetID(inside["pet_id"], false)
	if e != nil || p.InstanceID == "" {
		return p, e
	}
	p.ProtocolBaseID, e = battleLivePetID(common["base_conf_id"], false)
	if e != nil {
		return p, e
	}
	alternate, e := battleLivePetID(inside["base_conf_id"], false)
	if e != nil {
		return p, e
	}
	if p.ProtocolBaseID == "" {
		p.ProtocolBaseID = alternate
	} else if alternate != "" && alternate != p.ProtocolBaseID {
		return p, errBattleLive
	}
	p.ProtocolID, e = battleLivePetID(common["conf_id"], false)
	if e != nil {
		return p, e
	}
	alternate, e = battleLivePetID(inside["conf_id"], false)
	if e != nil {
		return p, e
	}
	if p.ProtocolID == "" {
		p.ProtocolID = alternate
	} else if alternate != "" && alternate != p.ProtocolID {
		return p, errBattleLive
	}
	p.InitialSkills, e = battleLiveInitialSkills(inside["skill_round_data"])
	if e != nil {
		return p, e
	}
	p.Level, e = battleLivePtr(common["level"], 1, 100)
	if e != nil {
		return p, e
	}
	p.SpeedMin, e = battleLivePtr(inside["speed_min"], 1, 1<<31-1)
	if e != nil {
		return p, e
	}
	p.SpeedMax, e = battleLivePtr(inside["speed_max"], 1, 1<<31-1)
	if e != nil {
		return p, e
	}
	if p.SpeedMin != nil && p.SpeedMax != nil && *p.SpeedMin > *p.SpeedMax {
		return p, errBattleLive
	}
	attrs, e := battleLiveArray(inside["battle_attr"], 256)
	if e != nil {
		return p, e
	}
	if side != "me" {
		return p, nil
	} // enemy zero vectors/absent direct units are not IV/nature
	if len(attrs) > 6 {
		n, er := battleLiveInt(attrs[6], 0, 1<<31-1, true)
		if er != nil {
			return p, er
		}
		if n > 0 {
			p.Speed = &n
		}
	}
	fields := map[string]string{"hp": "hp", "attack": "attack", "special_attack": "magic_attack", "defense": "defense", "special_defense": "magic_defense", "speed": "speed"}
	own := battleObject(common["attribute_info"])
	for key, stat := range fields {
		row := battleObject(own[key])
		if row["talent"] == nil {
			continue
		}
		n, e := battleLiveInt(row["talent"], 0, 60, true)
		if e != nil {
			return p, e
		}
		if p.IV == nil {
			p.IV = map[string]BattleEvidence{}
		}
		v := float64(n)
		p.IV[stat] = BattleEvidence{Value: &v, Certainty: "direct", Evidence: []string{"Opening attribute_info." + key + ".talent; exact effective IV units."}}
	}
	p.Nature, e = battleLiveNature(common, attrs)
	return p, e
}

// Explicit reviewed NATURE_CONF pairs from our independently authored metadata
// script (commit 727614cc195299cce6b3398c2dd82e23e4db9318). Not array-order guessing.
var battleLiveNaturePairs = map[int][2]int{1: {80, 82}, 2: {80, 81}, 3: {80, 83}, 4: {80, 84}, 5: {80, 79}, 6: {82, 80}, 7: {82, 81}, 8: {82, 83}, 9: {82, 84}, 10: {82, 79}, 11: {81, 80}, 12: {81, 82}, 13: {81, 83}, 14: {81, 84}, 15: {81, 79}, 16: {83, 80}, 17: {83, 82}, 18: {83, 81}, 19: {83, 84}, 20: {83, 79}, 21: {84, 80}, 22: {84, 82}, 23: {84, 81}, 24: {84, 83}, 25: {84, 79}, 26: {79, 80}, 27: {79, 82}, 28: {79, 81}, 29: {79, 83}, 30: {79, 84}}

func battleLiveNature(common map[string]any, attrs []any) (map[string]BattleEvidence, error) {
	if common["nature"] == nil {
		return nil, nil
	}
	n, e := battleLiveInt(common["nature"], 0, 1<<31-1, true)
	if e != nil {
		return nil, e
	}
	pair, ok := battleLiveNaturePairs[n]
	if !ok || len(attrs) <= 84 {
		return nil, nil
	}
	// Missing override fields are unknown, not assumed zero.
	if common["changed_nature_pos_attr_type"] == nil || common["changed_nature_neg_attr_type"] == nil {
		return nil, nil
	}
	pos, e := battleLiveInt(common["changed_nature_pos_attr_type"], 0, 6, true)
	if e != nil {
		return nil, e
	}
	neg, e := battleLiveInt(common["changed_nature_neg_attr_type"], 0, 6, true)
	if e != nil {
		return nil, e
	}
	indices := map[int]int{1: 79, 2: 80, 3: 81, 4: 82, 5: 83, 6: 84}
	if pos > 0 {
		pair[0] = indices[pos]
	}
	if neg > 0 {
		pair[1] = indices[neg]
	}
	if pair[0] == pair[1] {
		return nil, nil
	}
	rawNames := []string{"hp", "attack", "special_attack", "defense", "special_defense", "speed"}
	names := []string{"hp", "attack", "magic_attack", "defense", "magic_defense", "speed"}
	out := map[string]BattleEvidence{}
	own := battleObject(common["attribute_info"])
	for i, name := range names {
		code := 0
		if pair[0] == 79+i {
			code = 1
		}
		if pair[1] == 79+i {
			code = 2
		}
		percent, e := battleLiveSigned(attrs[79+i])
		if e != nil {
			return nil, e
		}
		if percent != []int{0, 2000, -1000}[code] {
			return nil, nil
		}
		row := battleObject(own[rawNames[i]])
		if row["base_value"] == nil || row["effort_add"] == nil {
			return nil, nil
		}
		base, e := battleLiveInt(row["base_value"], 1, 1<<31-1, true)
		if e != nil {
			return nil, e
		}
		effort, e := battleLiveInt(row["effort_add"], 0, 1<<31-1, true)
		if e != nil {
			return nil, e
		}
		actual, e := battleLiveInt(attrs[i+1], 0, 1<<31-1, true)
		if e != nil {
			return nil, e
		}
		expected := (int64(base)*int64([]int{10, 12, 9}[code])+5)/10 + int64(effort)
		if int64(actual) != expected {
			return nil, nil
		}
		value := float64(code)
		out[name] = BattleEvidence{Value: &value, Certainty: "direct", Evidence: []string{"Opening nature configuration + explicit overrides + six independent actual-attribute checks."}}
	}
	return out, nil
}
func (s *battleLiveState) settlement(info, packet map[string]any) error {
	if info == nil {
		return errBattleLive
	}
	rounds, e := battleLiveInt(info["rounds"], 0, 1000000, false)
	if e != nil {
		return e
	}
	if e = battleMergeKnown(&s.Record.Rounds, rounds); e != nil {
		return e
	}
	duration, e := battleLivePtr(info["seconds"], 0, 7*24*60*60)
	if e != nil {
		return e
	}
	if e = battleMergeKnown(&s.Record.DurationSeconds, duration); e != nil {
		return e
	}
	started, e := battleLiveTime(info["enter_battle_time"])
	if e != nil {
		return e
	}
	if e = battleMergeKnown(&s.Record.StartedAt, started); e != nil {
		return e
	}
	if info["real_pvp"] != nil {
		v, e := battleLiveInt(info["real_pvp"], 0, 1, true)
		if e != nil {
			return e
		}
		if v == 1 {
			s.Record.Mode = "pvp"
		}
	}
	// Numeric side means nothing without explicit pet membership. Auxiliary
	// settlement monsters are ignored, never retroactively appended to the roster.
	sides := map[int]string{}
	rows, e := battleLiveArray(info["monster_info"], 128)
	if e != nil {
		return e
	}
	for _, raw := range rows {
		row := battleObject(raw)
		if row == nil {
			return errBattleLive
		}
		id, e := battleLivePetID(row["pet_id"], false)
		if e != nil {
			return e
		}
		side := s.actor(id)
		if side == "unknown" {
			continue
		}
		code, e := battleLiveInt(row["side"], 0, 1, true)
		if e != nil {
			return e
		}
		if old := sides[code]; old != "" && old != side {
			return errBattleLive
		}
		sides[code] = side
		if declared := s.SideCodes[code]; declared != "" && declared != side {
			return errBattleLive
		}
	}
	if sides[0] != "" && sides[0] == sides[1] {
		return errBattleLive
	}
	if info["result"] != nil && info["side"] != nil {
		result, e := battleLiveEnum(info["result"])
		if e != nil {
			return e
		}
		subject, e := battleLiveInt(info["side"], 0, 1, true)
		if e != nil {
			return e
		}
		side := sides[subject]
		outcome := "unknown"
		// Reviewed TrueBattleResult: loss/runaway/quit subject versus winning subject.
		if side != "" {
			switch result {
			case 4, 12, 68, 260:
				if side == "me" {
					outcome = "loss"
				} else {
					outcome = "win"
				}
			case 2, 10, 18, 34, 66:
				if side == "me" {
					outcome = "win"
				} else {
					outcome = "loss"
				}
			}
		}
		if e = battleMergeKnown(&s.Record.Outcome, outcome); e != nil {
			return e
		}
		if outcome == "unknown" {
			battleIssue(&s.Record, fmt.Sprintf("Settlement result %d retained as unknown: unreviewed result semantics or side membership.", result))
		}
	}
	return s.ranks(info, packet)
}
func (s *battleLiveState) ranks(info, packet map[string]any) error {
	rows, e := battleLiveArray(battleObject(info["pvp_mode"])["match_infos"], 24)
	if e != nil {
		return e
	}
	matching := map[string]BattleRank{}
	for _, raw := range rows {
		row := battleObject(raw)
		if row == nil {
			return errBattleLive
		}
		if row["side"] == nil {
			continue
		}
		code, e := battleLiveInt(row["side"], 0, 1, true)
		if e != nil {
			return e
		}
		side := s.SideCodes[code]
		if side == "" {
			continue
		}
		rank, e := battleLiveRank(row, "pvp_rank_")
		if e != nil {
			return e
		}
		if old, ok := matching[side]; ok {
			if e = battleMergeKnown(&old, rank); e != nil {
				return e
			}
			rank = old
		}
		matching[side] = rank
	}
	phase := battleObject(packet["pvp_rank_settle_info"])
	old, e := battleLiveRank(phase, "old_pvp_rank_")
	if e != nil {
		return e
	}
	next, e := battleLiveRank(phase, "new_pvp_rank_")
	if e != nil {
		return e
	}
	candidates := []string{}
	if old.Score != nil && old.Rank != nil && old.Stars != nil {
		for side, r := range matching {
			if r.Score != nil && r.Rank != nil && r.Stars != nil && *old.Score == *r.Score && *old.Rank == *r.Rank && *old.Stars == *r.Stars {
				candidates = append(candidates, side)
			}
		}
	}
	for side, rank := range matching {
		team := s.Record.Sides[side]
		if len(candidates) == 1 && candidates[0] == side {
			if e = battleMergeKnown(&team.Before, old); e != nil {
				return e
			}
			if e = battleMergeKnown(&team.After, next); e != nil {
				return e
			}
		} else {
			if team.Matching == nil {
				team.Matching = &BattleRank{}
			}
			if e = battleMergeKnown(team.Matching, rank); e != nil {
				return e
			}
		}
		s.Record.Sides[side] = team
	}
	return nil
}
func battleLiveRank(row map[string]any, prefix string) (BattleRank, error) {
	var r BattleRank
	var e error
	r.Rank, e = battleLivePtr(row[prefix+"order"], 1, 1<<31-1)
	if e != nil {
		return r, e
	}
	r.Stars, e = battleLivePtr(row[prefix+"star"], 0, 1<<31-1)
	if e != nil {
		return r, e
	}
	if row[prefix+"master_score"] != nil {
		n, e := battleLiveInt(row[prefix+"master_score"], 0, 1<<31-1, true)
		if e != nil {
			return r, e
		}
		v := float64(n)
		r.Score = &v
	}
	return r, nil
}

// Only literal opening type-1 slots 1..4 declare an initial loadout. Executed
// casts, later copied skills, current catalog learnsets and missing slots do not.
func battleLiveInitialSkills(raw any) (*BattleInitialSkills, error) {
	rows, e := battleLiveArray(raw, 64)
	if e != nil {
		return nil, e
	}
	slots := map[int]string{}
	ids := map[int]bool{}
	disclosed := false
	for _, v := range rows {
		m := battleObject(v)
		if m == nil {
			return nil, errBattleLive
		}
		if m["type"] == nil || m["pos"] == nil {
			continue
		}
		typ, e := battleLiveEnum(m["type"])
		if e != nil {
			return nil, e
		}
		if typ != 1 {
			continue
		}
		pos, e := battleLiveInt(m["pos"], 0, 128, true)
		if e != nil {
			return nil, e
		}
		if pos < 1 || pos > 4 {
			continue
		}
		disclosed = true
		runtime, e := battleLivePetID(m["id"], true)
		if e != nil {
			return nil, e
		}
		config, e := battleLivePetID(m["skill_id"], false)
		if e != nil {
			return nil, e
		}
		key := runtime + ":" + config
		if old, ok := slots[pos]; ok && old != key {
			return nil, errBattleLive
		}
		slots[pos] = key
		if id := battleStreamSkillLocal(config); id > 0 {
			ids[id] = true
		}
	}
	if !disclosed || len(ids) == 0 {
		return nil, nil
	}
	out := &BattleInitialSkills{SkillIDs: []int{}, Complete: len(slots) == 4 && len(ids) == 4}
	for id := range ids {
		out.SkillIDs = append(out.SkillIDs, id)
	}
	sort.Ints(out.SkillIDs)
	return out, nil
}

func battleLiveSortPets(r *BattleRecord) {
	for side, team := range r.Sides {
		sort.Slice(team.Pets, func(i, j int) bool { return team.Pets[i].InstanceID < team.Pets[j].InstanceID })
		r.Sides[side] = team
	}
}
