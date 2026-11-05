// catalogdelete creates a developer-only deletion candidate, or explicitly
// commits one to a caller-specified closed-app local store. It never replaces
// bundled input, discovers AppData, alters personal files, or restores records.
package main

import (
	"crypto/sha256"
	"encoding/json"
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

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("catalogdelete", flag.ContinueOnError)
	input := flags.String("catalog", "", "explicit canonical catalog input; never changed")
	names := flags.String("names", "", "exact comma-separated names to delete; no default targets")
	output := flags.String("out", "", "new candidate file only; omit for audit, existing files refused")
	storeRoot := flags.String("store-root", "", "explicit absolute local store; when set, read its current snapshot instead of bundled input")
	backupDir := flags.String("backup-dir", "", "explicit absolute external backup directory for local store")
	commitLocal := flags.Bool("commit-local", false, "explicitly commit deletion to the local store; never modifies the bundled catalog")
	expected := flags.String("expected-revision", "", "required exact dry-run current_revision for local commit")
	appClosed := flags.Bool("app-closed", false, "acknowledge the app has fully closed and finished saving; required for local commit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *input == "" || *names == "" || flags.NArg() != 0 {
		return fmt.Errorf("required: -catalog <path> -names <exact,name,list>; optional -out <new-file>")
	}
	if *storeRoot == "" && (*backupDir != "" || *commitLocal || *expected != "" || *appClosed) {
		return fmt.Errorf("local-store flags require -store-root")
	}
	if *commitLocal && (*expected == "" || !*appClosed || *output != "") {
		return fmt.Errorf("-commit-local requires -expected-revision and -app-closed, and cannot be combined with -out")
	}
	raw, err := os.ReadFile(*input)
	if err != nil {
		return err
	}
	var store *catalogstore.Store
	currentRevision := catalogstore.Hash(raw)
	if *storeRoot != "" {
		if !filepath.IsAbs(*storeRoot) || !filepath.IsAbs(*backupDir) {
			return fmt.Errorf("-store-root and -backup-dir must both be explicit absolute paths")
		}
		if sameOrWithin(*storeRoot, *backupDir) || sameOrWithin(*backupDir, *storeRoot) {
			return fmt.Errorf("local store and backup directory must be separate")
		}
		store, err = catalogstore.Open(catalogstore.Options{Root: *storeRoot, BackupDir: *backupDir, Baseline: raw, Validate: validateCatalog, Replace: catalogstore.ReplaceFile})
		if err != nil {
			return err
		}
		snapshot := store.Current()
		if snapshot.Recovery != "" {
			return fmt.Errorf("local store fell back to previous data; repair it explicitly before deleting records")
		}
		raw, currentRevision = snapshot.Data, snapshot.Revision
		if *expected != "" && *expected != currentRevision {
			return catalogstore.ErrConflict
		}
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		return err
	}
	list := strings.Split(*names, ",")
	for i := range list {
		list[i] = strings.TrimSpace(list[i])
	}
	candidate, report, err := catalogrecovery.DeleteMonsters(c, list)
	if err != nil {
		return err
	}
	data, err := catalog.Marshal(candidate)
	if err != nil {
		return err
	}
	if *output != "" {
		inPath, err := filepath.Abs(*input)
		if err != nil {
			return err
		}
		outPath, err := filepath.Abs(*output)
		if err != nil {
			return err
		}
		if *storeRoot != "" && (sameOrWithin(*storeRoot, outPath) || sameOrWithin(*backupDir, outPath)) {
			return fmt.Errorf("candidate output must be outside the active store and backup directories")
		}
		if strings.EqualFold(inPath, outPath) {
			return fmt.Errorf("in-place deletion refused; create and review a separate candidate")
		}
		// Parents must explicitly create/select a destination. O_EXCL also
		// refuses aliases/symlinks to the input and every existing candidate.
		f, err := os.OpenFile(outPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
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
		if closeErr != nil {
			return closeErr
		}
	}
	committedRevision := ""
	if *commitLocal {
		snapshot, err := store.Commit(data, *expected, nil)
		if err != nil {
			return err
		}
		committedRevision = snapshot.Revision
	}
	return json.NewEncoder(stdout).Encode(map[string]any{
		"current_revision":   currentRevision,
		"committed_revision": committedRevision,
		"input_sha256":       fmt.Sprintf("%x", sha256.Sum256(raw)),
		"candidate_sha256":   fmt.Sprintf("%x", sha256.Sum256(data)),
		"candidate_path":     *output,
		"deletion":           report,
	})
}

func validateCatalog(raw []byte) error {
	c, err := catalog.Parse(raw)
	if err != nil {
		return err
	}
	return catalogrecovery.Validate(c)
}

func sameOrWithin(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
