package main

import (
	"sort"
	"strconv"
	"strings"
)

const battleOtherArchetypeID = "__other__"

// BattleArchetypeStats is a read-only projection of already-filtered records.
// Rates are fractions and nil means no known denominator, never an observed zero.
type BattleArchetypeStats struct {
	MultiLabel      bool                         `json:"multiLabel"`
	AssignmentCount int                          `json:"assignmentCount"`
	Samples         int                          `json:"samples"`
	UnknownBattles  int                          `json:"unknownBattles"`
	Teams           []BattleArchetypeTeam        `json:"teams"`
	Environment     []BattleArchetypeEnvironment `json:"environment"`
	OwnMatchups     []BattleArchetypeOwnMatchup  `json:"ownMatchups"`
}

type BattleArchetypeIdentity struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	MonsterIDs         []int   `json:"monsterIds"`
	ExcludedMonsterIDs []int   `json:"excludedMonsterIds"`
	AnyOf              [][]int `json:"anyOf,omitempty"`
	Other              bool    `json:"other"`
}

type BattleArchetypeSummary struct {
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
	roundSum               int64
	durationSum            float64
}

type BattleArchetypeTeam struct {
	BattleArchetypeIdentity
	BattleArchetypeSummary
	Teammates  []BattleArchetypeCarry     `json:"teammates"`
	Components []BattleArchetypeComponent `json:"components"`
}

type BattleArchetypeCarry struct {
	MonsterID int      `json:"monsterId"`
	Carried   int      `json:"carried"`
	Samples   int      `json:"samples"`
	Rate      *float64 `json:"rate"`
}

type BattleArchetypeSkill struct {
	SkillID int      `json:"skillId"`
	Carried int      `json:"carried"`
	Samples int      `json:"samples"`
	Rate    *float64 `json:"rate"`
}

type BattleArchetypeLifeProfile struct {
	IV      float64  `json:"iv"`
	Nature  float64  `json:"nature"`
	Battles int      `json:"battles"`
	Rate    *float64 `json:"rate"`
}

type BattleArchetypeComponent struct {
	BattleArchetypeCarry
	SkillUsage      []BattleSelfSkillStats `json:"skillUsage"`
	UsageTotalCasts int                    `json:"usageTotalCasts"`
	// Deprecated compatibility fields are no longer computed. Executed usage
	// is never evidence of initial carrying or a joint life configuration.
	Skills       []BattleArchetypeSkill `json:"skills,omitempty"`
	SkillSamples int                    `json:"skillSamples,omitempty"`
	SkillUnknown int                    `json:"skillUnknown,omitempty"`
	// Profile retains IV/nature evidence for this assigned cohort only.
	Profile              BattleEnemyStats             `json:"profile"`
	NatureSamples        int                          `json:"natureSamples"`
	NatureUnknown        int                          `json:"natureUnknown"`
	NatureConfigurations []BattleNatureConfiguration  `json:"natureConfigurations"`
	IndividualChoices    []BattleIndividualChoice     `json:"individualChoices"`
	LifeProfiles         []BattleArchetypeLifeProfile `json:"lifeProfiles,omitempty"`
	LifeProfileSamples   int                          `json:"lifeProfileSamples,omitempty"`
	LifeProfileUnknown   int                          `json:"lifeProfileUnknown,omitempty"`
}

// Mutually exclusive configuration combinations, not six marginal pie slices.
// Incomplete buckets contain only confirmed values and explicitly name unknown
// attributes. NatureUnknown is coverage metadata, never an extra pie slice.
type BattleNatureConfiguration struct {
	Key               string             `json:"key"`
	Label             string             `json:"label"`
	Selected          []string           `json:"selected"`
	UnknownAttributes []string           `json:"unknownAttributes"`
	Values            map[string]float64 `json:"values"`
	Complete          bool               `json:"complete"`
	Battles           int                `json:"battles"`
	Rate              *float64           `json:"rate"`
}

type BattleIndividualChoice struct {
	Attribute  string   `json:"attribute"`
	Selected   int      `json:"selected"`
	Unselected int      `json:"unselected"`
	Unknown    int      `json:"unknown"`
	Samples    int      `json:"samples"`
	Rate       *float64 `json:"rate"`
}

type BattleArchetypeEnvironment struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Other   bool     `json:"other"`
	Battles int      `json:"battles"`
	Samples int      `json:"samples"`
	Rate    *float64 `json:"rate"`
}

type BattleArchetypeMatchupTeam struct {
	BattleArchetypeIdentity
	BattleArchetypeSummary
}

type BattleArchetypeOwnMatchup struct {
	Key        string                       `json:"key"`
	MonsterIDs []int                        `json:"monsterIds"`
	Battles    int                          `json:"battles"`
	Teams      []BattleArchetypeMatchupTeam `json:"teams"`
}

// Deprecated compatibility convenience: first displayed match only. Current
// count/filter consumers use the full battleMatchedArchetypes membership set.
func battleAssignedArchetype(r BattleRecord, rules []BattleTeamRule) (string, bool) {
	return battleAssignArchetype(r, battleArchetypeRules(rules))
}

// Storage validates full rule DTOs on writes. Classification validates only rule
// identity/membership: an optional display name must never change a match. Clone
// member slices so neither normalization nor output aliases mutate input rules.
func battleArchetypeRules(rules []BattleTeamRule) []BattleTeamRule {
	out := []BattleTeamRule{}
	seen := map[string]bool{}
	for _, rule := range rules {
		if !battleID(rule.ID, true) || rule.ID == battleOtherArchetypeID || seen[rule.ID] || len(rule.MonsterIDs) == 0 && len(rule.AnyOf) == 0 || len(rule.MonsterIDs) > 24 || len(rule.ExcludedMonsterIDs) > 24 || len(rule.AnyOf) > 24 {
			continue
		}
		core, excluded := map[int]bool{}, map[int]bool{}
		clean := BattleTeamRule{ID: rule.ID, Name: strings.TrimSpace(rule.Name), MonsterIDs: []int{}, ExcludedMonsterIDs: []int{}}
		valid := true
		for _, id := range rule.MonsterIDs {
			if id <= 0 || id > 1000000000 {
				valid = false
			}
			if !core[id] {
				core[id] = true
				clean.MonsterIDs = append(clean.MonsterIDs, id)
			}
		}
		for _, id := range rule.ExcludedMonsterIDs {
			if id <= 0 || id > 1000000000 || core[id] {
				valid = false
			}
			if !excluded[id] {
				excluded[id] = true
				clean.ExcludedMonsterIDs = append(clean.ExcludedMonsterIDs, id)
			}
		}
		clean.AnyOf = battleCloneRuleGroups(rule.AnyOf)
		clean.familyMatch = rule.familyMatch
		for _, group := range clean.AnyOf {
			if len(group) == 0 || len(group) > 24 {
				valid = false
			}
			for _, id := range group {
				if id <= 0 || id > 1000000000 {
					valid = false
				}
			}
		}
		if valid {
			seen[rule.ID] = true
			out = append(out, clean)
		}
	}
	return out
}

func battleArchetypeRoster(r BattleRecord, side string) ([]int, bool) {
	pets := r.Sides[side].Pets
	if !r.Quality.Roster[side] || len(pets) == 0 {
		return nil, false
	}
	ids := make([]int, 0, len(pets))
	for _, p := range pets {
		if p.MonsterID <= 0 || p.MonsterID > 1000000000 {
			return nil, false
		}
		ids = append(ids, p.MonsterID)
	}
	sort.Ints(ids)
	return ids, true
}

func battleAssignArchetype(r BattleRecord, rules []BattleTeamRule) (string, bool) {
	matches, eligible := battleMatchArchetypes(r, rules)
	if !eligible {
		return "", false
	}
	return matches[0], true
}

func battleMatchedArchetypes(r BattleRecord, rules []BattleTeamRule) ([]string, bool) {
	return battleMatchArchetypes(r, battleArchetypeRules(rules))
}

// Rule order controls display only. Every eligible initial roster is in all
// matching teams, or other if there are zero matches. Unknown is never other.
func battleMatchArchetypes(r BattleRecord, rules []BattleTeamRule) ([]string, bool) {
	ids, complete := battleArchetypeRoster(r, "enemy")
	if !complete {
		return nil, false
	}
	have := map[int]bool{}
	for _, id := range ids {
		have[id] = true
	}
	matches := []string{}
	for _, rule := range rules {
		if battleRuleMatches(rule, have) {
			matches = append(matches, rule.ID)
		}
	}
	if len(matches) == 0 {
		matches = append(matches, battleOtherArchetypeID)
	}
	return matches, true
}

func battleArchetypeIdentity(rule BattleTeamRule) BattleArchetypeIdentity {
	return BattleArchetypeIdentity{ID: rule.ID, Name: rule.Name,
		MonsterIDs: append([]int{}, rule.MonsterIDs...), ExcludedMonsterIDs: append([]int{}, rule.ExcludedMonsterIDs...),
		AnyOf: battleCloneRuleGroups(rule.AnyOf), Other: rule.ID == battleOtherArchetypeID}
}

func (s *BattleArchetypeSummary) add(r BattleRecord) {
	s.Battles++
	switch r.Outcome {
	case "win":
		s.Wins++
	case "loss":
		s.Losses++
	case "draw":
		s.Draws++
	default:
		s.Unknown++
	}
	if r.Rounds > 0 {
		s.RoundSamples++
		s.roundSum += int64(r.Rounds)
	}
	if seconds, known := battlePerformanceDuration(r); known {
		s.DurationSamples++
		s.durationSum += seconds
	}
}

func (s *BattleArchetypeSummary) finish() {
	s.KnownOutcomes = s.Wins + s.Losses + s.Draws
	s.WinRate = battlePerformanceRatio(s.Wins, s.KnownOutcomes)
	if s.RoundSamples > 0 {
		v := float64(s.roundSum) / float64(s.RoundSamples)
		s.AverageRounds = &v
	}
	if s.DurationSamples > 0 {
		v := s.durationSum / float64(s.DurationSamples)
		s.AverageDurationSeconds = &v
	}
}

// BuildBattleArchetypeStats performs no I/O, catalog/global reads or input mutation.
// A duplicate ID is counted once after canonical merging. Invalid or conflicting
// IDs exclude the entire battle, even when another fragment would be eligible.
func BuildBattleArchetypeStats(records []BattleRecord, rules []BattleTeamRule, optionalCatalog ...[]byte) *BattleArchetypeStats {
	out := &BattleArchetypeStats{MultiLabel: true, Teams: []BattleArchetypeTeam{}, Environment: []BattleArchetypeEnvironment{}, OwnMatchups: []BattleArchetypeOwnMatchup{}}
	cleanRules := battleArchetypeRules(rules)
	if len(optionalCatalog) > 0 {
		prepared, err := battlePrepareRuleFamilies(cleanRules, optionalCatalog[0])
		if err != nil {
			out.UnknownBattles = len(records)
			return out
		}
		cleanRules = prepared
	}
	allRules := append(append([]BattleTeamRule{}, cleanRules...), BattleTeamRule{ID: battleOtherArchetypeID, Name: "其他"})
	unique, bad := map[string]BattleRecord{}, map[string]bool{}
	for _, input := range records {
		r, err := battleClone(input)
		if err == nil {
			err = ValidateBattleRecord(&r)
		}
		if err != nil {
			bad[input.ID] = true
			delete(unique, input.ID)
			continue
		}
		if bad[r.ID] {
			continue
		}
		if old, exists := unique[r.ID]; exists {
			r, err = MergeBattleRecord(old, r)
			if err != nil {
				bad[input.ID] = true
				delete(unique, input.ID)
				continue
			}
		}
		unique[r.ID] = r
	}
	out.UnknownBattles = len(bad)
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	cohorts := map[string][]BattleRecord{}
	own := map[string]*BattleArchetypeOwnMatchup{}
	ownTeams := map[string]map[string]*BattleArchetypeSummary{}
	for _, id := range ids {
		r := unique[id]
		assigned, eligible := battleMatchArchetypes(r, cleanRules)
		if !eligible {
			out.UnknownBattles++
			continue
		}
		out.Samples++
		out.AssignmentCount += len(assigned)
		for _, teamID := range assigned {
			cohorts[teamID] = append(cohorts[teamID], r)
		}
		lineup, complete := battleArchetypeRoster(r, "me")
		if !complete {
			continue
		}
		parts := make([]string, len(lineup))
		for i, species := range lineup {
			parts[i] = strconv.Itoa(species)
		}
		key := strings.Join(parts, ",")
		if own[key] == nil {
			own[key] = &BattleArchetypeOwnMatchup{Key: key, MonsterIDs: lineup, Teams: []BattleArchetypeMatchupTeam{}}
			ownTeams[key] = map[string]*BattleArchetypeSummary{}
		}
		own[key].Battles++
		for _, teamID := range assigned {
			if ownTeams[key][teamID] == nil {
				ownTeams[key][teamID] = &BattleArchetypeSummary{}
			}
			ownTeams[key][teamID].add(r)
		}
	}
	for _, rule := range allRules {
		cohort := cohorts[rule.ID]
		team := BattleArchetypeTeam{BattleArchetypeIdentity: battleArchetypeIdentity(rule), Teammates: []BattleArchetypeCarry{}, Components: []BattleArchetypeComponent{}}
		for _, r := range cohort {
			team.add(r)
		}
		team.finish()
		team.Components = battleArchetypeComponents(cohort)
		core := battleRuleCore(rule)
		for _, component := range team.Components {
			if !core[component.MonsterID] {
				team.Teammates = append(team.Teammates, component.BattleArchetypeCarry)
			}
		}
		sort.Slice(team.Teammates, func(i, j int) bool {
			a, b := team.Teammates[i], team.Teammates[j]
			if a.Carried != b.Carried {
				return a.Carried > b.Carried
			}
			return a.MonsterID < b.MonsterID
		})
		out.Teams = append(out.Teams, team)
		out.Environment = append(out.Environment, BattleArchetypeEnvironment{ID: rule.ID, Name: rule.Name, Other: team.Other, Battles: len(cohort), Samples: out.Samples, Rate: battlePerformanceRatio(len(cohort), out.Samples)})
	}
	for key, group := range own {
		for _, rule := range allRules {
			if summary := ownTeams[key][rule.ID]; summary != nil {
				summary.finish()
				group.Teams = append(group.Teams, BattleArchetypeMatchupTeam{BattleArchetypeIdentity: battleArchetypeIdentity(rule), BattleArchetypeSummary: *summary})
			}
		}
		out.OwnMatchups = append(out.OwnMatchups, *group)
	}
	sort.Slice(out.OwnMatchups, func(i, j int) bool {
		a, b := out.OwnMatchups[i].MonsterIDs, out.OwnMatchups[j].MonsterIDs
		for k := 0; k < len(a) && k < len(b); k++ {
			if a[k] != b[k] {
				return a[k] < b[k]
			}
		}
		return len(a) < len(b)
	})
	return out
}

func battleArchetypeComponents(records []BattleRecord) []BattleArchetypeComponent {
	out := []BattleArchetypeComponent{}
	if len(records) == 0 {
		return out
	}
	usage := battleSelfSkillAccumulator{}
	for _, r := range records {
		usage.add(battleSideSkillUsage(r, "enemy"))
	}
	bySpecies := map[int][]BattleSelfSkillStats{}
	for _, skill := range usage.stats() {
		bySpecies[skill.MonsterID] = append(bySpecies[skill.MonsterID], skill)
	}
	charts := battleArchetypeConfigurationCharts(records)
	// Deliberately use only this team's cohort. Existing profile evidence stays
	// compatible; chart combinations do not infer initial skills or missing stats.
	for _, profile := range BuildBattleStats(records, nil).Enemy {
		row := BattleArchetypeComponent{
			BattleArchetypeCarry: BattleArchetypeCarry{MonsterID: profile.MonsterID, Carried: profile.Carried, Samples: len(records), Rate: battlePerformanceRatio(profile.Carried, len(records))},
			SkillUsage:           append([]BattleSelfSkillStats{}, bySpecies[profile.MonsterID]...), Profile: profile,
		}
		chart := charts[profile.MonsterID]
		row.NatureSamples, row.NatureUnknown = chart.samples, chart.unknown
		row.NatureConfigurations, row.IndividualChoices = chart.configurations, chart.choices
		if totals := usage[profile.MonsterID]; totals != nil {
			row.UsageTotalCasts = totals.totalCasts
		}
		out = append(out, row)
	}
	return out
}

var battleChartAttributes = []struct{ stat, attribute, label string }{
	{"hp", "hp", "生命"}, {"attack", "attack", "物攻"}, {"magic_attack", "magicAttack", "魔攻"},
	{"defense", "defense", "物防"}, {"magic_defense", "magicDefense", "魔防"}, {"speed", "speed", "速度"},
}

type battleMemberConfigurationCharts struct {
	samples, unknown int
	configurations   []BattleNatureConfiguration
	choices          []BattleIndividualChoice
	buckets          map[string]*BattleNatureConfiguration
}

// Same-species instances contribute at most one slot per battle, exactly as the
// compatibility profile guard: a stat is confirmed only if all instances agree.
// Missing, conflicting and failed-inference attributes never turn into zeros.
func battleArchetypeConfigurationCharts(records []BattleRecord) map[int]battleMemberConfigurationCharts {
	acc := map[int]*battleMemberConfigurationCharts{}
	for _, record := range records {
		bySpecies := map[int][]BattlePet{}
		for _, pet := range record.Sides["enemy"].Pets {
			if pet.MonsterID > 0 {
				bySpecies[pet.MonsterID] = append(bySpecies[pet.MonsterID], pet)
			}
		}
		for species, pets := range bySpecies {
			chart := acc[species]
			if chart == nil {
				chart = &battleMemberConfigurationCharts{configurations: []BattleNatureConfiguration{}, choices: []BattleIndividualChoice{}, buckets: map[string]*BattleNatureConfiguration{}}
				for _, attr := range battleChartAttributes {
					chart.choices = append(chart.choices, BattleIndividualChoice{Attribute: attr.attribute})
				}
				acc[species] = chart
			}
			chart.samples++
			bucket := BattleNatureConfiguration{Selected: []string{}, UnknownAttributes: []string{}, Values: map[string]float64{}, Complete: true}
			parts, labels, neutrals := []string{}, []string{}, []string{}
			for i, attr := range battleChartAttributes {
				choice := &chart.choices[i]
				iv, known := battleProfileConsensus(pets, attr.stat, false)
				if !known {
					choice.Unknown++
				} else if iv > 0 {
					choice.Selected++
				} else {
					choice.Unselected++
				}
				nature, known := battleProfileConsensus(pets, attr.stat, true)
				if !known {
					bucket.Complete = false
					bucket.UnknownAttributes = append(bucket.UnknownAttributes, attr.attribute)
					parts = append(parts, attr.attribute+":?")
					continue
				}
				bucket.Values[attr.attribute] = nature
				parts = append(parts, attr.attribute+":"+strconv.FormatFloat(nature, 'f', -1, 64))
				if nature == 1 {
					bucket.Selected = append(bucket.Selected, attr.attribute)
					labels = append(labels, attr.label)
				}
				if nature == 2 {
					labels = append(labels, attr.label+"负性格")
				}
				if nature == 0 {
					neutrals = append(neutrals, attr.label+"中性")
				}
			}
			bucket.Key = strings.Join(parts, ",")
			if len(bucket.Values) == 0 {
				bucket.Key, bucket.Label = "unknown", "未知"
			} else if !bucket.Complete {
				// State every confirmed attribute, including known neutral values,
				// so "the remaining attributes" means exactly UnknownAttributes.
				labels = append(labels, neutrals...)
				bucket.Label = strings.Join(labels, "＋") + "（其余属性性格未确认）"
			} else if len(labels) == 0 {
				bucket.Label = "无正性格（全中性）"
			} else {
				bucket.Label = strings.Join(labels, "＋")
			}
			if !bucket.Complete {
				chart.unknown++
			}
			if old := chart.buckets[bucket.Key]; old != nil {
				old.Battles++
			} else {
				bucket.Battles = 1
				chart.buckets[bucket.Key] = &bucket
			}
		}
	}
	out := map[int]battleMemberConfigurationCharts{}
	for species, chart := range acc {
		for _, bucket := range chart.buckets {
			bucket.Rate = battlePerformanceRatio(bucket.Battles, chart.samples)
			chart.configurations = append(chart.configurations, *bucket)
		}
		sort.Slice(chart.configurations, func(i, j int) bool {
			a, b := chart.configurations[i], chart.configurations[j]
			if a.Battles != b.Battles {
				return a.Battles > b.Battles
			}
			return a.Key < b.Key
		})
		for i := range chart.choices {
			choice := &chart.choices[i]
			choice.Samples = choice.Selected + choice.Unselected
			choice.Rate = battlePerformanceRatio(choice.Selected, choice.Samples)
		}
		out[species] = *chart
	}
	return out
}
