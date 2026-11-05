package main

import (
	"fmt"
	"sort"
)

func (s *battleLiveState) event(round, seq, index int, kind, actor, target string) BattleEvent {
	return BattleEvent{ID: s.key(round, seq, index, kind, actor+":"+target), Round: round, Seq: seq, ExecIndex: &index, Kind: kind, Phase: "executed", Side: s.actor(actor), Actor: actor, Target: target, TargetSide: func() string {
		if target == "" {
			return ""
		}
		return s.actor(target)
	}()}
}
func (s *battleLiveState) command(cmd map[string]any) error {
	if cmd == nil {
		return nil
	}
	round, e := battleLiveInt(cmd["round"], 1, 1000000, true)
	if e != nil {
		return e
	}
	seq, e := battleLiveInt(cmd["seq_num"], 0, 1000000000, true)
	if e != nil {
		return e
	}
	rows, e := battleLiveArray(cmd["perform_info"], BattleMaxEvents)
	if e != nil {
		return e
	}
	for _, raw := range rows {
		entry := battleObject(raw)
		if entry == nil {
			return errBattleLive
		}
		index, e := battleLiveInt(entry["exec_index"], 0, 1000000000, true)
		if e != nil {
			return e
		}
		typ, e := battleLiveEnum(entry["type"])
		if e != nil {
			return e
		}
		group, e := battleLiveInt(entry["group_id"], 0, 1000000000, false)
		if e != nil {
			return e
		}
		ref, e := battleLiveInt(entry["group_ref"], 0, 1000000000, false)
		if e != nil {
			return e
		}
		head := false
		if entry["is_group_head"] != nil {
			var ok bool
			head, ok = entry["is_group_head"].(bool)
			if !ok {
				return errBattleLive
			}
		}
		syncs, e := battleLiveArray(battleObject(entry["sync_data"])["pet_sync_info"], 128)
		if e != nil {
			return e
		}
		for _, v := range syncs {
			m := battleObject(v)
			if m == nil {
				return errBattleLive
			}
			pid, e := battleLivePetID(m["pet_id"], true)
			if e != nil {
				return e
			}
			key := s.key(round, seq, index, "sync", pid)
			value := s.Sync[key]
			for _, f := range []struct {
				name string
				ptr  **int
			}{{"hp_change", &value.HPChange}, {"hp_result", &value.HPAfter}, {"energy_change", &value.EnergyChange}, {"energy_result", &value.EnergyAfter}, {"damage_result", &value.Damage}} {
				if m[f.name] == nil {
					continue
				}
				n, e := battleLiveSigned(m[f.name])
				if e != nil {
					return e
				}
				if (f.name == "hp_result" || f.name == "energy_result" || f.name == "damage_result") && n < 0 {
					return errBattleLive
				}
				if *f.ptr != nil && **f.ptr != n {
					return errBattleLive
				}
				*f.ptr = &n
			}
			if len(s.Sync) >= BattleMaxEvents {
				return errBattleLive
			}
			s.Sync[key] = value
			resource := s.event(round, seq, index, "resource", pid, "")
			resource.HPChange = value.HPChange
			resource.HPAfter = value.HPAfter
			resource.EnergyChange = value.EnergyChange
			resource.EnergyAfter = value.EnergyAfter
			if resource.HPChange != nil || resource.HPAfter != nil || resource.EnergyChange != nil || resource.EnergyAfter != nil {
				if e = s.put(resource); e != nil {
					return e
				}
			}
		}
		// The primary type selects the branch. Other embedded fragments (for example
		// role_skill_cast + a target-only skill_cast) never become phantom casts.
		branch := map[int]string{1: "skill_cast", 4: "damage_info", 5: "heal_info", 7: "dead_info", 13: "change_pet", 24: "change_model", 35: "data_update", 37: "supply_pet"}[typ]
		if branch == "" {
			continue
		}
		body := battleObject(entry[branch])
		if body == nil {
			return errBattleLive
		}
		var event *BattleEvent
		switch typ {
		case 1:
			actor, e := battleLivePetID(body["caster_id"], false)
			if e != nil {
				return e
			}
			skill, e := battleLivePetID(body["skill_id"], false)
			if e != nil {
				return e
			}
			if actor == "" || skill == "" {
				continue
			}
			castType, e := battleLiveEnum(body["type"])
			if e != nil {
				return e
			}
			if castType < 1 || castType > 3 {
				continue
			}
			v := s.event(round, seq, index, "skill", actor, "")
			v.ID = s.key(round, seq, index, "cast", actor)
			v.ProtocolSkillID = skill
			v.SkillClass = "ordinary"
			if castType == 2 {
				v.Kind = "effect"
				v.SkillClass = "passive"
			}
			if castType == 3 {
				v.SkillClass = "response"
				yes := true
				v.Combat = &BattleCombatEvidence{ResponseAttempt: &yes}
			}
			if skill == "700001000" && castType != 2 {
				v.Kind = "effect"
				v.SkillClass = "system"
				v.Label = "聚能"
				no := false
				v.Combat = &BattleCombatEvidence{IsAttack: &no}
			}
			targets, e := battleLiveArray(body["target_id"], 48)
			if e != nil {
				return e
			}
			unique := map[string]bool{}
			for _, t := range targets {
				id, e := battleLivePetID(t, false)
				if e != nil {
					return e
				}
				if id != "" {
					unique[id] = true
				}
			}
			if len(unique) == 1 {
				for id := range unique {
					v.Target = id
					v.TargetSide = s.actor(id)
				}
			} else if len(unique) > 1 {
				battleIssue(&s.Record, "Multi-target cast counted once; single-target normalized attribution is incomplete.")
			}
			if body["is_interupt"] != nil {
				flag, ok := body["is_interupt"].(bool)
				if !ok {
					return errBattleLive
				}
				if flag {
					v.Phase = "interrupted"
				}
			}
			event = &v
		case 4, 5:
			actor, e := battleLivePetID(body["caster_id"], false)
			if e != nil {
				return e
			}
			target, e := battleLivePetID(body["target_id"], true)
			if e != nil {
				return e
			}
			kind := "damage"
			if typ == 5 {
				kind = "heal"
			}
			v := s.event(round, seq, index, kind, actor, target)
			source, e := battleLivePetID(body["source_id"], false)
			if e != nil {
				return e
			}
			if typ == 4 && body["restraint_type"] != nil {
				tier, e := battleLiveSigned(body["restraint_type"])
				if e != nil {
					return e
				}
				if tier >= -3 && tier <= 3 {
					class := "usual"
					if tier > 0 {
						class = "advantage"
					}
					if tier < 0 {
						class = "resisted"
					}
					v.Combat = &BattleCombatEvidence{EffectivenessClass: class}
				}
			}
			if e = s.link(v.ID, battleLiveLink{Group: group, Source: source, Ref: ref, Head: head}); e != nil {
				return e
			}
			event = &v
		case 7:
			target, e := battleLivePetID(body["target_id"], true)
			if e != nil {
				return e
			}
			v := s.event(round, seq, index, "effect", target, "")
			v.ID = s.key(round, seq, index, "faint", target)
			v.Label = "倒下通知"
			if body["dead_type"] != nil {
				dt, e := battleLiveEnum(body["dead_type"])
				if e != nil {
					return e
				}
				if dt == 0 && s.actor(target) != "unknown" {
					v.Combat = &BattleCombatEvidence{LeaveReason: "defeat"}
				}
			}
			event = &v
		case 13:
			actor, e := battleLivePetID(body["battle_pet_id"], true)
			if e != nil {
				return e
			}
			target, e := battleLivePetID(body["rest_pet_id"], true)
			if e != nil {
				return e
			}
			v := s.event(round, seq, index, "switch", actor, target)
			if v.Side != "unknown" && v.TargetSide != "unknown" && v.Side != v.TargetSide {
				return errBattleLive
			}
			v.Combat = &BattleCombatEvidence{LeaveReason: "unknown"}
			if body["is_cmd"] != nil {
				flag, ok := body["is_cmd"].(bool)
				if !ok {
					return errBattleLive
				}
				if flag {
					v.Combat.LeaveReason = "self"
				}
			}
			if pet := battleObject(body["battle_pet_info"]); pet != nil {
				pid, e := battleLivePetID(battleObject(pet["battle_inside_pet_info"])["pet_id"], true)
				if e != nil || pid != actor {
					return errBattleLive
				}
				if e = s.snapshot(pet, round, seq, index, "entry"); e != nil {
					return e
				}
			}
			event = &v
		case 24:
			actor, e := battleLivePetID(body["pet_id"], true)
			if e != nil {
				return e
			}
			pet := battleObject(body["pet_info"])
			inside := battleObject(pet["battle_inside_pet_info"])
			pid, e := battleLivePetID(inside["pet_id"], true)
			if e != nil || pid != actor {
				return errBattleLive
			}
			from, e := battleLivePetID(body["old_base_id"], true)
			if e != nil {
				return e
			}
			to, e := battleLivePetID(inside["base_conf_id"], true)
			if e != nil {
				return e
			}
			if s.actor(actor) == "unknown" {
				battleIssue(&s.Record, "Form on undisclosed initial instance omitted; it does not prove an initial roster member.")
				continue
			}
			if from != to {
				v := s.event(round, seq, index, "form", actor, "")
				v.Form = &BattleFormChange{FromBaseID: from, ToBaseID: to, ExecIndex: index}
				event = &v
			}
			if e = s.snapshot(pet, round, seq, index, "snapshot"); e != nil {
				return e
			}
		case 35:
			if pet := battleObject(body["pet"]); pet != nil {
				if e = s.snapshot(pet, round, seq, index, "snapshot"); e != nil {
					return e
				}
			}
			others, e := battleLiveArray(battleObject(body["other"])["pets"], 24)
			if e != nil {
				return e
			}
			for _, raw := range others {
				pet := battleObject(raw)
				if pet == nil {
					return errBattleLive
				}
				if e = s.snapshot(pet, round, seq, index, "snapshot"); e != nil {
					return e
				}
			}
			if m := battleObject(body["pet_skill"]); m != nil {
				pid, e := battleLivePetID(m["pet_id"], true)
				if e != nil {
					return e
				}
				if e = s.costs(pid, m["skills"], round, seq, index); e != nil {
					return e
				}
			}
		case 37:
			rows, e := battleLiveArray(body["pet_infos"], 24)
			if e != nil {
				return e
			}
			for _, raw := range rows {
				m := battleObject(raw)
				if m == nil {
					return errBattleLive
				}
				actor, e := battleLivePetID(m["pet_id"], true)
				if e != nil {
					return e
				}
				pet := battleObject(m["pet_info"])
				inside := battleObject(pet["battle_inside_pet_info"])
				pid, e := battleLivePetID(inside["pet_id"], true)
				if e != nil || pid != actor {
					return errBattleLive
				}
				if s.actor(actor) == "unknown" {
					continue
				}
				position, e := battleLiveSigned(m["pet_pos"])
				if e != nil {
					return e
				}
				insidePos, e := battleLiveSigned(inside["pos"])
				if e != nil || insidePos != position {
					return errBattleLive
				}
				if position != 1 {
					continue
				}
				v := s.event(round, seq, index, "effect", actor, "")
				v.ID = s.key(round, seq, index, "supply", actor)
				v.Label = "补位通知"
				if e = s.put(v); e != nil {
					return e
				}
				if e = s.snapshot(pet, round, seq, index, "entry"); e != nil {
					return e
				}
			}
		}
		if event != nil {
			if _, ok := s.Links[event.ID]; !ok {
				if e = s.link(event.ID, battleLiveLink{Group: group, Ref: ref, Head: head}); e != nil {
					return e
				}
			}
			if e = s.put(*event); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *battleLiveState) link(id string, l battleLiveLink) error {
	if old, ok := s.Links[id]; ok {
		if e := battleMergeKnown(&old, l); e != nil {
			return e
		}
		l = old
	}
	s.Links[id] = l
	return nil
}
func (s *battleLiveState) costs(pid string, raw any, round, seq, index int) error {
	if s.actor(pid) == "unknown" {
		return nil
	}
	rows, e := battleLiveArray(raw, 64)
	if e != nil {
		return e
	}
	for _, raw := range rows {
		m := battleObject(raw)
		if m == nil {
			return errBattleLive
		}
		skill, e := battleLivePetID(m["id"], true)
		if e != nil {
			return e
		}
		cost, e := battleLivePtr(m["cost_energy"], 0, 1<<31-1)
		if e != nil {
			return e
		}
		key := s.key(round, seq, index, "cost", pid+":"+skill)
		config, e := battleLivePetID(m["skill_id"], false)
		if e != nil {
			return e
		}
		v := battleLiveCost{Round: round, Seq: seq, Index: index, Actor: pid, Skill: skill, Config: config, Cost: cost}
		if old, ok := s.Costs[key]; ok {
			if e = battleMergeKnown(&old, v); e != nil {
				return e
			}
			v = old
		}
		if len(s.Costs) >= BattleMaxEvents {
			return errBattleLive
		}
		s.Costs[key] = v
	}
	return nil
}
func (s *battleLiveState) snapshot(raw map[string]any, round, seq, index int, stage string) error {
	inside := battleObject(raw["battle_inside_pet_info"])
	common := battleObject(raw["battle_common_pet_info"])
	pid, e := battleLivePetID(inside["pet_id"], true)
	if e != nil {
		return e
	}
	if s.actor(pid) == "unknown" {
		return nil
	}
	if e = s.originalSkills(inside["used_original_skill"]); e != nil {
		return e
	}
	if e = s.costs(pid, inside["skill_round_data"], round, seq, index); e != nil {
		return e
	}
	v := s.event(round, seq, index, "resource", pid, "")
	v.ID = s.key(round, seq, index, "state-"+stage, pid)
	v.StateStage = stage
	attrs, e := battleLiveArray(inside["battle_attr"], 256)
	if e != nil {
		return e
	}
	if len(attrs) > 1 {
		n, e := battleLiveInt(attrs[1], 0, 1<<31-1, true)
		if e != nil {
			return e
		}
		if n > 0 {
			v.HPMax = &n
		}
	}
	if len(attrs) > 25 {
		v.HPAfter, e = battleLivePtr(attrs[25], 0, 1<<31-1)
		if e != nil {
			return e
		}
	}
	v.EnergyAfter, e = battleLivePtr(common["energy"], 0, 1<<31-1)
	if e != nil {
		return e
	}
	if inside["pos"] != nil {
		pos, e := battleLiveSigned(inside["pos"])
		if e != nil {
			return e
		}
		if pos == 1 && v.HPAfter != nil && *v.HPAfter > 0 {
			active := true
			v.StateActive = &active
		} else if pos == -1 {
			active := false
			v.StateActive = &active
		}
	}
	if v.HPMax == nil && v.HPAfter == nil && v.EnergyAfter == nil && v.StateActive == nil {
		return nil
	}
	return s.put(v)
}

// used_original_skill is a reviewed repeated PetSkillRoundData identity source,
// not current cost/initial loadout evidence. Its placeholder costs are ignored.
func (s *battleLiveState) originalSkills(raw any) error {
	rows, e := battleLiveArray(raw, 64)
	if e != nil {
		return e
	}
	for _, v := range rows {
		m := battleObject(v)
		if m == nil {
			return errBattleLive
		}
		runtime, e := battleLivePetID(m["id"], true)
		if e != nil {
			return e
		}
		config, e := battleLivePetID(m["skill_id"], false)
		if e != nil {
			return e
		}
		if config == "" {
			continue
		}
		if old := s.Bindings[runtime]; old != "" && old != config {
			return errBattleLive
		}
		if len(s.Bindings) >= 4096 {
			return errBattleLive
		}
		s.Bindings[runtime] = config
	}
	return nil
}

func battleLivePointBefore(ar, as, ai, br, bs, bi int) bool {
	if ar != br {
		return ar < br
	}
	if as != bs {
		return as < bs
	}
	return ai < bi
}
func (s *battleLiveState) enrichFinal(r *BattleRecord) error {
	battleLiveSortPets(r)
	bindings := map[string]string{}
	for runtime, config := range s.Bindings {
		bindings[runtime] = config
	}
	for _, c := range s.Costs {
		if c.Config != "" {
			if old := bindings[c.Skill]; old != "" && old != c.Config {
				return errBattleLive
			}
			bindings[c.Skill] = c.Config
		}
	}
	for i := range r.Events {
		ev := &r.Events[i]
		if ev.Kind == "skill" && bindings[ev.ProtocolSkillID] != "" {
			config := bindings[ev.ProtocolSkillID]
			if ev.ProtocolSkillConfigID != "" && ev.ProtocolSkillConfigID != config {
				return errBattleLive
			}
			ev.ProtocolSkillConfigID = config
			local := battleStreamSkillLocal(config)
			if ev.SkillID != 0 && local != 0 && ev.SkillID != local {
				return errBattleLive
			}
			if ev.SkillID == 0 {
				ev.SkillID = local
			}
		}
	}
	// User confirmation is independent of same-battle query evidence. Apply it
	// before alias enrichment so a contradictory alias must reject, not override.
	for i := range r.Events {
		if err := battleApplyUserConfirmedSkill(&r.Events[i], nil); err != nil {
			return errBattleLive
		}
	}
	if e := s.enrichSkillAliases(r, bindings); e != nil {
		return e
	}
	// Sort costs independently of arrival order. Same-point observations cannot be
	// used as a prior cost, and an explicit absent updated cost stops propagation.
	costs := make([]battleLiveCost, 0, len(s.Costs))
	for _, v := range s.Costs {
		costs = append(costs, v)
	}
	sort.Slice(costs, func(i, j int) bool {
		a, b := costs[i], costs[j]
		return battleLivePointBefore(a.Round, a.Seq, a.Index, b.Round, b.Seq, b.Index)
	})
	consumed := map[string]bool{}
	maxHP := map[string]int{}
	for i := range r.Events {
		ev := &r.Events[i]
		if ev.ExecIndex == nil {
			continue
		}
		idx := *ev.ExecIndex
		if ev.Kind == "resource" && ev.HPMax != nil {
			maxHP[ev.Actor] = *ev.HPMax
		}
		if !battleIsStunSkip(*ev) && (ev.Kind == "skill" || ev.Kind == "effect" && ev.SkillClass == "system") {
			var cost *int
			for _, c := range costs {
				if c.Actor == ev.Actor && c.Skill == ev.ProtocolSkillID && battleLivePointBefore(c.Round, c.Seq, c.Index, ev.Round, ev.Seq, idx) {
					cost = c.Cost
				}
			}
			sync := s.Sync[s.key(ev.Round, ev.Seq, idx, "sync", ev.Actor)]
			if sync.EnergyChange != nil && *sync.EnergyChange < 0 {
				n := -*sync.EnergyChange
				cost = &n
			}
			ev.EnergyCost = cost
		}
		if ev.Kind != "damage" && ev.Kind != "heal" {
			continue
		}
		key := s.key(ev.Round, ev.Seq, idx, "sync", ev.Target)
		v := s.Sync[key]
		ev.HPChange = v.HPChange
		ev.HPAfter = v.HPAfter
		if ev.Kind == "damage" {
			if v.HPChange != nil && *v.HPChange > 0 {
				return errBattleLive
			}
			if v.Damage != nil {
				n := float64(*v.Damage)
				ev.Amount = &n
			}
		} else if v.HPChange != nil {
			if *v.HPChange < 0 {
				return errBattleLive
			}
			n := float64(*v.HPChange)
			ev.Amount = &n
		}
		if v.HPChange != nil || v.HPAfter != nil {
			if consumed[key] {
				return errBattleLive
			}
			consumed[key] = true
		}
		if ev.Combat == nil {
			ev.Combat = &BattleCombatEvidence{}
		}
		if ev.Kind == "damage" && v.HPChange != nil && v.HPAfter != nil {
			n64 := int64(*v.HPAfter) - int64(*v.HPChange)
			if n64 < 0 || n64 > 1<<31-1 {
				return errBattleLive
			}
			n := int(n64)
			ev.Combat.HPBefore = &n
			if maximum, ok := maxHP[ev.Target]; ok && maximum == n {
				yes := true
				ev.Combat.FullHPBefore = &yes
			}
		}
		l := s.Links[ev.ID]
		matches := []string{}
		if l.Group > 0 && l.Source != "" && ev.Side != "unknown" && ev.TargetSide != "unknown" {
			for j := 0; j < i; j++ {
				c := r.Events[j]
				if c.Round == ev.Round && c.Seq == ev.Seq && c.ExecIndex != nil && *c.ExecIndex < idx && c.Actor == ev.Actor && c.ProtocolSkillID == l.Source && c.Phase == "executed" && !battleIsStunSkip(c) && battleCombatSourceAction(c) && s.Links[c.ID].Group == l.Group {
					matches = append(matches, c.ID)
				}
			}
		}
		if len(matches) == 1 {
			ev.Combat.ActionID = matches[0]
		}
	}
	// Explicit counter group_ref is a causal link; adjacency and target alone are not.
	for i := range r.Events {
		ev := &r.Events[i]
		if battleIsStunSkip(*ev) || ev.Kind != "skill" || ev.SkillClass != "response" || ev.Phase != "executed" || ev.Side == "unknown" {
			continue
		}
		l := s.Links[ev.ID]
		if !l.Head || l.Ref == 0 {
			continue
		}
		matches := []string{}
		for j := range r.Events {
			c := r.Events[j]
			cl := s.Links[c.ID]
			if c.Round == ev.Round && c.Seq == ev.Seq && c.ExecIndex != nil && ev.ExecIndex != nil && *c.ExecIndex < *ev.ExecIndex && cl.Group == l.Ref && cl.Head && !battleIsStunSkip(c) && c.Kind == "skill" && c.Side != "unknown" && c.Side != ev.Side {
				matches = append(matches, c.ID)
			}
		}
		if len(matches) == 1 {
			if ev.Combat == nil {
				ev.Combat = &BattleCombatEvidence{}
			}
			ev.Combat.CounteredActionID = matches[0]
		}
	}
	out := make([]BattleEvent, 0, len(r.Events))
	for _, ev := range r.Events {
		if ev.Kind == "resource" && ev.StateStage == "" && ev.ExecIndex != nil && consumed[s.key(ev.Round, ev.Seq, *ev.ExecIndex, "sync", ev.Actor)] {
			ev.HPChange = nil
			ev.HPAfter = nil
			if ev.EnergyChange == nil && ev.EnergyAfter == nil {
				continue
			}
		}
		if ev.Kind == "damage" && ev.Combat != nil && ev.Combat.ActionID == "" {
			battleIssue(r, "Some damage sources lack a unique same-group executed cast; attribution remains unknown.")
		}
		out = append(out, ev)
	}
	r.Events = out
	if len(r.Events) > BattleMaxEvents {
		return fmt.Errorf("battle event budget exceeded")
	}
	return nil
}
