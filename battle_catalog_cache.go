package main

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"

	"xhmwiki/internal/catalog"
)

// The cache is only a read-only accelerator for caller-supplied snapshots. It
// never chooses the active catalogue, performs I/O, or caches battle results.
// Bump this independently of schema_version when the shared parse/index contract
// changes. Exact source bytes (including v1 versus v2) always have distinct keys.
const battleCatalogCacheSemanticsVersion = 2
const battleCatalogCacheGenerations = 2

type battleCatalogCacheKey struct {
	sha       [sha256.Size]byte
	semantics int
}

type battleCatalogDomainResult struct {
	value any
	err   error
}

type battleCatalogCacheEntry struct {
	key      battleCatalogCacheKey
	revision string
	catalog  *catalog.Catalog

	mu           sync.Mutex
	domains      map[string]battleCatalogDomainResult
	domainBuilds uint64 // private instrumentation; read under mu
}

type battleCatalogCache struct {
	mu          sync.Mutex
	entries     []*battleCatalogCacheEntry // most recently used first, at most two
	parseBuilds uint64                     // private instrumentation; read under mu
}

var battleCatalogSnapshots battleCatalogCache

func (cache *battleCatalogCache) read(data []byte) (*battleCatalogCacheEntry, error) {
	key := battleCatalogCacheKey{sha: sha256.Sum256(data), semantics: battleCatalogCacheSemanticsVersion}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	for i, entry := range cache.entries {
		if entry.key == key {
			copy(cache.entries[1:i+1], cache.entries[:i])
			cache.entries[0] = entry
			return entry, nil
		}
	}
	// Serialize the first parse, not just publication: concurrent same-byte reads
	// must not each pay for validation and index construction. Parse does not keep
	// aliases to the input byte slice; its slices/maps belong to this entry.
	cache.parseBuilds++
	parsed, err := catalog.Parse(data)
	if err != nil {
		// No last-good-generation fallback, and invalid input cannot evict a valid
		// entry or ever receive another generation's catalogue/domain values.
		return nil, err
	}
	entry := &battleCatalogCacheEntry{key: key, revision: hex.EncodeToString(key.sha[:]), catalog: parsed, domains: map[string]battleCatalogDomainResult{}}
	cache.entries = append(cache.entries, nil)
	copy(cache.entries[1:], cache.entries[:len(cache.entries)-1])
	cache.entries[0] = entry
	if len(cache.entries) > battleCatalogCacheGenerations {
		cache.entries[battleCatalogCacheGenerations] = nil
		cache.entries = cache.entries[:battleCatalogCacheGenerations]
	}
	return entry, nil
}

// battleSharedCatalog returns a PRIVATE immutable parsed view. Only audited
// read-only battle consumers may use it: never mutate any struct, nested slice,
// map, Power pointer or extension. Public DTOs/record facts must be detached.
func battleSharedCatalog(data []byte) (*catalog.Catalog, error) {
	entry, err := battleCatalogSnapshots.read(data)
	if err != nil {
		return nil, err
	}
	return entry.catalog, nil
}

func (entry *battleCatalogCacheEntry) domain(name string, build func(*catalog.Catalog, string) (any, error)) (any, error) {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if found, ok := entry.domains[name]; ok {
		return found.value, found.err
	}
	// Domain names are private, fixed, versioned callsite constants; don't use
	// filter values, user rules, record IDs or other unbounded user input as names.
	// Builders are read-only and must not recursively ask for this entry's domain.
	entry.domainBuilds++
	value, err := build(entry.catalog, entry.revision)
	if err != nil {
		value = nil
	}
	entry.domains[name] = battleCatalogDomainResult{value: value, err: err}
	return value, err
}

// Each domain lazily constructs its own private read-only index once per exact
// catalogue generation. Failed domain validation remains tied to those bytes.
// Callers must copy any mutable maps/slices that escape into public results.
func battleSharedCatalogDomain(data []byte, name string, build func(*catalog.Catalog, string) (any, error)) (any, error) {
	entry, err := battleCatalogSnapshots.read(data)
	if err != nil {
		return nil, err
	}
	return entry.domain(name, build)
}
