package main

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestLevelControlsPersistAndPreserveOtherSections(t *testing.T) {
	s := testConfigStore(t)
	doc := configTransaction(t, s, `{"patch":{"rk_pet_configs":{"619":{"mode":1,"iv":{"hp":false}}},"rk_damage_levels":{"619":{"attacker":{"slider":49,"manual":"43"},"defender":{"slider":99,"manual":""},"future":"keep"}}}}`)
	prior := readConfigTest(t, s.path)
	next := configTransaction(t, s, `{"patch":{"rk_damage_levels":{"619":{"attacker":{"slider":19,"manual":"43"}}}}}`)
	backupContains(t, s, prior)
	if string(configSection(t, doc, "rk_pet_configs")["619"]) != string(configSection(t, next, "rk_pet_configs")["619"]) {
		t.Fatal("levels changed personal config")
	}
	levels, _ := parseObject(configSection(t, next, "rk_damage_levels")["619"])
	defender, _ := parseObject(levels["defender"])
	if string(levels["future"]) != `"keep"` || string(defender["slider"]) != "99" || string(defender["manual"]) != `""` {
		t.Fatal("partial level update lost other side")
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	fresh := configTransaction(t, reopened, `{}`)
	if compactConfigJSON(fresh["data"]) != compactConfigJSON(next["data"]) {
		t.Fatal("level state lost")
	}
	for _, bad := range []string{`{"attacker":{"slider":100,"manual":""}}`, `{"attacker":{"slider":1,"manual":"100"}}`, `{"defender":{"slider":9,"manual":"0"}}`, `{"attacker":{"slider":99,"manual":"1.5"}}`, `{"attacker":{"slider":99,"manual":"01"}}`, `{"attacker":{"slider":99,"manual":null}}`, `{"attacker":{"manual":"50"}}`} {
		before := readConfigTest(t, s.path)
		if _, err := s.data(configObject(t, `{"patch":{"rk_damage_levels":{"619":`+bad+`}}}`)); err == nil {
			t.Fatal("invalid levels accepted", bad)
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("invalid level wrote")
		}
	}
}

func TestTrickRoomSettingsDefaultPersistenceAndType(t *testing.T) {
	s := testConfigStore(t)
	settings, err := s.settings()
	if err != nil || settings.TrickRoom {
		t.Fatal("new setting default must be false")
	}
	settings, err = s.updateSettings(configObject(t, `{"trick_room":true,"effective_speed_mode":"threshold","effective_speed_threshold":80}`))
	if err != nil || !settings.TrickRoom {
		t.Fatal("cannot save trick room", err)
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	settings, err = reopened.settings()
	if err != nil || !settings.TrickRoom || settings.EffectiveSpeedThreshold != 80 {
		t.Fatal("setting not durable")
	}
	before := readConfigTest(t, s.path)
	if _, err = s.updateSettings(configObject(t, `{"trick_room":"true"}`)); err == nil {
		t.Fatal("string flag accepted")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("bad settings wrote")
	}
	settings, err = s.updateSettings(configObject(t, `{"trick_room":false}`))
	if err != nil || settings.TrickRoom || settings.EffectiveSpeedMode != "threshold" {
		t.Fatal("unrelated speed policy changed")
	}
}
