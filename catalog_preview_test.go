package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
)

// Opt-in visual/integration fixture. Normal go test skips it. It serves real
// frontend files, but every API write goes to a fresh test-owned user directory.
// XHM_CATALOG_PREVIEW_SOURCE is a previously captured public source JSON, not a
// network endpoint; the fixture never downloads remote data or images.
func TestCatalogPreviewServer(t *testing.T) {
	if os.Getenv("XHM_CATALOG_PREVIEW") != "1" {
		t.Skip("opt-in isolated browser fixture")
	}
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	baselineFile := filepath.Join(root, "data", "catalog.json")
	if override := os.Getenv("XHM_CATALOG_PREVIEW_BASELINE"); override != "" {
		if !filepath.IsAbs(override) {
			t.Fatal("isolated preview baseline must be absolute")
		}
		baselineFile = override
	}
	baseline, err := os.ReadFile(baselineFile)
	if err != nil {
		t.Fatal(err)
	}
	temporary := t.TempDir()
	store, err := catalogstore.Open(catalogstore.Options{Root: filepath.Join(temporary, "catalog"), BackupDir: filepath.Join(temporary, "backups"), Baseline: baseline, Replace: replaceUserConfigFile, Validate: func(b []byte) error { _, err := catalog.Parse(b); return err }})
	if err != nil {
		t.Fatal(err)
	}
	rt := &catalogRuntime{store: store, baselineRoot: root}
	rt.update = newCatalogUpdateManager(rt)
	defer rt.update.Close()
	sourceFile := os.Getenv("XHM_CATALOG_PREVIEW_SOURCE")
	var source []byte
	if sourceFile != "" {
		source, err = os.ReadFile(sourceFile)
		if err != nil {
			t.Fatal(err)
		}
	}
	rt.update.fetchSource = func(ctx context.Context) ([]byte, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(source) == 0 {
			return nil, errors.New("隔离测试未配置官方快照，不进行网络访问")
		}
		return append([]byte(nil), source...), nil
	}
	rt.update.fetchImage = func(context.Context, string) ([]byte, error) {
		return nil, errors.New("隔离测试禁止下载图片，保留原图")
	}
	previousFS, previousRoot, previousCatalog, previousConfig := appFS, appRoot, activeCatalog, sharedUserConfig
	appFS = os.DirFS(root)
	appRoot = ""
	activeCatalog = rt
	sharedUserConfig = newUserConfigStore(filepath.Join(temporary, "profile"), filepath.Join(temporary, "profile-backups"))
	defer func() {
		appFS, appRoot, activeCatalog, sharedUserConfig = previousFS, previousRoot, previousCatalog, previousConfig
	}()
	mux := http.NewServeMux()
	closeBattle := RegisterBattleRecordRoutes(mux, filepath.Join(temporary, "battle-records.sqlite"))
	defer closeBattle()
	mux.HandleFunc("/api/", handleAPI)
	mux.HandleFunc("/", handleStatic)
	mux.HandleFunc("/__fixture/info", func(w http.ResponseWriter, r *http.Request) {
		b, _ := json.Marshal(map[string]any{"isolated": true, "profile": temporary, "catalog_revision": store.Current().Revision, "network": false})
		writeJSON(w, 200, b)
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	mux.HandleFunc("/__fixture/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if !guardUserConfigRequest(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", 405)
			return
		}
		writeJSON(w, 200, []byte(`{"ok":true}`))
		go server.Shutdown(context.Background())
	})
	fmt.Printf("CATALOG_PREVIEW_URL=http://%s/\n", listener.Addr().String())
	if err = server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatal(err)
	}
}
