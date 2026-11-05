package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
)

func TestLocalStoreDeletionRequiresFreshRevisionAndClosedApp(t *testing.T) {
	dir := t.TempDir()
	input, storeRoot, backup := filepath.Join(dir, "bundled.json"), filepath.Join(dir, "local-catalog"), filepath.Join(dir, "backups")
	bundled := cliTestCatalog(t)
	if err := os.WriteFile(input, bundled, 0600); err != nil {
		t.Fatal(err)
	}
	personal := filepath.Join(dir, "personal.json")
	if err := os.WriteFile(personal, []byte(`{"keep":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"-catalog", input, "-names", "猫", "-store-root", storeRoot, "-backup-dir", backup}
	var audit bytes.Buffer
	if err := run(args, &audit); err != nil {
		t.Fatal(err)
	}
	var report struct {
		CurrentRevision string `json:"current_revision"`
	}
	if err := json.Unmarshal(audit.Bytes(), &report); err != nil || report.CurrentRevision != catalogstore.Hash(bundled) {
		t.Fatal("dry-run revision missing", err)
	}
	if _, err := os.Stat(storeRoot); !os.IsNotExist(err) {
		t.Fatal("dry-run created a local store")
	}
	if _, err := os.Stat(backup); !os.IsNotExist(err) {
		t.Fatal("dry-run wrote backups")
	}
	for _, extra := range [][]string{{"-commit-local"}, {"-commit-local", "-expected-revision", report.CurrentRevision}, {"-commit-local", "-app-closed"}, {"-commit-local", "-app-closed", "-expected-revision", strings.Repeat("0", 64)}} {
		if err := run(append(append([]string{}, args...), extra...), new(bytes.Buffer)); err == nil {
			t.Fatalf("unsafe local commit allowed: %v", extra)
		}
	}

	// Simulate a user's later catalog update after the first dry-run. Deletion
	// must clone CURRENT, retain that user's metadata, and reject the stale hash.
	opts := catalogstore.Options{Root: storeRoot, BackupDir: backup, Baseline: bundled, Validate: validateCatalog, Replace: catalogstore.ReplaceFile}
	store, err := catalogstore.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	current, _ := catalog.Parse(bundled)
	current.Extensions = catalog.Extensions{"user_metadata": json.RawMessage(`{"keep":"later-update"}`)}
	updated, _ := catalog.Marshal(current)
	latest, err := store.Commit(updated, store.Current().Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	commitArgs := append(append([]string{}, args...), "-commit-local", "-app-closed", "-expected-revision", report.CurrentRevision)
	if err := run(commitArgs, new(bytes.Buffer)); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale dry-run did not block commit", err)
	}
	commitArgs[len(commitArgs)-1] = latest.Revision
	if err := run(commitArgs, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	reopened, err := catalogstore.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := catalog.Parse(reopened.Current().Data)
	if err != nil || len(deleted.Monsters) != 1 || deleted.Monsters[0].ID != 6 || string(deleted.Extensions["user_metadata"]) != `{"keep":"later-update"}` {
		t.Fatal("local commit lost latest data", err)
	}
	backedUp, err := os.ReadFile(filepath.Join(backup, latest.Revision+".json"))
	if err != nil || !bytes.Equal(backedUp, updated) {
		t.Fatal("previous current not backed up before deletion", err)
	}
	currentInput, _ := os.ReadFile(input)
	personalAfter, _ := os.ReadFile(personal)
	if !bytes.Equal(currentInput, bundled) || string(personalAfter) != `{"keep":true}` {
		t.Fatal("local deletion touched bundled or personal files")
	}
}
