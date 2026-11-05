package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSkillSimulationStateRoundTripAndPartialMerge(t *testing.T) {
	s := testConfigStore(t)
	before := configTransaction(t, s, `{"patch":{"rk_pet_configs":{"202":{"mode":1,"iv":{"hp":false}}},"rk_skill_simulation":{"202:41":{"powerCount":3,"comboCount":0,"future":"keep"},"202:35":{"energy":6},"202:19":{"hpRatio":"77/100"}},"rk_damage_view":{"skill":{"basePower":225,"basePowerExpression":"90+(3*45)","skillInputKind":"power","skillInputValue":""}}}}`)
	old := readConfigTest(t, s.path)
	after := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"202:41":{"powerCount":4}},"rk_damage_skill_configs":{"202":{"basePower":60,"basePowerExpression":"15*2^(2)","skillInputKind":"power","skillInputValue":""}}}}`)
	backupContains(t, s, old)
	values := configSection(t, after, "rk_skill_simulation")
	r, _ := parseObject(values["202:41"])
	if string(r["powerCount"]) != "4" || string(r["future"]) != `"keep"` {
		t.Fatal("partial simulation merge lost fields")
	}
	if compactConfigJSON(configSection(t, before, "rk_pet_configs")["202"]) != compactConfigJSON(configSection(t, after, "rk_pet_configs")["202"]) {
		t.Fatal("personal config changed")
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	fresh := configTransaction(t, reopened, `{}`)
	if compactConfigJSON(fresh["data"]) != compactConfigJSON(after["data"]) {
		t.Fatal("simulation state lost on restart")
	}
	cleared := configTransaction(t, s, `{"clear_pet_configs":[202,9001]}`)
	if compactConfigJSON(configSection(t, cleared, "rk_skill_simulation")["202:41"]) != compactConfigJSON(values["202:41"]) {
		t.Fatal("personal clear touched skill counters")
	}
}

func TestSkillSimulationRejectsInvalidAndFailedWrites(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"202:41":{"powerCount":1}}}}`)
	old := readConfigTest(t, s.path)
	for _, bad := range []string{`{"0:41":{}}`, `{"202:01":{}}`, `{"202:41":{"powerCount":-1}}`, `{"202:41":{"comboCount":1.5}}`, `{"202:35":{"energy":11}}`, `{"202:19":{"hpRatio":"101/100"}}`, `{"202:19":{"hpRatio":"0/0"}}`, `{"202:19":{"hpRatio":"77"}}`, `{"202:510":{"counterMode":1}}`} {
		if _, err := s.data(configObject(t, `{"patch":{"rk_skill_simulation":`+bad+`}}`)); err == nil {
			t.Fatal("invalid simulation accepted", bad)
		}
		if !bytes.Equal(old, readConfigTest(t, s.path)) {
			t.Fatal("invalid simulation wrote")
		}
	}
	for _, bad := range []string{`{"skillInputKind":"script"}`, `{"skillInputValue":4}`, `{"basePowerExpression":"alert(1)"}`} {
		if _, err := s.data(configObject(t, `{"patch":{"rk_damage_view":{"skill":`+bad+`}}}`)); err == nil {
			t.Fatal("invalid skill input accepted")
		}
	}
	s.replace = func(string, string) error { return errors.New("isolated simulation failure") }
	if _, err := s.data(configObject(t, `{"patch":{"rk_skill_simulation":{"202:41":{"powerCount":2}}}}`)); err == nil {
		t.Fatal("false saved result")
	}
	if !bytes.Equal(old, readConfigTest(t, s.path)) {
		t.Fatal("failed simulation write changed file")
	}
}

func TestSkillSimulationFireAttackCountRoundTripAndPartialMerge(t *testing.T) {
	for _, count := range []int{0, 1, 1_000_000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			s := testConfigStore(t)
			before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":7,"comboCount":2,"future":{"nested":[1,"keep",null]}},"202:41":{"powerCount":3,"future":"other"}},"rk_pet_configs":{"14":{"mode":1,"iv":{"hp":false}}}}}`)
			old := readConfigTest(t, s.path)
			after := configTransaction(t, s, fmt.Sprintf(`{"patch":{"rk_skill_simulation":{"14:113":{"fireAttackCount":%d}}}}`, count))
			backupContains(t, s, old)
			record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["fireAttackCount"]) != fmt.Sprint(count) || string(record["powerCount"]) != "7" || string(record["comboCount"]) != "2" || compactConfigJSON(record["future"]) != `{"nested":[1,"keep",null]}` {
				t.Fatalf("growth patch lost independent counters or unknown fields: %s", configSection(t, after, "rk_skill_simulation")["14:113"])
			}

			// An older writer that only knows powerCount must not clear growth.
			after = configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":8}}}}`)
			record = configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["fireAttackCount"]) != fmt.Sprint(count) || string(record["powerCount"]) != "8" || string(record["comboCount"]) != "2" || compactConfigJSON(record["future"]) != `{"nested":[1,"keep",null]}` {
				t.Fatal("partial power update changed growth or unknown fields")
			}
			if !bytes.Equal(configSection(t, before, "rk_skill_simulation")["202:41"], configSection(t, after, "rk_skill_simulation")["202:41"]) || !bytes.Equal(configSection(t, before, "rk_pet_configs")["14"], configSection(t, after, "rk_pet_configs")["14"]) {
				t.Fatal("growth update changed unrelated records")
			}
			persisted := readConfigTest(t, s.path)
			reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
			reopened.replace = func(string, string) error {
				t.Error("reopening growth state attempted a write")
				return errors.New("unexpected read-time write")
			}
			fresh := configTransaction(t, reopened, `{}`)
			if compactConfigJSON(fresh["data"]) != compactConfigJSON(after["data"]) || !bytes.Equal(persisted, readConfigTest(t, s.path)) {
				t.Fatal("growth state changed on restart")
			}
		})
	}
}

func TestSkillSimulationFireAttackCountRejectsInvalidWithoutWrite(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":7,"fireAttackCount":2,"future":"keep"},"202:41":{"powerCount":3}}}}`)
	old := readConfigTest(t, s.path)
	writeAttempts := 0
	s.replace = func(string, string) error {
		writeAttempts++
		return errors.New("invalid input reached replace")
	}
	cases := []struct {
		name, key, value string
	}{
		{"null", "14:113", `null`},
		{"negative", "14:113", `-1`},
		{"above_limit", "14:113", `1000001`},
		{"overflow", "14:113", `999999999999999999999999999999`},
		{"fraction", "14:113", `1.5`},
		{"decimal_integer", "14:113", `1.0`},
		{"exponent", "14:113", `1e0`},
		{"string", "14:113", `"1"`},
		{"empty_string", "14:113", `""`},
		{"boolean", "14:113", `true`},
		{"object", "14:113", `{}`},
		{"array", "14:113", `[]`},
		{"wrong_species", "15:113", `1`},
		{"wrong_skill", "14:114", `1`},
		{"unrelated_pair_zero", "202:41", `0`},
		{"zero_species", "0:113", `1`},
		{"zero_skill", "14:0", `1`},
		{"species_leading_zero", "014:113", `1`},
		{"skill_leading_zero", "14:0113", `1`},
		{"extra_component", "14:113:1", `1`},
		{"missing_component", "14", `1`},
	}
	for _, op := range []string{"patch", "import"} {
		for _, tc := range cases {
			t.Run(op+"/"+tc.name, func(t *testing.T) {
				// A valid sibling edit must also remain uncommitted.
				request := fmt.Sprintf(`{"%s":{"rk_skill_simulation":{"%s":{"fireAttackCount":%s}},"rk_damage_skill_configs":{"14":{"basePower":90}}}}`, op, tc.key, tc.value)
				if _, err := s.data(configObject(t, request)); err == nil {
					t.Fatal("invalid growth accepted", request)
				}
				if writeAttempts != 0 || !bytes.Equal(old, readConfigTest(t, s.path)) {
					t.Fatal("invalid growth attempted a write or changed persisted state")
				}
			})
		}
	}
}

func TestSkillSimulationFireAttackCountFailedWriteRetainsPrevious(t *testing.T) {
	s := testConfigStore(t)
	before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":7,"fireAttackCount":2,"future":{"keep":true}}}}}`)
	old := readConfigTest(t, s.path)
	replace := s.replace
	failure := errors.New("isolated fire growth write failure")
	s.replace = func(string, string) error { return failure }
	request := `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":8,"fireAttackCount":3}}}}`
	if doc, err := s.data(configObject(t, request)); !errors.Is(err, failure) || doc != nil {
		t.Fatalf("failed growth write reported success: doc=%v err=%v", doc, err)
	}
	if !bytes.Equal(old, readConfigTest(t, s.path)) {
		t.Fatal("failed growth write changed persisted state")
	}
	for _, store := range []*userConfigStore{s, newUserConfigStore(filepath.Dir(s.path), s.backupDir)} {
		fresh := configTransaction(t, store, `{}`)
		if compactConfigJSON(fresh["data"]) != compactConfigJSON(before["data"]) {
			t.Fatal("failed growth write leaked into current or reopened state")
		}
	}
	s.replace = replace
	after := configTransaction(t, s, request)
	record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
	if string(record["fireAttackCount"]) != "3" || string(record["powerCount"]) != "8" || compactConfigJSON(record["future"]) != `{"keep":true}` {
		t.Fatal("growth retry failed or lost unknown fields")
	}
}

func TestSkillSimulationOldPowerCountReadDoesNotMigrateStoredFields(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, `{"schema_version":1,"settings":{},"data":{"rk_skill_simulation":{"14:113":{"powerCount":7},"14:114":{"powerCount":4,"future":"keep"}}},"legacy_imported":false}`)
	old := readConfigTest(t, s.path)
	replace := s.replace
	for _, store := range []*userConfigStore{s, newUserConfigStore(filepath.Dir(s.path), s.backupDir)} {
		store.replace = func(string, string) error {
			t.Error("legacy growth read attempted a write")
			return errors.New("unexpected growth migration")
		}
		fresh := configTransaction(t, store, `{}`)
		record := configObject(t, string(configSection(t, fresh, "rk_skill_simulation")["14:113"]))
		if _, exists := record["fireAttackCount"]; exists || len(record) != 1 || string(record["powerCount"]) != "7" {
			t.Fatal("legacy powerCount read materialized a compatibility field")
		}
		if !bytes.Equal(old, readConfigTest(t, s.path)) {
			t.Fatal("reading legacy powerCount rewrote persisted state")
		}
		if _, err := os.Stat(s.backupDir); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("reading legacy powerCount created backups: %v", err)
		}
	}
	// Explicit old-format edits also stay valid without filling in the new field.
	s.replace = replace
	after := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":8},"14:114":{"powerCount":5}}}}`)
	for key, power := range map[string]string{"14:113": "8", "14:114": "5"} {
		record := configObject(t, string(configSection(t, after, "rk_skill_simulation")[key]))
		if _, exists := record["fireAttackCount"]; exists || string(record["powerCount"]) != power {
			t.Fatal("old-format patch materialized a compatibility field", key)
		}
	}
}

func TestSkillSimulationFirePowerDetachedRoundTripAndClear(t *testing.T) {
	for _, detached := range []bool{false, true} {
		t.Run(fmt.Sprint(detached), func(t *testing.T) {
			s := testConfigStore(t)
			before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2,"future":{"keep":true}},"14:41":{"powerCount":3}},"rk_pet_configs":{"14":{"mode":1,"iv":{"hp":false}}}}}`)
			old := readConfigTest(t, s.path)
			after := configTransaction(t, s, fmt.Sprintf(`{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":0,"firePowerDetached":%t}}}}`, detached))
			backupContains(t, s, old)
			record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["firePowerDetached"]) != fmt.Sprint(detached) || string(record["powerCount"]) != "0" || string(record["fireAttackCount"]) != "2" || compactConfigJSON(record["future"]) != `{"keep":true}` {
				t.Fatal("manual-power provenance lost on partial merge", record)
			}
			persisted := readConfigTest(t, s.path)
			reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
			reopened.replace = func(string, string) error {
				t.Error("provenance restore attempted a write")
				return errors.New("unexpected marker migration")
			}
			fresh := configTransaction(t, reopened, `{}`)
			if compactConfigJSON(fresh["data"]) != compactConfigJSON(after["data"]) || !bytes.Equal(persisted, readConfigTest(t, s.path)) {
				t.Fatal("marker or counters changed on restart")
			}
			// Explicit selection synchronizes the counters and turns off the marker.
			after = configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":1,"fireAttackCount":1,"firePowerDetached":false}}}}`)
			record = configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["firePowerDetached"]) != "false" || string(record["powerCount"]) != "1" || string(record["fireAttackCount"]) != "1" || compactConfigJSON(record["future"]) != `{"keep":true}` {
				t.Fatal("explicit selection failed to clear provenance or preserve unknown fields")
			}
			if !bytes.Equal(configSection(t, before, "rk_skill_simulation")["14:41"], configSection(t, after, "rk_skill_simulation")["14:41"]) || !bytes.Equal(configSection(t, before, "rk_pet_configs")["14"], configSection(t, after, "rk_pet_configs")["14"]) {
				t.Fatal("marker update changed unrelated records")
			}
		})
	}
}

func TestSkillSimulationFirePowerDetachedRejectsInvalidWithoutWrite(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":0,"fireAttackCount":2,"firePowerDetached":true,"future":"keep"}}}}`)
	old := readConfigTest(t, s.path)
	writeAttempts := 0
	s.replace = func(string, string) error {
		writeAttempts++
		return errors.New("invalid provenance reached replace")
	}
	cases := []struct {
		name, key, value string
	}{
		{"null", "14:113", `null`},
		{"zero", "14:113", `0`},
		{"one", "14:113", `1`},
		{"string_true", "14:113", `"true"`},
		{"string_false", "14:113", `"false"`},
		{"empty_string", "14:113", `""`},
		{"object", "14:113", `{}`},
		{"array", "14:113", `[]`},
		{"wrong_species", "13:113", `true`},
		{"wrong_skill", "14:41", `true`},
		{"unrelated_pair_false", "202:41", `false`},
		{"species_leading_zero", "014:113", `true`},
		{"skill_leading_zero", "14:0113", `false`},
	}
	for _, op := range []string{"patch", "import"} {
		for _, tc := range cases {
			t.Run(op+"/"+tc.name, func(t *testing.T) {
				request := fmt.Sprintf(`{"%s":{"rk_skill_simulation":{"%s":{"firePowerDetached":%s}},"rk_damage_skill_configs":{"14":{"basePower":90}}}}`, op, tc.key, tc.value)
				if _, err := s.data(configObject(t, request)); err == nil {
					t.Fatal("invalid provenance accepted", request)
				}
				if writeAttempts != 0 || !bytes.Equal(old, readConfigTest(t, s.path)) {
					t.Fatal("invalid provenance attempted a write or changed persisted state")
				}
			})
		}
	}
}

func TestSkillSimulationFirePowerDetachedFailedWriteRetainsPrevious(t *testing.T) {
	s := testConfigStore(t)
	before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2,"firePowerDetached":false,"future":"keep"}}}}`)
	old := readConfigTest(t, s.path)
	replace := s.replace
	failure := errors.New("isolated manual-power marker write failure")
	s.replace = func(string, string) error { return failure }
	request := `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":0,"fireAttackCount":2,"firePowerDetached":true}}}}`
	if doc, err := s.data(configObject(t, request)); !errors.Is(err, failure) || doc != nil {
		t.Fatalf("failed provenance write reported success: doc=%v err=%v", doc, err)
	}
	if !bytes.Equal(old, readConfigTest(t, s.path)) {
		t.Fatal("failed provenance write changed persisted state")
	}
	for _, store := range []*userConfigStore{s, newUserConfigStore(filepath.Dir(s.path), s.backupDir)} {
		fresh := configTransaction(t, store, `{}`)
		if compactConfigJSON(fresh["data"]) != compactConfigJSON(before["data"]) {
			t.Fatal("failed provenance write leaked into current or reopened state")
		}
	}
	s.replace = replace
	after := configTransaction(t, s, request)
	record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
	if string(record["powerCount"]) != "0" || string(record["fireAttackCount"]) != "2" || string(record["firePowerDetached"]) != "true" || string(record["future"]) != `"keep"` {
		t.Fatal("manual-power retry failed or lost unknown fields")
	}
}

func TestSkillSimulationFireBuffOverrideRoundTripAndClear(t *testing.T) {
	for _, overridden := range []bool{false, true} {
		t.Run(fmt.Sprint(overridden), func(t *testing.T) {
			s := testConfigStore(t)
			before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2,"firePowerDetached":true,"future":"keep"},"13:113":{"powerCount":1}},"rk_pet_configs":{"14":{"mode":1,"iv":{"hp":false}}}}}`)
			old := readConfigTest(t, s.path)
			after := configTransaction(t, s, fmt.Sprintf(`{"patch":{"rk_skill_simulation":{"14:113":{"fireBuffOverridden":%t}},"rk_damage_skill_configs":{"14":{"buff":-60}},"rk_damage_view":{"skill":{"buff":-60}}}}`, overridden))
			backupContains(t, s, old)
			// Unrelated partial edits cannot clear takeover or manual-power provenance.
			after = configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"comboCount":1}}}}`)
			record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["fireBuffOverridden"]) != fmt.Sprint(overridden) || string(record["powerCount"]) != "2" || string(record["fireAttackCount"]) != "2" || string(record["firePowerDetached"]) != "true" || string(record["future"]) != `"keep"` {
				t.Fatal("BUFF takeover lost independent counters, provenance or unknown fields")
			}
			persisted := readConfigTest(t, s.path)
			reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
			reopened.replace = func(string, string) error {
				t.Error("BUFF takeover restore attempted migration")
				return errors.New("unexpected write")
			}
			fresh := configTransaction(t, reopened, `{}`)
			if compactConfigJSON(fresh["data"]) != compactConfigJSON(after["data"]) || !bytes.Equal(persisted, readConfigTest(t, s.path)) {
				t.Fatal("BUFF takeover or literal negative changed on restart")
			}
			after = configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":3,"fireAttackCount":3,"firePowerDetached":false,"fireBuffOverridden":false}}}}`)
			record = configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
			if string(record["fireBuffOverridden"]) != "false" || string(record["powerCount"]) != "3" || string(record["fireAttackCount"]) != "3" || string(record["future"]) != `"keep"` {
				t.Fatal("explicit selection failed to clear BUFF takeover")
			}
			if !bytes.Equal(configSection(t, before, "rk_skill_simulation")["13:113"], configSection(t, after, "rk_skill_simulation")["13:113"]) || !bytes.Equal(configSection(t, before, "rk_pet_configs")["14"], configSection(t, after, "rk_pet_configs")["14"]) {
				t.Fatal("BUFF marker update changed unrelated records")
			}
		})
	}
}

func TestSkillSimulationFireBuffOverrideRejectsInvalidWithoutWrite(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2,"fireBuffOverridden":true,"future":"keep"}},"rk_damage_skill_configs":{"14":{"buff":-60}}}}`)
	old := readConfigTest(t, s.path)
	writeAttempts := 0
	s.replace = func(string, string) error { writeAttempts++; return errors.New("invalid override reached replace") }
	for _, op := range []string{"patch", "import"} {
		for _, key := range []string{"14:113", "13:113", "14:41", "014:113", "14:0113", "0:113", "14:0", "14:113:1"} {
			for _, value := range []string{`null`, `0`, `1`, `"true"`, `"false"`, `{}`, `[]`, `true`, `false`} {
				if key == "14:113" && (value == "true" || value == "false") {
					continue
				}
				request := fmt.Sprintf(`{"%s":{"rk_skill_simulation":{"%s":{"fireBuffOverridden":%s}},"rk_damage_skill_configs":{"14":{"buff":0}}}}`, op, key, value)
				if _, err := s.data(configObject(t, request)); err == nil {
					t.Fatal("invalid BUFF takeover accepted", request)
				}
				if writeAttempts != 0 || !bytes.Equal(old, readConfigTest(t, s.path)) {
					t.Fatal("invalid BUFF takeover attempted write or changed saved baseline")
				}
			}
		}
	}
}

func TestSkillSimulationFireBuffOverrideFailedWriteRetainsPrevious(t *testing.T) {
	s := testConfigStore(t)
	before := configTransaction(t, s, `{"patch":{"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2,"fireBuffOverridden":false,"future":"keep"}},"rk_damage_skill_configs":{"14":{"buff":20}}}}`)
	old := readConfigTest(t, s.path)
	replace := s.replace
	failure := errors.New("isolated BUFF takeover write failure")
	s.replace = func(string, string) error { return failure }
	request := `{"patch":{"rk_skill_simulation":{"14:113":{"fireBuffOverridden":true}},"rk_damage_skill_configs":{"14":{"buff":0}}}}`
	if doc, err := s.data(configObject(t, request)); !errors.Is(err, failure) || doc != nil {
		t.Fatalf("failed BUFF takeover reported success: doc=%v err=%v", doc, err)
	}
	if !bytes.Equal(old, readConfigTest(t, s.path)) {
		t.Fatal("failed BUFF takeover changed persisted bytes")
	}
	for _, store := range []*userConfigStore{s, newUserConfigStore(filepath.Dir(s.path), s.backupDir)} {
		fresh := configTransaction(t, store, `{}`)
		if compactConfigJSON(fresh["data"]) != compactConfigJSON(before["data"]) {
			t.Fatal("failed BUFF takeover leaked into current or reopened state")
		}
	}
	s.replace = replace
	after := configTransaction(t, s, request)
	record := configObject(t, string(configSection(t, after, "rk_skill_simulation")["14:113"]))
	if string(record["fireBuffOverridden"]) != "true" || string(record["powerCount"]) != "2" || string(record["fireAttackCount"]) != "2" || string(record["future"]) != `"keep"` {
		t.Fatal("BUFF takeover retry failed or lost unknown fields")
	}
}
