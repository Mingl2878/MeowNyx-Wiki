package catalogstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// All fixtures, catalogs, image objects and backups stay inside TempDir. These
// tests do not inspect project data, runtime profiles, permissions or network.
func canonicalOptions(t *testing.T) (Options, string) {
	t.Helper()
	all := t.TempDir()
	opts := Options{
		Root:          filepath.Join(all, "exe", "data", "catalog-assets"),
		CanonicalFile: filepath.Join(all, "exe", "data", "catalog.json"),
		BackupDir:     filepath.Join(all, "external-backups"),
		Baseline:      []byte(`{"schema_version":2,"value":"stale bundle"}`),
		Replace:       ReplaceFile,
		Validate: func(data []byte) error {
			var value struct {
				Version int    `json:"schema_version"`
				Value   string `json:"value"`
			}
			if err := json.Unmarshal(data, &value); err != nil {
				return err
			}
			if (value.Version != 1 && value.Version != 2) || value.Value == "" {
				return errors.New("invalid catalog schema")
			}
			return nil
		},
	}
	if err := os.MkdirAll(filepath.Dir(opts.CanonicalFile), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(opts.CanonicalFile, []byte("{\n  \"schema_version\": 2, \"value\": \"actual canonical\", \"unknown\": {\"keep\":true}\n}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return opts, all
}

func canonicalStore(t *testing.T) (*Store, Options, string) {
	t.Helper()
	opts, all := canonicalOptions(t)
	s, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, opts, all
}

func assertCanonicalOld(t *testing.T, s *Store, opts Options, old Snapshot) {
	t.Helper()
	if got := s.Current(); got.Revision != old.Revision || !bytes.Equal(got.Data, old.Data) {
		t.Fatal("failed commit changed private snapshot")
	}
	assertBackupBytes(t, opts.CanonicalFile, old.Data)
}

func assertNoCanonicalTemps(t *testing.T, opts Options) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(filepath.Dir(opts.CanonicalFile), ".catalog-file-*"))
	if err != nil || len(files) != 0 {
		t.Fatal("canonical staging file was not cleaned up", files, err)
	}
	for _, name := range []string{"current.json", "previous.json", "versions"} {
		if _, err := os.Stat(filepath.Join(opts.Root, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("direct mode created legacy object", name, err)
		}
	}
}

func TestCanonicalOpenPrefersFileAndIgnoresLegacyTree(t *testing.T) {
	opts, all := canonicalOptions(t)
	actual, err := os.ReadFile(opts.CanonicalFile)
	if err != nil {
		t.Fatal(err)
	}
	// A future, invalid legacy CURRENT object must not shadow the selected file.
	if err := os.MkdirAll(filepath.Join(opts.Root, "versions"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), []byte(`{"version":99,"revision":"legacy"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(opts.Root, "previous.json"), 0700); err != nil {
		t.Fatal(err)
	}
	opts.Baseline = []byte(`{"schema_version":999,"value":"never validate this baseline"}`)
	before := backupTree(t, all)
	s, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	got := s.Current()
	if !bytes.Equal(got.Data, actual) || got.Revision != Hash(actual) || got.Recovery != "" || len(s.pointerBytes) != 0 {
		t.Fatal("canonical Open used baseline, legacy pointers or wrong hash")
	}
	got.Data[0] = 'x'
	opts.Baseline[0] = 'x'
	if !bytes.Equal(s.Current().Data, actual) {
		t.Fatal("Current did not return an isolated clone")
	}
	assertBackupTree(t, all, before)
}

func TestCanonicalReadOnlyStartupAndNoOpCreateNothing(t *testing.T) {
	opts, all := canonicalOptions(t)
	before := backupTree(t, all)
	for range 2 {
		s, err := Open(opts)
		if err != nil {
			t.Fatal(err)
		}
		old := s.Current()
		if _, err := s.Image(strings.Repeat("a", 64) + ".png"); !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "missing.json")
		if _, err := s.Commit(old.Data, old.Revision, nil); err != nil {
			t.Fatal("unchanged save unnecessarily required backup", err)
		}
	}
	assertBackupTree(t, all, before)
	if _, err := os.Stat(opts.Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only startup created asset root", err)
	}
	if _, err := os.Stat(opts.BackupDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only startup created backup directory", err)
	}
}

func TestCanonicalOpenRejectsUnusableFileWithoutFallback(t *testing.T) {
	for _, kind := range []string{"missing", "empty", "invalid", "invalid_schema", "future", "directory", "oversized", "relative"} {
		t.Run(kind, func(t *testing.T) {
			opts, all := canonicalOptions(t)
			switch kind {
			case "missing":
				opts.CanonicalFile = filepath.Join(filepath.Dir(opts.CanonicalFile), "absent.json")
			case "empty":
				if err := os.WriteFile(opts.CanonicalFile, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid":
				if err := os.WriteFile(opts.CanonicalFile, []byte("not JSON"), 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid_schema":
				if err := os.WriteFile(opts.CanonicalFile, []byte(`{"schema_version":2}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "future":
				if err := os.WriteFile(opts.CanonicalFile, []byte(`{"schema_version":3,"value":"future"}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				opts.CanonicalFile = filepath.Dir(opts.CanonicalFile)
			case "oversized":
				if err := os.Truncate(opts.CanonicalFile, MaxCatalogBytes+1); err != nil {
					t.Fatal(err)
				}
			case "relative":
				opts.CanonicalFile = "data/catalog.json"
			}
			before := backupTree(t, all)
			_, err := Open(opts)
			if err == nil || (kind == "future" && !errors.Is(err, ErrFutureVersion)) {
				t.Fatal("unusable canonical file fell back to baseline", err)
			}
			assertBackupTree(t, all, before)
		})
	}
}

func TestCanonicalCommitExactBytesAndReopen(t *testing.T) {
	s, opts, _ := canonicalStore(t)
	old := s.Current()
	next := []byte("{\n \"unknown\": {\"future_field\": [3,2,1]}, \"value\": \"approved 新资料\",\n \"schema_version\": 2\n}\n  ")
	calls := 0
	s.opts.Replace = func(from, to string) error {
		calls++
		if to != opts.CanonicalFile || filepath.Dir(from) != filepath.Dir(to) {
			t.Fatal("replacement did not stage beside canonical file")
		}
		assertBackupBytes(t, from, next)
		assertBackupBytes(t, to, old.Data)
		assertBackupBytes(t, filepath.Join(opts.BackupDir, old.Revision+".json"), old.Data)
		return ReplaceFile(from, to)
	}
	got, err := s.Commit(next, old.Revision, nil)
	if err != nil || calls != 1 || got.Revision != Hash(next) || !bytes.Equal(got.Data, next) {
		t.Fatal("exact-byte canonical commit failed", err)
	}
	assertBackupBytes(t, opts.CanonicalFile, next)
	assertNoCanonicalTemps(t, opts)
	if _, err := os.Stat(opts.Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("catalog-only save created image root", err)
	}
	reopened, err := Open(opts)
	if err != nil || !bytes.Equal(reopened.Current().Data, next) || reopened.Current().Revision != Hash(next) {
		t.Fatal("reopen did not read exact committed bytes", err)
	}
	got.Data[0], next[0] = 'x', 'x'
	if s.Current().Data[0] != '{' {
		t.Fatal("commit result/input aliases private snapshot")
	}
}

func TestCanonicalEarlyFailuresWriteNothing(t *testing.T) {
	for _, kind := range []string{"empty_expected", "stale_expected", "invalid", "invalid_schema", "future", "invalid_image", "external_exact_bytes", "missing_disk", "backup_directory_file", "backup_object_invalid", "backup_overlap"} {
		t.Run(kind, func(t *testing.T) {
			s, opts, all := canonicalStore(t)
			old := s.Current()
			next, expected := []byte(`{"schema_version":2,"value":"new"}`), old.Revision
			var images map[string][]byte
			var want error
			switch kind {
			case "empty_expected":
				expected, want = "", ErrConflict
			case "stale_expected":
				expected, want = "stale", ErrConflict
			case "invalid":
				next = []byte("not JSON")
			case "invalid_schema":
				next = []byte(`{"schema_version":2}`)
			case "future":
				next, want = []byte(`{"schema_version":3,"value":"future"}`), ErrFutureVersion
			case "invalid_image":
				images = map[string][]byte{"../escape.png": []byte("bad")}
			case "external_exact_bytes":
				if err := os.WriteFile(opts.CanonicalFile, append(bytes.Clone(old.Data), '\n'), 0600); err != nil {
					t.Fatal(err)
				}
				want = ErrConflict
			case "missing_disk":
				s.opts.CanonicalFile = filepath.Join(filepath.Dir(opts.CanonicalFile), "missing.json")
			case "backup_directory_file":
				if err := os.WriteFile(opts.BackupDir, []byte("not a directory"), 0600); err != nil {
					t.Fatal(err)
				}
			case "backup_object_invalid":
				if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(opts.BackupDir, old.Revision+".json"), []byte("wrong bytes"), 0600); err != nil {
					t.Fatal(err)
				}
			case "backup_overlap":
				s.opts.BackupDir = filepath.Dir(opts.CanonicalFile)
			}
			before := backupTree(t, all)
			_, err := s.Commit(next, expected, images)
			if err == nil || (want != nil && !errors.Is(err, want)) {
				t.Fatal("invalid transaction accepted or wrong error", err)
			}
			if !bytes.Equal(s.Current().Data, old.Data) || s.Current().Revision != old.Revision {
				t.Fatal("early failure changed snapshot")
			}
			assertBackupTree(t, all, before)
		})
	}
}

func TestCanonicalReplaceAndImageFailureKeepOld(t *testing.T) {
	for _, kind := range []string{"replace", "image_directory_file"} {
		t.Run(kind, func(t *testing.T) {
			s, opts, _ := canonicalStore(t)
			old := s.Current()
			var images map[string][]byte
			if kind == "replace" {
				s.opts.Replace = func(string, string) error { return errors.New("simulated atomic replace failure") }
			} else {
				if err := os.MkdirAll(opts.Root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(opts.Root, "images"), []byte("not a directory"), 0600); err != nil {
					t.Fatal(err)
				}
				image := []byte("caller-validated image")
				images = map[string][]byte{Hash(image) + ".png": image}
			}
			if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, images); err == nil {
				t.Fatal("late failure reported success")
			}
			assertCanonicalOld(t, s, opts, old)
			assertNoCanonicalTemps(t, opts)
			reopened, err := Open(opts)
			if err != nil || reopened.Current().Revision != old.Revision {
				t.Fatal("failed transaction changed active file", err)
			}
		})
	}
}

func TestCanonicalHashedImagesAndURLsUnchanged(t *testing.T) {
	s, opts, _ := canonicalStore(t)
	old := s.Current()
	images := make(map[string][]byte)
	for _, ext := range []string{"png", "jpg", "jpeg"} {
		image := []byte("caller-validated " + ext + " image")
		images[Hash(image)+"."+ext] = image
	}
	name := Hash([]byte("caller-validated png image")) + ".png"
	next := []byte(`{"schema_version":2,"value":"with images","image":"/catalog-images/` + name + `","source_ref":{"url":"https://example.invalid/source"},"unknown":{"keep":true}}`)
	if _, err := s.Commit(next, old.Revision, images); err != nil {
		t.Fatal(err)
	}
	assertBackupBytes(t, opts.CanonicalFile, next)
	for name, image := range images {
		got, err := s.Image(name)
		if err != nil || !bytes.Equal(got, image) {
			t.Fatal("hashed image lookup failed", name, err)
		}
		assertBackupBytes(t, filepath.Join(opts.Root, "images", name), image)
	}
	for _, bad := range []string{"../catalog.json", "/catalog-images/" + name, strings.ToUpper(name), Hash([]byte("bad")) + ".gif"} {
		if _, err := s.Image(bad); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("image API changed path/extension guard", bad, err)
		}
	}
	assertNoCanonicalTemps(t, opts)
}

func TestCanonicalExistingBackupStrictAndReadOnly(t *testing.T) {
	for _, kind := range []string{"exact", "missing", "different_bytes", "future", "outside", "hardlink", "directory_overlap"} {
		t.Run(kind, func(t *testing.T) {
			s, opts, all := canonicalStore(t)
			old := s.Current()
			if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
				t.Fatal(err)
			}
			s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "independent.json")
			data := old.Data
			switch kind {
			case "different_bytes":
				data = append(bytes.Clone(data), '\n')
			case "future":
				data = []byte(`{"schema_version":3,"value":"future"}`)
			case "outside":
				s.opts.ExistingBackupFile = filepath.Join(all, "outside.json")
			case "directory_overlap":
				s.opts.BackupDir = all
			}
			if kind == "hardlink" {
				if err := os.Link(opts.CanonicalFile, s.opts.ExistingBackupFile); err != nil {
					t.Skipf("TempDir hardlinks unavailable: %v", err)
				}
			} else if kind != "missing" {
				if err := os.WriteFile(s.opts.ExistingBackupFile, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := backupTree(t, all)
			backupBefore := backupTree(t, opts.BackupDir)
			next := []byte(`{"schema_version":2,"value":"approved"}`)
			_, err := s.Commit(next, old.Revision, nil)
			if kind == "exact" {
				if err != nil {
					t.Fatal(err)
				}
				assertBackupTree(t, opts.BackupDir, backupBefore)
				assertBackupBytes(t, opts.CanonicalFile, next)
				if _, err := s.Commit(old.Data, s.Current().Revision, nil); err == nil {
					t.Fatal("stale backup reused after revision advanced")
				}
			} else {
				if err == nil || (kind == "future" && !errors.Is(err, ErrFutureVersion)) {
					t.Fatal("non-exact independent backup accepted", err)
				}
				assertCanonicalOld(t, s, opts, old)
				assertBackupTree(t, all, before)
			}
			assertNoCanonicalTemps(t, opts)
		})
	}
}

func TestCanonicalCASAfterBackupValidation(t *testing.T) {
	s, opts, all := canonicalStore(t)
	old := s.Current()
	if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
		t.Fatal(err)
	}
	s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "independent.json")
	if err := os.WriteFile(s.opts.ExistingBackupFile, old.Data, 0600); err != nil {
		t.Fatal(err)
	}
	external := append(bytes.Clone(old.Data), '\n')
	var afterExternal map[string]backupTreeEntry
	s.opts.Validate = func(data []byte) error {
		if bytes.Equal(data, old.Data) {
			if err := os.WriteFile(opts.CanonicalFile, external, 0600); err != nil {
				return err
			}
			afterExternal = backupTree(t, all)
		}
		return nil
	}
	if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("external exact-byte edit during backup verification overwritten", err)
	}
	if afterExternal == nil {
		t.Fatal("backup validation was not reached")
	}
	assertBackupTree(t, all, afterExternal)
	if s.Current().Revision != old.Revision {
		t.Fatal("CAS changed snapshot")
	}
}

func TestCanonicalFinalCASAndAtomicCallbackFailure(t *testing.T) {
	for _, point := range []string{"final_store_recheck", "atomic_callback_refuses"} {
		t.Run(point, func(t *testing.T) {
			s, opts, _ := canonicalStore(t)
			old := s.Current()
			external := append(bytes.Clone(old.Data), '\n')
			calls := 0
			s.opts.Replace = func(from, to string) error {
				calls++
				if err := os.WriteFile(to, external, 0600); err != nil {
					return err
				}
				return ErrConflict
			}
			next := []byte(`{"schema_version":2,"value":"new"}`)
			var err error
			if point == "final_store_recheck" {
				if err := os.WriteFile(opts.CanonicalFile, external, 0600); err != nil {
					t.Fatal(err)
				}
				// Exercise the last gate after temp-file staging directly, without
				// adding production hooks or timing-dependent watcher goroutines.
				err = s.replaceCanonicalFile(next)
				if calls != 0 {
					t.Fatal("final exact-byte CAS did not stop Replace")
				}
			} else {
				image := []byte("inactive orphan allowed after final refusal")
				_, err = s.Commit(next, old.Revision, map[string][]byte{Hash(image) + ".png": image})
				assertBackupBytes(t, filepath.Join(opts.Root, "images", Hash(image)+".png"), image)
				if calls != 1 {
					t.Fatal("atomic callback refusal not reached")
				}
			}
			if !errors.Is(err, ErrConflict) {
				t.Fatal("late conflict lost", err)
			}
			assertBackupBytes(t, opts.CanonicalFile, external)
			if !bytes.Equal(s.Current().Data, old.Data) {
				t.Fatal("late CAS failure changed snapshot")
			}
			assertNoCanonicalTemps(t, opts)
		})
	}
}

func TestCanonicalRejectsSymlinkFilesAndDirectoryEscapes(t *testing.T) {
	for _, kind := range []string{"canonical_file", "canonical_directory", "backup_file", "images_directory"} {
		t.Run(kind, func(t *testing.T) {
			s, opts, all := canonicalStore(t)
			old := s.Current()
			link, target := filepath.Join(all, "link"), opts.CanonicalFile
			switch kind {
			case "canonical_file":
				opts.CanonicalFile = link
			case "canonical_directory":
				target, opts.CanonicalFile = filepath.Dir(opts.CanonicalFile), filepath.Join(link, "catalog.json")
			case "backup_file":
				if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
					t.Fatal(err)
				}
				link = filepath.Join(opts.BackupDir, "linked.json")
				s.opts.ExistingBackupFile = link
			case "images_directory":
				if err := os.MkdirAll(opts.Root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
					t.Fatal(err)
				}
				link, target = filepath.Join(opts.Root, "images"), opts.BackupDir
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("TempDir symlinks unavailable: %v", err)
			}
			before := backupTree(t, all)
			if strings.HasPrefix(kind, "canonical") {
				if _, err := Open(opts); err == nil {
					t.Fatal("canonical link/escape accepted")
				}
			} else {
				if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); err == nil {
					t.Fatal("linked backup/staging directory accepted")
				}
				assertCanonicalOld(t, s, opts, old)
			}
			assertBackupTree(t, all, before)
		})
	}
}
