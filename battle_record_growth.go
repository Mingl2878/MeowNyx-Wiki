package main

import (
	"errors"
	"math"
	"sort"
	"strconv"
	canonicalcatalog "xhmwiki/internal/catalog"
)

// Growth is a read-only, evidence-qualified projection. Unknown battles never
// enter either total or samples. A confirmed zero DOES enter samples.
type BattleGrowthStats struct {
	Me    []BattleSpeciesGrowth `json:"me"`
	Enemy []BattleSpeciesGrowth `json:"enemy"`
}
type BattleSpeciesGrowth struct {
	MonsterID int                 `json:"monsterId"`
	Trait     *BattleTraitGrowth  `json:"trait"`
	Skills    []BattleSkillGrowth `json:"skills"`
}
type BattleTraitGrowth struct {
	TraitID string   `json:"traitId"`
	Name    string   `json:"name"`
	Total   float64  `json:"total"`
	Samples int      `json:"samples"`
	Unknown int      `json:"unknown"`
	Average *float64 `json:"average"`
	// Historical entry counts may be qualified observed-prefix lower bounds;
	// they are not declarations of complete whole-battle effect coverage.
	ObservedPrefixSamples int `json:"observedPrefixSamples,omitempty"`
}
type BattleSkillGrowth struct {
	SkillID int      `json:"skillId"`
	Name    string   `json:"name"`
	Branch  string   `json:"branch,omitempty"`
	Unit    string   `json:"unit"`
	Total   float64  `json:"total"`
	Samples int      `json:"samples"`
	Unknown int      `json:"unknown"`
	Average *float64 `json:"average"`
}

// BattleGrowthEvidence is an input declaration, not an inferred result. Complete
// means THIS effect's whole-battle coverage, not merely complete actions. A total
// is the final cumulative newly enacted growth this battle (not retained buffs,
// profile simulation counters, initial power, or a protocol grow_times value).
// Stacks is an explicit layer count; Amount is the actual native effect increment
// converted through the selected skill's unit. Traits require Stacks (triggers).
// OccurrenceID coalesces notifications for one trigger's multiple attributes.
type BattleGrowthEvidence struct {
	TraitID      string `json:"traitId,omitempty"`
	Branch       string `json:"branch,omitempty"`
	OccurrenceID string `json:"occurrenceId,omitempty"`
	Mode         string `json:"mode"`
	Complete     bool   `json:"complete"`
}

// This registry is an explicit user selection of STABLE LOCAL identities, not a
// keyword scan. Owners come from canonical trait_id, including all native forms.
type battleGrowthTraitRule struct{ id, name, description, derive string }

var battleGrowthTraitRules = []battleGrowthTraitRule{
	{"trait-4ce2d8a1ba544b5988de673421381236", "爆燃", "使用火系技能后，获得双攻永久+30%。", "fire"},
	{"trait-5f30b4d15f6e0734998d5982fe99af30", "三鼓作气", "使用能耗为3的技能后，获得双攻和双防永久+20%。", "cost3"},
	{"trait-9ef3df35c33a62120339671bade2c934", "蓄电池", "每入场1次，永久获得双攻+30%。", "entry"},
	{"trait-46d489bf168900998f2b111b706b906b", "洄游", "每次进入 蓄力 状态，获得全技能能耗永久-2。", ""},
	{"trait-f2078a657798e94b6e8aeba9eac29e5f", "合拍", "本回合与敌方使用的技能在系别/类型/能耗上每有1项相同，回合结束时获得物攻和物防永久+10%。", ""},
	{"trait-89a451b13730893fa3e7b589b5ae7904", "光度换算", "携带的火系技能获得 选择 ：使用后失去15%生命，光系技能威力永久+30。", ""},
	{"trait-58e88fa60b0289b9263e8af3651bc2ce", "水翼推进", "己方精灵每使用1次水系技能，自己入场时获得全技能能耗-1。", "historyWater"},
	{"trait-564a216af26fd00a269a371c7f622cb7", "水翼飞升", "己方精灵每使用1次水系技能，自己入场时获得全技能能耗-1，且能耗为0的技能威力+30%。", "historyWater"},
	{"trait-6b978661da9d650de7a7dac2fe4b18aa", "身经百练", "己方精灵每应对1次，自己入场时水系和武系技能威力+20%。", "historyResponse"},
	{"trait-5f2ff7cdd642cdb0950c1d9b5e1b7e40", "渗透", "己方精灵每使用1次武系或地系技能，自己入场时获得攻防+5%。", "historyFightingGround"},
	{"trait-119e36dd263e93e5905c17d955f5d327", "拨浪鼓", "己方精灵每使用1次状态技能，自己入场时毒系和萌系技能威力+10。", "historyStatus"},
	{"trait-70f7af8fffa315e7138dead633d27461", "蒸汽膨胀", "己方精灵每使用1次火系技能，自己入场时获得全技能威力+10。", "historyFire"},
	{"trait-970197bade05ff4ec66567a33a31bbe0", "定向精炼", "己方精灵每使用1次防御技能，自己入场时机械系和地系技能威力+10%。", "historyDefense"},
	{"trait-e25ae47945095818382dc9f9809b5882", "搜刮", "敌方每使用1次「聚能」技能或更换精灵，自己入场时获得魔攻+20%。", "historyEnemyChargeSwitch"},
	{"trait-1d22de1794cbc151f7e505e1f7c1acd1", "扫荡", "敌方每使用1次「聚能」技能或更换精灵，自己入场时获得魔攻+20%和魔防+10%。", "historyEnemyChargeSwitch"},
	{"trait-38e548d59a4015f8d7bc19fc7aed574d", "淬炼火", "入场前己方精灵每使用1次火系技能，获得攻防+10%，速度+10。（最多触发10次）", "historyFireCap10"},
	{"trait-40d2524b7b9510efda8103ef4084cddc", "猫精灵的礼物", "己方精灵每完整使用1次「 选择 」技能（「明」和「暗」各1次），自己入场时获得物攻+40%。", ""},
	{"trait-447f953e530b953692a3185912ca1db4", "旧玩具", "己方精灵每使用过1个不同系别的技能，自己入场时获得双攻+10%。", "historyDistinctType"},
	{"trait-6697629d910983b329437713b38e2c29", "蒸汽革命", "己方精灵每使用1次火系技能，自己入场时获得全技能威力+10和物防+5%", "historyFire"},
	{"trait-2d62e65c758af0457fe3fcdc3054ae81", "圣龙的守护", "己方精灵每使用1次能耗为3的技能，自己入场前等级+2。在战斗中每提升1级，获得物攻+5%，低于80级时受到伤害+30%。", "historyCost3"},
	{"trait-c9050cafd31bb60d4885f7b19e2133cb", "花精灵", "回合结束时，己方队伍获得1次随机 奉献 。", ""},
	{"trait-b1a42772aab02046a9affde6c827c885", "坚韧铠甲", "每受到1次攻击伤害，己方队伍获得1次随机 奉献 。", ""},
}

type battleGrowthSkillRule struct {
	id                        int
	name, description, derive string
	increment                 float64
}

var battleGrowthSkillRules = []battleGrowthSkillRule{
	{88, "光能聚集", "造成魔伤，每次使用其他草系技能后，本技能威力永久+60。", "otherGrass", 60},
	{113, "吹火", "造成物伤，每次使用后，本技能威力永久+20。", "use", 20},
	{126, "流星火雨", "", "", 85},
	{131, "山火", "造成物伤，每使用1次其他火系技能，本技能威力永久翻倍。", "otherFire", 1},
	{154, "水波术", "", "", 20},
	{173, "过曝", "", "", 30},
	{252, "绵里藏针", "", "noUse", 20},
	{272, "落雷", "", "", 40},
	{429, "齿轮扭矩", "", "", 15},
	{510, "友谊满溢", "", "noUse", 20},
	{537, "远行", "", "", 25},
	{79, "孢子爆散", "造成物伤，2连击，每次使用后，本技能连击数永久+2。", "use", 2},
	{404, "趁火打劫", "", "noUse", 2},
	{538, "试飞", "", "noUse", 0},
	{265, "感电", "", "", 1},
	{163, "水刃", "", "noUse", 3},
}

func battleGrowthTraitRuleFor(id string) (battleGrowthTraitRule, bool) {
	for _, r := range battleGrowthTraitRules {
		if r.id == id {
			return r, true
		}
	}
	return battleGrowthTraitRule{}, false
}
func battleGrowthSkillRuleFor(id int) (battleGrowthSkillRule, bool) {
	for _, r := range battleGrowthSkillRules {
		if r.id == id {
			return r, true
		}
	}
	return battleGrowthSkillRule{}, false
}
func battleGrowthClone(g *BattleGrowthEvidence) *BattleGrowthEvidence {
	if g == nil {
		return nil
	}
	x := *g
	return &x
}
func battleGrowthEvidenceValid(e BattleEvent) error {
	g := e.Growth
	if g == nil {
		return nil
	}
	if !battleOneOf(e.Kind, "growth", "effect") || e.Phase != "executed" || !battleOneOf(e.Side, "me", "enemy") || e.Actor == "" || e.Target != "" || e.TargetSide != "" || e.Form != nil || e.Combat != nil {
		return errors.New("growth evidence requires an executed owner-only growth/effect event")
	}
	if !battleOneOf(g.Mode, "delta", "total") || !battleID(g.OccurrenceID, false) {
		return errors.New("invalid growth mode or occurrence identity")
	}
	if (g.TraitID != "") == (e.SkillID != 0) {
		return errors.New("growth requires exactly one trait or skill identity")
	}
	if g.TraitID != "" {
		r, ok := battleGrowthTraitRuleFor(g.TraitID)
		if !ok || g.Branch != "" || e.Stacks == nil || e.Amount != nil || e.Trigger != "" && e.Trigger != r.id && e.Trigger != r.name {
			return errors.New("invalid selected trait growth evidence")
		}
	} else {
		r, ok := battleGrowthSkillRuleFor(e.SkillID)
		if !ok || e.Trigger != "" && e.Trigger != r.name && e.Trigger != strconv.Itoa(r.id) {
			return errors.New("invalid selected skill growth identity")
		}
		if e.SkillID == 538 {
			if !battleOneOf(g.Branch, "power", "hits") {
				return errors.New("trial flight growth requires its actual branch")
			}
		} else if g.Branch != "" && !(e.SkillID == 510 && g.Branch == "power") {
			return errors.New("invalid skill growth branch")
		}
	}
	if e.Stacks == nil && e.Amount == nil {
		return errors.New("growth requires an explicit observed quantity, including zero")
	}
	if e.SkillID == 131 && e.Amount != nil {
		return errors.New("doubling growth requires an explicit enactment count, not an ambiguous multiplier")
	}
	if e.Stacks != nil && (*e.Stacks < 0 || *e.Stacks > 1000000) || e.Amount != nil && (!battleFinite(*e.Amount, 0, 1e12) || math.Trunc(*e.Amount) != *e.Amount) {
		return errors.New("invalid growth quantity")
	}
	if e.Stacks != nil && e.Amount != nil {
		quantum, _ := battleGrowthUnit(battleGrowthKey{trait: g.TraitID, skill: e.SkillID, branch: g.Branch})
		if float64(*e.Stacks)*quantum != *e.Amount {
			return errors.New("conflicting growth quantities")
		}
	}
	return nil
}
func battleGrowthRecordsValid(r *BattleRecord) error {
	pets := map[battleGrowthActor]bool{}
	for side, s := range r.Sides {
		for _, p := range s.Pets {
			pets[battleGrowthActor{side, p.InstanceID}] = true
		}
	}
	type occurrenceKey struct {
		owner      battleGrowthActor
		trait      string
		skill      int
		occurrence string
	}
	type occurrenceValue struct {
		branch, mode string
		count        float64
	}
	occurrences := map[occurrenceKey]occurrenceValue{}
	for _, e := range r.Events {
		if err := battleGrowthEvidenceValid(e); err != nil {
			return err
		}
		if e.Growth == nil {
			continue
		}
		owner := battleGrowthActor{e.Side, e.Actor}
		if !pets[owner] {
			return errors.New("growth owner is outside the roster")
		}
		g := e.Growth
		if g.OccurrenceID != "" {
			quantity := 0.0
			if e.Stacks != nil {
				quantity = float64(*e.Stacks)
			} else {
				quantum, _ := battleGrowthUnit(battleGrowthKey{g.TraitID, e.SkillID, g.Branch})
				quantity = *e.Amount / quantum
			}
			branch := g.Branch
			if e.SkillID == 510 {
				branch = ""
			}
			key := occurrenceKey{owner, g.TraitID, e.SkillID, g.OccurrenceID}
			value := occurrenceValue{branch, g.Mode, quantity}
			if old, ok := occurrences[key]; ok && old != value {
				return errors.New("conflicting growth occurrence or choice branch")
			}
			occurrences[key] = value
		}
	}
	return nil
}
func battleMergeGrowthFields(a, b *BattleEvent) error {
	if a == nil || b == nil {
		return errors.New("missing growth event to merge")
	}
	if a.Growth == nil && b.Growth == nil {
		return nil
	}
	x := battleGrowthClone(a.Growth)
	if x == nil {
		x = &BattleGrowthEvidence{}
	}
	if b.Growth != nil {
		if err := battleMergeKnown(x, *b.Growth); err != nil {
			return err
		}
	}
	a.Growth, b.Growth = battleGrowthClone(x), battleGrowthClone(x)
	return nil
}

type battleGrowthSkillConfig struct {
	Name, Description, Category string
	TypeID                      int
}
type battleGrowthCatalog struct {
	native map[int]string
	traits map[string]battleGrowthTraitRule
	skills map[int]battleGrowthSkillConfig
	types  map[int]string
}

func battleGrowthReadCatalog(data []byte) battleGrowthCatalog {
	value, err := battleSharedCatalogDomain(data, "growth-history-config-v1", battleGrowthBuildCatalog)
	if err != nil {
		return battleGrowthCatalog{map[int]string{}, map[string]battleGrowthTraitRule{}, map[int]battleGrowthSkillConfig{}, map[int]string{}}
	}
	return value.(battleGrowthCatalog)
}
func battleGrowthBuildCatalog(c *canonicalcatalog.Catalog, _ string) (any, error) {
	out := battleGrowthCatalog{map[int]string{}, map[string]battleGrowthTraitRule{}, map[int]battleGrowthSkillConfig{}, map[int]string{}}
	for _, t := range c.Traits {
		if rule, ok := battleGrowthTraitRuleFor(t.ID); ok && rule.name == t.Name {
			if rule.description != "" && rule.description != t.Description {
				rule.derive = ""
			}
			out.traits[t.ID] = rule
		}
	}
	for _, m := range c.Monsters {
		out.native[m.ID] = m.TraitID
	}
	for _, s := range c.Skills {
		out.skills[s.ID] = battleGrowthSkillConfig{Name: s.Name, Description: s.Description, Category: s.Category, TypeID: s.TypeID}
	}
	for _, t := range c.Types {
		out.types[t.ID] = t.Code
	}
	return out, nil
}

type battleGrowthActor struct{ side, id string }
type battleGrowthKey struct {
	trait  string
	skill  int
	branch string
}
type battleGrowthObservation struct {
	deltas              map[string]float64
	total               *float64
	complete, seen, bad bool
	minimum             float64
}

func (o *battleGrowthObservation) add(e BattleEvent, n float64) {
	o.seen = true
	if o.deltas == nil {
		o.deltas = map[string]float64{}
	}
	if e.Growth != nil && e.Growth.Mode == "total" {
		if n > o.minimum {
			o.minimum = n
		}
		// Incomplete snapshots cannot prove the final cumulative total. Do not sum
		// snapshots or add them to deltas (the same increments occur in both).
		if !e.Growth.Complete {
			return
		}
		if o.total != nil && *o.total != n {
			o.bad = true
		}
		v := n
		o.total = &v
		return
	}
	identity := e.ID
	if e.Growth != nil {
		if e.Growth.OccurrenceID != "" {
			identity = "occurrence:" + e.Growth.OccurrenceID
		}
		o.complete = o.complete || e.Growth.Complete
	}
	if previous, ok := o.deltas[identity]; ok && previous != n {
		o.bad = true
	}
	o.deltas[identity] = n
}
func (o *battleGrowthObservation) result() (float64, bool) {
	if o == nil || o.bad {
		return 0, false
	}
	sum := 0.0
	for _, v := range o.deltas {
		sum += v
	}
	if o.total != nil {
		if sum > *o.total || o.minimum > *o.total || o.complete && sum != *o.total {
			return 0, false
		}
		return *o.total, true
	}
	if sum < o.minimum {
		return 0, false
	}
	return sum, o.complete
}
func (o *battleGrowthObservation) reconcile(n float64, known bool) (float64, bool) {
	if o == nil {
		return n, known
	}
	if o.bad {
		return 0, false
	}
	if v, ok := o.result(); ok {
		return v, true
	}
	if !known || o.minimum > n || o.total != nil || o.complete {
		return 0, false
	}
	// A partial explicit stream and derivation are not added together. Any
	// quantity disagreement prevents a theoretical trigger from overriding fact.
	sum := 0.0
	for _, v := range o.deltas {
		sum += v
	}
	if o.seen && sum != n {
		return 0, false
	}
	return n, true
}

type battleGrowthRecordView struct {
	r            BattleRecord
	cat          battleGrowthCatalog
	pets         map[battleGrowthActor]BattlePet
	native       map[battleGrowthActor]map[string]bool
	observations map[battleGrowthActor]map[battleGrowthKey]*battleGrowthObservation
	changed      map[battleGrowthActor]bool
	transfer     bool
	history      []BattleGrowthEntrySnapshot
}

func battleGrowthView(r BattleRecord, cat battleGrowthCatalog) battleGrowthRecordView {
	v := battleGrowthRecordView{r: r, cat: cat, pets: map[battleGrowthActor]BattlePet{}, native: map[battleGrowthActor]map[string]bool{}, observations: map[battleGrowthActor]map[battleGrowthKey]*battleGrowthObservation{}, changed: map[battleGrowthActor]bool{}}
	formFrames := map[battleGrowthActor][]BattleEvent{}
	for _, e := range r.Events {
		if e.Kind == "form" && e.Form != nil {
			a := battleGrowthActor{e.Side, e.Actor}
			formFrames[a] = append(formFrames[a], e)
		}
	}
	for side, s := range r.Sides {
		for _, p := range s.Pets {
			a := battleGrowthActor{side, p.InstanceID}
			v.pets[a] = p
			v.native[a] = map[string]bool{}
			if _, ok := cat.traits[cat.native[p.MonsterID]]; ok {
				v.native[a][cat.native[p.MonsterID]] = true
			}
		}
	}
	for a, frames := range formFrames {
		sort.SliceStable(frames, func(i, j int) bool { return battleEventBefore(frames[i], frames[j]) })
		formFrames[a] = frames
		id := v.pets[a].MonsterID
		v.changed[a] = true
		for i, f := range frames {
			if battleGrowthFormTie(frames, i) || id != f.Form.FromMonsterID {
				id = 0
				continue
			}
			id = f.Form.ToMonsterID
			if _, ok := cat.traits[cat.native[id]]; ok {
				v.native[a][cat.native[id]] = true
			}
		}
	}
	for _, e := range r.Events {
		a := battleGrowthActor{e.Side, e.Actor}
		// Copying, identity replacement and cross-instance exchanges invalidate
		// initial-carry continuity. They are NOT themselves new growth or carriers.
		if e.Kind == "skill" && e.Phase == "executed" && battleGrowthChangesSkills(e.SkillID) {
			v.transfer = true
		}
		if _, ok := v.pets[a]; !ok || e.Phase != "executed" {
			continue
		}
		sourceSpecies := battleGrowthSourceSpecies(v.pets[a].MonsterID, e, formFrames[a])
		key, n, ok := v.explicit(e, sourceSpecies)
		if !ok {
			continue
		}
		if v.observations[a] == nil {
			v.observations[a] = map[battleGrowthKey]*battleGrowthObservation{}
		}
		o := v.observations[a][key]
		if o == nil {
			o = &battleGrowthObservation{}
			v.observations[a][key] = o
		}
		o.add(e, n)
	}
	v.history = battleGrowthHistoryEntries(r, cat)
	return v
}

// Form lists contain only explicitly indexed transitions. Resolve each event
// against that independent list: a missing-index unrelated note must not make a
// partial-order sort accidentally move a known before/after growth event.
func battleGrowthFormTie(frames []BattleEvent, i int) bool {
	same := func(j int) bool {
		return j >= 0 && j < len(frames) && frames[i].Round == frames[j].Round && frames[i].Seq == frames[j].Seq && frames[i].Form.ExecIndex == frames[j].Form.ExecIndex
	}
	return same(i-1) || same(i+1)
}
func battleGrowthSourceSpecies(initial int, e BattleEvent, frames []BattleEvent) int {
	id := initial
	for i, f := range frames {
		if f.Round == e.Round && f.Seq == e.Seq && (e.ExecIndex == nil || *e.ExecIndex == f.Form.ExecIndex) {
			return 0
		}
		if !battleEventBefore(f, e) {
			continue
		}
		if battleGrowthFormTie(frames, i) || id != f.Form.FromMonsterID {
			return 0
		}
		id = f.Form.ToMonsterID
	}
	return id
}
func battleGrowthChangesSkills(id int) bool {
	switch id {
	case 14, 25, 44, 175, 424, 492:
		return true
	}
	return false
}
func (v battleGrowthRecordView) explicit(e BattleEvent, current int) (battleGrowthKey, float64, bool) {
	key := battleGrowthKey{}
	if e.Growth != nil {
		key = battleGrowthKey{e.Growth.TraitID, e.SkillID, e.Growth.Branch}
	} else {
		if !battleOneOf(e.Kind, "growth", "effect") || e.Trigger == "" {
			return key, 0, false
		}
		if t, ok := v.cat.traits[v.cat.native[current]]; ok && (e.Trigger == t.id || e.Trigger == t.name) {
			key.trait = t.id
		} else if rule, ok := battleGrowthSkillRuleFor(e.SkillID); ok && battleOneOf(e.Kind, "growth", "effect") && (e.Trigger == rule.name || e.Trigger == strconv.Itoa(rule.id)) {
			key.skill = e.SkillID
			if key.skill == 538 {
				return key, 0, false
			} // No guessed choice branch.
		} else {
			return key, 0, false
		}
	}
	if key.trait != "" {
		if key.trait != v.cat.native[current] {
			return key, 0, false
		}
		if _, ok := v.cat.traits[key.trait]; !ok {
			return key, 0, false
		}
	} else {
		rule, ok := battleGrowthSkillRuleFor(key.skill)
		if !ok {
			return key, 0, false
		}
		if s, exists := v.cat.skills[key.skill]; exists && s.Name != rule.name {
			return key, 0, false
		}
		if key.skill == 510 {
			key.branch = ""
		}
	}
	if e.Stacks != nil {
		return key, float64(*e.Stacks), true
	}
	if key.trait != "" {
		// An exact executed trigger is one logical trigger, not its +30% amount.
		if e.Amount == nil && e.Growth == nil {
			return key, 1, true
		}
		return key, 0, false
	}
	if e.Amount != nil && math.Trunc(*e.Amount) == *e.Amount {
		quantum, _ := battleGrowthUnit(key)
		if quantum <= 0 {
			return key, 0, false
		}
		return key, *e.Amount / quantum, true
	}
	return key, 0, false
}
func (v battleGrowthRecordView) actionType(e BattleEvent) (string, bool) {
	if e.Combat != nil && e.Combat.TypeID != nil {
		s := v.cat.types[*e.Combat.TypeID]
		return s, s != ""
	}
	if e.Combat != nil && e.Combat.ActionKind == "wishImpact" {
		if e.Combat.TypeID == nil {
			return "", false
		}
		s := v.cat.types[*e.Combat.TypeID]
		return s, s != ""
	}
	s, ok := v.cat.skills[e.SkillID]
	if !ok || e.SkillID == 180 {
		return "", false
	} // 天光 uses actual weather type.
	code := v.cat.types[s.TypeID]
	return code, code != ""
}
func battleGrowthIsUse(e BattleEvent) bool {
	return !battleIsStunSkip(e) && e.Phase == "executed" && (e.Kind == "skill" || e.Combat != nil && e.Combat.ActionKind == "wishImpact")
}
func (v battleGrowthRecordView) traitTotal(a battleGrowthActor, key battleGrowthKey) (float64, bool) {
	rule, ok := v.cat.traits[key.trait]
	if ok && battleGrowthHistorical(rule.derive) {
		n, known, _ := v.historicalTraitTotal(a, key)
		return n, known
	}
	known := ok && v.r.Quality.Actions && !v.changed[a] && rule.derive != ""
	total := 0.0
	if known && rule.derive == "entry" {
		total, known = v.entries(a)
	} else if known {
		for _, e := range v.r.Events {
			if e.Side != a.side || e.Actor != a.id || !battleGrowthIsUse(e) {
				continue
			}
			switch rule.derive {
			case "cost3":
				if e.EnergyCost == nil {
					known = false
				} else if *e.EnergyCost == 3 {
					total++
				}
			case "fire":
				if typ, ok := v.actionType(e); !ok {
					known = false
				} else if typ == "Fire" {
					total++
				}
			}
		}
	}
	return v.observations[a][key].reconcile(total, known)
}
func (v battleGrowthRecordView) entries(a battleGrowthActor) (float64, bool) {
	s := v.r.Sides[a.side]
	if !v.r.Quality.Lead[a.side] || s.Lead == "" {
		return 0, false
	}
	active := s.Lead
	total := 0.0
	if active == a.id {
		total = 1
	}
	presence := []BattleEvent{}
	type framePresence struct {
		indexes   map[int]bool
		unindexed bool
	}
	frames := map[[2]int]*framePresence{}
	for _, e := range v.r.Events {
		if e.Side != a.side || e.Phase != "executed" {
			continue
		}
		if e.Kind != "switch" && !(e.Kind == "resource" && e.StateActive != nil) && !battlePerformanceSupply(e) && !battlePerformanceFaint(e) && !(e.Kind == "effect" && e.Combat != nil && e.Combat.LeaveReason == "defeat") {
			continue
		}
		frame := [2]int{e.Round, e.Seq}
		state := frames[frame]
		if state == nil {
			state = &framePresence{indexes: map[int]bool{}}
			frames[frame] = state
		}
		ei, eok := battleMetadataExecutionIndex(e)
		if len(state.indexes) > 0 && (!eok || state.unindexed || state.indexes[ei]) {
			return 0, false
		}
		state.indexes[ei] = true
		state.unindexed = !eok
		presence = append(presence, e)
	}
	sort.SliceStable(presence, func(i, j int) bool { return battleEventBefore(presence[i], presence[j]) })
	for _, e := range presence {
		if e.Kind == "switch" {
			if e.Target == "" || e.Target != active {
				return 0, false
			}
			if e.Actor != active && e.Actor == a.id {
				total++
			}
			active = e.Actor
		} else if e.Kind == "resource" && e.StateActive != nil {
			// State snapshots are not a complete entry/exit stream. A newly
			// observed transition, including an unpaired departure or entry
			// snapshot, prevents an understated complete trigger total.
			if e.StateStage == "entry" || *e.StateActive != (e.Actor == active) {
				return 0, false
			}
		} else if battlePerformanceSupply(e) {
			if e.Actor != active {
				return 0, false
			}
		} else if e.Actor == active {
			return 0, false
		}
	}
	return total, true
}
func (v battleGrowthRecordView) skillTotal(a battleGrowthActor, key battleGrowthKey) (float64, bool) {
	rule, ok := battleGrowthSkillRuleFor(key.skill)
	p := v.pets[a]
	carried := false
	if p.InitialSkills != nil {
		for _, id := range p.InitialSkills.SkillIDs {
			if id == key.skill {
				carried = true
			}
		}
	}
	s, haveSkill := v.cat.skills[key.skill]
	known := ok && haveSkill && s.Name == rule.name && v.r.Quality.Actions && carried && !v.transfer && !v.changed[a] && rule.derive != ""
	if rule.description != "" && rule.description != s.Description {
		known = false
	}
	total := 0.0
	if known {
		for _, e := range v.r.Events {
			if e.Side != a.side || e.Actor != a.id || !battleGrowthIsUse(e) {
				continue
			}
			switch rule.derive {
			case "use":
				if e.Kind == "skill" && e.SkillID == key.skill {
					total += rule.increment
				}
			case "noUse":
				if e.Kind == "skill" && e.SkillID == key.skill {
					known = false
				}
			case "otherGrass", "otherFire":
				if e.Kind == "skill" && e.SkillID == key.skill {
					continue
				}
				typ, ok := v.actionType(e)
				if !ok {
					known = false
					continue
				}
				if rule.derive == "otherGrass" && typ == "Grass" || rule.derive == "otherFire" && typ == "Fire" {
					total += rule.increment
				}
			}
		}
	}
	quantum, _ := battleGrowthUnit(key)
	if quantum > 0 {
		total /= quantum
	}
	return v.observations[a][key].reconcile(total, known)
}

// BuildBattleGrowthStats performs no I/O, no mutation, no profile/manual-config
// lookup and no raw-protocol inference. Invalid/conflicting duplicate IDs are
// excluded as a whole, while compatible fragments merge before aggregation.
func BuildBattleGrowthStats(records []BattleRecord, catalogData []byte) *BattleGrowthStats {
	out := &BattleGrowthStats{Me: []BattleSpeciesGrowth{}, Enemy: []BattleSpeciesGrowth{}}
	cat := battleGrowthReadCatalog(catalogData)
	unique := map[string]BattleRecord{}
	bad := map[string]bool{}
	for _, input := range records {
		r, err := battleClone(input)
		if err == nil {
			err = ValidateBattleRecord(&r)
		}
		if err == nil {
			err = battleGrowthRecordsValid(&r)
		}
		if err != nil {
			bad[input.ID] = true
			delete(unique, input.ID)
			continue
		}
		if bad[r.ID] {
			continue
		}
		if old, ok := unique[r.ID]; ok {
			r, err = MergeBattleRecord(old, r)
			if err != nil {
				bad[input.ID] = true
				delete(unique, input.ID)
				continue
			}
		}
		sort.SliceStable(r.Events, func(i, j int) bool { return battleEventBefore(r.Events[i], r.Events[j]) })
		unique[r.ID] = r
	}
	ids := make([]string, 0, len(unique))
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	views := make([]battleGrowthRecordView, 0, len(ids))
	for _, id := range ids {
		views = append(views, battleGrowthView(unique[id], cat))
	}
	for _, side := range []string{"me", "enemy"} {
		rows := map[int]*BattleSpeciesGrowth{}
		// Discover selected eligibility independently from observations, so a native
		// owner with missing evidence is visible as unknown, not an omitted/zero row.
		traitSets := map[int]map[string]bool{}
		skillSets := map[int]map[battleGrowthKey]bool{}
		for _, v := range views {
			for a, p := range v.pets {
				if a.side != side || p.MonsterID <= 0 {
					continue
				}
				if rows[p.MonsterID] == nil {
					rows[p.MonsterID] = &BattleSpeciesGrowth{MonsterID: p.MonsterID, Skills: []BattleSkillGrowth{}}
					traitSets[p.MonsterID] = map[string]bool{}
					skillSets[p.MonsterID] = map[battleGrowthKey]bool{}
				}
				for id := range v.native[a] {
					traitSets[p.MonsterID][id] = true
				}
				addSkill := func(id int) {
					if rule, ok := battleGrowthSkillRuleFor(id); ok {
						if s, exists := cat.skills[id]; exists && s.Name != rule.name {
							return
						}
						if id == 538 {
							skillSets[p.MonsterID][battleGrowthKey{skill: id, branch: "power"}] = true
							skillSets[p.MonsterID][battleGrowthKey{skill: id, branch: "hits"}] = true
						} else {
							skillSets[p.MonsterID][battleGrowthKey{skill: id}] = true
						}
					}
				}
				if p.InitialSkills != nil {
					for _, id := range p.InitialSkills.SkillIDs {
						addSkill(id)
					}
				}
				for k := range v.observations[a] {
					if k.skill != 0 {
						addSkill(k.skill)
					}
				}
			}
		}
		species := make([]int, 0, len(rows))
		for id := range rows {
			species = append(species, id)
		}
		sort.Ints(species)
		for _, id := range species {
			row := rows[id]
			if rule, ok := cat.traits[cat.native[id]]; ok {
				// The singular DTO names the initial native trait; a later form's
				// different trait must not hide it or be relabelled as its growth.
				row.Trait = &BattleTraitGrowth{TraitID: rule.id, Name: rule.name}
			} else if len(traitSets[id]) == 1 {
				for t := range traitSets[id] {
					rule := cat.traits[t]
					row.Trait = &BattleTraitGrowth{TraitID: t, Name: rule.name}
				}
			}
			keys := make([]battleGrowthKey, 0, len(skillSets[id]))
			for k := range skillSets[id] {
				keys = append(keys, k)
			}
			sort.Slice(keys, func(i, j int) bool {
				if keys[i].skill != keys[j].skill {
					return keys[i].skill < keys[j].skill
				}
				return keys[i].branch < keys[j].branch
			})
			for _, key := range keys {
				rule, _ := battleGrowthSkillRuleFor(key.skill)
				_, unit := battleGrowthUnit(key)
				row.Skills = append(row.Skills, BattleSkillGrowth{SkillID: key.skill, Name: rule.name, Branch: key.branch, Unit: unit})
			}
			for _, v := range views {
				cohort := []battleGrowthActor{}
				for a, p := range v.pets {
					if a.side == side && p.MonsterID == id {
						cohort = append(cohort, a)
					}
				}
				if len(cohort) == 0 {
					continue
				}
				if row.Trait != nil {
					sum, known, eligible, observedPrefix := 0.0, true, false, false
					key := battleGrowthKey{trait: row.Trait.TraitID}
					for _, a := range cohort {
						if !v.native[a][key.trait] {
							continue
						}
						eligible = true
						n, ok := v.traitTotal(a, key)
						if battleGrowthHistorical(cat.traits[key.trait].derive) {
							_, _, lower := v.historicalTraitTotal(a, key)
							observedPrefix = observedPrefix || lower
						}
						sum += n
						known = known && ok
					}
					if eligible {
						if known {
							row.Trait.Total += sum
							row.Trait.Samples++
							if observedPrefix {
								row.Trait.ObservedPrefixSamples++
							}
						} else {
							row.Trait.Unknown++
						}
					}
				}
				for i, key := range keys {
					sum, known, eligible := 0.0, true, false
					for _, a := range cohort {
						p := v.pets[a]
						carry := false
						for k := range v.observations[a] {
							if k.skill == key.skill {
								carry = true
							}
						}
						if p.InitialSkills != nil {
							for _, skill := range p.InitialSkills.SkillIDs {
								if skill == key.skill {
									carry = true
								}
							}
						}
						// A missing/partial loadout cannot be treated as a known noncarrier in
						// a same-species cohort or in this skill's cross-battle denominator.
						if !carry {
							if p.InitialSkills == nil || !p.InitialSkills.Complete {
								eligible = true
								known = false
							}
							continue
						}
						eligible = true
						n, ok := v.skillTotal(a, key)
						sum += n
						known = known && ok
					}
					if eligible {
						if known {
							row.Skills[i].Total += sum
							row.Skills[i].Samples++
						} else {
							row.Skills[i].Unknown++
						}
					}
				}
			}
			if row.Trait != nil && row.Trait.Samples > 0 {
				n := row.Trait.Total / float64(row.Trait.Samples)
				row.Trait.Average = &n
			}
			for i := range row.Skills {
				s := &row.Skills[i]
				if s.Samples > 0 {
					n := s.Total / float64(s.Samples)
					s.Average = &n
				}
			}
			if side == "me" {
				out.Me = append(out.Me, *row)
			} else {
				out.Enemy = append(out.Enemy, *row)
			}
		}
	}
	return out
}

// Stacks is already an explicitly identified layer count; Amount is an actual
// effect magnitude and must be converted before either can be displayed as layers.
func battleGrowthUnit(key battleGrowthKey) (quantum float64, label string) {
	if key.trait != "" {
		return 1, "每层=特性触发1次"
	}
	switch key.skill {
	case 79, 404:
		return 1, "每层=连击数+1"
	case 163:
		return 1, "每层=能耗降低1"
	case 265:
		return 1, "每层=技能使用次数参数+1"
	case 131:
		return 1, "每层=永久翻倍1次"
	case 538:
		if key.branch == "hits" {
			return 1, "每层=连击数+1"
		}
		return 10, "每层=威力+10"
	}
	rule, _ := battleGrowthSkillRuleFor(key.skill)
	return rule.increment, "每层=威力+" + strconv.FormatFloat(rule.increment, 'f', -1, 64)
}
