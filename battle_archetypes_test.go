package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func archetypeRecord(id string, own, enemy []int) BattleRecord {
	r := BattleRecord{Version: 1, ID: id, Mode: "pvp", Outcome: "win",
		Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{}},
		Sides:   map[string]BattleSide{}, Events: []BattleEvent{}, Issues: []string{}}
	for side, ids := range map[string][]int{"me": own, "enemy": enemy} {
		s := BattleSide{Pets: []BattlePet{}}
		for i, id := range ids {
			s.Pets = append(s.Pets, BattlePet{InstanceID: side + strconv.Itoa(i), MonsterID: id})
		}
		r.Sides[side] = s
	}
	return r
}

func archetypeFloat(v float64) *float64 { return &v }
func archetypeInt(v int) *int           { return &v }
func archetypeLoadout(ids ...int) *BattleInitialSkills {
	return &BattleInitialSkills{SkillIDs: append([]int{}, ids...), Complete: true}
}
func archetypeHP(p *BattlePet, iv, nature float64) {
	p.IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(iv), Certainty: "direct"}}
	p.Nature = map[string]BattleEvidence{"hp": {Value: archetypeFloat(nature), Certainty: "unique"}}
}
func archetypeEncode(t *testing.T, v any) []byte {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func archetypeValid(t *testing.T, r BattleRecord) {
	t.Helper()
	clone, err := battleClone(r)
	if err == nil {
		err = ValidateBattleRecord(&clone)
	}
	if err != nil {
		t.Fatalf("invalid test fixture %q: %v", r.ID, err)
	}
}
func archetypeTeam(t *testing.T, stats *BattleArchetypeStats, id string) BattleArchetypeTeam {
	t.Helper()
	for _, team := range stats.Teams {
		if team.ID == id {
			return team
		}
	}
	t.Fatalf("missing team %q: %+v", id, stats)
	return BattleArchetypeTeam{}
}
func archetypeComponent(t *testing.T, team BattleArchetypeTeam, id int) BattleArchetypeComponent {
	t.Helper()
	for _, c := range team.Components {
		if c.MonsterID == id {
			return c
		}
	}
	t.Fatalf("missing component %d in %q: %+v", id, team.ID, team.Components)
	return BattleArchetypeComponent{}
}
func archetypeRate(t *testing.T, value *float64, want float64) {
	t.Helper()
	if value == nil || *value != want {
		t.Fatalf("rate/mean = %v; want %v", value, want)
	}
}

func TestBattleArchetypesAssignmentPriorityExclusionsAndOther(t *testing.T) {
	rules := []BattleTeamRule{
		{ID: "first", Name: "First", MonsterIDs: []int{2, 3}, ExcludedMonsterIDs: []int{8, 9}},
		{ID: "second", Name: "Second", MonsterIDs: []int{2}},
	}
	cases := []struct {
		ids  []int
		want string
	}{
		{[]int{2, 3, 4}, "first"},
		{[]int{2, 4}, "second"}, // ALL core IDs, not any core ID.
		{[]int{2, 3, 8}, "second"},
		{[]int{2, 3, 9}, "second"}, // ANY exclusion, not all exclusions.
		{[]int{7}, battleOtherArchetypeID},
	}
	for i, tc := range cases {
		r := archetypeRecord(strconv.Itoa(i), []int{1}, tc.ids)
		id, eligible := battleAssignedArchetype(r, rules)
		if !eligible || id != tc.want {
			t.Fatalf("assignment %v: %q/%v, want %q", tc.ids, id, eligible, tc.want)
		}
	}
	r := archetypeRecord("overlap", []int{1}, []int{2, 3})
	id, ok := battleAssignedArchetype(r, []BattleTeamRule{rules[1], rules[0]})
	if !ok || id != "second" {
		t.Fatal("first array match is not authoritative", id, ok)
	}
	if id, ok := battleAssignedArchetype(r, nil); !ok || id != battleOtherArchetypeID {
		t.Fatal("no rules must mean other, not a generated preset")
	}
	if id, ok := battleAssignedArchetype(r, []BattleTeamRule{{ID: "unnamed", MonsterIDs: []int{2}}}); !ok || id != "unnamed" {
		t.Fatal("display name changed pure classification", id, ok)
	}
}

func TestBattleArchetypesRejectPartialUnknownAndEmptyRosters(t *testing.T) {
	rules := []BattleTeamRule{{ID: "type", Name: "Type", MonsterIDs: []int{2}}}
	partial := archetypeRecord("partial", []int{1}, []int{2, 3})
	partial.Quality.Roster["enemy"] = false
	unmapped := archetypeRecord("unmapped", []int{1}, []int{2, 0})
	empty := archetypeRecord("empty", []int{1}, nil)
	missing := BattleRecord{ID: "missing"}
	for _, r := range []BattleRecord{partial, unmapped, empty, missing} {
		if id, eligible := battleAssignedArchetype(r, rules); eligible || id != "" {
			t.Fatalf("ineligible roster was assigned: %q/%v", id, eligible)
		}
	}
	known := archetypeRecord("known", []int{1}, []int{2, 3})
	known.Outcome = "" // Unknown result still an eligible complete enemy sample.
	stats := BuildBattleArchetypeStats([]BattleRecord{partial, unmapped, empty, missing, known}, rules)
	if stats.Samples != 1 || stats.UnknownBattles != 4 {
		t.Fatalf("sample eligibility: %+v", stats)
	}
	team := archetypeTeam(t, stats, "type")
	if team.Unknown != 1 || team.Losses != 0 || team.KnownOutcomes != 0 || team.WinRate != nil {
		t.Fatalf("unknown outcome became loss: %+v", team)
	}
	archetypeRate(t, stats.Environment[0].Rate, 1)
}

func TestBattleArchetypesEnvironmentMultiLabelAndKnownOutcomeMeans(t *testing.T) {
	rules := []BattleTeamRule{
		{ID: "first", Name: "First", MonsterIDs: []int{2}},
		{ID: "overlap", Name: "Overlap", MonsterIDs: []int{2, 3}},
	}
	win := archetypeRecord("win", []int{1}, []int{2, 3})
	win.Rounds, win.DurationSeconds = 5, archetypeInt(0)
	loss := archetypeRecord("loss", []int{1}, []int{2, 3})
	loss.Outcome, loss.Rounds = "loss", 9
	loss.StartedAt, loss.EndedAt = "2026-11-01T10:00:00Z", "2026-11-01T10:00:12Z"
	draw := archetypeRecord("draw", []int{1}, []int{2})
	draw.Outcome = "draw"
	unknown := archetypeRecord("unknown", []int{1}, []int{2})
	unknown.Outcome = "unknown"
	other := archetypeRecord("other", []int{1}, []int{9})
	stats := BuildBattleArchetypeStats([]BattleRecord{win, loss, draw, unknown, other}, rules)
	team := archetypeTeam(t, stats, "first")
	if team.Battles != 4 || team.Wins != 1 || team.Losses != 1 || team.Draws != 1 || team.Unknown != 1 || team.KnownOutcomes != 3 {
		t.Fatalf("ME outcome summaries: %+v", team)
	}
	archetypeRate(t, team.WinRate, 1.0/3)
	archetypeRate(t, team.AverageRounds, 7)
	archetypeRate(t, team.AverageDurationSeconds, 6)
	if team.RoundSamples != 2 || team.DurationSamples != 2 {
		t.Fatalf("means denominators: %+v", team)
	}
	overlap := archetypeTeam(t, stats, "overlap")
	if overlap.Battles != 2 || len(overlap.Components) != 2 || len(overlap.Teammates) != 0 {
		t.Fatalf("overlapping rule lost data: %+v", overlap)
	}
	archetypeRate(t, overlap.WinRate, .5)
	archetypeRate(t, overlap.AverageRounds, 7)
	archetypeRate(t, overlap.AverageDurationSeconds, 6)
	if len(stats.Environment) != 3 || stats.Environment[2].ID != battleOtherArchetypeID || !stats.Environment[2].Other {
		t.Fatalf("other-last environment: %+v", stats.Environment)
	}
	sum, battles := 0.0, 0
	for _, row := range stats.Environment {
		if row.Samples != 5 || row.Rate == nil {
			t.Fatal("different environment population", row)
		}
		sum += *row.Rate
		battles += row.Battles
	}
	if sum < 1.399999999 || sum > 1.400000001 || battles != 7 || stats.Samples != 5 || !stats.MultiLabel || stats.AssignmentCount != 7 {
		t.Fatal("multi-label/global sample dedup mismatch", sum, battles, stats.Samples, stats.AssignmentCount)
	}
}

func TestBattleArchetypesOwnMatchupsExactMultisetAndNoBleed(t *testing.T) {
	rules := []BattleTeamRule{{ID: "type", Name: "Type", MonsterIDs: []int{2}}}
	a := archetypeRecord("a", []int{5, 1, 1}, []int{2})
	b := archetypeRecord("b", []int{1, 5, 1}, []int{2})
	b.Outcome = "loss"
	c := archetypeRecord("c", []int{1, 5}, []int{2})
	c.Outcome = "loss"
	d := archetypeRecord("d", []int{1, 1, 5}, []int{8})
	partialOwn := archetypeRecord("partial-own", []int{1, 1, 5}, []int{2})
	partialOwn.Quality.Roster["me"] = false
	unknownOwn := archetypeRecord("unknown-own", []int{1, 0}, []int{2})
	partialEnemy := archetypeRecord("partial-enemy", []int{1, 1, 5}, []int{2})
	partialEnemy.Quality.Roster["enemy"] = false
	stats := BuildBattleArchetypeStats([]BattleRecord{a, b, c, d, partialOwn, unknownOwn, partialEnemy}, rules)
	if stats.Samples != 6 || stats.UnknownBattles != 1 || len(stats.OwnMatchups) != 2 {
		t.Fatalf("own eligibility: %+v", stats)
	}
	g := stats.OwnMatchups[0]
	if g.Key != "1,1,5" || !reflect.DeepEqual(g.MonsterIDs, []int{1, 1, 5}) || g.Battles != 3 || len(g.Teams) != 2 || g.Teams[0].Battles != 2 || g.Teams[1].ID != battleOtherArchetypeID {
		t.Fatalf("multiset grouping: %+v", g)
	}
	archetypeRate(t, g.Teams[0].WinRate, .5)
	archetypeRate(t, g.Teams[1].WinRate, 1)
	otherOwn := stats.OwnMatchups[1]
	if otherOwn.Key != "1,5" || otherOwn.Battles != 1 || len(otherOwn.Teams) != 1 {
		t.Fatalf("multiplicity lost: %+v", otherOwn)
	}
	archetypeRate(t, otherOwn.Teams[0].WinRate, 0)
	if archetypeTeam(t, stats, "type").Battles != 5 {
		t.Fatal("incomplete own roster incorrectly removed enemy sample")
	}
}

func TestBattleArchetypesComponentsScopedToAssignedTypeAndTeammatesDedup(t *testing.T) {
	rules := []BattleTeamRule{
		{ID: "a", Name: "A", MonsterIDs: []int{2}},
		{ID: "b", Name: "B", MonsterIDs: []int{3}},
	}
	a := archetypeRecord("a", []int{1}, []int{2, 7, 7, 8, 9})
	for i := range a.Sides["enemy"].Pets {
		p := &a.Sides["enemy"].Pets[i]
		p.InitialSkills = archetypeLoadout(10)
		archetypeHP(p, 60, 1)
	}
	a2 := archetypeRecord("a2", []int{1}, []int{2, 7, 8})
	for i := range a2.Sides["enemy"].Pets {
		p := &a2.Sides["enemy"].Pets[i]
		p.InitialSkills = archetypeLoadout(10)
		archetypeHP(p, 60, 1)
	}
	b := archetypeRecord("b", []int{1}, []int{3, 7})
	for i := range b.Sides["enemy"].Pets {
		p := &b.Sides["enemy"].Pets[i]
		p.InitialSkills = archetypeLoadout(20)
		archetypeHP(p, 54, 0)
	}
	// Explicit observations are independent of initial loadout snapshots. Two
	// instances of species 7 contribute their actual casts, not two carry samples.
	a.Events = []BattleEvent{
		{ID: "a-first", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 10, Seq: 1},
		{ID: "a-twin", Side: "enemy", Actor: "enemy2", Kind: "skill", Phase: "executed", SkillID: 10, Seq: 2},
		{ID: "a-repeat", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 10, Seq: 3},
		{ID: "a-acquired", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 11, Seq: 4},
	}
	a2.Events = []BattleEvent{{ID: "a2-cast", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 10, Seq: 1}}
	b.Events = []BattleEvent{
		{ID: "b-first", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 20, Seq: 1},
		{ID: "b-repeat", Side: "enemy", Actor: "enemy1", Kind: "skill", Phase: "executed", SkillID: 20, Seq: 2},
	}
	for _, r := range []BattleRecord{a, a2, b} {
		archetypeValid(t, r)
	}
	stats := BuildBattleArchetypeStats([]BattleRecord{a, a2, b}, rules)
	teamA := archetypeTeam(t, stats, "a")
	if len(teamA.Teammates) != 3 || teamA.Teammates[0].MonsterID != 7 || teamA.Teammates[1].MonsterID != 8 || teamA.Teammates[2].MonsterID != 9 {
		t.Fatalf("core exclusion and sorted teammates: %+v", teamA.Teammates)
	}
	if teamA.Teammates[0].Carried != 2 || teamA.Teammates[0].Samples != 2 {
		t.Fatal("same-species instances double counted", teamA.Teammates)
	}
	archetypeRate(t, teamA.Teammates[2].Rate, .5)
	ca, cb := archetypeComponent(t, teamA, 7), archetypeComponent(t, archetypeTeam(t, stats, "b"), 7)
	if ca.Profile.IVSamples["hp"] != 2 || ca.Profile.IVDistributions["hp"]["60"] != 2 || ca.Profile.IVDistributions["hp"]["54"] != 0 || cb.Profile.IVDistributions["hp"]["54"] != 1 {
		t.Fatalf("shared species profile bled across types: %+v / %+v", ca.Profile, cb.Profile)
	}
	wantA := []BattleSelfSkillStats{
		{MonsterID: 7, SkillID: 10, Casts: 4, TotalCasts: 5, UsedBattles: 2, Samples: 2},
		{MonsterID: 7, SkillID: 11, Casts: 1, TotalCasts: 5, UsedBattles: 1, Samples: 2},
	}
	wantB := []BattleSelfSkillStats{{MonsterID: 7, SkillID: 20, Casts: 2, TotalCasts: 2, UsedBattles: 1, Samples: 1}}
	if ca.UsageTotalCasts != 5 || cb.UsageTotalCasts != 2 || !reflect.DeepEqual(ca.SkillUsage, wantA) || !reflect.DeepEqual(cb.SkillUsage, wantB) {
		t.Fatalf("shared species executed usage bled across types or used carry denominator: %+v / %+v", ca, cb)
	}
	if ca.Profile.NatureSamples["hp"] != 2 || ca.Profile.NatureDistributions["hp"]["1"] != 2 || cb.Profile.NatureDistributions["hp"]["0"] != 1 {
		t.Fatalf("per-stat nature evidence lost scope: %+v / %+v", ca.Profile, cb.Profile)
	}
	if len(ca.LifeProfiles) != 0 || len(cb.LifeProfiles) != 0 || len(ca.Skills) != 0 || len(cb.Skills) != 0 {
		t.Fatal("deprecated joint-life/carry summaries were recomputed")
	}
}

func TestBattleArchetypesExecutedUsageIncludesExchangeAndPartialObservationsNotCarry(t *testing.T) {
	known := archetypeRecord("known", []int{1}, []int{7, 7})
	known.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout(10, 20)
	known.Sides["enemy"].Pets[1].InitialSkills = archetypeLoadout(20, 30)
	known.Quality.Actions = true
	known.Events = []BattleEvent{
		{ID: "used-after-exchange", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 99, Seq: 1},
		{ID: "repeat", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 99, Seq: 2},
	}
	absent := archetypeRecord("absent", []int{1}, []int{7})
	absent.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout(20)
	empty := archetypeRecord("confirmed-empty", []int{1}, []int{7})
	empty.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout()
	unknown := archetypeRecord("unknown", []int{1}, []int{7})
	unknown.Events = []BattleEvent{{ID: "usage-is-not-carry", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 88}}
	partial := archetypeRecord("partial", []int{1}, []int{7})
	partial.Sides["enemy"].Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{77}, Complete: false}
	oneMissing := archetypeRecord("one-missing-instance", []int{1}, []int{7, 7})
	oneMissing.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout(55)
	records := []BattleRecord{known, absent, empty, unknown, partial, oneMissing}
	for _, r := range records {
		archetypeValid(t, r)
	}
	c := archetypeComponent(t, archetypeTeam(t, BuildBattleArchetypeStats(records, nil), battleOtherArchetypeID), 7)
	want := []BattleSelfSkillStats{
		{MonsterID: 7, SkillID: 88, Casts: 1, TotalCasts: 3, UsedBattles: 1, Samples: 2},
		{MonsterID: 7, SkillID: 99, Casts: 2, TotalCasts: 3, UsedBattles: 1, Samples: 2},
	}
	if c.Carried != 6 || c.UsageTotalCasts != 3 || !reflect.DeepEqual(c.SkillUsage, want) {
		t.Fatalf("usage must count recorded executions (including partial capture), not initial skills or carried battles: %+v", c)
	}
	if c.SkillSamples != 0 || c.SkillUnknown != 0 || len(c.Skills) != 0 {
		t.Fatal("deprecated carrying projection still populated")
	}
	for _, skill := range c.SkillUsage {
		if skill.SkillID == 10 || skill.SkillID == 20 || skill.SkillID == 30 || skill.SkillID == 77 || skill.SkillID == 55 {
			t.Fatal("initial slot declaration fabricated an executed cast", skill)
		}
	}
	if len(c.Profile.Skills) != 1 || c.Profile.Skills[0].SkillID != 99 {
		t.Fatal("legacy complete-capture compatibility profile changed; new usage must remain independently observed", c.Profile.Skills)
	}
}

func TestBattleArchetypesMarginalProfilesRetainEvidenceWithoutInventingJointLife(t *testing.T) {
	a := archetypeRecord("iv-only-positive", []int{1}, []int{7})
	archetypeHP(&a.Sides["enemy"].Pets[0], 60, 0)
	b := archetypeRecord("nature-only-positive", []int{1}, []int{7})
	archetypeHP(&b.Sides["enemy"].Pets[0], 0, 1)
	c := archetypeRecord("double-life", []int{1}, []int{7, 7})
	for i := range c.Sides["enemy"].Pets {
		archetypeHP(&c.Sides["enemy"].Pets[i], 60, 1)
	}
	conflict := archetypeRecord("conflict-instances", []int{1}, []int{7, 7})
	archetypeHP(&conflict.Sides["enemy"].Pets[0], 60, 1)
	archetypeHP(&conflict.Sides["enemy"].Pets[1], 54, 1)
	split := archetypeRecord("split-instances", []int{1}, []int{7, 7})
	split.Sides["enemy"].Pets[0].IV = map[string]BattleEvidence{"hp": {Value: archetypeFloat(60), Certainty: "direct"}}
	split.Sides["enemy"].Pets[1].Nature = map[string]BattleEvidence{"hp": {Value: archetypeFloat(1), Certainty: "direct"}}
	candidate := archetypeRecord("candidate", []int{1}, []int{7})
	archetypeHP(&candidate.Sides["enemy"].Pets[0], 60, 1)
	candidate.Sides["enemy"].Pets[0].IV["hp"] = BattleEvidence{Certainty: "candidate", Candidates: []float64{54, 60}}
	missing := archetypeRecord("missing", []int{1}, []int{7})
	records := []BattleRecord{a, b, c, conflict, split, candidate, missing}
	for _, r := range records {
		archetypeValid(t, r)
	}
	before := archetypeEncode(t, records)
	component := archetypeComponent(t, archetypeTeam(t, BuildBattleArchetypeStats(records, nil), battleOtherArchetypeID), 7)
	profile := component.Profile
	if profile.ProfileSamples != 7 || profile.IVSamples["hp"] != 3 || !reflect.DeepEqual(profile.IVDistributions["hp"], map[string]int{"60": 2, "0": 1}) {
		t.Fatalf("IV conflict/split/candidate evidence was collapsed or repeated instances counted twice: %+v", profile)
	}
	if profile.NatureSamples["hp"] != 5 || !reflect.DeepEqual(profile.NatureDistributions["hp"], map[string]int{"0": 1, "1": 4}) {
		t.Fatalf("independent per-stat nature evidence lost: %+v", profile)
	}
	if component.LifeProfileSamples != 0 || component.LifeProfileUnknown != 0 || len(component.LifeProfiles) != 0 {
		t.Fatal("marginal evidence was recombined into a fabricated joint-life statistic")
	}
	if component.UsageTotalCasts != 0 || len(component.SkillUsage) != 0 {
		t.Fatal("profile evidence created casts")
	}
	if !bytes.Equal(before, archetypeEncode(t, records)) {
		t.Fatal("candidate/direct evidence mutated by projection")
	}
}

func TestBattleArchetypesFormsDoNotReplaceInitialSpecies(t *testing.T) {
	r := archetypeRecord("forms", []int{5}, []int{2, 7})
	r.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout(10)
	r.Events = []BattleEvent{
		{ID: "enemy-form", Seq: 1, Side: "enemy", Actor: "enemy0", Kind: "form", Phase: "executed", Form: &BattleFormChange{FromBaseID: "2", ToBaseID: "9", FromMonsterID: 2, ToMonsterID: 9}},
		{ID: "own-form", Seq: 2, Side: "me", Actor: "me0", Kind: "form", Phase: "executed", Form: &BattleFormChange{FromBaseID: "5", ToBaseID: "6", FromMonsterID: 5, ToMonsterID: 6}},
		{ID: "after-form-skill", Seq: 3, Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 11},
	}
	archetypeValid(t, r)
	rules := []BattleTeamRule{{ID: "initial", Name: "Initial", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{9}}, {ID: "form", Name: "Form", MonsterIDs: []int{9}}}
	stats := BuildBattleArchetypeStats([]BattleRecord{r}, rules)
	team := archetypeTeam(t, stats, "initial")
	if team.Battles != 1 || len(team.Components) != 2 || team.Components[0].MonsterID != 2 || stats.OwnMatchups[0].Key != "5" || archetypeTeam(t, stats, "form").Battles != 0 {
		t.Fatalf("later forms changed roster categories: %+v", stats)
	}
	component := archetypeComponent(t, team, 2)
	if component.UsageTotalCasts != 1 || len(component.SkillUsage) != 1 || component.SkillUsage[0].SkillID != 11 || component.SkillUsage[0].MonsterID != 2 {
		t.Fatal("same-instance later-form cast reassigned identity or inferred initial skill", component)
	}
}

func TestBattleArchetypesDuplicateFragmentsConflictsAndImmutability(t *testing.T) {
	full := archetypeRecord("merge", []int{1}, []int{7, 2})
	full.Sides["enemy"].Pets[0].InitialSkills = archetypeLoadout(20, 10)
	full.Rounds = 5
	partial := archetypeRecord("merge", []int{1}, []int{7})
	partial.Quality.Roster["enemy"] = false
	partial.Outcome = "unknown"
	sharedCast := BattleEvent{ID: "shared-cast", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 20, Seq: 1}
	full.Events = []BattleEvent{sharedCast, {ID: "full-cast", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 99, Seq: 2}}
	partial.Events = []BattleEvent{sharedCast, {ID: "partial-cast", Side: "enemy", Actor: "enemy0", Kind: "skill", Phase: "executed", SkillID: 30, Seq: 3}}
	conflict := archetypeRecord("bad-conflict", []int{1}, []int{7})
	conflicting := archetypeRecord("bad-conflict", []int{1}, []int{7})
	conflicting.Outcome = "loss"
	invalid := archetypeRecord("bad-invalid", []int{1}, []int{7})
	invalid.Rounds = -1
	invalidDuplicate := archetypeRecord("bad-invalid", []int{1}, []int{7})
	rules := []BattleTeamRule{{ID: "type", Name: " Type ", MonsterIDs: []int{7, 7}, ExcludedMonsterIDs: []int{8, 8}}}
	records := []BattleRecord{full, full, partial, conflict, conflicting, invalid, invalidDuplicate}
	before, ruleBefore := archetypeEncode(t, records), archetypeEncode(t, rules)
	stats := BuildBattleArchetypeStats(records, rules)
	if stats.Samples != 1 || stats.UnknownBattles != 2 || archetypeTeam(t, stats, "type").Battles != 1 {
		t.Fatalf("repeated records/fragments or rejected IDs counted: %+v", stats)
	}
	c := archetypeComponent(t, archetypeTeam(t, stats, "type"), 7)
	wantUsage := []BattleSelfSkillStats{
		{MonsterID: 7, SkillID: 20, Casts: 1, TotalCasts: 3, UsedBattles: 1, Samples: 1},
		{MonsterID: 7, SkillID: 30, Casts: 1, TotalCasts: 3, UsedBattles: 1, Samples: 1},
		{MonsterID: 7, SkillID: 99, Casts: 1, TotalCasts: 3, UsedBattles: 1, Samples: 1},
	}
	if c.Carried != 1 || c.UsageTotalCasts != 3 || !reflect.DeepEqual(c.SkillUsage, wantUsage) {
		t.Fatalf("fragments duplicated recorded casts/samples or omitted partial observations: %+v", c)
	}
	if !bytes.Equal(before, archetypeEncode(t, records)) || !bytes.Equal(ruleBefore, archetypeEncode(t, rules)) {
		t.Fatal("builder mutated input records/rules")
	}
	reversed := append([]BattleRecord{}, records...)
	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	if !bytes.Equal(archetypeEncode(t, stats), archetypeEncode(t, BuildBattleArchetypeStats(reversed, rules))) {
		t.Fatal("record order changed canonical summaries")
	}
	stats.Teams[0].MonsterIDs[0] = 999
	stats.Teams[0].ExcludedMonsterIDs[0] = 999
	stats.Teams[0].Components[0].Profile.IVSamples["hp"] = 999
	if !bytes.Equal(before, archetypeEncode(t, records)) || !bytes.Equal(ruleBefore, archetypeEncode(t, rules)) {
		t.Fatal("output aliases caller-owned records/rules")
	}
}

func TestBattleArchetypesNoRulesSixEnemyAndMissingFieldsJSON(t *testing.T) {
	r := archetypeRecord("six-initial-enemies", []int{1}, []int{2, 3, 4, 5, 6, 7})
	r.Outcome = "unknown"
	stats := BuildBattleArchetypeStats([]BattleRecord{r}, nil)
	if stats.Samples != 1 || len(stats.Teams) != 1 || !stats.Teams[0].Other || stats.Teams[0].Battles != 1 || len(stats.Teams[0].Components) != 6 {
		t.Fatalf("no-rules fallback should only classify as other: %+v", stats)
	}
	for _, component := range stats.Teams[0].Components {
		if component.UsageTotalCasts != 0 || component.SkillUsage == nil || len(component.SkillUsage) != 0 || len(component.Profile.IVSamples) != 0 || len(component.Profile.NatureSamples) != 0 {
			t.Fatalf("missing observations/profile manufactured values: %+v", component)
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal(archetypeEncode(t, component), &wire); err != nil {
			t.Fatal(err)
		}
		for _, deprecated := range []string{"skills", "skillSamples", "skillUnknown", "lifeProfiles", "lifeProfileSamples", "lifeProfileUnknown"} {
			if _, exists := wire[deprecated]; exists {
				t.Fatal("deprecated carry/jointlife field still emitted", deprecated)
			}
		}
	}
	jsonText := string(archetypeEncode(t, stats))
	for _, expected := range []string{`"skillUsage":[]`, `"usageTotalCasts":0`, `"averageRounds":null`, `"averageDurationSeconds":null`, `"winRate":null`, `"excludedMonsterIds":[]`} {
		if !strings.Contains(jsonText, expected) {
			t.Fatalf("missing stable empty/nullable JSON %s: %s", expected, jsonText)
		}
	}
	empty := BuildBattleArchetypeStats(nil, []BattleTeamRule{{ID: "empty", Name: "Empty", MonsterIDs: []int{2}}})
	if empty.Samples != 0 || empty.UnknownBattles != 0 || len(empty.Teams) != 2 || len(empty.OwnMatchups) != 0 {
		t.Fatalf("empty input: %+v", empty)
	}
	for _, row := range empty.Environment {
		if row.Rate != nil || row.Battles != 0 || row.Samples != 0 {
			t.Fatal("zero denominator manufactured pie", row)
		}
	}
	if !strings.Contains(string(archetypeEncode(t, empty)), `"ownMatchups":[]`) {
		t.Fatal("empty ownMatchups must be an array")
	}
}

func TestBattleArchetypesMalformedRulesCannotHijackOther(t *testing.T) {
	rules := []BattleTeamRule{
		{ID: battleOtherArchetypeID, Name: "Hijack", MonsterIDs: []int{2}},
		{ID: "empty", Name: "Empty", MonsterIDs: []int{}},
		{ID: "bad", Name: "Bad", MonsterIDs: []int{0}},
		{ID: "both", Name: "Contradictory", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{2}},
		{ID: "valid", Name: "First", MonsterIDs: []int{3}},
		{ID: "valid", Name: "Duplicate", MonsterIDs: []int{2}},
	}
	r := archetypeRecord("other", []int{1}, []int{2})
	id, eligible := battleAssignedArchetype(r, rules)
	if !eligible || id != battleOtherArchetypeID {
		t.Fatal("malformed rules changed assignment", id, eligible)
	}
	stats := BuildBattleArchetypeStats([]BattleRecord{r}, rules)
	if len(stats.Teams) != 2 || stats.Teams[0].ID != "valid" || stats.Teams[1].Name != "其他" || !stats.Teams[1].Other {
		t.Fatalf("malformed/reserved rules retained: %+v", stats.Teams)
	}
}

func TestBattleArchetypesSharedFilterUsesAllMemberships(t *testing.T) {
	rules := []BattleTeamRule{{ID: "first", Name: "First", MonsterIDs: []int{2}}, {ID: "second", Name: "Second", MonsterIDs: []int{2, 3}}}
	r := archetypeRecord("both", []int{1}, []int{2, 3})
	if !MatchBattleRecord(r, BattleFilter{TeamRuleID: "first"}, rules) || !MatchBattleRecord(r, BattleFilter{TeamRuleID: "second"}, rules) {
		t.Fatal("team rule filter did not use all matching memberships")
	}
	other := archetypeRecord("other", []int{1}, []int{9})
	if !MatchBattleRecord(other, BattleFilter{TeamRuleID: battleOtherArchetypeID}, rules) {
		t.Fatal("other filter missing")
	}
	partial := archetypeRecord("partial", []int{1}, []int{2})
	partial.Quality.Roster["enemy"] = false
	if MatchBattleRecord(partial, BattleFilter{TeamRuleID: "first"}, rules) || MatchBattleRecord(partial, BattleFilter{TeamRuleID: battleOtherArchetypeID}, rules) {
		t.Fatal("unknown enemy got a team filter assignment")
	}
	// The builder must honor caller-provided filtered input; it cannot fetch
	// excluded records or calculate components from some global population.
	stats := BuildBattleArchetypeStats([]BattleRecord{other}, rules)
	if stats.Samples != 1 || archetypeTeam(t, stats, "first").Battles != 0 || archetypeTeam(t, stats, battleOtherArchetypeID).Battles != 1 {
		t.Fatal("builder widened filtered cohort")
	}
}
