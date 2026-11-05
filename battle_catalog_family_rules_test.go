package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"xhmwiki/internal/catalog"
)

func familyRulesCatalog(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func familyRulesRecord(id string, species ...int) BattleRecord {
	r := BattleRecord{Version: 1, ID: id, Mode: "pvp", Outcome: "win", Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{}}, Sides: map[string]BattleSide{"me": {Pets: []BattlePet{{InstanceID: "own", MonsterID: 1}}}}, Events: []BattleEvent{}, Issues: []string{}}
	side := BattleSide{Pets: []BattlePet{}}
	for i, id := range species {
		side.Pets = append(side.Pets, BattlePet{InstanceID: string(rune('a' + i)), MonsterID: id})
	}
	r.Sides["enemy"] = side
	return r
}

func TestUniversalFamilyRulesAllConditionsAndFutureLinks(t *testing.T) {
	monsters := []catalog.Monster{
		{ID: 1, Name: "unrelated names"}, {ID: 2, EvolvesFromID: 1}, {ID: 3, LeaderOfID: 2},
		{ID: 10}, {ID: 11, EvolvesFromID: 10}, {ID: 12, LeaderOfID: 11},
		{ID: 20}, {ID: 21, EvolvesFromID: 20}, {ID: 22, LeaderOfID: 21},
		{ID: 30}, {ID: 31, EvolvesFromID: 30},
		{ID: 40, Name: "unrelated names", MainFormID: 2, EvolutionMembers: []int{1, 2, 3, 40}},
	}
	rules := []BattleTeamRule{{ID: "custom", Name: "custom", MonsterIDs: []int{2}, ExcludedMonsterIDs: []int{11}, AnyOf: [][]int{{21, 31}, {777}}}}
	before, _ := json.Marshal(rules)
	compiled := battleCompileRuleFamilies(rules, monsters)
	for _, tc := range []struct {
		ids  []int
		want bool
	}{
		{[]int{1, 20, 777}, true}, {[]int{3, 22, 777}, true}, {[]int{2, 30, 777}, true},
		{[]int{2, 20}, false}, {[]int{2, 777}, false}, {[]int{40, 20, 777}, false},
		{[]int{3, 22, 777, 10}, false}, {[]int{3, 22, 777, 12}, false},
	} {
		got, eligible := battleAssignedArchetype(familyRulesRecord("fixture", tc.ids...), compiled)
		if !eligible || (got == "custom") != tc.want {
			t.Fatalf("%v => %s eligible %v", tc.ids, got, eligible)
		}
	}
	// A later catalog-only link is universal: no rule patch or built-in-ID table.
	future := append(append([]catalog.Monster{}, monsters...), catalog.Monster{ID: 99, LeaderOfID: 2})
	futureRules := battleCompileRuleFamilies(rules, future)
	if got, _ := battleAssignedArchetype(familyRulesRecord("future", 99, 22, 777), futureRules); got != "custom" {
		t.Fatal(got)
	}
	if battleRulesRevision(compiled) == battleRulesRevision(futureRules) {
		t.Fatal("catalog family update did not invalidate revision")
	}
	// Names, catalog row ordering and display membership lists are not evidence.
	monsters[0].Name = "changed display only"
	monsters[0].EvolutionMembers = []int{40, 12}
	reverse := append([]catalog.Monster{}, monsters...)
	for i, j := 0, len(reverse)-1; i < j; i, j = i+1, j-1 {
		reverse[i], reverse[j] = reverse[j], reverse[i]
	}
	if battleRulesRevision(compiled) != battleRulesRevision(battleCompileRuleFamilies(rules, reverse)) {
		t.Fatal("display/order changed semantic family revision")
	}
	after, _ := json.Marshal(rules)
	if string(before) != string(after) {
		t.Fatal("source rule mutated")
	}
	compiled[0].AnyOf[0][0] = 999
	if rules[0].AnyOf[0][0] != 21 {
		t.Fatal("OR group aliases input")
	}
}

func TestUniversalFamilyRulesActualCatalogRegionalBranches(t *testing.T) {
	data := familyRulesCatalog(t)
	for _, tc := range []struct {
		seed    int
		yes, no []int
	}{
		{170, []int{168, 170}, []int{169, 171}},
		{171, []int{169, 171}, []int{168, 170}},
		{111, []int{103, 107, 111}, []int{100, 101, 102, 104, 105, 106, 108, 109, 110}},
		{109, []int{101, 105, 109}, []int{100, 102, 103, 104, 106, 107, 108, 110, 111}},
		{233, []int{232, 233}, []int{595, 616, 617}},
		{356, []int{354, 355, 356, 357}, nil},
		{13, []int{11, 12, 13, 14}, nil},
		{322, []int{320, 321, 322, 323}, nil},
		{199, []int{196, 197, 198, 199}, nil},
	} {
		positive, err := battlePrepareRuleFamilies([]BattleTeamRule{{ID: "p", MonsterIDs: []int{tc.seed}}}, data)
		if err != nil {
			t.Fatal(err)
		}
		negative, err := battlePrepareRuleFamilies([]BattleTeamRule{{ID: "n", MonsterIDs: []int{900001}, ExcludedMonsterIDs: []int{tc.seed}}}, data)
		if err != nil {
			t.Fatal(err)
		}
		or, err := battlePrepareRuleFamilies([]BattleTeamRule{{ID: "o", AnyOf: [][]int{{tc.seed}}}}, data)
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range tc.yes {
			if got, _ := battleAssignedArchetype(familyRulesRecord("yes", id), positive); got != "p" {
				t.Fatalf("seed %d excludes %d", tc.seed, id)
			}
			if got, _ := battleAssignedArchetype(familyRulesRecord("or", id), or); got != "o" {
				t.Fatalf("OR seed %d excludes %d", tc.seed, id)
			}
			if got, _ := battleAssignedArchetype(familyRulesRecord("negative", 900001, id), negative); got != "__other__" {
				t.Fatalf("negative seed %d admits %d", tc.seed, id)
			}
		}
		for _, id := range tc.no {
			if got, _ := battleAssignedArchetype(familyRulesRecord("no", id), positive); got != "__other__" {
				t.Fatalf("seed %d crosses regional/name-only link to %d", tc.seed, id)
			}
			if got, _ := battleAssignedArchetype(familyRulesRecord("negative", 900001, id), negative); got != "n" {
				t.Fatalf("negative seed %d wrongly excludes %d", tc.seed, id)
			}
		}
	}
}

func TestDefaultFamilyRulesOrderedResourceAndFirstHit(t *testing.T) {
	rules, err := defaultBattleRules()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"rain", "snow", "star", "poison", "cute", "bugs", "earth-martial", "fire", "thunderstorm", "wolf", "fire-god", "stilt", "dream", "electric-deer", "luoyin"}
	got, names := []string{}, []string{}
	for _, r := range rules {
		got = append(got, r.ID)
		names = append(names, r.Name)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	wantNames := []string{"雨天", "雪天", "星陨", "毒队", "萌队", "虫队", "地武", "火队", "雷暴", "狼王", "火神", "高脚", "三三", "电鹿", "罗隐"}
	if !reflect.DeepEqual(names, wantNames) {
		t.Fatalf("user category names/order: got %v want %v", names, wantNames)
	}
	resource, err := os.ReadFile("data/default-battle-rules.json")
	if err != nil || !reflect.DeepEqual(resource, battleDefaultRulesJSON) {
		t.Fatal("bundled/embedded mismatch", err)
	}
	prepared, err := battlePrepareRuleFamilies(rules, familyRulesCatalog(t))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		ids  []int
		want string
	}{
		{[]int{17, 202, 246, 472}, "rain"}, {[]int{246, 472, 14}, "snow"},
		{[]int{231, 443}, "star"}, {[]int{231, 444}, "star"}, {[]int{231, 445}, "star"},
		{[]int{387, 390}, "poison"}, {[]int{167, 296}, "cute"}, {[]int{192, 432}, "bugs"},
		{[]int{311}, "earth-martial"}, {[]int{312}, "earth-martial"}, {[]int{297}, "earth-martial"},
		{[]int{343, 393}, "fire"}, {[]int{385, 168}, "thunderstorm"}, {[]int{385, 169}, "__other__"}, {[]int{385, 171}, "__other__"},
		{[]int{232, 103}, "wolf"}, {[]int{233, 105}, "wolf"}, {[]int{233, 111}, "wolf"}, {[]int{233, 109}, "wolf"},
		{[]int{233, 108}, "__other__"}, {[]int{233, 110}, "__other__"}, {[]int{595, 111}, "__other__"},
		{[]int{14}, "fire-god"}, {[]int{363}, "stilt"}, {[]int{323}, "dream"}, {[]int{357}, "electric-deer"}, {[]int{198}, "luoyin"},
	}
	for _, tc := range cases {
		if got, _ := battleAssignedArchetype(familyRulesRecord("default", tc.ids...), prepared); got != tc.want {
			t.Fatalf("%v=>%s want %s", tc.ids, got, tc.want)
		}
	}
	stats := BuildBattleArchetypeStats([]BattleRecord{familyRulesRecord("leader", 357, 900001)}, rules, familyRulesCatalog(t))
	for _, team := range stats.Teams {
		if team.ID == "electric-deer" && (len(team.Teammates) != 1 || team.Teammates[0].MonsterID != 900001) {
			t.Fatalf("leader appeared as noncore teammate: %+v", team.Teammates)
		}
	}
	rules[0].MonsterIDs[0] = 900001
	again, _ := defaultBattleRules()
	if again[0].MonsterIDs[0] != 17 {
		t.Fatal("default resource aliases caller")
	}
}

func TestDefaultFamilyRulesSeedIDsResolveToUserCatalogIdentities(t *testing.T) {
	c, err := catalog.Parse(familyRulesCatalog(t))
	if err != nil {
		t.Fatal(err)
	}
	byID := map[int]catalog.Monster{}
	for _, monster := range c.Monsters {
		byID[monster.ID] = monster
	}
	// These identities were independently inspected in the canonical catalog,
	// not inferred from labels or copied from the default pair arrays.
	names := map[int]string{
		17: "水灵", 202: "彩蝶鲨", 246: "雪影娃娃", 472: "月牙雪熊", 231: "怖哭菇",
		443: "小帕尔", 444: "帕尔萨斯", 445: "龙息帕尔", 387: "琉璃水母", 390: "裘卡",
		167: "菊花梨", 296: "卡洛儿", 192: "花衣蝶", 432: "铠甲虫", 311: "棋绮后", 312: "棋绮后",
		343: "烈火守护", 393: "火焰猿", 385: "闪电鳗鱼", 170: "星光狮", 233: "恶魔狼王",
		111: "卡瓦重", 109: "卡瓦重", 13: "火神", 363: "高脚鹬", 322: "梦想三三", 356: "爵士鹿", 199: "罗隐",
	}
	forms := map[int]string{311: "白子", 312: "黑子", 170: "星光能量的样子", 111: "雪山附近的样子", 109: "火山附近的样子"}
	rules, err := defaultBattleRules()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[int]bool{}
	for _, rule := range rules {
		ids := append([]int{}, rule.MonsterIDs...)
		for _, group := range rule.AnyOf {
			ids = append(ids, group...)
		}
		for _, id := range ids {
			monster, exists := byID[id]
			if !exists || names[id] == "" || monster.Name != names[id] {
				t.Fatalf("default %s seed %d resolves to %q, want user identity %q", rule.ID, id, monster.Name, names[id])
			}
			if form := forms[id]; form != "" && monster.Form != form {
				t.Fatalf("default %s seed %d wrong regional form %q", rule.ID, id, monster.Form)
			}
			seen[id] = true
		}
	}
	if len(seen) != len(names) {
		t.Fatalf("default seed identity coverage %d/%d", len(seen), len(names))
	}
}

func TestUniversalFamilyRulesORValidationAndUnknownIDs(t *testing.T) {
	good := []BattleTeamRule{{ID: "future", Name: "future", AnyOf: [][]int{{999001, 999001, 999002}, {999003}}, ExcludedMonsterIDs: []int{999004}}}
	clean, err := normalizeBattleRules(good)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(clean[0].AnyOf, [][]int{{999001, 999002}, {999003}}) {
		t.Fatal(clean)
	}
	if got, _ := battleAssignedArchetype(familyRulesRecord("unknown", 999002, 999003), clean); got != "future" {
		t.Fatal(got)
	}
	for _, bad := range []BattleTeamRule{
		{ID: "x", Name: "x"}, {ID: "x", Name: "x", AnyOf: [][]int{{}}}, {ID: "x", Name: "x", AnyOf: [][]int{{0}}}, {ID: "x", Name: "x", AnyOf: [][]int{{-1}}},
	} {
		if _, err := normalizeBattleRules([]BattleTeamRule{bad}); err == nil {
			t.Fatal("accepted invalid OR", bad)
		}
	}
	if _, err := battlePrepareRuleFamilies(good, []byte(`{"schema_version":999}`)); err == nil {
		t.Fatal("unknown catalog schema accepted")
	}
}
