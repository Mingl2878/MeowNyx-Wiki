package main

import (
	"regexp"
	"strings"
	canonicalcatalog "xhmwiki/internal/catalog"
)

// Only the caller's immutable current catalog bytes are consulted. No source IDs,
// names, type matchups, default levels or personal configuration become facts.
type battlePerformanceCatalog struct {
	available bool
	reference string
	hp        map[int]int
	skills    map[int]battlePerformanceSkill
}

// Only immutable scalar configuration is needed; do not retain a Skill's mutable
// Power, SourceRef or Extensions aliases in this private performance index.
type battlePerformanceSkill struct {
	Name, Category, Description string
	EnergyCost                  float64
}

func battlePerformanceReadCatalog(data []byte) battlePerformanceCatalog {
	value, err := battleSharedCatalogDomain(data, "performance-config-v1", battlePerformanceBuildCatalog)
	if err != nil {
		return battlePerformanceCatalog{hp: map[int]int{}, skills: map[int]battlePerformanceSkill{}}
	}
	// Maps remain private and are used only by the read-only lookup methods below.
	return value.(battlePerformanceCatalog)
}

func battlePerformanceBuildCatalog(c *canonicalcatalog.Catalog, revision string) (any, error) {
	out := battlePerformanceCatalog{available: true, reference: "sha256:" + revision, hp: map[int]int{}, skills: map[int]battlePerformanceSkill{}}
	for _, m := range c.Monsters {
		if m.Stats.HP > 0 {
			out.hp[m.ID] = m.Stats.HP
		}
	}
	for _, s := range c.Skills {
		out.skills[s.ID] = battlePerformanceSkill{Name: s.Name, Category: s.Category, Description: s.Description, EnergyCost: s.EnergyCost}
	}
	return out, nil
}

// These are reviewed local stable identities, never Tencent IDs or labels.
const battlePerformanceRollerCoasterSpecies = 501
const battlePerformanceRollerCoasterSkill = 492

// category separates status and defense without treating every non-attack as
// either. Explicit attack evidence remains authoritative; charge is the single
// reviewed system action counted as status. Passive/resource events never count.
func (c battlePerformanceCatalog) category(e BattleEvent, attack, attackKnown bool) string {
	if battleIsStunSkip(e) || !battleOneOf(e.Phase, "executed", "interrupted") {
		return ""
	}
	if e.Kind == "effect" && e.SkillClass == "system" && e.ProtocolSkillID == "700001000" {
		return "status"
	}
	if attackKnown && attack && battleCombatSourceAction(e) && e.SkillClass != "passive" {
		return "attack"
	}
	if e.Kind != "skill" || !attackKnown {
		return ""
	}
	s, ok := c.skills[e.SkillID]
	if !ok {
		return ""
	}
	switch s.Category {
	case "Status":
		return "status"
	case "Defense":
		return "defense"
	}
	return ""
}

func (c battlePerformanceCatalog) attack(e BattleEvent) (value, known, fromCatalog bool) {
	if battleIsStunSkip(e) {
		return false, true, false
	}
	if e.Combat != nil && e.Combat.IsAttack != nil {
		return *e.Combat.IsAttack, true, false
	}
	// Charge and passive notifications are not ordinary attacks; descriptive
	// wording or reported damage cannot turn one into a cast.
	if e.Kind != "skill" || e.SkillClass == "passive" || e.SkillClass == "system" {
		return false, true, false
	}
	s, ok := c.skills[e.SkillID]
	if !ok {
		return false, false, false
	}
	switch s.Category {
	case "Physical Attack", "Magic Attack":
		return true, true, true
	case "Status", "Defense":
		return false, true, true
	}
	return false, false, false
}

var battlePerformanceResponseRule = regexp.MustCompile(`(?:^|[。；;\n>])\s*(?:【应对】|\[应对\]|应对(?:[：:（(]|成功|时|后))`)

func (c battlePerformanceCatalog) response(e BattleEvent) (value, known, fromCatalog bool) {
	if battleIsStunSkip(e) {
		return false, true, false
	}
	if e.Combat != nil && e.Combat.ResponseAttempt != nil {
		return *e.Combat.ResponseAttempt, true, false
	}
	if e.Kind != "skill" {
		return false, true, false
	}
	if e.SkillClass == "response" || e.Combat != nil && e.Combat.CounteredActionID != "" {
		return true, true, false
	}
	s, ok := c.skills[e.SkillID]
	// All current Defense skills explicitly respond to attacks. Capability is
	// not success: the latter still needs an executed linked defense response.
	if ok && s.Category == "Defense" {
		return true, true, true
	}
	if !ok || strings.TrimSpace(s.Description) == "" {
		return false, false, false
	}
	if battlePerformanceResponseRule.MatchString(s.Description) {
		return true, true, true
	}
	// An incidental reference (e.g. preventing the foe's response) is not proof
	// of capability or its absence. Keep those descriptions unclassified.
	if strings.Contains(s.Description, "应对") {
		return false, false, false
	}
	return false, true, true
}
func (c battlePerformanceCatalog) estimatedHP(monsterID int, level *int) (int64, bool) {
	q, ok := c.hp[monsterID]
	if !ok || level == nil || *level < 1 || *level > 100 {
		return 0, false
	}
	// Positive-integer half-up rounding, E60 and neutral HP nature, exactly:
	// round(((2L+50)*(Q+30))/100)+L+110. No HP or profile is written.
	l := int64(*level)
	return ((2*l+50)*(int64(q)+30)+50)/100 + l + 110, true
}
