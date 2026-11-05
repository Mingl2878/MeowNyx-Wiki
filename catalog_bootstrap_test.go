package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"xhmwiki/internal/catalog"
)

// Synthetic data only. No app initialization, real source files, AppData,
// production backup roots, network, or package-global filesystem overrides.
func catalogBootstrapFixture(t *testing.T, label string, ids ...int) ([]byte, catalog.LegacyFiles) {
	t.Helper()
	c := &catalog.Catalog{SchemaVersion: catalog.SchemaVersion,
		Types:  []catalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}},
		Traits: []catalog.Trait{{ID: "local-trait", Name: "本地特性", Description: "保留的完整特性定义。"}},
		Skills: []catalog.Skill{{ID: 7, Name: "本地技能", Description: "完整的本地技能说明。", TypeID: 1, Category: "Status", EnergyCost: 0, Power: nil, Season: "本地赛季"}},
	}
	for _, id := range ids {
		c.Monsters = append(c.Monsters, catalog.Monster{ID: id, EvolutionMembers: []int{id}, Name: fmt.Sprintf("%s%d", label, id), DexNumber: id, TypeIDs: []int{1}, TraitID: "local-trait", Stats: catalog.Stats{HP: 100, PhyAtk: 90, PhyDef: 80, MagAtk: 70, MagDef: 60, Speed: 50}, Images: catalog.Images{Avatar: "本地头像.png", Portrait: "本地立绘.png"}, Form: "default", FormCategory: "无多形态", EvolutionStage: "高级形态", Extensions: catalog.Extensions{"legacy": json.RawMessage(`{"local_only":{"keep":"原始额外数据"}}`)}})
		c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: id, Mode: "own", Skills: []catalog.LearnedSkill{{SkillID: 7, Source: "传说"}}})
	}
	b, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	files, err := catalog.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	return b, files
}
func catalogBootstrapInput(canonical []byte, legacy *catalog.LegacyFiles) map[string][]byte {
	files := map[string][]byte{}
	if canonical != nil {
		files[filepath.Join("data", "catalog.json")] = canonical
	}
	if legacy != nil {
		for _, part := range catalogBootstrapLegacyParts(legacy) {
			files[filepath.Join("data", part.name)] = *part.data
		}
	}
	return files
}
func catalogBootstrapReader(files map[string][]byte, calls *[]string) func(...string) ([]byte, error) {
	return func(parts ...string) ([]byte, error) {
		name := filepath.Join(parts...)
		if calls != nil {
			*calls = append(*calls, name)
		}
		b, ok := files[name]
		if !ok {
			return nil, fmt.Errorf("%s: %w", name, os.ErrNotExist)
		}
		return b, nil
	}
}

func TestCatalogBootstrapLegacyWinsWithoutActive(t *testing.T) {
	bundled, _ := catalogBootstrapFixture(t, "新内置", 100)
	_, old := catalogBootstrapFixture(t, "旧本地", 11, 99)
	files := catalogBootstrapInput(bundled, &old)
	calls := []string{}
	data, backup, err := prepareCatalogBaseline(catalogBootstrapReader(files, &calls), false)
	if err != nil {
		t.Fatal(err)
	}
	if backup == nil {
		t.Fatal("complete old dataset must request backup")
	}
	c, err := catalog.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Monsters) != 2 || c.Monsters[0].ID != 11 || c.Monsters[1].ID != 99 || !strings.HasPrefix(c.Monsters[0].Name, "旧本地") {
		t.Fatal("old local IDs/content replaced or automatically merged with new bundle")
	}
	if c.Learnsets[0].Skills[0].Source != "传说" || len(c.Monsters[0].Extensions) == 0 {
		t.Fatal("old learning source/extra data lost")
	}
	if len(calls) != 4 {
		t.Fatalf("unexpected reads: %v", calls)
	}
	for _, call := range calls {
		if strings.HasSuffix(call, "catalog.json") {
			t.Fatal("new bundle read during full legacy migration")
		}
	}
	if !reflect.DeepEqual(*backup, old) {
		t.Fatal("backup bytes are not exact original input")
	}
	// Return values must not alias the read closure's buffers.
	backup.Monsters[0] = 'X'
	if files[filepath.Join("data", "monsters.json")][0] == 'X' {
		t.Fatal("returned backup aliases source bytes")
	}
	if !strings.Contains(catalogLegacyBootstrapMessage, "旧版本地资料") || !strings.Contains(catalogLegacyBootstrapMessage, "官方更新") {
		t.Fatal("migration notice lost required safety explanation")
	}
}

func TestCatalogBootstrapActiveSkipsAllLegacy(t *testing.T) {
	bundled, old := catalogBootstrapFixture(t, "资料", 11)
	for _, state := range []string{"complete", "partial", "corrupt"} {
		t.Run(state, func(t *testing.T) {
			files := catalogBootstrapInput(bundled, &old)
			if state == "partial" {
				delete(files, filepath.Join("data", "moves.json"))
			}
			if state == "corrupt" {
				files[filepath.Join("data", "monsters.json")] = []byte("invalid legacy")
			}
			calls := []string{}
			data, backup, err := prepareCatalogBaseline(catalogBootstrapReader(files, &calls), true)
			if err != nil {
				t.Fatal(err)
			}
			if backup != nil || !bytes.Equal(data, bundled) {
				t.Fatal("active initialization reimported legacy")
			}
			if !reflect.DeepEqual(calls, []string{filepath.Join("data", "catalog.json")}) {
				t.Fatalf("active initialization read old dataset: %v", calls)
			}
			data[0] = 'X'
			if files[filepath.Join("data", "catalog.json")][0] == 'X' {
				t.Fatal("canonical return aliases input")
			}
		})
	}
}

func TestCatalogBootstrapPriorityAndFailureCases(t *testing.T) {
	bundled, old := catalogBootstrapFixture(t, "旧资料", 11)
	cases := []struct {
		name                  string
		active                bool
		change                func(map[string][]byte)
		wantLegacy, wantError bool
	}{
		{name: "canonical only", change: func(f map[string][]byte) {
			for _, p := range catalogBootstrapLegacyParts(&old) {
				delete(f, filepath.Join("data", p.name))
			}
		}},
		{name: "legacy only", change: func(f map[string][]byte) { delete(f, filepath.Join("data", "catalog.json")) }, wantLegacy: true},
		{name: "valid old outranks malformed new", change: func(f map[string][]byte) { f[filepath.Join("data", "catalog.json")] = []byte("{") }, wantLegacy: true},
		{name: "one missing old", change: func(f map[string][]byte) { delete(f, filepath.Join("data", "moves.json")) }, wantError: true},
		{name: "two missing old", change: func(f map[string][]byte) {
			delete(f, filepath.Join("data", "moves.json"))
			delete(f, filepath.Join("data", "types.json"))
		}, wantError: true},
		{name: "three missing old", change: func(f map[string][]byte) {
			delete(f, filepath.Join("data", "moves.json"))
			delete(f, filepath.Join("data", "types.json"))
			delete(f, filepath.Join("data", "wiki_monster_data.json"))
		}, wantError: true},
		{name: "old invalid JSON", change: func(f map[string][]byte) { f[filepath.Join("data", "moves.json")] = []byte("{") }, wantError: true},
		{name: "old null collection", change: func(f map[string][]byte) { f[filepath.Join("data", "moves.json")] = []byte("null") }, wantError: true},
		{name: "old empty bytes", change: func(f map[string][]byte) { f[filepath.Join("data", "moves.json")] = nil }, wantError: true},
		{name: "old empty collection", change: func(f map[string][]byte) { f[filepath.Join("data", "moves.json")] = []byte("[]") }, wantError: true},
		{name: "nothing available", change: func(f map[string][]byte) { clear(f) }, wantError: true},
		{name: "active missing canonical must not reimport", active: true, change: func(f map[string][]byte) { delete(f, filepath.Join("data", "catalog.json")) }, wantError: true},
		{name: "active malformed canonical must not reimport", active: true, change: func(f map[string][]byte) { f[filepath.Join("data", "catalog.json")] = []byte("{") }, wantError: true},
		{name: "canonical future schema", change: func(f map[string][]byte) {
			for _, p := range catalogBootstrapLegacyParts(&old) {
				delete(f, filepath.Join("data", p.name))
			}
			f[filepath.Join("data", "catalog.json")] = bytes.Replace(bundled, []byte(`"schema_version":2`), []byte(`"schema_version":3`), 1)
		}, wantError: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			files := catalogBootstrapInput(bundled, &old)
			tc.change(files)
			data, backup, err := prepareCatalogBaseline(catalogBootstrapReader(files, nil), tc.active)
			if tc.wantError {
				if err == nil || data != nil || backup != nil {
					t.Fatal("failure became a usable/empty baseline")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if (backup != nil) != tc.wantLegacy {
				t.Fatal("wrong migration priority")
			}
			if _, err = catalog.Parse(data); err != nil {
				t.Fatal(err)
			}
		})
	}
	if _, _, err := prepareCatalogBaseline(nil, false); err == nil {
		t.Fatal("nil reader accepted")
	}
	permission := func(parts ...string) ([]byte, error) {
		if parts[len(parts)-1] == "moves.json" {
			return nil, os.ErrPermission
		}
		return catalogBootstrapReader(catalogBootstrapInput(bundled, &old), nil)(parts...)
	}
	if _, _, err := prepareCatalogBaseline(permission, false); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("old read failure hidden: %v", err)
	}
}

func TestCatalogBootstrapBackupRawBytesAndRepeat(t *testing.T) {
	_, files := catalogBootstrapFixture(t, "旧资料", 11)
	files.Monsters = append([]byte(" \n"), append(files.Monsters, '\n')...)
	dir := filepath.Join(t.TempDir(), "external-backups")
	for i := 0; i < 2; i++ {
		if err := backupLegacyCatalog(dir, files); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	name := catalogBootstrapBackupName(files)
	if len(entries) != 1 || entries[0].Name() != name || !strings.HasPrefix(name, "legacy-") || len(name) != 71 {
		t.Fatalf("unexpected backup directories: %v", entries)
	}
	bundle := filepath.Join(dir, name)
	children, err := os.ReadDir(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 4 {
		t.Fatal("backup wrote extra or arbitrary paths")
	}
	for _, part := range catalogBootstrapLegacyParts(&files) {
		got, err := os.ReadFile(filepath.Join(bundle, part.name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, *part.data) {
			t.Fatalf("raw bytes changed for %s", part.name)
		}
	}
	changed := files
	changed.Wiki = append(bytes.Clone(files.Wiki), ' ')
	if catalogBootstrapBackupName(changed) == name {
		t.Fatal("raw byte difference not covered by hash")
	}
	if err := backupLegacyCatalog(dir, changed); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatal("different data overwrote old hash directory")
	}
}

func TestCatalogBootstrapBackupNeverOverwritesConflict(t *testing.T) {
	_, files := catalogBootstrapFixture(t, "旧资料", 11)
	t.Run("same length different data", func(t *testing.T) {
		dir := t.TempDir()
		bundle := filepath.Join(dir, catalogBootstrapBackupName(files))
		if err := os.Mkdir(bundle, 0700); err != nil {
			t.Fatal(err)
		}
		bad := bytes.Repeat([]byte("X"), len(files.Monsters))
		name := filepath.Join(bundle, "monsters.json")
		if err := os.WriteFile(name, bad, 0600); err != nil {
			t.Fatal(err)
		}
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatal("different existing backup accepted")
		}
		got, err := os.ReadFile(name)
		if err != nil || !bytes.Equal(got, bad) {
			t.Fatal("conflicting backup overwritten")
		}
		entries, err := os.ReadDir(bundle)
		if err != nil || len(entries) != 1 {
			t.Fatal("wrote other members before rejecting corrupt existing backup")
		}
	})
	t.Run("hash path is regular file", func(t *testing.T) {
		dir := t.TempDir()
		name := filepath.Join(dir, catalogBootstrapBackupName(files))
		if err := os.WriteFile(name, []byte("keep"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatal("backup directory conflict ignored")
		}
		got, _ := os.ReadFile(name)
		if string(got) != "keep" {
			t.Fatal("hash-path conflict overwritten")
		}
	})
	t.Run("member is directory", func(t *testing.T) {
		dir := t.TempDir()
		name := filepath.Join(dir, catalogBootstrapBackupName(files), "monsters.json")
		if err := os.MkdirAll(name, 0700); err != nil {
			t.Fatal(err)
		}
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatal("nonregular backup member accepted")
		}
	})
}

func TestCatalogBootstrapBackupCompletesMissingMembersAndSerializes(t *testing.T) {
	_, files := catalogBootstrapFixture(t, "旧资料", 11)
	dir := t.TempDir()
	bundle := filepath.Join(dir, catalogBootstrapBackupName(files))
	if err := os.Mkdir(bundle, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bundle, "monsters.json"), files.Monsters, 0600); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- backupLegacyCatalog(dir, files) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, part := range catalogBootstrapLegacyParts(&files) {
		got, err := os.ReadFile(filepath.Join(bundle, part.name))
		if err != nil || !bytes.Equal(got, *part.data) {
			t.Fatalf("partial repeat did not retain exact %s", part.name)
		}
	}
}

func TestCatalogBootstrapBackupRejectsUnsafeDirectories(t *testing.T) {
	_, files := catalogBootstrapFixture(t, "旧资料", 11)
	for _, dir := range []string{"", ".", "relative-backups", filepath.VolumeName(t.TempDir()) + string(filepath.Separator)} {
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatalf("unsafe directory accepted: %q", dir)
		}
	}
	dir := filepath.Join(t.TempDir(), "must-not-exist")
	if err := backupLegacyCatalog(dir, catalog.LegacyFiles{}); err == nil {
		t.Fatal("empty original files accepted")
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid input created a backup directory")
	}
}

func TestCatalogBootstrapBackupRejectsSymlinks(t *testing.T) {
	_, files := catalogBootstrapFixture(t, "旧资料", 11)
	link := func(t *testing.T, target, name string) {
		t.Helper()
		if err := os.Symlink(target, name); err != nil {
			if runtime.GOOS == "windows" {
				t.Skipf("symlink privilege unavailable: %v", err)
			}
			t.Fatal(err)
		}
	}
	t.Run("configured root", func(t *testing.T) {
		base := t.TempDir()
		outside := filepath.Join(base, "outside")
		if err := os.Mkdir(outside, 0700); err != nil {
			t.Fatal(err)
		}
		destination := filepath.Join(base, "link")
		link(t, outside, destination)
		if err := backupLegacyCatalog(destination, files); err == nil {
			t.Fatal("followed backup root symlink")
		}
		entries, _ := os.ReadDir(outside)
		if len(entries) != 0 {
			t.Fatal("wrote through root symlink")
		}
	})
	t.Run("content directory", func(t *testing.T) {
		dir := t.TempDir()
		outside := t.TempDir()
		link(t, outside, filepath.Join(dir, catalogBootstrapBackupName(files)))
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatal("followed hash-directory symlink")
		}
		entries, _ := os.ReadDir(outside)
		if len(entries) != 0 {
			t.Fatal("wrote through hash-directory symlink")
		}
	})
	t.Run("member", func(t *testing.T) {
		dir := t.TempDir()
		bundle := filepath.Join(dir, catalogBootstrapBackupName(files))
		if err := os.Mkdir(bundle, 0700); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(t.TempDir(), "original")
		if err := os.WriteFile(target, files.Monsters, 0600); err != nil {
			t.Fatal(err)
		}
		link(t, target, filepath.Join(bundle, "monsters.json"))
		if err := backupLegacyCatalog(dir, files); err == nil {
			t.Fatal("followed backup member symlink")
		}
	})
}

func TestCatalogBootstrapRepeatedInitializationDoesNotReimport(t *testing.T) {
	bundled, _ := catalogBootstrapFixture(t, "新内置", 100)
	_, old := catalogBootstrapFixture(t, "旧本地", 11, 99)
	files := catalogBootstrapInput(bundled, &old)
	read := catalogBootstrapReader(files, nil)
	first, raw, err := prepareCatalogBaseline(read, false)
	if err != nil || raw == nil {
		t.Fatalf("initial migration failed: %v", err)
	}
	dir := t.TempDir()
	if err = backupLegacyCatalog(dir, *raw); err != nil {
		t.Fatal(err)
	}
	retry, retryRaw, err := prepareCatalogBaseline(read, false)
	if err != nil || !bytes.Equal(first, retry) || retryRaw == nil {
		t.Fatal("pre-commit retry is not deterministic")
	}
	if err = backupLegacyCatalog(dir, *retryRaw); err != nil {
		t.Fatal(err)
	}
	// The caller has now committed current.json. This helper returns the bundled
	// fallback only; Store.Open, not this helper, loads the immutable active data.
	files[filepath.Join("data", "monsters.json")] = []byte("stale, now corrupt")
	next, again, err := prepareCatalogBaseline(read, true)
	if err != nil || again != nil || !bytes.Equal(next, bundled) {
		t.Fatal("post-commit initialization reimported stale local files")
	}
	preserved, err := os.ReadFile(filepath.Join(dir, catalogBootstrapBackupName(old), "monsters.json"))
	if err != nil || !bytes.Equal(preserved, old.Monsters) {
		t.Fatal("initial raw backup changed on repeated initialization")
	}
}
