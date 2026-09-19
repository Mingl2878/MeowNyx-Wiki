package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVersionAndEffectiveSettingCompatibility(t *testing.T) {
	if applicationTitle() != "小黑猫 wiki 版本"+strings.TrimSpace(applicationVersion) {
		t.Fatal("version title mismatch")
	}
	s := UserSettings{EffectiveIncludeSpeed: true}
	if err := json.Unmarshal([]byte(`{"default_route":"petdex"}`), &s); err != nil || !s.EffectiveIncludeSpeed {
		t.Fatal("legacy settings must preserve include-speed default")
	}
	if err := json.Unmarshal([]byte(`{"effective_include_speed":false}`), &s); err != nil || s.EffectiveIncludeSpeed {
		t.Fatal("false must be persisted, not defaulted back to true")
	}
	data, err := json.Marshal(s)
	if err != nil || !strings.Contains(string(data), `"effective_include_speed":false`) {
		t.Fatal("false missing from settings payload")
	}
}
