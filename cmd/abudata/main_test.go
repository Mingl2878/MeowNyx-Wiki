package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalogstore"
)

func put(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

func readTest(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func assertBytes(t *testing.T, path string, expected []byte) {
	t.Helper()
	if !bytes.Equal(readTest(t, path), expected) {
		t.Fatalf("unexpected write to %s", path)
	}
}

func tree(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		if entry.IsDir() {
			out[relative] = "directory"
		} else {
			out[relative] = catalogstore.Hash(readTest(t, path))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestAuditAndNewCandidateOnly(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "input", "catalog.json")
	output := filepath.Join(root, "candidate.json")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	before := tree(t, root)
	var report bytes.Buffer
	if err := run([]string{"-catalog", input}, &report); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("default audit wrote files")
	}
	var fields map[string]any
	if err := json.Unmarshal(report.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["current_revision"] != catalogstore.Hash(original) || fields["committed_revision"] != "" || len(fields["changes"].([]any)) != 3 || fields["already_applied"] != false {
		t.Fatal("bad report", fields)
	}
	if err := run([]string{"-catalog", input, "-out", input}, io.Discard); err == nil {
		t.Fatal("allowed input overwrite")
	}
	if err := run([]string{"-catalog", input, "-out", output}, io.Discard); err != nil {
		t.Fatal(err)
	}
	candidate := readTest(t, output)
	assertOnlyAddition(t, original, candidate)
	if err := run([]string{"-catalog", input, "-out", output}, io.Discard); !errors.Is(err, os.ErrExist) {
		t.Fatal("overwrote candidate", err)
	}
	assertBytes(t, output, candidate)
	assertBytes(t, input, original)
	if err := run([]string{"-catalog", input, "-expected-revision", strings.Repeat("0", 64), "-out", filepath.Join(root, "stale.json")}, io.Discard); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale candidate", err)
	}
	if _, err := os.Stat(filepath.Join(root, "stale.json")); !os.IsNotExist(err) {
		t.Fatal("wrote stale candidate")
	}
}

func TestFlagsRefuseImplicitAndIncompatibleWrites(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "input", "catalog.json")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	before := tree(t, root)
	base := []string{"-catalog", input}
	for _, extra := range [][]string{
		{"-write-catalog"}, {"-commit-local"}, {"-app-closed"}, {"-backup-dir", root},
		{"-write-catalog", "-commit-local"}, {"-write-catalog", "-out", filepath.Join(root, "out.json")},
		{"-commit-local", "-out", filepath.Join(root, "out.json")}, {"-write-catalog", "-store-root", root},
		{"-store-root", "relative", "-backup-dir", root}, {"-store-root", root},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", "relative"},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", filepath.Join(root, "input", "backups")},
		{"-store-root", filepath.Join(root, "store"), "-backup-dir", filepath.Join(root, "backup"), "-commit-local", "-expected-revision", catalogstore.Hash(original)},
		{"unexpected-argument"},
	} {
		if err := run(append(append([]string{}, base...), extra...), io.Discard); err == nil {
			t.Fatalf("accepted %v", extra)
		}
	}
	if err := run(nil, io.Discard); err == nil {
		t.Fatal("accepted no explicit input")
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("invalid flags wrote files")
	}
}

func TestFactoryCommitBackupAndStaleRefusal(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "project", "data", "catalog.json")
	backup := filepath.Join(root, "backups")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	args := []string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}
	if err := run(args, io.Discard); err != nil {
		t.Fatal(err)
	}
	candidate := readTest(t, input)
	assertOnlyAddition(t, original, candidate)
	assertBytes(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), original)
	if err := run(args, io.Discard); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale revision", err)
	}
	args[4] = catalogstore.Hash(candidate)
	before := tree(t, root)
	if err := run(args, io.Discard); err != nil {
		t.Fatal("no-op failed", err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("exact no-op changed files")
	}
	if err := replaceCatalog(input, backup, original, candidate, catalogstore.Hash(original), catalogstore.ReplaceFile); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale helper accepted", err)
	}
}

func TestFactoryFailedBackupOrReplaceLeavesOriginal(t *testing.T) {
	for _, mode := range []string{"blocked-backup-directory", "wrong-existing-backup", "internal-project-backup", "failed-replace"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "project", "data", "catalog.json")
			backup := filepath.Join(root, "backups")
			original := marshalTest(t, testCatalog(t))
			put(t, input, original)
			switch mode {
			case "blocked-backup-directory":
				put(t, backup, []byte("blocked"))
			case "wrong-existing-backup":
				put(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), []byte("wrong"))
			case "internal-project-backup":
				backup = filepath.Join(root, "project", "backups")
			}
			replace := catalogstore.ReplaceFile
			sentinel := errors.New("simulated atomic replace failure")
			called := false
			if mode == "failed-replace" {
				replace = func(from, to string) error {
					called = true
					assertBytes(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), original)
					assertOnlyAddition(t, original, readTest(t, from))
					assertBytes(t, to, original)
					return sentinel
				}
			}
			var report bytes.Buffer
			err := runWithReplace([]string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}, &report, replace)
			if err == nil {
				t.Fatal("accepted unsafe commit")
			}
			if mode == "failed-replace" && (!called || !errors.Is(err, sentinel)) {
				t.Fatal(err)
			}
			assertBytes(t, input, original)
			if report.Len() != 0 {
				t.Fatal("reported success after failed commit")
			}
			files, err := filepath.Glob(filepath.Join(filepath.Dir(input), ".abudata-*"))
			if err != nil || len(files) != 0 {
				t.Fatal("leaked temporary replacement", err)
			}
		})
	}
}

func initializeStore(t *testing.T, root, backup string, raw []byte) *catalogstore.Store {
	t.Helper()
	s, err := catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, Baseline: raw, Validate: validateCatalog, Replace: catalogstore.ReplaceFile})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Commit(raw, catalogstore.Hash(raw), nil); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStoreAuditsActualAndCommitPreservesOtherFiles(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "factory", "catalog.json")
	storeRoot := filepath.Join(root, "store")
	backup := filepath.Join(root, "backups")
	factory := marshalTest(t, testCatalog(t))
	put(t, input, factory)
	local := testCatalog(t)
	local.Monsters[0].Stats.Speed = 222
	local.Extensions["local-only"] = json.RawMessage(`{"preserve":true}`)
	original := marshalTest(t, local)
	initializeStore(t, storeRoot, filepath.Join(root, "setup-backups"), original)
	put(t, filepath.Join(storeRoot, "images", "keep.png"), []byte("untouched image"))
	put(t, filepath.Join(root, "user-config.json"), []byte("untouched personal data"))
	args := []string{"-catalog", input, "-store-root", storeRoot, "-backup-dir", backup}
	before := tree(t, root)
	var audit bytes.Buffer
	if err := run(args, &audit); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(audit.String(), catalogstore.Hash(original)) {
		t.Fatal("audited baseline instead of actual store")
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("store audit wrote files or directories")
	}
	for _, out := range []string{filepath.Join(storeRoot, "candidate.json"), filepath.Join(backup, "candidate.json")} {
		if err := run(append(append([]string{}, args...), "-out", out), io.Discard); err == nil {
			t.Fatal("allowed output inside active store/backup")
		}
	}
	commit := append(append([]string{}, args...), "-commit-local", "-app-closed", "-expected-revision", catalogstore.Hash(original))
	if err := run(commit, io.Discard); err != nil {
		t.Fatal(err)
	}
	s, err := openCurrentStore(storeRoot, backup, factory, catalogstore.ReplaceFile)
	if err != nil {
		t.Fatal(err)
	}
	candidate := s.Current().Data
	assertOnlyAddition(t, original, candidate)
	assertBytes(t, filepath.Join(backup, catalogstore.Hash(original)+".json"), original)
	assertBytes(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), original)
	assertBytes(t, input, factory)
	assertBytes(t, filepath.Join(storeRoot, "images", "keep.png"), []byte("untouched image"))
	assertBytes(t, filepath.Join(root, "user-config.json"), []byte("untouched personal data"))
	if err := run(commit, io.Discard); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale local revision", err)
	}
	commit[len(commit)-1] = catalogstore.Hash(candidate)
	before = tree(t, root)
	if err := run(commit, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("idempotent local commit rewrote state")
	}
}

func TestStoreRefusesBadStateAndRequiresClosedApp(t *testing.T) {
	for _, mode := range []string{"missing", "recovery", "future-pointer", "bad-hash", "occupied-target", "backup-failure", "stale", "not-app-closed"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "factory", "catalog.json")
			storeRoot := filepath.Join(root, "store")
			backup := filepath.Join(root, "backups")
			factory := marshalTest(t, testCatalog(t))
			put(t, input, factory)
			local := testCatalog(t)
			if mode == "occupied-target" {
				addApproved(local)
				local.Monsters[len(local.Monsters)-1].Name = "用户自己的623"
			}
			original := marshalTest(t, local)
			if mode != "missing" {
				initializeStore(t, storeRoot, filepath.Join(root, "setup-backups"), original)
			}
			pointerPath := filepath.Join(storeRoot, "current.json")
			switch mode {
			case "recovery":
				put(t, pointerPath, []byte(`{"version":1,"revision":"bad"}`))
			case "future-pointer":
				put(t, pointerPath, []byte(`{"version":99,"revision":"`+catalogstore.Hash(original)+`"}`))
			case "bad-hash":
				put(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), []byte("corrupt version"))
			case "backup-failure":
				put(t, backup, []byte("blocked"))
			}
			before := tree(t, root)
			expected := catalogstore.Hash(original)
			if mode == "stale" {
				expected = strings.Repeat("0", 64)
			}
			args := []string{"-catalog", input, "-store-root", storeRoot, "-backup-dir", backup, "-commit-local", "-expected-revision", expected}
			if mode != "not-app-closed" {
				args = append(args, "-app-closed")
			}
			if err := run(args, io.Discard); err == nil {
				t.Fatal("accepted invalid store operation")
			}
			if !reflect.DeepEqual(before, tree(t, root)) {
				t.Fatal("invalid operation wrote files")
			}
		})
	}
}

func TestLocalFailedAtomicReplacePreservesActivePointer(t *testing.T) {
	for _, target := range []string{"previous.json", "current.json"} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "factory", "catalog.json")
			storeRoot := filepath.Join(root, "store")
			backup := filepath.Join(root, "backups")
			original := marshalTest(t, testCatalog(t))
			put(t, input, original)
			initializeStore(t, storeRoot, filepath.Join(root, "setup-backups"), original)
			pointerPath := filepath.Join(storeRoot, "current.json")
			pointer := readTest(t, pointerPath)
			sentinel := errors.New("simulated pointer replacement failure")
			called := false
			replace := func(from, to string) error {
				assertBytes(t, filepath.Join(backup, catalogstore.Hash(original)+".json"), original)
				if filepath.Base(to) == target {
					called = true
					return sentinel
				}
				return catalogstore.ReplaceFile(from, to)
			}
			var report bytes.Buffer
			err := runWithReplace([]string{"-catalog", input, "-store-root", storeRoot, "-backup-dir", backup, "-commit-local", "-app-closed", "-expected-revision", catalogstore.Hash(original)}, &report, replace)
			if !called || !errors.Is(err, sentinel) {
				t.Fatal("wrong failure", err)
			}
			if report.Len() != 0 {
				t.Fatal("reported success")
			}
			assertBytes(t, pointerPath, pointer)
			assertBytes(t, input, original)
			s, err := openCurrentStore(storeRoot, backup, original, catalogstore.ReplaceFile)
			if err != nil {
				t.Fatal(err)
			}
			if s.Current().Revision != catalogstore.Hash(original) {
				t.Fatal("failed commit changed current revision")
			}
		})
	}
}

func TestStoreDetectsChangedPointerAfterOpen(t *testing.T) {
	root := t.TempDir()
	storeRoot := filepath.Join(root, "store")
	backup := filepath.Join(root, "backups")
	original := marshalTest(t, testCatalog(t))
	s := initializeStore(t, storeRoot, backup, original)
	candidate, _, err := patch(original)
	if err != nil {
		t.Fatal(err)
	}
	pointerPath := filepath.Join(storeRoot, "current.json")
	changed := append(readTest(t, pointerPath), '\n')
	put(t, pointerPath, changed)
	before := tree(t, root)
	if _, err = s.Commit(candidate, catalogstore.Hash(original), nil); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale pointer", err)
	}
	if !reflect.DeepEqual(before, tree(t, root)) {
		t.Fatal("stale commit staged/wrote data")
	}
}

func TestBackupSymlinkIsNotIndependent(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "input", "catalog.json")
	backup := filepath.Join(root, "backup")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	if err := os.MkdirAll(backup, 0700); err != nil {
		t.Fatal(err)
	}
	backupFile := filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json")
	if err := os.Symlink(input, backupFile); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := run([]string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}, io.Discard); err == nil {
		t.Fatal("accepted symlink backup")
	}
	assertBytes(t, input, original)
}
