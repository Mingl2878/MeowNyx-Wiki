package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestDamageConfigModeAndSkillValidation(t *testing.T) {
	s := testConfigStore(t)
	for _, body := range []string{
		`{"patch":{"rk_pet_configs":{"249":{"mode":0,"iv":{},"nature":{}},"434":{"mode":1},"602":{}}}}`,
		`{"patch":{"rk_damage_skill_configs":{"249":{"skillType":"magic_attack","skillAttr":"钢","currentSkillName":"磁暴","basePower":0,"fixedBonus":-10,"percentBonus":0,"buff":-25,"comboCount":2,"starMeteor":4,"debuffPercent":"10+20","defenseMod":"-50","finalPowerManual":"0","future":42}}}}`,
		`{"patch":{"rk_damage_view":{"skill":{"basePower":0,"finalPowerManual":"0"}}}}`,
	} {
		configTransaction(t, s, body)
	}
	before := readConfigTest(t, s.path)
	for _, body := range []string{
		`{"patch":{"rk_pet_configs":{"249":{"mode":"0"}}}}`,
		`{"patch":{"rk_pet_configs":{"249":{"mode":2}}}}`,
		`{"patch":{"rk_pet_configs":{"249":{"mode":null}}}}`,
		`{"patch":{"rk_pet_configs":{"249":{"mode":0.5}}}}`,
		`{"patch":{"rk_damage_skill_configs":{"249":{"basePower":"100"}}}}`,
		`{"patch":{"rk_damage_skill_configs":{"249":{"skillType":"bad"}}}}`,
		`{"patch":{"rk_damage_skill_configs":{"0249":{}}}}`,
		`{"patch":{"rk_damage_skill_configs":{"249":{"comboCount":0}}}}`,
		`{"patch":{"rk_damage_view":{"skill":{"finalPowerManual":null}}}}`,
		`{"patch":{"rk_damage_view":{"bad":{}}}}`,
	} {
		if _, err := s.data(configObject(t, body)); err == nil {
			t.Fatal("invalid accepted", body)
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("validation mutated file")
		}
	}
	doc := configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"249":{"basePower":80}},"rk_pet_configs":{"249":{"future":{"keep":true}}}}}`)
	record := configObject(t, string(configSection(t, doc, "rk_damage_skill_configs")["249"]))
	if string(record["future"]) != "42" || string(record["finalPowerManual"]) != `"0"` {
		t.Fatal("unknown or untouched fields lost")
	}
	doc = configTransaction(t, s, `{"patch":{"rk_pet_configs":{"249":{"mode":1,"iv":{"hp":false}}}}}`)
	record = configObject(t, string(configSection(t, doc, "rk_pet_configs")["249"]))
	if compactConfigJSON(record["future"]) != `{"keep":true}` {
		t.Fatal("pet unknown fields lost")
	}
}

func TestDamageSkillUpgradeIsPerKeyAtomicAndOneTime(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, `{"schema_version":1,"settings":{},"legacy_imported":true,"data":{"rk_damage_skill_configs":{"249":{},"434":{"basePower":0}},"rk_damage_view":{"skill":{"basePower":0}}},"future":42}`)
	before := readConfigTest(t, s.path)
	body := `{"import":{"rk_damage_skill_configs":{"249":{"basePower":100},"434":{"basePower":100},"602":{"basePower":80}},"rk_damage_view":{"skill":{"basePower":100}},"rk_pet_configs":{"1":{}}}}`
	replace := s.replace
	s.replace = func(string, string) error { return errors.New("simulated write failure") }
	if _, err := s.data(configObject(t, body)); err == nil {
		t.Fatal("failed import succeeded")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("failed import changed file/flags")
	}
	s.replace = replace
	doc := configTransaction(t, s, body)
	if compactConfigJSON(configSection(t, doc, "rk_damage_skill_configs")["249"]) != "{}" {
		t.Fatal("empty record overwritten")
	}
	if len(configSection(t, doc, "rk_damage_skill_configs")) != 3 {
		t.Fatal("missing legacy import")
	}
	if _, exists := configObject(t, string(doc["data"]))["rk_pet_configs"]; exists {
		t.Fatal("old deleted value revived")
	}
	flags := configObject(t, string(doc["legacy_imported_keys"]))
	if string(flags["rk_damage_skill_configs"]) != "true" || string(flags["rk_damage_view"]) != "true" {
		t.Fatal("flags missing")
	}
	// Simulate deletion by a newer client. Stale origins must not reimport it.
	data := configObject(t, string(doc["data"]))
	data["rk_damage_skill_configs"] = json.RawMessage(`{}`)
	delete(data, "rk_damage_view")
	doc["data"], _ = json.Marshal(data)
	s.mu.Lock()
	err := s.writeLocked(doc, readConfigTest(t, s.path))
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	doc = configTransaction(t, s, body)
	if len(configSection(t, doc, "rk_damage_skill_configs")) != 0 {
		t.Fatal("stale record revived")
	}
	if _, exists := configObject(t, string(doc["data"]))["rk_damage_view"]; exists {
		t.Fatal("stale snapshot revived")
	}
	if string(doc["future"]) != "42" {
		t.Fatal("unknown top field lost")
	}
}

func TestDamageEmptyUpgradeMarksCompletionAndHTTPExposesFlags(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	w := configHTTP("POST", "/api/user-config", `{"import":{"rk_damage_skill_configs":{},"rk_damage_view":{}}}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	obj := configObject(t, w.Body.String())
	flags := configObject(t, string(obj["legacy_imported_keys"]))
	if string(flags["rk_damage_view"]) != "true" {
		t.Fatal("empty upgrade not marked")
	}
	doc := configTransaction(t, s, `{"import":{"rk_damage_view":{"skill":{"basePower":100}}}}`)
	if _, ok := configObject(t, string(doc["data"]))["rk_damage_view"]; ok {
		t.Fatal("empty upgrade revived stale snapshot")
	}
}

func TestDamageTwentyNineLegacySkillRecords(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, `{"schema_version":1,"settings":{},"legacy_imported":true,"data":{"rk_damage_selection":{"attacker":202,"attackerTeam":null},"rk_damage_skill_configs":{"1000":{}}}}`)
	records := jsonObject{"202": json.RawMessage(`{"basePower":150,"fixedBonus":0,"percentBonus":0,"buff":200,"comboCount":1,"debuffPercent":"0","defenseMod":"0","starMeteor":0,"finalPowerManual":"","skillType":"magic_attack","skillAttr":"水","currentSkillName":"天洪"}`)}
	for id := 1000; id < 1028; id++ {
		records[fmt.Sprint(id)] = json.RawMessage(fmt.Sprintf(`{"basePower":0,"debuffPercent":"%d","defenseMod":"-%d"}`, id, id))
	}
	raw, _ := json.Marshal(map[string]any{"import": map[string]any{"rk_damage_skill_configs": records, "rk_damage_view": jsonObject{}}})
	doc := configTransaction(t, s, string(raw))
	got := configSection(t, doc, "rk_damage_skill_configs")
	if len(got) != 29 || compactConfigJSON(got["1000"]) != "{}" {
		t.Fatal("legacy import lost records or replaced shared empty record")
	}
	r := configObject(t, string(got["202"]))
	if string(r["buff"]) != "200" || string(r["debuffPercent"]) != `"0"` || string(r["defenseMod"]) != `"0"` {
		t.Fatal("legacy numeric strings rejected or altered")
	}
}
