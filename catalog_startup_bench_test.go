package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/sourcebaseline"
)

// These benchmarks read the real bundled fixture, but all store paths are under
// b.TempDir. They never initialize the application, resolve AppData, listen on a
// port, or write the bundled catalog. without_source_baseline is an in-memory
// ablation, not a historical fixture or an alternate distributable catalog.
func catalogStartupFixture(b *testing.B, withBaseline bool) []byte {
	b.Helper()
	raw, err := os.ReadFile(filepath.Join("data", "catalog.json"))
	if err != nil {
		b.Fatal(err)
	}
	if withBaseline {
		return raw
	}
	var c map[string]json.RawMessage
	if err = json.Unmarshal(raw, &c); err != nil {
		b.Fatal(err)
	}
	var extensions map[string]json.RawMessage
	if err = json.Unmarshal(c["extensions"], &extensions); err != nil {
		b.Fatal(err)
	}
	delete(extensions, sourcebaseline.Extension)
	c["extensions"], err = json.Marshal(extensions)
	if err != nil {
		b.Fatal(err)
	}
	raw, err = json.Marshal(c)
	if err != nil {
		b.Fatal(err)
	}
	return raw
}

func catalogStartupOptions(dir string, raw []byte) catalogstore.Options {
	return catalogstore.Options{Root: filepath.Join(dir, "catalog"), BackupDir: filepath.Join(dir, "backups"), Baseline: raw, Replace: catalogstore.ReplaceFile, Validate: func(b []byte) error { _, err := catalog.Parse(b); return err }}
}

func catalogStartupData(b *testing.B, rt *catalogRuntime) {
	b.Helper()
	w := httptest.NewRecorder()
	rt.handleData(w, httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8788/api/catalog/data", nil))
	if w.Code != http.StatusOK {
		b.Fatalf("data status %d: %s", w.Code, w.Body.String())
	}
}

func BenchmarkCatalogStartup(b *testing.B) {
	for _, withBaseline := range []bool{true, false} {
		name := "real"
		if !withBaseline {
			name = "without_source_baseline"
		}
		b.Run(name, func(b *testing.B) {
			raw := catalogStartupFixture(b, withBaseline)
			b.Run("Parse", func(b *testing.B) {
				b.ReportAllocs()
				b.SetBytes(int64(len(raw)))
				for b.Loop() {
					if _, err := catalog.Parse(raw); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("Validate", func(b *testing.B) {
				c, err := catalog.Parse(raw)
				if err != nil {
					b.Fatal(err)
				}
				b.ReportAllocs()
				for b.Loop() {
					if err := catalog.Validate(c); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("ExportLegacy", func(b *testing.B) {
				c, err := catalog.Parse(raw)
				if err != nil {
					b.Fatal(err)
				}
				b.ReportAllocs()
				for b.Loop() {
					if _, err := catalog.ExportLegacy(c); err != nil {
						b.Fatal(err)
					}
				}
			})
			b.Run("DataRequest", func(b *testing.B) {
				opts := catalogStartupOptions(b.TempDir(), raw)
				rt := &catalogRuntime{}
				rt.open(catalogBootstrapReader(catalogBootstrapInput(raw, nil), nil), opts.Root, opts.BackupDir)
				if rt.initErr != nil {
					b.Fatal(rt.initErr)
				}
				b.Cleanup(rt.update.Close)
				b.ReportAllocs()
				for b.Loop() {
					catalogStartupData(b, rt)
				}
			})
			b.Run("PrepareOpenAndFirstData", func(b *testing.B) {
				opts := catalogStartupOptions(b.TempDir(), raw)
				read := catalogBootstrapReader(catalogBootstrapInput(raw, nil), nil)
				b.ReportAllocs()
				for b.Loop() {
					rt := &catalogRuntime{}
					rt.open(read, opts.Root, opts.BackupDir)
					if rt.initErr != nil {
						b.Fatal(rt.initErr)
					}
					catalogStartupData(b, rt)
					rt.update.Close()
				}
			})
		})
	}
}
