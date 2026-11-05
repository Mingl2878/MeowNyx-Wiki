package main

import (
	"sort"
	"strconv"
	"time"
)

// Filters use known pre-battle rank values only; post-battle changes must not
// silently move unknown pre-battle samples into another cohort. Time is StartedAt. Date-only
// From/To are UTC calendar days, with To inclusive through the end of that day.
func MatchBattleRecord(record BattleRecord, f BattleFilter, rules []BattleTeamRule) bool {
	if f.Outcome != "" && (!battleOneOf(f.Outcome, "win", "loss", "draw", "unknown") || record.Outcome != f.Outcome) {
		return false
	}
	if f.ToExclusive && f.To == "" {
		return false
	}
	if f.From != "" || f.To != "" {
		t, err := time.Parse(time.RFC3339Nano, record.StartedAt)
		if err != nil {
			return false
		}
		if f.From != "" {
			b, ok := battleFilterTime(f.From, false)
			if !ok || t.Before(b) {
				return false
			}
		}
		if f.To != "" {
			b, ok := battleFilterTime(f.To, !f.ToExclusive)
			if !ok || t.After(b) || f.ToExclusive && t.Equal(b) {
				return false
			}
		}
	}
	if f.MonsterID < 0 {
		return false
	}
	if f.MonsterID > 0 {
		found := false
		for _, s := range record.Sides {
			for _, p := range s.Pets {
				if p.MonsterID == f.MonsterID {
					found = true
				}
			}
		}
		if !found {
			return false
		}
	}
	if f.TeamRuleID != "" {
		assigned, eligible := battleMatchedArchetypes(record, rules)
		if !eligible || !battleOneOf(f.TeamRuleID, assigned...) {
			return false
		}
	}
	rankActive := f.RankMin != nil || f.RankMax != nil || f.Tier != ""
	if rankActive {
		side := f.RankSide
		if side == "" {
			side = "me"
		}
		if !battleOneOf(side, "me", "enemy") {
			return false
		}
		s := record.Sides[side]
		metric := f.RankMetric
		if metric == "" {
			metric = "score"
		}
		if !battleOneOf(metric, "score", "rank", "tier") {
			return false
		}
		if f.Tier != "" {
			tier := s.Before.Tier
			if tier == "" || tier != f.Tier {
				return false
			}
		}
		if f.RankMin != nil || f.RankMax != nil {
			if metric == "tier" {
				return false
			}
			var value *float64
			if metric == "score" {
				value = s.Before.Score
			} else {
				rank := s.Before.Rank
				if rank != nil {
					v := float64(*rank)
					value = &v
				}
			}
			if value == nil || !battleFinite(*value, 0, 1e12) {
				return false
			}
			if f.RankMin != nil && (!battleFinite(*f.RankMin, 0, 1e12) || *value < *f.RankMin) {
				return false
			}
			if f.RankMax != nil && (!battleFinite(*f.RankMax, 0, 1e12) || *value > *f.RankMax) {
				return false
			}
		}
	}
	return true
}
func battleFilterTime(s string, end bool) (time.Time, bool) {
	if len(s) == 10 {
		t, err := time.Parse("2006-01-02", s)
		if err != nil {
			return time.Time{}, false
		}
		if end {
			t = t.AddDate(0, 0, 1).Add(-time.Nanosecond)
		}
		return t, true
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	return t, err == nil
}
func battleContainsTeam(r BattleRecord, rule BattleTeamRule) bool {
	if !r.Quality.Roster["enemy"] || len(r.Sides["enemy"].Pets) == 0 || len(rule.MonsterIDs) == 0 || len(rule.MonsterIDs) > 24 || len(rule.ExcludedMonsterIDs) > 24 {
		return false
	}
	have := map[int]bool{}
	for _, p := range r.Sides["enemy"].Pets {
		if p.MonsterID <= 0 {
			return false
		}
		have[p.MonsterID] = true
	}
	for _, id := range rule.ExcludedMonsterIDs {
		if id <= 0 || have[id] {
			return false
		}
	}
	for _, id := range rule.MonsterIDs {
		if id <= 0 || !have[id] {
			return false
		}
	}
	return true
}

type battleStatsMatch struct {
	r        BattleRecord
	species  map[string]map[int][]BattlePet
	appeared map[string]map[int]bool
	casts    map[string]map[int]map[int]int
}

func battleStatMatch(r BattleRecord) battleStatsMatch {
	m := battleStatsMatch{r: r, species: map[string]map[int][]BattlePet{}, appeared: map[string]map[int]bool{}, casts: map[string]map[int]map[int]int{}}
	instances := map[string]map[string]int{}
	for _, side := range []string{"me", "enemy"} {
		m.species[side] = map[int][]BattlePet{}
		m.appeared[side] = map[int]bool{}
		m.casts[side] = map[int]map[int]int{}
		instances[side] = map[string]int{}
		for _, p := range r.Sides[side].Pets {
			if p.MonsterID > 0 {
				m.species[side][p.MonsterID] = append(m.species[side][p.MonsterID], p)
				instances[side][p.InstanceID] = p.MonsterID
			}
		}
		if id := instances[side][r.Sides[side].Lead]; r.Quality.Lead[side] && id > 0 {
			m.appeared[side][id] = true
		}
	}
	for _, e := range r.Events {
		if e.Side == "me" && e.Phase == "executed" && e.Kind == "resource" && e.StateActive != nil && *e.StateActive && battleOneOf(e.StateStage, "initial", "snapshot", "entry") {
			if id := instances[e.Side][e.Actor]; id > 0 {
				m.appeared[e.Side][id] = true
			}
		}
		// Bench-wide damage, heals, traits and growth do not prove entry.
		// Explicit active snapshots, leads, executed casts and switches do.
		if battleIsStunSkip(e) || e.Phase != "executed" || !battleOneOf(e.Kind, "skill", "switch") {
			continue
		}
		actor := instances[e.Side][e.Actor]
		target := instances[e.TargetSide][e.Target]
		if actor > 0 {
			m.appeared[e.Side][actor] = true
		}
		if e.Kind == "switch" && target > 0 {
			m.appeared[e.TargetSide][target] = true
		}
		if e.Kind == "skill" && actor > 0 && e.SkillID > 0 {
			if m.casts[e.Side][actor] == nil {
				m.casts[e.Side][actor] = map[int]int{}
			}
			m.casts[e.Side][actor][e.SkillID]++
		}
	}
	return m
}

// Own usage has a separate identity from enemy occurrence statistics. Normal
// casts retain their canonical skill ID; wish actions have no invented skill ID
// and are grouped only by explicit normalized type evidence (zero is unknown).
// Initial roster species owns all casts by the same instance, including forms.
type battleSelfSkillKey struct {
	kind    string
	skillID int
	typeID  int
}
type battleSelfSkillUsage struct {
	appeared map[int]bool
	casts    map[int]map[battleSelfSkillKey]int
}

func battleSelfSkillBucket(e BattleEvent) (battleSelfSkillKey, bool) {
	return battleSideSkillBucket(e, "me")
}
func battleSideSkillBucket(e BattleEvent, side string) (battleSelfSkillKey, bool) {
	if battleIsStunSkip(e) || !battleOneOf(side, "me", "enemy") || e.Side != side || e.Phase != "executed" || e.ProtocolSkillID == "700001000" {
		return battleSelfSkillKey{}, false
	}
	if e.Combat != nil && e.Combat.ActionKind == "wishImpact" && (e.Kind == "skill" || e.Kind == "effect" && e.SkillClass == "system") {
		key := battleSelfSkillKey{kind: "wishImpact"}
		if e.Combat.TypeID != nil {
			key.typeID = *e.Combat.TypeID
		}
		return key, true
	}
	// Charge/system notifications, damage segments, unmapped skill-zero events
	// and unsuccessful attempts do not create slices or increase total casts.
	if e.Kind == "skill" && e.SkillID > 0 {
		return battleSelfSkillKey{skillID: e.SkillID}, true
	}
	return battleSelfSkillKey{}, false
}

func battleOwnSkillUsage(r BattleRecord) battleSelfSkillUsage {
	return battleSideSkillUsage(r, "me")
}
func battleSideSkillUsage(r BattleRecord, side string) battleSelfSkillUsage {
	usage := battleSelfSkillUsage{appeared: map[int]bool{}, casts: map[int]map[battleSelfSkillKey]int{}}
	if !battleOneOf(side, "me", "enemy") {
		return usage
	}
	instances := map[string]int{}
	for _, p := range r.Sides[side].Pets {
		instances[p.InstanceID] = p.MonsterID
	}
	if id := instances[r.Sides[side].Lead]; r.Quality.Lead[side] && id > 0 {
		usage.appeared[id] = true
	}
	// Callers already canonicalize and merge event IDs. Iterate each
	// completed action once, never its linked damage/resource/effect fragments.
	for _, e := range r.Events {
		if battleIsStunSkip(e) || e.Phase != "executed" {
			continue
		}
		if e.Side == side {
			id := instances[e.Actor]
			if id > 0 && (battleOneOf(e.Kind, "skill", "switch") || e.Kind == "resource" && e.StateActive != nil && *e.StateActive && battleOneOf(e.StateStage, "initial", "snapshot", "entry")) {
				usage.appeared[id] = true
			}
			if key, counted := battleSideSkillBucket(e, side); counted && id > 0 {
				usage.appeared[id] = true
				if usage.casts[id] == nil {
					usage.casts[id] = map[battleSelfSkillKey]int{}
				}
				usage.casts[id][key]++
			}
		}
		if e.Kind == "switch" && e.TargetSide == side {
			if id := instances[e.Target]; id > 0 {
				usage.appeared[id] = true
			}
		}
	}
	return usage
}

// This accumulator is shared by global compatibility statistics and exact-lineup
// projections. A battle contributes once per observed initial species, while all
// of its same-species instances contribute their actual casts. Accumulating only
// observed buckets avoids rescanning every battle for every output skill.
type battleSelfSkillAccumulator map[int]*battleSelfSkillSpeciesTotals

type battleSelfSkillSpeciesTotals struct {
	samples, totalCasts int
	skills              map[battleSelfSkillKey]*BattleSelfSkillStats
}

func (a battleSelfSkillAccumulator) add(usage battleSelfSkillUsage) {
	for species, appeared := range usage.appeared {
		if !appeared {
			continue
		}
		totals := a[species]
		if totals == nil {
			totals = &battleSelfSkillSpeciesTotals{skills: map[battleSelfSkillKey]*BattleSelfSkillStats{}}
			a[species] = totals
		}
		totals.samples++
		for key, casts := range usage.casts[species] {
			s := totals.skills[key]
			if s == nil {
				s = &BattleSelfSkillStats{MonsterID: species, SkillID: key.skillID, Kind: key.kind}
				totals.skills[key] = s
			}
			s.Casts += casts
			if casts > 0 {
				s.UsedBattles++
			}
			totals.totalCasts += casts
		}
	}
}

func (a battleSelfSkillAccumulator) stats() []BattleSelfSkillStats {
	out := []BattleSelfSkillStats{}
	for _, totals := range a {
		for key, counts := range totals.skills {
			s := *counts
			s.Samples, s.TotalCasts = totals.samples, totals.totalCasts
			if key.typeID > 0 {
				typeID := key.typeID
				s.TypeID = &typeID
			}
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.MonsterID != b.MonsterID {
			return a.MonsterID < b.MonsterID
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.SkillID != b.SkillID {
			return a.SkillID < b.SkillID
		}
		aType, bType := 0, 0
		if a.TypeID != nil {
			aType = *a.TypeID
		}
		if b.TypeID != nil {
			bType = *b.TypeID
		}
		return aType < bType
	})
	return out
}

// Every ratio is assembled from the same eligible population for numerator and
// denominator. Partial matches cannot increase a numerator without a sample.
// Profiles count per species/battle/stat only when every same-species instance
// agrees on a known direct/unique value; conflicts and candidates remain unknown.
func BuildBattleStats(records []BattleRecord, rules []BattleTeamRule) BattleStats {
	out := BattleStats{Enemy: []BattleEnemyStats{}, SelfSkills: []BattleSelfSkillStats{}, Teams: []BattleTeamStats{}, Issues: []string{}}
	issue := func(s string) {
		if len(out.Issues) < 128 && !battleOneOf(s, out.Issues...) {
			out.Issues = append(out.Issues, s)
		}
	}
	unique := map[string]BattleRecord{}
	bad := map[string]bool{}
	order := []string{}
	for _, input := range records {
		r, err := battleClone(input)
		if err == nil {
			err = ValidateBattleRecord(&r)
		}
		if err != nil {
			bad[input.ID] = true
			delete(unique, input.ID)
			issue("Invalid record excluded from statistics.")
			continue
		}
		if bad[r.ID] {
			continue
		}
		if old, ok := unique[r.ID]; ok {
			r, err = MergeBattleRecord(old, r)
			if err != nil {
				bad[old.ID] = true
				delete(unique, old.ID)
				issue("Conflicting duplicate battle excluded from statistics.")
				continue
			}
		} else {
			order = append(order, r.ID)
		}
		unique[r.ID] = r
	}
	matches := []battleStatsMatch{}
	ownSkills := battleSelfSkillAccumulator{}
	enemyIDs := map[int]string{}
	enemySkills := map[int]map[int]bool{}
	for _, id := range order {
		r, ok := unique[id]
		if !ok {
			continue
		}
		m := battleStatMatch(r)
		matches = append(matches, m)
		out.MatchedBattles++
		switch r.Outcome {
		case "win":
			out.Outcomes.Win++
		case "loss":
			out.Outcomes.Loss++
		case "draw":
			out.Outcomes.Draw++
		default:
			out.Outcomes.Unknown++
		}
		if r.Quality.Roster["enemy"] {
			out.Quality.Roster++
		}
		if r.Quality.Actions {
			out.Quality.Actions++
		}
		if r.Quality.Lead["enemy"] {
			out.Quality.Lead++
		}
		for _, s := range r.Issues {
			issue(s)
		}
		for species, pets := range m.species["enemy"] {
			if _, ok := enemyIDs[species]; !ok {
				enemyIDs[species] = pets[0].Name
			}
		}
		// Own skill usage is an observation count, not the enemy's complete-
		// capture occurrence cohort. Do not hide positively recorded own casts.
		ownSkills.add(battleOwnSkillUsage(r))
		if r.Quality.Actions {
			for species, skills := range m.casts["enemy"] {
				if enemySkills[species] == nil {
					enemySkills[species] = map[int]bool{}
				}
				for skill := range skills {
					enemySkills[species][skill] = true
				}
			}
		}
	}
	speciesList := []int{}
	for id := range enemyIDs {
		speciesList = append(speciesList, id)
	}
	sort.Ints(speciesList)
	for _, id := range speciesList {
		e := BattleEnemyStats{MonsterID: id, Name: enemyIDs[id], CarrySamples: out.Quality.Roster, AppearSamples: out.Quality.Actions, LeadSamples: out.Quality.Lead, Skills: []BattleSkillStats{}, IVDistributions: map[string]map[string]int{}, NatureDistributions: map[string]map[string]int{}, IVSamples: map[string]int{}, NatureSamples: map[string]int{}, IVConditionalSamples: map[string]int{}, NatureConditionalSamples: map[string]int{}}
		skillStats := map[int]*BattleSkillStats{}
		for skill := range enemySkills[id] {
			skillStats[skill] = &BattleSkillStats{SkillID: skill}
		}
		for _, m := range matches {
			pets := m.species["enemy"][id]
			carried := len(pets) > 0
			if m.r.Quality.Roster["enemy"] && carried {
				e.Carried++
			}
			if m.r.Quality.Actions && m.appeared["enemy"][id] {
				e.Appeared++
				for skill, s := range skillStats {
					s.Samples++
					casts := m.casts["enemy"][id][skill]
					s.Casts += casts
					if casts > 0 {
						s.UsedBattles++
					}
				}
			}
			if m.r.Quality.Lead["enemy"] {
				for _, p := range pets {
					if p.InstanceID == m.r.Sides["enemy"].Lead {
						e.Leads++
						break
					}
				}
				// Conditional lead rate needs confirmed presence, not a
				// complete roster: the mapped lead itself proves carriage.
				if carried {
					e.CarriedLeadSamples++
				}
			}
			if carried {
				e.ProfileSamples++
				unknown := false
				for _, stat := range battleStatKeys {
					for _, nature := range []bool{false, true} {
						v, known := battleProfileConsensus(pets, stat, nature)
						if !known {
							unknown = true
							continue
						}
						dist, samples := e.IVDistributions, e.IVSamples
						if nature {
							dist, samples = e.NatureDistributions, e.NatureSamples
						}
						if dist[stat] == nil {
							dist[stat] = map[string]int{}
						}
						dist[stat][strconv.FormatFloat(v, 'f', -1, 64)]++
						samples[stat]++
						conditional := false
						for _, pet := range pets {
							evidence := pet.IV[stat]
							if nature {
								evidence = pet.Nature[stat]
							}
							if evidence.Condition != "" {
								conditional = true
								break
							}
						}
						if conditional {
							if nature {
								e.NatureConditionalSamples[stat]++
							} else {
								e.IVConditionalSamples[stat]++
							}
						}
					}
				}
				if unknown {
					e.UnknownProfiles++
				}
			}
		}
		for _, s := range skillStats {
			e.Skills = append(e.Skills, *s)
		}
		sort.Slice(e.Skills, func(i, j int) bool { return e.Skills[i].SkillID < e.Skills[j].SkillID })
		out.Enemy = append(out.Enemy, e)
	}
	out.SelfSkills = ownSkills.stats()
	// One eligible population, all matching rule labels. Counts may overlap;
	// MatchedBattles above remains deduplicated by the original battle ID.
	assignedCounts := map[string]int{}
	eligibleSamples := 0
	if len(rules) > 0 {
		for _, m := range matches {
			if assigned, ok := battleMatchedArchetypes(m.r, rules); ok {
				eligibleSamples++
				for _, teamID := range assigned {
					assignedCounts[teamID]++
				}
			}
		}
	}
	for _, rule := range battleArchetypeRules(rules) {
		t := BattleTeamStats{ID: rule.ID, Name: rule.Name, Samples: eligibleSamples, Battles: assignedCounts[rule.ID]}
		out.Teams = append(out.Teams, t)
	}
	return out
}
func battleProfileConsensus(pets []BattlePet, stat string, nature bool) (float64, bool) {
	var value float64
	for i, p := range pets {
		m := p.IV
		if nature {
			m = p.Nature
		}
		e, ok := m[stat]
		if !ok || e.Value == nil || !battleOneOf(e.Certainty, "direct", "unique") {
			return 0, false
		}
		if i > 0 && value != *e.Value {
			return 0, false
		}
		value = *e.Value
	}
	return value, len(pets) > 0
}
