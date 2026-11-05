package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
)

// These tests exercise the real default constructor, but every application,
// personal, pointer, asset and backup path is confined to t.TempDir. The real
// bundled catalog is read only, copied unchanged, and never used as a write path.
type catalogBundledFixture struct {
	dir, exeDir, personal, backup string
}

func catalogBundledWrite(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func catalogBundledNew(t *testing.T, raw []byte) catalogBundledFixture {
	t.Helper()
	dir := t.TempDir()
	f := catalogBundledFixture{dir: dir, exeDir: filepath.Join(dir, "app"), backup: filepath.Join(dir, "backups")}
	t.Setenv("APPDATA", filepath.Join(dir, "AppData"))
	f.personal = getUserDataDir()
	if !strings.HasPrefix(f.personal, dir+string(filepath.Separator)) {
		t.Fatal("personal root escaped the temporary directory")
	}
	t.Setenv("XHM_CATALOG_ROOT", filepath.Join(f.personal, "catalog"))
	t.Setenv("XHM_CATALOG_BACKUP_ROOT", f.backup)
	if err := os.MkdirAll(f.exeDir, 0700); err != nil {
		t.Fatal(err)
	}
	if raw != nil {
		catalogBundledWrite(t, filepath.Join(f.exeDir, "data", "catalog.json"), raw)
	}
	old, _ := catalogBootstrapFixture(t, "旧AppData", 11)
	revision := catalogstore.Hash(old)
	for name, data := range map[string][]byte{
		"user-config.json":                       []byte("{\n  \"personal\": {\"619\": {\"iv\": 54, \"nature\": 2}}, \"unknown\": true\n}\n"),
		"teams.json":                             []byte("{\"teams\":[{\"id\":\"keep-team\",\"members\":[619,623]}]}\n"),
		"settings.json":                          []byte("{\"theme\":\"dark\",\"trick_room\":true}\n"),
		"favorites.json":                         []byte("[619,623]\n"),
		"battle-records.sqlite":                  []byte("SQLite format 3\x00test-owned battle bytes"),
		"catalog/current.json":                   []byte(`{"version":1,"revision":"` + revision + `","updated_at":"old"}`),
		"catalog/previous.json":                  []byte(`{"version":99,"revision":"retired-future-pointer"}`),
		"catalog/versions/" + revision + ".json": old,
	} {
		catalogBundledWrite(t, filepath.Join(f.personal, filepath.FromSlash(name)), data)
	}
	oldFS, oldRoot := appFS, appRoot
	appFS, appRoot = os.DirFS(f.exeDir), ""
	t.Cleanup(func() { appFS, appRoot = oldFS, oldRoot })
	return f
}

type catalogBundledTreeEntry struct {
	Mode     fs.FileMode
	Size     int64
	Modified int64
	Data     string
}

func catalogBundledTree(t *testing.T, root string) map[string]catalogBundledTreeEntry {
	t.Helper()
	entries := map[string]catalogBundledTreeEntry{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		entry := catalogBundledTreeEntry{Mode: info.Mode(), Size: info.Size(), Modified: info.ModTime().UnixNano()}
		if !d.IsDir() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			entry.Data = string(data)
		}
		entries[rel] = entry
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return entries
}

func catalogBundledTreeEqual(t *testing.T, before, after map[string]catalogBundledTreeEntry) bool {
	t.Helper()
	if reflect.DeepEqual(before, after) {
		return true
	}
	for name, old := range before {
		current, exists := after[name]
		if !exists || current != old {
			t.Logf("tree changed %s: exists=%v mode=%v/%v size=%d/%d modified=%d/%d bytesEqual=%v", name, exists, old.Mode, current.Mode, old.Size, current.Size, old.Modified, current.Modified, old.Data == current.Data)
		}
	}
	for name := range after {
		if _, exists := before[name]; !exists {
			t.Logf("tree added %s", name)
		}
	}
	return false
}

func catalogBundledOpen(t *testing.T, f catalogBundledFixture) *catalogRuntime {
	t.Helper()
	rt := initCatalogRuntime(f.exeDir)
	if rt.initErr != nil {
		t.Fatal(rt.initErr)
	}
	t.Cleanup(rt.update.Close)
	if rt.update.status.State != "idle" || rt.update.status.Message != "" {
		t.Fatal("startup performed an update or added a migration warning")
	}
	return rt
}

func TestCatalogBundledRuntimeDefaultIgnoresPersonalPointersAndAppFSFallback(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("data", "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	want, err := catalog.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	f := catalogBundledNew(t, raw)
	// Exercise appReadFile's nonempty appRoot pipeline with a stale website
	// fallback: neither it nor XHM_CATALOG_ROOT may replace the actual EXE file.
	old, _ := catalogBootstrapFixture(t, "旧网站", 11)
	catalogBundledWrite(t, filepath.Join(f.dir, "cached-site", "data", "catalog.json"), old)
	appFS, appRoot = os.DirFS(f.dir), "cached-site"
	if read, err := appReadFile("data", "catalog.json"); err != nil || !bytes.Equal(read, old) {
		t.Fatal("fixture did not isolate the appReadFile fallback", err)
	}
	before := catalogBundledTree(t, f.dir)
	rt := catalogBundledOpen(t, f)
	snap, files, err := rt.legacySnapshot()
	if err != nil || snap.Revision != catalogstore.Hash(raw) || !bytes.Equal(snap.Data, raw) || !reflect.DeepEqual(files, want) || snap.Recovery != "" {
		t.Fatal("default constructor did not serve the complete physical bundled catalog", err)
	}
	w := httptest.NewRecorder()
	rt.handleData(w, catalogTestRequest(http.MethodGet, "/api/catalog/data", nil))
	wantBody := catalogTestJSON(t, map[string]any{"ok": true, "format": "meownyx-catalog-view/1", "revision": snap.Revision, "recovery": "", "monsters": json.RawMessage(want.Monsters), "moves": json.RawMessage(want.Moves), "types": json.RawMessage(want.Types), "wiki": json.RawMessage(want.Wiki)})
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), wantBody) {
		t.Fatal("GET data returned the stale AppData projection or an incomplete bundle", w.Code)
	}
	var monsters, skills []map[string]any
	if err := json.Unmarshal(files.Monsters, &monsters); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(files.Moves, &skills); err != nil {
		t.Fatal(err)
	}
	if len(monsters) != len(c.Monsters) || len(skills) != len(c.Skills) {
		t.Fatal("GET projection dropped declared bundled records")
	}
	monsterIDs, skillIDs := map[int]bool{}, map[int]bool{}
	for _, row := range monsters {
		monsterIDs[int(row["id"].(float64))] = true
	}
	for _, row := range skills {
		skillIDs[int(row["id"].(float64))] = true
	}
	for id := 624; id <= 652; id++ {
		if !monsterIDs[id] {
			t.Fatalf("new bundled monster %d was shadowed", id)
		}
	}
	for id := 5963; id <= 5991; id++ {
		if !skillIDs[id] {
			t.Fatalf("new bundled skill %d was shadowed", id)
		}
	}
	got, handled, err := rt.staticData("data/catalog.json")
	if err != nil || !handled || !bytes.Equal(got, raw) {
		t.Fatal("static canonical data disagrees with API data", err)
	}
	if !catalogBundledTreeEqual(t, before, catalogBundledTree(t, f.dir)) {
		t.Fatal("startup/GET wrote, migrated or removed a temporary application/personal/backup file")
	}
	t.Logf("served all %d declared monsters and %d declared skills", len(monsters), len(skills))
}

func TestCatalogBundledRuntimeStrictFileWithoutLegacyBootstrap(t *testing.T) {
	valid, legacy := catalogBootstrapFixture(t, "有效", 11)
	for name, raw := range map[string][]byte{
		"missing":   nil,
		"empty":     {},
		"malformed": []byte("{"),
		"future":    bytes.Replace(valid, []byte(`"schema_version":2`), []byte(`"schema_version":99`), 1),
		"duplicate": append([]byte(`{"schema_version":2,`), valid[1:]...),
		"trailing":  append(bytes.Clone(valid), []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			f := catalogBundledNew(t, raw)
			for _, part := range catalogBootstrapLegacyParts(&legacy) {
				catalogBundledWrite(t, filepath.Join(f.exeDir, "data", part.name), *part.data)
			}
			before := catalogBundledTree(t, f.dir)
			rt := initCatalogRuntime(f.exeDir)
			if rt.initErr == nil || rt.store != nil || rt.update != nil {
				t.Fatal("invalid/missing physical file silently fell back to a legacy or empty catalog")
			}
			if name == "future" && !errors.Is(rt.initErr, catalogstore.ErrFutureVersion) {
				t.Fatal("future schema lost its strict error", rt.initErr)
			}
			if !catalogBundledTreeEqual(t, before, catalogBundledTree(t, f.dir)) {
				t.Fatal("failed startup wrote, migrated or removed fixture files")
			}
		})
	}
	// Even complete empty legacy fixtures are inert when canonical is valid.
	f := catalogBundledNew(t, valid)
	for _, part := range catalogBootstrapLegacyParts(&legacy) {
		data := []byte("[]")
		if part.name == "wiki_monster_data.json" {
			data = []byte("{}")
		}
		catalogBundledWrite(t, filepath.Join(f.exeDir, "data", part.name), data)
	}
	t.Setenv("XHM_CATALOG_ROOT", "retired-relative-root")
	before := catalogBundledTree(t, f.dir)
	rt := catalogBundledOpen(t, f)
	if !bytes.Equal(rt.store.Current().Data, valid) || !catalogBundledTreeEqual(t, before, catalogBundledTree(t, f.dir)) {
		t.Fatal("empty legacy files or retired environment root affected valid default startup")
	}
}

func TestCatalogBundledRuntimeCommitAndImageUseExecutablePaths(t *testing.T) {
	before, _ := catalogBootstrapFixture(t, "原始", 11)
	next, _ := catalogBootstrapFixture(t, "编辑后", 11, 12)
	f := catalogBundledNew(t, before)
	personalBefore := catalogBundledTree(t, f.personal)
	rt := catalogBundledOpen(t, f)
	image := []byte("test-owned immutable image bytes")
	imageName := catalogstore.Hash(image) + ".png"
	snap, err := rt.store.Commit(next, rt.store.Current().Revision, map[string][]byte{imageName: image})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := os.ReadFile(filepath.Join(f.exeDir, "data", "catalog.json"))
	if err != nil || !bytes.Equal(canonical, next) || snap.Revision != catalogstore.Hash(next) {
		t.Fatal("normal commit did not atomically update the executable-adjacent catalog", err)
	}
	backup, err := os.ReadFile(filepath.Join(f.backup, catalogstore.Hash(before)+".json"))
	if err != nil || !bytes.Equal(backup, before) {
		t.Fatal("normal commit did not preserve exact pre-write backup", err)
	}
	root := filepath.Join(f.exeDir, "data", "catalog-assets")
	storedImage, err := os.ReadFile(filepath.Join(root, "images", imageName))
	if err != nil || !bytes.Equal(storedImage, image) {
		t.Fatal("image was not stored under the executable's catalog-assets root", err)
	}
	for _, name := range []string{"current.json", "previous.json", "versions"} {
		if _, err := os.Stat(filepath.Join(root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("canonical mode wrote a retired pointer/version path", name, err)
		}
	}
	reopened := catalogBundledOpen(t, f)
	if !bytes.Equal(reopened.store.Current().Data, next) {
		t.Fatal("reopen did not use the edited canonical file")
	}
	got, handled, err := reopened.staticData("assets/monster/images/catalog/" + imageName)
	if err != nil || !handled || !bytes.Equal(got, image) {
		t.Fatal("existing catalog image route did not use the new image root", err)
	}
	if _, handled, _ := reopened.staticData("assets/monster/images/bundled.png"); handled {
		t.Fatal("ordinary bundled static image route changed")
	}
	if !reflect.DeepEqual(personalBefore, catalogBundledTree(t, f.personal)) {
		t.Fatal("commit/reopen modified personal configurations, teams, battles or retired AppData catalog")
	}
}

func TestCatalogBundledRuntimeBackupResolutionRemainsExternal(t *testing.T) {
	before, _ := catalogBootstrapFixture(t, "原始", 11)
	next, _ := catalogBootstrapFixture(t, "修改", 11)
	f := catalogBundledNew(t, before)
	t.Setenv("XHM_CATALOG_BACKUP_ROOT", "relative-backup")
	tree := catalogBundledTree(t, f.dir)
	if rt := initCatalogRuntime(f.exeDir); rt.initErr == nil || !reflect.DeepEqual(tree, catalogBundledTree(t, f.dir)) {
		t.Fatal("relative backup override was accepted or wrote files")
	}
	t.Setenv("XHM_CATALOG_BACKUP_ROOT", "")
	project := filepath.Join(f.dir, "source-project")
	catalogBundledWrite(t, filepath.Join(project, "AGENTS.md"), []byte("test-owned development marker"))
	catalogBundledWrite(t, filepath.Join(project, "go.mod"), []byte("module test-owned\n"))
	f.exeDir = filepath.Join(project, "dist", "app")
	catalogBundledWrite(t, filepath.Join(f.exeDir, "data", "catalog.json"), before)
	personalBefore := catalogBundledTree(t, f.personal)
	rt := catalogBundledOpen(t, f)
	if _, err := rt.store.Commit(next, rt.store.Current().Revision, nil); err != nil {
		t.Fatal(err)
	}
	backupRoot := filepath.Join(f.dir, "old", "source-project-backups", "data-updates", "runtime")
	backup, err := os.ReadFile(filepath.Join(backupRoot, catalogstore.Hash(before)+".json"))
	if err != nil || !bytes.Equal(backup, before) || !reflect.DeepEqual(personalBefore, catalogBundledTree(t, f.personal)) {
		t.Fatal("development backup resolver changed or personal files were modified", err)
	}
}
