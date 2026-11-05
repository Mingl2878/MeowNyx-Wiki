package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	canonicalcatalog "xhmwiki/internal/catalog"
)

const battleInferenceCondition = "effective_iv_60"
const battleInferenceAssumption = "假设该属性有效个体为60（界面+10）；条件唯一，不证明实际个体值"

type BattleInferenceCandidate struct {
	IV     int `json:"iv"`
	Nature int `json:"nature"`
	Value  int `json:"value"`
}
type BattleInferenceDecision struct {
	BattleID       string                     `json:"battleId"`
	Side           string                     `json:"side"`
	InstanceID     string                     `json:"instanceId"`
	MonsterID      int                        `json:"monsterId"`
	Level          int                        `json:"level"`
	Stat           string                     `json:"stat"`
	Status         string                     `json:"status"`
	Condition      string                     `json:"condition,omitempty"`
	Cohort         string                     `json:"cohort,omitempty"`
	Basis          string                     `json:"basis,omitempty"`
	KnownValue     *int                       `json:"knownValue,omitempty"`
	Candidates     []BattleInferenceCandidate `json:"candidates"`
	SourceIDs      []string                   `json:"sourceIDs"`
	Reason         string                     `json:"reason"`
	ProfileApplied bool                       `json:"profileApplied"`
}
type BattleInferenceDTO struct {
	Assumption string                    `json:"assumption"`
	Decisions  []BattleInferenceDecision `json:"decisions"`
	Counts     map[string]int            `json:"counts"`
}

type battleInferenceCatalog map[int]map[string]int

func battleInferenceReadCatalog(data []byte) battleInferenceCatalog {
	value, err := battleSharedCatalogDomain(data, "inference-base-stats-v1", battleInferenceBuildCatalog)
	if err != nil {
		return battleInferenceCatalog{}
	}
	// Private read-only lookup: inference only reads these scalar bases; detached
	// record/profile copies below never retain or mutate this index.
	return value.(battleInferenceCatalog)
}

func battleInferenceBuildCatalog(c *canonicalcatalog.Catalog, _ string) (any, error) {
	out := battleInferenceCatalog{}
	for _, m := range c.Monsters {
		out[m.ID] = map[string]int{"hp": m.Stats.HP, "attack": m.Stats.PhyAtk, "defense": m.Stats.PhyDef, "magic_attack": m.Stats.MagAtk, "magic_defense": m.Stats.MagDef, "speed": m.Stats.Speed}
	}
	return out, nil
}

// This reflection copy preserves absent versus empty fields (and invalid values)
// without mutating or normalizing source data. Inference never writes a store.
func battleInferenceDeepCopy(v reflect.Value) reflect.Value {
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		o := reflect.New(v.Type().Elem())
		o.Elem().Set(battleInferenceDeepCopy(v.Elem()))
		return o
	case reflect.Map:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		o := reflect.MakeMapWithSize(v.Type(), v.Len())
		it := v.MapRange()
		for it.Next() {
			o.SetMapIndex(it.Key(), battleInferenceDeepCopy(it.Value()))
		}
		return o
	case reflect.Slice:
		if v.IsNil() {
			return reflect.Zero(v.Type())
		}
		o := reflect.MakeSlice(v.Type(), v.Len(), v.Len())
		for i := 0; i < v.Len(); i++ {
			o.Index(i).Set(battleInferenceDeepCopy(v.Index(i)))
		}
		return o
	case reflect.Struct:
		o := reflect.New(v.Type()).Elem()
		for i := 0; i < v.NumField(); i++ {
			o.Field(i).Set(battleInferenceDeepCopy(v.Field(i)))
		}
		return o
	default:
		return v
	}
}

// PrepareBattleInference derives independently eligible attribute samples on a
// detached view. It never upgrades quality, overwrites direct evidence, infers a
// missing initial skill, or treats a failed +10 hypothesis as proof of IV0.
func PrepareBattleInference(records []BattleRecord, catalogData []byte) ([]BattleRecord, BattleInferenceDTO) {
	view := battleInferenceDeepCopy(reflect.ValueOf(records)).Interface().([]BattleRecord)
	out := BattleInferenceDTO{Assumption: battleInferenceAssumption, Decisions: []BattleInferenceDecision{}, Counts: map[string]int{}}
	cat := battleInferenceReadCatalog(catalogData)
	seen := map[string]bool{}
	for i := range view {
		rows := battleInferenceRecord(&view[i], cat)
		for _, d := range rows {
			key, _ := json.Marshal(d)
			if seen[string(key)] {
				continue
			}
			seen[string(key)] = true
			out.Decisions = append(out.Decisions, d)
			out.Counts[d.Status]++
		}
	}
	return view, out
}

type battleInferenceConstraint struct {
	id, kind, cohort                                                    string
	monster, level, attackerLevel                                       int
	knownStat, power, reduction, effectiveness, attackMult, defenseMult float64
	damage                                                              int
	before                                                              bool
}

func battleInferenceDirect(m map[string]BattleEvidence, stat string, high int) (int, bool) {
	e, ok := m[stat]
	if !ok || e.Certainty != "direct" || e.Value == nil || !battleFinite(*e.Value, 0, float64(high)) || float64(int(*e.Value)) != *e.Value {
		return 0, false
	}
	return int(*e.Value), true
}
func battleInferenceKnownStat(p BattlePet, cat battleInferenceCatalog, stat string, monster, level int) (int, bool) {
	iv, ik := battleInferenceDirect(p.IV, stat, 60)
	nature, nk := battleInferenceDirect(p.Nature, stat, 2)
	base, bk := cat[monster][stat]
	if !ik || !nk || !bk {
		return 0, false
	}
	v := battleInferenceStat(base, stat, nature, iv, level)
	return v, v > 0
}
func battleInferencePet(r *BattleRecord, side, actor string) (BattlePet, bool) {
	var p BattlePet
	n := 0
	for _, x := range r.Sides[side].Pets {
		if x.InstanceID == actor {
			p = x
			n++
		}
	}
	return p, n == 1
}
func battleInferenceInitialLevel(p BattlePet) int {
	if p.Level != nil && *p.Level >= 1 && *p.Level <= 99 {
		return *p.Level
	}
	return 0
}

func battleInferenceRecord(r *BattleRecord, cat battleInferenceCatalog) []BattleInferenceDecision {
	events := map[string]BattleEvent{}
	badEvents := map[string]bool{}
	for _, e := range r.Events {
		if old, ok := events[e.ID]; ok && !reflect.DeepEqual(old, e) {
			badEvents[e.ID] = true
		}
		events[e.ID] = e
	}
	hitIDs := map[string]map[string]bool{}
	for _, e := range r.Events {
		if e.Kind == "damage" && e.Phase == "executed" && e.Combat != nil && e.Combat.ActionID != "" {
			if hitIDs[e.Combat.ActionID] == nil {
				hitIDs[e.Combat.ActionID] = map[string]bool{}
			}
			hitIDs[e.Combat.ActionID][e.ID] = true
		}
	}
	sources := map[string][]battleInferenceConstraint{}
	reasons := map[string][]string{}
	key := func(side, actor, stat string) string { return side + "\x00" + actor + "\x00" + stat }
	add := func(side, actor, stat string, c battleInferenceConstraint) {
		k := key(side, actor, stat)
		sources[k] = append(sources[k], c)
	}
	skip := func(side, actor, stat, reason string) {
		k := key(side, actor, stat)
		if !battleOneOf(reason, reasons[k]...) {
			reasons[k] = append(reasons[k], reason)
		}
	}
	// Initial absolute HP is a distinct measurement: do not use later full HP,
	// ordinary damage, percentage-only HP or a transformed/delevelled snapshot.
	for _, e := range r.Events {
		if e.Kind != "resource" || e.Phase != "executed" || e.StateStage != "initial" || e.Round != 0 || e.HPMax == nil {
			continue
		}
		p, ok := battleInferencePet(r, e.Side, e.Actor)
		if !ok {
			continue
		}
		if badEvents[e.ID] {
			skip(e.Side, e.Actor, "hp", "初始生命事件ID冲突")
			continue
		}
		if *e.HPMax <= 0 || e.HPAfter != nil && (*e.HPAfter < 0 || *e.HPAfter > *e.HPMax) {
			skip(e.Side, e.Actor, "hp", "初始生命范围冲突")
			continue
		}
		add(e.Side, e.Actor, "hp", battleInferenceConstraint{id: e.ID, kind: "hp", monster: p.MonsterID, level: battleInferenceInitialLevel(p), damage: *e.HPMax, cohort: "initial"})
	}
	// Damage sources require complete explicit snapshot factors, not defaults.
	for _, e := range r.Events {
		if e.Kind != "damage" || e.Phase != "executed" {
			continue
		}
		side, actor, stats := "enemy", e.Actor, []string{"attack", "magic_attack"}
		if e.Side == "me" && e.TargetSide == "enemy" {
			actor = e.Target
			stats = []string{"defense", "magic_defense"}
		} else if e.Side != "enemy" || e.TargetSide != "me" {
			continue
		}
		reject := func(reason string) {
			for _, s := range stats {
				skip(side, actor, s, reason)
			}
		}
		if e.Combat != nil && e.Combat.DamageFormula != nil {
			if e.Combat.DamageFormula.AttackCategory == "physical" {
				stats = stats[:1]
			} else if e.Combat.DamageFormula.AttackCategory == "magic" {
				stats = stats[1:]
			}
		}
		if badEvents[e.ID] {
			reject("伤害事件ID冲突")
			continue
		}
		if !battleInferenceFormulaComplete(e) {
			reject("缺少已核实的单击威力、双方修正与伤害公式快照")
			continue
		}
		f := e.Combat.DamageFormula
		if len(hitIDs[e.Combat.ActionID]) != 1 {
			reject("同一行动有多击或混合目标，不能作单击精确条件")
			continue
		}
		if e.Combat.HPBefore == nil || e.HPAfter == nil || *e.HPAfter <= 0 || *e.Combat.HPBefore < *e.HPAfter {
			reject("缺少未截断的真实HP损失；HP0不作精确伤害")
			continue
		}
		loss := *e.Combat.HPBefore - *e.HPAfter
		if e.HPChange != nil && *e.HPChange != -loss {
			reject("HP前后与变化量冲突")
			continue
		}
		a, aok := events[e.Combat.ActionID]
		if !aok || battleIsStunSkip(a) || badEvents[a.ID] || a.Side != e.Side || a.Actor != e.Actor || a.Phase != "executed" || !battleCombatSourceAction(a) || a.Combat == nil || a.Combat.IsAttack == nil || !*a.Combat.IsAttack || !battleEventBefore(a, e) || a.Round != e.Round {
			reject("缺少可归属的已执行攻击")
			continue
		}
		ap, aok := battleInferencePet(r, e.Side, e.Actor)
		dp, dok := battleInferencePet(r, e.TargetSide, e.Target)
		if !aok || !dok {
			reject("攻击或受击实例不明确")
			continue
		}
		at := e
		dt := e
		dt.Side = e.TargetSide
		dt.Actor = e.Target
		if battleSpeciesAt(r, at) != f.AttackerMonsterID || battleSpeciesAt(r, dt) != f.DefenderMonsterID {
			reject("伤害快照形态与事件不一致")
			continue
		}
		own, ownStat, ownMonster, ownLevel := dp, "defense", f.DefenderMonsterID, f.DefenderLevel
		c := battleInferenceConstraint{id: e.ID, kind: "damageDealt", monster: f.AttackerMonsterID, level: f.AttackerLevel, attackerLevel: f.AttackerLevel, power: *f.Power, reduction: *f.Reduction, effectiveness: *f.Effectiveness, attackMult: *f.AttackMultiplier, defenseMult: *f.DefenseMultiplier, damage: loss, cohort: "damage"}
		if e.Side == "me" {
			own, ownStat, ownMonster, ownLevel = ap, "attack", f.AttackerMonsterID, f.AttackerLevel
			c.kind = "damageReceived"
			c.monster = f.DefenderMonsterID
			c.level = f.DefenderLevel
		}
		if f.AttackCategory == "magic" {
			ownStat = "magic_" + ownStat
		}
		value, known := battleInferenceKnownStat(own, cat, ownStat, ownMonster, ownLevel)
		if !known {
			reject("我方对侧属性缺少直接个体/性格事实")
			continue
		}
		c.knownStat = float64(value)
		add(side, actor, stats[0], c)
	}
	// Legacy normalized constraints are accepted only with their full declaration.
	// Their old schema has no hit form; don't borrow initial identity after a form.
	cs := map[string]BattleConstraint{}
	badC := map[string]bool{}
	for _, c := range r.Constraints {
		if old, ok := cs[c.ID]; ok && !reflect.DeepEqual(old, c) {
			badC[c.ID] = true
		}
		cs[c.ID] = c
	}
	for _, c := range r.Constraints {
		p, ok := battleInferencePet(r, c.Side, c.InstanceID)
		if !ok {
			continue
		}
		if c.Stat == "speed" && p.Speed != nil && *p.Speed >= 1 && *p.Speed <= 1000000 {
			continue // a measured initial speed outranks a conditional order declaration
		}
		if badC[c.ID] || !battleInferenceNormalizedValid(c, p) {
			skip(c.Side, c.InstanceID, c.Stat, "规范化条件不完整或冲突")
			continue
		}
		formChanged := false
		for _, e := range r.Events {
			if e.Kind == "form" && e.Phase == "executed" && e.Side == c.Side && e.Actor == c.InstanceID && e.Round <= c.Round {
				formChanged = true
			}
		}
		if formChanged {
			skip(c.Side, c.InstanceID, c.Stat, "旧条件缺少变形后的明确形态/等级")
			continue
		}
		kind := c.Kind
		damage := 0
		if c.Damage != nil {
			damage = *c.Damage
		}
		cohort := "normalized"
		if c.Stat == "speed" {
			cohort = fmt.Sprintf("normalized:%d:%g:%s", c.Round, c.KnownStat, c.Provenance)
		}
		add(c.Side, c.InstanceID, c.Stat, battleInferenceConstraint{id: c.ID, kind: kind, monster: p.MonsterID, level: battleInferenceInitialLevel(p), attackerLevel: c.Level, knownStat: c.KnownStat, power: c.Power, reduction: c.Reduction, effectiveness: c.Effectiveness, attackMult: 1, defenseMult: 1, damage: damage, before: c.Before, cohort: cohort})
	}
	battleInferenceSpeedSources(r, events, badEvents, add, skip)
	rows := []BattleInferenceDecision{}
	for _, side := range []string{"me", "enemy"} {
		s := r.Sides[side]
		for pi := range s.Pets {
			p := &s.Pets[pi]
			// Recompute our own prior conditional view evidence; a stale projection must
			// not survive a missing source or changed catalog. Direct facts are untouched.
			for _, m := range []map[string]BattleEvidence{p.IV, p.Nature} {
				for stat, e := range m {
					derived := e.Condition == battleInferenceCondition || len(e.Evidence) > 0 && strings.HasPrefix(e.Evidence[0], "battle-inference:")
					if derived && e.Certainty != "direct" {
						delete(m, stat)
					}
				}
			}
			for _, stat := range battleStatKeys {
				k := key(side, p.InstanceID, stat)
				ds := battleInferenceDecide(r.ID, side, *p, stat, sources[k], reasons[k], cat)
				// Distinct speed condition groups must not pool votes into a singleton.
				eligible := []int{}
				for i, d := range ds {
					if d.Status == "unique" && d.MonsterID == p.MonsterID && d.Level == battleInferenceInitialLevel(*p) {
						eligible = append(eligible, i)
					}
				}
				if len(eligible) > 0 {
					chosen := eligible[0]
					v := ds[chosen].Candidates[0]
					compatible := true
					for _, d := range ds {
						if d.MonsterID != p.MonsterID || d.Level != battleInferenceInitialLevel(*p) {
							continue
						}
						if d.Status == "no_solution" {
							compatible = false
						}
						if len(d.Candidates) > 0 {
							found := false
							for _, c := range d.Candidates {
								if c.IV == v.IV && c.Nature == v.Nature {
									found = true
								}
							}
							if !found {
								compatible = false
							}
						}
					}
					if compatible {
						battleInferenceApply(p, stat, v, ds[chosen])
						ds[chosen].ProfileApplied = true
					}
				}
				rows = append(rows, ds...)
			}
		}
		r.Sides[side] = s
	}
	return rows
}

func battleInferenceNormalizedValid(c BattleConstraint, p BattlePet) bool {
	if c.ID == "" || !c.ModifiersKnown || strings.TrimSpace(c.Provenance) == "" || !battleFinite(c.KnownStat, 0.000001, 1000000) || battleInferenceInitialLevel(p) == 0 || c.Round < 1 {
		return false
	}
	if c.Kind == "speedOrder" {
		return c.Stat == "speed" && c.SamePriority
	}
	if !(c.Kind == "damageDealt" && battleOneOf(c.Stat, "attack", "magic_attack") || c.Kind == "damageReceived" && battleOneOf(c.Stat, "defense", "magic_defense")) {
		return false
	}
	return c.Damage != nil && *c.Damage >= 0 && *c.Damage <= 100000000 && battleFinite(c.Power, 0.000001, 1000000) && battleFinite(c.Reduction, 0.000001, 1) && battleFinite(c.Effectiveness, 0.000001, 4) && c.Level >= 1 && c.Level <= 99 && (c.Kind != "damageDealt" || c.Level == *p.Level)
}

func battleInferenceDecide(battleID, side string, p BattlePet, stat string, conditions []battleInferenceConstraint, reasons []string, cat battleInferenceCatalog) []BattleInferenceDecision {
	baseD := BattleInferenceDecision{BattleID: battleID, Side: side, InstanceID: p.InstanceID, MonsterID: p.MonsterID, Level: battleInferenceInitialLevel(p), Stat: stat, Status: "insufficient", Candidates: []BattleInferenceCandidate{}, SourceIDs: []string{}, Reason: "缺少有效条件"}
	if stat != "speed" {
		baseD.Condition = battleInferenceCondition
	}
	iv, ik := battleInferenceDirect(p.IV, stat, 60)
	n, nk := battleInferenceDirect(p.Nature, stat, 2)
	if stat != "speed" && ik && iv != 60 {
		baseD.Status = "direct_non60"
		baseD.Condition = ""
		baseD.Reason = "直接个体事实不符合+10假设；仅排除此属性的条件推断，直接事实保留"
		return []BattleInferenceDecision{baseD}
	}
	if ik && nk {
		baseD.Status = "direct"
		baseD.Condition = ""
		baseD.Reason = "保留直接个体与性格事实"
		return []BattleInferenceDecision{baseD}
	}
	if len(conditions) == 0 {
		if len(reasons) > 0 {
			baseD.Reason = strings.Join(reasons, "；")
		}
		return []BattleInferenceDecision{baseD}
	}
	groups := map[string][]battleInferenceConstraint{}
	order := []string{}
	for _, c := range conditions {
		cohort := c.cohort
		if stat != "speed" {
			cohort = "profile"
		} // fully specified damage factors may differ without pooling snapshots
		g := fmt.Sprintf("%d/%d/%s", c.monster, c.level, cohort)
		if _, ok := groups[g]; !ok {
			order = append(order, g)
		}
		duplicate := false
		for _, old := range groups[g] {
			if reflect.DeepEqual(old, c) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			groups[g] = append(groups[g], c)
		}
	}
	sort.Strings(order)
	out := []BattleInferenceDecision{}
	for _, g := range order {
		cs := groups[g]
		d := baseD
		if stat == "speed" {
			d.Basis = "verified-order"
			if cs[0].kind == "speedValue" {
				v := cs[0].damage
				d.KnownValue = &v
				d.Basis = "recorded-speed"
			}
		}
		d.Cohort = g
		d.MonsterID = cs[0].monster
		d.Level = cs[0].level
		d.SourceIDs = []string{}
		for _, c := range cs {
			if !battleOneOf(c.id, d.SourceIDs...) {
				d.SourceIDs = append(d.SourceIDs, c.id)
			}
		}
		sort.Strings(d.SourceIDs)
		base, ok := cat[d.MonsterID][stat]
		if !ok || base < 0 || base > 10000 || d.Level < 1 || d.Level > 99 {
			d.Reason = "缺少可靠的形态资质或记录等级"
			out = append(out, d)
			continue
		}
		if len(cs) > 128 {
			d.Reason = "条件数量超过可验证上限"
			out = append(out, d)
			continue
		}
		firstIV := 60
		if stat == "speed" {
			firstIV = 0
		}
		for i := firstIV; i <= 60; i++ {
			for nature := 0; nature <= 2; nature++ {
				if ik && i != iv || nk && nature != n {
					continue
				}
				v := battleInferenceStat(base, stat, nature, i, d.Level)
				matches := true
				for _, c := range cs {
					switch c.kind {
					case "hp", "speedValue":
						matches = v == c.damage
					case "speedOrder":
						if c.before {
							matches = float64(v) >= c.knownStat
						} else {
							matches = float64(v) <= c.knownStat
						}
					case "damageDealt":
						matches = battleInferenceDamage(float64(v), c.power, c.knownStat, c.reduction, c.effectiveness, c.attackMult, c.defenseMult, c.attackerLevel) == c.damage
					case "damageReceived":
						matches = battleInferenceDamage(c.knownStat, c.power, float64(v), c.reduction, c.effectiveness, c.attackMult, c.defenseMult, c.attackerLevel) == c.damage
					default:
						matches = false
					}
					if !matches {
						break
					}
				}
				if matches {
					d.Candidates = append(d.Candidates, BattleInferenceCandidate{IV: i, Nature: nature, Value: v})
				}
			}
		}
		switch len(d.Candidates) {
		case 0:
			d.Status = "no_solution"
			d.Reason = "当前条件模型无解；可能存在未记录修正，不证明实际没有个体"
		case 1:
			d.Status = "unique"
			d.Reason = "联合个体/性格仅一个候选"
			if stat != "speed" {
				d.Reason = battleInferenceAssumption
			}
		default:
			d.Status = "multiple"
			d.Reason = "多个联合候选；该属性不纳入推断分布"
		}
		if d.Basis == "recorded-speed" {
			d.Reason = fmt.Sprintf("直接记录开场速度%d；%s", *d.KnownValue, d.Reason)
		}
		if d.MonsterID != p.MonsterID || d.Level != battleInferenceInitialLevel(p) {
			d.Reason += "；非初始形态/等级分组，不回填初始配置"
		}
		out = append(out, d)
	}
	return out
}

func battleInferenceApply(p *BattlePet, stat string, c BattleInferenceCandidate, d BattleInferenceDecision) {
	if p.IV == nil {
		p.IV = map[string]BattleEvidence{}
	}
	if p.Nature == nil {
		p.Nature = map[string]BattleEvidence{}
	}
	evidence := []string{"battle-inference: joint singleton; " + d.Reason}
	for _, s := range d.SourceIDs {
		if len(evidence) >= 128 {
			break
		}
		if len(s) > 500 {
			s = s[:500]
		}
		evidence = append(evidence, s)
	}
	for _, x := range []struct {
		m map[string]BattleEvidence
		v int
	}{{p.IV, c.IV}, {p.Nature, c.Nature}} {
		if x.m[stat].Certainty == "direct" {
			continue
		}
		v := float64(x.v)
		x.m[stat] = BattleEvidence{Value: &v, Certainty: "unique", Candidates: []float64{v}, Condition: d.Condition, Evidence: append([]string{}, evidence...)}
	}
}
