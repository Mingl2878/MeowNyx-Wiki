package main

import (
	"os"
	"testing"

	"xhmwiki/internal/catalog"
)

// Keep the measured pre-change lookup implementation as an explicit benchmark
// reference, not a production fallback. Scope: one inference and both sides'
// performance catalogue lookups, no records/DB/formulas/result caching.
func battleCatalogUncachedInference(data []byte) battleInferenceCatalog {
	out := battleInferenceCatalog{}
	c, err := catalog.Parse(data)
	if err != nil {
		return out
	}
	for _, m := range c.Monsters {
		out[m.ID] = map[string]int{"hp": m.Stats.HP, "attack": m.Stats.PhyAtk, "defense": m.Stats.PhyDef, "magic_attack": m.Stats.MagAtk, "magic_defense": m.Stats.MagDef, "speed": m.Stats.Speed}
	}
	return out
}

func battleCatalogUncachedPerformance(data []byte) (map[int]int, map[int]catalog.Skill) {
	hp, skills := map[int]int{}, map[int]catalog.Skill{}
	c, err := catalog.Parse(data)
	if err != nil {
		return hp, skills
	}
	for _, m := range c.Monsters {
		if m.Stats.HP > 0 {
			hp[m.ID] = m.Stats.HP
		}
	}
	for _, s := range c.Skills {
		skills[s.ID] = s
	}
	return hp, skills
}

func BenchmarkBattleCatalogUncachedStatsLookups(b *testing.B) {
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if len(battleCatalogUncachedInference(data)) == 0 {
			b.Fatal("fixture unavailable")
		}
		for side := 0; side < 2; side++ {
			hp, skills := battleCatalogUncachedPerformance(data)
			if len(hp) == 0 || len(skills) == 0 {
				b.Fatal("fixture unavailable")
			}
		}
	}
	b.ReportMetric(3, "parses/op")
	b.ReportMetric(3, "index-builds/op")
}

func BenchmarkBattleCatalogSharedStatsLookups(b *testing.B) {
	data, err := os.ReadFile("data/catalog.json")
	if err != nil {
		b.Fatal(err)
	}
	_ = battleInferenceReadCatalog(data)
	_ = battlePerformanceReadCatalog(data)
	entry, err := battleCatalogSnapshots.read(data)
	if err != nil {
		b.Fatal(err)
	}
	battleCatalogSnapshots.mu.Lock()
	parsesBefore := battleCatalogSnapshots.parseBuilds
	battleCatalogSnapshots.mu.Unlock()
	entry.mu.Lock()
	domainsBefore := entry.domainBuilds
	entry.mu.Unlock()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if len(battleInferenceReadCatalog(data)) == 0 || !battlePerformanceReadCatalog(data).available || !battlePerformanceReadCatalog(data).available {
			b.Fatal("fixture unavailable")
		}
	}
	b.StopTimer()
	battleCatalogSnapshots.mu.Lock()
	parses := battleCatalogSnapshots.parseBuilds - parsesBefore
	battleCatalogSnapshots.mu.Unlock()
	entry.mu.Lock()
	domains := entry.domainBuilds - domainsBefore
	entry.mu.Unlock()
	b.ReportMetric(float64(parses)/float64(b.N), "parses/op")
	b.ReportMetric(float64(domains)/float64(b.N), "index-builds/op")
	if parses != 0 || domains != 0 {
		b.Fatal("same generation rebuilt")
	}
}
