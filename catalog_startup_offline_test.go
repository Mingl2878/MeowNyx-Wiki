package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Source checks must be a deliberate operation, never an effect of loading
// catalog data, opening the update page, or polling local task status.
func TestCatalogLoadsDoNotCheckTencentUntilExplicitStart(t *testing.T) {
	fx := catalogTestNew(t, 2, true, nil)
	before := fx.rt.store.Current()
	var calls atomic.Int32
	fx.rt.update.fetchSource = func(context.Context) ([]byte, error) {
		calls.Add(1)
		return nil, errors.New("isolated source probe; no network")
	}
	fx.rt.update.fetchImage = func(context.Context, string) ([]byte, error) {
		t.Error("read path must not fetch artwork")
		return nil, errors.New("no network")
	}
	for i := 0; i < 3; i++ {
		response := httptest.NewRecorder()
		fx.rt.handleData(response, catalogTestRequest(http.MethodGet, "/api/catalog/data", nil))
		if response.Code != 200 {
			t.Fatalf("load failed: %d %s", response.Code, response.Body.String())
		}
		state := catalogTestStatus(t, fx.rt)
		if state.State != "idle" || state.TaskID != "" {
			t.Fatalf("read started a task: %+v", state)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("a read path checked the online source")
	}
	after := fx.rt.store.Current()
	if after.Revision != before.Revision || !bytes.Equal(after.Data, before.Data) {
		t.Fatal("loading changed data")
	}
	// The same fetch boundary is reached exactly once by an explicit check action.
	if err := fx.rt.update.Start(); err != nil {
		t.Fatal(err)
	}
	catalogTestWait(t, fx.rt.update)
	if calls.Load() != 1 {
		t.Fatalf("explicit check count=%d", calls.Load())
	}
}
