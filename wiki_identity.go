package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
)

// Covers the entire read/validate/write transaction, including moves used to
// populate a learnset. Settings and unrelated files do not share this lock.
var dataEditMu sync.Mutex

type wikiSkillRef struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// normalizeMonsterName is deliberately dependency-free and shared by contract with
// the browser/scripts. Only a trailing Roman suffix loses its separators.
func normalizeMonsterName(name string) string {
	roman := [...]string{"I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			b.WriteRune(r - 0xFEE0)
		case r == 0x3000:
			b.WriteByte(' ')
		case r >= 0x2160 && r <= 0x216B:
			b.WriteString(roman[r-0x2160])
		case r >= 0x2170 && r <= 0x217B:
			b.WriteString(roman[r-0x2170])
		case r >= 0x200B && r <= 0x200D || r == 0xFEFF:
			// Zero-width characters are not part of identity.
		case strings.ContainsRune("‐‑‒–—−﹣", r):
			b.WriteByte('-')
		default:
			b.WriteRune(r)
		}
	}
	runes := []rune(strings.TrimFunc(b.String(), wikiNameSpace))
	i := len(runes)
	for i > 0 && strings.ContainsRune("ivxIVX", runes[i-1]) {
		i--
	}
	if i == len(runes) {
		return string(runes)
	}
	j := i
	for j > 0 && (runes[j-1] == '-' || runes[j-1] == '_' || wikiNameSpace(runes[j-1])) {
		j--
	}
	return string(runes[:j]) + strings.ToUpper(string(runes[i:]))
}

// ECMAScript whitespace (not Go's extra U+0085 NEL).
func wikiNameSpace(r rune) bool {
	return r == 0x20 || r >= 0x09 && r <= 0x0D || r == 0x00A0 || r == 0x1680 ||
		r >= 0x2000 && r <= 0x200A || r == 0x2028 || r == 0x2029 ||
		r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF
}

func monsterDisplayName(monster map[string]interface{}) string {
	loc, _ := monster["localized"].(map[string]interface{})
	zh, _ := loc["zh"].(map[string]interface{})
	name, _ := zh["name"].(string)
	form, _ := monster["form"].(string)
	if name != "" && form != "" && form != "default" && form != "Original" {
		name += "（" + form + "）"
	}
	return name
}

func numericMonsterID(value interface{}) (int, error) {
	var n float64
	switch v := value.(type) {
	case int:
		if v > 0 && uint64(v) <= 9007199254740991 {
			return v, nil
		}
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		var err error
		n, err = v.Float64()
		if err != nil {
			return 0, fmt.Errorf("invalid monster_id %v", value)
		}
	default:
		return 0, fmt.Errorf("invalid monster_id %v", value)
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 || n != math.Trunc(n) || n >= float64(math.MaxInt) || n > 9007199254740991 {
		return 0, fmt.Errorf("invalid monster_id %v", value)
	}
	return int(n), nil
}

func cloneObject(in map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(in))
	for k, v := range in {
		if m, ok := v.(map[string]interface{}); ok {
			out[k] = cloneObject(m)
		} else {
			out[k] = v
		}
	}
	return out
}

// Merge missing fields, but never silently choose between conflicting values.
// Decoded JSON values are compared structurally, not by map iteration order.
func mergeWikiFields(dst, src map[string]interface{}, context string) error {
	for k, v := range src {
		old, exists := dst[k]
		if !exists {
			dst[k] = v
			continue
		}
		if !reflect.DeepEqual(old, v) {
			return fmt.Errorf("wiki conflict at %s.%s", context, k)
		}
	}
	return nil
}

func skillIdentity(skill map[string]interface{}) (wikiSkillRef, error) {
	name, ok := skill["name"].(string)
	if !ok || strings.TrimSpace(name) == "" {
		return wikiSkillRef{}, fmt.Errorf("wiki skill has no name")
	}
	source := "默认"
	if v, exists := skill["source"]; exists && v != nil {
		s, ok := v.(string)
		if !ok {
			return wikiSkillRef{}, fmt.Errorf("invalid source for skill %q", name)
		}
		if s != "" {
			source = s
		}
	}
	return wikiSkillRef{name, source}, nil
}

func entrySkills(entry map[string]interface{}) ([]map[string]interface{}, error) {
	raw, exists := entry["skills"]
	if !exists || raw == nil {
		return []map[string]interface{}{}, nil
	}
	list, ok := raw.([]interface{})
	if !ok {
		return nil, fmt.Errorf("wiki skills must be an array")
	}
	out := make([]map[string]interface{}, 0, len(list))
	for _, v := range list {
		m, ok := v.(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("invalid wiki skill")
		}
		out = append(out, m)
	}
	return out, nil
}

func mergeWikiSkillLists(lists ...[]map[string]interface{}) ([]map[string]interface{}, error) {
	out := []map[string]interface{}{}
	seen := map[wikiSkillRef]map[string]interface{}{}
	for _, list := range lists {
		for _, raw := range list {
			key, err := skillIdentity(raw)
			if err != nil {
				return nil, err
			}
			skill := cloneObject(raw)
			skill["source"] = key.Source
			if old, ok := seen[key]; ok {
				if err := mergeWikiFields(old, skill, "skill "+key.Name+"/"+key.Source); err != nil {
					return nil, err
				}
			} else {
				seen[key] = skill
				out = append(out, skill)
			}
		}
	}
	return out, nil
}

type resolvedWikiEntry struct {
	Canonical string
	Aliases   []string
	Entry     map[string]interface{}
	Skills    []map[string]interface{}
}

// ID is authoritative (including after a rename). Name fallback applies only to
// untagged legacy entries. A name collision with another explicit ID is an error.
// Does not mutate wiki or monster; full forms are never reduced to a base name.
func wikiAliases(entry map[string]interface{}) ([]string, error) {
	value := entry["aliases"]
	if value == nil {
		return nil, nil
	}
	values, ok := value.([]interface{})
	if !ok {
		return nil, fmt.Errorf("aliases must be an array of names")
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		name, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("aliases must contain names")
		}
		out = append(out, name)
	}
	return out, nil
}

// Registers all known display names before historical names, so a rename may
// claim an unknown old name but cannot claim another known monster's identity.
func wikiIdentityOwners(wiki map[string]interface{}, monster map[string]interface{}, inventory []map[string]interface{}) (map[string]int, error) {
	complete := len(inventory) > 0
	if !complete {
		inventory = []map[string]interface{}{monster}
	}
	byID, byName := map[int]bool{}, map[string]int{}
	register := func(name string, owner int) error {
		key := normalizeMonsterName(name)
		if key == "" {
			return fmt.Errorf("empty name for monster_id %d", owner)
		}
		if prior, exists := byName[key]; exists && prior != owner {
			return fmt.Errorf("wiki identity conflict: %q belongs to monster_id %d, not %d", name, prior, owner)
		}
		byName[key] = owner
		return nil
	}
	for _, m := range inventory {
		id, err := numericMonsterID(m["id"])
		if err != nil {
			return nil, err
		}
		if byID[id] {
			return nil, fmt.Errorf("duplicate monster ID %d", id)
		}
		byID[id] = true
		if err := register(monsterDisplayName(m), id); err != nil {
			return nil, err
		}
	}
	keys, owners := []string{}, map[string]int{}
	registerEntry := func(key string, entry map[string]interface{}, id int) error {
		if err := register(key, id); err != nil {
			return err
		}
		aliases, err := wikiAliases(entry)
		if err != nil {
			return err
		}
		for _, alias := range aliases {
			if err := register(alias, id); err != nil {
				return err
			}
		}
		owners[key] = id
		return nil
	}
	for key := range wiki {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// Explicit IDs first, regardless of JSON object order.
	for _, key := range keys {
		entry, ok := wiki[key].(map[string]interface{})
		if !ok {
			return nil, fmt.Errorf("invalid wiki entry %q", key)
		}
		if value := entry["monster_id"]; value != nil {
			id, err := numericMonsterID(value)
			if err != nil {
				return nil, fmt.Errorf("wiki %q: %w", key, err)
			}
			if complete && !byID[id] {
				return nil, fmt.Errorf("wiki %q references unknown monster_id %d", key, id)
			}
			if err := registerEntry(key, entry, id); err != nil {
				return nil, err
			}
		}
	}
	// Register newly resolved legacy aliases until no more names become known.
	for {
		progress := false
		for _, key := range keys {
			if owners[key] != 0 {
				continue
			}
			if id := byName[normalizeMonsterName(key)]; id != 0 {
				if err := registerEntry(key, wiki[key].(map[string]interface{}), id); err != nil {
					return nil, err
				}
				progress = true
			}
		}
		if !progress {
			break
		}
	}
	return owners, nil
}

func resolveWikiIdentity(wiki map[string]interface{}, monster map[string]interface{}, inventory ...[]map[string]interface{}) (resolvedWikiEntry, error) {
	result := resolvedWikiEntry{Canonical: monsterDisplayName(monster)}
	id, err := numericMonsterID(monster["id"])
	if err != nil {
		return result, err
	}
	if result.Canonical == "" {
		return result, fmt.Errorf("monster %d has no display name", id)
	}
	var all []map[string]interface{}
	if len(inventory) > 0 {
		all = inventory[0]
	}
	owners, err := wikiIdentityOwners(wiki, monster, all)
	if err != nil {
		return result, err
	}
	keys := []string{}
	for key, owner := range owners {
		if owner == id {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	// Canonical metadata (especially image) gets first preference.
	for i, key := range keys {
		if key == result.Canonical {
			keys = append([]string{key}, append(keys[:i], keys[i+1:]...)...)
			break
		}
	}
	result.Entry = map[string]interface{}{"monster_id": id}
	var lists [][]map[string]interface{}
	aliases := map[string]bool{}
	for _, key := range keys {
		entry := wiki[key].(map[string]interface{})
		result.Aliases = append(result.Aliases, key)
		if key != result.Canonical {
			aliases[key] = true
		}
		names, err := wikiAliases(entry)
		if err != nil {
			return result, err
		}
		for _, alias := range names {
			if alias != result.Canonical {
				aliases[alias] = true
			}
		}
		skills, err := entrySkills(entry)
		if err != nil {
			return result, fmt.Errorf("wiki %q: %w", key, err)
		}
		for _, skill := range skills {
			if _, err := skillIdentity(skill); err != nil {
				return result, err
			}
		}
		lists = append(lists, skills)
		meta := cloneObject(entry)
		delete(meta, "monster_id")
		delete(meta, "skills")
		delete(meta, "image")
		delete(meta, "aliases")
		if err := mergeWikiFields(result.Entry, meta, key); err != nil {
			return result, err
		}
		if image, exists := entry["image"]; exists && image != nil {
			s, ok := image.(string)
			if !ok {
				return result, fmt.Errorf("invalid image in wiki %q", key)
			}
			if previous, _ := result.Entry["image"].(string); previous == "" {
				result.Entry["image"] = s
			}
		}
	}
	if len(lists) == 1 {
		result.Skills = lists[0]
	} else {
		result.Skills, err = mergeWikiSkillLists(lists...)
		if err != nil {
			return result, err
		}
	}
	if _, ok := result.Entry["image"]; !ok {
		result.Entry["image"] = ""
	}
	if len(aliases) > 0 {
		names := make([]string, 0, len(aliases))
		for alias := range aliases {
			names = append(names, alias)
		}
		sort.Strings(names)
		result.Entry["aliases"] = names
	}
	result.Entry["skills"] = result.Skills
	return result, nil
}

func decodeWiki(data []byte) (map[string]interface{}, error) {
	var wiki map[string]interface{}
	if err := json.Unmarshal(bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf}), &wiki); err != nil {
		return nil, fmt.Errorf("parse wiki: %w", err)
	}
	if wiki == nil {
		return nil, fmt.Errorf("wiki must be an object, not null")
	}
	return wiki, nil
}

func effectiveWikiSkills(wiki map[string]interface{}, monster map[string]interface{}, monsters []map[string]interface{}) ([]map[string]interface{}, error) {
	seen := map[int]bool{}
	for {
		id, err := numericMonsterID(monster["id"])
		if err != nil {
			return nil, err
		}
		if seen[id] {
			return nil, fmt.Errorf("learnset inheritance cycle at %d", id)
		}
		seen[id] = true
		resolved, err := resolveWikiIdentity(wiki, monster, monsters)
		if err != nil {
			return nil, err
		}
		currentSkills := resolved.Skills
		// Preserve the frontend's historical winter-form base-name fallback,
		// but never let it override an explicitly present (possibly empty) entry.
		if len(resolved.Aliases) == 0 {
			loc, _ := monster["localized"].(map[string]interface{})
			zh, _ := loc["zh"].(map[string]interface{})
			base, _ := zh["name"].(string)
			if base != monsterDisplayName(monster) {
				if entry, ok := wiki[base].(map[string]interface{}); ok {
					currentSkills, err = entrySkills(entry)
					if err != nil {
						return nil, err
					}
				}
			}
		}
		parent, inherits := monster["learnset_inherits_from_id"]
		if monster["learnset_mode"] != "inherit" || !inherits || parent == nil {
			return currentSkills, nil
		}
		parentID, err := numericMonsterID(parent)
		if err != nil {
			return nil, err
		}
		var next map[string]interface{}
		for _, m := range monsters {
			if mid, _ := numericMonsterID(m["id"]); mid == parentID {
				next = m
				break
			}
		}
		if next == nil {
			return nil, fmt.Errorf("learnset parent %d not found", parentID)
		}
		monster = next
	}
}

func normalizeSkillRefs(refs []wikiSkillRef) ([]wikiSkillRef, error) {
	out := make([]wikiSkillRef, 0, len(refs))
	seen := map[wikiSkillRef]bool{}
	for _, ref := range refs {
		if strings.TrimSpace(ref.Name) == "" {
			return nil, fmt.Errorf("skill name cannot be empty")
		}
		if ref.Source == "" {
			ref.Source = "默认"
		}
		if !seen[ref] {
			seen[ref] = true
			out = append(out, ref)
		}
	}
	return out, nil
}

func sameSkillRefs(skills []map[string]interface{}, refs []wikiSkillRef) bool {
	seen := map[wikiSkillRef]bool{}
	for _, skill := range skills {
		key, err := skillIdentity(skill)
		if err != nil {
			return false
		}
		seen[key] = true
	}
	if len(seen) != len(refs) {
		return false
	}
	for _, ref := range refs {
		if !seen[ref] {
			return false
		}
	}
	return true
}

func moveSkillInfo(data []byte) (map[string]map[string]interface{}, error) {
	var moves []map[string]interface{}
	if err := json.Unmarshal(data, &moves); err != nil {
		var entries map[string]map[string]interface{}
		if err := json.Unmarshal(data, &entries); err != nil || entries == nil {
			return nil, fmt.Errorf("parse moves: expected array or object")
		}
		keys := make([]string, 0, len(entries))
		for key := range entries {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			moves = append(moves, entries[key])
		}
	} else if moves == nil {
		return nil, fmt.Errorf("parse moves: null array")
	}
	categories := map[string]string{"Physical Attack": "物攻", "Magic Attack": "魔攻", "Status": "状态", "Defense": "防御", "Conditional Attack": "条件攻击", "Energy": "能量"}
	out := map[string]map[string]interface{}{}
	for _, mv := range moves {
		loc, _ := mv["localized"].(map[string]interface{})
		zh, _ := loc["zh"].(map[string]interface{})
		name, _ := zh["name"].(string)
		if name == "" {
			continue
		}
		cat, _ := mv["move_category"].(string)
		cat = categories[cat]
		if cat == "" {
			cat = "自定义"
		}
		elem := "普通"
		mt, _ := mv["move_type"].(map[string]interface{})
		if n, _ := mt["name"].(string); n != "" {
			elem = n
		}
		mloc, _ := mt["localized"].(map[string]interface{})
		if n, _ := mloc["zh"].(string); n != "" {
			elem = n
		}
		if mzh, ok := mloc["zh"].(map[string]interface{}); ok {
			if n, _ := mzh["name"].(string); n != "" {
				elem = n
			} else if n, _ := mzh["zh"].(string); n != "" {
				elem = n
			}
		}
		desc, _ := zh["description"].(string)
		info := map[string]interface{}{"name": name, "type": cat, "element": elem, "desc": desc}
		if old, exists := out[name]; exists && !reflect.DeepEqual(old, info) {
			return nil, fmt.Errorf("conflicting move definitions for %q", name)
		}
		out[name] = info
	}
	return out, nil
}

// prepareWikiSkills never writes. nil means skillList was omitted/null, or its
// effective name/source set is unchanged. Non-nil lists are explicit replacement
// lists; existing metadata for retained skills survives. Aliases are validated
// and merged BEFORE replacement, so conflicting data cannot be hidden by edits.
func prepareWikiSkills(wikiData, movesData []byte, monster map[string]interface{}, monsters []map[string]interface{}, refs []wikiSkillRef, allowEmpty bool) ([]byte, bool, error) {
	if refs == nil {
		return nil, false, nil
	}
	wiki, err := decodeWiki(wikiData)
	if err != nil {
		return nil, false, err
	}
	resolved, err := resolveWikiIdentity(wiki, monster, monsters)
	if err != nil {
		return nil, false, err
	}
	current, err := effectiveWikiSkills(wiki, monster, monsters)
	if err != nil {
		return nil, false, err
	}
	refs, err = normalizeSkillRefs(refs)
	if err != nil {
		return nil, false, err
	}
	if len(refs) == 0 && (len(current) > 0 || len(resolved.Skills) > 0) && !allowEmpty {
		return nil, false, fmt.Errorf("refusing to clear existing skills without allowEmptySkills=true")
	}
	if sameSkillRefs(current, refs) && !(len(refs) == 0 && len(resolved.Skills) > 0) {
		return nil, false, nil
	}
	info := map[string]map[string]interface{}{}
	if len(refs) > 0 {
		info, err = moveSkillInfo(movesData)
		if err != nil {
			return nil, false, err
		}
	}
	// Preserve duplicate rows in a single entry. Only the resolver's actual
	// multi-alias merge deduplicates old data. Never merge ancestor identities.
	byKey := map[wikiSkillRef][]map[string]interface{}{}
	for _, skill := range current {
		key, _ := skillIdentity(skill)
		byKey[key] = append(byKey[key], skill)
	}
	fallback := map[wikiSkillRef][]map[string]interface{}{}
	for _, skill := range resolved.Skills {
		key, _ := skillIdentity(skill)
		fallback[key] = append(fallback[key], skill)
	}
	for key, rows := range fallback {
		if _, exists := byKey[key]; !exists {
			byKey[key] = rows
		}
	}
	skills := make([]map[string]interface{}, 0, len(refs))
	for _, ref := range refs {
		rows := byKey[ref]
		if len(rows) == 0 {
			skill := info[ref.Name]
			if skill == nil {
				return nil, false, fmt.Errorf("主技能表中不存在新增技能：%s", ref.Name)
			}
			rows = []map[string]interface{}{skill}
		}
		for _, row := range rows {
			skill := cloneObject(row)
			if _, exists := row["source"]; !exists {
				skill["source"] = ref.Source
			}
			skills = append(skills, skill)
		}
	}

	for _, key := range resolved.Aliases {
		delete(wiki, key)
	}
	resolved.Entry["skills"] = skills
	wiki[resolved.Canonical] = resolved.Entry
	out, err := json.MarshalIndent(wiki, "", "  ")
	if err != nil {
		return nil, false, fmt.Errorf("marshal wiki: %w", err)
	}
	return out, true, nil
}

type preparedDataWrite struct {
	Path          string
	Before, After []byte
}

// A missing/corrupt wiki is never treated as an empty database. Call only while
// holding dataEditMu. No filesystem writes happen until every file is prepared.
func updateWikiSkills(monster map[string]interface{}, monsters []map[string]interface{}, refs []wikiSkillRef, allowEmpty bool, wikiPath, movesPath string) (*preparedDataWrite, bool, error) {
	if refs == nil {
		return nil, false, nil
	}
	before, err := os.ReadFile(wikiPath)
	if err != nil {
		return nil, false, fmt.Errorf("read wiki: %w", err)
	}
	var moves []byte
	if len(refs) > 0 {
		moves, err = os.ReadFile(movesPath)
		if err != nil {
			return nil, false, fmt.Errorf("read moves: %w", err)
		}
	}
	after, changed, err := prepareWikiSkills(before, moves, monster, monsters, refs, allowEmpty)
	if err != nil || !changed {
		return nil, changed, err
	}
	return &preparedDataWrite{wikiPath, before, after}, true, nil
}

func prepareMonsterSave(monsters []map[string]interface{}, monster map[string]interface{}, refs []wikiSkillRef, allowEmpty bool, monsterPath string, before []byte, wikiPath, movesPath string) ([]preparedDataWrite, error) {
	wikiWrite, changed, err := updateWikiSkills(monster, monsters, refs, allowEmpty, wikiPath, movesPath)
	if err != nil {
		return nil, err
	}
	if changed {
		monster["learnset_mode"] = "own"
		delete(monster, "learnset_inherits_from_id")
	}
	after, err := json.MarshalIndent(monsters, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal monsters: %w", err)
	}
	writes := []preparedDataWrite{{monsterPath, before, after}}
	if wikiWrite != nil {
		writes = append(writes, *wikiWrite)
	}
	return writes, nil
}

// Stage on the same volume, flush and close before rename. Both files are staged
// before either replacement. A second replacement failure restores the first;
// rollback errors are returned too (this is not a crash-atomic two-file journal).
func stageDataWrite(path string, data []byte) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("not a regular data file: %s", path)
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".wiki-save-*")
	if err != nil {
		return "", err
	}
	name := f.Name()
	ok := false
	defer func() {
		if !ok {
			f.Close()
			os.Remove(name)
		}
	}()
	if err = f.Chmod(st.Mode().Perm()); err != nil {
		return "", err
	}
	if _, err = f.Write(data); err != nil {
		return "", err
	}
	if err = f.Sync(); err != nil {
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	ok = true
	return name, nil
}

func commitDataWrites(writes []preparedDataWrite) error {
	return commitDataWritesWithRename(writes, os.Rename)
}

func commitDataWritesWithRename(writes []preparedDataWrite, rename func(string, string) error) error {
	staged := make([]string, len(writes))
	defer func() {
		for _, path := range staged {
			if path != "" {
				os.Remove(path)
			}
		}
	}()
	for i, write := range writes {
		current, err := os.ReadFile(write.Path)
		if err != nil {
			return fmt.Errorf("read before save: %w", err)
		}
		if !bytes.Equal(current, write.Before) {
			return fmt.Errorf("data file changed during save: %s", write.Path)
		}
		staged[i], err = stageDataWrite(write.Path, write.After)
		if err != nil {
			return fmt.Errorf("stage %s: %w", write.Path, err)
		}
	}
	for i, write := range writes {
		if err := rename(staged[i], write.Path); err != nil {
			failure := fmt.Errorf("replace %s: %w", write.Path, err)
			for j := i - 1; j >= 0; j-- {
				backup, rollbackErr := stageDataWrite(writes[j].Path, writes[j].Before)
				if rollbackErr == nil {
					rollbackErr = rename(backup, writes[j].Path)
					os.Remove(backup)
				}
				if rollbackErr != nil {
					failure = fmt.Errorf("%w; rollback %s failed: %v", failure, writes[j].Path, rollbackErr)
				}
			}
			return failure
		}
		staged[i] = ""
	}
	return nil
}

func writeDataError(w http.ResponseWriter, err error) {
	out, _ := json.Marshal(map[string]interface{}{"ok": false, "error": err.Error()})
	writeJSON(w, http.StatusInternalServerError, out)
}
