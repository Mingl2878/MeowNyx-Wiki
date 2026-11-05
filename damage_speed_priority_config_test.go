package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const damageSpeedPriorityProfile = `{"schema_version":1,"settings":{"futureSetting":{"keep":true}},"legacy_imported":true,"legacy_imported_keys":{"rk_damage_view":true,"future_import":false},"futureTop":{"keep":[1,2]},"data":{"rk_damage_view":{"skill":{"basePower":80,"buff":-20,"finalPowerManual":"0","futureSkill":{"keep":true}},"speedPriority":[8,14,619],"futureSibling":{"keep":[3,2,1]}},"rk_speed_form_overrides":{"leader:13:130":14,"火神|default|130":13,"futureLeader":"14"},"rk_speed_pet_priority":{"130":[13,14]},"rk_pet_configs":{"14":{"mode":1,"future":42}},"rk_damage_selection":{"attacker":14,"defender":9001},"future_section":{"keep":true}}}`

func assertDamageSpeedPriorityUnrelatedPreserved(t *testing.T, before, after jsonObject) {
	t.Helper()
	for key, value := range before {
		if key != "data" && compactConfigJSON(after[key]) != compactConfigJSON(value) {
			t.Fatalf("unrelated top-level field %s changed", key)
		}
	}
	oldData := configObject(t, string(before["data"]))
	newData := configObject(t, string(after["data"]))
	if len(oldData) != len(newData) {
		t.Fatal("priority patch added or removed a section")
	}
	for key, value := range oldData {
		if key != "rk_damage_view" && compactConfigJSON(newData[key]) != compactConfigJSON(value) {
			t.Fatalf("unrelated section %s changed", key)
		}
	}
	oldView := configSection(t, before, "rk_damage_view")
	newView := configSection(t, after, "rk_damage_view")
	if compactConfigJSON(newView["futureSibling"]) != compactConfigJSON(oldView["futureSibling"]) {
		t.Fatal("stored unknown damage-view sibling lost")
	}
}

func TestDamageSpeedPriorityValidAndRoundTrip(t *testing.T) {
	for _, ids := range []string{
		`[]`, `[14]`, `[619,8,14]`, `[1,9007199254740991]`,
		`[16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1]`,
	} {
		t.Run(ids, func(t *testing.T) {
			s := testConfigStore(t)
			useConfigStore(t, s)
			w := configHTTP(http.MethodPost, "/api/user-config", `{"patch":{"rk_damage_view":{"speedPriority":`+ids+`}}}`)
			if w.Code != http.StatusOK {
				t.Fatalf("valid list rejected: %d %s", w.Code, w.Body.String())
			}
			response := configObject(t, w.Body.String())
			if got := compactConfigJSON(configSection(t, response, "rk_damage_view")["speedPriority"]); got != ids {
				t.Fatalf("priority order changed: got %s, want %s", got, ids)
			}
			reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
			doc := configTransaction(t, reopened, `{}`)
			view := configSection(t, doc, "rk_damage_view")
			if len(view) != 1 || compactConfigJSON(view["speedPriority"]) != ids {
				t.Fatal("priority did not round-trip as an independent array field")
			}
			if string(doc["legacy_imported"]) != "false" {
				t.Fatal("patch changed the import flag")
			}
			if _, exists := doc["legacy_imported_keys"]; exists {
				t.Fatal("priority patch introduced migration flags")
			}
		})
	}
}

func TestDamageSpeedPriorityInvalidPreservesOldFile(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	putConfigFile(t, s.path, damageSpeedPriorityProfile)
	before := readConfigTest(t, s.path)
	invalid := []string{
		`null`, `{}`, `{"0":14}`, `14`, `true`, `false`, `"[14]"`, `""`,
		`["14"]`, `[14,"8"]`, `[null]`, `[true]`, `[{}]`, `[[14]]`,
		`[0]`, `[-0]`, `[-1]`, `[1.5]`, `[9001]`, `[14,9001]`,
		`[14,14]`, `[14,8,14]`, `[9007199254740991,9007199254740991]`,
		`[9007199254740992]`, `[9007199254740993]`, `[9223372036854775808]`, `[1e100]`,
		`[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]`,
	}
	for _, op := range []string{"patch", "import"} {
		for _, ids := range invalid {
			t.Run(op+"/"+ids, func(t *testing.T) {
				body := fmt.Sprintf(`{"%s":{"rk_damage_view":{"speedPriority":%s,"skill":{"basePower":100}},"rk_speed_form_overrides":{"leader:13:130":13}}}`, op, ids)
				w := configHTTP(http.MethodPost, "/api/user-config", body)
				if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"ok":false`) {
					t.Fatalf("invalid list accepted: %d %s", w.Code, w.Body.String())
				}
				if !bytes.Equal(before, readConfigTest(t, s.path)) {
					t.Fatal("rejected list changed old file, skill, leader preferences or flags")
				}
			})
		}
	}
}

func TestDamageSpeedPriorityPartialPatchPreservesSkillAndSiblings(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, damageSpeedPriorityProfile)
	original := configTransaction(t, s, `{}`)
	originalSkill := configSection(t, original, "rk_damage_view")["skill"]
	for _, ids := range []string{`[14,8,619]`, `[619]`, `[]`} {
		doc := configTransaction(t, s, `{"patch":{"rk_damage_view":{"speedPriority":`+ids+`}}}`)
		view := configSection(t, doc, "rk_damage_view")
		if compactConfigJSON(view["speedPriority"]) != ids {
			t.Fatal("array patch merged with the old list instead of replacing it")
		}
		if compactConfigJSON(view["skill"]) != compactConfigJSON(originalSkill) {
			t.Fatal("priority patch cleared or changed the skill snapshot")
		}
		assertDamageSpeedPriorityUnrelatedPreserved(t, original, doc)
	}
	backupContains(t, s, []byte(damageSpeedPriorityProfile))

	// Skill partials keep the independent empty array and existing skill fields.
	doc := configTransaction(t, s, `{"patch":{"rk_damage_view":{"skill":{"basePower":100}}}}`)
	view := configSection(t, doc, "rk_damage_view")
	skill := configObject(t, string(view["skill"]))
	if string(view["speedPriority"]) != "[]" || string(skill["basePower"]) != "100" || string(skill["buff"]) != "-20" || string(skill["finalPowerManual"]) != `"0"` || compactConfigJSON(skill["futureSkill"]) != `{"keep":true}` {
		t.Fatal("skill partial changed priority or dropped untouched skill fields")
	}
	assertDamageSpeedPriorityUnrelatedPreserved(t, original, doc)
	before := readConfigTest(t, s.path)
	configTransaction(t, s, `{"patch":{"rk_damage_view":{}}}`)
	configTransaction(t, s, `{"patch":{"rk_damage_view":{"skill":{}}}}`)
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("empty partial erased saved skill or priority")
	}
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	doc = configTransaction(t, reopened, `{}`)
	if compactConfigJSON(configSection(t, doc, "rk_damage_view")["skill"]) != compactConfigJSON(view["skill"]) || string(configSection(t, doc, "rk_damage_view")["speedPriority"]) != "[]" {
		t.Fatal("partial changes did not survive reopening")
	}
	assertDamageSpeedPriorityUnrelatedPreserved(t, original, doc)
}

func TestDamageSpeedPriorityKeepsSkillValidationAndRejectsUnknownSiblings(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, damageSpeedPriorityProfile)
	before := readConfigTest(t, s.path)
	for _, op := range []string{"patch", "import"} {
		for _, entry := range []string{
			`"skill":null`, `"skill":[]`, `"skill":{"basePower":"100"}`,
			`"skill":{"comboCount":0}`, `"skill":{"finalPowerManual":null}`,
			`"skill":{"skillType":"bad"}`, `"unknown":{}`, `"futureSibling":{}`, `"speed_priority":[]`,
		} {
			body := fmt.Sprintf(`{"%s":{"rk_damage_view":{"speedPriority":[14],%s}}}`, op, entry)
			if _, err := s.data(configObject(t, body)); err == nil {
				t.Fatalf("invalid skill or unknown sibling accepted: %s", body)
			}
			if !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("invalid sibling write changed the old profile")
			}
		}
	}
	// Existing forward-compatible skill fields remain valid; do not tighten that validator.
	doc := configTransaction(t, s, `{"patch":{"rk_damage_view":{"skill":{"futureAdded":{"keep":true},"buff":-30},"speedPriority":[619,14]}}}`)
	view := configSection(t, doc, "rk_damage_view")
	skill := configObject(t, string(view["skill"]))
	if compactConfigJSON(skill["futureAdded"]) != `{"keep":true}` || string(skill["buff"]) != "-30" || string(skill["basePower"]) != "80" || compactConfigJSON(view["speedPriority"]) != "[619,14]" {
		t.Fatal("existing skill validation or combined field patch changed")
	}
}

func TestDamageSpeedPriorityImportUsesExistingFlagsAndPresence(t *testing.T) {
	for _, tc := range []struct {
		name, current, imported, flag, global, want string
	}{
		{"fresh import", "", `[619,14]`, "false", "false", `[619,14]`},
		{"upgrade after old global import", "", `[619,14]`, "false", "true", `[619,14]`},
		{"empty imported array", "", `[]`, "false", "true", `[]`},
		{"existing empty array wins", `,"speedPriority":[]`, `[619,14]`, "false", "true", `[]`},
		{"existing order wins", `,"speedPriority":[8,14]`, `[619,14]`, "false", "true", `[8,14]`},
		{"completed section does not reimport", "", `[619,14]`, "true", "true", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testConfigStore(t)
			useConfigStore(t, s)
			putConfigFile(t, s.path, fmt.Sprintf(`{"schema_version":1,"settings":{},"legacy_imported":%s,"legacy_imported_keys":{"rk_damage_view":%s,"future_import":false},"data":{"rk_damage_view":{"skill":{"basePower":80,"future":42}%s},"rk_speed_form_overrides":{"leader:13:130":14}}}`, tc.global, tc.flag, tc.current))
			body := `{"import":{"rk_damage_view":{"speedPriority":` + tc.imported + `,"skill":{"basePower":100}}}}`
			w := configHTTP(http.MethodPost, "/api/user-config", body)
			if w.Code != http.StatusOK {
				t.Fatalf("import failed: %d %s", w.Code, w.Body.String())
			}
			response := configObject(t, w.Body.String())
			flags := configObject(t, string(response["legacy_imported_keys"]))
			if len(flags) != 2 || string(flags["rk_damage_view"]) != "true" || string(flags["future_import"]) != "false" || string(response["legacy_imported"]) != "true" {
				t.Fatal("import did not expose existing section flags unchanged")
			}
			view := configSection(t, response, "rk_damage_view")
			if compactConfigJSON(view["speedPriority"]) != tc.want || compactConfigJSON(view["skill"]) != `{"basePower":80,"future":42}` {
				t.Fatal("import changed existing skill/order or skipped the missing priority")
			}
			before := readConfigTest(t, s.path)
			configTransaction(t, s, `{"import":{"rk_damage_view":{"speedPriority":[1]}}}`)
			if !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("completed import revived a stale priority")
			}
			reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
			doc := configTransaction(t, reopened, `{}`)
			if compactConfigJSON(configSection(t, doc, "rk_damage_view")["speedPriority"]) != tc.want || string(configSection(t, doc, "rk_speed_form_overrides")["leader:13:130"]) != "14" || compactConfigJSON(doc["legacy_imported_keys"]) != compactConfigJSON(response["legacy_imported_keys"]) {
				t.Fatal("imported priority/flags or leader preference did not round-trip")
			}
		})
	}
}

func TestDamageSpeedPriorityImportThenPatchWins(t *testing.T) {
	s := testConfigStore(t)
	doc := configTransaction(t, s, `{"import":{"rk_damage_view":{"speedPriority":[8,14],"skill":{"basePower":80,"buff":-20}}},"patch":{"rk_damage_view":{"speedPriority":[],"skill":{"basePower":100}}}}`)
	view := configSection(t, doc, "rk_damage_view")
	skill := configObject(t, string(view["skill"]))
	if string(view["speedPriority"]) != "[]" || string(skill["basePower"]) != "100" || string(skill["buff"]) != "-20" {
		t.Fatal("explicit array replacement or partial skill patch lost to import")
	}
	flags := configObject(t, string(doc["legacy_imported_keys"]))
	if len(flags) != 1 || string(flags["rk_damage_view"]) != "true" {
		t.Fatal("independent field introduced new migration flags")
	}
}

func TestDamageSpeedPriorityWriteFailurePreservesOldFileAndFlags(t *testing.T) {
	for _, op := range []string{"patch", "import"} {
		t.Run(op, func(t *testing.T) {
			s := testConfigStore(t)
			useConfigStore(t, s)
			original := `{"schema_version":1,"settings":{},"legacy_imported":false,"legacy_imported_keys":{"future_import":false},"data":{"rk_damage_view":{"skill":{"basePower":80},"futureSibling":{"keep":true}},"rk_speed_form_overrides":{"leader:13:130":14}}}`
			putConfigFile(t, s.path, original)
			before := readConfigTest(t, s.path)
			replace := s.replace
			s.replace = func(string, string) error { return errors.New("simulated atomic replace failure") }
			body := fmt.Sprintf(`{"%s":{"rk_damage_view":{"speedPriority":[619,14]}}}`, op)
			w := configHTTP(http.MethodPost, "/api/user-config", body)
			if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), `"ok":false`) {
				t.Fatalf("failed write reported success: %d %s", w.Code, w.Body.String())
			}
			if !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("failed write replaced original file or committed import flags")
			}
			backupContains(t, s, before)
			files, err := os.ReadDir(filepath.Dir(s.path))
			if err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				if strings.HasPrefix(file.Name(), ".user-config-") {
					t.Fatal("failed write left a staged profile")
				}
			}
			s.replace = replace
			doc := configTransaction(t, s, body)
			view := configSection(t, doc, "rk_damage_view")
			if compactConfigJSON(view["speedPriority"]) != `[619,14]` || compactConfigJSON(view["skill"]) != `{"basePower":80}` || compactConfigJSON(view["futureSibling"]) != `{"keep":true}` || string(configSection(t, doc, "rk_speed_form_overrides")["leader:13:130"]) != "14" {
				t.Fatal("retry did not commit priority while preserving old siblings")
			}
			flags := configObject(t, string(doc["legacy_imported_keys"]))
			if string(flags["future_import"]) != "false" {
				t.Fatal("retry changed unrelated import flag")
			}
			if op == "import" {
				if len(flags) != 2 || string(flags["rk_damage_view"]) != "true" || string(doc["legacy_imported"]) != "true" {
					t.Fatal("retry did not atomically commit existing import flags")
				}
			} else if len(flags) != 1 || string(doc["legacy_imported"]) != "false" {
				t.Fatal("patch retry introduced migration flags")
			}
		})
	}
}
