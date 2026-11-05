package main

import (
	"encoding/json"
	"regexp"
	"sort"
	"time"
)

// BattlePerformance is a read-only projection of the supplied normalized records.
// All counts are observed counts, including partial captures. Species averages
// ALWAYS divide by carriedBattles, not entered battles or complete captures.
// A nil rate/mean is unknown, not zero. Catalog-derived facts are identified in
// coverage and never become historical record/profile measurements.
type BattlePerformance struct {
	Species         []BattleSpeciesPerformance `json:"species"`
	CompleteLineups []BattleCompleteLineup     `json:"completeLineups"`
	Coverage        BattlePerformanceCoverage  `json:"coverage"`
	Issues          []string                   `json:"issues"`
}
type BattlePerformanceCoverage struct {
	InputRecords             int    `json:"inputRecords"`
	IncludedBattles          int    `json:"includedBattles"`
	InvalidBattles           int    `json:"invalidBattles"`
	ConflictingBattles       int    `json:"conflictingBattles"`
	CompleteLineupBattles    int    `json:"completeLineupBattles"`
	IncompleteLineupBattles  int    `json:"incompleteLineupBattles"`
	UnmappedOwnInstances     int    `json:"unmappedOwnInstances"`
	UnattributedDamageEvents int    `json:"unattributedDamageEvents"`
	UnattributedKills        int    `json:"unattributedKills"`
	CatalogAvailable         bool   `json:"catalogAvailable"`
	CurrentCatalogReference  string `json:"currentCatalogReference,omitempty"`
}
type BattleSpeciesPerformance struct {
	MonsterID      int `json:"monsterId"`
	CarriedBattles int `json:"carriedBattles"`
	// Enemy-only evidence denominators. Own projections leave rates nil/counts zero.
	CarryRate            *float64                  `json:"carryRate"`
	WinRate              *float64                  `json:"winRate"`
	CarrySamples         int                       `json:"carrySamples"`
	CarryOccurrences     int                       `json:"carryOccurrences"`
	Wins                 int                       `json:"wins"`
	KnownOutcomeBattles  int                       `json:"knownOutcomeBattles"`
	EnteredBattles       int                       `json:"enteredBattles"`
	Totals               BattlePerformanceTotals   `json:"totals"`
	Averages             BattlePerformanceAverages `json:"averages"`
	ResponseRate         *float64                  `json:"responseRate"`
	AttackPerDeath       *float64                  `json:"attackPerDeath"`
	ReceivedPerDeath     *float64                  `json:"receivedPerDeath"`
	AttackCounteredRate  *float64                  `json:"attackCounteredRate"`
	StatusCounteredRate  *float64                  `json:"statusCounteredRate"`
	DefenseSuccessRate   *float64                  `json:"defenseSuccessRate"`
	RollerCoaster        *BattleRollerCoaster      `json:"rollerCoaster,omitempty"`
	DeparturesByOpponent []BattleDepartureMatchup  `json:"departuresByOpponent"`
	Coverage             BattleSpeciesCoverage     `json:"coverage"`
}

// RollerCoaster is intentionally limited to initial local species 501. Success
// is a battle-level set of explicit completed local skill 492 casts by its own
// initial instance, not an inferred effect or a count of repeated casts.
type BattleRollerCoaster struct {
	CarriedBattles      int      `json:"carriedBattles"`
	SuccessBattles      int      `json:"successBattles"`
	KnownOutcomeBattles int      `json:"knownOutcomeBattles"`
	Wins                int      `json:"wins"`
	SuccessRate         *float64 `json:"successRate"`
	WinRate             *float64 `json:"winRate"`
}

type BattleSpeciesCoverage struct {
	CompleteActionBattles               int `json:"completeActionBattles"`
	PartialActionBattles                int `json:"partialActionBattles"`
	CompleteRosterBattles               int `json:"completeRosterBattles"`
	AttackClassificationUnknown         int `json:"attackClassificationUnknown"`
	CatalogAttackClassifications        int `json:"catalogAttackClassifications"`
	ResponseCapabilityUnknown           int `json:"responseCapabilityUnknown"`
	CatalogResponseClassifications      int `json:"catalogResponseClassifications"`
	OutgoingEffectivenessUnknown        int `json:"outgoingEffectivenessUnknown"`
	ReceivedEffectivenessUnknown        int `json:"receivedEffectivenessUnknown"`
	ReceivedAttackClassificationUnknown int `json:"receivedAttackClassificationUnknown"`
	ResponseOutcomesUnknown             int `json:"responseOutcomesUnknown"`
	ReceivedHitEvidenceUnknown          int `json:"receivedHitEvidenceUnknown"`
	UnresolvedActionLinks               int `json:"unresolvedActionLinks"`
	UnresolvedKills                     int `json:"unresolvedKills"`
	UnresolvedDepartures                int `json:"unresolvedDepartures"`
	OpponentAtExitUnknown               int `json:"opponentAtExitUnknown"`
}

// Actual is measured HP lost; Estimated is the separately labelled full-HP KO
// fallback; Unresolved counts damage events with no trustworthy HP loss. Amount
// is deliberately never used. Healing never subtracts from cumulative damage.
type BattleDamageTotals struct {
	Actual     int64 `json:"actual"`
	Estimated  int64 `json:"estimated"`
	Unresolved int   `json:"unresolved"`
}
type BattleDamageAverages struct {
	Actual     float64 `json:"actual"`
	Estimated  float64 `json:"estimated"`
	Unresolved float64 `json:"unresolved"`
}
type BattleDepartureTotals struct {
	Total     int `json:"total"`
	Defeat    int `json:"defeat"`
	Forced    int `json:"forced"`
	Voluntary int `json:"voluntary,omitempty"`
	Self      int `json:"self"`
	Unknown   int `json:"unknown"`
}
type BattleDepartureAverages struct {
	Total     float64 `json:"total"`
	Defeat    float64 `json:"defeat"`
	Forced    float64 `json:"forced"`
	Voluntary float64 `json:"voluntary,omitempty"`
	Self      float64 `json:"self"`
	Unknown   float64 `json:"unknown"`
}

// Effectiveness tags are sets per distinct action (and receiver for received
// actions). A mixed-target action may be in multiple tags, but attackActions is
// still one. Untagged/unknown effectiveness is never classified as usual.
type BattlePerformanceTotals struct {
	Entries                 int                   `json:"entries"`
	Kills                   int                   `json:"kills"`
	AttackActions           int                   `json:"attackActions"`
	Deaths                  int                   `json:"deaths"`
	StatusActions           int                   `json:"statusActions"`
	DefenseActions          int                   `json:"defenseActions"`
	AttackAttempts          int                   `json:"attackAttempts"`
	StatusAttempts          int                   `json:"statusAttempts"`
	DefenseAttempts         int                   `json:"defenseAttempts"`
	AttackCountered         int                   `json:"attackCountered"`
	StatusCountered         int                   `json:"statusCountered"`
	DefenseSuccess          int                   `json:"defenseSuccess"`
	OutgoingAdvantage       int                   `json:"outgoingAdvantage"`
	OutgoingResisted        int                   `json:"outgoingResisted"`
	OutgoingUsual           int                   `json:"outgoingUsual"`
	ResponseAttempts        int                   `json:"responseAttempts"`
	ResponseSuccess         int                   `json:"responseSuccess"`
	CounteredActions        int                   `json:"counteredActions"`
	ReceivedActions         int                   `json:"receivedActions"`
	ReceivedAdvantage       int                   `json:"receivedAdvantage"`
	ReceivedResisted        int                   `json:"receivedResisted"`
	ReceivedUsual           int                   `json:"receivedUsual"`
	DamageDealt             BattleDamageTotals    `json:"damageDealt"`
	DamageReceived          BattleDamageTotals    `json:"damageReceived"`
	ReceivedAdvantageDamage BattleDamageTotals    `json:"receivedAdvantageDamage"`
	ReceivedResistedDamage  BattleDamageTotals    `json:"receivedResistedDamage"`
	ReceivedUsualDamage     BattleDamageTotals    `json:"receivedUsualDamage"`
	Departures              BattleDepartureTotals `json:"departures"`
}
type BattlePerformanceAverages struct {
	Entries                 float64                 `json:"entries"`
	Kills                   float64                 `json:"kills"`
	AttackActions           float64                 `json:"attackActions"`
	Deaths                  float64                 `json:"deaths"`
	StatusActions           float64                 `json:"statusActions"`
	DefenseActions          float64                 `json:"defenseActions"`
	AttackAttempts          float64                 `json:"attackAttempts"`
	StatusAttempts          float64                 `json:"statusAttempts"`
	DefenseAttempts         float64                 `json:"defenseAttempts"`
	AttackCountered         float64                 `json:"attackCountered"`
	StatusCountered         float64                 `json:"statusCountered"`
	DefenseSuccess          float64                 `json:"defenseSuccess"`
	OutgoingAdvantage       float64                 `json:"outgoingAdvantage"`
	OutgoingResisted        float64                 `json:"outgoingResisted"`
	OutgoingUsual           float64                 `json:"outgoingUsual"`
	ResponseAttempts        float64                 `json:"responseAttempts"`
	ResponseSuccess         float64                 `json:"responseSuccess"`
	CounteredActions        float64                 `json:"counteredActions"`
	ReceivedActions         float64                 `json:"receivedActions"`
	ReceivedAdvantage       float64                 `json:"receivedAdvantage"`
	ReceivedResisted        float64                 `json:"receivedResisted"`
	ReceivedUsual           float64                 `json:"receivedUsual"`
	DamageDealt             BattleDamageAverages    `json:"damageDealt"`
	DamageReceived          BattleDamageAverages    `json:"damageReceived"`
	ReceivedAdvantageDamage BattleDamageAverages    `json:"receivedAdvantageDamage"`
	ReceivedResistedDamage  BattleDamageAverages    `json:"receivedResistedDamage"`
	ReceivedUsualDamage     BattleDamageAverages    `json:"receivedUsualDamage"`
	Departures              BattleDepartureAverages `json:"departures"`
}

// Attribution distinguishes a proven causal action (its actor's then-current
// canonical form) from facing an opponent. A linked self departure uses facing
// at source-action time; an unlinked self/voluntary departure uses exit time.
// Unknown reasons/causes use ID zero; a replacement opponent is not a forcing
// actor. Initial own species identity remains unchanged in the enclosing row.
type BattleDepartureMatchup struct {
	MonsterID   int                     `json:"monsterId"`
	Attribution string                  `json:"attribution"`
	Totals      BattleDepartureTotals   `json:"totals"`
	Averages    BattleDepartureAverages `json:"averages"`
}
type BattleCompleteLineup struct {
	MonsterIDs             []int    `json:"monsterIds"`
	Battles                int      `json:"battles"`
	Wins                   int      `json:"wins"`
	Losses                 int      `json:"losses"`
	Draws                  int      `json:"draws"`
	Unknown                int      `json:"unknown"`
	KnownOutcomes          int      `json:"knownOutcomes"`
	WinRate                *float64 `json:"winRate"`
	AverageRounds          *float64 `json:"averageRounds"`
	RoundSamples           int      `json:"roundSamples"`
	AverageDurationSeconds *float64 `json:"averageDurationSeconds"`
	DurationSamples        int      `json:"durationSamples"`
	// SelfSkills contains only this exact initial-species multiset's battles
	// from the supplied (already filtered) records, including unknown outcomes
	// and partial actions. It is always an array, even with no observed casts.
	SelfSkills  []BattleSelfSkillStats `json:"selfSkills"`
	roundSum    int64
	durationSum float64
}

// BuildBattlePerformance performs no I/O, global reads or mutation of its inputs.
// Invalid/conflicting duplicate battle IDs exclude the entire battle, independent
// of input order. Compatible partial imports are merged by the canonical merger.
func BuildBattlePerformance(records []BattleRecord, catalogData []byte) *BattlePerformance {
	return buildBattleSidePerformance(records, catalogData, "me")
}

// BuildBattleEnemyPerformance uses the exact same evidence/form/action engine
// from the enemy's perspective. Records are cloned and validated in their original
// orientation: asymmetric measurements (notably MeSpeed), constraints, IDs and
// causal references never need rewriting or fabricated opposite-side values.
func BuildBattleEnemyPerformance(records []BattleRecord, catalogData []byte) *BattlePerformance {
	return buildBattleSidePerformance(records, catalogData, "enemy")
}

func battlePerformanceOutcome(outcome, side string) string {
	if side == "enemy" {
		switch outcome {
		case "win":
			return "loss"
		case "loss":
			return "win"
		}
	}
	return outcome
}

func buildBattleSidePerformance(records []BattleRecord, catalogData []byte, viewSide string) *BattlePerformance {
	out := &BattlePerformance{Species: []BattleSpeciesPerformance{}, CompleteLineups: []BattleCompleteLineup{}, Issues: []string{}}
	cat := battlePerformanceReadCatalog(catalogData)
	out.Coverage.InputRecords = len(records)
	out.Coverage.CatalogAvailable = cat.available
	out.Coverage.CurrentCatalogReference = cat.reference
	if !cat.available {
		out.Issues = append(out.Issues, "Current catalog unavailable; only explicit record evidence is used.")
	}
	unique, bad := map[string]BattleRecord{}, map[string]string{}
	for _, input := range records {
		r, err := battleClone(input)
		if err == nil {
			err = ValidateBattleRecord(&r)
		}
		if err != nil {
			bad[input.ID] = "invalid"
			delete(unique, input.ID)
			continue
		}
		if bad[r.ID] != "" {
			continue
		}
		if old, ok := unique[r.ID]; ok {
			r, err = MergeBattleRecord(old, r)
			if err != nil {
				bad[input.ID] = "conflict"
				delete(unique, input.ID)
				continue
			}
		}
		unique[r.ID] = r
	}
	for _, reason := range bad {
		if reason == "invalid" {
			out.Coverage.InvalidBattles++
		} else {
			out.Coverage.ConflictingBattles++
		}
	}
	if len(bad) > 0 {
		out.Issues = append(out.Issues, "Invalid or conflicting battles are excluded in full.")
	}
	rows, lineups := map[int]*BattleSpeciesPerformance{}, map[string]*BattleCompleteLineup{}
	lineupSkills := map[string]battleSelfSkillAccumulator{}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		r := unique[id]
		out.Coverage.IncludedBattles++
		carried := map[int]bool{}
		for _, p := range r.Sides[viewSide].Pets {
			if p.MonsterID <= 0 {
				out.Coverage.UnmappedOwnInstances++
				continue
			}
			if carried[p.MonsterID] {
				continue
			}
			carried[p.MonsterID] = true
			row := rows[p.MonsterID]
			if row == nil {
				row = &BattleSpeciesPerformance{MonsterID: p.MonsterID, DeparturesByOpponent: []BattleDepartureMatchup{}}
				rows[p.MonsterID] = row
			}
			row.CarriedBattles++
			if viewSide == "enemy" && battleOneOf(r.Outcome, "win", "loss", "draw") {
				row.KnownOutcomeBattles++
				if r.Outcome == "loss" {
					row.Wins++
				}
			}
			if p.MonsterID == battlePerformanceRollerCoasterSpecies {
				if row.RollerCoaster == nil {
					row.RollerCoaster = &BattleRollerCoaster{}
				}
				row.RollerCoaster.CarriedBattles++
			}
			if r.Quality.Actions {
				row.Coverage.CompleteActionBattles++
			} else {
				row.Coverage.PartialActionBattles++
			}
			if r.Quality.Roster[viewSide] {
				row.Coverage.CompleteRosterBattles++
			}
		}
		battlePerformanceRecord(&r, rows, cat, &out.Coverage, viewSide)
		if !r.Quality.Roster[viewSide] {
			out.Coverage.IncompleteLineupBattles++
			continue
		}
		lineup := []int{}
		complete := true
		for _, p := range r.Sides[viewSide].Pets {
			if p.MonsterID <= 0 {
				complete = false
			}
			lineup = append(lineup, p.MonsterID)
		}
		if !complete || len(lineup) == 0 {
			out.Coverage.IncompleteLineupBattles++
			continue
		}
		out.Coverage.CompleteLineupBattles++
		if viewSide == "enemy" {
			// Both carry-rate populations require a nonempty, complete-known
			// initial roster. Partial confirmed occurrences still count as carried
			// battles above, but cannot inflate this stricter numerator.
			for species := range carried {
				rows[species].CarryOccurrences++
			}
		}
		sort.Ints(lineup)
		data, _ := json.Marshal(lineup)
		key := string(data)
		group := lineups[key]
		if group == nil {
			group = &BattleCompleteLineup{MonsterIDs: lineup, SelfSkills: []BattleSelfSkillStats{}}
			lineups[key] = group
			lineupSkills[key] = battleSelfSkillAccumulator{}
		}
		// Reuse own-usage identity/counting after canonical duplicate merging.
		// Each eligible record is scanned once, not once per possible lineup.
		if viewSide == "me" {
			lineupSkills[key].add(battleOwnSkillUsage(r))
		}
		group.Battles++
		switch battlePerformanceOutcome(r.Outcome, viewSide) {
		case "win":
			group.Wins++
		case "loss":
			group.Losses++
		case "draw":
			group.Draws++
		default:
			group.Unknown++
		}
		if r.Rounds > 0 {
			group.RoundSamples++
			group.roundSum += int64(r.Rounds)
		}
		if seconds, ok := battlePerformanceDuration(r); ok {
			group.DurationSamples++
			group.durationSum += seconds
		}
	}
	for _, row := range rows {
		if viewSide == "enemy" {
			row.CarrySamples = out.Coverage.CompleteLineupBattles
			row.CarryRate = battlePerformanceRatio(row.CarryOccurrences, row.CarrySamples)
			row.WinRate = battlePerformanceRatio(row.Wins, row.KnownOutcomeBattles)
		}
		row.Averages = battlePerformanceMean(row.Totals, row.CarriedBattles)
		row.ResponseRate = battlePerformanceRatio(row.Totals.ResponseSuccess, row.Totals.ResponseAttempts)
		// Ratios have their own evidence denominators; unlike averages, they are
		// never divided by carried battles (nor recalculated for a UI view mode).
		row.AttackPerDeath = battlePerformanceRatio(row.Totals.AttackActions, row.Totals.Deaths)
		row.ReceivedPerDeath = battlePerformanceRatio(row.Totals.ReceivedActions, row.Totals.Deaths)
		row.AttackCounteredRate = battlePerformanceRatio(row.Totals.AttackCountered, row.Totals.AttackAttempts)
		row.StatusCounteredRate = battlePerformanceRatio(row.Totals.StatusCountered, row.Totals.StatusAttempts)
		row.DefenseSuccessRate = battlePerformanceRatio(row.Totals.DefenseSuccess, row.Totals.DefenseAttempts)
		if rc := row.RollerCoaster; rc != nil {
			rc.SuccessRate = battlePerformanceRatio(rc.SuccessBattles, rc.CarriedBattles)
			rc.WinRate = battlePerformanceRatio(rc.Wins, rc.KnownOutcomeBattles)
		}
		for i := range row.DeparturesByOpponent {
			row.DeparturesByOpponent[i].Averages = battleDepartureMean(row.DeparturesByOpponent[i].Totals, float64(row.CarriedBattles))
		}
		sort.Slice(row.DeparturesByOpponent, func(i, j int) bool {
			a, b := row.DeparturesByOpponent[i], row.DeparturesByOpponent[j]
			if a.MonsterID != b.MonsterID {
				return a.MonsterID < b.MonsterID
			}
			return a.Attribution < b.Attribution
		})
		out.Species = append(out.Species, *row)
	}
	sort.Slice(out.Species, func(i, j int) bool { return out.Species[i].MonsterID < out.Species[j].MonsterID })
	for key, group := range lineups {
		group.SelfSkills = lineupSkills[key].stats()
		group.KnownOutcomes = group.Wins + group.Losses + group.Draws
		group.WinRate = battlePerformanceRatio(group.Wins, group.KnownOutcomes)
		if group.RoundSamples > 0 {
			v := float64(group.roundSum) / float64(group.RoundSamples)
			group.AverageRounds = &v
		}
		if group.DurationSamples > 0 {
			v := group.durationSum / float64(group.DurationSamples)
			group.AverageDurationSeconds = &v
		}
		out.CompleteLineups = append(out.CompleteLineups, *group)
	}
	sort.Slice(out.CompleteLineups, func(i, j int) bool {
		a, b := out.CompleteLineups[i].MonsterIDs, out.CompleteLineups[j].MonsterIDs
		for k := 0; k < len(a) && k < len(b); k++ {
			if a[k] != b[k] {
				return a[k] < b[k]
			}
		}
		return len(a) < len(b)
	})
	return out
}

// Instance and action keys are structured Go map keys; arbitrary protocol IDs
// (including __proto__ and constructor) cannot collide with map prototypes or
// delimiter-joined identities, nor with the other side's identical instance ID.
type battlePerformanceActor struct{ side, id string }
type battlePerformanceActionKey struct {
	actor battlePerformanceActor
	id    string
}
type battlePerformanceAction struct {
	key                                      battlePerformanceActionKey
	event                                    BattleEvent
	events                                   []BattleEvent
	attack, attackKnown, attackCatalog       bool
	category                                 string
	response, responseKnown, responseCatalog bool
	success                                  bool
	outgoing                                 map[string]bool
	outgoingUnknown                          bool
	received                                 map[battlePerformanceActor]map[string]bool
	receivedUnknown                          map[battlePerformanceActor]bool
}
type battlePerformanceLegacyKey struct {
	round, seq                           int
	side, actor, targetSide, target, ref string
}
type battlePerformanceHP struct {
	value int
	known bool
	event BattleEvent
}
type battlePerformancePresence struct {
	actor   battlePerformanceActor
	event   BattleEvent
	initial bool
}

var battlePerformanceFaintID = regexp.MustCompile(`^rkpp:action:\d+:\d+:\d+:faint$`)
var battlePerformanceSupplyID = regexp.MustCompile(`^rkpp:action:\d+:\d+:\d+:supply:(.+)$`)
var battlePerformanceDamageID = regexp.MustCompile(`^rkpp:action:\d+:\d+:\d+:damage_info$`)
var battlePerformanceDamageText = regexp.MustCompile(`^同一条执行消息、同一目标的数值同步；来源标识 (\d+)（不直接当作技能ID）。CSV逻辑行 \d+。 报告伤害与实际生命变化分开保留，不推导隐藏配置。$`)

func battlePerformanceFaint(e BattleEvent) bool {
	return e.Kind == "effect" && e.Phase == "executed" && battlePerformanceFaintID.MatchString(e.ID) && e.Label == "倒下通知" && e.Text == "明确 dead_info；不由动画或HP推测。"
}
func battlePerformanceSupply(e BattleEvent) bool {
	m := battlePerformanceSupplyID.FindStringSubmatch(e.ID)
	return e.Kind == "effect" && e.Phase == "executed" && len(m) == 2 && m[1] == e.Actor && e.Label == "补位通知" && e.Text == "同一既有实例的 supply_pet 通知；不增加初始队员。"
}
func battlePerformanceIsAction(e BattleEvent) bool {
	return !battleIsStunSkip(e) && battleOneOf(e.Phase, "executed", "interrupted") && (e.Kind == "skill" || e.Kind == "switch" || e.Kind == "effect" && battleOneOf(e.SkillClass, "system", "passive"))
}
func battlePerformanceLegacy(e BattleEvent) (battlePerformanceLegacyKey, bool) {
	k := battlePerformanceLegacyKey{e.Round, e.Seq, e.Side, e.Actor, e.TargetSide, e.Target, e.ProtocolSkillID}
	if k.ref == "" && e.Kind == "damage" && battlePerformanceDamageID.MatchString(e.ID) {
		m := battlePerformanceDamageText.FindStringSubmatch(e.Text)
		if len(m) == 2 {
			k.ref = m[1]
		}
	}
	_, indexed := battleMetadataExecutionIndex(e)
	return k, indexed && battleOneOf(e.Side, "me", "enemy") && e.Actor != "" && battleOneOf(e.TargetSide, "me", "enemy") && e.Target != "" && k.ref != ""
}
func battlePerformanceVictim(e BattleEvent) (battlePerformanceActor, string, bool) {
	reason := ""
	if e.Combat != nil {
		reason = e.Combat.LeaveReason
	}
	if battlePerformanceFaint(e) {
		reason = "defeat"
	}
	switch e.Kind {
	case "switch":
		side := e.TargetSide
		if side == "" {
			side = e.Side
		}
		return battlePerformanceActor{side, e.Target}, reason, e.Phase == "executed" && e.Target != "" && side == e.Side
	case "damage":
		return battlePerformanceActor{e.TargetSide, e.Target}, reason, e.Phase == "executed" && reason != ""
	case "effect":
		return battlePerformanceActor{e.Side, e.Actor}, reason, e.Phase == "executed" && reason != ""
	}
	return battlePerformanceActor{}, "", false
}
func battlePerformanceRecord(r *BattleRecord, rows map[int]*BattleSpeciesPerformance, cat battlePerformanceCatalog, coverage *BattlePerformanceCoverage, viewSide string) {
	opponentSide := "enemy"
	if viewSide == "enemy" {
		opponentSide = "me"
	}
	pets := map[battlePerformanceActor]BattlePet{}
	for _, side := range []string{"me", "enemy"} {
		for _, p := range r.Sides[side].Pets {
			pets[battlePerformanceActor{side, p.InstanceID}] = p
		}
	}
	rowFor := func(a battlePerformanceActor) *BattleSpeciesPerformance {
		if a.side != viewSide {
			return nil
		}
		return rows[pets[a].MonsterID]
	}
	events := append([]BattleEvent(nil), r.Events...)
	sort.SliceStable(events, func(i, j int) bool { return battleEventBefore(events[i], events[j]) })
	groups := map[battlePerformanceActionKey]*battlePerformanceAction{}
	aliases := map[string]map[*battlePerformanceAction]bool{}
	legacy := map[battlePerformanceLegacyKey]map[*battlePerformanceAction]bool{}
	addAlias := func(id string, a *battlePerformanceAction) {
		if id == "" {
			return
		}
		if aliases[id] == nil {
			aliases[id] = map[*battlePerformanceAction]bool{}
		}
		aliases[id][a] = true
	}
	for _, e := range events {
		if !battlePerformanceIsAction(e) {
			continue
		}
		// The normalized event ID is the action identity; combat.ActionID is
		// a causal source reference, not an alias or a new cast.
		id := e.ID
		key := battlePerformanceActionKey{battlePerformanceActor{e.Side, e.Actor}, id}
		a := groups[key]
		if a == nil {
			a = &battlePerformanceAction{key: key, event: e, outgoing: map[string]bool{}, received: map[battlePerformanceActor]map[string]bool{}, receivedUnknown: map[battlePerformanceActor]bool{}}
			groups[key] = a
		}
		a.events = append(a.events, e)
		if a.event.Phase != "executed" && e.Phase == "executed" {
			a.event = e
		}
		addAlias(id, a)
		addAlias(e.ID, a)
		if k, ok := battlePerformanceLegacy(e); ok && e.Phase == "executed" {
			if legacy[k] == nil {
				legacy[k] = map[*battlePerformanceAction]bool{}
			}
			legacy[k][a] = true
		}
	}
	// References are resolved only when side/instance constraints leave exactly
	// one action. Unknown links do not fall through to an adjacency heuristic.
	resolve := func(ref, side, actor string) *battlePerformanceAction {
		var found *battlePerformanceAction
		for a := range aliases[ref] {
			if side != "" && a.key.actor.side != side || actor != "" && a.key.actor.id != actor {
				continue
			}
			if found != nil && found != a {
				return nil
			}
			found = a
		}
		return found
	}
	damageAction := func(e BattleEvent) *battlePerformanceAction {
		if e.Combat != nil && e.Combat.ActionID != "" {
			side := e.Side
			if !battleOneOf(side, "me", "enemy") {
				side = ""
			}
			a := resolve(e.Combat.ActionID, side, e.Actor)
			if a != nil && a.event.Phase == "executed" {
				return a
			}
			return nil
		}
		k, ok := battlePerformanceLegacy(e)
		if !ok {
			return nil
		}
		var found *battlePerformanceAction
		for a := range legacy[k] {
			matches := false
			for _, source := range a.events {
				if source.Phase == "executed" {
					if sk, sok := battlePerformanceLegacy(source); sok && sk == k && battleEventBefore(source, e) {
						matches = true
					}
				}
			}
			if !matches {
				continue
			}
			if found != nil {
				return nil
			}
			found = a
		}
		return found
	}
	linked := map[string]*battlePerformanceAction{}
	for _, e := range events {
		if e.Kind == "damage" && e.Phase == "executed" {
			linked[e.ID] = damageAction(e)
		}
	}
	type actionTarget struct {
		action *battlePerformanceAction
		target battlePerformanceActor
	}
	confirmedKO := map[actionTarget]bool{}
	actualEvidence := map[actionTarget]bool{}
	measuredHit := map[actionTarget]bool{}
	koLossAccounted := map[actionTarget]bool{}
	for _, e := range events {
		if e.Kind == "damage" {
			if a := linked[e.ID]; a != nil && (e.HPChange != nil || e.HPAfter != nil || e.Combat != nil && e.Combat.HPBefore != nil) {
				at := actionTarget{a, battlePerformanceActor{e.TargetSide, e.Target}}
				actualEvidence[at] = true
				if e.HPChange != nil || e.HPAfter != nil {
					measuredHit[at] = true
				}
			}
		}
		victim, reason, ok := battlePerformanceVictim(e)
		if !ok || reason != "defeat" {
			continue
		}
		var a *battlePerformanceAction
		if e.Kind == "damage" {
			a = linked[e.ID]
		} else if e.Combat != nil && e.Combat.ActionID != "" {
			a = resolve(e.Combat.ActionID, "", "")
		}
		if a != nil && a.event.Phase == "executed" {
			confirmedKO[actionTarget{a, victim}] = true
		}
	}
	rollerCoasterSuccess := false
	for _, a := range groups {
		// Prefer explicit flags on any representation of this same action. Conflicting
		// flags are unresolved, rather than selecting whichever event sorted first.
		a.attack, a.attackKnown, a.attackCatalog = cat.attack(a.event)
		a.response, a.responseKnown, a.responseCatalog = cat.response(a.event)
		var attackFlag, responseFlag *bool
		attackConflict, responseConflict := false, false
		for _, e := range a.events {
			if e.SkillClass == "response" && e.Phase == "executed" {
				a.success = true
			}
			if e.Combat == nil {
				continue
			}
			if e.Combat.IsAttack != nil {
				if attackFlag != nil && *attackFlag != *e.Combat.IsAttack {
					attackConflict = true
				}
				attackFlag = e.Combat.IsAttack
			}
			if e.Combat.ResponseAttempt != nil {
				if responseFlag != nil && *responseFlag != *e.Combat.ResponseAttempt {
					responseConflict = true
				}
				responseFlag = e.Combat.ResponseAttempt
			}
			if e.Combat.CounteredActionID != "" && e.Phase == "executed" {
				a.success = true
			}
		}
		if attackFlag != nil {
			a.attack, a.attackKnown, a.attackCatalog = *attackFlag, !attackConflict, false
		}
		if responseFlag != nil {
			a.response, a.responseKnown, a.responseCatalog = *responseFlag, !responseConflict, false
		}
		// Success itself is proof of an attempt, unless contradictory explicit input
		// makes this action unclassifiable.
		if a.success && responseFlag == nil {
			a.response, a.responseKnown, a.responseCatalog = true, true, false
		}
		if a.success && responseFlag != nil && !*responseFlag {
			a.responseKnown = false
			a.success = false
		}
		a.category = cat.category(a.event, a.attack, a.attackKnown)
		if row := rowFor(a.key.actor); row != nil {
			switch a.category {
			case "attack":
				row.Totals.AttackAttempts++
			case "status":
				row.Totals.StatusAttempts++
				if a.event.Phase == "executed" {
					row.Totals.StatusActions++
				}
			case "defense":
				row.Totals.DefenseAttempts++
				if a.event.Phase == "executed" {
					row.Totals.DefenseActions++
				}
			}
			if row.MonsterID == battlePerformanceRollerCoasterSpecies && a.event.Kind == "skill" && a.event.SkillID == battlePerformanceRollerCoasterSkill && a.event.Phase == "executed" {
				rollerCoasterSuccess = true
			}
			if a.event.Phase == "executed" {
				if !a.attackKnown {
					row.Coverage.AttackClassificationUnknown++
				} else if a.attack {
					row.Totals.AttackActions++
				}
				if a.attackCatalog {
					row.Coverage.CatalogAttackClassifications++
				}
			}
			if a.event.Kind == "skill" {
				if !a.responseKnown {
					row.Coverage.ResponseCapabilityUnknown++
				} else if a.response {
					row.Totals.ResponseAttempts++
					if a.success {
						row.Totals.ResponseSuccess++
					} else {
						// An observed attempt without a success marker is not an
						// asserted failure; the displayed ratio remains observed.
						row.Coverage.ResponseOutcomesUnknown++
					}
				}
				if a.responseCatalog {
					row.Coverage.CatalogResponseClassifications++
				}
			}
		}
	}
	// Resolve defense protection only after every action's classification is
	// complete, independent of Go map iteration order. A confirmed defense must
	// target a known opposing attack; responding to charge/status/switch is not
	// protection. An interrupted attack still qualifies (e.g. hard interruption).
	for _, a := range groups {
		if a.category != "defense" || a.event.Phase != "executed" || !a.success || a.event.SkillClass != "response" || a.event.Combat == nil {
			continue
		}
		if row := rowFor(a.key.actor); row != nil {
			target := resolve(a.event.Combat.CounteredActionID, opponentSide, "")
			if target != nil && target.attackKnown && target.attack {
				row.Totals.DefenseSuccess++
			}
		}
	}
	if row := rows[battlePerformanceRollerCoasterSpecies]; rollerCoasterSuccess && row != nil && row.RollerCoaster != nil {
		rc := row.RollerCoaster
		rc.SuccessBattles++
		if battleOneOf(r.Outcome, "win", "loss", "draw") {
			rc.KnownOutcomeBattles++
			if battlePerformanceOutcome(r.Outcome, viewSide) == "win" {
				rc.Wins++
			}
		}
	}
	countered := map[*battlePerformanceAction]bool{}
	for _, e := range events {
		if battleIsStunSkip(e) || e.Phase != "executed" || e.Side != opponentSide || e.Combat == nil || e.Combat.CounteredActionID == "" {
			continue
		}
		if a := resolve(e.Combat.CounteredActionID, viewSide, ""); a != nil && !countered[a] {
			if row := rowFor(a.key.actor); row != nil {
				row.Totals.CounteredActions++
				switch a.category {
				case "attack":
					row.Totals.AttackCountered++
				case "status":
					row.Totals.StatusCountered++
				}
				countered[a] = true
			}
		}
	}
	active := map[string]battlePerformancePresence{}
	open := map[battlePerformanceActor]bool{}
	entered := map[int]bool{}
	dead := map[battlePerformanceActor]bool{}
	hp := map[battlePerformanceActor]battlePerformanceHP{}
	maxHP := map[battlePerformanceActor]battlePerformanceHP{}
	currentSpecies := func(a battlePerformanceActor, e BattleEvent) int {
		e.Side, e.Actor = a.side, a.id
		return battleSpeciesAt(r, e)
	}
	facing := func(side string, e BattleEvent) int {
		other := "me"
		if side == "me" {
			other = "enemy"
		}
		s, ok := active[other]
		if !ok || !s.initial && !battleEventBefore(s.event, e) {
			return 0
		}
		return currentSpecies(s.actor, e)
	}
	// Freeze the opponent's canonical form when a source action executes. A
	// linked self departure may arrive after that action already exchanged the
	// enemy; looking at the active opponent at the later switch would misattribute
	// the old field period to its replacement. Zero is retained as unknown.
	sourceFacing := map[*battlePerformanceAction]int{}
	leave := func(a battlePerformanceActor, reason string, e BattleEvent, explicitOutgoing bool) {
		if !open[a] && !explicitOutgoing {
			return
		}
		open[a] = false
		if active[a.side].actor == a {
			delete(active, a.side)
		}
		// Unknown exits still end presence, but they are not known departures.
		// Keep the legacy Unknown JSON field at zero rather than removing it.
		if !battleOneOf(reason, "defeat", "forced", "voluntary", "self") {
			return
		}
		if row := rowFor(a); row != nil {
			battleDepartureAdd(&row.Totals.Departures, reason)
			opponent, attribution := 0, "unknown"
			if battleOneOf(reason, "voluntary", "self") {
				opponent = facing(a.side, e)
				if reason == "self" && e.Combat != nil && e.Combat.ActionID != "" {
					if source := resolve(e.Combat.ActionID, a.side, ""); source != nil && source.event.Phase == "executed" {
						opponent = sourceFacing[source]
					}
				}
				if opponent > 0 {
					attribution = "facing"
				}
			} else if battleOneOf(reason, "defeat", "forced") && e.Combat != nil && e.Combat.ActionID != "" {
				if source := resolve(e.Combat.ActionID, "", ""); source != nil && source.key.actor.side != a.side {
					opponent = currentSpecies(source.key.actor, source.event)
					if opponent > 0 {
						attribution = "cause"
					}
				}
			}
			if opponent == 0 {
				row.Coverage.OpponentAtExitUnknown++
			}
			index := -1
			for i := range row.DeparturesByOpponent {
				if row.DeparturesByOpponent[i].MonsterID == opponent && row.DeparturesByOpponent[i].Attribution == attribution {
					index = i
					break
				}
			}
			if index < 0 {
				row.DeparturesByOpponent = append(row.DeparturesByOpponent, BattleDepartureMatchup{MonsterID: opponent, Attribution: attribution})
				index = len(row.DeparturesByOpponent) - 1
			}
			battleDepartureAdd(&row.DeparturesByOpponent[index].Totals, reason)
		}
	}
	activate := func(a battlePerformanceActor, e BattleEvent, initial bool) {
		if _, ok := pets[a]; !ok {
			return
		}
		if old, ok := active[a.side]; ok {
			if old.actor == a && open[a] {
				return
			} // An affirmation is not another entry or a later start time.
			if old.actor != a {
				leave(old.actor, "unknown", e, false)
			}
		}
		if !open[a] {
			open[a] = true
			dead[a] = false
			if row := rowFor(a); row != nil {
				row.Totals.Entries++
				entered[row.MonsterID] = true
			}
		}
		active[a.side] = battlePerformancePresence{a, e, initial}
	}
	for _, side := range []string{"me", "enemy"} {
		s := r.Sides[side]
		if r.Quality.Lead[side] && s.Lead != "" {
			activate(battlePerformanceActor{side, s.Lead}, BattleEvent{}, true)
		}
	}
	estimated := map[actionTarget]bool{}
	for _, e := range events {
		if battleIsStunSkip(e) || e.Phase != "executed" {
			continue
		}
		actor := battlePerformanceActor{e.Side, e.Actor}
		// A cast/explicit entry proves presence. Passive, damage, form, ordinary
		// snapshots without stateActive, and system notifications do not.
		if e.Kind == "skill" && e.SkillClass != "passive" && e.SkillClass != "system" {
			activate(actor, e, false)
		}
		if battleCombatSourceAction(e) {
			if source := groups[battlePerformanceActionKey{actor, e.ID}]; source != nil {
				sourceFacing[source] = facing(actor.side, e)
			}
		}
		victim, reason, isLeave := battlePerformanceVictim(e)
		if isLeave {
			wasDead := dead[victim]
			if reason == "defeat" && !wasDead {
				dead[victim] = true
				// Life/death evidence is independent of the known field-period
				// departure guard: bench deaths and unknown killers still count.
				if row := rowFor(victim); row != nil {
					row.Totals.Deaths++
				}
				var source *battlePerformanceAction
				if e.Kind == "damage" {
					source = linked[e.ID]
				} else if e.Combat != nil && e.Combat.ActionID != "" {
					source = resolve(e.Combat.ActionID, "", "")
				}
				if source != nil && source.event.Phase == "executed" && source.key.actor.side != victim.side && victim.side == opponentSide {
					if row := rowFor(source.key.actor); row != nil {
						row.Totals.Kills++
					} else {
						coverage.UnattributedKills++
					}
				} else if source == nil {
					coverage.UnattributedKills++
					if e.Kind == "damage" && victim.side == opponentSide {
						if row := rowFor(actor); row != nil {
							row.Coverage.UnresolvedKills++
						}
					}
				}
			}
			if !open[victim] && !wasDead {
				if row := rowFor(victim); row != nil {
					row.Coverage.UnresolvedDepartures++
				}
			}
			explicitOutgoing := e.Kind == "switch" && !wasDead && pets[victim].MonsterID > 0
			if explicitOutgoing {
				if row := rowFor(victim); row != nil {
					entered[row.MonsterID] = true
				}
			}
			leave(victim, reason, e, explicitOutgoing)
		}
		if e.Kind == "switch" || battlePerformanceSupply(e) {
			activate(actor, e, false)
		}
		if e.Kind == "resource" && e.StateStage != "" && e.StateActive != nil {
			if *e.StateActive {
				activate(actor, e, false)
			} else if open[actor] {
				leave(actor, "unknown", e, false)
			}
		}
		if e.Kind == "form" {
			delete(hp, actor)
			delete(maxHP, actor)
		}
		if e.Kind != "damage" && e.Kind != "heal" && e.Kind != "resource" {
			continue
		}
		target := battlePerformanceActor{e.TargetSide, e.Target}
		if e.Kind == "resource" {
			target = actor
		}
		maximum := maxHP[target]
		if e.HPMax != nil {
			maximum = battlePerformanceHP{*e.HPMax, true, e}
			maxHP[target] = maximum
		}
		previous := hp[target]
		priorReliable := previous.known && battleEventBefore(previous.event, e) && (r.Quality.Actions || previous.event.Round == e.Round && previous.event.Seq == e.Seq)
		if e.Kind == "damage" {
			a := linked[e.ID]
			at := actionTarget{a, target}
			damage := BattleDamageTotals{}
			before, haveBefore := 0, false
			if e.Combat != nil && e.Combat.HPBefore != nil {
				before, haveBefore = *e.Combat.HPBefore, true
			} else if e.Combat != nil && e.Combat.FullHPBefore != nil && *e.Combat.FullHPBefore && maximum.known && (e.HPMax != nil || battleEventBefore(maximum.event, e)) {
				before, haveBefore = maximum.value, true // Measured full HP is actual, never the catalog assumption.
			} else if priorReliable {
				before, haveBefore = previous.value, true
			}
			actual := false
			if e.HPChange != nil && *e.HPChange <= 0 {
				damage.Actual = -int64(*e.HPChange)
				if haveBefore && damage.Actual > int64(before) {
					damage.Actual = int64(before)
				}
				actual = true
			} else if haveBefore && e.HPAfter != nil && before >= *e.HPAfter {
				damage.Actual = int64(before - *e.HPAfter)
				actual = true
			}
			if !actual && a != nil && haveBefore && confirmedKO[at] && !measuredHit[at] && !koLossAccounted[at] {
				damage.Actual = int64(before)
				actual, koLossAccounted[at] = true, true
			}
			if !actual {
				// HPAfter alone (including zero), partial HP, or any other real measurement
				// forbids the full-HP assumption. A linked confirmed KO and explicit full
				// HP are both necessary, and the current target form supplies only base HP.
				noRealHP := e.HPChange == nil && e.HPAfter == nil && !haveBefore && (e.Combat == nil || e.Combat.HPBefore == nil) && !actualEvidence[at]
				if noRealHP && a != nil && !estimated[at] && confirmedKO[at] && e.Combat != nil && e.Combat.FullHPBefore != nil && *e.Combat.FullHPBefore {
					p := pets[target]
					if value, ok := cat.estimatedHP(currentSpecies(target, e), p.Level); ok {
						damage.Estimated = value
						estimated[at] = true
					}
				}
				if damage.Estimated == 0 {
					damage.Unresolved = 1
				}
			}
			tag := ""
			if e.Combat != nil {
				tag = e.Combat.EffectivenessClass
				if tag == "" && e.Combat.Effectiveness != nil {
					v := *e.Combat.Effectiveness
					if v > 1 {
						tag = "advantage"
					} else if v < 1 {
						tag = "resisted"
					} else {
						tag = "usual"
					}
				}
			}
			source := actor
			if a != nil {
				source = a.key.actor
			}
			if pets[source].MonsterID <= 0 || pets[target].MonsterID <= 0 {
				coverage.UnattributedDamageEvents++ // Once per event, even when both endpoints are unknown.
			}
			if source.side == viewSide && target.side == opponentSide {
				if row := rowFor(source); row != nil {
					battleDamageAdd(&row.Totals.DamageDealt, damage)
					if a == nil {
						row.Coverage.UnresolvedActionLinks++
					}
				}
				if a != nil && a.attackKnown && a.attack {
					if tag != "" {
						a.outgoing[tag] = true
					} else {
						a.outgoingUnknown = true
					}
				}
			}
			if target.side == viewSide {
				if row := rowFor(target); row != nil {
					battleDamageAdd(&row.Totals.DamageReceived, damage)
					switch tag {
					case "advantage":
						battleDamageAdd(&row.Totals.ReceivedAdvantageDamage, damage)
					case "resisted":
						battleDamageAdd(&row.Totals.ReceivedResistedDamage, damage)
					case "usual":
						battleDamageAdd(&row.Totals.ReceivedUsualDamage, damage)
					}
					if source.side != viewSide && a == nil {
						row.Coverage.UnresolvedActionLinks++
					}
				}
				if source.side == opponentSide && a != nil {
					if a.received[target] == nil {
						a.received[target] = map[string]bool{}
					}
					if tag != "" {
						a.received[target][tag] = true
					} else {
						a.receivedUnknown[target] = true
					}
				}
			}
		}
		if e.HPAfter != nil {
			hp[target] = battlePerformanceHP{*e.HPAfter, true, e}
			if *e.HPAfter > 0 {
				dead[target] = false
			}
		} else if e.HPChange != nil && priorReliable && int64(previous.value)+int64(*e.HPChange) >= 0 {
			hp[target] = battlePerformanceHP{previous.value + *e.HPChange, true, e}
		} else if e.Kind == "damage" || e.Kind == "heal" || e.HPChange != nil {
			delete(hp, target)
		}
	}
	for id := range entered {
		if row := rows[id]; row != nil {
			row.EnteredBattles++
		}
	}
	for _, a := range groups {
		if a.event.Phase == "executed" && a.attackKnown && a.attack {
			if row := rowFor(a.key.actor); row != nil {
				if a.outgoing["advantage"] {
					row.Totals.OutgoingAdvantage++
				}
				if a.outgoing["resisted"] {
					row.Totals.OutgoingResisted++
				}
				if a.outgoing["usual"] {
					row.Totals.OutgoingUsual++
				}
				if len(a.outgoing) == 0 || a.outgoingUnknown {
					row.Coverage.OutgoingEffectivenessUnknown++
				}
			}
			// A declared target is not proof that the attack hit. Only linked
			// damage establishes a received action; absent hit evidence is visible.
			if a.key.actor.side == opponentSide {
				for _, e := range a.events {
					target := battlePerformanceActor{e.TargetSide, e.Target}
					if target.side == viewSide && target.id != "" && a.received[target] == nil {
						if row := rowFor(target); row != nil {
							row.Coverage.ReceivedHitEvidenceUnknown++
						}
					}
				}
			}
		}
		for target, tags := range a.received {
			if row := rowFor(target); row != nil {
				if !a.attackKnown {
					row.Coverage.ReceivedAttackClassificationUnknown++
					continue
				}
				if !a.attack {
					continue
				} // DOT/retaliation losses do not manufacture an attack.
				row.Totals.ReceivedActions++
				if tags["advantage"] {
					row.Totals.ReceivedAdvantage++
				}
				if tags["resisted"] {
					row.Totals.ReceivedResisted++
				}
				if tags["usual"] {
					row.Totals.ReceivedUsual++
				}
				if len(tags) == 0 || a.receivedUnknown[target] {
					row.Coverage.ReceivedEffectivenessUnknown++
				}
			}
		}
	}
}
func battleDamageAdd(dst *BattleDamageTotals, v BattleDamageTotals) {
	dst.Actual += v.Actual
	dst.Estimated += v.Estimated
	dst.Unresolved += v.Unresolved
}
func battleDepartureAdd(dst *BattleDepartureTotals, reason string) {
	if !battleOneOf(reason, "defeat", "forced", "voluntary", "self") {
		return
	}
	dst.Total++
	switch reason {
	case "defeat":
		dst.Defeat++
	case "forced":
		dst.Forced++
	case "voluntary", "self":
		dst.Self++
	}
}

func battlePerformanceRatio(n, d int) *float64 {
	if d <= 0 {
		return nil
	}
	v := float64(n) / float64(d)
	return &v
}
func battlePerformanceDuration(r BattleRecord) (float64, bool) {
	if r.DurationSeconds != nil {
		return float64(*r.DurationSeconds), true
	}
	a, e := time.Parse(time.RFC3339Nano, r.StartedAt)
	b, f := time.Parse(time.RFC3339Nano, r.EndedAt)
	if e != nil || f != nil || b.Before(a) {
		return 0, false
	}
	return b.Sub(a).Seconds(), true
}
func battleDamageMean(v BattleDamageTotals, d float64) BattleDamageAverages {
	return BattleDamageAverages{float64(v.Actual) / d, float64(v.Estimated) / d, float64(v.Unresolved) / d}
}
func battleDepartureMean(v BattleDepartureTotals, d float64) BattleDepartureAverages {
	return BattleDepartureAverages{Total: float64(v.Total) / d, Defeat: float64(v.Defeat) / d, Forced: float64(v.Forced) / d, Self: float64(v.Self+v.Voluntary) / d, Unknown: float64(v.Unknown) / d}
}
func battlePerformanceMean(v BattlePerformanceTotals, n int) BattlePerformanceAverages {
	if n <= 0 {
		return BattlePerformanceAverages{}
	}
	d := float64(n)
	return BattlePerformanceAverages{
		Entries: float64(v.Entries) / d, Kills: float64(v.Kills) / d, AttackActions: float64(v.AttackActions) / d,
		Deaths: float64(v.Deaths) / d, StatusActions: float64(v.StatusActions) / d, DefenseActions: float64(v.DefenseActions) / d,
		AttackAttempts: float64(v.AttackAttempts) / d, StatusAttempts: float64(v.StatusAttempts) / d, DefenseAttempts: float64(v.DefenseAttempts) / d,
		AttackCountered: float64(v.AttackCountered) / d, StatusCountered: float64(v.StatusCountered) / d, DefenseSuccess: float64(v.DefenseSuccess) / d,
		OutgoingAdvantage: float64(v.OutgoingAdvantage) / d, OutgoingResisted: float64(v.OutgoingResisted) / d, OutgoingUsual: float64(v.OutgoingUsual) / d,
		ResponseAttempts: float64(v.ResponseAttempts) / d, ResponseSuccess: float64(v.ResponseSuccess) / d, CounteredActions: float64(v.CounteredActions) / d,
		ReceivedActions: float64(v.ReceivedActions) / d, ReceivedAdvantage: float64(v.ReceivedAdvantage) / d, ReceivedResisted: float64(v.ReceivedResisted) / d, ReceivedUsual: float64(v.ReceivedUsual) / d,
		DamageDealt: battleDamageMean(v.DamageDealt, d), DamageReceived: battleDamageMean(v.DamageReceived, d), ReceivedAdvantageDamage: battleDamageMean(v.ReceivedAdvantageDamage, d), ReceivedResistedDamage: battleDamageMean(v.ReceivedResistedDamage, d), ReceivedUsualDamage: battleDamageMean(v.ReceivedUsualDamage, d), Departures: battleDepartureMean(v.Departures, d),
	}
}
