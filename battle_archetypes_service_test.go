package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestArchetypeRulesCASOrderExclusionAndHTTP(t *testing.T) {
	s, mux := backendMux(t)
	ctx := context.Background()
	get := backendRequest(mux, "GET", "/api/battles/rules", "")
	var initial struct {
		Rules    []BattleTeamRule `json:"rules"`
		Revision string           `json:"revision"`
	}
	if get.Code != 200 || json.Unmarshal(get.Body.Bytes(), &initial) != nil || len(initial.Revision) != 64 {
		t.Fatal(get.Body.String())
	}
	rules := []BattleTeamRule{{ID: "snow", Name: "雪天", MonsterIDs: []int{2, 3}}, {ID: "balance", Name: "平衡", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{3}}}
	raw, _ := json.Marshal(map[string]any{"rules": rules, "baseRevision": initial.Revision})
	put := backendRequest(mux, "PUT", "/api/battles/rules", string(raw))
	if put.Code != 200 {
		t.Fatal(put.Body.String())
	}
	var saved struct {
		Rules    []BattleTeamRule `json:"rules"`
		Revision string           `json:"revision"`
	}
	if json.Unmarshal(put.Body.Bytes(), &saved) != nil {
		t.Fatal("decode")
	}
	if cbJSON(saved.Rules) != cbJSON(rules) || saved.Revision == initial.Revision {
		t.Fatal("order/exclusion/revision lost")
	}
	stale := backendRequest(mux, "PUT", "/api/battles/rules", string(raw))
	if stale.Code != 409 {
		t.Fatal(stale.Code, stale.Body.String())
	}
	for _, unversioned := range []string{`{"rules":[]}`, `{"rules":[],"baseRevision":null}`, `{"rules":[],"baseRevision":""}`} {
		if w := backendRequest(mux, "PUT", "/api/battles/rules", unversioned); w.Code != 400 {
			t.Fatal("unversioned replacement bypassed CAS", w.Code, w.Body.String())
		}
	}
	after, readErr := s.Rules(ctx)
	if readErr != nil || cbJSON(after) != cbJSON(saved.Rules) || battleRulesRevision(after) != saved.Revision {
		t.Fatal("stale/unversioned requests altered committed public rules or revision", readErr)
	}
	loadedRules, loadedRevision := backendLoadedRules(t, mux)
	if cbJSON(loadedRules) != cbJSON(saved.Rules) || loadedRevision != saved.Revision {
		t.Fatal("HTTP reload changed saved rule DTO or revision")
	}
	reordered := []BattleTeamRule{rules[1], rules[0]}
	latest, e := s.PutRules(ctx, reordered, loadedRevision)
	if e != nil || latest[0].ID != "balance" {
		t.Fatal("reorder", e)
	}
	stored, e := s.Rules(ctx)
	if e != nil || stored[0].ID != "balance" || len(stored[0].ExcludedMonsterIDs) != 1 {
		t.Fatal("stored order lost", e)
	}
	for _, bad := range []BattleTeamRule{{ID: "__other__", Name: "reserved", MonsterIDs: []int{2}}, {ID: "bad", Name: "conflict", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{2}}, {ID: "bad", Name: "negative", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{-1}}} {
		if _, e = s.PutRules(ctx, []BattleTeamRule{bad}); !errors.Is(e, errBattleInvalid) {
			t.Fatal("accepted invalid rule", e)
		}
	}
	preserved, readErr := s.Rules(ctx)
	if readErr != nil || cbJSON(stored) != cbJSON(preserved) || battleRulesRevision(stored) != battleRulesRevision(preserved) {
		t.Fatal("invalid input changed committed public rules or revision", readErr)
	}
	r := domainFixture("order-match")
	_, e = s.Import(ctx, []BattleRecord{r})
	if e != nil {
		t.Fatal(e)
	}
	stats, e := s.Stats(ctx, BattleFilter{TeamRuleID: "snow"})
	if e != nil || stats.MatchedBattles != 1 {
		t.Fatal("exclusion/assignment filter", e)
	}
	stats, e = s.Stats(ctx, BattleFilter{TeamRuleID: "balance"})
	if e != nil || stats.MatchedBattles != 0 {
		t.Fatal("negative rule did not exclude", e)
	}
	generic := []BattleTeamRule{{ID: "first", Name: "first", MonsterIDs: []int{2}}, {ID: "second", Name: "second", MonsterIDs: []int{2, 3}}}
	if _, e = s.PutRules(ctx, generic); e != nil {
		t.Fatal(e)
	}
	stats, e = s.Stats(ctx, BattleFilter{TeamRuleID: "second"})
	if e != nil || stats.MatchedBattles != 1 {
		t.Fatal("overlapping membership missing", e)
	}
	stats, e = s.Stats(ctx, BattleFilter{TeamRuleID: "first"})
	if e != nil || stats.Archetypes.Samples != 1 {
		t.Fatal("first missing", e)
	}
}
func TestArchetypeInitialLoadoutValidationAndMerge(t *testing.T) {
	r := domainFixture("initial")
	side := r.Sides["enemy"]
	side.Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{10}, Complete: false}
	r.Sides["enemy"] = side
	incoming := domainClone(t, r)
	incoming.Sides["enemy"].Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{20, 10}, Complete: true}
	before := cbJSON(r)
	full := cbJSON(incoming)
	merged, e := MergeBattleRecord(r, incoming)
	if e != nil {
		t.Fatal(e)
	}
	got := merged.Sides["enemy"].Pets[0].InitialSkills
	if !got.Complete || !reflect.DeepEqual(got.SkillIDs, []int{10, 20}) {
		t.Fatal(got)
	}
	if cbJSON(r) != before || cbJSON(incoming) != full {
		t.Fatal("mutated source")
	}
	reversed, e := MergeBattleRecord(incoming, r)
	if e != nil || cbJSON(reversed) != cbJSON(merged) {
		t.Fatal("stale partial erased complete loadout", e)
	}
	conflicting := domainClone(t, incoming)
	conflicting.Sides["enemy"].Pets[0].InitialSkills.SkillIDs = []int{10, 30}
	if _, e = MergeBattleRecord(incoming, conflicting); e == nil {
		t.Fatal("overwrote known initial loadout")
	}
	for _, bad := range []*BattleInitialSkills{{SkillIDs: nil}, {SkillIDs: []int{0}}, {SkillIDs: []int{10, 10}}, {SkillIDs: []int{1, 2, 3, 4, 5}}} {
		x := domainClone(t, r)
		x.Sides["enemy"].Pets[0].InitialSkills = bad
		if ValidateBattleRecord(&x) == nil {
			t.Fatal("accepted invalid loadout", bad)
		}
	}
	clone := domainClone(t, merged)
	clone.Sides["enemy"].Pets[0].InitialSkills.SkillIDs[0] = 99
	if got.SkillIDs[0] != 10 {
		t.Fatal("loadout aliases clone")
	}
	empty := domainClone(t, r)
	empty.Sides["enemy"].Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{}, Complete: true}
	if e = ValidateBattleRecord(&empty); e != nil {
		t.Fatal("explicit empty rejected", e)
	}
}
func TestArchetypesActualServiceBoundary(t *testing.T) {
	dbpath, catpath := os.Getenv("AR_ACTUAL_DATABASE"), os.Getenv("AR_ACTUAL_CATALOG")
	if dbpath == "" || catpath == "" {
		t.Skip("explicit actual frozen fixture")
	}
	dbdata, e := os.ReadFile(dbpath)
	if e != nil {
		t.Fatal(e)
	}
	catalog, e := os.ReadFile(catpath)
	if e != nil {
		t.Fatal(e)
	}
	temp := filepath.Join(t.TempDir(), "battle.sqlite")
	if e = os.WriteFile(temp, dbdata, 0600); e != nil {
		t.Fatal(e)
	}
	s, e := NewBattleService(temp, func() ([]byte, error) { return append([]byte{}, catalog...), nil })
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ctx := context.Background()
	original, e := s.Record(ctx, "rkpp:1876469132858231449")
	if e != nil {
		t.Fatal(e)
	}
	old := cbJSON(original)
	stats, e := s.Stats(ctx, BattleFilter{})
	if e != nil {
		t.Fatal(e)
	}
	effectiveRules, e := s.Rules(ctx)
	if e != nil {
		t.Fatal(e)
	}
	assigned, eligible := battleAssignedArchetype(original, effectiveRules)
	if !eligible || stats.MatchedBattles != 1 || stats.EnemyPerformance == nil || len(stats.EnemyPerformance.Species) != 6 || stats.Archetypes.Samples != 1 || len(stats.Archetypes.Teams) != len(effectiveRules)+1 {
		t.Fatal("real shape or effective default classification")
	}
	team := archetypeTeam(t, stats.Archetypes, assigned)
	if team.Battles != 1 || team.WinRate == nil || *team.WinRate != 0 || len(team.Components) != 6 {
		t.Fatal(team)
	}
	// Count only explicit executed declarations from the frozen record. No
	// initial-loadout requirement and no quality.actions gate on observations.
	initialSpecies := map[string]int{}
	for _, pet := range original.Sides["enemy"].Pets {
		initialSpecies[pet.InstanceID] = pet.MonsterID
	}
	expectedCasts := map[int]int{}
	for _, event := range original.Events {
		if event.Side != "enemy" || event.Phase != "executed" || event.ProtocolSkillID == "700001000" {
			continue
		}
		normal := event.Kind == "skill" && event.SkillID > 0
		wish := event.Combat != nil && event.Combat.ActionKind == "wishImpact" && (event.Kind == "skill" || event.Kind == "effect" && event.SkillClass == "system")
		if species := initialSpecies[event.Actor]; species > 0 && (normal || wish) {
			expectedCasts[species]++
		}
	}
	for _, p := range team.Components {
		if p.SkillSamples != 0 || p.SkillUnknown != 0 || len(p.Skills) != 0 || p.LifeProfileSamples != 0 || len(p.LifeProfiles) != 0 {
			t.Fatal("deprecated carry/joint-life projection recomputed", p)
		}
		sum := 0
		for _, skill := range p.SkillUsage {
			if skill.MonsterID != p.MonsterID || skill.TotalCasts != p.UsageTotalCasts {
				t.Fatal("unscoped usage bucket", skill)
			}
			sum += skill.Casts
		}
		if p.SkillUsage == nil || p.UsageTotalCasts != expectedCasts[p.MonsterID] || sum != p.UsageTotalCasts {
			t.Fatal("recorded enemy skill observations lost/invented", p, expectedCasts)
		}
	}
	for _, p := range stats.EnemyPerformance.Species {
		if p.CarryRate == nil || *p.CarryRate != 1 || p.WinRate == nil || *p.WinRate != 1 || p.Wins != 1 || p.KnownOutcomeBattles != 1 {
			t.Fatal("enemy win/carry", p)
		}
	}
	var outgoing, received int64
	for _, p := range stats.EnemyPerformance.Species {
		outgoing += p.Totals.DamageDealt.Actual
		received += p.Totals.DamageReceived.Actual
	}
	if outgoing != 1728 || received != 1594 {
		t.Fatal("enemy HP projection", outgoing, received)
	}
	if len(stats.Archetypes.OwnMatchups) != 1 || len(stats.Archetypes.OwnMatchups[0].Teams) != 1 || stats.Archetypes.OwnMatchups[0].Teams[0].ID != assigned || stats.Archetypes.OwnMatchups[0].Teams[0].WinRate == nil || *stats.Archetypes.OwnMatchups[0].Teams[0].WinRate != 0 {
		t.Fatal("own matchup scope")
	}
	if out := os.Getenv("AR_ACTUAL_OUTPUT"); out != "" {
		f, err := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.MarshalIndent(stats, "", "  ")
		_, err = f.Write(b)
		ce := f.Close()
		if err != nil || ce != nil {
			t.Fatal(err, ce)
		}
	}
	after, _ := s.Record(ctx, original.ID)
	if cbJSON(after) != old {
		t.Fatal("stats wrote battle")
	}
	for p, b := range map[string][]byte{dbpath: dbdata, catpath: catalog} {
		current, err := os.ReadFile(p)
		if err != nil || !reflect.DeepEqual(current, b) {
			t.Fatal("modified fixture")
		}
	}
}
