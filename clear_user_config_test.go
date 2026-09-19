package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestClearAllPersonalConfigsIsExplicitManualOff(t *testing.T) {
	s := testConfigStore(t)
	beforeDoc := configTransaction(t, s, `{"patch":{"rk_pet_configs":{"1":{"mode":0,"iv":{"hp":true,"future":true},"nature":{"hp":2},"future":"keep"},"2":{"mode":1}},"rk_damage_skill_configs":{"1":{"basePower":160,"basePowerExpression":"70+90"}},"rk_chart_workspace":{"state":`+chartStateFixture+`},"rk_speed_pet_priority":{"100":[1,2]}}}`)
	before := readConfigTest(t, s.path)
	after := configTransaction(t, s, `{"clear_pet_configs":[1,3,9001]}`)
	backupContains(t, s, before)
	pets := configSection(t, after, "rk_pet_configs")
	if len(pets) != 4 {
		t.Fatal("must cover current catalog, dummy and saved IDs")
	}
	for id, raw := range pets {
		record, _ := parseObject(raw)
		if string(record["mode"]) != "1" {
			t.Fatalf("not manual %s", id)
		}
		for _, field := range []string{"iv", "nature"} {
			stats, _ := parseObject(record[field])
			want := "false"
			if field == "nature" {
				want = "0"
			}
			for _, stat := range []string{"hp", "attack", "magic_attack", "defense", "magic_defense", "speed"} {
				if string(stats[stat]) != want {
					t.Fatalf("not clear %s %s %s", id, field, stat)
				}
			}
		}
	}
	first, _ := parseObject(pets["1"])
	if string(first["future"]) != `"keep"` {
		t.Fatal("unknown record field lost")
	}
	iv, _ := parseObject(first["iv"])
	if string(iv["future"]) != "true" {
		t.Fatal("unknown future stat lost")
	}
	for _, key := range []string{"rk_damage_skill_configs", "rk_chart_workspace", "rk_speed_pet_priority"} {
		if compactConfigJSON(beforeDoc["data"]) == "" {
			t.Fatal("missing baseline")
		}
		a, _ := json.Marshal(configSection(t, beforeDoc, key))
		b, _ := json.Marshal(configSection(t, after, key))
		if !bytes.Equal(a, b) {
			t.Fatal("unrelated group changed", key)
		}
	}
	stable := readConfigTest(t, s.path)
	configTransaction(t, s, `{"clear_pet_configs":[1,3,9001]}`)
	if !bytes.Equal(stable, readConfigTest(t, s.path)) {
		t.Fatal("clear not idempotent")
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	fresh := configTransaction(t, reopened, `{}`)
	if compactConfigJSON(fresh["data"]) != compactConfigJSON(after["data"]) {
		t.Fatal("clear lost after reopen")
	}
	restored := configTransaction(t, reopened, `{"reset_pet_defaults":true}`)
	for _, raw := range configSection(t, restored, "rk_pet_configs") {
		obj, _ := parseObject(raw)
		if string(obj["mode"]) != "0" {
			t.Fatal("defaults remain distinct from clear")
		}
	}
}

func TestClearPersonalConfigsRejectsBadRequestsAndPreservesOnFailure(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_pet_configs":{"1":{"mode":0,"iv":{"hp":true}}}}}`)
	before := readConfigTest(t, s.path)
	for _, bad := range []string{`{"clear_pet_configs":true}`, `{"clear_pet_configs":[]}`, `{"clear_pet_configs":[0]}`, `{"clear_pet_configs":[1,1]}`, `{"clear_pet_configs":["1"]}`, `{"clear_pet_configs":[1.5]}`, `{"clear_pet_configs":[1],"patch":{}}`, `{"clear_pet_configs":[1],"reset_pet_defaults":true}`} {
		if _, err := s.data(configObject(t, bad)); err == nil {
			t.Fatal("accepted invalid request", bad)
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("invalid request wrote")
		}
	}
	s.replace = func(string, string) error { return errors.New("isolated clear failure") }
	if _, err := s.data(configObject(t, `{"clear_pet_configs":[1,9001]}`)); err == nil {
		t.Fatal("clear false success")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("failed clear changed profile")
	}
}

func TestGameDescriptionNotAnAutomaticStartupPage(t *testing.T) {
	s, err := settingsFromJSON(json.RawMessage(`{"default_route":"game-description","default_max_zoom":150}`), false)
	if err != nil || s.DefaultRoute != "petdex" || s.DefaultMaxZoom != 150 {
		t.Fatal("retired startup option fallback")
	}
	s, err = settingsFromJSON(json.RawMessage(`{"default_route":"chart"}`), false)
	if err != nil || s.DefaultRoute != "chart" {
		t.Fatal("valid default route changed")
	}
}
