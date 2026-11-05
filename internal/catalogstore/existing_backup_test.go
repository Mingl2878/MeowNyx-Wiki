package catalogstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Every path used by these tests is a descendant of a testing.TempDir. No
// runtime profile, project data, real backup, permissions or network is used.
func existingBackupStore(t *testing.T) (*Store, Options, string) {
	t.Helper()
	s, opts := testStore(t)
	old := s.Current()
	// Pin the old active version using the original API and a separate temporary
	// initial backup directory. The reuse directory deliberately has NO normal
	// <revision>.json object, so accidental default backup writes are observable.
	if _, err := s.Commit(old.Data, old.Revision, nil); err != nil {
		t.Fatal(err)
	}
	all := filepath.Dir(opts.Root)
	opts.BackupDir = filepath.Join(all, "verified-backups")
	opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "active-catalog.json")
	if err := os.MkdirAll(filepath.Join(opts.BackupDir, "unrelated"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(opts.ExistingBackupFile, old.Data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.BackupDir, "unrelated", "sentinel.txt"), []byte("unrelated backup must stay untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, opts, all
}

type backupTreeEntry struct {
	Mode    fs.FileMode
	Size    int64
	ModTime int64
	Hash    string
}

// Compare every path, content hash, permission mode and modification timestamp,
// including directories, not merely the chosen backup's bytes.
func backupTree(t *testing.T, root string) map[string]backupTreeEntry {
	t.Helper()
	result := make(map[string]backupTreeEntry)
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		return result
	} else if err != nil {
		t.Fatal(err)
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
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
		state := backupTreeEntry{Mode: info.Mode(), Size: info.Size(), ModTime: info.ModTime().UnixNano()}
		if info.Mode().IsRegular() {
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			state.Hash = Hash(data)
		} else if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			state.Hash = Hash([]byte(target))
		}
		result[rel] = state
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func assertBackupTree(t *testing.T, root string, before map[string]backupTreeEntry) {
	t.Helper()
	if after := backupTree(t, root); !reflect.DeepEqual(before, after) {
		t.Fatalf("tree changed at %s\nbefore: %#v\nafter: %#v", root, before, after)
	}
}

func assertBackupBytes(t *testing.T, path string, want []byte) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("unexpected file bytes at %s: %v", path, err)
	}
}

func assertBackupPointer(t *testing.T, path, revision string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var p pointer
	if err := json.Unmarshal(data, &p); err != nil || p.Version != 1 || p.Revision != revision || p.UpdatedAt == "" {
		t.Fatalf("unexpected pointer at %s: %#v, %v", path, p, err)
	}
	return data
}

func TestExistingBackupReadOnlyExactSuccess(t *testing.T) {
	s, opts, _ := existingBackupStore(t)
	old := s.Current()
	before := backupTree(t, opts.BackupDir)
	next := []byte(`{"schema_version":2,"value":"approved new data","unknown":{"preserved":true}}`)
	image := []byte("caller-validated immutable image")
	imageName := Hash(image) + ".png"
	got, err := s.Commit(next, old.Revision, map[string][]byte{imageName: image})
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != Hash(next) || !bytes.Equal(got.Data, next) || !bytes.Equal(s.Current().Data, next) {
		t.Fatal("successful commit returned or activated incorrect bytes")
	}
	assertBackupTree(t, opts.BackupDir, before)
	assertBackupBytes(t, opts.ExistingBackupFile, old.Data)
	if _, err := os.Stat(filepath.Join(opts.BackupDir, old.Revision+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("reuse created an unnecessary duplicate backup", err)
	}
	assertBackupBytes(t, filepath.Join(opts.Root, "versions", old.Revision+".json"), old.Data)
	assertBackupBytes(t, filepath.Join(opts.Root, "versions", got.Revision+".json"), next)
	assertBackupBytes(t, filepath.Join(opts.Root, "images", imageName), image)
	current := assertBackupPointer(t, filepath.Join(opts.Root, "current.json"), got.Revision)
	previous := assertBackupPointer(t, filepath.Join(opts.Root, "previous.json"), old.Revision)
	if !bytes.Equal(current, s.pointerBytes) {
		t.Fatal("disk and cached current pointer bytes differ")
	}
	for _, item := range []struct {
		pointer []byte
		want    []byte
	}{{current, next}, {previous, old.Data}} {
		loaded, err := s.loadPointer(item.pointer)
		if err != nil || !bytes.Equal(loaded.Data, item.want) {
			t.Fatal("pointer does not resolve to exact immutable data", err)
		}
	}
	opts.Baseline = []byte(`{"schema_version":2,"value":"different bundled data"}`)
	reopened, err := Open(opts)
	if err != nil || !bytes.Equal(reopened.Current().Data, next) {
		t.Fatal("reopen did not read the newly active version", err)
	}
	got.Data[0] = 'x'
	if !bytes.Equal(s.Current().Data, next) {
		t.Fatal("result aliases active data")
	}
	// Explicit selection is not a permanent skip: the same old backup cannot
	// protect a second commit after the current revision has advanced.
	allBefore := backupTree(t, filepath.Dir(opts.Root))
	if _, err := s.Commit(old.Data, s.Current().Revision, nil); err == nil {
		t.Fatal("old verified backup silently reused for a different current revision")
	}
	assertBackupTree(t, filepath.Dir(opts.Root), allBefore)
}

func TestExistingBackupFirstCommitUsesReadOnlyFile(t *testing.T) {
	s, opts := testStore(t)
	old := s.Current()
	if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
		t.Fatal(err)
	}
	s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "independent-old.json")
	// Create a read-only temporary fixture, without changing any permissions
	// during Commit. A duplicate write would also change the directory snapshot.
	if err := os.WriteFile(s.opts.ExistingBackupFile, old.Data, 0444); err != nil {
		t.Fatal(err)
	}
	before := backupTree(t, opts.BackupDir)
	next := []byte(`{"schema_version":2,"value":"first new active"}`)
	if _, err := s.Commit(next, old.Revision, nil); err != nil {
		t.Fatal(err)
	}
	assertBackupTree(t, opts.BackupDir, before)
	assertBackupBytes(t, filepath.Join(opts.Root, "versions", old.Revision+".json"), old.Data)
	assertBackupBytes(t, filepath.Join(opts.Root, "versions", Hash(next)+".json"), next)
	assertBackupPointer(t, filepath.Join(opts.Root, "current.json"), Hash(next))
	assertBackupPointer(t, filepath.Join(opts.Root, "previous.json"), old.Revision)
}

func TestExistingBackupEmptyOptionRetainsDefaultWrite(t *testing.T) {
	s, opts, _ := existingBackupStore(t)
	old := s.Current()
	chosenBefore := backupTree(t, opts.BackupDir)
	s.opts.ExistingBackupFile = ""
	if _, err := s.Commit([]byte(`{"schema_version":1,"value":"default writer"}`), old.Revision, nil); err != nil {
		t.Fatal(err)
	}
	assertBackupBytes(t, filepath.Join(opts.BackupDir, old.Revision+".json"), old.Data)
	assertBackupBytes(t, opts.ExistingBackupFile, old.Data)
	after := backupTree(t, opts.BackupDir)
	for path, entry := range chosenBefore {
		if path != "." && !reflect.DeepEqual(entry, after[path]) {
			t.Fatalf("default writer changed existing unrelated backup %s", path)
		}
	}
	if len(after) != len(chosenBefore)+1 {
		t.Fatal("default backup path did not create exactly its normal immutable object")
	}
}

func TestExistingBackupNoOpPreservesOriginalOrder(t *testing.T) {
	s, _, all := existingBackupStore(t)
	old := s.Current()
	s.opts.ExistingBackupFile = filepath.Join(s.opts.BackupDir, "missing.json")
	before := backupTree(t, all)
	calls := 0
	s.opts.Validate = func(data []byte) error {
		calls++
		return nil
	}
	got, err := s.Commit(old.Data, old.Revision, nil)
	if err != nil || got.Revision != old.Revision || !bytes.Equal(got.Data, old.Data) || calls != 1 {
		t.Fatal("pinned no-op changed validation order or required an unnecessary backup", err, calls)
	}
	assertBackupTree(t, all, before)
}

func TestExistingBackupFailuresWriteNothing(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*testing.T, *Store, Options, string)
		want  error
	}{
		{"missing", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "missing.json")
		}, nil},
		{"relative", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.ExistingBackupFile = "active-catalog.json"
		}, nil},
		{"different_exact_bytes", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.WriteFile(opts.ExistingBackupFile, append(bytes.Clone(s.Current().Data), '\n'), 0444); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"wrong_revision", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.WriteFile(opts.ExistingBackupFile, []byte(`{"schema_version":1,"value":"other revision"}`), 0444); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"future_schema", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.WriteFile(opts.ExistingBackupFile, []byte(`{"schema_version":3,"value":"future"}`), 0444); err != nil {
				t.Fatal(err)
			}
		}, ErrFutureVersion},
		{"invalid_json", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.WriteFile(opts.ExistingBackupFile, []byte(`not JSON`), 0444); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"empty", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.WriteFile(opts.ExistingBackupFile, nil, 0444); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"oversized", func(t *testing.T, s *Store, opts Options, all string) {
			if err := os.Truncate(opts.ExistingBackupFile, MaxCatalogBytes+1); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"directory", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "unrelated")
		}, nil},
		{"outside_backup_dir", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.ExistingBackupFile = filepath.Join(all, "outside.json")
			if err := os.WriteFile(s.opts.ExistingBackupFile, s.Current().Data, 0600); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"sibling_prefix_is_not_inside", func(t *testing.T, s *Store, opts Options, all string) {
			dir := opts.BackupDir + "-other"
			if err := os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			s.opts.ExistingBackupFile = filepath.Join(dir, "old.json")
			if err := os.WriteFile(s.opts.ExistingBackupFile, s.Current().Data, 0600); err != nil {
				t.Fatal(err)
			}
		}, nil},
		{"inside_store_even_when_backup_dir_is_root", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.BackupDir = opts.Root
			s.opts.ExistingBackupFile = filepath.Join(opts.Root, "versions", s.Current().Revision+".json")
		}, nil},
		{"backup_dir_contains_store", func(t *testing.T, s *Store, opts Options, all string) {
			s.opts.BackupDir = all
		}, nil},
		{"validator_rejects_old_backup", func(t *testing.T, s *Store, opts Options, all string) {
			old := s.Current().Data
			s.opts.Validate = func(data []byte) error {
				if bytes.Equal(data, old) {
					return errors.New("backup schema rejected")
				}
				return nil
			}
		}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, opts, all := existingBackupStore(t)
			old := s.Current()
			tc.setup(t, s, opts, all)
			before := backupTree(t, all)
			_, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil)
			if err == nil || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatal("invalid explicit backup accepted or error identity lost", err)
			}
			if s.Current().Revision != old.Revision || !bytes.Equal(s.Current().Data, old.Data) {
				t.Fatal("failed backup verification changed active memory")
			}
			assertBackupTree(t, all, before)
		})
	}
}

func TestExistingBackupRejectsFileAliases(t *testing.T) {
	for _, target := range []string{"immutable", "current", "previous"} {
		t.Run(target, func(t *testing.T) {
			s, opts, all := existingBackupStore(t)
			old := s.Current()
			stored := filepath.Join(opts.Root, target+".json")
			if target == "immutable" {
				stored = filepath.Join(opts.Root, "versions", old.Revision+".json")
			}
			s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "hardlink.json")
			if err := os.Link(stored, s.opts.ExistingBackupFile); err != nil {
				t.Skipf("isolated filesystem does not support hardlinks: %v", err)
			}
			before := backupTree(t, all)
			_, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil)
			if err == nil || !strings.Contains(err.Error(), "同一文件") {
				t.Fatal("file alias not rejected before byte/schema checks", err)
			}
			assertBackupTree(t, all, before)
		})
	}
}

func TestExistingBackupRejectsSymlinkEscapes(t *testing.T) {
	for _, kind := range []string{"file", "directory_escape", "directory_into_store", "aliased_store_root", "versions_linked_into_backups", "images_linked_into_backups"} {
		t.Run(kind, func(t *testing.T) {
			s, opts, all := existingBackupStore(t)
			old := s.Current()
			link := filepath.Join(opts.BackupDir, "link")
			target := filepath.Join(opts.Root, "versions", old.Revision+".json")
			switch kind {
			case "file":
				s.opts.ExistingBackupFile = link
			case "directory_escape":
				target = filepath.Join(all, "outside-backups")
				if err := os.MkdirAll(target, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(target, "old.json"), old.Data, 0600); err != nil {
					t.Fatal(err)
				}
				s.opts.ExistingBackupFile = filepath.Join(link, "old.json")
			case "directory_into_store":
				target = filepath.Join(opts.Root, "versions")
				s.opts.ExistingBackupFile = filepath.Join(link, old.Revision+".json")
			case "versions_linked_into_backups":
				s.opts.Root = filepath.Join(all, "other-store")
				if err := os.MkdirAll(s.opts.Root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(s.opts.Root, "current.json"), s.pointerBytes, 0600); err != nil {
					t.Fatal(err)
				}
				link = filepath.Join(s.opts.Root, "versions")
				target = opts.BackupDir
			case "images_linked_into_backups":
				link = filepath.Join(opts.Root, "images")
				target = opts.BackupDir
			case "aliased_store_root":
				link = filepath.Join(all, "store-alias")
				target = opts.Root
				s.opts.Root = link
				s.opts.BackupDir = filepath.Join(opts.Root, "looks-external")
				if err := os.MkdirAll(s.opts.BackupDir, 0700); err != nil {
					t.Fatal(err)
				}
				s.opts.ExistingBackupFile = filepath.Join(s.opts.BackupDir, "old.json")
				if err := os.WriteFile(s.opts.ExistingBackupFile, old.Data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skipf("isolated filesystem does not allow symlinks: %v", err)
			}
			before := backupTree(t, all)
			if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); err == nil {
				t.Fatal("symlink or directory escape accepted")
			}
			assertBackupTree(t, all, before)
		})
	}
}

func TestExistingBackupTamperedDuringValidationWritesNothing(t *testing.T) {
	s, opts, all := existingBackupStore(t)
	old := s.Current()
	var expectedTree map[string]backupTreeEntry
	s.opts.Validate = func(data []byte) error {
		if bytes.Equal(data, old.Data) {
			// Simulate an external modification during schema validation. Commit
			// itself must not write anything after noticing the backup changed.
			if err := os.WriteFile(opts.ExistingBackupFile, append(bytes.Clone(old.Data), '\n'), 0444); err != nil {
				return err
			}
			expectedTree = backupTree(t, all)
		}
		return nil
	}
	if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); err == nil {
		t.Fatal("backup modified during validation accepted")
	}
	if expectedTree == nil {
		t.Fatal("test did not reach backup validation")
	}
	assertBackupTree(t, all, expectedTree)
	if s.Current().Revision != old.Revision {
		t.Fatal("backup tampering changed active memory")
	}
}

func TestExistingBackupPreCASAndValidationOrder(t *testing.T) {
	t.Run("expected_before_validation", func(t *testing.T) {
		s, _, all := existingBackupStore(t)
		before := backupTree(t, all)
		s.opts.Validate = func([]byte) error { t.Fatal("stale revision reached validator"); return nil }
		if _, err := s.Commit([]byte(`{"schema_version":3}`), "wrong", nil); !errors.Is(err, ErrConflict) {
			t.Fatal("stale revision not checked first", err)
		}
		assertBackupTree(t, all, before)
	})
	t.Run("new_schema_before_disk_CAS", func(t *testing.T) {
		s, opts, all := existingBackupStore(t)
		if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), []byte("external edit"), 0600); err != nil {
			t.Fatal(err)
		}
		before := backupTree(t, all)
		if _, err := s.Commit([]byte(`{"schema_version":3}`), s.Current().Revision, nil); !errors.Is(err, ErrFutureVersion) {
			t.Fatal("new schema validation no longer precedes disk CAS", err)
		}
		assertBackupTree(t, all, before)
	})
	t.Run("disk_CAS_before_backup", func(t *testing.T) {
		s, opts, all := existingBackupStore(t)
		old := s.Current()
		s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "missing.json")
		external := append(bytes.Clone(s.pointerBytes), '\n')
		if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), external, 0600); err != nil {
			t.Fatal(err)
		}
		before := backupTree(t, all)
		if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); !errors.Is(err, ErrConflict) {
			t.Fatal("changed pointer reached backup verification", err)
		}
		assertBackupTree(t, all, before)
		assertBackupBytes(t, filepath.Join(opts.Root, "current.json"), external)
	})
	t.Run("images_before_backup", func(t *testing.T) {
		s, opts, all := existingBackupStore(t)
		s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "missing.json")
		before := backupTree(t, all)
		_, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), s.Current().Revision, map[string][]byte{"invalid": []byte("bad")})
		if err == nil || !strings.Contains(err.Error(), "图片名称") {
			t.Fatal("image validation no longer precedes backup verification", err)
		}
		assertBackupTree(t, all, before)
	})
}

func TestExistingBackupCASAfterVerificationBeforeStaging(t *testing.T) {
	s, opts, all := existingBackupStore(t)
	old := s.Current()
	backupBefore := backupTree(t, opts.BackupDir)
	external := append(bytes.Clone(s.pointerBytes), '\n')
	var afterExternal map[string]backupTreeEntry
	s.opts.Validate = func(data []byte) error {
		if bytes.Equal(data, old.Data) {
			if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), external, 0600); err != nil {
				return err
			}
			afterExternal = backupTree(t, all)
		}
		return nil
	}
	if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("pointer changed during backup validation was overwritten", err)
	}
	if afterExternal == nil {
		t.Fatal("test did not reach backup validation")
	}
	assertBackupTree(t, all, afterExternal)
	assertBackupTree(t, opts.BackupDir, backupBefore)
	if s.Current().Revision != old.Revision {
		t.Fatal("pre-staging CAS refusal changed active memory")
	}
}

func TestExistingBackupLateCASRefusesCurrentReplacement(t *testing.T) {
	for _, point := range []string{"previous_callback_refuses", "after_previous_before_current", "final_atomic_callback_refuses"} {
		t.Run(point, func(t *testing.T) {
			s, opts, _ := existingBackupStore(t)
			old := s.Current()
			backupBefore := backupTree(t, opts.BackupDir)
			previousBefore, err := os.ReadFile(filepath.Join(opts.Root, "previous.json"))
			if err != nil {
				t.Fatal(err)
			}
			external := append(bytes.Clone(s.pointerBytes), '\n')
			currentCalls := 0
			s.opts.Replace = func(from, to string) error {
				if filepath.Base(to) == "previous.json" {
					if point == "previous_callback_refuses" {
						if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), external, 0600); err != nil {
							return err
						}
						return ErrConflict
					}
					if err := os.Rename(from, to); err != nil {
						return err
					}
					if point == "after_previous_before_current" {
						return os.WriteFile(filepath.Join(opts.Root, "current.json"), external, 0600)
					}
					return nil
				}
				currentCalls++
				if point == "final_atomic_callback_refuses" {
					if err := os.WriteFile(to, external, 0600); err != nil {
						return err
					}
					// Keep the caller's final safe-current check; store-level
					// rechecks do not replace atomic callback ownership.
					disk, err := os.ReadFile(to)
					if err != nil {
						return err
					}
					if !bytes.Equal(disk, s.pointerBytes) {
						return ErrConflict
					}
				}
				return os.Rename(from, to)
			}
			next := []byte(`{"schema_version":2,"value":"staged but not activated"}`)
			if _, err := s.Commit(next, old.Revision, nil); !errors.Is(err, ErrConflict) {
				t.Fatal("late external pointer change was overwritten", err)
			}
			if s.Current().Revision != old.Revision || !bytes.Equal(s.Current().Data, old.Data) {
				t.Fatal("late CAS refusal changed active memory")
			}
			assertBackupBytes(t, filepath.Join(opts.Root, "current.json"), external)
			assertBackupTree(t, opts.BackupDir, backupBefore)
			assertBackupBytes(t, filepath.Join(opts.Root, "versions", Hash(next)+".json"), next)
			if point == "previous_callback_refuses" {
				assertBackupBytes(t, filepath.Join(opts.Root, "previous.json"), previousBefore)
			}
			if point != "final_atomic_callback_refuses" && currentCalls != 0 {
				t.Fatal("store failed to stop before current pointer callback")
			}
			if point == "final_atomic_callback_refuses" && currentCalls != 1 {
				t.Fatal("final callback guard was not exercised")
			}
		})
	}
}

func TestExistingBackupVersionWriteFailureKeepsOld(t *testing.T) {
	s, opts := testStore(t)
	old := s.Current()
	if err := os.MkdirAll(opts.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.Root, "versions"), []byte("cannot create a directory here"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(opts.BackupDir, 0700); err != nil {
		t.Fatal(err)
	}
	s.opts.ExistingBackupFile = filepath.Join(opts.BackupDir, "active-catalog.json")
	if err := os.WriteFile(s.opts.ExistingBackupFile, old.Data, 0444); err != nil {
		t.Fatal(err)
	}
	before := backupTree(t, filepath.Dir(opts.Root))
	if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); err == nil {
		t.Fatal("version write failure reported success")
	}
	assertBackupTree(t, filepath.Dir(opts.Root), before)
	if s.Current().Revision != old.Revision || !bytes.Equal(s.Current().Data, old.Data) {
		t.Fatal("version write failure changed active data")
	}
}

func TestExistingBackupPointerFailureKeepsOld(t *testing.T) {
	s, opts, _ := existingBackupStore(t)
	old := s.Current()
	backupBefore := backupTree(t, opts.BackupDir)
	currentBefore := bytes.Clone(s.pointerBytes)
	s.opts.Replace = func(from, to string) error {
		if filepath.Base(to) == "current.json" {
			return errors.New("simulated access denied on current pointer")
		}
		return os.Rename(from, to)
	}
	if _, err := s.Commit([]byte(`{"schema_version":2,"value":"new"}`), old.Revision, nil); err == nil {
		t.Fatal("pointer write failure reported success")
	}
	assertBackupBytes(t, filepath.Join(opts.Root, "current.json"), currentBefore)
	assertBackupTree(t, opts.BackupDir, backupBefore)
	reopened, err := Open(opts)
	if err != nil || reopened.Current().Revision != old.Revision || !bytes.Equal(reopened.Current().Data, old.Data) {
		t.Fatal("pointer failure did not preserve old active data", err)
	}
}
