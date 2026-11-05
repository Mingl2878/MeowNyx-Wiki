// mingulongdata is a developer-only, offline patch for the approved 619 data.
// It has no implicit paths or runtime integration. Default operation is audit.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
)

const (
	monsterID       = 619
	monsterName     = "冥古龙"
	traitID         = "trait-e6337fff38ccbd5fe07994daac0d1075"
	traitName       = "资料待补充"
	oldDescription  = "测试占位；尚未录入正式特性。"
	newDescription  = "初始等级+39，回合结束时等级-10，低于80级时受到伤害+40%。"
	oldNote         = "等级公式测试占位：六项资质暂定100；正式属性、形态、特性、技能和图片待补充。无属性仅为测试占位，不表示游戏真实属性。"
	newNote         = "资质与特性效果由用户补充；特性名称、正式属性、形态、技能和图片待补充。无属性仅为占位，不表示游戏真实属性。"
	dragonGhostNote = "资质、属性与特性效果由用户补充；特性名称、形态、技能和图片待补充。"
)

type patchMode string

const (
	statsMode       patchMode = "stats"
	dragonGhostMode patchMode = "dragon-ghost"
)

type change struct {
	Path   string `json:"path"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("mingulongdata", flag.ContinueOnError)
	dragonGhost := flags.Bool("dragon-ghost", false, "only approve 619 main Dragon (8), secondary Ghost (15), and the exact updated note; requires prior stats/trait patch")
	input := flags.String("catalog", "", "explicit canonical file; read-only validation baseline when -store-root is set")
	output := flags.String("out", "", "new candidate only; existing files refused; omit for audit")
	writeCatalogFlag := flags.Bool("write-catalog", false, "explicitly replace -catalog after backup and exact revision checks")
	storeRoot := flags.String("store-root", "", "explicit absolute immutable store; requires an existing valid current.json, never falls back")
	backupDir := flags.String("backup-dir", "", "explicit absolute external backup directory; required for writes and store access")
	commitLocal := flags.Bool("commit-local", false, "commit only to the specified closed-app local store")
	expected := flags.String("expected-revision", "", "exact current_revision from audit; required for either commit mode")
	appClosed := flags.Bool("app-closed", false, "acknowledge app fully closed and finished saving; required for local commit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" || flags.NArg() != 0 {
		return fmt.Errorf("required: -catalog <explicit-file>; default audit, no implicit paths")
	}
	if (*writeCatalogFlag && *commitLocal) || (*output != "" && (*writeCatalogFlag || *commitLocal)) {
		return fmt.Errorf("-out, -write-catalog and -commit-local are mutually exclusive")
	}
	if *writeCatalogFlag && *storeRoot != "" {
		return fmt.Errorf("-write-catalog cannot be combined with -store-root")
	}
	if *commitLocal && (*storeRoot == "" || !*appClosed) {
		return fmt.Errorf("-commit-local requires -store-root and -app-closed")
	}
	if *appClosed && !*commitLocal {
		return fmt.Errorf("-app-closed requires -commit-local")
	}
	if (*writeCatalogFlag || *commitLocal) && (*expected == "" || *backupDir == "") {
		return fmt.Errorf("writes require -expected-revision and absolute external -backup-dir")
	}
	if *backupDir != "" && *storeRoot == "" && !*writeCatalogFlag {
		return fmt.Errorf("-backup-dir requires -store-root or -write-catalog")
	}
	inputPath, err := resolvedPath(*input)
	if err != nil {
		return err
	}
	var backupPath, rootPath string
	if *storeRoot != "" {
		if !filepath.IsAbs(*storeRoot) || !filepath.IsAbs(*backupDir) {
			return fmt.Errorf("store access requires explicit absolute -store-root and -backup-dir")
		}
		rootPath, err = resolvedPath(*storeRoot)
		if err != nil {
			return err
		}
	}
	if *backupDir != "" {
		if !filepath.IsAbs(*backupDir) {
			return fmt.Errorf("-backup-dir must be absolute and external")
		}
		backupPath, err = resolvedPath(*backupDir)
		if err != nil {
			return err
		}
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		cwd, err = resolvedPath(cwd)
		if err != nil {
			return err
		}
		inputRoot := filepath.Dir(inputPath)
		if strings.EqualFold(filepath.Base(inputRoot), "data") {
			inputRoot = filepath.Dir(inputRoot)
		}
		for _, protected := range []string{cwd, inputRoot, rootPath} {
			if protected != "" && (sameOrWithin(protected, backupPath) || sameOrWithin(backupPath, protected)) {
				return fmt.Errorf("backup directory must be separate from project, catalog and store directories")
			}
		}
	}
	raw, err := readBounded(inputPath, catalogstore.MaxCatalogBytes)
	if err != nil {
		return err
	}
	var store *catalogstore.Store
	currentRevision := catalogstore.Hash(raw)
	if rootPath != "" {
		store, err = openCurrentStore(rootPath, backupPath, raw)
		if err != nil {
			return err
		}
		snapshot := store.Current()
		raw, currentRevision = snapshot.Data, snapshot.Revision
	}
	if *expected != "" && *expected != currentRevision {
		return catalogstore.ErrConflict
	}
	mode := statsMode
	if *dragonGhost {
		mode = dragonGhostMode
	}
	data, changes, err := patchForMode(raw, mode)
	if err != nil {
		return err
	}
	if *output != "" {
		outPath, err := resolvedPath(*output)
		if err != nil {
			return err
		}
		if strings.EqualFold(inputPath, outPath) {
			return fmt.Errorf("candidate must be a new file, not the input")
		}
		if rootPath != "" && (sameOrWithin(rootPath, outPath) || sameOrWithin(backupPath, outPath)) {
			return fmt.Errorf("candidate must be outside active store and backup directories")
		}
		if err = writeNew(outPath, data); err != nil {
			return err
		}
	}
	committedRevision := ""
	if *writeCatalogFlag {
		if err = replaceCatalog(inputPath, backupPath, raw, data, *expected); err != nil {
			return err
		}
		committedRevision = catalogstore.Hash(data)
	}
	if *commitLocal {
		snapshot, err := store.Commit(data, *expected, nil)
		if err != nil {
			return err
		}
		committedRevision = snapshot.Revision
	}
	return json.NewEncoder(stdout).Encode(map[string]any{
		"mode":               mode,
		"current_revision":   currentRevision,
		"input_sha256":       currentRevision,
		"candidate_sha256":   catalogstore.Hash(data),
		"committed_revision": committedRevision,
		"candidate_path":     *output,
		"changes":            changes,
		"already_applied":    len(changes) == 0,
	})
}

// Open itself can return Baseline on a missing pointer. Require the real pointer
// before and after Open, and verify its revision against Current; no bootstrap,
// recovery, bundled fallback, previous.json repair, or candidate-cache shortcut.
func openCurrentStore(root, backup string, baseline []byte) (*catalogstore.Store, error) {
	pointerPath := filepath.Join(root, "current.json")
	before, err := readBounded(pointerPath, 4096)
	if err != nil {
		return nil, fmt.Errorf("existing active store pointer required (no fallback): %w", err)
	}
	store, err := catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, Baseline: baseline, Validate: validateCatalog, Replace: catalogstore.ReplaceFile})
	if err != nil {
		return nil, err
	}
	snapshot := store.Current()
	if snapshot.Recovery != "" {
		return nil, fmt.Errorf("active store recovery refused; repair explicitly before patching")
	}
	after, err := readBounded(pointerPath, 4096)
	if err != nil {
		return nil, err
	}
	var pointer struct {
		Version  int    `json:"version"`
		Revision string `json:"revision"`
	}
	if err = json.Unmarshal(before, &pointer); err != nil {
		return nil, err
	}
	if !bytes.Equal(before, after) || pointer.Version != 1 || pointer.Revision != snapshot.Revision {
		return nil, catalogstore.ErrConflict
	}
	return store, nil
}

func validateCatalog(raw []byte) error {
	c, err := catalog.Parse(raw) // Includes strict sourcebaseline.Decode validation.
	if err != nil {
		return err
	}
	return catalogrecovery.Validate(c)
}

// patch retains the original eight-leaf stats/trait/note patch behavior.
func patch(raw []byte) ([]byte, []change, error) {
	return patchForMode(raw, statsMode)
}

// All state checks precede mutation. Each mode has its own narrow diff allowlist;
// even Marshal's extension/schema normalization must not change another field.
func patchForMode(raw []byte, mode patchMode) ([]byte, []change, error) {
	if mode != statsMode && mode != dragonGhostMode {
		return nil, nil, fmt.Errorf("unknown patch mode %q", mode)
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		return nil, nil, err
	}
	if err = catalogrecovery.Validate(c); err != nil {
		return nil, nil, err
	}
	mi, ti := -1, -1
	for i, m := range c.Monsters {
		if m.ID == monsterID {
			mi = i
		}
		if m.TraitID == traitID && m.ID != monsterID {
			return nil, nil, fmt.Errorf("trait is shared by monster %d; refused", m.ID)
		}
	}
	if mi < 0 {
		return nil, nil, fmt.Errorf("required monster 619 is missing")
	}
	m := &c.Monsters[mi]
	if m.Name != monsterName || m.TraitID != traitID {
		return nil, nil, fmt.Errorf("619 identity or trait mismatch")
	}
	if !m.Placeholder || !m.LevelConfigurable || m.DefaultLevel != 99 || m.EvolutionStage != "待定" {
		return nil, nil, fmt.Errorf("619 placeholder/stage/level guard mismatch")
	}
	legacyTypes := reflect.DeepEqual(m.TypeIDs, []int{0})
	approvedTypes := reflect.DeepEqual(m.TypeIDs, []int{8, 15})
	if !legacyTypes && !approvedTypes {
		return nil, nil, fmt.Errorf("619 types conflict; require legacy [0] or main Dragon [8], secondary Ghost [15]")
	}
	if mode == statsMode && approvedTypes {
		return nil, nil, fmt.Errorf("619 already has approved Dragon/Ghost types; use -dragon-ghost to audit, original stats mode will not downgrade types or note")
	}
	if mode == dragonGhostMode {
		codes := map[int]string{}
		for _, typ := range c.Types {
			codes[typ.ID] = typ.Code
		}
		if codes[8] != "Dragon" || codes[15] != "Ghost" {
			return nil, nil, fmt.Errorf("-dragon-ghost requires type 8 Code Dragon and type 15 Code Ghost")
		}
	}
	for _, l := range c.Learnsets {
		if l.MonsterID == monsterID && (l.Mode != "own" || l.FromID != 0 || len(l.Skills) != 0) {
			return nil, nil, fmt.Errorf("619 must retain its own empty learnset")
		}
	}
	for i, tr := range c.Traits {
		if tr.ID == traitID {
			ti = i
		}
	}
	if ti < 0 {
		return nil, nil, fmt.Errorf("required trait is missing")
	}
	tr := &c.Traits[ti]
	if tr.Name != traitName || (tr.Description != oldDescription && tr.Description != newDescription) {
		return nil, nil, fmt.Errorf("trait name/description conflict; local value preserved")
	}
	beforeStats := [6]int{m.Stats.HP, m.Stats.PhyAtk, m.Stats.PhyDef, m.Stats.MagAtk, m.Stats.MagDef, m.Stats.Speed}
	approved := [6]int{118, 128, 81, 42, 63, 70}
	changes := []change{}
	if mode == dragonGhostMode {
		if beforeStats != approved || tr.Description != newDescription {
			return nil, nil, fmt.Errorf("-dragon-ghost requires the complete prior approved stats and trait description; review/apply original stats patch first")
		}
		// Admit only the exact before/after pair, not partially updated or custom
		// notes. Already-applied data is an exact-byte no-op after validation.
		if (legacyTypes && m.DataNote != newNote) || (approvedTypes && m.DataNote != dragonGhostNote) {
			return nil, nil, fmt.Errorf("-dragon-ghost data_note/type state conflict; local note preserved")
		}
		if legacyTypes {
			changes = append(changes,
				change{"monsters[id=619].type_ids", append([]int(nil), m.TypeIDs...), []int{8, 15}},
				change{"monsters[id=619].data_note", m.DataNote, dragonGhostNote})
			m.TypeIDs, m.DataNote = []int{8, 15}, dragonGhostNote
		}
	} else {
		if m.DataNote != oldNote && m.DataNote != newNote {
			return nil, nil, fmt.Errorf("data_note conflict; local note preserved")
		}
		if beforeStats != ([6]int{100, 100, 100, 100, 100, 100}) && beforeStats != approved {
			return nil, nil, fmt.Errorf("619 stats conflict; require original six 100s or complete approved tuple")
		}
		fields := []string{"hp", "phy_atk", "phy_def", "mag_atk", "mag_def", "speed"}
		for i, key := range fields {
			if beforeStats[i] != approved[i] {
				changes = append(changes, change{fmt.Sprintf("monsters[id=619].stats.%s", key), beforeStats[i], approved[i]})
			}
		}
		// Do not replace the Stats object: its extensions belong to the user.
		m.Stats.HP, m.Stats.PhyAtk, m.Stats.PhyDef = approved[0], approved[1], approved[2]
		m.Stats.MagAtk, m.Stats.MagDef, m.Stats.Speed = approved[3], approved[4], approved[5]
		if m.DataNote != newNote {
			changes = append(changes, change{"monsters[id=619].data_note", m.DataNote, newNote})
		}
		if tr.Description != newDescription {
			changes = append(changes, change{"traits[id=" + traitID + "].description", tr.Description, newDescription})
		}
		m.DataNote, tr.Description = newNote, newDescription
	}
	data, err := catalog.Marshal(c)
	if err != nil {
		return nil, nil, err
	}
	if err = validateCatalog(data); err != nil {
		return nil, nil, err
	}
	if err = approvedDiffOnly(raw, data, mi, ti, mode); err != nil {
		return nil, nil, err
	}
	if len(changes) == 0 {
		return bytes.Clone(raw), changes, nil
	}
	return data, changes, nil
}

func jsonValue(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	err := dec.Decode(&value)
	return value, err
}

func approvedDiffOnly(before, after []byte, mi, ti int, mode patchMode) error {
	if mode != statsMode && mode != dragonGhostMode {
		return fmt.Errorf("unknown diff mode %q", mode)
	}
	a, err := jsonValue(before)
	if err != nil {
		return err
	}
	b, err := jsonValue(after)
	if err != nil {
		return err
	}
	// Both documents have already passed the strict catalog parser.
	for _, v := range []any{a, b} {
		root := v.(map[string]any)
		m := root["monsters"].([]any)[mi].(map[string]any)
		delete(m, "data_note")
		if mode == dragonGhostMode {
			delete(m, "type_ids")
		} else {
			s := m["stats"].(map[string]any)
			for _, key := range []string{"hp", "phy_atk", "phy_def", "mag_atk", "mag_def", "speed"} {
				delete(s, key)
			}
			delete(root["traits"].([]any)[ti].(map[string]any), "description")
		}
	}
	if !reflect.DeepEqual(a, b) {
		return fmt.Errorf("nonapproved JSON difference (including schema/extension normalization); refused")
	}
	return nil
}

func replaceCatalog(path, backup string, original, candidate []byte, expected string) error {
	if expected == "" || expected != catalogstore.Hash(original) {
		return catalogstore.ErrConflict
	}
	checkCurrent := func() error {
		current, err := readBounded(path, catalogstore.MaxCatalogBytes)
		if err != nil {
			return err
		}
		if catalogstore.Hash(current) != expected || !bytes.Equal(current, original) {
			return catalogstore.ErrConflict
		}
		return nil
	}
	if err := checkCurrent(); err != nil {
		return err
	}
	if bytes.Equal(original, candidate) {
		return nil
	}
	if err := os.MkdirAll(backup, 0700); err != nil {
		return fmt.Errorf("backup failed: %w", err)
	}
	backupFile := filepath.Join(backup, "catalog-"+expected+".json")
	if err := writeNew(backupFile, original); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("backup failed: %w", err)
		}
		// An existing symlink to the input is not an independent backup: an
		// atomic replacement would make that link follow the new data too.
		info, statErr := os.Lstat(backupFile)
		if statErr != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("existing backup must be an independent regular file")
		}
		prior, readErr := readBounded(backupFile, catalogstore.MaxCatalogBytes)
		if readErr != nil || !bytes.Equal(prior, original) {
			return fmt.Errorf("existing backup is not the exact original; refused")
		}
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".mingulongdata-*")
	if err != nil {
		return err
	}
	temporary := f.Name()
	defer func() { f.Close(); os.Remove(temporary) }()
	if err = f.Chmod(st.Mode().Perm()); err != nil {
		return err
	}
	if _, err = f.Write(candidate); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	// Recheck AFTER durable backup/staging, immediately before atomic replace.
	// Like the existing developer tools this is not an interprocess file lock;
	// callers must not run competing writers during the reviewed operation.
	if err = checkCurrent(); err != nil {
		return err
	}
	return catalogstore.ReplaceFile(temporary, path)
}

func writeNew(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	return closeErr
}

func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > limit {
		return nil, fmt.Errorf("not a regular bounded file: %s", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("file exceeds size limit")
	}
	return b, nil
}

// Resolve existing ancestors as well as the leaf, so a symlink/junction cannot
// disguise an output or backup inside a protected directory. Never creates paths.
func resolvedPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(absolute)
	if parent == absolute {
		return "", err
	}
	resolved, err = resolvedPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(absolute)), nil
}

func sameOrWithin(root, target string) bool {
	// Windows is case-insensitive; conservatively refuse case aliases elsewhere.
	rel, err := filepath.Rel(strings.ToLower(filepath.Clean(root)), strings.ToLower(filepath.Clean(target)))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
