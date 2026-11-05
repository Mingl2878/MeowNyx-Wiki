package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
)

func chartSurvivalFixture(t *testing.T) map[string]interface{} {
	t.Helper()
	var state map[string]interface{}
	if err := json.Unmarshal([]byte(chartStateFixture), &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func chartSurvivalJSON(t *testing.T, state map[string]interface{}) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestChartSurvivalNamespaceAndNatureMigrationBoundary(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		state := chartSurvivalFixture(t)
		controls := state["controls"].(map[string]interface{})
		controls["doubleLife"] = legacy
		state["activeGroupId"] = "preset:Survivors"
		if err := validateChartWorkspace(chartSurvivalJSON(t, state)); err != nil {
			t.Fatalf("legacy migration input rejected: %v", err)
		}
		// JS migrates legacy doubleLife to hpNature. The Go boundary accepts
		// either form, without treating false nature as a false HP IV.
		controls["hpNature"] = legacy
		if err := validateChartWorkspace(chartSurvivalJSON(t, state)); err != nil {
			t.Fatal(err)
		}
		delete(controls, "doubleLife")
		if err := validateChartWorkspace(chartSurvivalJSON(t, state)); err != nil {
			t.Fatalf("modern nature-only document rejected: %v", err)
		}
	}
	for _, mutate := range []func(map[string]interface{}){
		func(s map[string]interface{}) { s["activeGroupId"] = "preset:SurvivorsStale" },
		func(s map[string]interface{}) { s["controls"].(map[string]interface{})["hpNature"] = 1 },
		func(s map[string]interface{}) { s["controls"].(map[string]interface{})["hpNature"] = nil },
		func(s map[string]interface{}) { s["controls"].(map[string]interface{})["hpIV"] = false },
		func(s map[string]interface{}) {
			s["controls"].(map[string]interface{})["defIV"].(map[string]interface{})["hp"] = false
		},
		func(s map[string]interface{}) {
			s["groups"].([]interface{})[0].(map[string]interface{})["id"] = "preset:Survivors"
		},
	} {
		state := chartSurvivalFixture(t)
		mutate(state)
		if err := validateChartWorkspace(chartSurvivalJSON(t, state)); err == nil {
			t.Fatalf("accepted invalid chart survival state: %s", chartSurvivalJSON(t, state))
		}
	}
}

func TestChartSurvivalAtomicSnapshotFailureRetryAndUnknownPreservation(t *testing.T) {
	store := testConfigStore(t) // isolated temp directory, never a real profile
	state := chartSurvivalFixture(t)
	state["future"] = map[string]interface{}{"keep": true}
	controls := state["controls"].(map[string]interface{})
	controls["hpNature"] = false
	configTransaction(t, store, `{"patch":{"rk_chart_workspace":{"state":`+string(chartSurvivalJSON(t, state))+`}}}`)
	before := readConfigTest(t, store.path)
	state["activeGroupId"] = "preset:Survivors"
	controls["hpNature"] = true
	controls["doubleLife"] = true
	// Appended snapshot is a user group's members, never a frozen builtin group.
	state["groups"].([]interface{})[0].(map[string]interface{})["petIds"] = []int{327, 249, 202}
	request := `{"patch":{"rk_chart_workspace":{"state":` + string(chartSurvivalJSON(t, state)) + `}}}`
	replace := store.replace
	store.replace = func(string, string) error { return errors.New("isolated chart write failure") }
	if _, err := store.data(configObject(t, request)); err == nil {
		t.Fatal("failed chart write reported success")
	}
	if !bytes.Equal(before, readConfigTest(t, store.path)) {
		t.Fatal("failed write partially committed selection, nature or members")
	}
	store.replace = replace
	doc := configTransaction(t, store, request)
	raw := configSection(t, doc, "rk_chart_workspace")["state"]
	var saved map[string]interface{}
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["activeGroupId"] != "preset:Survivors" || saved["future"].(map[string]interface{})["keep"] != true {
		t.Fatal("retry lost selection or unknown chart data")
	}
	groups := saved["groups"].([]interface{})
	if len(groups) != 1 || groups[0].(map[string]interface{})["id"] != "ungrouped" || len(groups[0].(map[string]interface{})["petIds"].([]interface{})) != 3 {
		t.Fatal("snapshot was not committed as one ordinary group")
	}
}
