package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"testing"
)

func TestAbuBuffOverrideOnlyNativePerPetContext(t *testing.T) {
	for _, value := range []string{"true", "false"} {
		s := testConfigStore(t)
		doc := configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"623":{"buff":-20,"abuBuffOverridden":`+value+`}}}}`)
		fields := configObject(t, string(configSection(t, doc, "rk_damage_skill_configs")["623"]))
		if string(fields["abuBuffOverridden"]) != value || string(fields["buff"]) != "-20" {
			t.Fatal("native marker or literal negative baseline changed")
		}
		reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
		again := configTransaction(t, reopened, `{}`)
		if compactConfigJSON(configSection(t, doc, "rk_damage_skill_configs")["623"]) != compactConfigJSON(configSection(t, again, "rk_damage_skill_configs")["623"]) {
			t.Fatal("native takeover did not roundtrip")
		}
	}
}

func TestAbuBuffOverrideRejectsWrongOwnerAndNonBoolean(t *testing.T) {
	requests := []string{
		`{"rk_damage_skill_configs":{"595":{"abuBuffOverridden":true}}}`,
		`{"rk_damage_skill_configs":{"616":{"abuBuffOverridden":false}}}`,
		`{"rk_damage_skill_configs":{"617":{"abuBuffOverridden":true}}}`,
		`{"rk_damage_skill_configs":{"14":{"abuBuffOverridden":false}}}`,
		`{"rk_damage_view":{"skill":{"abuBuffOverridden":true}}}`,
		`{"rk_damage_view":{"skill":{"abuBuffOverridden":false}}}`,
	}
	for _, value := range []string{`null`, `0`, `1`, `"true"`, `"false"`, `{}`, `[]`} {
		requests = append(requests, `{"rk_damage_skill_configs":{"623":{"abuBuffOverridden":`+value+`}}}`)
	}
	for _, op := range []string{"patch", "import"} {
		for _, body := range requests {
			s := testConfigStore(t)
			configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"623":{"buff":7}}}}`)
			before := readConfigTest(t, s.path)
			if _, err := s.data(configObject(t, `{"`+op+`":`+body+`}`)); err == nil {
				t.Fatalf("accepted invalid marker context/type: %s %s", op, body)
			}
			if !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("rejected marker rewrote the profile")
			}
		}
	}
}

func TestAbuBuffOverridePartialChangesPreserveOtherRecords(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"623":{"buff":-20,"basePower":60,"future":{"keep":true},"abuBuffOverridden":true},"595":{"buff":11}},"rk_damage_view":{"skill":{"buff":-20},"speedPriority":[488,623]},"rk_skill_simulation":{"14:113":{"powerCount":2,"fireAttackCount":2}},"rk_damage_levels":{"623":{"attacker":{"slider":80,"manual":""}}}}}`)
	first := configTransaction(t, s, `{}`)
	configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"623":{"abuBuffOverridden":false}}}}`)
	latest := configTransaction(t, s, `{"patch":{"rk_damage_view":{"skill":{"buff":0,"basePower":100}}}}`)
	fields := configObject(t, string(configSection(t, latest, "rk_damage_skill_configs")["623"]))
	if string(fields["buff"]) != "-20" || string(fields["basePower"]) != "60" || string(fields["abuBuffOverridden"]) != "false" || compactConfigJSON(fields["future"]) != `{"keep":true}` {
		t.Fatal("native marker patch changed its sibling skill values")
	}
	if compactConfigJSON(configSection(t, latest, "rk_damage_skill_configs")["595"]) != compactConfigJSON(configSection(t, first, "rk_damage_skill_configs")["595"]) {
		t.Fatal("wolf personal data changed")
	}
	view := configSection(t, latest, "rk_damage_view")
	if string(view["speedPriority"]) != "[488,623]" {
		t.Fatal("active-skill save erased independent speed priority")
	}
	if _, exists := configObject(t, string(view["skill"]))["abuBuffOverridden"]; exists {
		t.Fatal("native-only marker leaked into the ownerless active view")
	}
	for _, section := range []string{"rk_skill_simulation", "rk_damage_levels"} {
		beforeData, _ := parseObject(first["data"])
		afterData, _ := parseObject(latest["data"])
		if compactConfigJSON(beforeData[section]) != compactConfigJSON(afterData[section]) {
			t.Fatalf("unrelated section changed: %s", section)
		}
	}
}

func TestAbuBuffOverrideFailedReplaceKeepsOldRecordAndCanRetry(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_damage_skill_configs":{"623":{"buff":0,"abuBuffOverridden":false}}}}`)
	before := readConfigTest(t, s.path)
	replace := s.replace
	s.replace = func(string, string) error { return errors.New("isolated replacement failure") }
	request := configObject(t, `{"patch":{"rk_damage_skill_configs":{"623":{"buff":-10,"abuBuffOverridden":true}}}}`)
	if _, err := s.data(request); err == nil {
		t.Fatal("failure was reported as saved")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("failed save damaged the previous profile")
	}
	s.replace = replace
	doc, err := s.data(request)
	if err != nil {
		t.Fatal(err)
	}
	fields := configObject(t, string(configSection(t, doc, "rk_damage_skill_configs")["623"]))
	if string(fields["buff"]) != "-10" || string(fields["abuBuffOverridden"]) != "true" {
		t.Fatal("retry did not persist literal manual takeover")
	}
}
