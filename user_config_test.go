package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func compactConfigJSON(raw []byte) string {
	var out bytes.Buffer
	if json.Compact(&out, raw) != nil {
		return string(raw)
	}
	return out.String()
}

func testConfigStore(t *testing.T) *userConfigStore {
	t.Helper()
	dir := t.TempDir()
	return newUserConfigStore(filepath.Join(dir, "profile"), filepath.Join(dir, "external-backups"))
}

func configObject(t *testing.T, text string) jsonObject {
	t.Helper()
	obj, err := parseObject([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	return obj
}

func putConfigFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func readConfigTest(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func configTransaction(t *testing.T, s *userConfigStore, text string) jsonObject {
	t.Helper()
	doc, err := s.data(configObject(t, text))
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func configSection(t *testing.T, doc jsonObject, key string) jsonObject {
	t.Helper()
	data, err := parseObject(doc["data"])
	if err != nil {
		t.Fatal(err)
	}
	obj, err := parseObject(data[key])
	if err != nil {
		t.Fatalf("section %s: %v", key, err)
	}
	return obj
}

func backupContains(t *testing.T, s *userConfigStore, before []byte) {
	t.Helper()
	entries, err := os.ReadDir(s.backupDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if bytes.Equal(readConfigTest(t, filepath.Join(s.backupDir, entry.Name())), before) {
			return
		}
	}
	t.Fatal("exact previous bytes not backed up")
}

func useConfigStore(t *testing.T, s *userConfigStore) {
	t.Helper()
	old := sharedUserConfig
	sharedUserConfig = s
	gCloseMu.Lock()
	closeBehavior := gCloseBehavior
	gCloseMu.Unlock()
	t.Cleanup(func() {
		sharedUserConfig = old
		gCloseMu.Lock()
		gCloseBehavior = closeBehavior
		gCloseMu.Unlock()
	})
}

func configHTTP(method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:18788"+path, strings.NewReader(body))
	if method == http.MethodPost {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Origin", "http://127.0.0.1:18788")
	w := httptest.NewRecorder()
	handleAPI(w, r)
	return w
}

func TestUserConfigMissingEmptyAndImportMarker(t *testing.T) {
	s := testConfigStore(t)
	for _, request := range []string{`{}`, `{"patch":{}}`, `{"import":{}}`, `{"import":{"rk_pet_configs":{}}}`} {
		doc := configTransaction(t, s, request)
		if string(doc["legacy_imported"]) != "false" {
			t.Fatal("empty import was marked complete")
		}
		if _, err := os.Stat(s.path); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("empty request wrote a file", err)
		}
	}
	doc := configTransaction(t, s, `{"patch":{"rk_speed_view":{"iv":false}}}`)
	if string(doc["legacy_imported"]) != "false" {
		t.Fatal("patch completed import")
	}
	before := readConfigTest(t, s.path)
	doc = configTransaction(t, s, `{"import":{"rk_speed_view":{"iv":true}}}`)
	if string(doc["legacy_imported"]) != "true" || string(configSection(t, doc, "rk_speed_view")["iv"]) != "false" {
		t.Fatal("import presence semantics broken")
	}
	backupContains(t, s, before)
	reopened := newUserConfigStore(filepath.Dir(s.path), s.backupDir)
	doc = configTransaction(t, reopened, `{}`)
	if string(doc["legacy_imported"]) != "true" {
		t.Fatal("import marker not durable")
	}
}

func TestUserConfigMergeImportDeleteAndPreserveUnknown(t *testing.T) {
	s := testConfigStore(t)
	original := `{"schema_version":1,"settings":{"future":{"keep":1}},"data":{"future_section":{"deep":[1,2]},"rk_pet_configs":{"249":{},"250":{"nature":{},"iv":{},"future":7}},"rk_speed_view":{"iv":false,"fixed":0,"search":""},"rk_speed_form_overrides":{"a":null,"b":249}},"future_top":{"keep":true}}`
	putConfigFile(t, s.path, original)
	doc := configTransaction(t, s, `{"import":{"rk_pet_configs":{"249":{"nature":{"hp":1}},"251":{"iv":{"hp":true}}},"rk_speed_view":{"iv":true,"fixed":20,"search":"new"},"rk_speed_form_overrides":{"a":5,"c":9}}}`)
	if string(doc["future_top"]) != `{"keep":true}` {
		t.Fatal("unknown top field lost")
	}
	data, _ := parseObject(doc["data"])
	if string(data["future_section"]) != `{"deep":[1,2]}` {
		t.Fatal("unknown section lost")
	}
	pets := configSection(t, doc, "rk_pet_configs")
	if string(pets["249"]) != `{}` || string(pets["250"]) != `{"nature":{},"iv":{},"future":7}` {
		t.Fatal("import overwrote explicit empty or another entry")
	}
	view := configSection(t, doc, "rk_speed_view")
	if string(view["iv"]) != "false" || string(view["fixed"]) != "0" || string(view["search"]) != `""` {
		t.Fatal("import overwrote false/zero/empty")
	}
	forms := configSection(t, doc, "rk_speed_form_overrides")
	if string(forms["a"]) != "null" {
		t.Fatal("import overwrote explicit null")
	}
	doc = configTransaction(t, s, `{"patch":{"rk_speed_form_overrides":{"b":null},"rk_pet_configs":{"249":{"nature":{"hp":2},"iv":{"speed":true}}},"rk_speed_view":{"iv":true}}}`)
	forms = configSection(t, doc, "rk_speed_form_overrides")
	if _, exists := forms["b"]; exists || string(forms["c"]) != "9" {
		t.Fatal("delete did not affect exactly one form entry")
	}
	pets = configSection(t, doc, "rk_pet_configs")
	if len(pets) != 3 {
		t.Fatal("section shallow merge cleared siblings")
	}
	backupContains(t, s, []byte(original))
	before := readConfigTest(t, s.path)
	configTransaction(t, s, `{"patch":{"rk_pet_configs":{},"rk_speed_form_overrides":{"absent":null}},"import":{}}`)
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("empty operations rewrote profile")
	}
}

func TestUserConfigInvalidRequestsAndStoredErrors(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	for _, body := range []string{
		`null`, `[]`, `{} {}`, `{"patch":null}`, `{"patch":[]}`, `{"patch":{"unknown":{}}}`,
		`{"unknown":{}}`, `{"patch":{"rk_pet_configs":"{}"}}`, `{"patch":{"rk_pet_configs":{"1":null}}}`,
		`{"patch":{"rk_pet_configs":{"1":{"nature":[]}}}}`, `{"patch":{"rk_pet_configs":{"1":{"nature":{"hp":3}}}}}`,
		`{"patch":{"rk_pet_configs":{"1":{"iv":{"hp":1}}}}}`, `{"patch":{"rk_speed_pet_priority":{"80":{}}}}`,
		`{"patch":{"rk_speed_pet_priority":{"80":[false]}}}`, `{"patch":{"rk_speed_form_overrides":{"a":{}}}}`,
		`{"patch":{"rk_speed_view":{"iv":"true"}}}`, `{"patch":{"rk_speed_view":{"fixed":null}}}`,
		`{"patch":{"rk_speed_view":{"iv":true,"iv":false}}}`, `{"patch":{"__proto__":{}}}`,
		`{"patch":{"rk_pet_configs":{"1":{"iv":{"constructor":true}}}}}`, `{"import":{"rk_speed_view":{"prototype":{}}}}`,
	} {
		w := configHTTP(http.MethodPost, "/api/user-config", body)
		if w.Code != 400 || !strings.Contains(w.Body.String(), `"ok":false`) {
			t.Errorf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
	if _, err := os.Stat(s.path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid request created file")
	}
	for _, contents := range []string{
		``, `{broken`, `null`, `{"schema_version":2,"settings":{},"data":{}}`, `{"schema_version":1.1,"settings":{},"data":{}}`,
		`{"settings":{},"data":{}}`, `{"schema_version":1,"settings":null,"data":{}}`,
		`{"schema_version":1,"settings":{"window_width":"wide"},"data":{}}`,
		`{"schema_version":1,"settings":{"effective_speed_mode":null},"data":{}}`,
		`{"schema_version":1,"settings":{},"data":{"rk_speed_view":[]}}`,
		`{"schema_version":1,"settings":{},"data":{},"legacy_imported":null}`,
	} {
		putConfigFile(t, s.path, contents)
		for _, tc := range []struct{ method, path, body string }{
			{"GET", "/api/user-config", ""}, {"POST", "/api/user-config", `{"patch":{"rk_speed_view":{"iv":true}}}`},
			{"GET", "/api/settings", ""}, {"POST", "/api/settings", `{"close_behavior":"minimize"}`},
		} {
			w := configHTTP(tc.method, tc.path, tc.body)
			if w.Code != 500 || !strings.Contains(w.Body.String(), `"ok":false`) {
				t.Errorf("corrupt profile %q: %s returned %d %s", contents, tc.path, w.Code, w.Body.String())
			}
		}
		if err := saveSettings(defaultSettings()); err == nil {
			t.Fatal("saveSettings overwrote corrupt target")
		}
		if string(readConfigTest(t, s.path)) != contents {
			t.Fatal("corrupt/newer file changed")
		}
	}
	if _, err := os.Stat(s.backupDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid stored profile created backup")
	}
}

func TestUserConfigUnreadableNotMissing(t *testing.T) {
	s := testConfigStore(t)
	// Directory at the file path reliably gives a read error even under Windows
	// administrator accounts where chmod cannot simulate denied file access.
	if err := os.MkdirAll(s.path, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(t.TempDir(), "settings.json")
	putConfigFile(t, legacy, `{"default_route":"damage"}`)
	s.legacyPaths = []string{legacy}
	if _, err := s.settings(); err == nil {
		t.Fatal("unreadable target fell back to legacy")
	}
	if _, err := s.data(configObject(t, `{"patch":{"rk_speed_view":{"iv":true}}}`)); err == nil {
		t.Fatal("unreadable target accepted write")
	}
	if _, err := os.Stat(s.backupDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unreadable target attempted migration")
	}
}

func TestUserConfigFailedWritesKeepOriginalAndLiveSettings(t *testing.T) {
	for _, failure := range []string{"replace", "backup"} {
		t.Run(failure, func(t *testing.T) {
			s := testConfigStore(t)
			useConfigStore(t, s)
			configTransaction(t, s, `{"patch":{"rk_speed_view":{"iv":false}}}`)
			before := readConfigTest(t, s.path)
			switch failure {
			case "replace":
				s.replace = func(string, string) error { return errors.New("injected replace denial") }
			case "backup":
				putConfigFile(t, s.backupDir, "not a directory")

			}
			gCloseMu.Lock()
			gCloseBehavior = "close"
			gCloseMu.Unlock()
			w := configHTTP("POST", "/api/settings", `{"close_behavior":"minimize"}`)
			if w.Code != 500 {
				t.Fatalf("expected explicit save error: %d %s", w.Code, w.Body.String())
			}
			gCloseMu.RLock()
			got := gCloseBehavior
			gCloseMu.RUnlock()
			if got != "close" {
				t.Fatal("live close effect applied before durable save")
			}
			if !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("failed save changed original")
			}
			w = configHTTP("POST", "/api/user-config", `{"import":{"rk_speed_view":{"iv":true}}}`)
			if w.Code != 500 || !bytes.Equal(before, readConfigTest(t, s.path)) {
				t.Fatal("failed import changed file or succeeded")
			}
			if failure == "replace" {
				backupContains(t, s, before)
			}
			leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(s.path), ".user-config-*.tmp"))
			if len(leftovers) != 0 {
				t.Fatal("failed save left staging files")
			}
		})
	}
	s := testConfigStore(t)
	putConfigFile(t, filepath.Dir(s.path), "not a directory")
	if _, err := s.data(configObject(t, `{"patch":{"rk_speed_view":{"iv":true}}}`)); err == nil {
		t.Fatal("invalid parent accepted save")
	}
}

func TestUserConfigLegacyMigration(t *testing.T) {
	s := testConfigStore(t)
	legacy := filepath.Join(filepath.Dir(s.path), "settings.json")
	old := "\xef\xbb\xbf" + `{"effective_include_speed":false,"default_route":"damage","future_setting":{"keep":true}}`
	putConfigFile(t, legacy, old)
	s.legacyPaths = []string{legacy}
	settings, err := s.settings()
	if err != nil || settings.EffectiveSpeedMode != "exclude" || settings.EffectiveSpeedThreshold != 80 {
		t.Fatalf("migration: %+v %v", settings, err)
	}
	backupContains(t, s, []byte(old))
	if string(readConfigTest(t, legacy)) != old {
		t.Fatal("legacy file changed/deleted")
	}
	doc := configTransaction(t, s, `{}`)
	if string(doc["legacy_imported"]) != "false" {
		t.Fatal("settings migration blocked browser import")
	}
	stored := configObject(t, string(doc["settings"]))
	if compactConfigJSON(stored["future_setting"]) != `{"keep":true}` {
		t.Fatal("migration lost unknown setting")
	}
	putConfigFile(t, legacy, "broken")
	if _, err := s.settings(); err != nil {
		t.Fatal("shared profile did not supersede legacy", err)
	}

	for _, failure := range []string{"corrupt", "backup", "replace", "directory"} {
		t.Run(failure, func(t *testing.T) {
			st := testConfigStore(t)
			oldPath := filepath.Join(t.TempDir(), "settings.json")
			putConfigFile(t, oldPath, `{"default_route":"speed"}`)
			st.legacyPaths = []string{oldPath}
			switch failure {
			case "corrupt":
				putConfigFile(t, oldPath, `{"default_route":`)
			case "backup":
				putConfigFile(t, st.backupDir, "blocked")
			case "replace":
				st.replace = func(string, string) error { return errors.New("migration replace failure") }
			case "directory":
				st.legacyPaths = []string{filepath.Dir(oldPath)}
			}
			before := readConfigTest(t, oldPath)
			if _, err := st.settings(); err == nil {
				t.Fatal("bad migration silently succeeded")
			}
			if _, err := os.Stat(st.path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("failed migration created target")
			}
			if !bytes.Equal(before, readConfigTest(t, oldPath)) {
				t.Fatal("failed migration modified legacy")
			}
			if failure == "replace" {
				backupContains(t, st, before)
			}
		})
	}
}

func TestUserConfigSettingsCompatibilityAndPreservation(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	putConfigFile(t, s.path, `{"schema_version":1,"settings":{"effective_include_speed":false,"future_setting":{"keep":[1]}},"data":{"future_section":{"v":1},"rk_pet_configs":{"249":{"nature":{}}}},"future_top":42}`)
	for _, tc := range []struct {
		body, mode string
		threshold  int
		include    bool
	}{
		{`{"default_route":"speed"}`, "exclude", 80, false},
		{`{"effective_speed_mode":"threshold","effective_speed_threshold":95,"effective_include_speed":false}`, "threshold", 95, true},
		{`{"default_route":"damage"}`, "threshold", 95, true},
		{`{"effective_include_speed":false}`, "exclude", 95, false},
		{`{"effective_include_speed":true}`, "include", 95, true},
		{`{"effective_speed_mode":"exclude","effective_include_speed":true,"effective_speed_threshold":120}`, "exclude", 120, false},
		{`{"effective_speed_mode":"threshold","effective_speed_threshold":39}`, "threshold", 80, true},
		{`{"effective_speed_threshold":121}`, "threshold", 80, true},
		{`{"effective_speed_threshold":40}`, "threshold", 40, true},
	} {
		w := configHTTP("POST", "/api/settings", tc.body)
		if w.Code != 200 {
			t.Fatalf("settings save: %d %s", w.Code, w.Body.String())
		}
		w = configHTTP("GET", "/api/settings", "")
		var got UserSettings
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if got.EffectiveSpeedMode != tc.mode || got.EffectiveSpeedThreshold != tc.threshold || got.EffectiveIncludeSpeed != tc.include {
			t.Fatalf("%s: %+v", tc.body, got)
		}
	}
	before := readConfigTest(t, s.path)
	for _, body := range []string{`{"effective_speed_threshold":80.5}`, `{"effective_include_speed":"false"}`, `{"font_family":"unlikely-nonexistent-font-xhm-test-abcdef"}`, `{"window_width":null}`} {
		if w := configHTTP("POST", "/api/settings", body); w.Code != 400 {
			t.Fatalf("invalid settings accepted: %s %d", body, w.Code)
		}
		if !bytes.Equal(before, readConfigTest(t, s.path)) {
			t.Fatal("invalid settings changed target")
		}
	}
	w := configHTTP("POST", "/api/settings", `{"window_width":0,"window_height":-1,"default_max_zoom":999,"hotkey_mods":99,"hotkey_vk":-1,"default_monitor":-1,"close_behavior":"invalid","default_route":"","font_family":""}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got, err := s.settings()
	if err != nil || got.WindowWidth != 1280 || got.WindowHeight != 800 || got.DefaultMaxZoom != 100 || got.HotkeyMods != 0 || got.HotkeyVK != 0 || got.DefaultMonitor != 0 || got.CloseBehavior != "close" || got.DefaultRoute != "petdex" {
		t.Fatalf("normal sanitization: %+v %v", got, err)
	}
	doc := configTransaction(t, s, `{}`)
	stored := configObject(t, string(doc["settings"]))
	if compactConfigJSON(stored["future_setting"]) != `{"keep":[1]}` || string(doc["future_top"]) != `42` || len(configSection(t, doc, "rk_pet_configs")) != 1 {
		t.Fatal("settings save lost unrelated fields")
	}
	before = readConfigTest(t, s.path)
	if w := configHTTP("POST", "/api/settings", `{}`); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("empty settings patch changed bytes")
	}
}

func TestUserConfigConcurrentTransactions(t *testing.T) {
	s := testConfigStore(t)
	var wg sync.WaitGroup
	errs := make(chan error, 80)
	for i := 1; i <= 40; i++ {
		wg.Add(2)
		go func(i int) {
			defer wg.Done()
			request, _ := parseObject([]byte(fmt.Sprintf(`{"patch":{"rk_pet_configs":{"%d":{"nature":{"hp":1},"iv":{"speed":true}}},"rk_speed_pet_priority":{"%d":[%d]}}}`, i, i, i)))
			_, err := s.data(request)
			if err != nil {
				errs <- err
			}
		}(i)
		go func(i int) {
			defer wg.Done()
			_, err := s.updateSettings(jsonObject{fmt.Sprintf("future_%d", i): json.RawMessage(`true`)})
			if err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	doc := configTransaction(t, s, `{}`)
	if len(configSection(t, doc, "rk_pet_configs")) != 40 || len(configSection(t, doc, "rk_speed_pet_priority")) != 40 {
		t.Fatal("concurrent entry updates lost")
	}
	stored := configObject(t, string(doc["settings"]))
	for i := 1; i <= 40; i++ {
		if string(stored[fmt.Sprintf("future_%d", i)]) != "true" {
			t.Fatal("concurrent settings update lost")
		}
	}
}

func TestUserConfigOriginSizeAndResponseContract(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	for _, path := range []string{"/api/user-config", "/api/settings"} {
		for _, tc := range []struct {
			origin, media, site, host string
			code                      int
		}{
			{"http://evil.example", "application/json", "", "127.0.0.1:18788", 403},
			{"null", "application/json", "", "127.0.0.1:18788", 403},
			{"http://127.0.0.1:18789", "application/json", "", "127.0.0.1:18788", 403},
			{"http://127.0.0.1:18788/", "application/json", "", "127.0.0.1:18788", 403},
			{"", "text/plain", "", "127.0.0.1:18788", 415},
			{"", "", "", "127.0.0.1:18788", 415},
			{"", "application/json", "cross-site", "127.0.0.1:18788", 403},
			{"", "application/json", "same-site", "127.0.0.1:18788", 403},
			{"http://evil.example:18788", "application/json", "", "evil.example:18788", 403},
			{"", "application/json; charset=utf-8", "", "127.0.0.1:18788", 200},
		} {
			r := httptest.NewRequest("POST", "http://127.0.0.1:18788"+path, strings.NewReader(`{}`))
			r.Host = tc.host
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			r.Header.Set("Content-Type", tc.media)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			w := httptest.NewRecorder()
			handleAPI(w, r)
			if w.Code != tc.code {
				t.Errorf("%s %+v: %d %s", path, tc, w.Code, w.Body.String())
			}
			if w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatal("profile API enabled CORS")
			}
		}
		w := configHTTP("OPTIONS", path, "")
		if w.Code != 405 {
			t.Fatal("profile API inherited permissive OPTIONS")
		}
		w = configHTTP("POST", path, strings.Repeat(" ", userConfigLimit+1))
		if w.Code != 413 {
			t.Fatalf("oversize body: %d", w.Code)
		}
	}
	w := configHTTP("POST", "/api/user-config", `{"patch":{"rk_speed_view":{"iv":true},"rk_damage_selection":{"attacker":249}}}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = configHTTP("POST", "/api/user-config", `{"import":{"rk_pet_configs":{"249":{}}}}`)
	var response struct {
		OK             bool                       `json:"ok"`
		LegacyImported bool                       `json:"legacy_imported"`
		Data           map[string]json.RawMessage `json:"data"`
		Schema         int                        `json:"schema_version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if !response.OK || !response.LegacyImported || response.Schema != 1 || len(response.Data) != 3 {
		t.Fatalf("response missing current persisted sections: %s", w.Body.String())
	}
	if w.Result().Header.Get("Cache-Control") != "no-store" {
		t.Fatal("profile response may be cached")
	}
	// Cumulative size must also be bounded, not just individual request bodies.
	huge := strings.Repeat("x", userConfigLimit)
	_, err := s.data(jsonObject{"patch": json.RawMessage(`{"rk_damage_selection":{"attackerTeam":"` + huge + `"}}`)})
	if err == nil {
		t.Fatal("oversized persisted document accepted")
	}
}

func TestUserConfigWindowCloseHandshake(t *testing.T) {
	gCloseMu.Lock()
	pending, approved := gClosePending, gCloseApproved
	gClosePending, gCloseApproved = false, false
	gCloseMu.Unlock()
	defer func() { gCloseMu.Lock(); gClosePending, gCloseApproved = pending, approved; gCloseMu.Unlock() }()
	if finishCloseFlush(true) {
		t.Fatal("unsolicited close acknowledgement accepted")
	}
	gCloseMu.Lock()
	gClosePending = true
	gCloseMu.Unlock()
	if finishCloseFlush(false) {
		t.Fatal("failed flush allowed close")
	}
	gCloseMu.Lock()
	failedState := gClosePending || gCloseApproved
	gClosePending = true
	gCloseMu.Unlock()
	if failedState {
		t.Fatal("failed flush did not reset close request")
	}
	if !finishCloseFlush(true) {
		t.Fatal("successful pending flush not approved")
	}
	if finishCloseFlush(false) {
		t.Fatal("duplicate acknowledgement accepted")
	}
	gCloseMu.RLock()
	stillApproved := gCloseApproved
	gCloseMu.RUnlock()
	if !stillApproved {
		t.Fatal("duplicate acknowledgement cancelled already-approved close")
	}
}

func TestUserConfigWindowsLockedTarget(t *testing.T) {
	s := testConfigStore(t)
	configTransaction(t, s, `{"patch":{"rk_speed_view":{"iv":false}}}`)
	before := readConfigTest(t, s.path)
	path, err := syscall.UTF16PtrFromString(s.path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := syscall.CreateFile(path, syscall.GENERIC_READ, syscall.FILE_SHARE_READ, nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.CloseHandle(h)
	if _, err := s.data(configObject(t, `{"patch":{"rk_speed_view":{"iv":true}}}`)); err == nil {
		t.Fatal("MoveFileExW unexpectedly replaced locked file")
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("locked target was changed")
	}
	backupContains(t, s, before)
}

func TestUserConfigViewAndSelectionFields(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	w := configHTTP("POST", "/api/user-config", `{"patch":{"rk_speed_view":{"iv":true,"nature":false,"negNature":true,"showMonsters":false,"fixed":-20,"percent":12.5,"search":"a","searchDisplay":"A","selectedCol":"ivNature","selectedSpeed":120},"rk_damage_selection":{"attacker":249,"defender":250,"attackerTeam":"group-1","defenderTeam":null}}}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, col := range []string{`"base"`, `"iv"`, `"ivNature"`, `"negNature"`, `null`} {
		w = configHTTP("POST", "/api/user-config", `{"patch":{"rk_speed_view":{"selectedCol":`+col+`,"selectedSpeed":null}}}`)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
	}
	before := readConfigTest(t, s.path)
	for _, body := range []string{
		`{"patch":{"rk_speed_view":{"selectedCol":1}}}`, `{"patch":{"rk_speed_view":{"selectedCol":"other"}}}`,
		`{"patch":{"rk_speed_view":{"unknown":true}}}`, `{"patch":{"rk_damage_selection":{"attacker":0}}}`,
		`{"patch":{"rk_damage_selection":{"defender":1.5}}}`, `{"patch":{"rk_damage_selection":{"attacker":"249"}}}`,
		`{"patch":{"rk_damage_selection":{"attackerTeam":249}}}`, `{"patch":{"rk_damage_selection":{"unknown":1}}}`,
	} {
		if w := configHTTP("POST", "/api/user-config", body); w.Code != 400 {
			t.Errorf("invalid selection accepted: %s %d", body, w.Code)
		}
	}
	if !bytes.Equal(before, readConfigTest(t, s.path)) {
		t.Fatal("invalid selection modified file")
	}
}

func TestUserConfigConcurrentSettingsLiveOrder(t *testing.T) {
	s := testConfigStore(t)
	useConfigStore(t, s)
	var wg sync.WaitGroup
	errs := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			behavior := "close"
			if i%2 == 0 {
				behavior = "minimize"
			}
			w := configHTTP("POST", "/api/settings", `{"close_behavior":"`+behavior+`"}`)
			if w.Code != 200 {
				errs <- w.Body.String()
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	settings, err := s.settings()
	if err != nil {
		t.Fatal(err)
	}
	gCloseMu.RLock()
	live := gCloseBehavior
	gCloseMu.RUnlock()
	if live != settings.CloseBehavior {
		t.Fatal("live settings applied out of commit order")
	}
}

func TestUserConfigUninstalledFontFallback(t *testing.T) {
	s := testConfigStore(t)
	putConfigFile(t, s.path, `{"schema_version":1,"settings":{"font_family":"uninstalled-font-abcdef-test"},"data":{}}`)
	settings, err := s.settings()
	if err != nil || settings.FontFamily != "" {
		t.Fatal("load did not fall back from unavailable font", err)
	}
	settings, err = s.updateSettings(configObject(t, `{"default_route":"speed"}`))
	if err != nil || settings.FontFamily != "" {
		t.Fatal("unrelated save blocked by unavailable font", err)
	}
}

func TestUserConfigExternalBackupConvention(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Project")
	putConfigFile(t, filepath.Join(root, "AGENTS.md"), "test")
	putConfigFile(t, filepath.Join(root, "go.mod"), "module test")
	t.Setenv("XHM_USER_CONFIG_BACKUP_ROOT", "")
	want := filepath.Join(filepath.Dir(root), "old", "Project-backups", "user-config")
	if got := userConfigBackupDir(filepath.Join(root, "dist", "app")); got != want {
		t.Fatalf("backup root %s, want %s", got, want)
	}
	override := filepath.Join(t.TempDir(), "backup-root")
	t.Setenv("XHM_USER_CONFIG_BACKUP_ROOT", override)
	if got := userConfigBackupDir(root); got != filepath.Join(override, "user-config") {
		t.Fatal("external override ignored")
	}
	t.Setenv("XHM_USER_CONFIG_BACKUP_ROOT", "relative")
	if userConfigBackupDir(root) != "" {
		t.Fatal("relative override allowed")
	}
}

// Optional browser harness. Run ONLY explicitly, for example:
// XHM_BROWSER_FIXTURE_DIR=<absolute temporary directory>
// XHM_BROWSER_FIXTURE_ROOT=<absolute source root OR dist/app>
// go test -run '^TestUserConfigBrowserFixture$' -count=1 -v -timeout 30m
// ready.json lists two independent loopback origins sharing ONE real Go store.
// POST stop_url with application/json to end the test. No native WebView/app is
// started. Only profile mutations are exposed; source/data files are read-only.
func TestUserConfigBrowserFixture(t *testing.T) {
	dir := os.Getenv("XHM_BROWSER_FIXTURE_DIR")
	if dir == "" {
		t.Skip("set XHM_BROWSER_FIXTURE_DIR and XHM_BROWSER_FIXTURE_ROOT explicitly")
	}
	root := os.Getenv("XHM_BROWSER_FIXTURE_ROOT")
	if !filepath.IsAbs(dir) || !filepath.IsAbs(root) {
		t.Fatal("fixture and asset root must be explicit absolute directories")
	}
	dir = filepath.Clean(dir)
	root = filepath.Clean(root)
	inside := func(child, parent string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	actual, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	if inside(dir, filepath.Join(actual, "小黑猫Wiki")) || inside(dir, root) {
		t.Fatal("fixture directory must not be the real profile or inside the asset project")
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		t.Fatal("asset root must directly contain index.html", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	s := newUserConfigStore(filepath.Join(dir, "profile"), filepath.Join(dir, "backups"), filepath.Join(dir, "profile", "settings.json"))
	useConfigStore(t, s)
	oldFS, oldRoot := appFS, appRoot
	appFS, appRoot = os.DirFS(root), ""
	t.Cleanup(func() { appFS, appRoot = oldFS, oldRoot })
	stop := make(chan struct{})
	var once sync.Once
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		t.Fatal(err)
	}
	token := hex.EncodeToString(tokenBytes)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/__fixture/info":
			writeJSON(w, 200, []byte(`{"isolated":true}`))
		case "/__fixture/reset":
			if !guardUserConfigRequest(w, r) {
				return
			}
			if r.Method != "POST" || r.URL.Query().Get("token") != token {
				configError(w, 403, errors.New("invalid fixture reset request"))
				return
			}
			s.mu.Lock()
			err := os.Remove(s.path)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
			if err == nil {
				e := os.Remove(filepath.Join(dir, "profile", "settings.json"))
				if !errors.Is(e, os.ErrNotExist) {
					err = e
				}
			}
			s.mu.Unlock()
			if err != nil {
				configError(w, 500, err)
				return
			}
			writeJSON(w, 200, []byte(`{"ok":true}`))
		case "/__layout/original.css", "/__layout/before.css":
			name := "XHM_BROWSER_LAYOUT_ORIGINAL"
			if r.URL.Path == "/__layout/before.css" {
				name = "XHM_BROWSER_LAYOUT_BEFORE"
			}
			file := os.Getenv(name)
			if !filepath.IsAbs(file) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFile(w, r, file)
		case "/api/window/state":
			if r.Method != "GET" {
				configError(w, 405, errors.New("fixture read-only endpoint"))
				return
			}
			writeJSON(w, 200, []byte(`{"maximized":true}`))
		case "/__fixture/stop":
			if !guardUserConfigRequest(w, r) {
				return
			}
			if r.Method != "POST" || r.URL.Query().Get("token") != token {
				configError(w, 403, errors.New("invalid fixture stop request"))
				return
			}
			writeJSON(w, 200, []byte(`{"ok":true}`))
			once.Do(func() { close(stop) })
		case "/api/user-config", "/api/settings":
			handleAPI(w, r)
		case "/api/fonts", "/api/font-file":
			if r.Method != "GET" {
				configError(w, 405, errors.New("fixture read-only endpoint"))
				return
			}
			handleAPI(w, r)
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") || (r.Method != "GET" && r.Method != "HEAD") {
				configError(w, 405, errors.New("fixture only permits profile writes"))
				return
			}
			handleStatic(w, r)
		}
	})
	a, b := httptest.NewServer(handler), httptest.NewServer(handler)
	defer a.Close()
	defer b.Close()
	port := func(origin string) int {
		value, _ := strconv.Atoi(origin[strings.LastIndex(origin, ":")+1:])
		return value
	}
	metadata := map[string]any{"pid": os.Getpid(), "port": port(a.URL), "ports": []int{port(a.URL), port(b.URL)}, "origins": []string{a.URL, b.URL}, "root": root, "profile": filepath.Dir(s.path), "config_path": s.path, "backup_dir": s.backupDir, "stop_url": a.URL + "/__fixture/stop?token=" + token, "reset_url": a.URL + "/__fixture/reset?token=" + token, "native_close": false}
	ready, _ := json.MarshalIndent(metadata, "", "  ")
	readyTemp, err := writeSyncedTemp(dir, ".ready-*.tmp", ready)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(readyTemp)
	if err := replaceUserConfigFile(readyTemp, filepath.Join(dir, "ready.json")); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("XHM_BROWSER_FIXTURE_READY %s\n", ready)
	select {
	case <-stop:
	case <-time.After(25 * time.Minute):
		t.Fatal("fixture timed out waiting for stop endpoint")
	}
}
