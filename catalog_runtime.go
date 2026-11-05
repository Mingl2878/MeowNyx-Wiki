package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
)

// A runtime is created explicitly by main, never by a package initializer. Tests
// inject temporary roots and never inherit a developer's real AppData catalog.
var activeCatalog *catalogRuntime

type catalogRuntime struct {
	store        *catalogstore.Store
	initErr      error
	baselineRoot string
	mutationMu   sync.Mutex
	update       *catalogUpdateManager

	viewMu sync.Mutex
	views  [2]*catalogRuntimeView // bounded: bundled/active, or active/candidate
}

// All fields remain private to the runtime. The parsed object is never handed
// to an editor/updater, and exported byte slices are cloned on return. A cached
// candidate is NOT an active snapshot: only Store.Current decides what to serve.
type catalogRuntimeView struct {
	data    []byte
	catalog *catalog.Catalog
	legacy  *catalog.LegacyFiles
}

func initCatalogRuntime(exeDir string) *catalogRuntime {
	rt := &catalogRuntime{baselineRoot: exeDir}
	exeDir, err := filepath.Abs(exeDir)
	if err != nil {
		rt.initErr = err
		return rt
	}
	rt.baselineRoot = exeDir
	root := filepath.Join(exeDir, "data", "catalog-assets")
	canonicalFile := filepath.Join(exeDir, "data", "catalog.json")
	backup := filepath.Join(getUserDataDir(), "catalog-backups")
	// Development builds keep backups in the established project-external root.
	for dir := exeDir; ; dir = filepath.Dir(dir) {
		if _, e := os.Stat(filepath.Join(dir, "AGENTS.md")); e == nil {
			if _, e = os.Stat(filepath.Join(dir, "go.mod")); e == nil {
				backup = filepath.Join(filepath.Dir(dir), "old", filepath.Base(dir)+"-backups", "data-updates", "runtime")
				break
			}
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	// The executable-adjacent file is the only default catalog source. Ignore
	// retired per-user pointer roots, including XHM_CATALOG_ROOT; explicit
	// developer/test pointer stores remain available through open below.
	if override := os.Getenv("XHM_CATALOG_BACKUP_ROOT"); override != "" {
		if !filepath.IsAbs(override) {
			rt.initErr = errors.New("XHM_CATALOG_BACKUP_ROOT 必须是绝对路径")
			return rt
		}
		backup = override
	}
	rt.openBundled(root, canonicalFile, backup)
	return rt
}

// openBundled reads the actual executable-adjacent catalog, not the appFS
// website fallback or any retired user pointer. Opening is strictly read-only:
// no legacy bootstrap, backup migration, initial commit or image-root creation.
func (rt *catalogRuntime) openBundled(root, canonicalFile, backup string) {
	rt.store, rt.initErr = catalogstore.Open(catalogstore.Options{Root: root, CanonicalFile: canonicalFile, BackupDir: backup, Replace: replaceUserConfigFile, Validate: rt.validateData})
	if rt.initErr == nil {
		_, _, rt.initErr = rt.legacySnapshot()
	}
	if rt.initErr == nil {
		rt.update = newCatalogUpdateManager(rt)
	}
}

// open is the same initialization path used by main, with explicit filesystem
// inputs so startup benchmarks/tests cannot resolve or write real AppData.
func (rt *catalogRuntime) open(read func(...string) ([]byte, error), root, backup string) {
	_, pointerErr := os.Stat(filepath.Join(root, "current.json"))
	if pointerErr != nil && !errors.Is(pointerErr, os.ErrNotExist) {
		rt.initErr = pointerErr
		return
	}
	baseline, legacy, err := prepareCatalogBaselineValidated(read, pointerErr == nil, rt.validateData)
	if err != nil {
		rt.initErr = fmt.Errorf("无法准备图鉴资料: %w", err)
		return
	}
	rt.store, rt.initErr = catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, Baseline: baseline, Replace: replaceUserConfigFile, Validate: rt.validateData})
	if rt.initErr == nil && legacy != nil {
		if rt.initErr = backupLegacyCatalog(backup, *legacy); rt.initErr == nil {
			_, rt.initErr = rt.store.Commit(baseline, rt.store.Current().Revision, nil)
		}
	}
	if rt.initErr == nil {
		// Build the compatibility view once from the already-validated active
		// catalog before serving requests, not once per JSON file or page reload.
		// Both Parse and ExportLegacy retain all their validation checks.
		_, _, rt.initErr = rt.legacySnapshot()
	}
	if rt.initErr == nil {
		rt.update = newCatalogUpdateManager(rt)
		if legacy != nil {
			rt.update.status.Message = catalogLegacyBootstrapMessage
		}
	}
}

func (rt *catalogRuntime) validateData(data []byte) error {
	rt.viewMu.Lock()
	defer rt.viewMu.Unlock()
	_, err := rt.validatedViewLocked(data)
	return err
}

// Caller holds viewMu. Equality is over owned, exact bytes, not a caller-supplied
// revision, timestamp or extension subset. Changed and invalid baselines always
// go through strict Parse (including duplicate keys and future-version checks).
// No negative results are cached, and only two valid generations are retained.
func (rt *catalogRuntime) validatedViewLocked(data []byte) (*catalogRuntimeView, error) {
	for i, view := range rt.views {
		if view != nil && bytes.Equal(view.data, data) {
			if i != 0 {
				rt.views[0], rt.views[i] = view, rt.views[0]
			}
			return view, nil
		}
	}
	c, err := catalog.Parse(data)
	if err != nil {
		return nil, err
	}
	if err := catalogrecovery.Validate(c); err != nil {
		return nil, err
	}
	view := &catalogRuntimeView{data: bytes.Clone(data), catalog: c}
	rt.views[1], rt.views[0] = rt.views[0], view
	return view, nil
}

func (rt *catalogRuntime) legacySnapshot() (catalogstore.Snapshot, catalog.LegacyFiles, error) {
	if rt == nil || rt.initErr != nil {
		if rt != nil {
			return catalogstore.Snapshot{}, catalog.LegacyFiles{}, rt.initErr
		}
		return catalogstore.Snapshot{}, catalog.LegacyFiles{}, errors.New("图鉴尚未初始化")
	}
	// Never take the store lock while holding viewMu: Commit invokes validateData
	// under the store lock. Snapshot bytes/recovery stay pinned across a commit.
	snap := rt.store.Current()
	rt.viewMu.Lock()
	defer rt.viewMu.Unlock()
	view, err := rt.validatedViewLocked(snap.Data)
	if err != nil {
		return snap, catalog.LegacyFiles{}, err
	}
	if view.legacy == nil {
		files, err := catalog.ExportLegacy(view.catalog)
		if err != nil {
			return snap, catalog.LegacyFiles{}, err
		}
		view.legacy = &files
	}
	files := view.legacy
	return snap, catalog.LegacyFiles{Monsters: bytes.Clone(files.Monsters), Moves: bytes.Clone(files.Moves), Types: bytes.Clone(files.Types), Wiki: bytes.Clone(files.Wiki)}, nil
}
func (rt *catalogRuntime) handleData(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	if r.Method != http.MethodGet {
		configError(w, 405, errors.New("只支持GET"))
		return
	}
	snap, files, err := rt.legacySnapshot()
	if err != nil {
		configError(w, 503, err)
		return
	}
	// One response pins all four compatibility views to exactly one generation.
	body, err := json.Marshal(map[string]any{"ok": true, "format": "meownyx-catalog-view/1", "revision": snap.Revision, "recovery": snap.Recovery, "monsters": json.RawMessage(files.Monsters), "moves": json.RawMessage(files.Moves), "types": json.RawMessage(files.Types), "wiki": json.RawMessage(files.Wiki)})
	if err != nil {
		configError(w, 500, err)
		return
	}
	writeJSON(w, 200, body)
}
func (rt *catalogRuntime) staticData(name string) ([]byte, bool, error) {
	if name == "data/catalog.json" {
		if rt.initErr != nil {
			return nil, true, rt.initErr
		}
		return rt.store.Current().Data, true, nil
	}
	switch name {
	case "data/monsters.json", "data/moves.json", "data/types.json", "data/wiki_monster_data.json":
		_, files, err := rt.legacySnapshot()
		if err != nil {
			return nil, true, err
		}
		switch name {
		case "data/monsters.json":
			return files.Monsters, true, nil
		case "data/moves.json":
			return files.Moves, true, nil
		case "data/types.json":
			return files.Types, true, nil
		default:
			return files.Wiki, true, nil
		}
	}
	prefix := "assets/monster/images/catalog/"
	if strings.HasPrefix(name, prefix) {
		if rt.initErr != nil {
			return nil, true, rt.initErr
		}
		b, err := rt.store.Image(strings.TrimPrefix(name, prefix))
		return b, true, err
	}
	return nil, false, nil
}

// Existing manual-edit validation is reused only against an isolated temporary
// projection. Its file writes never touch active data. The result is normalized
// and committed via the SAME snapshot transaction as an official update.
func (rt *catalogRuntime) handleManual(w http.ResponseWriter, r *http.Request, kind string) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		configError(w, 405, errors.New("只支持POST"))
		return
	}
	if rt.initErr != nil {
		configError(w, 503, rt.initErr)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		configError(w, 400, err)
		return
	}
	if err = checkJSON(body); err != nil {
		configError(w, 400, err)
		return
	}
	var base struct {
		Revision string `json:"base_revision"`
	}
	if err = json.Unmarshal(body, &base); err != nil {
		configError(w, 400, err)
		return
	}
	rt.mutationMu.Lock()
	defer rt.mutationMu.Unlock()
	snap, files, err := rt.legacySnapshot()
	if err != nil {
		configError(w, 503, err)
		return
	}
	if base.Revision == "" || base.Revision != snap.Revision {
		configError(w, 409, catalogstore.ErrConflict)
		return
	}
	originalFiles := files
	dir, err := os.MkdirTemp("", "meownyx-catalog-edit-*")
	if err != nil {
		configError(w, 500, err)
		return
	}
	defer os.RemoveAll(dir) // only this CreateTemp result, never caller input
	monsterPath := filepath.Join(dir, "monsters.json")
	movePath := filepath.Join(dir, "moves.json")
	wikiPath := filepath.Join(dir, "wiki_monster_data.json")
	for name, data := range map[string][]byte{monsterPath: files.Monsters, movePath: files.Moves, wikiPath: files.Wiki} {
		if err = os.WriteFile(name, data, 0600); err != nil {
			configError(w, 500, err)
			return
		}
	}
	copyRequest := r.Clone(r.Context())
	copyRequest.Body = io.NopCloser(bytes.NewReader(body))
	response := &catalogBufferedResponse{header: make(http.Header)}
	switch kind {
	case "edit":
		handleEditMonsterFiles(response, copyRequest, monsterPath, wikiPath, movePath)
	case "add-monster":
		handleAddMonsterFiles(response, copyRequest, monsterPath, wikiPath, movePath)
	case "add-move":
		handleAddMoveFiles(response, copyRequest, movePath)
	default:
		configError(w, 400, errors.New("未知编辑操作"))
		return
	}
	if response.status >= 400 {
		writeJSON(w, response.status, response.body.Bytes())
		return
	}
	if files.Monsters, err = os.ReadFile(monsterPath); err == nil {
		files.Moves, err = os.ReadFile(movePath)
	}
	if err == nil {
		files.Wiki, err = os.ReadFile(wikiPath)
	}
	if err != nil {
		configError(w, 500, err)
		return
	}
	if err = completeManualReferences(&files, originalFiles); err != nil {
		configError(w, 400, err)
		return
	}
	c, err := catalog.ImportLegacy(files)
	if err != nil {
		configError(w, 400, err)
		return
	}
	if err = preserveCatalogExtensions(c, snap.Data); err != nil {
		configError(w, 500, err)
		return
	}
	data, err := catalog.Marshal(c)
	if err != nil {
		configError(w, 500, err)
		return
	}
	committed, err := rt.store.Commit(data, snap.Revision, nil)
	if err != nil {
		status := 500
		if errors.Is(err, catalogstore.ErrConflict) {
			status = 409
		}
		configError(w, status, err)
		return
	}
	out, _ := json.Marshal(map[string]any{"ok": true, "revision": committed.Revision})
	writeJSON(w, 200, out)
}

// Root metadata has no legacy-view representation. Never lose it while routing
// existing editor forms or source adapters through the compatibility projection.
func preserveCatalogExtensions(candidate *catalog.Catalog, before []byte) error {
	previous, err := catalog.Parse(before)
	if err != nil {
		return err
	}
	candidate.Extensions = previous.Extensions
	return nil
}

// Legacy forms submit a type code, not a full type object. Resolve it only
// against the known local type dictionary; never invent a new attribute ID.
func completeManualReferences(files *catalog.LegacyFiles, before catalog.LegacyFiles) error {
	var types, monsters, skills, previousMonsters, previousSkills []map[string]interface{}
	var wiki map[string]interface{}
	for _, item := range []struct {
		data   []byte
		target any
	}{
		{files.Types, &types}, {files.Monsters, &monsters}, {files.Moves, &skills}, {files.Wiki, &wiki},
		{before.Monsters, &previousMonsters}, {before.Moves, &previousSkills},
	} {
		if err := json.Unmarshal(item.data, item.target); err != nil {
			return err
		}
	}
	byCode := map[string]map[string]interface{}{}
	for _, t := range types {
		code, _ := t["name"].(string)
		byCode[code] = t
	}
	byCode["None"] = map[string]interface{}{"id": 0, "name": "None", "localized": map[string]interface{}{"zh": "无"}, "vulnerable_to": []string{}, "resistant_to": []string{}}
	fillType := func(row map[string]interface{}, key string) error {
		value := row[key]
		if value == nil {
			return nil
		}
		ref, ok := value.(map[string]interface{})
		if !ok {
			return fmt.Errorf("%s 属性格式无效", key)
		}
		if _, hasID := ref["id"]; hasID {
			return nil
		}
		code, _ := ref["name"].(string)
		definition := byCode[code]
		if definition == nil {
			return fmt.Errorf("未知属性：%s", code)
		}
		row[key] = cloneObject(definition)
		return nil
	}
	oldMonsters := map[int]bool{}
	oldSkills := map[int]bool{}
	for _, row := range previousMonsters {
		id, _ := numericMonsterID(row["id"])
		oldMonsters[id] = true
	}
	for _, row := range previousSkills {
		id, _ := numericMonsterID(row["id"])
		oldSkills[id] = true
	}
	for _, row := range monsters {
		if err := fillType(row, "main_type"); err != nil {
			return err
		}
		if err := fillType(row, "sub_type"); err != nil {
			return err
		}
		row["is_leader_form"] = row["evolution_stage"] == "首领形态"
		id, err := numericMonsterID(row["id"])
		if err != nil {
			return err
		}
		if !oldMonsters[id] {
			if _, ok := row["learnset_mode"]; !ok {
				row["learnset_mode"] = "own"
			}
			name := monsterDisplayName(row)
			if _, exists := wiki[name]; !exists {
				wiki[name] = map[string]interface{}{"monster_id": id, "image": "", "skills": []interface{}{}}
			}
		}
	}
	for _, row := range skills {
		if err := fillType(row, "move_type"); err != nil {
			return err
		}
		id, err := numericMonsterID(row["id"])
		if err != nil {
			return err
		}
		if !oldSkills[id] {
			if _, ok := row["season"]; !ok {
				row["season"] = ""
			} // unknown, never guessed S1
			if _, ok := row["power_formula"]; !ok {
				row["power_formula"] = nil
			}
			if value, ok := row["base_combo"].(float64); ok && value == 0 {
				row["base_combo"] = nil
			}
			if _, ok := row["base_combo"]; !ok {
				row["base_combo"] = nil
			}
		}
	}
	var err error
	files.Monsters, err = json.Marshal(monsters)
	if err != nil {
		return err
	}
	files.Moves, err = json.Marshal(skills)
	if err != nil {
		return err
	}
	files.Wiki, err = json.Marshal(wiki)
	return err
}

type catalogBufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *catalogBufferedResponse) Header() http.Header { return w.header }
func (w *catalogBufferedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *catalogBufferedResponse) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.body.Write(b)
}
