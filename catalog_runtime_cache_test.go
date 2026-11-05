package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/sourcebaseline"
)

// Every runtime is explicitly opened against t.TempDir; no app initializer,
// AppData, user configuration, network or global application filesystem is used.
func catalogRuntimeCacheOpen(t *testing.T, raw []byte) *catalogRuntime {
	t.Helper()
	dir := t.TempDir()
	rt := &catalogRuntime{}
	rt.open(catalogBootstrapReader(catalogBootstrapInput(raw, nil), nil), filepath.Join(dir, "catalog"), filepath.Join(dir, "backups"))
	if rt.initErr != nil {
		t.Fatal(rt.initErr)
	}
	t.Cleanup(rt.update.Close)
	return rt
}

func TestCatalogRuntimeCacheRealProjectionParity(t *testing.T) {
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
	rt := catalogRuntimeCacheOpen(t, raw)
	cached := rt.views[0]
	if cached == nil || cached.legacy == nil {
		t.Fatal("startup did not prepare its validated projection")
	}
	for i := 0; i < 2; i++ {
		snap, files, err := rt.legacySnapshot()
		if err != nil {
			t.Fatal(err)
		}
		if snap.Revision != catalogstore.Hash(raw) || !bytes.Equal(snap.Data, raw) || !reflect.DeepEqual(files, want) {
			t.Fatal("cached projection differs from the fully validated real fixture")
		}
		if rt.views[0] != cached {
			t.Fatal("unchanged bytes were decoded again")
		}
		w := httptest.NewRecorder()
		rt.handleData(w, catalogTestRequest(http.MethodGet, "/api/catalog/data", nil))
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		var response struct {
			OK       bool            `json:"ok"`
			Revision string          `json:"revision"`
			Monsters json.RawMessage `json:"monsters"`
			Moves    json.RawMessage `json:"moves"`
			Types    json.RawMessage `json:"types"`
			Wiki     json.RawMessage `json:"wiki"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		// The envelope's Marshal HTML-escapes/compacts RawMessages; compare to
		// the same old API wire encoding, not to unescaped legacy file bytes.
		wantBody := catalogTestJSON(t, map[string]any{"ok": true, "format": "meownyx-catalog-view/1", "revision": snap.Revision, "recovery": snap.Recovery, "monsters": json.RawMessage(want.Monsters), "moves": json.RawMessage(want.Moves), "types": json.RawMessage(want.Types), "wiki": json.RawMessage(want.Wiki)})
		if !response.OK || response.Revision != snap.Revision || !bytes.Equal(w.Body.Bytes(), wantBody) {
			t.Fatal("API combined different projections/revisions")
		}
		if bytes.Contains(w.Body.Bytes(), []byte(sourcebaseline.Extension)) {
			t.Fatal("API leaked inert source acknowledgement metadata")
		}
	}
	for name, wantBytes := range map[string][]byte{"data/monsters.json": want.Monsters, "data/moves.json": want.Moves, "data/types.json": want.Types, "data/wiki_monster_data.json": want.Wiki} {
		got, handled, err := rt.staticData(name)
		if err != nil || !handled || !bytes.Equal(got, wantBytes) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestCatalogRuntimeCacheOwnedBytesAndFullValidation(t *testing.T) {
	raw, _ := catalogBootstrapFixture(t, "未变", 11)
	c, err := catalog.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	baseline := sourcebaseline.New(strings.Repeat("a", 64))
	baselineRaw, err := json.Marshal(baseline)
	if err != nil {
		t.Fatal(err)
	}
	c.Extensions = catalog.Extensions{sourcebaseline.Extension: baselineRaw}
	raw, err = catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	rt := catalogRuntimeCacheOpen(t, raw)
	cached := rt.views[0]
	_, want, err := rt.legacySnapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := rt.validateData(raw); err != nil || rt.views[0] != cached {
		t.Fatal("validated exact bytes not reused", err)
	}
	// Neither the reader's bytes nor any returned byte slice can poison cache or store.
	raw[0] = 'X'
	snap, exposed, err := rt.legacySnapshot()
	if err != nil {
		t.Fatal(err)
	}
	snap.Data[0] = 'X'
	for _, part := range catalogBootstrapLegacyParts(&exposed) {
		(*part.data)[0] = 'X'
	}
	again, got, err := rt.legacySnapshot()
	if err != nil || again.Data[0] != '{' || !reflect.DeepEqual(got, want) {
		t.Fatal("caller mutated cached view", err)
	}
	for name, invalid := range map[string][]byte{
		"future schema":           bytes.Replace(again.Data, []byte(`"schema_version":2`), []byte(`"schema_version":3`), 1),
		"duplicate key":           append([]byte(`{"schema_version":2,`), again.Data[1:]...),
		"future baseline":         bytes.Replace(again.Data, []byte(`"version":1`), []byte(`"version":2`), 1),
		"invalid baseline digest": bytes.Replace(again.Data, []byte(strings.Repeat("a", 64)), []byte("invalid-digest"), 1),
		"trailing document":       append(bytes.Clone(again.Data), []byte(` {}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			if bytes.Equal(invalid, again.Data) {
				t.Fatal("invalid fixture did not change bytes")
			}
			if err := rt.validateData(invalid); err == nil {
				t.Fatal("warm cache bypassed strict validation")
			}
			if rt.views[0] != cached {
				t.Fatal("invalid input displaced valid cache")
			}
			if _, err := rt.store.Commit(invalid, again.Revision, nil); err == nil {
				t.Fatal("invalid input was committed")
			}
			if rt.store.Current().Revision != again.Revision {
				t.Fatal("invalid commit changed active pointer")
			}
		})
	}
}

func TestCatalogRuntimeCacheReservationBoundary(t *testing.T) {
	raw, _ := catalogBootstrapFixture(t, "本地", 11)
	rt := catalogRuntimeCacheOpen(t, raw)
	for name, reservation := range map[string]string{
		"future version":    `{"version":2,"entries":[]}`,
		"occupied local ID": `{"version":1,"entries":[{"local_id":11,"provider":"tencent-compendium","source_id":"144","identity":"NO.044|预留|"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			c, err := catalog.Parse(raw)
			if err != nil {
				t.Fatal(err)
			}
			c.Extensions = catalog.Extensions{catalogrecovery.Extension: json.RawMessage(reservation)}
			candidate, err := catalog.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			if err := rt.validateData(candidate); err == nil {
				t.Fatal("runtime accepted invalid reservation")
			}
			before := rt.store.Current()
			if _, err := rt.store.Commit(candidate, before.Revision, nil); err == nil {
				t.Fatal("commit accepted invalid reservation")
			}
			if rt.store.Current().Revision != before.Revision {
				t.Fatal("invalid reservation advanced pointer")
			}
			broken := &catalogRuntime{}
			dir := t.TempDir()
			broken.open(catalogBootstrapReader(catalogBootstrapInput(candidate, nil), nil), filepath.Join(dir, "catalog"), filepath.Join(dir, "backups"))
			if broken.initErr == nil {
				t.Fatal("startup accepted invalid reservation")
			}
		})
	}
}

func TestCatalogRuntimeCacheCandidateCannotPublishFailedCommit(t *testing.T) {
	before, _ := catalogBootstrapFixture(t, "原始", 11)
	next, _ := catalogBootstrapFixture(t, "候选", 11)
	dir := t.TempDir()
	rt := &catalogRuntime{}
	fail := false
	opts := catalogStartupOptions(dir, before)
	opts.Validate = rt.validateData
	opts.Replace = func(from, to string) error {
		if fail && filepath.Base(to) == "current.json" {
			return errors.New("injected pointer switch failure")
		}
		return catalogstore.ReplaceFile(from, to)
	}
	var err error
	rt.store, err = catalogstore.Open(opts)
	if err != nil {
		t.Fatal(err)
	}
	old, want, err := rt.legacySnapshot()
	if err != nil {
		t.Fatal(err)
	}
	fail = true
	if _, err = rt.store.Commit(next, old.Revision, nil); err == nil {
		t.Fatal("expected failed pointer switch")
	}
	if !bytes.Equal(rt.views[0].data, next) {
		t.Fatal("test did not exercise a fully validated cached candidate")
	}
	still, files, err := rt.legacySnapshot()
	if err != nil || still.Revision != old.Revision || !bytes.Equal(still.Data, before) || !reflect.DeepEqual(files, want) {
		t.Fatal("candidate cache published failed transaction", err)
	}
	fail = false
	committed, err := rt.store.Commit(next, old.Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	now, files, err := rt.legacySnapshot()
	if err != nil || now.Revision != committed.Revision || !bytes.Equal(now.Data, next) || bytes.Equal(files.Monsters, want.Monsters) {
		t.Fatal("successful commit served stale projection", err)
	}
	if _, err = rt.store.Commit(before, old.Revision, nil); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale revision accepted", err)
	}
	backup, err := os.ReadFile(filepath.Join(opts.BackupDir, old.Revision+".json"))
	if err != nil || !bytes.Equal(backup, before) {
		t.Fatal("exact durable backup lost", err)
	}
	// Force recovery from a corrupt active object. Warming must not erase the
	// warning, skip checksum validation, replace user bytes, or serve the bundle.
	if err := os.WriteFile(filepath.Join(opts.Root, "versions", committed.Revision+".json"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	reopened := &catalogRuntime{}
	reopened.open(catalogBootstrapReader(catalogBootstrapInput(next, nil), nil), opts.Root, opts.BackupDir)
	if reopened.initErr != nil {
		t.Fatal(reopened.initErr)
	}
	t.Cleanup(reopened.update.Close)
	for i := 0; i < 2; i++ {
		snap, got, err := reopened.legacySnapshot()
		if err != nil || snap.Revision != old.Revision || snap.Recovery == "" || !reflect.DeepEqual(got, want) {
			t.Fatal("cache lost recovered generation/warning", err)
		}
	}
	corrupt, err := os.ReadFile(filepath.Join(opts.Root, "versions", committed.Revision+".json"))
	if err != nil || string(corrupt) != "corrupt" {
		t.Fatal("recovery modified forensic bytes", err)
	}
}

func TestCatalogRuntimeCacheConcurrentSnapshotsStayPinned(t *testing.T) {
	before, _ := catalogBootstrapFixture(t, "原始", 11)
	next, _ := catalogBootstrapFixture(t, "更新", 11)
	rt := catalogRuntimeCacheOpen(t, before)
	want := map[string]string{catalogstore.Hash(before): "原始11", catalogstore.Hash(next): "更新11"}
	start := make(chan struct{})
	failures := make(chan error, 9)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < 25; j++ {
				snap, files, err := rt.legacySnapshot()
				if err != nil {
					failures <- err
					return
				}
				name, ok := want[snap.Revision]
				if !ok || catalogstore.Hash(snap.Data) != snap.Revision || !bytes.Contains(files.Monsters, []byte(name)) || !bytes.Contains(files.Wiki, []byte(name)) {
					failures <- fmt.Errorf("mixed-generation snapshot %s", snap.Revision)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < 4; i++ {
			data := next
			if i%2 != 0 {
				data = before
			}
			if _, err := rt.store.Commit(data, rt.store.Current().Revision, nil); err != nil {
				failures <- err
				return
			}
		}
	}()
	close(start)
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if rt.views[0] == nil || rt.views[1] == nil {
		t.Fatal("expected bounded two-generation cache")
	}
}
