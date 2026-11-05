package main

import (
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode"
)

const BattleRecordVersion = 1
const BattleMaxImportBytes = 16 << 20
const BattleMaxRecords = 1000
const BattleMaxEvents = 20000

// Normalized records contain only these explicitly allowed fields. Protocol payloads
// and transport/account credentials are deliberately not represented here.
type BattleRecord struct {
	Version           int                      `json:"version"`
	ID                string                   `json:"id"`
	StartedAt         string                   `json:"startedAt,omitempty"`
	EndedAt           string                   `json:"endedAt,omitempty"`
	ImportedAt        string                   `json:"importedAt,omitempty"`
	Mode              string                   `json:"mode"`
	Outcome           string                   `json:"outcome"`
	Rounds            int                      `json:"rounds,omitempty"`
	DurationSeconds   *int                     `json:"durationSeconds,omitempty"`
	SpeedObservations []BattleSpeedObservation `json:"speedObservations,omitempty"`
	Source            string                   `json:"source,omitempty"`
	Quality           BattleQuality            `json:"quality"`
	Sides             map[string]BattleSide    `json:"sides"`
	Events            []BattleEvent            `json:"events"`
	Constraints       []BattleConstraint       `json:"constraints,omitempty"`
	Issues            []string                 `json:"issues"`
}
type BattleQuality struct {
	Roster  map[string]bool `json:"roster"`
	Actions bool            `json:"actions"`
	Lead    map[string]bool `json:"lead"`
}
type BattleSide struct {
	Pets     []BattlePet `json:"pets"`
	Lead     string      `json:"lead,omitempty"`
	Before   BattleRank  `json:"before"`
	After    BattleRank  `json:"after"`
	Matching *BattleRank `json:"matching,omitempty"`
}
type BattleRank struct {
	Score *float64 `json:"score,omitempty"`
	Rank  *int     `json:"rank,omitempty"`
	Tier  string   `json:"tier,omitempty"`
	Stars *int     `json:"stars,omitempty"`
}
type BattlePet struct {
	InstanceID      string                    `json:"instanceId"`
	MonsterID       int                       `json:"monsterId"`
	ProtocolID      string                    `json:"protocolId,omitempty"`
	ProtocolBaseID  string                    `json:"protocolBaseId,omitempty"`
	MappingRevision string                    `json:"mappingRevision,omitempty"`
	Name            string                    `json:"name,omitempty"`
	Level           *int                      `json:"level,omitempty"`
	Speed           *int                      `json:"speed,omitempty"`
	SpeedMin        *int                      `json:"speedMin,omitempty"`
	SpeedMax        *int                      `json:"speedMax,omitempty"`
	IV              map[string]BattleEvidence `json:"iv,omitempty"`
	Nature          map[string]BattleEvidence `json:"nature,omitempty"`
	InitialSkills   *BattleInitialSkills      `json:"initialSkills,omitempty"`
}
type BattleEvidence struct {
	Value      *float64  `json:"value,omitempty"`
	Certainty  string    `json:"certainty"`
	Candidates []float64 `json:"candidates,omitempty"`
	Evidence   []string  `json:"evidence,omitempty"`
	Condition  string    `json:"condition,omitempty"`
}
type BattleEvent struct {
	ID                    string                `json:"id"`
	Round                 int                   `json:"round"`
	Seq                   int                   `json:"seq"`
	At                    string                `json:"at,omitempty"`
	Kind                  string                `json:"kind"`
	Phase                 string                `json:"phase"`
	Side                  string                `json:"side"`
	Actor                 string                `json:"actor,omitempty"`
	Target                string                `json:"target,omitempty"`
	TargetSide            string                `json:"targetSide,omitempty"`
	SkillID               int                   `json:"skillId,omitempty"`
	ProtocolSkillID       string                `json:"protocolSkillId,omitempty"`
	ProtocolSkillConfigID string                `json:"protocolSkillConfigId,omitempty"`
	Amount                *float64              `json:"amount,omitempty"`
	Trigger               string                `json:"trigger,omitempty"`
	Text                  string                `json:"text,omitempty"`
	Stacks                *int                  `json:"stacks,omitempty"`
	Form                  *BattleFormChange     `json:"form,omitempty"`
	ExecIndex             *int                  `json:"execIndex,omitempty"`
	Lifecycle             string                `json:"lifecycle,omitempty"`
	SkillClass            string                `json:"skillClass,omitempty"`
	Label                 string                `json:"label,omitempty"`
	HPChange              *int                  `json:"hpChange,omitempty"`
	HPAfter               *int                  `json:"hpAfter,omitempty"`
	EnergyChange          *int                  `json:"energyChange,omitempty"`
	EnergyAfter           *int                  `json:"energyAfter,omitempty"`
	HPMax                 *int                  `json:"hpMax,omitempty"`
	EnergyCost            *int                  `json:"energyCost,omitempty"`
	StateStage            string                `json:"stateStage,omitempty"`
	StateActive           *bool                 `json:"stateActive,omitempty"`
	Combat                *BattleCombatEvidence `json:"combat,omitempty"`
	Growth                *BattleGrowthEvidence `json:"growth,omitempty"`
}

// A form transition describes the same roster instance, never a replacement
// initial species or proof that the pet appeared or used a skill.
type BattleFormChange struct {
	FromBaseID      string `json:"fromBaseId"`
	ToBaseID        string `json:"toBaseId"`
	FromMonsterID   int    `json:"fromMonsterId"`
	ToMonsterID     int    `json:"toMonsterId"`
	MappingRevision string `json:"mappingRevision,omitempty"`
	ExecIndex       int    `json:"execIndex"`
}

// Constraints are explicit normalized declarations, never synthesized from raw packets.
// Incomplete conditions are retained as notes; ModifiersKnown alone is not proof.
type BattleConstraint struct {
	ID             string  `json:"id"`
	Side           string  `json:"side"`
	InstanceID     string  `json:"instanceId"`
	Stat           string  `json:"stat"`
	Kind           string  `json:"kind"`
	KnownStat      float64 `json:"knownStat"`
	Power          float64 `json:"power"`
	Damage         *int    `json:"damage,omitempty"`
	Level          int     `json:"level"`
	Reduction      float64 `json:"reduction"`
	Effectiveness  float64 `json:"effectiveness"`
	Before         bool    `json:"before"`
	SamePriority   bool    `json:"samePriority"`
	ModifiersKnown bool    `json:"modifiersKnown"`
	Provenance     string  `json:"provenance"`
	Round          int     `json:"round"`
}
type BattleTeamRule struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	MonsterIDs         []int   `json:"monsterIds"`
	ExcludedMonsterIDs []int   `json:"excludedMonsterIds,omitempty"`
	AnyOf              [][]int `json:"anyOf,omitempty"`
	familyMatch        *battleRuleFamilyMatch
}
type BattleFilter struct {
	From        string   `json:"from,omitempty"`
	To          string   `json:"to,omitempty"`
	ToExclusive bool     `json:"toExclusive,omitempty"`
	Outcome     string   `json:"outcome,omitempty"`
	MonsterID   int      `json:"monsterId,omitempty"`
	TeamRuleID  string   `json:"teamRuleId,omitempty"`
	RankSide    string   `json:"rankSide,omitempty"`
	RankMetric  string   `json:"rankMetric,omitempty"`
	RankMin     *float64 `json:"rankMin,omitempty"`
	RankMax     *float64 `json:"rankMax,omitempty"`
	Tier        string   `json:"tier,omitempty"`
}
type BattleOutcomeStats struct {
	Win     int `json:"win"`
	Loss    int `json:"loss"`
	Draw    int `json:"draw"`
	Unknown int `json:"unknown"`
}
type BattleSkillStats struct {
	SkillID     int `json:"skillId"`
	UsedBattles int `json:"usedBattles"`
	Samples     int `json:"samples"`
	Casts       int `json:"casts"`
}
type BattleEnemyStats struct {
	MonsterID                int                       `json:"monsterId"`
	Name                     string                    `json:"name"`
	Carried                  int                       `json:"carried"`
	CarrySamples             int                       `json:"carrySamples"`
	Appeared                 int                       `json:"appeared"`
	AppearSamples            int                       `json:"appearSamples"`
	Leads                    int                       `json:"leads"`
	LeadSamples              int                       `json:"leadSamples"`
	CarriedLeadSamples       int                       `json:"carriedLeadSamples"`
	Skills                   []BattleSkillStats        `json:"skills"`
	IVDistributions          map[string]map[string]int `json:"ivDistributions"`
	NatureDistributions      map[string]map[string]int `json:"natureDistributions"`
	UnknownProfiles          int                       `json:"unknownProfiles"`
	ProfileSamples           int                       `json:"profileSamples"`
	IVSamples                map[string]int            `json:"ivSamples"`
	NatureSamples            map[string]int            `json:"natureSamples"`
	IVConditionalSamples     map[string]int            `json:"ivConditionalSamples"`
	NatureConditionalSamples map[string]int            `json:"natureConditionalSamples"`
}
type BattleSelfSkillStats struct {
	MonsterID   int    `json:"monsterId"`
	SkillID     int    `json:"skillId"`
	Kind        string `json:"kind,omitempty"`
	TypeID      *int   `json:"typeId,omitempty"`
	Casts       int    `json:"casts"`
	TotalCasts  int    `json:"totalCasts"`
	UsedBattles int    `json:"usedBattles"`
	Samples     int    `json:"samples"`
}
type BattleTeamStats struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Battles int    `json:"battles"`
	Samples int    `json:"samples"`
}
type BattleQualityStats struct {
	Roster  int `json:"roster"`
	Actions int `json:"actions"`
	Lead    int `json:"lead"`
}
type BattleStats struct {
	Revision         string                 `json:"revision,omitempty"`
	MatchedBattles   int                    `json:"matchedBattles"`
	Outcomes         BattleOutcomeStats     `json:"outcomes"`
	Enemy            []BattleEnemyStats     `json:"enemy"`
	SelfSkills       []BattleSelfSkillStats `json:"selfSkills"`
	SelfPerformance  *BattlePerformance     `json:"selfPerformance,omitempty"`
	EnemyPerformance *BattlePerformance     `json:"enemyPerformance,omitempty"`
	Archetypes       *BattleArchetypeStats  `json:"archetypes,omitempty"`
	Growth           *BattleGrowthStats     `json:"growth,omitempty"`
	Inference        BattleInferenceDTO     `json:"inference"`
	Teams            []BattleTeamStats      `json:"teams"`
	Quality          BattleQualityStats     `json:"quality"`
	Issues           []string               `json:"issues"`
}

var battleStatKeys = []string{"hp", "attack", "defense", "magic_attack", "magic_defense", "speed"}

func battleOneOf(s string, values ...string) bool {
	for _, v := range values {
		if s == v {
			return true
		}
	}
	return false
}
func battleFinite(n float64, lo, hi float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= lo && n <= hi
}
func battleID(s string, required bool) bool {
	if s == "" {
		return !required
	}
	if len(s) > 128 || strings.TrimSpace(s) != s {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
func battleText(s string, max int) (string, error) {
	if len(s) > max {
		return "", errors.New("text exceeds allowed length")
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return -1
		}
		return r
	}, s), nil
}
func battleTime(s *string) error {
	if *s == "" {
		return nil
	}
	if len(*s) > 64 {
		return errors.New("invalid timestamp; use RFC3339 with timezone")
	}
	t, err := time.Parse(time.RFC3339Nano, *s)
	if err != nil {
		return errors.New("invalid timestamp; use RFC3339 with timezone")
	}
	*s = t.UTC().Format(time.RFC3339Nano)
	return nil
}
func battleIssue(r *BattleRecord, issue string) {
	for _, s := range r.Issues {
		if s == issue {
			return
		}
	}
	if len(r.Issues) < 128 {
		r.Issues = append(r.Issues, issue)
	}
}
func battleRankValid(r *BattleRank) error {
	if r.Stars != nil && (*r.Stars < 0 || *r.Stars > 1000000000) {
		return errors.New("invalid rank stars")
	}
	if r.Score != nil && !battleFinite(*r.Score, 0, 1e12) {
		return errors.New("invalid score")
	}
	if r.Rank != nil && (*r.Rank < 1 || *r.Rank > 1000000000) {
		return errors.New("invalid leaderboard rank")
	}
	var err error
	r.Tier, err = battleText(r.Tier, 128)
	return err
}
func battleEvidenceValid(m map[string]BattleEvidence, nature bool) error {
	if len(m) > 6 {
		return errors.New("too many profile stats")
	}
	for k, e := range m {
		if !battleOneOf(k, battleStatKeys...) {
			return errors.New("unknown profile stat")
		}
		if e.Certainty == "" {
			e.Certainty = "unknown"
		}
		if !battleOneOf(e.Certainty, "direct", "unique", "candidate", "unknown") {
			return errors.New("invalid evidence certainty")
		}
		if !battleOneOf(e.Condition, "", "effective_iv_60") || e.Condition != "" && (k == "speed" || e.Certainty == "direct") {
			return errors.New("invalid conditional profile evidence")
		}
		if e.Condition == "effective_iv_60" && !nature && e.Value != nil && *e.Value != 60 {
			return errors.New("conditional profile IV conflicts with assumption")
		}
		hi := 60.0
		if nature {
			hi = 2
		}
		valid := func(v float64) bool { return battleFinite(v, 0, hi) && math.Trunc(v) == v }
		if e.Value != nil && !valid(*e.Value) {
			return errors.New("invalid normalized profile value")
		}
		if len(e.Candidates) > 61 || len(e.Evidence) > 128 {
			return errors.New("profile evidence exceeds limit")
		}
		seen := map[float64]bool{}
		vals := []float64{}
		for _, v := range e.Candidates {
			if !valid(v) {
				return errors.New("invalid profile candidate")
			}
			if !seen[v] {
				vals = append(vals, v)
				seen[v] = true
			}
		}
		sort.Float64s(vals)
		e.Candidates = vals
		for i, s := range e.Evidence {
			var err error
			e.Evidence[i], err = battleText(s, 768)
			if err != nil {
				return err
			}
		}
		switch e.Certainty {
		case "direct", "unique":
			if e.Value == nil {
				return errors.New("known evidence requires a value")
			}
			if len(vals) > 0 && (len(vals) != 1 || vals[0] != *e.Value) {
				return errors.New("evidence value conflicts with candidates")
			}
		case "candidate":
			if e.Value != nil || len(vals) == 0 {
				return errors.New("candidate evidence requires candidates and no fixed value")
			}
		case "unknown":
			if e.Value != nil || len(vals) > 0 {
				return errors.New("unknown evidence cannot assert numeric values")
			}
		}
		m[k] = e
	}
	return nil
}

// ValidateBattleRecord checks normalized declarations, not their truth in the game.
// Unknown attribution is retained visibly, but cannot confer action coverage.
func ValidateBattleRecord(r *BattleRecord) error {
	if r == nil {
		return errors.New("record is required")
	}
	if r.Version == 0 {
		r.Version = 1
	}
	if r.Version != 1 {
		return errors.New("unsupported battle record version")
	}
	if r.Rounds < 0 || r.Rounds > 1000000 {
		return errors.New("invalid authoritative round count")
	}
	if !battleID(r.ID, true) {
		return errors.New("invalid battle ID")
	}
	for _, p := range []*string{&r.StartedAt, &r.EndedAt, &r.ImportedAt} {
		if err := battleTime(p); err != nil {
			return err
		}
	}
	if r.StartedAt != "" && r.EndedAt != "" {
		a, _ := time.Parse(time.RFC3339Nano, r.StartedAt)
		b, _ := time.Parse(time.RFC3339Nano, r.EndedAt)
		if b.Before(a) {
			return errors.New("battle end precedes start")
		}
	}
	if r.Mode == "" {
		r.Mode = "unknown"
	}
	if r.Outcome == "" {
		r.Outcome = "unknown"
	}
	if !battleOneOf(r.Mode, "pvp", "unknown") || !battleOneOf(r.Outcome, "win", "loss", "draw", "unknown") {
		return errors.New("invalid mode or outcome")
	}
	var err error
	r.Source, err = battleText(r.Source, 128)
	if err != nil {
		return err
	}
	if len(r.Issues) > 128 {
		return errors.New("too many issues")
	}
	cleanIssues := []string{}
	for _, s := range r.Issues {
		s, err = battleText(s, 512)
		if err != nil {
			return err
		}
		if !battleOneOf(s, cleanIssues...) {
			cleanIssues = append(cleanIssues, s)
		}
	}
	r.Issues = cleanIssues
	if len(r.Sides) > 2 || len(r.Events) > BattleMaxEvents || len(r.Constraints) > 512 || len(r.SpeedObservations) > 512 {
		return errors.New("record exceeds collection limits")
	}
	if r.Sides == nil {
		r.Sides = map[string]BattleSide{}
	}
	for side := range r.Sides {
		if !battleOneOf(side, "me", "enemy") {
			return errors.New("invalid roster side")
		}
	}
	for k := range r.Quality.Roster {
		if !battleOneOf(k, "me", "enemy") {
			return errors.New("invalid roster quality side")
		}
	}
	for k := range r.Quality.Lead {
		if !battleOneOf(k, "me", "enemy") {
			return errors.New("invalid lead quality side")
		}
	}
	if r.Quality.Roster == nil {
		r.Quality.Roster = map[string]bool{}
	}
	if r.Quality.Lead == nil {
		r.Quality.Lead = map[string]bool{}
	}
	pets := map[string]map[string]BattlePet{"me": {}, "enemy": {}}
	for _, side := range []string{"me", "enemy"} {
		s := r.Sides[side]
		if len(s.Pets) > 24 {
			return errors.New("too many pets per side")
		}
		if err = battleRankValid(&s.Before); err != nil {
			return err
		}
		if err = battleRankValid(&s.After); err != nil {
			return err
		}
		if s.Matching != nil {
			if err = battleRankValid(s.Matching); err != nil {
				return err
			}
		}
		clean := []BattlePet{}
		rosterOK := len(s.Pets) > 0
		for _, p := range s.Pets {
			if !battleID(p.InstanceID, true) || !battleID(p.ProtocolID, false) || !battleBaseID(p.ProtocolBaseID, false) || !battleMappingRevision(p.MappingRevision) || p.MappingRevision != "" && (p.ProtocolBaseID == "" || p.MonsterID == 0) || p.MonsterID < 0 || p.MonsterID > 1000000000 {
				return errors.New("invalid pet identity")
			}
			if p.Level != nil && (*p.Level < 1 || *p.Level > 100) {
				return errors.New("invalid pet level")
			}
			p.Name, err = battleText(p.Name, 128)
			if err != nil {
				return err
			}
			if err = battlePetSpeedValid(p); err != nil {
				return err
			}
			if err = battleEvidenceValid(p.IV, false); err != nil {
				return err
			}
			if err = battleEvidenceValid(p.Nature, true); err != nil {
				return err
			}
			if err = battleInitialSkillsValid(p.InitialSkills); err != nil {
				return err
			}
			if old, ok := pets[side][p.InstanceID]; ok {
				if !reflect.DeepEqual(old, p) {
					return errors.New("conflicting pet instance ID")
				}
				continue
			}
			pets[side][p.InstanceID] = p
			clean = append(clean, p)
			if p.MonsterID == 0 {
				rosterOK = false
			}
		}
		s.Pets = clean
		if !battleID(s.Lead, false) {
			return errors.New("invalid lead instance ID")
		}
		lead, leadOK := pets[side][s.Lead]
		leadOK = leadOK && lead.MonsterID > 0
		if s.Lead != "" && !leadOK {
			battleIssue(r, "Lead identity is not fully mapped; lead coverage excluded.")
		}
		if r.Quality.Roster[side] && !rosterOK {
			battleIssue(r, "Roster completeness downgraded: empty or unmapped roster.")
			r.Quality.Roster[side] = false
		}
		if r.Quality.Lead[side] && !leadOK {
			battleIssue(r, "Lead completeness downgraded: no confirmed mapped lead.")
			r.Quality.Lead[side] = false
		}
		// Always serialize both flags (false means unknown, not an empty complete roster).
		r.Quality.Roster[side] = r.Quality.Roster[side]
		r.Quality.Lead[side] = r.Quality.Lead[side]
		r.Sides[side] = s
	}
	resolve := func(side *string, id string) bool {
		if id == "" {
			return false
		}
		if *side == "me" || *side == "enemy" {
			p, ok := pets[*side][id]
			return ok && p.MonsterID > 0
		}
		a, aok := pets["me"][id]
		b, bok := pets["enemy"][id]
		if aok == bok {
			return false
		}
		if aok {
			*side = "me"
			return a.MonsterID > 0
		}
		*side = "enemy"
		return b.MonsterID > 0
	}
	cleanEvents := []BattleEvent{}
	eventIDs := map[string]BattleEvent{}
	actionsOK := len(r.Events) > 0
	executed := false
	for _, e := range r.Events {
		if !battleID(e.ID, true) || !battleID(e.Actor, false) || !battleID(e.Target, false) || !battleID(e.ProtocolSkillID, false) {
			return errors.New("invalid event identity")
		}
		if !battleBaseID(e.ProtocolSkillConfigID, false) || e.ProtocolSkillConfigID != "" && e.ProtocolSkillID == "" {
			return errors.New("invalid explicit protocol skill configuration binding")
		}
		if e.Round < 0 || e.Round > 1000000 || e.Seq < 0 || e.Seq > 1000000000 || e.SkillID < 0 || e.SkillID > 1000000000 {
			return errors.New("invalid event index or skill ID")
		}
		if e.Phase == "" {
			e.Phase = "unknown"
		}
		if e.Side == "" {
			e.Side = "unknown"
		}
		if !battleOneOf(e.Kind, "skill", "damage", "switch", "effect", "growth", "heal", "weather", "note", "order", "form", "resource") || !battleOneOf(e.Phase, "executed", "preview", "selection", "unknown", "interrupted") || !battleOneOf(e.Side, "me", "enemy", "unknown") || !battleOneOf(e.TargetSide, "", "me", "enemy", "unknown") {
			return errors.New("invalid event enum")
		}
		if err = battleTime(&e.At); err != nil {
			return err
		}
		if e.Amount != nil && !battleFinite(*e.Amount, 0, 1e12) {
			return errors.New("invalid event amount")
		}
		if e.Stacks != nil && (*e.Stacks < 0 || *e.Stacks > 1000000) {
			return errors.New("invalid event stacks")
		}
		e.Trigger, err = battleText(e.Trigger, 256)
		if err != nil {
			return err
		}
		e.Text, err = battleText(e.Text, 2048)
		if err != nil {
			return err
		}
		if err := battleValidateActionFields(&e); err != nil {
			return err
		}
		if err := battleValidateStateFields(&e); err != nil {
			return err
		}
		if e.StateStage != "" {
			if _, ok := pets[e.Side][e.Actor]; !ok {
				return errors.New("state snapshot actor is outside the roster")
			}
		}
		if e.Kind == "form" {
			f := e.Form
			_, actorExists := pets[e.Side][e.Actor]
			if f == nil || e.Phase != "executed" || !battleOneOf(e.Side, "me", "enemy") || !actorExists || e.Actor == "" {
				return errors.New("form requires executed phase and an explicit roster actor/side")
			}
			if !battleBaseID(f.FromBaseID, true) || !battleBaseID(f.ToBaseID, true) || f.FromBaseID == f.ToBaseID || f.FromMonsterID < 0 || f.FromMonsterID > 1000000000 || f.ToMonsterID < 0 || f.ToMonsterID > 1000000000 || f.ExecIndex < 0 || f.ExecIndex > 1000000000 || !battleMappingRevision(f.MappingRevision) || f.MappingRevision != "" && f.FromMonsterID == 0 && f.ToMonsterID == 0 {
				return errors.New("invalid form identity, mapping or execution index")
			}
			if e.SkillID != 0 || e.ProtocolSkillID != "" || e.Target != "" || e.TargetSide != "" || e.Amount != nil || e.Stacks != nil || e.Trigger != "" {
				return errors.New("form must not assert skill, target or effect fields")
			}
		} else if e.Form != nil {
			return errors.New("form payload requires form event kind")
		}
		actorOK := resolve(&e.Side, e.Actor)
		targetOK := resolve(&e.TargetSide, e.Target)
		if e.Actor != "" && !actorOK && e.Side != "unknown" {
			other := "me"
			if e.Side == "me" {
				other = "enemy"
			}
			if _, ok := pets[e.Side][e.Actor]; !ok {
				if _, wrong := pets[other][e.Actor]; wrong {
					return errors.New("event actor conflicts with declared side")
				}
			}
		}
		if e.Target != "" && !targetOK && battleOneOf(e.TargetSide, "me", "enemy") {
			other := "me"
			if e.TargetSide == "me" {
				other = "enemy"
			}
			if _, ok := pets[e.TargetSide][e.Target]; !ok {
				if _, wrong := pets[other][e.Target]; wrong {
					return errors.New("event target conflicts with declared side")
				}
			}
		}
		combat := !battleIsStunSkip(e) && e.Kind != "note" && e.Kind != "weather" && e.Kind != "form" && e.Kind != "resource"
		if combat && e.Phase == "unknown" {
			actionsOK = false
		}
		if combat && e.Phase == "executed" {
			executed = true
			if !actorOK || (e.Target != "" && !targetOK) || (e.Kind == "skill" && e.SkillID == 0) {
				actionsOK = false
				battleIssue(r, "Unmapped executed event excluded from complete action samples.")
			}
		}
		_, growthActorKnown := pets[e.Side][e.Actor]
		if e.Kind == "growth" && (e.Phase != "executed" || !growthActorKnown || e.Growth == nil && strings.TrimSpace(e.Trigger) == "") {
			return errors.New("growth requires executed phase, mapped actor and explicit trigger")
		}
		if old, ok := eventIDs[e.ID]; ok {
			if !reflect.DeepEqual(old, e) {
				return errors.New("conflicting event ID")
			}
			continue
		}
		eventIDs[e.ID] = e
		cleanEvents = append(cleanEvents, e)
	}
	r.Events = cleanEvents
	// Preserve legacy timeline order when no forms are present. Form timelines
	// have explicit execution order after round and protocol sequence.
	for _, event := range r.Events {
		if event.Form != nil || event.ExecIndex != nil {
			sort.SliceStable(r.Events, func(i, j int) bool {
				a, b := r.Events[i], r.Events[j]
				if a.Round != b.Round {
					return a.Round < b.Round
				}
				if a.Seq != b.Seq {
					return a.Seq < b.Seq
				}
				x, y := 0, 0
				if a.ExecIndex != nil {
					x = *a.ExecIndex
				} else if a.Form != nil {
					x = a.Form.ExecIndex
				}
				if b.ExecIndex != nil {
					y = *b.ExecIndex
				} else if b.Form != nil {
					y = b.Form.ExecIndex
				}
				return x < y
			})
			break
		}
	}
	if r.Quality.Actions && (!actionsOK || !executed) {
		r.Quality.Actions = false
		battleIssue(r, "Action completeness downgraded: no attributable executed actions or incomplete attribution.")
	}
	constraints := []BattleConstraint{}
	ids := map[string]BattleConstraint{}
	for _, c := range r.Constraints {
		if !battleID(c.ID, true) || !battleID(c.InstanceID, true) || !battleOneOf(c.Side, "me", "enemy") {
			return errors.New("invalid constraint identity")
		}
		if _, ok := pets[c.Side][c.InstanceID]; !ok {
			return errors.New("constraint instance not in declared side")
		}
		if !battleOneOf(c.Kind, "damageDealt", "damageReceived", "speedOrder") {
			return errors.New("invalid constraint kind")
		}
		validStat := c.Kind == "speedOrder" && c.Stat == "speed" || c.Kind == "damageDealt" && battleOneOf(c.Stat, "attack", "magic_attack") || c.Kind == "damageReceived" && battleOneOf(c.Stat, "defense", "magic_defense")
		if !validStat {
			return errors.New("constraint stat does not match kind")
		}
		if !battleFinite(c.KnownStat, 0, 1e6) || !battleFinite(c.Power, 0, 1e6) || !battleFinite(c.Reduction, 0, 1) || !battleFinite(c.Effectiveness, 0, 4) || c.Level < 0 || c.Level > 99 || c.Round < 0 || c.Round > 1000000 || c.Damage != nil && (*c.Damage < 0 || *c.Damage > 100000000) {
			return errors.New("constraint numeric condition out of bounds")
		}
		c.Provenance, err = battleText(c.Provenance, 512)
		if err != nil {
			return err
		}
		pet := pets[c.Side][c.InstanceID]
		if c.Kind == "damageDealt" && c.Level != 0 && pet.Level != nil && c.Level != *pet.Level {
			return errors.New("constraint attacker level conflicts with pet level")
		}
		if !c.ModifiersKnown || pet.MonsterID == 0 || pet.Level == nil || c.KnownStat == 0 || c.Level == 0 || c.Provenance == "" || (c.Kind == "speedOrder" && !c.SamePriority) || (c.Kind != "speedOrder" && (c.Power == 0 || c.Damage == nil || c.Effectiveness == 0 || c.Reduction == 0)) {
			battleIssue(r, "Incomplete constraint retained as a note; not sufficient for inference.")
		}
		if old, ok := ids[c.ID]; ok {
			if !reflect.DeepEqual(old, c) {
				return errors.New("conflicting constraint ID")
			}
			continue
		}
		ids[c.ID] = c
		constraints = append(constraints, c)
	}
	r.Constraints = constraints
	if err := battleCombatRecordsValid(r); err != nil {
		return err
	}
	if err := battleGrowthRecordsValid(r); err != nil {
		return err
	}
	return battleDisplayMetadataValid(r)
}

func battleClone(r BattleRecord) (BattleRecord, error) {
	data, err := json.Marshal(r)
	if err != nil {
		return BattleRecord{}, errors.New("invalid non-finite record")
	}
	var out BattleRecord
	if err = json.Unmarshal(data, &out); err != nil {
		return BattleRecord{}, errors.New("invalid record")
	}
	return out, nil
}

// mergeKnown fills only unknown fields. Two nonzero conflicting declarations fail.
func battleMergeKnown(dst, src any) error {
	return battleMergeValue(reflect.ValueOf(dst).Elem(), reflect.ValueOf(src))
}
func battleMergeValue(a, b reflect.Value) error {
	if b.IsZero() {
		return nil
	}
	if a.IsZero() {
		a.Set(b)
		return nil
	}
	switch a.Kind() {
	case reflect.Struct:
		for i := 0; i < a.NumField(); i++ {
			if err := battleMergeValue(a.Field(i), b.Field(i)); err != nil {
				return err
			}
		}
		return nil
	case reflect.String:
		if a.String() == "unknown" {
			a.Set(b)
			return nil
		}
		if b.String() == "unknown" {
			return nil
		}
	}
	if reflect.DeepEqual(a.Interface(), b.Interface()) {
		return nil
	}
	return errors.New("conflicting known record values")
}
func battleMergeEvidence(a, b BattleEvidence) (BattleEvidence, error) {
	if b.Certainty == "unknown" || b.Certainty == "" {
		return a, nil
	}
	if a.Certainty == "unknown" || a.Certainty == "" {
		return b, nil
	}
	originalEvidence := append([]string{}, a.Evidence...)
	values := func(e BattleEvidence) []float64 {
		if e.Value != nil {
			return []float64{*e.Value}
		}
		return e.Candidates
	}
	av, bv := values(a), values(b)
	common := []float64{}
	for _, v := range av {
		for _, w := range bv {
			if v == w {
				common = append(common, v)
				break
			}
		}
	}
	if len(common) == 0 {
		return a, errors.New("conflicting profile evidence")
	}
	if a.Certainty == "direct" { /* never downgrade direct evidence */
	} else if b.Certainty == "direct" || b.Certainty == "unique" {
		a = b
	} else if a.Certainty == "candidate" {
		a.Candidates = common
		if len(common) == 1 && len(av) > len(common) {
			v := common[0]
			a.Value = &v
			a.Candidates = nil
			a.Certainty = "unique"
		}
	}
	for _, s := range append(originalEvidence, b.Evidence...) {
		if !battleOneOf(s, a.Evidence...) {
			a.Evidence = append(a.Evidence, s)
		}
	}
	return a, nil
}
func battleMergePet(a, b BattlePet) (BattlePet, error) {
	skills, skillErr := battleMergeInitialSkills(a.InitialSkills, b.InitialSkills)
	if skillErr != nil {
		return a, skillErr
	}
	a.InitialSkills, b.InitialSkills = nil, nil
	// Catalogue bytes may change without changing identity. Keep the first
	// established mapping revision rather than making replay a conflict/update.
	revision := a.MappingRevision
	if a.MonsterID == 0 || revision == "" {
		revision = b.MappingRevision
	}
	a.MappingRevision, b.MappingRevision = "", ""
	iv, nat := a.IV, a.Nature
	a.IV = nil
	a.Nature = nil
	bi, bn := b.IV, b.Nature
	b.IV = nil
	b.Nature = nil
	if err := battleMergeKnown(&a, b); err != nil {
		return a, err
	}
	merge := func(dst, src map[string]BattleEvidence) (map[string]BattleEvidence, error) {
		if dst == nil {
			dst = map[string]BattleEvidence{}
		}
		for k, e := range src {
			m, err := battleMergeEvidence(dst[k], e)
			if err != nil {
				return nil, err
			}
			dst[k] = m
		}
		return dst, nil
	}
	var err error
	a.IV, err = merge(iv, bi)
	if err != nil {
		return a, err
	}
	a.Nature, err = merge(nat, bn)
	a.MappingRevision = revision
	a.InitialSkills = skills
	return a, err
}

// MergeBattleRecord never mutates its inputs. Unioning partial captures cannot
// manufacture completeness. Extending a complete capture withdraws its flag.
func MergeBattleRecord(existing, incoming BattleRecord) (BattleRecord, error) {
	a, err := battleClone(existing)
	if err != nil {
		return BattleRecord{}, err
	}
	b, err := battleClone(incoming)
	if err != nil {
		return BattleRecord{}, err
	}
	if err = ValidateBattleRecord(&a); err != nil {
		return BattleRecord{}, err
	}
	if err = ValidateBattleRecord(&b); err != nil {
		return BattleRecord{}, err
	}
	if a.ID != b.ID {
		return BattleRecord{}, errors.New("battle IDs do not match")
	}
	for _, pair := range [][2]*string{{&a.StartedAt, &b.StartedAt}, {&a.EndedAt, &b.EndedAt}, {&a.Mode, &b.Mode}, {&a.Outcome, &b.Outcome}} {
		if err = battleMergeKnown(pair[0], *pair[1]); err != nil {
			return BattleRecord{}, err
		}
	}
	if err = battleMergeKnown(&a.Rounds, b.Rounds); err != nil {
		return BattleRecord{}, err
	}
	if err = battleMergeDisplayMetadata(&a, b); err != nil {
		return BattleRecord{}, err
	}
	// Retain original import provenance; it is not battle identity.
	if a.ImportedAt == "" {
		a.ImportedAt = b.ImportedAt
	}
	if a.Source == "" {
		a.Source = b.Source
	}
	for _, side := range []string{"me", "enemy"} {
		x, y := a.Sides[side], b.Sides[side]
		for _, pair := range [][2]*BattleRank{{&x.Before, &y.Before}, {&x.After, &y.After}} {
			if err = battleMergeKnown(pair[0], *pair[1]); err != nil {
				return BattleRecord{}, err
			}
		}
		if y.Matching != nil {
			if x.Matching == nil {
				x.Matching = &BattleRank{}
			}
			if err = battleMergeKnown(x.Matching, *y.Matching); err != nil {
				return BattleRecord{}, err
			}
		}
		if err = battleMergeKnown(&x.Lead, y.Lead); err != nil {
			return BattleRecord{}, err
		}
		oldSet := map[string]bool{}
		for _, p := range x.Pets {
			oldSet[p.InstanceID] = true
		}
		newSet := map[string]bool{}
		for _, p := range y.Pets {
			newSet[p.InstanceID] = true
		}
		for _, p := range y.Pets {
			found := -1
			for i, q := range x.Pets {
				if q.InstanceID == p.InstanceID {
					found = i
					break
				}
			}
			if found < 0 {
				x.Pets = append(x.Pets, p)
			} else {
				x.Pets[found], err = battleMergePet(x.Pets[found], p)
				if err != nil {
					return BattleRecord{}, err
				}
			}
		}
		coverage := a.Quality.Roster[side] || b.Quality.Roster[side]
		if a.Quality.Roster[side] {
			for id := range newSet {
				if !oldSet[id] {
					coverage = false
				}
			}
		}
		if b.Quality.Roster[side] {
			for id := range oldSet {
				if !newSet[id] {
					coverage = false
				}
			}
		}
		if !coverage && (a.Quality.Roster[side] || b.Quality.Roster[side]) {
			battleIssue(&a, "Merged roster extends a declared complete roster; completeness withdrawn.")
		}
		a.Quality.Roster[side] = coverage
		a.Quality.Lead[side] = a.Quality.Lead[side] || b.Quality.Lead[side]
		a.Sides[side] = x
	}
	ids := map[string]BattleEvent{}
	eventPositions := map[string]int{}
	for i, e := range a.Events {
		ids[e.ID] = e
		eventPositions[e.ID] = i
	}
	extendsA, extendsB := false, false
	incomingIDs := map[string]bool{}
	for _, e := range b.Events {
		incomingIDs[e.ID] = true
		if old, ok := ids[e.ID]; ok {
			var merged BattleEvent
			var mergeErr error
			if existing.Source == "rkpp-live-v1" && incoming.Source == "rkpp-live-v1" {
				merged, mergeErr = battleMergeLiveEvent(old, e)
			} else {
				merged, mergeErr = battleMergeEvent(old, e)
			}
			if mergeErr != nil {
				return BattleRecord{}, mergeErr
			}
			a.Events[eventPositions[e.ID]] = merged
		} else {
			a.Events = append(a.Events, e)
			extendsA = true
		}
	}
	for id := range ids {
		if !incomingIDs[id] {
			extendsB = true
		}
	}
	actions := a.Quality.Actions || b.Quality.Actions
	if (a.Quality.Actions && extendsA) || (b.Quality.Actions && extendsB) {
		actions = false
		battleIssue(&a, "Merged events extend a declared complete capture; action completeness withdrawn.")
	}
	a.Quality.Actions = actions
	cids := map[string]BattleConstraint{}
	for _, c := range a.Constraints {
		cids[c.ID] = c
	}
	for _, c := range b.Constraints {
		if old, ok := cids[c.ID]; ok {
			if !reflect.DeepEqual(old, c) {
				return BattleRecord{}, errors.New("conflicting constraint ID")
			}
		} else {
			a.Constraints = append(a.Constraints, c)
		}
	}
	for _, issue := range b.Issues {
		battleIssue(&a, issue)
	}
	if err = ValidateBattleRecord(&a); err != nil {
		return BattleRecord{}, err
	}
	return a, nil
}

// Manual Wiki skill mapping may fill an unknown ID, but cannot alter the
// protocol skill, attribution, phase, amount, ordering or any other event fact.
func battleMergeEvent(a, b BattleEvent) (BattleEvent, error) {
	config := a.ProtocolSkillConfigID
	if config == "" {
		config = b.ProtocolSkillConfigID
	} else if b.ProtocolSkillConfigID != "" && b.ProtocolSkillConfigID != config {
		return BattleEvent{}, errors.New("conflicting protocol skill configuration binding")
	}
	a.ProtocolSkillConfigID, b.ProtocolSkillConfigID = config, config
	id := a.SkillID
	if id == 0 {
		id = b.SkillID
	} else if b.SkillID != 0 && b.SkillID != id {
		return BattleEvent{}, errors.New("conflicting event skill mapping")
	}
	a.SkillID, b.SkillID = id, id
	if err := battleMergeActionFields(&a, &b); err != nil {
		return BattleEvent{}, err
	}
	if err := battleMergeStateFields(&a, &b); err != nil {
		return BattleEvent{}, err
	}
	if err := battleMergeCombatFields(&a, &b); err != nil {
		return BattleEvent{}, err
	}
	if err := battleMergeGrowthFields(&a, &b); err != nil {
		return BattleEvent{}, err
	}
	if a.Form != nil && b.Form != nil {
		// Only local mapping fields can be enriched. The transition's bases and
		// execution order remain immutable facts attached to this same event.
		x, y := *a.Form, *b.Form
		revision := x.MappingRevision
		if revision == "" || x.FromMonsterID == 0 && y.FromMonsterID != 0 || x.ToMonsterID == 0 && y.ToMonsterID != 0 {
			revision = y.MappingRevision
		}
		for _, pair := range [][2]*int{{&x.FromMonsterID, &y.FromMonsterID}, {&x.ToMonsterID, &y.ToMonsterID}} {
			if err := battleMergeKnown(pair[0], *pair[1]); err != nil {
				return BattleEvent{}, err
			}
			*pair[1] = *pair[0]
		}
		x.MappingRevision, y.MappingRevision = revision, revision
		a.Form, b.Form = &x, &y
	}
	if !reflect.DeepEqual(a, b) {
		return BattleEvent{}, errors.New("conflicting event ID")
	}
	return a, nil
}
