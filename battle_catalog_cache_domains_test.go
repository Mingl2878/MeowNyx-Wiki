package main

import (
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"xhmwiki/internal/catalog"
)

// Exercise the actual independent Stats module readers after their owners wire
// the common helper. The catalogue cache contains no rule/filter/record results.
func TestBattleCatalogCacheStatsDomainsConcurrentReuseAndDetachedRules(t *testing.T) {
	data := append(performanceCatalog(t), []byte("\n \n \n")...)
	battleCatalogSnapshots.mu.Lock()
	beforeParses := battleCatalogSnapshots.parseBuilds
	battleCatalogSnapshots.mu.Unlock()
	entry, err := battleCatalogSnapshots.read(data)
	if err != nil {
		t.Fatal(err)
	}
	rules := []BattleTeamRule{{ID: "one", Name: "one", MonsterIDs: []int{1}}}
	const workers = 32
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := battlePrepareRuleFamilies(rules, data); err != nil {
				t.Error(err)
			}
			_ = battleInferenceReadCatalog(data)
			_ = battleGrowthReadCatalog(data)
			_ = battlePerformanceReadCatalog(data)
			_ = battlePerformanceReadCatalog(data) // self + enemy
		}()
	}
	wg.Wait()
	battleCatalogSnapshots.mu.Lock()
	parses := battleCatalogSnapshots.parseBuilds - beforeParses
	battleCatalogSnapshots.mu.Unlock()
	entry.mu.Lock()
	builds := entry.domainBuilds
	entry.mu.Unlock()
	if parses != 1 || builds != 4 {
		t.Fatalf("actual Stats readers: parses=%d, independent domain builds=%d (want 1,4)", parses, builds)
	}
	growthA, growthB := battleGrowthReadCatalog(data), battleGrowthReadCatalog(data)
	if reflect.ValueOf(growthA.native).Pointer() != reflect.ValueOf(growthB.native).Pointer() || reflect.ValueOf(growthA.skills).Pointer() != reflect.ValueOf(growthB.skills).Pointer() {
		t.Fatal("growth catalogue indexes rebuilt")
	}
	prepared, err := battlePrepareRuleFamilies(rules, data)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(rules)
	prepared[0].MonsterIDs[0] = 999
	prepared[0].familyMatch.required[0][999] = true
	prepared[0].familyMatch.core[999] = true
	next, err := battlePrepareRuleFamilies(rules, data)
	if err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(rules)
	if string(before) != string(after) || next[0].MonsterIDs[0] != 1 || battleRuleMatches(next[0], map[int]bool{999: true}) || next[0].familyMatch.core[999] {
		t.Fatal("mutable compiled rule result leaked into source/cache")
	}
}

func TestBattleCatalogCacheChangedGenerationRefreshesEveryStatsDomain(t *testing.T) {
	dataA := append(performanceCatalog(t), []byte("\n   \n")...)
	c, err := catalog.Parse(dataA)
	if err != nil {
		t.Fatal(err)
	}
	c.Monsters[0].Stats.HP = 101
	c.Monsters[1].EvolvesFromID = 1
	c.Monsters[1].EvolutionMembers = []int{1, 2}
	c.Traits = append(c.Traits, catalog.Trait{ID: "new-trait", Name: "新测试特性", Description: "仅用于隔离样本。"})
	c.Monsters[0].TraitID = "new-trait"
	dataB, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	rules := []BattleTeamRule{{ID: "one", Name: "one", MonsterIDs: []int{1}}}
	a, err := battlePrepareRuleFamilies(rules, dataA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := battlePrepareRuleFamilies(rules, dataB)
	if err != nil {
		t.Fatal(err)
	}
	if battleRuleMatches(a[0], map[int]bool{2: true}) || !battleRuleMatches(b[0], map[int]bool{2: true}) {
		t.Fatal("relationship index used wrong generation")
	}
	if battlePerformanceReadCatalog(dataA).hp[1] != 100 || battlePerformanceReadCatalog(dataB).hp[1] != 101 {
		t.Fatal("performance HP wrong generation")
	}
	if battleInferenceReadCatalog(dataA)[1]["hp"] != 100 || battleInferenceReadCatalog(dataB)[1]["hp"] != 101 {
		t.Fatal("inference bases wrong generation")
	}
	if battleGrowthReadCatalog(dataA).native[1] != "trait" || battleGrowthReadCatalog(dataB).native[1] != "new-trait" {
		t.Fatal("growth configuration wrong generation")
	}
}
