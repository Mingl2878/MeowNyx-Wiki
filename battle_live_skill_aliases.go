package main

import "strconv"

// Independently authored from audited named 0x1336 fields, not decoder code.
// Both a single query and the accumulated identity facts have a separate budget.
// Neither limit counts executions, changes coverage, nor creates pending battles.
const battleLiveMaxSkillAliases = 4096

func battleLiveSkillAliasKey(round int, caster, runtime string) string {
	return strconv.Itoa(round) + ":" + caster + ":" + runtime
}

// skillAliasQuery runs under Push's lock. Only a unique, currently open battle
// window anchors an ID-less query. Retained completed battles and round-only
// pending states are not anchors. A rejected query leaves all state untouched.
func (a *BattleStreamAssembler) skillAliasQuery(body map[string]any) error {
	// The audited query has no battle_id. If a producer supplies an explicit ID
	// at a known battle context, it must not contradict the active opening.
	contexts := []map[string]any{body, battleObject(body["init_info"]), battleObject(body["state_info"]), battleObject(body["settle_info"])}
	for _, context := range contexts {
		if raw, exists := context["battle_id"]; exists {
			id, err := battleLiveID(raw, true)
			if err != nil || a.active != "" && id != a.active {
				return errBattleLive
			}
		}
	}
	prev := a.states[a.active]
	if a.active == "" || a.aliasActive != a.active || prev == nil || !prev.Open || prev.Finished {
		return nil
	}
	for id, state := range a.states {
		if id != a.active && !state.Finished {
			return nil // overlapping/openless pending context cannot prove association
		}
	}
	s, err := battleLiveCloneState(prev)
	if err != nil {
		return errBattleLive
	}
	if err = s.readSkillAliases(body["items"]); err != nil {
		return errBattleLive
	}
	a.states[a.active] = s
	return nil
}

func (s *battleLiveState) readSkillAliases(raw any) error {
	rows, err := battleLiveArray(raw, battleLiveMaxSkillAliases)
	if err != nil {
		return err
	}
	if s.SkillAliases == nil {
		s.SkillAliases = map[string]string{}
	}
	for _, raw := range rows {
		item := battleObject(raw)
		if item == nil {
			return errBattleLive
		}
		typ, err := battleLiveInt(item["type"], 0, 1<<31-1, true)
		if err != nil {
			return err
		}
		if typ != 1 {
			continue
		}
		op := battleObject(item["skill_op"])
		if op == nil {
			return errBattleLive
		}
		original, err := battleLiveInt(op["original_skill_id"], 0, 1<<32-1, false)
		if err != nil {
			return err
		}
		if original == 0 {
			continue // absent/zero original is no base relationship, including wait
		}
		runtime, err := battleLiveInt(op["skill_id"], 1, 1<<32-1, true)
		if err != nil {
			return err
		}
		// Unlike execution skill_cast.caster_id, this is skill_op.caster: an
		// integer ephemeral pet ID. Do not accept objects, strings or caster_id.
		caster, err := battleLiveInt(op["caster"], 1, 1<<32-1, true)
		if err != nil {
			return err
		}
		round, err := battleLiveInt(op["round"], 1, 1000000, true)
		if err != nil {
			return err
		}
		actor, skill, base := strconv.Itoa(caster), strconv.Itoa(runtime), strconv.Itoa(original)
		key := battleLiveSkillAliasKey(round, actor, skill)
		if old, exists := s.SkillAliases[key]; exists {
			if old != base {
				return errBattleLive
			}
			continue // repeated query observations consume no additional budget
		}
		if len(s.SkillAliases) >= battleLiveMaxSkillAliases {
			return errBattleLive
		}
		// Reject self/cyclic facts in this exact round/actor scope. We never
		// resolve transitively: only a base's direct observed config may be used.
		for next := base; next != ""; next = s.SkillAliases[battleLiveSkillAliasKey(round, actor, next)] {
			if next == skill {
				return errBattleLive
			}
		}
		s.SkillAliases[key] = base
	}
	return nil
}

func (s *battleLiveState) enrichSkillAliases(r *BattleRecord, bindings map[string]string) error {
	// Query has no sequence/exec index: more than one executed cast in its
	// round/caster/runtime scope is ambiguous even across separate commands.
	matches := map[string]int{}
	for _, event := range r.Events {
		if !battleIsStunSkip(event) && event.Kind == "skill" && event.Phase == "executed" {
			matches[battleLiveSkillAliasKey(event.Round, event.Actor, event.ProtocolSkillID)]++
		}
	}
	for i := range r.Events {
		event := &r.Events[i]
		if err := battleValidateUserConfirmedSkill(*event); err != nil {
			return errBattleLive
		}
		if battleIsStunSkip(*event) || event.Kind != "skill" || event.Phase != "executed" || event.SkillClass != "response" {
			continue
		}
		key := battleLiveSkillAliasKey(event.Round, event.Actor, event.ProtocolSkillID)
		if matches[key] != 1 {
			continue
		}
		base := s.SkillAliases[key]
		if base == "" {
			continue
		}
		local := battleStreamSkillLocal(bindings[base])
		if local == 0 {
			continue
		}
		if confirmed := battleUserConfirmedSkillLocal(event.ProtocolSkillID); confirmed != 0 && confirmed != local {
			return errBattleLive
		}
		if event.SkillID != 0 && event.SkillID != local {
			return errBattleLive
		}
		if known := battleStreamSkillLocal(event.ProtocolSkillConfigID); known != 0 && known != local {
			return errBattleLive
		}
		if event.SkillID == 0 {
			event.SkillID = local
		}
		// In particular do NOT write the base config as the response config,
		// change its label/class, infer resources, or infer an initial loadout.
	}
	return nil
}
