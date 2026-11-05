package main

import (
	"sort"
	"strings"
)

// These are read-only entry projections, never normalized events. Known means
// the count of qualified observations is known; coverage distinguishes a lower
// bound from a complete prefix. Neither one claims whole-battle effect coverage.
type BattleGrowthHistory struct {
	Entries []BattleGrowthEntrySnapshot `json:"entries"`
	Audit   []BattleGrowthTraitAudit    `json:"audit"`
}
type BattleGrowthEntrySnapshot struct {
	EventID          string                      `json:"eventId"`
	Round            int                         `json:"round"`
	Seq              int                         `json:"seq"`
	ExecIndex        *int                        `json:"execIndex"`
	Side             string                      `json:"side"`
	Actor            string                      `json:"actor"`
	MonsterID        int                         `json:"monsterId"`
	TraitID          string                      `json:"traitId"`
	Name             string                      `json:"name"`
	Unit             string                      `json:"unit"`
	Count            *int                        `json:"count"`
	Known            bool                        `json:"known"`
	Coverage         BattleGrowthHistoryCoverage `json:"coverage"`
	DerivedBasis     string                      `json:"derivedBasis"`
	EvidenceEventIDs []string                    `json:"evidenceEventIds"`
}
type BattleGrowthHistoryCoverage struct {
	Mode           string `json:"mode"`
	Complete       bool   `json:"complete"`
	UnknownActions int    `json:"unknownActions"`
	AmbiguousOrder int    `json:"ambiguousOrder"`
}
type BattleGrowthTraitAudit struct {
	TraitID     string `json:"traitId"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Derive      string `json:"derive"`
	Supported   bool   `json:"supported"`
	Note        string `json:"note"`
}

func battleGrowthHistorical(derive string) bool { return strings.HasPrefix(derive, "history") }
func battleGrowthAuditNote(rule battleGrowthTraitRule) string {
	if battleGrowthHistorical(rule.derive) {
		return "Exact reviewed condition; qualified executed actions strictly before each explicit entry. Partial captures expose an observed-prefix lower bound."
	}
	if rule.derive != "" {
		return "Existing complete-action derivation; not an entry-history condition."
	}
	switch rule.name {
	case "洄游":
		return "Needs explicit entry into charged state; casts/charge energy do not prove this state."
	case "合拍":
		return "Needs paired round actions and confirmed round-end enactment; no round-end growth is guessed."
	case "光度换算", "猫精灵的礼物":
		return "Needs explicit choice branch/completion evidence; ordinary casts do not prove the branch."
	case "花精灵":
		return "Needs confirmed round-end offering enactment; round-start/finish/settlement is insufficient."
	case "坚韧铠甲":
		return "Needs confirmed attack-damage trigger/offering enactment; HP loss or multihit messages alone are insufficient."
	}
	return "Unsupported condition; explicit typed growth evidence remains available."
}

// BuildBattleGrowthHistory validates an isolated clone and uses one immutable
// catalog. It neither reads a player profile nor changes the original JSON.
func BuildBattleGrowthHistory(record BattleRecord, catalogData []byte) *BattleGrowthHistory {
	cat := battleGrowthReadCatalog(catalogData)
	out := &BattleGrowthHistory{Entries: []BattleGrowthEntrySnapshot{}, Audit: []BattleGrowthTraitAudit{}}
	for _, rule := range battleGrowthTraitRules {
		verified, ok := cat.traits[rule.id]
		derive := ""
		if ok {
			derive = verified.derive
		}
		note := battleGrowthAuditNote(rule)
		if !ok || derive != rule.derive {
			note = "Canonical identity/name/description guard failed; derivation disabled."
		}
		out.Audit = append(out.Audit, BattleGrowthTraitAudit{rule.id, rule.name, rule.description, derive, derive != "", note})
	}
	r, err := battleClone(record)
	if err != nil || ValidateBattleRecord(&r) != nil {
		return out
	}
	out.Entries = battleGrowthHistoryEntries(r, cat)
	return out
}

func battleGrowthHistoryEntries(r BattleRecord, cat battleGrowthCatalog) []BattleGrowthEntrySnapshot {
	out := []BattleGrowthEntrySnapshot{}
	v := battleGrowthRecordView{r: r, cat: cat, pets: map[battleGrowthActor]BattlePet{}}
	forms := map[battleGrowthActor][]BattleEvent{}
	for side, s := range r.Sides {
		for _, p := range s.Pets {
			v.pets[battleGrowthActor{side, p.InstanceID}] = p
		}
	}
	for _, e := range r.Events {
		if e.Kind == "form" && e.Phase == "executed" && e.Form != nil {
			a := battleGrowthActor{e.Side, e.Actor}
			forms[a] = append(forms[a], e)
		}
	}
	for a := range forms {
		sort.SliceStable(forms[a], func(i, j int) bool { return battleEventBefore(forms[a][i], forms[a][j]) })
	}
	appendEntry := func(e BattleEvent, initial bool) {
		a := battleGrowthActor{e.Side, e.Actor}
		p, ok := v.pets[a]
		if !ok {
			return
		}
		monster := p.MonsterID
		if !initial {
			monster = battleGrowthSourceSpecies(monster, e, forms[a])
		}
		rule, ok := cat.traits[cat.native[monster]]
		if !ok {
			return
		}
		unit := "次"
		if rule.derive == "historyWater" {
			unit = "层"
		} else if rule.derive == "historyDistinctType" {
			unit = "种系别"
		}
		s := BattleGrowthEntrySnapshot{EventID: e.ID, Round: e.Round, Seq: e.Seq, ExecIndex: e.ExecIndex, Side: e.Side, Actor: e.Actor, MonsterID: monster, TraitID: rule.id, Name: rule.name, Unit: unit, Coverage: BattleGrowthHistoryCoverage{Mode: "unknown"}, DerivedBasis: rule.derive, EvidenceEventIDs: []string{}}
		if battleGrowthHistorical(rule.derive) {
			battleGrowthPrefix(&s, e, initial, v, rule)
		}
		out = append(out, s)
	}
	// Only explicit lead/entry/supply declarations seed entries. Forms, HP0,
	// skill casts and bench snapshots are never another entry.
	for _, side := range []string{"me", "enemy"} {
		s := r.Sides[side]
		if r.Quality.Lead[side] && s.Lead != "" {
			appendEntry(BattleEvent{Side: side, Actor: s.Lead}, true)
		}
	}
	presence := []BattleEvent{}
	for _, e := range r.Events {
		if e.Phase != "executed" {
			continue
		}
		if e.Kind == "switch" || battlePerformanceSupply(e) || e.Kind == "resource" && e.StateActive != nil && (e.StateStage == "entry" || !*e.StateActive) || battlePerformanceFaint(e) || e.Kind == "effect" && e.Combat != nil && e.Combat.LeaveReason == "defeat" {
			presence = append(presence, e)
		}
	}
	sort.SliceStable(presence, func(i, j int) bool { return battleEventBefore(presence[i], presence[j]) })
	active := map[string]string{}
	for _, side := range []string{"me", "enemy"} {
		if r.Quality.Lead[side] {
			active[side] = r.Sides[side].Lead
		}
	}
	presenceFrames := map[string]map[[2]int][]BattleEvent{}
	for _, e := range presence {
		if presenceFrames[e.Side] == nil {
			presenceFrames[e.Side] = map[[2]int][]BattleEvent{}
		}
		frame := [2]int{e.Round, e.Seq}
		presenceFrames[e.Side][frame] = append(presenceFrames[e.Side][frame], e)
	}
	for _, e := range presence {
		ambiguous := false
		for _, other := range presenceFrames[e.Side][[2]int{e.Round, e.Seq}] {
			if e.ID != other.ID && !battleEventBefore(e, other) && !battleEventBefore(other, e) {
				ambiguous = true
				break
			}
		}
		if ambiguous {
			delete(active, e.Side)
			continue
		}
		if e.Kind == "switch" {
			if e.Target == "" || e.Target == e.Actor || e.TargetSide != "" && e.TargetSide != e.Side {
				delete(active, e.Side)
				continue
			}
			if active[e.Side] != e.Actor {
				appendEntry(e, false)
			}
			active[e.Side] = e.Actor
		} else if battlePerformanceSupply(e) || e.Kind == "resource" && e.StateStage == "entry" && e.StateActive != nil && *e.StateActive {
			if active[e.Side] != e.Actor {
				appendEntry(e, false)
			}
			active[e.Side] = e.Actor
		} else if active[e.Side] == e.Actor {
			delete(active, e.Side)
		}
	}
	return out
}

func battleGrowthHistoryUse(e BattleEvent) bool {
	return battleGrowthIsUse(e) && e.SkillClass != "passive" && (e.SkillClass != "system" || e.Combat != nil && e.Combat.ActionKind == "wishImpact") && e.ProtocolSkillID != "700001000"
}
func battleGrowthHistoryCharge(e BattleEvent) bool {
	return !battleIsStunSkip(e) && e.Phase == "executed" && e.ProtocolSkillID == "700001000" && (e.Kind == "skill" || e.Kind == "effect" && e.SkillClass == "system")
}
func battleGrowthPrefix(s *BattleGrowthEntrySnapshot, entry BattleEvent, initial bool, v battleGrowthRecordView, rule battleGrowthTraitRule) {
	coverage := BattleGrowthHistoryCoverage{Mode: "unknown", Complete: v.r.Quality.Actions}
	sourceSide := s.Side
	if rule.derive == "historyEnemyChargeSwitch" {
		if sourceSide == "me" {
			sourceSide = "enemy"
		} else {
			sourceSide = "me"
		}
	}
	count := 0
	types := map[string]bool{}
	frames := map[[2]int][]BattleEvent{}
	for _, e := range v.r.Events {
		if e.Side == sourceSide && (battleGrowthHistoryUse(e) || rule.derive == "historyEnemyChargeSwitch" && (battleGrowthHistoryCharge(e) || e.Kind == "switch" && e.Phase == "executed")) {
			frame := [2]int{e.Round, e.Seq}
			frames[frame] = append(frames[frame], e)
		}
	}
	for _, e := range v.r.Events {
		if initial || e.Side != sourceSide {
			continue
		}
		if e.Kind == "skill" && e.Phase == "unknown" && battleEventBefore(e, entry) && e.SkillClass != "passive" && e.SkillClass != "system" && !battleIsStunSkip(e) {
			coverage.UnknownActions++
			continue
		}
		isSwitch := rule.derive == "historyEnemyChargeSwitch" && e.Kind == "switch" && e.Phase == "executed"
		charge := rule.derive == "historyEnemyChargeSwitch" && battleGrowthHistoryCharge(e)
		use := battleGrowthHistoryUse(e)
		if !isSwitch && !charge && !use {
			continue
		}
		if !battleEventBefore(e, entry) {
			if e.Round == entry.Round && e.Seq == entry.Seq && !battleEventBefore(entry, e) {
				coverage.AmbiguousOrder++
			}
			continue
		}
		if _, ok := v.pets[battleGrowthActor{e.Side, e.Actor}]; !ok {
			coverage.UnknownActions++
			continue
		}
		ambiguous := false
		for _, other := range frames[[2]int{e.Round, e.Seq}] {
			if other.ID == e.ID {
				continue
			}
			if !(battleGrowthHistoryUse(other) || rule.derive == "historyEnemyChargeSwitch" && (battleGrowthHistoryCharge(other) || other.Kind == "switch" && other.Phase == "executed")) {
				continue
			}
			if !battleEventBefore(e, other) && !battleEventBefore(other, e) {
				ambiguous = true
				break
			}
		}
		if ambiguous {
			coverage.AmbiguousOrder++
			continue
		}
		if use {
			_, confirmedSkill := v.cat.skills[e.SkillID]
			if !confirmedSkill && !(e.Combat != nil && e.Combat.ActionKind == "wishImpact") {
				coverage.UnknownActions++
				continue
			}
		}
		match, known := false, true
		switch rule.derive {
		case "historyEnemyChargeSwitch":
			if isSwitch {
				_, targetKnown := v.pets[battleGrowthActor{e.Side, e.Target}]
				known = targetKnown && e.Target != e.Actor && (e.TargetSide == "" || e.TargetSide == e.Side)
			}
			match = charge || isSwitch
		case "historyResponse":
			if e.SkillClass == "response" {
				known = false
				if e.Combat != nil && e.Combat.CounteredActionID != "" && (e.Combat.ResponseAttempt == nil || *e.Combat.ResponseAttempt) {
					for _, target := range v.r.Events {
						if target.ID == e.Combat.CounteredActionID && target.Side != e.Side && target.Round == e.Round && !battleIsStunSkip(target) && battleOneOf(target.Phase, "executed", "interrupted") {
							known = true
							match = true
							break
						}
					}
				}
			} else if e.SkillClass == "" || e.SkillClass == "unknown" {
				known = false
			}
		case "historyCost3":
			known = e.EnergyCost != nil
			match = known && *e.EnergyCost == 3
		case "historyStatus", "historyDefense":
			skill, ok := v.cat.skills[e.SkillID]
			known = ok
			if e.Combat != nil && e.Combat.ActionKind == "wishImpact" {
				known = true
			} // known attack, never status/defense
			match = ok && (rule.derive == "historyStatus" && skill.Category == "Status" || rule.derive == "historyDefense" && skill.Category == "Defense")
		default:
			typ, ok := v.actionType(e)
			known = ok
			switch rule.derive {
			case "historyWater":
				match = typ == "Water"
			case "historyFightingGround":
				match = typ == "Fighting" || typ == "Ground"
			case "historyFire", "historyFireCap10":
				match = typ == "Fire"
			case "historyDistinctType":
				if ok && !types[typ] {
					match = true
					types[typ] = true
				}
			}
		}
		if !known {
			coverage.UnknownActions++
			continue
		}
		if match {
			count++
			s.EvidenceEventIDs = append(s.EvidenceEventIDs, e.ID)
		}
	}
	if rule.derive == "historyFireCap10" && count > 10 {
		count = 10
	}
	coverage.Complete = coverage.Complete && coverage.UnknownActions == 0 && coverage.AmbiguousOrder == 0
	if coverage.Complete {
		coverage.Mode = "completePrefix"
	} else if count > 0 {
		coverage.Mode = "observedPrefix"
	}
	s.Known = count > 0 || coverage.Complete
	if s.Known {
		n := count
		s.Count = &n
	}
	s.Coverage = coverage
}

// Repeated entries see overlapping history; use the largest qualified entry
// snapshot once, never sum snapshots or continue past the owner's last entry.
func (v battleGrowthRecordView) historicalTraitTotal(a battleGrowthActor, key battleGrowthKey) (float64, bool, bool) {
	total, known, lower := 0.0, false, false
	for _, s := range v.history {
		if s.Side != a.side || s.Actor != a.id || s.TraitID != key.trait || !s.Known || s.Count == nil {
			continue
		}
		if !known || float64(*s.Count) > total || float64(*s.Count) == total && s.Coverage.Complete {
			total, known, lower = float64(*s.Count), true, !s.Coverage.Complete
		}
	}
	n, ok := v.observations[a][key].reconcile(total, known)
	if o := v.observations[a][key]; o != nil {
		if _, explicit := o.result(); explicit {
			lower = false
		}
	}
	return n, ok, lower && ok
}
