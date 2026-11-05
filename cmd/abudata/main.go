// abudata is a developer-only, offline addition of the user-approved monster 623.
// It has no implicit paths, source lookup or runtime integration. Default: audit.
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
	"strings"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
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
	return runWithReplace(args, stdout, catalogstore.ReplaceFile)
}

// The replace dependency permits failure tests without touching live files or
// weakening the production atomic replacement implementation.
func runWithReplace(args []string, stdout io.Writer, replace func(string, string) error) error {
	flags := flag.NewFlagSet("abudata", flag.ContinueOnError)
	input := flags.String("catalog", "", "explicit canonical file; read-only validation baseline when -store-root is set")
	output := flags.String("out", "", "new candidate only; existing files refused; omit for audit")
	writeCatalogFlag := flags.Bool("write-catalog", false, "explicitly replace -catalog after backup and exact revision checks")
	storeRoot := flags.String("store-root", "", "explicit absolute immutable store; requires existing valid current.json, never falls back")
	backupDir := flags.String("backup-dir", "", "explicit absolute external backup directory; required for commits and store access")
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
		return fmt.Errorf("commits require -expected-revision and absolute external -backup-dir")
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
		store, err = openCurrentStore(rootPath, backupPath, raw, replace)
		if err != nil {
			return err
		}
		snapshot := store.Current()
		raw, currentRevision = snapshot.Data, snapshot.Revision
	}
	if *expected != "" && *expected != currentRevision {
		return catalogstore.ErrConflict
	}
	data, changes, err := patch(raw)
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
		if err = replaceCatalog(inputPath, backupPath, raw, data, *expected, replace); err != nil {
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
		"mode": "add-super-abu", "monster_id": monsterID, "trait_id": traitID,
		"current_revision": currentRevision, "input_sha256": currentRevision,
		"candidate_sha256": catalogstore.Hash(data), "committed_revision": committedRevision,
		"candidate_path": *output, "changes": changes, "already_applied": len(changes) == 0,
	})
}

// Open can return Baseline on a missing pointer. Require the real pointer before
// and after Open and match Current. No bootstrap, recovery, fallback or repair.
func openCurrentStore(root, backup string, baseline []byte, replace func(string, string) error) (*catalogstore.Store, error) {
	pointerPath := filepath.Join(root, "current.json")
	before, err := readBounded(pointerPath, 4096)
	if err != nil {
		return nil, fmt.Errorf("existing active store pointer required (no fallback): %w", err)
	}
	store, err := catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, Baseline: baseline, Validate: validateCatalog, Replace: replace})
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

func replaceCatalog(path, backup string, original, candidate []byte, expected string, replace func(string, string) error) error {
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
		// A link following the input is not an independent durable backup.
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
	f, err := os.CreateTemp(filepath.Dir(path), ".abudata-*")
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
	// Recheck after durable backup/staging. This is not an interprocess lock:
	// the reviewed developer operation must have no competing catalog writers.
	if err = checkCurrent(); err != nil {
		return err
	}
	return replace(temporary, path)
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

// Resolve ancestors too so symlinks/junctions cannot disguise protected paths.
// Never creates a directory, including for a read-only audit.
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
