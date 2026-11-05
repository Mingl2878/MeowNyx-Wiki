package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestRuleFamilyNormalizationRealExamplesAndStableUnknown(t *testing.T) {
	data := familyRulesCatalog(t)
	input := []BattleTeamRule{
		{ID: "star", Name: "星陨", MonsterIDs: []int{231}, AnyOf: [][]int{{443, 444, 445}}},
		{ID: "required", Name: "保留", MonsterIDs: []int{443, 444, 445, 231}, AnyOf: [][]int{{443, 999001}, {311, 312}, {312, 311}, {111, 109}}, ExcludedMonsterIDs: []int{101, 105, 109}},
		{ID: "kava", Name: "卡瓦", AnyOf: [][]int{{103, 107, 111, 101, 105, 109}, {999123}}},
	}
	before := archetypeEncode(t, input)
	out, err := battlePrepareRuleFamilies(input, data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out[0].MonsterIDs, []int{231, 445}) || len(out[0].AnyOf) != 0 {
		t.Fatal(out[0])
	}
	if !reflect.DeepEqual(out[1].MonsterIDs, []int{445, 231}) || !reflect.DeepEqual(out[1].AnyOf, [][]int{{311, 312}, {111, 109}}) || !reflect.DeepEqual(out[1].ExcludedMonsterIDs, []int{109}) {
		t.Fatal(out[1])
	}
	if !reflect.DeepEqual(out[2].MonsterIDs, []int{999123}) || !reflect.DeepEqual(out[2].AnyOf, [][]int{{111, 109}}) {
		t.Fatal(out[2])
	}
	if string(before) != string(archetypeEncode(t, input)) {
		t.Fatal("source mutation")
	}
	again, err := battlePrepareRuleFamilies(out, data)
	if err != nil || string(archetypeEncode(t, again)) != string(archetypeEncode(t, out)) {
		t.Fatal("not idempotent", err)
	}
	c, err := catalog.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	for i, j := 0, len(c.Monsters)-1; i < j; i, j = i+1, j-1 {
		c.Monsters[i], c.Monsters[j] = c.Monsters[j], c.Monsters[i]
	}
	reverse := battleCompileRuleFamilies(input, c.Monsters)
	if string(archetypeEncode(t, reverse)) != string(archetypeEncode(t, out)) {
		t.Fatal("catalog row order changed representatives")
	}
	for _, id := range []int{103, 107, 111, 101, 105, 109} {
		matches, ok := battleMatchedArchetypes(familyRulesRecord("positive", id, 999123), out)
		if !ok || !battleOneOf("kava", matches...) {
			t.Fatal(id, matches)
		}
	}
	for _, id := range []int{100, 102, 104, 106, 108, 110} {
		matches, _ := battleMatchedArchetypes(familyRulesRecord("negative", id, 999123), out)
		if battleOneOf("kava", matches...) {
			t.Fatal("crossed Kava branch", id)
		}
	}
	duplicate, err := battlePrepareRuleFamilies([]BattleTeamRule{{ID: "duplicate", Name: "重复组合", AnyOf: [][]int{{443, 107}, {111, 445}}}}, data)
	if err != nil || !reflect.DeepEqual(duplicate[0].AnyOf, [][]int{{445, 111}}) {
		t.Fatal("duplicate clause representative", duplicate, err)
	}
	unknown, err := battlePrepareRuleFamilies([]BattleTeamRule{{ID: "unknown", Name: "未确认", AnyOf: [][]int{{999123}}}}, nil)
	if err != nil || !reflect.DeepEqual(unknown[0].MonsterIDs, []int{999123}) || len(unknown[0].AnyOf) != 0 {
		t.Fatal("unknown singleton was lost", unknown, err)
	}
}

func TestRuleFamilyReadViewPreservesSourceCASAndExplicitSave(t *testing.T) {
	ctx := context.Background()
	data := familyRulesCatalog(t)
	s := familyRulesService(t, filepath.Join(t.TempDir(), "rules.sqlite"), func() ([]byte, error) { return data, nil })
	if _, err := s.Rules(ctx); err != nil {
		t.Fatal(err)
	}
	raw := `{"id":"original","name":"保留名字","monsterIds":[231],"anyOf":[[443,444,445]]}`
	if _, err := s.db.Exec(`INSERT INTO battle_rules VALUES('original',0,?)`, raw); err != nil {
		t.Fatal(err)
	}
	read, err := s.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(read[0].MonsterIDs, []int{231, 445}) || len(read[0].AnyOf) != 0 {
		t.Fatal(read)
	}
	sources := battleRuleSourceInputs(read)
	if !reflect.DeepEqual(sources[0].AnyOf, [][]int{{443, 444, 445}}) {
		t.Fatal("original source inputs lost", sources)
	}
	// Reconstruct the pre-cleanup revision using exactly the old public inputs.
	legacy := sources[0]
	legacy.familyMatch = &battleRuleFamilyMatch{revision: read[0].familyMatch.revision}
	revision := battleRulesRevision(read)
	if revision != battleRulesRevision([]BattleTeamRule{legacy}) {
		t.Fatal("read normalization changed original CAS")
	}
	var unchanged string
	if err := s.db.QueryRow(`SELECT rule_json FROM battle_rules WHERE id='original'`).Scan(&unchanged); err != nil || unchanged != raw {
		t.Fatal("GET rewrote saved rules", err, unchanged)
	}
	// Every request owns its rule slices and private matching predicates.
	read[0].familyMatch.required[0][231] = false
	read[0].MonsterIDs[1] = 999001
	sources[0].AnyOf[0][0] = 999002
	fresh, err := s.Rules(ctx)
	if err != nil || fresh[0].MonsterIDs[1] != 445 || !fresh[0].familyMatch.required[0][231] || battleRulesRevision(fresh) != revision {
		t.Fatal("shared index/view mutation", fresh, err)
	}
	saved, err := s.PutRules(ctx, fresh, revision)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT rule_json FROM battle_rules WHERE id='original'`).Scan(&unchanged); err != nil {
		t.Fatal(err)
	}
	var stored BattleTeamRule
	if json.Unmarshal([]byte(unchanged), &stored) != nil || !reflect.DeepEqual(stored.MonsterIDs, []int{231, 445}) || len(stored.AnyOf) != 0 {
		t.Fatal("explicit PUT did not normalize", unchanged)
	}
	next, err := s.Rules(ctx)
	if err != nil || battleRulesRevision(next) != battleRulesRevision(saved) {
		t.Fatal("PUT/GET CAS inconsistent", err)
	}
	if _, err = s.PutRules(ctx, fresh, revision); !errors.Is(err, errBattleRuleConflict) {
		t.Fatal("stale CAS accepted", err)
	}
}

func TestRuleFamilyImpossibleExclusionNotCorruptedByPromotion(t *testing.T) {
	input := []BattleTeamRule{{ID: "impossible", Name: "排除仍有效", AnyOf: [][]int{{111}}, ExcludedMonsterIDs: []int{111}}}
	out, err := battlePrepareRuleFamilies(input, familyRulesCatalog(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || !reflect.DeepEqual(out[0].AnyOf, input[0].AnyOf) {
		t.Fatal("impossible rule dropped or invalidated", out)
	}
	for _, ids := range [][]int{{111}, {103}, {109}, {999123}} {
		matches, _ := battleMatchedArchetypes(familyRulesRecord("none", ids...), out)
		if battleOneOf("impossible", matches...) {
			t.Fatal("exclusion became match", ids)
		}
	}
}

func TestRevisionSevenSnapshotReadOnlyMultiLabel(t *testing.T) {
	dir := os.Getenv("BR_REVISION_FIXTURE_DIR")
	if dir == "" {
		t.Skip("explicit isolated Nov4 seven-record JSON fixture")
	}
	source, err := os.ReadFile(filepath.Join(dir, "records-before.json"))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Records []BattleRecord `json:"records"`
	}
	if json.Unmarshal(source, &input) != nil || len(input.Records) != 7 {
		t.Fatal("fresh backup must contain seven records")
	}
	contextBytes, err := os.ReadFile(filepath.Join(dir, "context.json"))
	if err != nil {
		t.Fatal(err)
	}
	var paths struct {
		Backup string `json:"backup"`
	}
	if json.Unmarshal(contextBytes, &paths) != nil {
		t.Fatal("context")
	}
	catPath := filepath.Join(paths.Backup, "active-catalog.json")
	catBytes, err := os.ReadFile(catPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(paths.Backup, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Rules []struct {
			ID       string `json:"id"`
			Position int    `json:"position"`
			JSON     string `json:"json"`
		} `json:"rulesBefore"`
	}
	if json.Unmarshal(manifestBytes, &manifest) != nil || len(manifest.Rules) != 15 {
		t.Fatal("frozen rules")
	}
	s := familyRulesService(t, filepath.Join(t.TempDir(), "seven.sqlite"), func() ([]byte, error) { return catBytes, nil })
	ctx := context.Background()
	if _, err = s.Rules(ctx); err != nil {
		t.Fatal(err)
	}
	rules := []BattleTeamRule{}
	for _, row := range manifest.Rules {
		var rule BattleTeamRule
		if json.Unmarshal([]byte(row.JSON), &rule) != nil {
			t.Fatal(row.ID)
		}
		rules = append(rules, rule)
		if _, err = s.db.Exec(`INSERT INTO battle_rules(id,position,rule_json) VALUES(?,?,?)`, row.ID, row.Position, row.JSON); err != nil {
			t.Fatal(err)
		}
	}
	// Seed only the isolated temporary database with exact frozen record JSON.
	// Import identity/declaration enrichment is not part of a read-only test.
	var rawInput struct {
		Records []json.RawMessage `json:"records"`
	}
	if json.Unmarshal(source, &rawInput) != nil {
		t.Fatal("raw snapshot")
	}
	storedBefore := map[string]string{}
	for i, record := range input.Records {
		raw := string(rawInput.Records[i])
		storedBefore[record.ID] = raw
		if _, err = s.db.Exec(`INSERT INTO battles(id,started_at,outcome,record_json) VALUES(?,?,?,?)`, record.ID, record.StartedAt, record.Outcome, raw); err != nil {
			t.Fatal(err)
		}
	}
	view, err := s.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	stats, err := s.Stats(ctx, BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if stats.MatchedBattles != 7 || !stats.Archetypes.MultiLabel {
		t.Fatal("global duplicate", stats.MatchedBattles)
	}
	expected := map[string]int{}
	eligible, assignments := 0, 0
	for _, r := range input.Records {
		matched, ok := battleMatchedArchetypes(r, view)
		if !ok {
			continue
		}
		eligible++
		assignments += len(matched)
		t.Log(r.ID, matched)
		for _, id := range matched {
			expected[id]++
		}
	}
	if stats.Archetypes.Samples != eligible || stats.Archetypes.AssignmentCount != assignments || eligible != 7 || assignments != 8 {
		t.Fatal("eligible/global mismatch", eligible, assignments)
	}
	// Frozen seven-record expectations, independent of the match helper above.
	wantCounts := map[string]int{"rain": 2, "wolf": 2, "fire": 1, "snow": 1, "poison": 1, battleOtherArchetypeID: 1}
	for _, team := range stats.Archetypes.Teams {
		if team.Battles != wantCounts[team.ID] {
			t.Fatal("frozen multi-label count changed", team.ID, team.Battles)
		}
		if team.Battles != expected[team.ID] {
			t.Fatal("team mismatch", team.ID)
		}
		list, err := s.List(ctx, BattleFilter{TeamRuleID: team.ID}, 1, 100)
		if err != nil || list.Total != team.Battles {
			t.Fatal("list mismatch", team.ID, err)
		}
		filtered, err := s.Stats(ctx, BattleFilter{TeamRuleID: team.ID})
		if err != nil || filtered.MatchedBattles != team.Battles {
			t.Fatal("filtered count", team.ID, err)
		}
	}
	// Normalization/query/inference cannot persist facts or saved rule cleanups.
	for _, r := range input.Records {
		var raw string
		if err := s.db.QueryRow(`SELECT record_json FROM battles WHERE id=?`, r.ID).Scan(&raw); err != nil || raw != storedBefore[r.ID] {
			t.Fatal("query wrote record", r.ID, err)
		}
	}
	for _, row := range manifest.Rules {
		var raw string
		if err := s.db.QueryRow(`SELECT rule_json FROM battle_rules WHERE id=?`, row.ID).Scan(&raw); err != nil || raw != row.JSON {
			t.Fatal("query wrote rules", row.ID)
		}
	}
	for file, before := range map[string][]byte{filepath.Join(dir, "records-before.json"): source, catPath: catBytes, manifestPath: manifestBytes} {
		after, err := os.ReadFile(file)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatal("frozen source touched", file)
		}
	}
}

func TestRuleFamilySharedIndexConcurrentDetachedQueries(t *testing.T) {
	data := familyRulesCatalog(t)
	var wg sync.WaitGroup
	failures := make(chan string, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				unknown := 900000 + worker*20 + j
				rules := []BattleTeamRule{{ID: "one", Name: "独立规则", MonsterIDs: []int{231}, AnyOf: [][]int{{443, 444, 445}, {unknown}}}}
				out, err := battlePrepareRuleFamilies(rules, data)
				if err != nil || len(out) != 1 || !reflect.DeepEqual(out[0].MonsterIDs, []int{231, 445, unknown}) {
					failures <- "wrong detached output"
					return
				}
				matches, ok := battleMatchedArchetypes(familyRulesRecord("parallel"+strconv.Itoa(worker), 231, 443, unknown), out)
				if !ok || !battleOneOf("one", matches...) {
					failures <- "wrong unknown singleton/family membership"
					return
				}
				// Deliberately mutate only this query's private predicates.
				out[0].familyMatch.required[1][443] = false
				out[0].familyMatch.source.AnyOf[0][0] = 999001
			}
		}(i)
	}
	wg.Wait()
	close(failures)
	for failure := range failures {
		t.Error(failure)
	}
}

func TestRuleFamilyNormalizationExhaustivePredicateEquivalence(t *testing.T) {
	data := familyRulesCatalog(t)
	parsed, err := battleSharedCatalog(data)
	if err != nil {
		t.Fatal(err)
	}
	index := battleBuildRuleFamilyIndex(parsed.Monsters)
	rules := []BattleTeamRule{
		{ID: "and", Name: "and", MonsterIDs: []int{443, 444}, AnyOf: [][]int{{107, 111}, {311, 312}}, ExcludedMonsterIDs: []int{109}},
		{ID: "implied", Name: "implied", MonsterIDs: []int{445}, AnyOf: [][]int{{443, 999123}}, ExcludedMonsterIDs: []int{233}},
		{ID: "duplicated", Name: "duplicated", AnyOf: [][]int{{443, 103}, {445, 111}, {311, 312}}, ExcludedMonsterIDs: []int{101}},
		{ID: "impossible", Name: "impossible", AnyOf: [][]int{{111}}, ExcludedMonsterIDs: []int{111}},
	}
	out, err := battlePrepareRuleFamilies(rules, data)
	if err != nil {
		t.Fatal(err)
	}
	ids := []int{443, 445, 103, 111, 101, 109, 311, 312, 233, 999123}
	for mask := 0; mask < (1 << len(ids)); mask++ {
		have := map[int]bool{}
		for i, id := range ids {
			if mask&(1<<i) != 0 {
				have[id] = true
			}
		}
		contains := func(id int) bool {
			for member := range index.family(id) {
				if have[member] {
					return true
				}
			}
			return false
		}
		for i, rule := range rules {
			want := true
			for _, id := range rule.MonsterIDs {
				want = want && contains(id)
			}
			for _, id := range rule.ExcludedMonsterIDs {
				want = want && !contains(id)
			}
			for _, group := range rule.AnyOf {
				satisfied := false
				for _, id := range group {
					satisfied = satisfied || contains(id)
				}
				want = want && satisfied
			}
			if battleRuleMatches(out[i], have) != want {
				t.Fatalf("predicate changed for %s subset=%d", rule.ID, mask)
			}
		}
	}
}

func TestRuleFamilyPromotionOverBudgetPreservesPredicateSourceAndCAS(t *testing.T) {
	input := BattleTeamRule{ID: "budget", Name: "预算保护", MonsterIDs: []int{}, ExcludedMonsterIDs: []int{}, AnyOf: [][]int{}}
	have := map[int]bool{}
	for i := 0; i < 24; i++ {
		input.MonsterIDs = append(input.MonsterIDs, 900000+i)
		input.AnyOf = append(input.AnyOf, []int{900024 + i})
		have[900000+i] = true
		have[900024+i] = true
	}
	rules, err := normalizeBattleRules([]BattleTeamRule{input})
	if err != nil {
		t.Fatal("original budget invalid", err)
	}
	prepared, err := battlePrepareRuleFamilies(rules, nil)
	if err != nil || len(prepared) != 1 {
		t.Fatal("valid original dropped", err)
	}
	if !reflect.DeepEqual(prepared[0].MonsterIDs, input.MonsterIDs) || !reflect.DeepEqual(prepared[0].AnyOf, input.AnyOf) || len(prepared[0].familyMatch.required) != 48 {
		t.Fatal("over-budget promotion corrupted original", prepared)
	}
	if !battleRuleMatches(prepared[0], have) {
		t.Fatal("original clauses stopped matching")
	}
	delete(have, 900047)
	if battleRuleMatches(prepared[0], have) {
		t.Fatal("lost required group")
	}
	if battleRulesRevision(prepared) != battleRulesRevision(rules) || string(archetypeEncode(t, battleRuleSourceInputs(prepared))) != string(archetypeEncode(t, rules)) {
		t.Fatal("source or CAS changed")
	}
	ctx := context.Background()
	s := familyRulesService(t, filepath.Join(t.TempDir(), "budget.sqlite"))
	if _, err = s.Rules(ctx); err != nil {
		t.Fatal(err)
	}
	raw := string(archetypeEncode(t, input))
	if _, err = s.db.Exec(`INSERT INTO battle_rules VALUES('budget',0,?)`, raw); err != nil {
		t.Fatal(err)
	}
	read, err := s.Rules(ctx)
	if err != nil || len(read) != 1 || len(read[0].AnyOf) != 24 {
		t.Fatal("GET rejects old valid predicate", read, err)
	}
	var unchanged string
	if err = s.db.QueryRow(`SELECT rule_json FROM battle_rules WHERE id='budget'`).Scan(&unchanged); err != nil || unchanged != raw {
		t.Fatal("GET wrote original", err)
	}
	saved, err := s.PutRules(ctx, read, battleRulesRevision(read))
	if err != nil {
		t.Fatal("explicit save invalidated original", err)
	}
	next, err := s.Rules(ctx)
	if err != nil || battleRulesRevision(next) != battleRulesRevision(saved) || len(next[0].MonsterIDs) != 24 || len(next[0].AnyOf) != 24 {
		t.Fatal("save/read budget or CAS mismatch", err)
	}
}
