package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func chartControlsV2Fixture(t *testing.T) map[string]interface{} {
	t.Helper()
	state := chartSurvivalFixture(t)
	state["controlsRevision"] = 2
	controls := state["controls"].(map[string]interface{})
	controls["hpNature"] = false
	controls["defIV"] = map[string]interface{}{"defense": false, "magic_defense": false}
	return state
}

func TestChartControlsV2ValidationAndFavoritesNamespace(t *testing.T) {
	for _, selection := range []string{"ungrouped", "preset:Favorites", "preset:Survivors", "preset:Fire"} {
		state := chartControlsV2Fixture(t)
		state["activeGroupId"] = selection
		controls := state["controls"].(map[string]interface{})
		controls["atkNature"].(map[string]interface{})["attack"] = 1
		controls["atkIV"].(map[string]interface{})["magic_attack"] = false
		controls["hpIV"] = true
		controls["future"] = map[string]interface{}{"keep": true}
		if err := validateChartWorkspace(chartSurvivalJSON(t, state)); err != nil {
			t.Fatalf("valid revision2 selection %s rejected: %v", selection, err)
		}
	}
	mutations := []struct {
		name  string
		apply func(map[string]interface{})
	}{
		{"future revision", func(s map[string]interface{}) { s["controlsRevision"] = 3 }},
		{"negative revision", func(s map[string]interface{}) { s["controlsRevision"] = -1 }},
		{"string revision", func(s map[string]interface{}) { s["controlsRevision"] = "2" }},
		{"null revision", func(s map[string]interface{}) { s["controlsRevision"] = nil }},
		{"fractional revision", func(s map[string]interface{}) { s["controlsRevision"] = 1.5 }},
		{"negative nature", func(s map[string]interface{}) {
			s["controls"].(map[string]interface{})["atkNature"].(map[string]interface{})["attack"] = 2
		}},
		{"minus nature", func(s map[string]interface{}) {
			s["controls"].(map[string]interface{})["atkNature"].(map[string]interface{})["magic_attack"] = -1
		}},
		{"attack contradictory", func(s map[string]interface{}) {
			c := s["controls"].(map[string]interface{})
			c["atkNature"].(map[string]interface{})["attack"] = 1
			c["atkIV"].(map[string]interface{})["attack"] = false
		}},
		{"magic contradictory", func(s map[string]interface{}) {
			c := s["controls"].(map[string]interface{})
			c["atkNature"].(map[string]interface{})["magic_attack"] = 1
			c["atkIV"].(map[string]interface{})["magic_attack"] = false
		}},
		{"incomplete attack", func(s map[string]interface{}) {
			delete(s["controls"].(map[string]interface{})["atkIV"].(map[string]interface{}), "attack")
		}},
		{"incomplete nature", func(s map[string]interface{}) {
			delete(s["controls"].(map[string]interface{})["atkNature"].(map[string]interface{}), "magic_attack")
		}},
		{"incomplete defense", func(s map[string]interface{}) {
			delete(s["controls"].(map[string]interface{})["defIV"].(map[string]interface{}), "defense")
		}},
		{"HP IV off", func(s map[string]interface{}) { s["controls"].(map[string]interface{})["hpIV"] = false }},
		{"stale alias", func(s map[string]interface{}) { s["controls"].(map[string]interface{})["doubleLife"] = true }},
		{"missing hpNature", func(s map[string]interface{}) { delete(s["controls"].(map[string]interface{}), "hpNature") }},
		{"missing alias", func(s map[string]interface{}) { delete(s["controls"].(map[string]interface{}), "doubleLife") }},
		{"unimported", func(s map[string]interface{}) { s["legacyImported"] = false }},
		{"unknown preset", func(s map[string]interface{}) { s["activeGroupId"] = "preset:FavoritesStale" }},
		{"frozen preset", func(s map[string]interface{}) {
			s["groups"].([]interface{})[0].(map[string]interface{})["id"] = "preset:Favorites"
		}},
	}
	store := testConfigStore(t)
	configTransaction(t, store, `{"patch":{"rk_chart_workspace":{"state":`+string(chartSurvivalJSON(t, chartControlsV2Fixture(t)))+`}}}`)
	before := readConfigTest(t, store.path)
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			state := chartControlsV2Fixture(t)
			mutation.apply(state)
			raw := chartSurvivalJSON(t, state)
			if err := validateChartWorkspace(raw); err == nil {
				t.Fatalf("accepted invalid state: %s", raw)
			}
			if _, err := store.data(configObject(t, `{"patch":{"rk_chart_workspace":{"state":`+string(raw)+`}}}`)); err == nil {
				t.Fatal("invalid API patch accepted")
			}
			if !bytes.Equal(before, readConfigTest(t, store.path)) {
				t.Fatal("rejected state modified committed bytes")
			}
		})
	}
}

func TestChartControlsLegacyReadsRemainCompatibleWithoutServerReset(t *testing.T) {
	for _, revision := range []interface{}{nil, 0, 1} {
		store := testConfigStore(t)
		state := chartSurvivalFixture(t)
		if revision != nil {
			state["controlsRevision"] = revision
		}
		state["activeGroupId"] = "preset:Favorites"
		controls := state["controls"].(map[string]interface{})
		controls["atkNature"].(map[string]interface{})["attack"] = 2
		controls["atkNature"].(map[string]interface{})["magic_attack"] = 1
		controls["atkIV"].(map[string]interface{})["magic_attack"] = false
		raw := chartSurvivalJSON(t, state)
		configTransaction(t, store, `{"patch":{"rk_chart_workspace":{"state":`+string(raw)+`}}}`)
		before := readConfigTest(t, store.path)
		reopened := newUserConfigStore(filepath.Dir(store.path), store.backupDir)
		doc := configTransaction(t, reopened, `{}`)
		if compactConfigJSON(configSection(t, doc, "rk_chart_workspace")["state"]) != compactConfigJSON(raw) {
			t.Fatal("server read silently reset legacy controls or added a revision")
		}
		if !bytes.Equal(before, readConfigTest(t, store.path)) {
			t.Fatal("legacy read rewrote configuration")
		}
	}
}

func TestChartControlsV2ResetMarkerAtomicBackupRetryAndReopen(t *testing.T) {
	store := testConfigStore(t)
	state := chartSurvivalFixture(t)
	state["activeGroupId"] = "preset:Favorites"
	state["future"] = map[string]interface{}{"keep": []int{7, 8}}
	state["groups"].([]interface{})[0].(map[string]interface{})["future"] = "keep group metadata"
	controls := state["controls"].(map[string]interface{})
	controls["future"] = "keep control metadata"
	controls["atkNature"].(map[string]interface{})["attack"] = 2
	controls["atkIV"].(map[string]interface{})["attack"] = false
	controls["doubleLife"] = true
	initial := configTransaction(t, store, `{"patch":{"rk_pet_configs":{"249":{"mode":1,"nature":{"hp":2},"iv":{"hp":false}}},"rk_damage_skill_configs":{"249":{"basePower":180}},"rk_chart_workspace":{"state":`+string(chartSurvivalJSON(t, state))+`}}}`)
	before := readConfigTest(t, store.path)
	// This is the frontend reset snapshot, not a server reset operation. It changes
	// only the four control families and their alias, with the same atomic marker.
	state["controlsRevision"] = 2
	controls["atkIV"] = map[string]interface{}{"attack": true, "magic_attack": true}
	controls["atkNature"] = map[string]interface{}{"attack": 0, "magic_attack": 0}
	controls["defIV"] = map[string]interface{}{"defense": false, "magic_defense": false}
	controls["hpNature"] = false
	controls["doubleLife"] = false
	request := `{"patch":{"rk_chart_workspace":{"state":` + string(chartSurvivalJSON(t, state)) + `}}}`
	replace := store.replace
	store.replace = func(string, string) error { return errors.New("isolated revision2 replacement failure") }
	if _, err := store.data(configObject(t, request)); err == nil {
		t.Fatal("failed replacement reported success")
	}
	if !bytes.Equal(before, readConfigTest(t, store.path)) {
		t.Fatal("failed reset partially committed controls or marker")
	}
	store.replace = replace
	after := configTransaction(t, store, request)
	backupContains(t, store, before)
	if compactConfigJSON(configSection(t, after, "rk_chart_workspace")["state"]) != compactConfigJSON(chartSurvivalJSON(t, state)) {
		t.Fatal("retry did not preserve exact reset snapshot and metadata")
	}
	for _, key := range []string{"rk_pet_configs", "rk_damage_skill_configs"} {
		a, _ := json.Marshal(configSection(t, initial, key))
		b, _ := json.Marshal(configSection(t, after, key))
		if !bytes.Equal(a, b) {
			t.Fatalf("curve reset changed %s", key)
		}
	}
	controls["atkNature"].(map[string]interface{})["attack"] = 1
	controls["defIV"].(map[string]interface{})["defense"] = true
	controls["hpNature"], controls["doubleLife"] = true, true
	chosen := chartSurvivalJSON(t, state)
	configTransaction(t, store, `{"patch":{"rk_chart_workspace":{"state":`+string(chosen)+`}}}`)
	stable := readConfigTest(t, store.path)
	reopened := newUserConfigStore(filepath.Dir(store.path), store.backupDir)
	doc := configTransaction(t, reopened, `{}`)
	if compactConfigJSON(configSection(t, doc, "rk_chart_workspace")["state"]) != compactConfigJSON(chosen) || !bytes.Equal(stable, readConfigTest(t, store.path)) {
		t.Fatal("valid revision2 choices reset or rewrote on reopen")
	}
}
