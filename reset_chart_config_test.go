package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

const chartStateFixture = `{"version":1,"activeGroupId":"ungrouped","legacyImported":true,"groups":[{"id":"ungrouped","name":"未分组","petIds":[327,249]}],"controls":{"atkIV":{"attack":true,"magic_attack":true},"atkNature":{"attack":0,"magic_attack":0},"defIV":{"defense":true,"magic_defense":true},"doubleLife":false}}`

func TestIndependentChartConfigAndExpression(t *testing.T) {
	s := testConfigStore(t)
	doc := configTransaction(t, s, `{"patch":{"rk_chart_workspace":{"state":`+chartStateFixture+`},"rk_damage_skill_configs":{"569":{"basePower":160,"basePowerExpression":"70+90"}},"rk_damage_view":{"skill":{"basePower":160,"basePowerExpression":"70+90"}}}}`)
	if len(configSection(t, doc, "rk_chart_workspace")) != 1 {
		t.Fatal("chart not saved")
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	fresh := configTransaction(t, reopened, `{}`)
	if compactConfigJSON(configSection(t, doc, "rk_chart_workspace")["state"]) != compactConfigJSON(configSection(t, fresh, "rk_chart_workspace")["state"]) {
		t.Fatal("chart state did not survive reopening")
	}
	for _, bad := range []string{`{"patch":{"rk_damage_view":{"skill":{"basePowerExpression":"alert(1)"}}}}`, `{"patch":{"rk_damage_view":{"skill":{"basePowerExpression":160}}}}`, `{"patch":{"rk_chart_workspace":{"state":null}}}`, `{"patch":{"rk_chart_workspace":{"state":{}}}}`} {
		before := readConfigTest(t, s.path)
		if _, err := s.data(configObject(t, bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("invalid request wrote")
		}
	}
}

func TestResetPetDefaultsPreservesAllOtherDataAndBackup(t *testing.T) {
	s := testConfigStore(t)
	initial := configTransaction(t, s, `{"patch":{"rk_pet_configs":{"249":{"iv":{"hp":false},"nature":{"hp":2},"mode":1,"future":"keep"},"434":{"iv":{},"nature":{}},"602":{"mode":0}},"rk_damage_selection":{"attacker":249},"rk_damage_skill_configs":{"249":{"basePower":180}},"rk_chart_workspace":{"state":`+chartStateFixture+`},"rk_speed_pet_priority":{"136":[249]}}}`)
	before := readConfigTest(t, s.path)
	after := configTransaction(t, s, `{"reset_pet_defaults":true}`)
	backupContains(t, s, before)
	for id, raw := range configSection(t, after, "rk_pet_configs") {
		obj, err := parseObject(raw)
		if err != nil || string(obj["mode"]) != "0" {
			t.Fatalf("not default %s", id)
		}
	}
	a := configSection(t, after, "rk_pet_configs")
	p, _ := parseObject(a["249"])
	if string(p["future"]) != `"keep"` || string(p["nature"]) != `{"hp":2}` {
		t.Fatal("reset destroyed protected fields")
	}
	firstData, _ := parseObject(initial["data"])
	lastData, _ := parseObject(after["data"])
	delete(firstData, "rk_pet_configs")
	delete(lastData, "rk_pet_configs")
	x, _ := json.Marshal(firstData)
	y, _ := json.Marshal(lastData)
	if !bytes.Equal(x, y) {
		t.Fatal("reset changed unrelated state")
	}
	stable := readConfigTest(t, s.path)
	configTransaction(t, s, `{"reset_pet_defaults":true}`)
	if !bytes.Equal(stable, readConfigTest(t, s.path)) {
		t.Fatal("idempotent reset rewrote file")
	}
	for _, bad := range []string{`{"reset_pet_defaults":false}`, `{"reset_pet_defaults":true,"patch":{}}`, `{"reset_pet_defaults":null}`} {
		if _, err := s.data(configObject(t, bad)); err == nil {
			t.Fatal("accepted invalid reset")
		}
	}
}

func TestResetPetDefaultsFailureDoesNotCommit(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_pet_configs":{"1":{"mode":1,"iv":{"hp":false}}}}}`)
	before := readConfigTest(t, s.path)
	s.replace = func(string, string) error { return errors.New("simulated failure") }
	if _, err := s.data(configObject(t, `{"reset_pet_defaults":true}`)); err == nil {
		t.Fatal("false success")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("failed reset changed profile")
	}
}
