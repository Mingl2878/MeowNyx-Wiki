package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestBattleCatalogCacheConcurrentOneParseAndDomainBuild(t *testing.T) {
	data := performanceCatalog(t)
	var cache battleCatalogCache
	var builds atomic.Int32
	const workers = 64
	entries := make([]*battleCatalogCacheEntry, workers)
	values := make([]any, workers)
	var wg sync.WaitGroup
	for i := range entries {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			entry, err := cache.read(data)
			if err != nil {
				t.Error(err)
				return
			}
			entries[i] = entry
			value, err := entry.domain("test-index-v1", func(c *catalog.Catalog, revision string) (any, error) {
				builds.Add(1)
				sum := sha256.Sum256(data)
				if revision != hex.EncodeToString(sum[:]) {
					t.Error("not exact source revision")
				}
				return &struct{ count int }{len(c.Monsters)}, nil
			})
			if err != nil {
				t.Error(err)
				return
			}
			values[i] = value
		}(i)
	}
	wg.Wait()
	for i := range entries {
		if entries[i] != entries[0] || values[i] != values[0] {
			t.Fatal("same bytes rebuilt concurrently")
		}
	}
	if cache.parseBuilds != 1 || builds.Load() != 1 || entries[0].domainBuilds != 1 {
		t.Fatalf("parse=%d domain=%d", cache.parseBuilds, builds.Load())
	}
	// A separate domain is lazy and independent, not a whole-result cache.
	_, err := entries[0].domain("other-index-v1", func(*catalog.Catalog, string) (any, error) { return 7, nil })
	if err != nil || entries[0].domainBuilds != 2 || cache.parseBuilds != 1 {
		t.Fatal("domains do not share one parse")
	}
}

func TestBattleCatalogCacheExactBytesTwoGenerationsAndSemanticVersion(t *testing.T) {
	dataA := performanceCatalog(t)
	c, err := catalog.Parse(dataA)
	if err != nil {
		t.Fatal(err)
	}
	c.Monsters[0].Stats.HP++
	dataB, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	// Identical meaning is not sufficient: exact immutable source bytes are key.
	dataC := append(append([]byte(nil), dataA...), '\n')
	var cache battleCatalogCache
	a, _ := cache.read(dataA)
	b, _ := cache.read(dataB)
	if a == b || a.catalog.Monsters[0].Stats.HP == b.catalog.Monsters[0].Stats.HP {
		t.Fatal("changed bytes used old generation")
	}
	if hit, _ := cache.read(dataA); hit != a {
		t.Fatal("second generation was not retained")
	}
	third, _ := cache.read(dataC)
	if third == a || third.revision == a.revision || len(cache.entries) != 2 {
		t.Fatal("key not exact or unbounded generations")
	}
	if hit, _ := cache.read(dataA); hit != a {
		t.Fatal("LRU evicted most recent generation")
	}
	if rebuilt, _ := cache.read(dataB); rebuilt == b || len(cache.entries) != 2 || cache.parseBuilds != 4 {
		t.Fatal("old generation not evicted")
	}
	// The key includes cache semantics independently of source schema migration.
	cache.entries[0].key.semantics--
	if rebuilt, _ := cache.read(dataB); rebuilt == cache.entries[1] || rebuilt == b || cache.parseBuilds != 5 {
		t.Fatal("semantic version omitted from key")
	}
	v1 := bytes.Replace(dataA, []byte(`"schema_version":2`), []byte(`"schema_version":1`), 1)
	legacy, err := cache.read(v1)
	if err != nil || legacy.catalog.SchemaVersion != 2 || legacy.revision == a.revision {
		t.Fatalf("v1 migration boundary changed: %v", err)
	}
}

func TestBattleCatalogCacheErrorsNeverReturnAnotherGeneration(t *testing.T) {
	data := performanceCatalog(t)
	var cache battleCatalogCache
	good, err := cache.read(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]byte{
		nil, []byte(`{"schema_version":999}`),
		bytes.Replace(data, []byte(`"schema_version":2`), []byte(`"schema_version":999`), 1),
		bytes.Replace(data, []byte(`"schema_version":2`), []byte(`"schema_version":2,"schema_version":2`), 1),
		bytes.Replace(data, []byte(`"phy_atk":80`), []byte(`"phy_atk":-1`), 1),
		append(append([]byte(nil), data...), []byte(` {}`)...),
	} {
		entry, err := cache.read(bad)
		if err == nil || entry != nil || len(cache.entries) != 1 || cache.entries[0] != good {
			t.Fatal("invalid input fell back to or evicted valid generation")
		}
	}
	buildErr := errors.New("invalid exact domain metadata")
	badCalls := 0
	for i := 0; i < 2; i++ {
		value, err := good.domain("bad-domain-v1", func(*catalog.Catalog, string) (any, error) { badCalls++; return good, buildErr })
		if value != nil || !errors.Is(err, buildErr) {
			t.Fatal("domain failure exposed partial/other generation data")
		}
	}
	if badCalls != 1 {
		t.Fatal("deterministic domain failure rebuilt")
	}
	other, _ := cache.read(append(append([]byte(nil), data...), '\n'))
	value, err := other.domain("bad-domain-v1", func(*catalog.Catalog, string) (any, error) { return 42, nil })
	if err != nil || value != 42 {
		t.Fatal("domain error leaked across exact generations")
	}
}

func TestBattleCatalogCacheOwnedConsumersShareIndexesAndDoNotMutate(t *testing.T) {
	data := append(performanceCatalog(t), []byte(" \n  ")...)
	originalBytes := append([]byte(nil), data...)
	parsed, err := battleSharedCatalog(data)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(parsed)
	entry, _ := battleCatalogSnapshots.read(data)
	const workers = 32
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = battleInferenceReadCatalog(data)
			_ = battlePerformanceReadCatalog(data)
			if _, err := battleReadIdentityMap(data); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if entry.domainBuilds != 3 {
		t.Fatalf("owned domains built %d times, expected one per domain", entry.domainBuilds)
	}
	a, b := battleInferenceReadCatalog(data), battleInferenceReadCatalog(data)
	if reflect.ValueOf(a).Pointer() != reflect.ValueOf(b).Pointer() {
		t.Fatal("inference index rebuilt")
	}
	pa, pb := battlePerformanceReadCatalog(data), battlePerformanceReadCatalog(data)
	if reflect.ValueOf(pa.skills).Pointer() != reflect.ValueOf(pb.skills).Pointer() || reflect.ValueOf(pa.hp).Pointer() != reflect.ValueOf(pb.hp).Pointer() {
		t.Fatal("performance indexes rebuilt")
	}
	ma, _ := battleReadIdentityMap(data)
	mb, _ := battleReadIdentityMap(data)
	if ma != mb {
		t.Fatal("identity index rebuilt")
	}
	// Consumers only mutate their detached result/record views. A returned scalar
	// skill copy cannot alias a mutable Power/SourceRef/extension into the cache.
	skill := pa.skills[10]
	skill.Category = "changed only local scalar copy"
	r := inferenceRecord()
	r.Events = []BattleEvent{inferenceInitialHP("enemy", "b", 391)}
	rawBefore, _ := json.Marshal(r)
	view, dto := PrepareBattleInference([]BattleRecord{r}, data)
	_ = BuildBattlePerformance([]BattleRecord{r}, data)
	_ = BuildBattleEnemyPerformance([]BattleRecord{r}, data)
	*view[0].Events[0].HPMax = 1
	dto.Counts["unique"] = 999
	view[0].Sides["me"].Pets[0].IV["hp"] = BattleEvidence{}
	rawAfter, _ := json.Marshal(r)
	after, _ := json.Marshal(parsed)
	if !bytes.Equal(before, after) || !bytes.Equal(rawBefore, rawAfter) || !bytes.Equal(data, originalBytes) {
		t.Fatal("lookup/result mutation reached shared catalogue or source facts")
	}
	if battlePerformanceReadCatalog(data).skills[10].Category != "Physical Attack" || battleInferenceReadCatalog(data)[1]["hp"] != 100 {
		t.Fatal("shared scalar lookup corrupted")
	}
	// Invalid generation must preserve every reader's prior fail-closed behavior.
	invalid := []byte(strings.Replace(string(data), `"schema_version":2`, `"schema_version":999`, 1))
	if len(battleInferenceReadCatalog(invalid)) != 0 || battlePerformanceReadCatalog(invalid).available {
		t.Fatal("invalid schema used prior domain")
	}
	if _, err := battleReadIdentityMap(invalid); !errors.Is(err, errBattleMapping) {
		t.Fatal("identity invalid schema error changed")
	}
}
