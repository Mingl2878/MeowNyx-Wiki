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

func testStore(t *testing.T) (*Store, Options) {
	t.Helper()
	dir := t.TempDir()
	opts := Options{Root: filepath.Join(dir, "catalog"), BackupDir: filepath.Join(dir, "external-backups"), Baseline: []byte(`{"schema_version":1,"value":"baseline"}`), Replace: os.Rename, Validate: func(b []byte) error {
		if !json.Valid(b) {
			return errors.New("invalid JSON")
		}
		return nil
	}}
	s, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	return s, opts
}
func TestFirstCommitPinsLegacyBaselineAcrossBundledUpgrade(t *testing.T) {
	s, opts := testStore(t)
	before := s.Current()
	if _, err := s.Commit(before.Data, before.Revision, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(opts.Root, "current.json")); err != nil {
		t.Fatal("first unchanged commit did not pin migrated data", err)
	}
	opts.Baseline = []byte(`{"schema_version":1,"value":"new bundled catalog"}`)
	reopened, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reopened.Current().Data, before.Data) {
		t.Fatal("bundled upgrade overwrote the migrated local catalog")
	}
}

func TestCommitAndReopen(t *testing.T) {
	s, opts := testStore(t)
	before := s.Current()
	if _, err := os.Stat(opts.Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("read-only initial open created user files")
	}
	next := []byte(`{"schema_version":1,"value":"new"}`)
	got, err := s.Commit(next, before.Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision != Hash(next) {
		t.Fatal("wrong revision")
	}
	backup, err := os.ReadFile(filepath.Join(opts.BackupDir, before.Revision+".json"))
	if err != nil || !bytes.Equal(backup, before.Data) {
		t.Fatal("missing exact durable backup", err)
	}
	reopened, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reopened.Current().Data, next) {
		t.Fatal("restart lost committed data")
	}
	if _, err = s.Commit(before.Data, before.Revision, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("stale edit accepted", err)
	}
}
func TestFailedPointerSwitchKeepsOld(t *testing.T) {
	s, opts := testStore(t)
	old := s.Current()
	s.opts.Replace = func(from, to string) error {
		if filepath.Base(to) == "current.json" {
			return errors.New("simulated pointer failure")
		}
		return os.Rename(from, to)
	}
	_, err := s.Commit([]byte(`{"schema_version":1,"value":"new"}`), old.Revision, nil)
	if err == nil || s.Current().Revision != old.Revision {
		t.Fatal("failed commit changed memory")
	}
	reopened, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Current().Revision != old.Revision {
		t.Fatal("failed commit changed disk")
	}
}
func TestCorruptCurrentUsesPreviousWithoutDeleting(t *testing.T) {
	s, opts := testStore(t)
	old := s.Current()
	_, err := s.Commit([]byte(`{"schema_version":1,"value":"new"}`), old.Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(opts.Root, "versions", s.Current().Revision+".json")
	if err = os.WriteFile(file, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Current().Revision != old.Revision || recovered.Current().Recovery == "" {
		t.Fatal("recovery not explicit")
	}
	b, _ := os.ReadFile(file)
	if string(b) != "corrupt" {
		t.Fatal("recovery erased forensic input")
	}
}
func TestFutureVersionNeverDowngrades(t *testing.T) {
	s, opts := testStore(t)
	if _, err := s.Commit([]byte(`{"schema_version":3}`), s.Current().Revision, nil); !errors.Is(err, ErrFutureVersion) {
		t.Fatal(err)
	}
	if err := os.MkdirAll(opts.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), []byte(`{"version":2,"revision":"future"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(opts); !errors.Is(err, ErrFutureVersion) {
		t.Fatal("future pointer reset", err)
	}
}
func TestExternalWriterAndBadAssetsRejected(t *testing.T) {
	s, opts := testStore(t)
	old := s.Current()
	next := []byte(`{"schema_version":1,"value":"new"}`)
	for _, name := range []string{"../escape.png", strings.Repeat("a", 64) + ".png"} {
		if _, err := s.Commit(next, old.Revision, map[string][]byte{name: []byte("image")}); err == nil {
			t.Fatal("invalid asset accepted", name)
		}
	}
	if err := os.MkdirAll(opts.Root, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(opts.Root, "current.json"), []byte(`{"version":1}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Commit(next, old.Revision, nil); !errors.Is(err, ErrConflict) {
		t.Fatal("external edit overwritten", err)
	}
}
func TestBackupFailureStopsCommit(t *testing.T) {
	s, opts := testStore(t)
	if err := os.WriteFile(opts.BackupDir, []byte("not a directory"), 0600); err != nil {
		t.Fatal(err)
	}
	before := s.Current()
	if _, err := s.Commit([]byte(`{"schema_version":1,"value":"new"}`), before.Revision, nil); err == nil {
		t.Fatal("missing backup accepted")
	}
	if s.Current().Revision != before.Revision {
		t.Fatal("backup failure changed active data")
	}
}
func TestImmutableImageAndSnapshotCopies(t *testing.T) {
	s, _ := testStore(t)
	before := s.Current()
	before.Data[0] = 'x'
	if s.Current().Data[0] != '{' {
		t.Fatal("snapshot aliases store memory")
	}
	image := []byte("image bytes validated by caller")
	name := Hash(image) + ".png"
	_, err := s.Commit([]byte(`{"schema_version":1,"value":"image"}`), before.Revision, map[string][]byte{name: image})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Image(name)
	if err != nil || !bytes.Equal(got, image) {
		t.Fatal(err)
	}
	if _, err := s.Image("../current.json"); err == nil {
		t.Fatal("path escape accepted")
	}
}
