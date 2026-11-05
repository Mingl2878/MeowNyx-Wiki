package main

import "errors"

// Combat is an additive normalized evidence envelope, never a statistics result.
// Percent-only full HP is distinct from an absolute HP value. Neither an HP
// estimate nor a guessed configuration is persisted here.
type BattleCombatEvidence struct {
	ActionKind         string               `json:"actionKind,omitempty"`
	TypeID             *int                 `json:"typeId,omitempty"`
	ActionID           string               `json:"actionId,omitempty"`
	IsAttack           *bool                `json:"isAttack,omitempty"`
	ResponseAttempt    *bool                `json:"responseAttempt,omitempty"`
	CounteredActionID  string               `json:"counteredActionId,omitempty"`
	EffectivenessClass string               `json:"effectivenessClass,omitempty"`
	Effectiveness      *float64             `json:"effectiveness,omitempty"`
	HPBefore           *int                 `json:"hpBefore,omitempty"`
	FullHPBefore       *bool                `json:"fullHpBefore,omitempty"`
	LeaveReason        string               `json:"leaveReason,omitempty"`
	DamageFormula      *BattleDamageFormula `json:"damageFormula,omitempty"`
}

func battleCombatCopy[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}
func battleCombatClone(c *BattleCombatEvidence) *BattleCombatEvidence {
	if c == nil {
		return nil
	}
	v := *c
	v.TypeID = battleCombatCopy(c.TypeID)
	v.IsAttack = battleCombatCopy(c.IsAttack)
	v.ResponseAttempt = battleCombatCopy(c.ResponseAttempt)
	v.Effectiveness = battleCombatCopy(c.Effectiveness)
	v.HPBefore = battleCombatCopy(c.HPBefore)
	v.FullHPBefore = battleCombatCopy(c.FullHPBefore)
	v.DamageFormula = battleInferenceFormulaClone(c.DamageFormula)
	return &v
}

// This checks the retained raw source representation, not statistical action
// eligibility. Old explicit links remain readable; derived consumers separately
// exclude battleIsStunSkip without deleting their damage/resource evidence.
func battleCombatSourceAction(e BattleEvent) bool {
	return e.Kind == "skill" || e.Kind == "effect" && battleOneOf(e.SkillClass, "system", "passive")
}
func battleCombatRecordsValid(r *BattleRecord) error {
	events := map[string]BattleEvent{}
	roster := map[string]map[string]bool{"me": {}, "enemy": {}}
	for side, s := range r.Sides {
		for _, p := range s.Pets {
			roster[side][p.InstanceID] = true
		}
	}
	for _, e := range r.Events {
		events[e.ID] = e
	}
	counterEdges := map[string]string{}
	for _, e := range r.Events {
		if err := battleInferenceFormulaValid(e); err != nil {
			return err
		}
		c := e.Combat
		if c == nil {
			continue
		}
		if c.ActionKind != "" {
			if c.ActionKind != "wishImpact" || !(e.Kind == "skill" || e.Kind == "effect" && e.SkillClass == "system") || !battleOneOf(e.Phase, "executed", "interrupted") {
				return errors.New("invalid special action evidence")
			}
			if e.ProtocolSkillID == "700001000" {
				return errors.New("charge cannot be wish impact")
			}
		}
		if c.TypeID != nil && (c.ActionKind != "wishImpact" || *c.TypeID < 1 || *c.TypeID > 18) {
			return errors.New("wish impact type must be a known local type or absent")
		}
		if !battleID(c.ActionID, false) || !battleID(c.CounteredActionID, false) {
			return errors.New("invalid combat action reference")
		}
		if c.IsAttack != nil {
			if !battleCombatSourceAction(e) || !battleOneOf(e.Phase, "executed", "interrupted") {
				return errors.New("attack classification requires a recorded action")
			}
			if *c.IsAttack && e.Kind == "effect" && e.SkillClass != "system" {
				return errors.New("a passive effect is not an attack action")
			}
		}
		if c.ResponseAttempt != nil && (e.Kind != "skill" || !battleOneOf(e.Phase, "executed", "interrupted")) {
			return errors.New("response attempt requires a recorded skill action")
		}
		if c.ResponseAttempt != nil && !*c.ResponseAttempt && e.SkillClass == "response" && e.Phase == "executed" {
			return errors.New("an executed response is also an attempt")
		}
		if c.EffectivenessClass != "" && !battleOneOf(c.EffectivenessClass, "advantage", "resisted", "usual") {
			return errors.New("invalid damage effectiveness class")
		}
		if c.Effectiveness != nil && !battleFinite(*c.Effectiveness, 0, 64) {
			return errors.New("invalid damage effectiveness")
		}
		if c.Effectiveness != nil && c.EffectivenessClass != "" {
			class := "usual"
			if *c.Effectiveness > 1 {
				class = "advantage"
			} else if *c.Effectiveness < 1 {
				class = "resisted"
			}
			if class != c.EffectivenessClass {
				return errors.New("conflicting damage effectiveness declarations")
			}
		}
		if (c.Effectiveness != nil || c.EffectivenessClass != "" || c.FullHPBefore != nil || c.HPBefore != nil) && (e.Kind != "damage" || e.Phase != "executed") {
			return errors.New("damage evidence requires executed damage")
		}
		if c.HPBefore != nil && (*c.HPBefore < 0 || *c.HPBefore > 2147483647) {
			return errors.New("invalid HP before damage")
		}
		if c.HPBefore != nil && c.FullHPBefore != nil && *c.FullHPBefore && *c.HPBefore == 0 {
			return errors.New("conflicting full HP evidence")
		}
		if c.HPBefore != nil && e.HPChange != nil && e.HPAfter != nil && int64(*c.HPBefore)+int64(*e.HPChange) != int64(*e.HPAfter) {
			return errors.New("conflicting HP before, delta and result")
		}
		if c.LeaveReason != "" {
			if !battleOneOf(c.LeaveReason, "defeat", "forced", "voluntary", "self", "unknown") || e.Phase != "executed" {
				return errors.New("invalid departure reason")
			}
			if c.LeaveReason == "defeat" {
				if e.Kind == "switch" {
					if !roster[e.Side][e.Target] {
						return errors.New("defeat switch requires a known outgoing instance")
					}
				} else if e.Kind != "effect" || !roster[e.Side][e.Actor] {
					return errors.New("defeat evidence requires a roster instance effect")
				}
			} else if e.Kind != "switch" {
				return errors.New("departure reason requires a switch")
			}
		}
		if c.ActionID != "" {
			a, ok := events[c.ActionID]
			if !ok || a.ID == e.ID || !battleCombatSourceAction(a) || a.Phase != "executed" || !roster[a.Side][a.Actor] || !battleEventBefore(a, e) {
				return errors.New("combat source is not a preceding known action")
			}
			if !battleOneOf(e.Kind, "damage", "heal", "effect", "switch") || e.Phase != "executed" {
				return errors.New("unsupported combat source association")
			}
			if battleOneOf(e.Kind, "damage", "heal") && (e.Side != a.Side || e.Actor != a.Actor || !roster[e.TargetSide][e.Target]) {
				return errors.New("combat source actor or target mismatch")
			}
		}
		if c.CounteredActionID != "" {
			a, ok := events[c.CounteredActionID]
			if e.Kind != "skill" || e.SkillClass != "response" || e.Phase != "executed" || c.ResponseAttempt != nil && !*c.ResponseAttempt {
				return errors.New("counter evidence requires an executed response")
			}
			if !ok || a.ID == e.ID || a.Round != e.Round || !battleOneOf(a.Phase, "executed", "interrupted") || !(battleCombatSourceAction(a) || a.Kind == "switch") || a.Side == e.Side || !roster[e.Side][e.Actor] || !roster[a.Side][a.Actor] {
				return errors.New("counter reference has wrong action, round or side")
			}
			counterEdges[e.ID] = a.ID
		}
	}
	seen := map[string]int{}
	var visit func(string) bool
	visit = func(id string) bool {
		if seen[id] == 1 {
			return false
		}
		if seen[id] == 2 {
			return true
		}
		seen[id] = 1
		if next := counterEdges[id]; next != "" && !visit(next) {
			return false
		}
		seen[id] = 2
		return true
	}
	for id := range counterEdges {
		if !visit(id) {
			return errors.New("cyclic response references")
		}
	}
	return nil
}
func battleMergeCombatFields(a, b *BattleEvent) error {
	if a.Combat == nil && b.Combat == nil {
		return nil
	}
	x := battleCombatClone(a.Combat)
	if x == nil {
		x = &BattleCombatEvidence{}
	}
	if b.Combat != nil {
		y := battleCombatClone(b.Combat)
		// "unknown" records the absence of a departure explanation, not a
		// competing known cause. Later evidence can fill it, but two known
		// reasons still conflict and a stale unknown can never erase a cause.
		if x.LeaveReason == "unknown" && y.LeaveReason != "" && y.LeaveReason != "unknown" {
			x.LeaveReason = ""
		}
		if y.LeaveReason == "unknown" && x.LeaveReason != "" && x.LeaveReason != "unknown" {
			y.LeaveReason = ""
		}
		if err := battleMergeKnown(x, *y); err != nil {
			return err
		}
	}
	a.Combat = battleCombatClone(x)
	b.Combat = battleCombatClone(x)
	return nil
}
