package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
)

func TestFactoryCatalogStartsWithZeroPoliciesAndNoAppliedOperations(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("data", "catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	memory, err := readCatalogChoiceMemory(c)
	if err != nil || len(memory.Entries) != 0 {
		t.Fatal("factory data contains remembered developer choices", err)
	}
	fx := catalogTestNew(t, 1, false, nil)
	fx.opts.Baseline = raw
	fx.rt.store, err = catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
	state := fx.rt.update.Status()
	if state.State != "idle" || state.TaskID != "" || state.Phase != "" || len(state.Changes) != 0 || len(state.Issues) != 0 || len(state.Summary) != 0 || len(state.RememberedChoices) != 0 || state.AutomaticSourceChanges != 0 || state.Message != "" {
		t.Fatalf("initial state looks like a prior operation: %+v", state)
	}
	if !state.SourceBaselineActive {
		t.Fatal("factory reset removed Tencent baseline")
	}
	if _, err = os.Stat(filepath.Join(fx.opts.Root, "current.json")); !os.IsNotExist(err) {
		t.Fatal("reading factory data created an applied version pointer", err)
	}
	if !bytes.Equal(fx.rt.store.Current().Data, raw) {
		t.Fatal("initial load rewrote shipped data")
	}
}
func TestEmptySourceDeltaDoesNotReportHistoricalIssueCounts(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, baselineTestHP(t, 90), nil)
	state := catalogTestPreview(t, fx, baselineTestHP(t, 90))
	if len(state.Candidates) != 0 || len(state.Issues) != 0 || len(state.Changes) != 0 || state.AutomaticSourceChanges != 0 {
		t.Fatal("known initial differences reappeared", state)
	}
	if count, ok := state.Summary["issues"].(float64); ok && count != 0 {
		t.Fatal("acknowledged issues counted as outstanding", state.Summary)
	}
	if count, ok := state.Summary["issues"].(int); ok && count != 0 {
		t.Fatal("acknowledged issues counted as outstanding", state.Summary)
	}
}
