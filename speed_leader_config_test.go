package main

import "testing"

// Reuse the existing form-preference transaction schema; no new settings root or
// actual player profile is created for the speed-page display choice.
func TestSpeedLeaderChoiceUsesExistingAtomicFormPreferenceSection(t *testing.T) {
	s := testConfigStore(t)
	before := configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"火神|default|130":13,"other|default|50":99},"rk_pet_configs":{"13":{"mode":1}},"rk_damage_levels":{"619":{"attacker":{"slider":79,"manual":""}}}}}`)
	configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"leader:13:130":14}}}`)
	after := configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"leader:13:130":13}}}`)
	forms := configSection(t, after, "rk_speed_form_overrides")
	if string(forms["leader:13:130"]) != "13" || string(forms["火神|default|130"]) != "13" || string(forms["other|default|50"]) != "99" {
		t.Fatal("leader choice did not preserve sibling form preferences")
	}
	for _, section := range []string{"rk_pet_configs", "rk_damage_levels"} {
		if string(configSection(t, before, section)["13"]) != string(configSection(t, after, section)["13"]) || string(configSection(t, before, section)["619"]) != string(configSection(t, after, section)["619"]) {
			t.Fatalf("unrelated section changed: %s", section)
		}
	}
	// Existing form-preference compatibility accepts quoted decimal IDs too.
	quoted := configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"leader:13:130":"14"}}}`)
	if string(configSection(t, quoted, "rk_speed_form_overrides")["leader:13:130"]) != `"14"` {
		t.Fatal("quoted-ID compatibility changed")
	}
	configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"leader:13:130":13}}}`)
	for _, invalid := range []string{`0`, `-1`, `14.5`, `"bad"`, `true`, `{}`, `[]`} {
		if _, err := s.data(configObject(t, `{"patch":{"rk_speed_form_overrides":{"leader:13:130":`+invalid+`}}}`)); err == nil {
			t.Fatalf("invalid selected stable ID accepted: %s", invalid)
		}
	}
	current := configTransaction(t, s, `{}`)
	if string(configSection(t, current, "rk_speed_form_overrides")["leader:13:130"]) != "13" {
		t.Fatal("invalid request replaced the last valid display choice")
	}
}
