package main

// Tests use only explicit TempDir stores. No real AppData, RKPP or window launch.
import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func rkppSettingJSON(t *testing.T, s UserSettings) jsonObject {
	t.Helper()
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return configObject(t, string(raw))
}

func TestRKPPSettingsStrictBooleanParser(t *testing.T) {
	for _, field := range []string{"rkpp_autostart", "close_to_background"} {
		for _, value := range []string{"true", "false"} {
			s, err := settingsFromJSON(json.RawMessage(`{"`+field+`":`+value+`}`), false)
			if err != nil || string(rkppSettingJSON(t, s)[field]) != value {
				t.Fatalf("%s=%s: %v", field, value, err)
			}
		}
		for _, value := range []string{"null", `"true"`, `"false"`, "0", "1", "[]", "{}"} {
			if _, err := settingsFromJSON(json.RawMessage(`{"`+field+`":`+value+`}`), false); err == nil {
				t.Fatalf("accepted non-boolean %s=%s", field, value)
			}
		}
	}
	s, err := settingsFromJSON(json.RawMessage(`{"close_behavior":"minimize"}`), false)
	if err != nil {
		t.Fatal(err)
	}
	obj := rkppSettingJSON(t, s)
	if string(obj["rkpp_autostart"]) != "false" || string(obj["close_to_background"]) != "false" || s.CloseBehavior != "minimize" {
		t.Fatal("missing flags must be false without replacing old close behavior")
	}
}

func TestRKPPSettingsReadsDoNotMigrateMissingFields(t *testing.T) {
	s := testConfigStore(t)
	if _, err := s.settings(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing-profile read wrote a file: %v", err)
	}
	before := []byte(`{"schema_version":1,"settings":{"close_behavior":"minimize","future_field":{"keep":true}},"data":{"synthetic_private":{"keep":7}},"future_top":[1,2]}`)
	putConfigFile(t, s.path, string(before))
	for i := 0; i < 2; i++ {
		settings, err := s.settings()
		if err != nil {
			t.Fatal(err)
		}
		if string(rkppSettingJSON(t, settings)["rkpp_autostart"]) != "false" {
			t.Fatal("missing flag must only be a runtime default")
		}
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("read rewrote old settings")
	}
	if _, err := os.Stat(s.backupDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read created a migration backup: %v", err)
	}
}

func TestRKPPSettingsExplicitSavePreservesUnknownAndFailureBytes(t *testing.T) {
	s := testConfigStore(t)
	before := []byte(`{"schema_version":1,"settings":{"rkpp_autostart":true,"close_to_background":true,"close_behavior":"minimize","future_field":{"keep":true}},"data":{"synthetic_private":{"keep":7}},"future_top":[1,2]}`)
	putConfigFile(t, s.path, string(before))
	for _, patch := range []string{`{"rkpp_autostart":null}`, `{"close_to_background":"false"}`} {
		if _, err := s.updateSettings(configObject(t, patch)); err == nil {
			t.Fatal("invalid save accepted")
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("invalid save changed disk bytes")
		}
	}
	originalReplace := s.replace
	s.replace = func(string, string) error { return errors.New("synthetic readonly replacement failure") }
	if _, err := s.updateSettings(configObject(t, `{"rkpp_autostart":false,"close_to_background":false}`)); err == nil {
		t.Fatal("failed replacement acknowledged as saved")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("failed replacement changed existing settings")
	}
	s.replace = originalReplace
	settings, err := s.updateSettings(configObject(t, `{"rkpp_autostart":false,"close_to_background":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.CloseBehavior != "minimize" {
		t.Fatal("new checkbox reset legacy selector")
	}
	doc := configObject(t, string(readConfigTest(t, s.path)))
	stored := configObject(t, string(doc["settings"]))
	if string(stored["rkpp_autostart"]) != "false" || string(stored["close_to_background"]) != "false" {
		t.Fatal("false must be written explicitly")
	}
	for _, section := range []string{"data", "future_top"} {
		old := configObject(t, string(before))
		if compactConfigJSON(doc[section]) != compactConfigJSON(old[section]) {
			t.Fatalf("unrelated %s changed", section)
		}
	}
	if compactConfigJSON(stored["future_field"]) != `{"keep":true}` {
		t.Fatal("unknown settings field lost")
	}
	if filepath.Dir(s.path) == filepath.Dir(sharedUserConfig.path) {
		t.Fatal("test must not touch shared profile")
	}
}
