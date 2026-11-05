package main

import (
	"fmt"
	"reflect"
	"strings"
)

// Speed differs from the non-speed +10 hypothesis: enumerate all effective IVs
// and keep equality feasible in either order. Repeating one order is not proof
// of strict speed. Never intersect changed form/level/condition cohorts.
func battleInferenceSpeedSources(r *BattleRecord, events map[string]BattleEvent, badEvents map[string]bool, add func(string, string, string, battleInferenceConstraint), skip func(string, string, string, string)) {
	direct := map[string]bool{}
	for _, side := range []string{"me", "enemy"} {
		for _, p := range r.Sides[side].Pets {
			if p.Speed == nil || *p.Speed < 1 || *p.Speed > 1000000 || battleInferenceInitialLevel(p) == 0 {
				continue
			}
			if _, ok := battleInferencePet(r, side, p.InstanceID); !ok {
				continue
			}
			direct[side+":"+p.InstanceID] = true
			add(side, p.InstanceID, "speed", battleInferenceConstraint{id: "initial-speed:" + p.InstanceID, kind: "speedValue", monster: p.MonsterID, level: *p.Level, damage: *p.Speed, cohort: "initial-speed"})
		}
	}
	seen := map[string]BattleSpeedObservation{}
	bad := map[string]bool{}
	pairRows := map[string]BattleSpeedObservation{}
	badPairs := map[string]bool{}
	for _, o := range r.SpeedObservations {
		if old, ok := seen[o.ID]; ok && !reflect.DeepEqual(old, o) {
			bad[o.ID] = true
		}
		seen[o.ID] = o
		pair := o.MeEvent + "\x00" + o.EnemyEvent
		v := o
		v.ID = ""
		if old, ok := pairRows[pair]; ok && !reflect.DeepEqual(old, v) {
			badPairs[pair] = true
		}
		pairRows[pair] = v
	}
	used := map[string]bool{}
	for _, o := range r.SpeedObservations {
		me, mok := events[o.MeEvent]
		enemy, eok := events[o.EnemyEvent]
		actor := enemy.Actor
		reject := func(reason string) {
			if actor != "" {
				skip("enemy", actor, "speed", reason)
			}
		}
		pair := o.MeEvent + "\x00" + o.EnemyEvent
		if bad[o.ID] || badPairs[pair] || badEvents[o.MeEvent] || badEvents[o.EnemyEvent] {
			reject("速度观察或引用事件冲突")
			continue
		}
		if used[pair] {
			continue
		}
		used[pair] = true
		if !mok || !eok || me.Side != "me" || enemy.Side != "enemy" || me.Round != o.Round || enemy.Round != o.Round || o.Round < 1 || me.Seq != enemy.Seq {
			reject("缺少同回合、同帧可比较行动")
			continue
		}
		if o.ID == "" || o.MeLevel < 1 || o.MeLevel > 99 || o.EnemyLevel < 1 || o.EnemyLevel > 99 || o.MeSpeed < 1 || o.MeSpeed > 1000000 || o.MePriority == nil || o.EnemyPriority == nil || *o.MePriority != *o.EnemyPriority || *o.MePriority < -1000000 || *o.MePriority > 1000000 || !o.PrioritiesVerified || !o.SpeedConditionsVerified || strings.TrimSpace(o.Conditions) == "" || len(o.Evidence) == 0 {
			reject("先制、速度修正或数值未核实")
			continue
		}
		valid := len(o.Evidence) <= 16 && len(o.Conditions) <= 128
		for _, evidence := range o.Evidence {
			if strings.TrimSpace(evidence) == "" || len(evidence) > 512 {
				valid = false
			}
		}
		for _, e := range []BattleEvent{me, enemy} {
			if battleIsStunSkip(e) || e.Kind != "skill" || e.SkillClass != "ordinary" || e.Phase != "executed" || e.ExecIndex == nil || *e.ExecIndex < 0 || e.Seq < 0 {
				valid = false
			}
		}
		if !valid || !battleOneOf(o.First, "me", "enemy") || o.First == "me" && !battleEventBefore(me, enemy) || o.First == "enemy" && !battleEventBefore(enemy, me) {
			reject("速度行动顺序不明确")
			continue
		}
		if _, ok := battleInferencePet(r, "me", me.Actor); !ok {
			reject("我方速度实例不明确")
			continue
		}
		p, ok := battleInferencePet(r, "enemy", enemy.Actor)
		if !ok {
			reject("敌方速度实例不明确")
			continue
		}
		if battleSpeciesAt(r, me) != o.MeMonsterID || battleSpeciesAt(r, enemy) != o.EnemyMonsterID {
			reject("速度快照形态冲突")
			continue
		}
		// Initial directly measured speed wins over conditional order estimates in
		// that same initial cohort. Changed forms remain available as separate DTOs.
		if direct["enemy:"+enemy.Actor] && p.MonsterID == o.EnemyMonsterID && battleInferenceInitialLevel(p) == o.EnemyLevel {
			continue
		}
		cohort := fmt.Sprintf("order:%s:%s:%d:%d:%d:%d:%d:%d:%s", me.Actor, enemy.Actor, o.MeMonsterID, o.EnemyMonsterID, o.MeLevel, o.EnemyLevel, o.MeSpeed, *o.MePriority, o.Conditions)
		add("enemy", enemy.Actor, "speed", battleInferenceConstraint{id: o.ID, kind: "speedOrder", monster: o.EnemyMonsterID, level: o.EnemyLevel, knownStat: float64(o.MeSpeed), before: o.First == "enemy", cohort: cohort})
	}
}
