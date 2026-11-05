package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"sort"
	"strconv"
	"testing"
	canonicalcatalog "xhmwiki/internal/catalog"
)

func growthInt(n int) *int           { return &n }
func growthFloat(n float64) *float64 { return &n }
func growthCatalog(t *testing.T) ([]byte, *canonicalcatalog.Catalog) {
	t.Helper()
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	c, err := canonicalcatalog.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	return data, c
}
func growthRecord(id string, monster int, skills ...int) BattleRecord {
	return BattleRecord{Version: 1, ID: id, Mode: "pvp", Outcome: "win", Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": true, "enemy": true}}, Sides: map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "a", MonsterID: monster, InitialSkills: &BattleInitialSkills{SkillIDs: append([]int{}, skills...), Complete: true}}}, Lead: "a"},
		"enemy": {Pets: []BattlePet{{InstanceID: "b", MonsterID: 1, InitialSkills: &BattleInitialSkills{SkillIDs: []int{}, Complete: true}}}, Lead: "b"},
	}, Events: []BattleEvent{}, Issues: []string{}}
}
func growthEvent(id, side, actor, trait string, skill, n int, mode string, complete bool) BattleEvent {
	return BattleEvent{ID: id, Round: 1, Seq: 1, Kind: "growth", Phase: "executed", Side: side, Actor: actor, SkillID: skill, Stacks: growthInt(n), Growth: &BattleGrowthEvidence{TraitID: trait, Mode: mode, Complete: complete}}
}
func growthCast(id, side, actor string, skill, seq int) BattleEvent {
	return BattleEvent{ID: id, Round: 1, Seq: seq, Kind: "skill", Phase: "executed", Side: side, Actor: actor, SkillID: skill, SkillClass: "ordinary"}
}
func growthRow(t *testing.T, out *BattleGrowthStats, side string, monster int) BattleSpeciesGrowth {
	t.Helper()
	rows := out.Me
	if side == "enemy" {
		rows = out.Enemy
	}
	for _, r := range rows {
		if r.MonsterID == monster {
			return r
		}
	}
	t.Fatalf("missing growth row %s/%d: %+v", side, monster, out)
	return BattleSpeciesGrowth{}
}
func growthSkill(t *testing.T, row BattleSpeciesGrowth, id int, branch string) BattleSkillGrowth {
	t.Helper()
	for _, s := range row.Skills {
		if s.SkillID == id && s.Branch == branch {
			return s
		}
	}
	t.Fatalf("missing skill %d/%s: %+v", id, branch, row)
	return BattleSkillGrowth{}
}
func growthValid(t *testing.T, r BattleRecord) {
	t.Helper()
	clone, err := battleClone(r)
	if err == nil {
		err = ValidateBattleRecord(&clone)
	}
	if err != nil {
		t.Fatalf("invalid fixture %s: %v", r.ID, err)
	}
}
func growthAssert(t *testing.T, total float64, samples, unknown int, avg *float64, want float64, ws, wu int) {
	t.Helper()
	if total != want || samples != ws || unknown != wu {
		t.Fatalf("got total=%v samples=%d unknown=%d; want %v/%d/%d", total, samples, unknown, want, ws, wu)
	}
	if ws == 0 {
		if avg != nil {
			t.Fatalf("missing sample became %v", *avg)
		}
	} else if avg == nil || *avg != want/float64(ws) {
		t.Fatalf("incorrect average: %v", avg)
	}
}

func TestBattleGrowthAll22TraitsAndAllNativeOwners(t *testing.T) {
	data, c := growthCatalog(t)
	expected := []string{"爆燃", "三鼓作气", "蓄电池", "洄游", "合拍", "光度换算", "水翼推进", "水翼飞升", "身经百练", "渗透", "拨浪鼓", "蒸汽膨胀", "定向精炼", "搜刮", "扫荡", "淬炼火", "猫精灵的礼物", "旧玩具", "蒸汽革命", "圣龙的守护", "花精灵", "坚韧铠甲"}
	got := []string{}
	seen := map[string]bool{}
	for _, rule := range battleGrowthTraitRules {
		got = append(got, rule.name)
		if seen[rule.id] {
			t.Fatal("duplicate trait identity")
		}
		seen[rule.id] = true
	}
	sort.Strings(expected)
	sort.Strings(got)
	if !reflect.DeepEqual(expected, got) {
		t.Fatalf("selection changed: %v", got)
	}
	cat := battleGrowthReadCatalog(data)
	if len(cat.traits) != 22 {
		t.Fatalf("catalog exact-name verification failed: %d", len(cat.traits))
	}
	owners := map[int]bool{}
	for _, m := range c.Monsters {
		rule, ok := cat.traits[m.TraitID]
		if !ok {
			continue
		}
		owners[m.ID] = true
		t.Run(rule.name+"/"+strconv.Itoa(m.ID), func(t *testing.T) {
			r := growthRecord("positive", m.ID)
			r.Events = []BattleEvent{growthEvent("g", "me", "a", rule.id, 0, 4, "total", true)}
			z := growthRecord("zero", m.ID)
			z.Events = []BattleEvent{growthEvent("z", "me", "a", rule.id, 0, 0, "total", true)}
			missing := growthRecord("missing", m.ID)
			partial := growthRecord("partial", m.ID)
			partial.Events = []BattleEvent{growthEvent("partial-g", "me", "a", rule.id, 0, 9, "delta", false)}
			growthValid(t, r)
			row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r, z, missing, partial}, data), "me", m.ID)
			if row.Trait == nil || row.Trait.TraitID != rule.id || row.Trait.Name != rule.name {
				t.Fatalf("native selected trait omitted: %+v", row)
			}
			growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 4, 2, 2)
		})
	}
	for _, id := range []int{190, 191, 192, 431, 432} {
		if !owners[id] {
			t.Fatalf("native owner %d omitted", id)
		}
	}
	for _, id := range []int{357, 248, 249, 595, 616, 617} {
		if owners[id] {
			t.Fatalf("unselected/acquired trait guessed for %d", id)
		}
	}
}
func TestBattleGrowthAll16SkillsKnownZeroMissingAndBothSides(t *testing.T) {
	data, _ := growthCatalog(t)
	want := []int{88, 113, 126, 131, 154, 173, 252, 272, 429, 510, 537, 79, 404, 538, 265, 163}
	got := []int{}
	for _, r := range battleGrowthSkillRules {
		got = append(got, r.id)
	}
	sort.Ints(want)
	sort.Ints(got)
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("selection changed: %v", got)
	}
	for _, rule := range battleGrowthSkillRules {
		branches := []string{""}
		if rule.id == 538 {
			branches = []string{"power", "hits"}
		}
		for _, branch := range branches {
			t.Run(rule.name+branch, func(t *testing.T) {
				r := growthRecord("positive", 1, rule.id)
				z := growthRecord("zero", 1, rule.id)
				missing := growthRecord("missing", 1, rule.id)
				for _, pair := range []struct {
					r *BattleRecord
					n int
				}{{&r, 4}, {&z, 0}} {
					side := pair.r.Sides["enemy"]
					side.Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{rule.id}, Complete: true}
					pair.r.Sides["enemy"] = side
					for _, s := range []string{"me", "enemy"} {
						actor := "a"
						if s == "enemy" {
							actor = "b"
						}
						e := growthEvent(s+"-g", s, actor, "", rule.id, pair.n, "total", true)
						e.Growth.Branch = branch
						pair.r.Events = append(pair.r.Events, e)
					}
				}
				side := missing.Sides["enemy"]
				side.Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{rule.id}, Complete: true}
				missing.Sides["enemy"] = side
				out := BuildBattleGrowthStats([]BattleRecord{r, z, missing}, data)
				for _, s := range []string{"me", "enemy"} {
					stat := growthSkill(t, growthRow(t, out, s, 1), rule.id, branch)
					growthAssert(t, stat.Total, stat.Samples, stat.Unknown, stat.Average, 4, 2, 1)
					if stat.Unit == "" {
						t.Fatal("layer unit missing")
					}
				}
			})
		}
	}
}
func TestBattleGrowthCompleteActionsActualUsesNotHitsOrAttempts(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("actions", 14, 113, 79)
	r.Quality.Actions = true
	a := growthCast("fire1", "me", "a", 113, 1)
	b := growthCast("fire2", "me", "a", 113, 3)
	p := growthCast("spores", "me", "a", 79, 4)
	interrupted := growthCast("interrupted", "me", "a", 113, 5)
	interrupted.Phase = "interrupted"
	r.Events = []BattleEvent{a, a, b, p, interrupted, {ID: "hit1", Kind: "damage", Phase: "executed", Side: "me", Actor: "a", TargetSide: "enemy", Target: "b", Round: 1, Seq: 2, SkillID: 113, HPChange: growthInt(-20)}, {ID: "hit2", Kind: "damage", Phase: "executed", Side: "me", Actor: "a", TargetSide: "enemy", Target: "b", Round: 1, Seq: 2, SkillID: 113, HPChange: growthInt(-30)}}
	z := growthRecord("no-activation", 14, 113, 79)
	z.Quality.Actions = true
	z.Events = []BattleEvent{growthCast("enemy", "enemy", "b", 13, 1)}
	missing := growthRecord("missing", 14, 113, 79)
	input := []BattleRecord{r, z, missing}
	before, _ := json.Marshal(input)
	catalogBefore := append([]byte{}, data...)
	row := growthRow(t, BuildBattleGrowthStats(input, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 2, 1)
	fire := growthSkill(t, row, 113, "")
	growthAssert(t, fire.Total, fire.Samples, fire.Unknown, fire.Average, 2, 2, 1)
	spore := growthSkill(t, row, 79, "")
	growthAssert(t, spore.Total, spore.Samples, spore.Unknown, spore.Average, 2, 2, 1)
	after, _ := json.Marshal(input)
	if !bytes.Equal(before, after) || !bytes.Equal(catalogBefore, data) {
		t.Fatal("growth aggregation mutated input")
	}
}
func TestBattleGrowthOtherSkillConditionsAndActualCost(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("other-elements", 323, 88, 131, 79, 113)
	r.Quality.Actions = true
	r.Events = []BattleEvent{growthCast("grass", "me", "a", 79, 1), growthCast("fire", "me", "a", 113, 2), growthCast("self-grass", "me", "a", 88, 3), growthCast("self-fire", "me", "a", 131, 4)}
	for i := range r.Events {
		r.Events[i].EnergyCost = growthInt(2)
	}
	r.Events[0].EnergyCost = growthInt(3)
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 323)
	// 88 grows from other grass 79, but not itself; 131 from113, not itself.
	for _, id := range []int{88, 131} {
		s := growthSkill(t, row, id, "")
		growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 1, 1, 0)
	}
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 1, 1, 0)
	r.Events[2].EnergyCost = nil
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 323)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
}
func TestBattleGrowthEntryCyclesNotRepeatedStateOrFormSnapshots(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("entries", 354)
	r.Quality.Actions = true
	s := r.Sides["me"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "other", MonsterID: 1})
	r.Sides["me"] = s
	r.Events = []BattleEvent{{ID: "out", Kind: "switch", Phase: "executed", Side: "me", Actor: "other", Target: "a", Round: 1, Seq: 1}, {ID: "in", Kind: "switch", Phase: "executed", Side: "me", Actor: "a", Target: "other", Round: 2, Seq: 1}}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 1, 0)
	r.Quality.Lead["me"] = false
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
}
func TestBattleGrowthEntryCoverageRejectsUnpairedOrUnorderedTransitions(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("entry-coverage", 354)
	r.Quality.Actions = true
	side := r.Sides["me"]
	side.Pets = append(side.Pets, BattlePet{InstanceID: "other", MonsterID: 1})
	r.Sides["me"] = side
	active, inactive := true, false
	snapshot := BattleEvent{ID: "state", Kind: "resource", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 2, StateStage: "snapshot", StateActive: &active}
	r.Events = []BattleEvent{snapshot, growthCast("enemy", "enemy", "b", 13, 1)}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 1, 1, 0)
	snapshot.StateActive = &inactive
	r.Events = []BattleEvent{snapshot, growthCast("enemy", "enemy", "b", 13, 1)}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
	out := BattleEvent{ID: "out", Kind: "switch", Phase: "executed", Side: "me", Actor: "other", Target: "a", Round: 1, Seq: 2}
	in := BattleEvent{ID: "in", Kind: "switch", Phase: "executed", Side: "me", Actor: "a", Target: "other", Round: 1, Seq: 2}
	for _, events := range [][]BattleEvent{{out, in}, {in, out}} {
		r.Events = events
		row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
		growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
	}
	out.ExecIndex = growthInt(0)
	in.ExecIndex = growthInt(1)
	r.Events = []BattleEvent{in, out}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 354)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 1, 0)
}

func TestBattleGrowthConditionalBranchesCounterAndHPStayUnknown(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("branches", 1, 510, 538, 163, 404)
	r.Quality.Actions = true
	for i, id := range []int{510, 538, 163, 404} {
		r.Events = append(r.Events, growthCast("cast"+strconv.Itoa(id), "me", "a", id, i+2))
	}
	status := growthCast("status", "enemy", "b", 16, 1)
	r.Events = append(r.Events, status)
	r.Events[2].SkillClass = "response"
	r.Events[2].Combat = &BattleCombatEvidence{CounteredActionID: "status"}
	r.Events = append(r.Events, BattleEvent{ID: "hp-zero", Kind: "damage", Phase: "executed", Side: "me", Actor: "a", TargetSide: "enemy", Target: "b", Round: 1, Seq: 6, HPAfter: growthInt(0), HPChange: growthInt(-20)})
	growthValid(t, r)
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1)
	for _, s := range row.Skills {
		growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 0, 0, 1)
	}
	// A proven actual branch and final effect stream is useful even when actions
	// are partial. The other branch remains missing, not manufactured as zero.
	r.Quality.Actions = false
	e := growthEvent("actual", "me", "a", "", 538, 3, "total", true)
	e.Growth.Branch = "hits"
	r.Events = append(r.Events, e)
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1)
	hits := growthSkill(t, row, 538, "hits")
	growthAssert(t, hits.Total, hits.Samples, hits.Unknown, hits.Average, 3, 1, 0)
	power := growthSkill(t, row, 538, "power")
	growthAssert(t, power.Total, power.Samples, power.Unknown, power.Average, 0, 0, 1)
}
func TestBattleGrowthLayerUnitsAndTypedQuantityValidation(t *testing.T) {
	data, _ := growthCatalog(t)
	for _, tc := range []struct {
		id           int
		branch       string
		amount, want float64
	}{{113, "", 40, 2}, {88, "", 120, 2}, {272, "", 80, 2}, {79, "", 2, 2}, {404, "", 4, 4}, {163, "", 3, 3}, {265, "", 2, 2}, {538, "power", 30, 3}, {538, "hits", 3, 3}} {
		r := growthRecord("units", 1, tc.id)
		e := growthEvent("g", "me", "a", "", tc.id, 0, "total", true)
		e.Stacks = nil
		e.Amount = growthFloat(tc.amount)
		e.Growth.Branch = tc.branch
		r.Events = []BattleEvent{e}
		s := growthSkill(t, growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1), tc.id, tc.branch)
		growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, tc.want, 1, 0)
	}
	e := growthEvent("conflict", "me", "a", "", 113, 3, "total", true)
	e.Amount = growthFloat(60)
	if err := battleGrowthEvidenceValid(e); err != nil {
		t.Fatal(err)
	}
	e.Amount = growthFloat(40)
	if battleGrowthEvidenceValid(e) == nil {
		t.Fatal("incompatible amount/stack units accepted")
	}
	e = growthEvent("ambiguous", "me", "a", "", 131, 0, "total", true)
	e.Stacks = nil
	e.Amount = growthFloat(2)
	if battleGrowthEvidenceValid(e) == nil {
		t.Fatal("ambiguous multiplier became doubling count")
	}
}
func TestBattleGrowthDuplicateEventsOccurrencesFragmentsAndFinalCounters(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := battleGrowthTraitRules[0].id
	r := growthRecord("dup", 14)
	a := growthEvent("attack-buff", "me", "a", trait, 0, 1, "delta", true)
	a.Growth.OccurrenceID = "one-fire-use"
	b := a
	b.ID = "magic-buff"
	b.Growth = battleGrowthClone(a.Growth)
	r.Events = []BattleEvent{a, a, b}
	fragment := growthRecord("dup", 14)
	fragment.Events = []BattleEvent{a}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r, fragment, r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 1, 1, 0)
	for i := range r.Events {
		r.Events[i].Growth = battleGrowthClone(r.Events[i].Growth)
		r.Events[i].Growth.Complete = false
	}
	final := growthEvent("final", "me", "a", trait, 0, 4, "total", true)
	final.Seq = 9
	r.Events = append(r.Events, final)
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 4, 1, 0)
	// A cumulative snapshot without explicit final coverage cannot certify the
	// total of a partial capture; it must not be summed with delta events either.
	r.Events = []BattleEvent{final}
	r.Events[0].Growth = battleGrowthClone(final.Growth)
	r.Events[0].Growth.Complete = false
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
}
func TestBattleGrowthSameSpeciesCohortsRequireEveryEligibleInstance(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := battleGrowthTraitRules[0].id
	r := growthRecord("cohort", 14, 113)
	side := r.Sides["me"]
	side.Pets = append(side.Pets, BattlePet{InstanceID: "a2", MonsterID: 14, InitialSkills: &BattleInitialSkills{SkillIDs: []int{113}, Complete: true}})
	r.Sides["me"] = side
	r.Events = []BattleEvent{growthEvent("one", "me", "a", trait, 0, 3, "total", true), growthEvent("skill-one", "me", "a", "", 113, 2, "total", true)}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
	s := growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 0, 0, 1)
	r.Events = append(r.Events, growthEvent("two", "me", "a2", trait, 0, 2, "total", true), growthEvent("skill-two", "me", "a2", "", 113, 0, "total", true))
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 5, 1, 0)
	s = growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 2, 1, 0)
}
func TestBattleGrowthFormsUseSourceNativeTraitAndInitialSpecies(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := "trait-5f2ff7cdd642cdb0950c1d9b5e1b7e40"
	r := growthRecord("form", 297)
	pre := growthEvent("before-form", "me", "a", trait, 0, 8, "delta", false)
	form := BattleEvent{ID: "form", Kind: "form", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 2, Form: &BattleFormChange{FromBaseID: "297", ToBaseID: "311", FromMonsterID: 297, ToMonsterID: 311, ExecIndex: 0}}
	post := growthEvent("after-form", "me", "a", trait, 0, 2, "total", true)
	post.Seq = 3
	r.Events = []BattleEvent{pre, form, post}
	growthValid(t, r)
	out := BuildBattleGrowthStats([]BattleRecord{r}, data)
	row := growthRow(t, out, "me", 297)
	if row.Trait == nil {
		t.Fatal("confirmed native form trait not attributed to initial species")
	}
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 1, 0)
	if len(out.Me) != 1 {
		t.Fatal("form added another initial-species row")
	}
	wolf := growthRecord("wolf", 595)
	wolf.Events = []BattleEvent{growthEvent("not-native", "me", "a", trait, 0, 5, "total", true)}
	w := growthRow(t, BuildBattleGrowthStats([]BattleRecord{wolf}, data), "me", 595)
	if w.Trait != nil {
		t.Fatal("acquired trait guessed")
	}
}
func TestBattleGrowthNoLearnsetCastOrExchangeCarrierGuess(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("copied", 1)
	r.Quality.Actions = true
	r.Events = []BattleEvent{growthCast("exchange", "me", "a", 424, 1), growthCast("copied-fire", "me", "a", 113, 2), growthCast("ordinary", "me", "a", 13, 3)}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1)
	if len(row.Skills) != 0 {
		t.Fatal("casts/learnsets created initial carriers")
	}
	// A separate known-carrier battle discovers the row, but the complete empty
	// initial loadout does not become a denominator due to an exchanged cast.
	known := growthRecord("known", 1, 113)
	known.Events = []BattleEvent{growthEvent("zero", "me", "a", "", 113, 0, "total", true)}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r, known}, data), "me", 1)
	s := growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 0, 1, 0)
	missing := growthRecord("unknown-loadout", 1)
	p := missing.Sides["me"]
	p.Pets[0].InitialSkills = nil
	missing.Sides["me"] = p
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{known, missing}, data), "me", 1)
	s = growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 0, 1, 1)
	// Actual growth is evidence of the beneficiary skill even without claiming
	// it was initially carried. Explicit final coverage can qualify its own row.
	r.Quality.Actions = false
	r.Events = append(r.Events, growthEvent("actual", "me", "a", "", 113, 2, "total", true))
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1)
	s = growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 2, 1, 0)
}
func TestBattleGrowthLegacyExactTriggerSupportAndGenericCountersRejected(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("legacy", 14, 113)
	r.Quality.Actions = true
	r.Events = []BattleEvent{growthCast("cast", "me", "a", 113, 1), {ID: "trait", Kind: "effect", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 2, Trigger: "爆燃"}, {ID: "growth", Kind: "growth", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 3, SkillID: 113, Trigger: "吹火", Stacks: growthInt(1)}}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 1, 1, 0)
	s := growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 1, 1, 0)
	r.Quality.Actions = false
	r.Events = []BattleEvent{{ID: "raw", Kind: "growth", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 1, SkillID: 113, Trigger: "grow_times", Stacks: growthInt(50)}}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	s = growthSkill(t, row, 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 0, 0, 1)
}
func TestBattleGrowthConflictingFragmentsAndFutureCatalogFailClosed(t *testing.T) {
	data, _ := growthCatalog(t)
	r := growthRecord("conflict", 1, 113)
	r.Events = []BattleEvent{growthEvent("g", "me", "a", "", 113, 2, "total", true)}
	b, _ := battleClone(r)
	b.Events[0].Stacks = growthInt(3)
	for _, input := range [][]BattleRecord{{r, b}, {b, r}} {
		out := BuildBattleGrowthStats(input, data)
		if len(out.Me) != 0 || len(out.Enemy) != 0 {
			t.Fatal("conflicting record included")
		}
	}
	noCatalog := BuildBattleGrowthStats([]BattleRecord{r}, []byte(`{"schema_version":999}`))
	// Stable skill evidence remains usable without a catalog; native trait
	// membership is never guessed without a successfully parsed catalog.
	s := growthSkill(t, growthRow(t, noCatalog, "me", 1), 113, "")
	growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, 2, 1, 0)
}

func TestBattleGrowthTypedValidationMergingAndBranchOccurrenceConflicts(t *testing.T) {
	base := growthEvent("g", "me", "a", "", 113, 2, "total", true)
	cases := map[string]func(*BattleEvent){
		"wrong-kind":       func(e *BattleEvent) { e.Kind = "skill" },
		"preview":          func(e *BattleEvent) { e.Phase = "preview" },
		"unselected":       func(e *BattleEvent) { e.SkillID = 13 },
		"two-identities":   func(e *BattleEvent) { e.Growth.TraitID = battleGrowthTraitRules[0].id },
		"missing-quantity": func(e *BattleEvent) { e.Stacks = nil },
		"negative":         func(e *BattleEvent) { e.Stacks = growthInt(-1) },
		"branch":           func(e *BattleEvent) { e.Growth.Branch = "temporary" },
		"missing-mode":     func(e *BattleEvent) { e.Growth.Mode = "" },
		"ambiguous-target": func(e *BattleEvent) { e.Target = "b" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			e := base
			e.Growth = battleGrowthClone(base.Growth)
			change(&e)
			if battleGrowthEvidenceValid(e) == nil {
				t.Fatal("invalid growth declaration accepted")
			}
		})
	}
	left, right := base, base
	left.Growth = nil
	if err := battleMergeGrowthFields(&left, &right); err != nil {
		t.Fatal(err)
	}
	if left.Growth == nil || !reflect.DeepEqual(left.Growth, right.Growth) || left.Growth == right.Growth {
		t.Fatal("merge did not enrich isolated copies")
	}
	left.Growth.Complete = false
	if !right.Growth.Complete {
		t.Fatal("merged evidence aliases its peer")
	}
	wrong := base
	wrong.Growth = battleGrowthClone(base.Growth)
	wrong.Growth.Mode = "delta"
	before, _ := json.Marshal(left)
	if battleMergeGrowthFields(&left, &wrong) == nil {
		t.Fatal("mode conflict accepted")
	}
	after, _ := json.Marshal(left)
	if !bytes.Equal(before, after) {
		t.Fatal("failed merge mutated its input")
	}
	r := growthRecord("choice-conflict", 1, 538)
	p := growthEvent("power", "me", "a", "", 538, 1, "delta", true)
	p.Growth.Branch = "power"
	p.Growth.OccurrenceID = "one-choice"
	h := growthEvent("hits", "me", "a", "", 538, 1, "delta", true)
	h.Growth.Branch = "hits"
	h.Growth.OccurrenceID = "one-choice"
	r.Events = []BattleEvent{p, h}
	if battleGrowthRecordsValid(&r) == nil {
		t.Fatal("one logical choice counted both branches")
	}
	h.Growth.OccurrenceID = "another-enactment"
	r.Events = []BattleEvent{p, h}
	if err := battleGrowthRecordsValid(&r); err != nil {
		t.Fatal(err)
	}
}

func TestBattleGrowthIncompleteCounterContradictsCompleteDeltaStream(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := battleGrowthTraitRules[0].id
	r := growthRecord("counter-contradiction", 14)
	snapshot := growthEvent("snapshot", "me", "a", trait, 0, 5, "total", false)
	delta := growthEvent("delta", "me", "a", trait, 0, 3, "delta", true)
	for _, events := range [][]BattleEvent{{snapshot, delta}, {delta, snapshot}} {
		r.Events = events
		row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
		growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
	}
	r.Quality.Actions = true
	for i := 0; i < 5; i++ {
		r.Events = append(r.Events, growthCast("fire"+strconv.Itoa(i), "me", "a", 113, i+2))
	}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 14)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
}

func TestBattleGrowthSameFrameFormsRequireProvenSourceOrdering(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := "trait-5f2ff7cdd642cdb0950c1d9b5e1b7e40"
	r := growthRecord("ambiguous-form", 297)
	f := BattleEvent{ID: "form", Kind: "form", Phase: "executed", Side: "me", Actor: "a", Round: 1, Seq: 2, Form: &BattleFormChange{FromBaseID: "297", ToBaseID: "311", FromMonsterID: 297, ToMonsterID: 311, ExecIndex: 0}}
	g := growthEvent("growth", "me", "a", trait, 0, 2, "total", true)
	g.Seq = 2
	var first []byte
	for _, events := range [][]BattleEvent{{f, g}, {g, f}} {
		r.Events = events
		out := BuildBattleGrowthStats([]BattleRecord{r}, data)
		row := growthRow(t, out, "me", 297)
		if row.Trait == nil {
			t.Fatal("selected form trait should remain visible as unknown")
		}
		growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
		encoded, _ := json.Marshal(out)
		if first == nil {
			first = encoded
		} else if !bytes.Equal(first, encoded) {
			t.Fatal("input order selected an unproven source-time form")
		}
	}
	// A distinct explicit execution index proves the form is already active,
	// regardless of intervening unindexed metadata or input order.
	g.ExecIndex = growthInt(1)
	note := BattleEvent{ID: "note", Kind: "note", Phase: "unknown", Side: "unknown", Round: 1, Seq: 2}
	for _, events := range [][]BattleEvent{{f, note, g}, {g, note, f}} {
		r.Events = events
		row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 297)
		growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 1, 0)
	}
	g.ExecIndex = growthInt(0)
	r.Events = []BattleEvent{f, g}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 297)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 0, 0, 1)
}

func TestBattleGrowthTraitSidesDoNotShareInstanceOrOccurrenceIDs(t *testing.T) {
	data, _ := growthCatalog(t)
	trait := battleGrowthTraitRules[0].id
	r := growthRecord("same-instance-id", 14)
	enemy := r.Sides["enemy"]
	enemy.Pets[0].InstanceID = "a"
	enemy.Pets[0].MonsterID = 14
	enemy.Lead = "a"
	r.Sides["enemy"] = enemy
	me := growthEvent("me", "me", "a", trait, 0, 2, "total", true)
	me.Growth.OccurrenceID = "same"
	foe := growthEvent("enemy", "enemy", "a", trait, 0, 4, "total", true)
	foe.Growth.OccurrenceID = "same"
	r.Events = []BattleEvent{me, foe}
	before, _ := json.Marshal(r)
	growthValid(t, r)
	out := BuildBattleGrowthStats([]BattleRecord{r}, data)
	for side, n := range map[string]float64{"me": 2, "enemy": 4} {
		s := growthRow(t, out, side, 14).Trait
		if s == nil {
			t.Fatal("missing side trait")
		}
		growthAssert(t, s.Total, s.Samples, s.Unknown, s.Average, n, 1, 0)
	}
	after, _ := json.Marshal(r)
	if !bytes.Equal(before, after) {
		t.Fatal("side projection mutated source evidence")
	}
}

func TestBattleGrowthPartialCatalogStableIdentityAndNoAutoRename(t *testing.T) {
	rule := battleGrowthTraitRules[0]
	c := &canonicalcatalog.Catalog{SchemaVersion: 2,
		Types:     []canonicalcatalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}},
		Traits:    []canonicalcatalog.Trait{{ID: rule.id, Name: rule.name, Description: rule.description}},
		Skills:    []canonicalcatalog.Skill{{ID: 13, Name: "普通攻击", Description: "对敌方造成物理伤害。", TypeID: 1, Category: "Physical Attack", EnergyCost: 1, Power: growthFloat(60)}},
		Monsters:  []canonicalcatalog.Monster{{ID: 1000, Name: "测试原生持有者", DexNumber: 1000, TypeIDs: []int{1}, TraitID: rule.id, Stats: canonicalcatalog.Stats{HP: 80, PhyAtk: 80, PhyDef: 80, MagAtk: 80, MagDef: 80, Speed: 80}, Form: "default", FormCategory: "无多形态", EvolutionStage: "高级形态", EvolutionMembers: []int{1000}}},
		Learnsets: []canonicalcatalog.Learnset{{MonsterID: 1000, Mode: "own", Skills: []canonicalcatalog.LearnedSkill{}}},
	}
	data, err := canonicalcatalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	r := growthRecord("small-catalog", 1000)
	r.Events = []BattleEvent{growthEvent("actual", "me", "a", rule.id, 0, 2, "total", true)}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1000)
	if row.Trait == nil {
		t.Fatal("aggregation incorrectly required all22 catalog traits or hard-coded original owners")
	}
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 2, 1, 0)
	c.Traits[0].ID = "trait-lookalike"
	c.Monsters[0].TraitID = "trait-lookalike"
	data, err = canonicalcatalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1000)
	if row.Trait != nil {
		t.Fatal("name alone became a stable selected identity")
	}
	c.Traits[0].ID = rule.id
	c.Monsters[0].TraitID = rule.id
	c.Traits[0].Name = "改名爆燃"
	data, err = canonicalcatalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	row = growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 1000)
	if row.Trait != nil {
		t.Fatal("trait was silently auto-renamed")
	}
}
