package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

const userConfigLimit = 4 * 1024 * 1024
const userConfigSchema = 1

type jsonObject map[string]json.RawMessage

// One read/modify/backup/replace transaction at a time, shared by BOTH APIs.
// The application's existing named single-instance mutex excludes other app processes.
type userConfigStore struct {
	mu          sync.Mutex
	path        string
	backupDir   string
	legacyPaths []string
	initErr     error
	replace     func(string, string) error // injectable failure seam; production uses MoveFileExW
}

func newUserConfigStore(profile, backupDir string, legacyPaths ...string) *userConfigStore {
	return &userConfigStore{path: filepath.Join(profile, "user-config.json"),
		backupDir: backupDir, legacyPaths: legacyPaths,
		replace: replaceUserConfigFile}
}

var sharedUserConfig = defaultUserConfigStore()

// Serialize settings HTTP commits with their live effects/hotkey acknowledgement
// so concurrent saves cannot apply live settings in reverse commit order.
var settingsHTTPMu sync.Mutex

func defaultUserConfigStore() *userConfigStore {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		return &userConfigStore{initErr: fmt.Errorf("cannot locate shared AppData profile: %v", err)}
	}
	profile := filepath.Join(base, "小黑猫Wiki")
	return newUserConfigStore(profile, userConfigBackupDir(getExeDir()), filepath.Join(profile, "settings.json"),
		filepath.Join(getExeDir(), "settings.json"), filepath.Join(getExeDir(), "Xwiki", "settings.json"))
}

// Mirror the established project-external backup convention, including builds
// under dist/app. No developer drive is baked into the deployed executable.
// Installed/portable layouts without a source root use the executable folder
// as their project root; set XHM_USER_CONFIG_BACKUP_ROOT to an absolute external
// backup root when its sibling old/ directory is not writable.
func userConfigBackupDir(exeDir string) string {
	if root := os.Getenv("XHM_USER_CONFIG_BACKUP_ROOT"); root != "" {
		if !filepath.IsAbs(root) {
			return ""
		} // fail closed at backup time
		return filepath.Join(root, "user-config")
	}
	root := exeDir
	for dir := exeDir; ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "AGENTS.md")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
				root = dir
				break
			}
		}
		if filepath.Dir(dir) == dir {
			break
		}
	}
	return filepath.Join(filepath.Dir(root), "old", filepath.Base(root)+"-backups", "user-config")
}

var moveUserConfigFile = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// os.Rename does not promise atomic replacement on Windows. Both paths are on
// the same volume; never remove the destination first or fall back to copy.
func replaceUserConfigFile(from, to string) error {
	src, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	dst, err := syscall.UTF16PtrFromString(to)
	if err != nil {
		return err
	}
	r, _, callErr := moveUserConfigFile.Call(uintptr(unsafe.Pointer(src)), uintptr(unsafe.Pointer(dst)), 0x1|0x8)
	if r == 0 {
		return callErr
	}
	return nil
}

func configError(w http.ResponseWriter, status int, err error) {
	body, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
	writeJSON(w, status, body)
}

// No CORS opt-in. Require an exact same-origin authority (including port) when
// Origin is supplied. Non-browser callers without Origin still need JSON.
func guardUserConfigRequest(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		configError(w, http.StatusForbidden, errors.New("loopback profile host required"))
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		configError(w, http.StatusForbidden, errors.New("cross-site profile access rejected"))
		return false
	}
	if origins := r.Header.Values("Origin"); len(origins) > 0 {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		origin, err := url.Parse(origins[0])
		if len(origins) != 1 || err != nil || origin.Scheme != scheme || !strings.EqualFold(origin.Host, r.Host) || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
			configError(w, http.StatusForbidden, errors.New("same-origin profile access required"))
			return false
		}
	}
	if r.Method == http.MethodPost {
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			configError(w, http.StatusUnsupportedMediaType, errors.New("Content-Type application/json required"))
			return false
		}
	}
	return true
}

func readConfigRequest(w http.ResponseWriter, r *http.Request) (jsonObject, error) {
	r.Body = http.MaxBytesReader(w, r.Body, userConfigLimit)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	return parseObject(b)
}

// Reject ambiguous duplicate keys and JS prototype keys at every nesting level,
// as these objects will be consumed by frontend caches. Bound nesting as well.
func checkJSON(b []byte) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var walk func(int) error
	walk = func(depth int) error {
		if depth > 64 {
			return errors.New("JSON nesting exceeds 64 levels")
		}
		tok, err := d.Token()
		if err != nil {
			return err
		}
		delim, container := tok.(json.Delim)
		if !container {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				tok, err = d.Token()
				if err != nil {
					return err
				}
				key, ok := tok.(string)
				if !ok || key == "__proto__" || key == "prototype" || key == "constructor" || seen[key] {
					return fmt.Errorf("unsafe or duplicate JSON key %q", key)
				}
				seen[key] = true
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		case '[':
			for d.More() {
				if err := walk(depth + 1); err != nil {
					return err
				}
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		_, err = d.Token()
		return err
	}
	if err := walk(0); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("expected exactly one JSON value")
	}
	return nil
}

func parseObject(b []byte) (jsonObject, error) {
	b = bytes.TrimSpace(bytes.TrimPrefix(b, []byte{0xef, 0xbb, 0xbf}))
	if len(b) == 0 || b[0] != '{' {
		return nil, errors.New("expected JSON object")
	}
	if err := checkJSON(b); err != nil {
		return nil, err
	}
	var obj jsonObject
	if err := json.Unmarshal(b, &obj); err != nil {
		return nil, err
	}
	return obj, nil
}

func readConfigBytes(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, userConfigLimit+1))
	if err == nil && len(b) > userConfigLimit {
		err = errors.New("profile exceeds 4 MiB limit")
	}
	return b, err
}

func emptyUserConfig() jsonObject {
	return jsonObject{"schema_version": json.RawMessage(`1`), "settings": json.RawMessage(`{}`), "data": json.RawMessage(`{}`), "legacy_imported": json.RawMessage(`false`)}
}

// Caller holds mu. Missing is the ONLY condition that permits migration or
// defaults. A corrupt/unreadable/newer shared file never falls back to legacy.
func (s *userConfigStore) loadLocked() (jsonObject, []byte, error) {
	if s.initErr != nil {
		return nil, nil, s.initErr
	}
	b, err := readConfigBytes(s.path)
	if err == nil {
		doc, err := parseObject(b)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid shared profile: %w", err)
		}
		if raw, exists := doc["legacy_imported"]; exists {
			var imported bool
			if nullJSON(raw) || json.Unmarshal(raw, &imported) != nil {
				return nil, nil, errors.New("invalid legacy_imported flag")
			}
		}
		if raw, exists := doc["legacy_imported_keys"]; exists {
			flags, err := parseObject(raw)
			if err != nil {
				return nil, nil, errors.New("invalid legacy_imported_keys")
			}
			for _, raw := range flags {
				var flag bool
				if nullJSON(raw) || json.Unmarshal(raw, &flag) != nil {
					return nil, nil, errors.New("invalid per-key import flag")
				}
			}
		}
		var schema int
		if err := json.Unmarshal(doc["schema_version"], &schema); err != nil || schema != userConfigSchema {
			return nil, nil, fmt.Errorf("unsupported user-config schema_version (supported: %d)", userConfigSchema)
		}
		if _, err := settingsFromJSON(doc["settings"], false); err != nil {
			return nil, nil, fmt.Errorf("invalid shared settings: %w", err)
		}
		data, err := parseObject(doc["data"])
		if err != nil {
			return nil, nil, fmt.Errorf("invalid shared data: %w", err)
		}
		// Preserve unrecognized sections verbatim, but known sections must be objects.
		for key, value := range data {
			if knownConfigSection(key) {
				if _, err := parseObject(value); err != nil {
					return nil, nil, fmt.Errorf("invalid section %s: %w", key, err)
				}
			}
		}
		return doc, b, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, nil, fmt.Errorf("read shared profile: %w", err)
	}
	doc := emptyUserConfig()
	for _, old := range s.legacyPaths {
		legacy, err := readConfigBytes(old)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, nil, fmt.Errorf("read legacy settings %s: %w", old, err)
		}
		obj, err := parseObject(legacy)
		if err != nil {
			return nil, nil, fmt.Errorf("invalid legacy settings %s: %w", old, err)
		}
		raw, _ := json.Marshal(obj)
		if _, err := settingsFromJSON(raw, false); err != nil {
			return nil, nil, fmt.Errorf("invalid legacy settings: %w", err)
		}
		// Back up outside the project before first migration. The original
		// legacy file (and all WebView data) remains untouched.
		if err := s.backupLocked("legacy-settings-", legacy); err != nil {
			return nil, nil, err
		}
		doc["settings"] = raw
		if err := s.writeLocked(doc, nil); err != nil {
			return nil, nil, fmt.Errorf("migrate legacy settings: %w", err)
		}
		b, _ := json.MarshalIndent(doc, "", "  ")
		return doc, b, nil
	}
	return doc, nil, nil
}

func writeSyncedTemp(dir, pattern string, b []byte) (name string, err error) {
	f, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	name = f.Name()
	defer func() {
		if err != nil {
			os.Remove(name)
		}
	}()
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	return name, err
}

func (s *userConfigStore) backupLocked(prefix string, b []byte) error {
	if s.backupDir == "" || !filepath.IsAbs(s.backupDir) {
		return errors.New("an absolute external profile backup root is required")
	}
	if err := os.MkdirAll(s.backupDir, 0700); err != nil {
		return fmt.Errorf("create profile backup directory: %w", err)
	}
	if _, err := writeSyncedTemp(s.backupDir, prefix+"*.json", b); err != nil {
		return fmt.Errorf("backup profile: %w", err)
	}
	return nil
}

func (s *userConfigStore) writeLocked(doc jsonObject, before []byte) error {
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	if len(b) > userConfigLimit {
		return errors.New("resulting profile exceeds 4 MiB limit")
	}
	if bytes.Equal(b, before) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	tmp, err := writeSyncedTemp(filepath.Dir(s.path), ".user-config-*.tmp", b)
	if err != nil {
		return fmt.Errorf("stage profile: %w", err)
	}
	defer os.Remove(tmp)
	if before != nil {
		if err := s.backupLocked("user-config-", before); err != nil {
			return err
		}
	}
	if err := s.replace(tmp, s.path); err != nil {
		return fmt.Errorf("atomic profile replace: %w", err)
	}
	return nil
}

func knownConfigSection(key string) bool {
	switch key {
	case "rk_pet_configs", "rk_speed_pet_priority", "rk_speed_form_overrides", "rk_speed_view", "rk_damage_selection", "rk_damage_skill_configs", "rk_damage_view", "rk_chart_workspace":
		return true
	}
	return false
}

func nullJSON(b []byte) bool { return bytes.Equal(bytes.TrimSpace(b), []byte("null")) }

func validConfigID(b []byte) bool {
	var n int64
	if json.Unmarshal(b, &n) == nil && n > 0 && n <= (1<<53)-1 {
		return true
	}
	var text string
	if json.Unmarshal(b, &text) != nil {
		return false
	}
	n, err := strconv.ParseInt(text, 10, 64)
	return err == nil && n > 0 && n <= (1<<53)-1
}

// These sections were introduced after the original all-keys import flag.
func upgradeConfigSection(key string) bool {
	return key == "rk_damage_skill_configs" || key == "rk_damage_view" || key == "rk_chart_workspace"
}

func validateSkillConfig(value json.RawMessage) error {
	obj, err := parseObject(value)
	if err != nil {
		return err
	}
	for key, raw := range obj {
		invalid := func() error { return fmt.Errorf("invalid skill field %s", key) }
		switch key {
		case "skillType":
			var text string
			if json.Unmarshal(raw, &text) != nil || (text != "attack" && text != "magic_attack") {
				return invalid()
			}
		case "basePowerExpression":
			var text string
			if nullJSON(raw) || json.Unmarshal(raw, &text) != nil || len(text) > 256 {
				return invalid()
			}
			for _, c := range text {
				if !(c >= '0' && c <= '9') && !strings.ContainsRune("+-*/(). \t\r\n", c) {
					return invalid()
				}
			}
		case "skillAttr", "currentSkillName", "debuffPercent", "defenseMod", "finalPowerManual":
			var text string
			if nullJSON(raw) || json.Unmarshal(raw, &text) != nil {
				return invalid()
			}
		case "basePower", "fixedBonus", "percentBonus", "buff", "comboCount", "starMeteor":
			var n float64
			if nullJSON(raw) || json.Unmarshal(raw, &n) != nil {
				return invalid()
			}
			if key == "comboCount" && (n < 1 || n != float64(int64(n))) {
				return invalid()
			}
			if key == "starMeteor" && (n < 0 || n != float64(int64(n))) {
				return invalid()
			}
		}
	}
	return nil
}

func validateConfigEntry(section, key string, value json.RawMessage) error {
	invalid := func() error { return fmt.Errorf("invalid value for %s.%s", section, key) }
	if key == "" {
		return invalid()
	}
	switch section {
	case "rk_pet_configs":
		id, err := strconv.ParseUint(key, 10, 53)
		if err != nil || id == 0 || strconv.FormatUint(id, 10) != key {
			return invalid()
		}
		obj, err := parseObject(value)
		if err != nil {
			return invalid()
		}
		if raw, exists := obj["mode"]; exists {
			var mode int
			if nullJSON(raw) || json.Unmarshal(raw, &mode) != nil || (mode != 0 && mode != 1) {
				return invalid()
			}
		}
		for _, field := range []string{"nature", "iv"} {
			if v, exists := obj[field]; exists {
				stats, err := parseObject(v)
				if err != nil {
					return invalid()
				}
				for _, stat := range stats {
					if nullJSON(stat) {
						return invalid()
					}
					if field == "nature" {
						var n int
						if json.Unmarshal(stat, &n) != nil || n < 0 || n > 2 {
							return invalid()
						}
					} else {
						var flag bool
						if json.Unmarshal(stat, &flag) != nil {
							return invalid()
						}
					}
				}
			}
		}
	case "rk_chart_workspace":
		if key == "state" {
			return validateChartWorkspace(value)
		}
		return invalid()
	case "rk_damage_skill_configs":
		id, err := strconv.ParseUint(key, 10, 53)
		if err != nil || id == 0 || strconv.FormatUint(id, 10) != key {
			return invalid()
		}
		if err := validateSkillConfig(value); err != nil {
			return err
		}
	case "rk_damage_view":
		if key != "skill" {
			return invalid()
		}
		if err := validateSkillConfig(value); err != nil {
			return err
		}
	case "rk_speed_pet_priority":
		speed, err := strconv.ParseUint(key, 10, 53)
		if err != nil || speed == 0 || strconv.FormatUint(speed, 10) != key {
			return invalid()
		}
		var ids []json.RawMessage
		if nullJSON(value) || json.Unmarshal(value, &ids) != nil {
			return invalid()
		}
		for _, id := range ids {
			if !validConfigID(id) {
				return invalid()
			}
		}
	case "rk_speed_form_overrides":
		// null is an explicit tombstone in patches, and an explicit value in imports.
		if !nullJSON(value) && !validConfigID(value) {
			return invalid()
		}
	case "rk_speed_view":
		switch key {
		case "iv", "nature", "negNature", "showMonsters":
			var flag bool
			if nullJSON(value) || json.Unmarshal(value, &flag) != nil {
				return invalid()
			}
		case "fixed", "percent", "selectedSpeed":
			if nullJSON(value) && key == "selectedSpeed" {
				return nil
			}
			var n float64
			if nullJSON(value) || json.Unmarshal(value, &n) != nil {
				return invalid()
			}
		case "search", "searchDisplay":
			var text string
			if nullJSON(value) || json.Unmarshal(value, &text) != nil {
				return invalid()
			}
		case "selectedCol":
			if nullJSON(value) {
				return nil
			}
			var col string
			if json.Unmarshal(value, &col) != nil {
				return invalid()
			}
			switch col {
			case "base", "iv", "ivNature", "negNature":
			default:
				return invalid()
			}
		default:
			return invalid()
		}
	case "rk_damage_selection":
		switch key {
		case "attacker", "defender":
			if nullJSON(value) {
				return nil
			}
			var id int64
			if json.Unmarshal(value, &id) != nil || id <= 0 {
				return invalid()
			}
		case "attackerTeam", "defenderTeam":
			if nullJSON(value) {
				return nil
			}
			var group string
			if json.Unmarshal(value, &group) != nil {
				return invalid()
			}
		default:
			return invalid()
		}
	}
	return nil
}

func validateConfigChanges(request jsonObject) (map[string]jsonObject, map[string]jsonObject, error) {
	patch, imports := map[string]jsonObject{}, map[string]jsonObject{}
	if len(request) == 0 {
		return patch, imports, nil
	}
	if raw, exists := request["clear_pet_configs"]; exists {
		if len(request) != 1 {
			return nil, nil, errors.New("clear_pet_configs must be exclusive")
		}
		if _, err := clearPetIDs(raw); err != nil {
			return nil, nil, err
		}
		return patch, imports, nil
	}
	if raw, exists := request["reset_pet_defaults"]; exists {
		if len(request) != 1 || !bytes.Equal(bytes.TrimSpace(raw), []byte("true")) {
			return nil, nil, errors.New("reset_pet_defaults must be true and exclusive")
		}
		return patch, imports, nil
	}
	for op, raw := range request {
		target := patch
		if op == "import" {
			target = imports
		} else if op != "patch" {
			return nil, nil, fmt.Errorf("unknown operation %q", op)
		}
		sections, err := parseObject(raw)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", op, err)
		}
		for key, rawSection := range sections {
			if !knownConfigSection(key) {
				return nil, nil, fmt.Errorf("unknown section %q", key)
			}
			entries, err := parseObject(rawSection)
			if err != nil {
				return nil, nil, fmt.Errorf("%s: %w", key, err)
			}
			for entry, value := range entries {
				if err := validateConfigEntry(key, entry, value); err != nil {
					return nil, nil, err
				}
			}
			target[key] = entries
		}
	}
	return patch, imports, nil
}

func (s *userConfigStore) data(request jsonObject) (jsonObject, error) {
	patch, imports, err := validateConfigChanges(request)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, before, err := s.loadLocked()
	if err != nil {
		return nil, err
	}
	data, _ := parseObject(doc["data"])
	changed := false
	if _, reset := request["reset_pet_defaults"]; reset {
		if raw, exists := data["rk_pet_configs"]; exists {
			pets, err := parseObject(raw)
			if err != nil {
				return nil, err
			}
			for id, value := range pets {
				record, err := parseObject(value)
				if err != nil {
					return nil, fmt.Errorf("invalid personal record %s: %w", id, err)
				}
				if !bytes.Equal(bytes.TrimSpace(record["mode"]), []byte("0")) {
					record["mode"] = json.RawMessage(`0`)
					pets[id], _ = json.Marshal(record)
					changed = true
				}
			}
			if changed {
				data["rk_pet_configs"], _ = json.Marshal(pets)
			}
		}
	}
	if raw, clear := request["clear_pet_configs"]; clear {
		ids, _ := clearPetIDs(raw) // Validated before acquiring the transaction lock.
		var err error
		changed, err = clearPersonalRecords(data, ids)
		if err != nil {
			return nil, err
		}
	}
	flags := jsonObject{}
	if raw, ok := doc["legacy_imported_keys"]; ok {
		flags, _ = parseObject(raw)
	}
	// Import first, then explicit patch wins. Imports test existence, not truthiness.
	for index, sections := range []map[string]jsonObject{imports, patch} {
		for section, entries := range sections {
			if index == 0 && upgradeConfigSection(section) {
				if bytes.Equal(flags[section], []byte("true")) {
					continue
				}
				flags[section] = json.RawMessage(`true`)
				doc["legacy_imported_keys"], _ = json.Marshal(flags)
				changed = true
			} else if index == 0 && bytes.Equal(doc["legacy_imported"], []byte("true")) {
				continue
			}
			if len(entries) == 0 {
				continue
			}
			current := jsonObject{}
			if old, ok := data[section]; ok {
				current, _ = parseObject(old)
			}
			for key, value := range entries {
				old, exists := current[key]
				if index == 0 && exists {
					continue
				}
				if index == 1 && section == "rk_speed_form_overrides" && nullJSON(value) {
					if exists {
						delete(current, key)
						changed = true
					}
				} else if !exists || !bytes.Equal(old, value) {
					// Preserve forward-compatible record fields on partial writes.
					if index == 1 && exists && (section == "rk_pet_configs" || section == "rk_damage_skill_configs" || section == "rk_damage_view") {
						previous, oldErr := parseObject(old)
						fields, newErr := parseObject(value)
						if oldErr == nil && newErr == nil {
							for field, v := range fields {
								previous[field] = v
							}
							value, _ = json.Marshal(previous)
						}
					}
					current[key] = value
					changed = true
				}
			}
			data[section], _ = json.Marshal(current)
		}
	}
	for _, entries := range imports {
		if len(entries) > 0 && !bytes.Equal(doc["legacy_imported"], []byte("true")) {
			doc["legacy_imported"] = json.RawMessage(`true`)
			changed = true
			break
		}
	}
	if changed {
		doc["data"], _ = json.Marshal(data)
		if err := s.writeLocked(doc, before); err != nil {
			return nil, err
		}
	}
	return doc, nil
}

func handleUserConfig(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	var request jsonObject
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		var err error
		request, err = readConfigRequest(w, r)
		if err == nil {
			_, _, err = validateConfigChanges(request)
		}
		if err != nil {
			configRequestError(w, err)
			return
		}
	default:
		w.Header().Set("Allow", "GET, POST")
		configError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
		return
	}
	doc, err := sharedUserConfig.data(request)
	if err != nil {
		configError(w, http.StatusInternalServerError, err)
		return
	}
	imported := false
	_ = json.Unmarshal(doc["legacy_imported"], &imported)
	out, _ := json.Marshal(map[string]any{"ok": true, "schema_version": userConfigSchema, "legacy_imported": imported, "legacy_imported_keys": doc["legacy_imported_keys"], "data": doc["data"]})
	writeJSON(w, http.StatusOK, out)
}

func configRequestError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		status = http.StatusRequestEntityTooLarge
	}
	configError(w, status, err)
}

func defaultSettings() UserSettings {
	return UserSettings{CloseBehavior: "close", WindowWidth: 1280, WindowHeight: 800,
		DefaultRoute: "petdex", DefaultMaxZoom: 100, EffectiveIncludeSpeed: true,
		EffectiveSpeedMode: "include", EffectiveSpeedThreshold: 80}
}

func normalizeEffectiveSpeed(s *UserSettings, obj jsonObject) {
	// Presence matters: a legacy bool-only POST maps to include/exclude even if
	// the previously saved document had a valid threshold mode.
	var mode string
	if raw, ok := obj["effective_speed_mode"]; ok {
		_ = json.Unmarshal(raw, &mode)
	}
	if mode != "include" && mode != "exclude" && mode != "threshold" {
		mode = "exclude"
		if s.EffectiveIncludeSpeed {
			mode = "include"
		}
	}
	s.EffectiveSpeedMode = mode
	s.EffectiveIncludeSpeed = mode != "exclude"
	if s.EffectiveSpeedThreshold < 40 || s.EffectiveSpeedThreshold > 120 {
		s.EffectiveSpeedThreshold = 80
	}
}

func sanitizeSettings(s *UserSettings) {
	if s.CloseBehavior != "minimize" {
		s.CloseBehavior = "close"
	}
	if s.WindowWidth <= 0 {
		s.WindowWidth = 1280
	}
	if s.WindowHeight <= 0 {
		s.WindowHeight = 800
	}
	if s.DefaultRoute == "" || s.DefaultRoute == "game-description" {
		s.DefaultRoute = "petdex"
	}
	if s.DefaultMaxZoom < 50 || s.DefaultMaxZoom > 200 {
		s.DefaultMaxZoom = 100
	}
	if s.HotkeyMods < 0 || s.HotkeyMods > 15 {
		s.HotkeyMods = 0
	}
	if s.HotkeyVK < 0 || s.HotkeyVK > 255 {
		s.HotkeyVK = 0
	}
	if s.DefaultMonitor < 0 || s.DefaultMonitor >= monitorCount() {
		s.DefaultMonitor = 0
	}
}

func settingsFromJSON(raw json.RawMessage, checkFont bool) (UserSettings, error) {
	s := defaultSettings()
	obj, err := parseObject(raw)
	if err != nil {
		return s, err
	}
	known, _ := json.Marshal(s)
	fields, _ := parseObject(known)
	for field := range fields {
		if value, exists := obj[field]; exists && nullJSON(value) {
			return s, fmt.Errorf("settings.%s cannot be null", field)
		}
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return s, err
	}
	normalizeEffectiveSpeed(&s, obj)
	sanitizeSettings(&s)
	if checkFont {
		if font, ok := canonicalInstalledFont(s.FontFamily); ok {
			s.FontFamily = font
		} else {
			s.FontFamily = ""
		}
	}
	return s, nil
}

func (s *userConfigStore) settings() (UserSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, _, err := s.loadLocked()
	if err != nil {
		return defaultSettings(), err
	}
	return settingsFromJSON(doc["settings"], true)
}

type settingsValidationError struct{ err error }

func (e *settingsValidationError) Error() string { return e.err.Error() }

// Merge under the same lock as data writes; keep unknown settings fields and
// all unrelated data. Never load defaults and then blindly overwrite a file.
func (s *userConfigStore) updateSettings(patch jsonObject) (UserSettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, before, err := s.loadLocked()
	if err != nil {
		return UserSettings{}, err
	}
	if len(patch) == 0 {
		return settingsFromJSON(doc["settings"], true)
	}
	current, _ := parseObject(doc["settings"])
	for key, raw := range patch {
		current[key] = raw
	}
	if _, legacy := patch["effective_include_speed"]; legacy {
		if _, mode := patch["effective_speed_mode"]; !mode {
			delete(current, "effective_speed_mode")
		}
	}
	raw, _ := json.Marshal(current)
	result, err := settingsFromJSON(raw, false)
	if err != nil {
		return result, &settingsValidationError{err}
	}
	font, ok := canonicalInstalledFont(result.FontFamily)
	if !ok {
		if _, supplied := patch["font_family"]; supplied {
			return result, &settingsValidationError{errors.New("字体不可用")}
		}
		// Match the old load-then-save behavior for a font uninstalled since
		// the previous save; an unrelated preference must remain editable.
		font = ""
	}
	result.FontFamily = font
	normalized, _ := json.Marshal(result)
	fields, _ := parseObject(normalized)
	for key, value := range fields {
		current[key] = value
	}
	doc["settings"], _ = json.Marshal(current)
	if err := s.writeLocked(doc, before); err != nil {
		return result, err
	}
	return result, nil
}
