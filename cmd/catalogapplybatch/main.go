// catalogapplybatch is a developer-only, offline store commit command. It has
// no startup hook, source writer, database, downloads or implicit profile paths.
// Manually reviewed candidates are committed byte-for-byte; default is audit.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
)

const maxManifestBytes = 1 << 20
const maxChanges = 4096

// Changes are exact RFC6901 pointers, not prefixes or patterns. Objects recurse;
// nested arrays are atomic. Top-level collection arrays retain old ID positions,
// and each appended row is one /collection/index change. List order is irrelevant.
type manifest struct {
	Version         int      `json:"version"`
	BaselineSHA256  string   `json:"baseline_sha256"`
	CandidateSHA256 string   `json:"candidate_sha256"`
	Changes         []string `json:"changes"`
	NewMonsterIDs   []int    `json:"new_monster_ids"`
	NewSkillIDs     []int    `json:"new_skill_ids"`
	NewTraitIDs     []string `json:"new_trait_ids"`
	LeaderAvatarIDs []int    `json:"leader_avatar_ids"`
}

type dependencies struct {
	replace      func(string, string) error
	appClosed    func() error
	beforeCommit func() error // isolated tests can simulate a competing writer
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	return runWithDependencies(args, stdout, dependencies{replace: catalogstore.ReplaceFile, appClosed: checkAppClosed})
}

func runWithDependencies(args []string, stdout io.Writer, deps dependencies) error {
	flags := flag.NewFlagSet("catalogapplybatch", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	rootFlag := flags.String("storeRoot", "", "explicit absolute existing user catalog store; no bootstrap/fallback")
	candidateFlag := flags.String("candidate", "", "explicit absolute prevalidated catalog candidate (32 MiB maximum)")
	expected := flags.String("expectedRevision", "", "exact active catalog SHA256; required even for audit")
	backupFlag := flags.String("backupDir", "", "explicit absolute external backup directory; audit does not create it")
	existingBackupFlag := flags.String("existingBackupFile", "", "optional explicit absolute already-existing independent exact active catalog backup within backupDir; read-only reuse, never inferred")
	manifestFlag := flags.String("manifest", "", "explicit absolute reviewed hash/diff manifest (1 MiB maximum)")
	baselineFlag := flags.String("baseline", "", "optional explicit absolute valid JSON baseline for catalogstore.Open, never committed")
	apply := flags.Bool("apply", false, "commit the reviewed candidate to this store only; otherwise read-only audit")
	appClosed := flags.Bool("appClosed", false, "acknowledge caller has closed the app and all competing writers; required for apply")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || !validHash(*expected) {
		return fmt.Errorf("required exact -expectedRevision and no positional arguments")
	}
	if *appClosed && !*apply {
		return fmt.Errorf("-appClosed requires -apply")
	}
	if *apply && !*appClosed {
		return fmt.Errorf("-apply requires -appClosed; close the app and finish all saves first")
	}
	if deps.replace == nil || deps.appClosed == nil {
		return fmt.Errorf("missing atomic replace or process checker")
	}
	paths := make([]string, 4)
	for i, value := range []string{*rootFlag, *candidateFlag, *backupFlag, *manifestFlag} {
		if value == "" || !filepath.IsAbs(value) {
			return fmt.Errorf("-storeRoot, -candidate, -backupDir and -manifest must all be explicit absolute paths")
		}
		p, err := resolvedPath(value)
		if err != nil {
			return err
		}
		paths[i] = p
	}
	root, candidatePath, backup, manifestPath := paths[0], paths[1], paths[2], paths[3]
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cwd, err = resolvedPath(cwd)
	if err != nil {
		return err
	}
	baselinePath := ""
	if *baselineFlag != "" {
		if !filepath.IsAbs(*baselineFlag) {
			return fmt.Errorf("-baseline must be an explicit absolute path")
		}
		baselinePath, err = resolvedPath(*baselineFlag)
		if err != nil {
			return err
		}
	}
	protected := []string{cwd, root, filepath.Dir(candidatePath), filepath.Dir(manifestPath)}
	if baselinePath != "" {
		p := filepath.Dir(baselinePath)
		if strings.EqualFold(filepath.Base(p), "data") {
			p = filepath.Dir(p)
		}
		protected = append(protected, p)
	}
	for _, p := range protected {
		if sameOrWithin(p, backup) || sameOrWithin(backup, p) {
			return fmt.Errorf("backup directory must be external and separate from project, inputs and store")
		}
	}
	for _, p := range []string{candidatePath, manifestPath, baselinePath} {
		if p != "" && (sameOrWithin(root, p) || sameOrWithin(backup, p)) {
			return fmt.Errorf("candidate, manifest and optional baseline must be outside the store and backup")
		}
	}
	candidate, err := readBounded(candidatePath, catalogstore.MaxCatalogBytes)
	if err != nil {
		return err
	}
	if err = validateCatalog(candidate); err != nil {
		return fmt.Errorf("candidate rejected: %w", err)
	}
	manifestBytes, err := readBounded(manifestPath, maxManifestBytes)
	if err != nil {
		return err
	}
	plan, err := parseManifest(manifestBytes)
	if err != nil {
		return err
	}
	if plan.BaselineSHA256 != *expected || plan.CandidateSHA256 != catalogstore.Hash(candidate) {
		return fmt.Errorf("manifest hashes do not match exact expected revision and candidate bytes")
	}
	pointerPath := filepath.Join(root, "current.json")
	pointerBytes, err := readBounded(pointerPath, 4096)
	if err != nil {
		return fmt.Errorf("existing active pointer required; no bootstrap or fallback: %w", err)
	}
	var pointer struct {
		Version   int    `json:"version"`
		Revision  string `json:"revision"`
		UpdatedAt string `json:"updated_at"`
	}
	if err = decodeStrict(pointerBytes, &pointer); err != nil {
		return fmt.Errorf("invalid active pointer: %w", err)
	}
	if pointer.Version != 1 || pointer.Revision != *expected {
		return catalogstore.ErrConflict
	}
	current, err := readBounded(filepath.Join(root, "versions", *expected+".json"), catalogstore.MaxCatalogBytes)
	if err != nil {
		return err
	}
	if catalogstore.Hash(current) != *expected {
		return fmt.Errorf("active object checksum mismatch")
	}
	baseline := current
	if baselinePath != "" {
		baseline, err = readBounded(baselinePath, catalogstore.MaxCatalogBytes)
		if err != nil {
			return err
		}
	}
	checkPointer := func() error {
		disk, e := readBounded(pointerPath, 4096)
		if e != nil {
			return e
		}
		if !bytes.Equal(disk, pointerBytes) {
			return catalogstore.ErrConflict
		}
		return nil
	}
	guardedReplace := func(from, to string) error {
		// catalogstore checks CAS before staging; this also guards the late pointer
		// switch after durable objects/backup exist. It is not an interprocess lock:
		// -appClosed acknowledges no competing writers through the whole operation.
		if err := checkPointer(); err != nil {
			return err
		}
		return deps.replace(from, to)
	}
	existingBackupPath := ""
	if *existingBackupFlag != "" {
		existingBackupPath, err = verifyExistingBackup(*existingBackupFlag, backup, root, current, plan.BaselineSHA256,
			[]string{candidatePath, manifestPath, baselinePath, pointerPath, filepath.Join(root, "previous.json"), filepath.Join(root, "versions", *expected+".json")})
		if err != nil {
			return err
		}
	}
	store, err := catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, ExistingBackupFile: existingBackupPath, Baseline: baseline, Validate: validateCatalog, Replace: guardedReplace})
	if err != nil {
		return err
	}
	snapshot := store.Current()
	if snapshot.Recovery != "" {
		return fmt.Errorf("store recovery refused; repair explicitly before applying")
	}
	if snapshot.Revision != *expected || !bytes.Equal(snapshot.Data, current) {
		return catalogstore.ErrConflict
	}
	if err = checkPointer(); err != nil {
		return err
	}
	changes, err := verifyCandidate(current, candidate, plan)
	if err != nil {
		return err
	}
	committed := ""
	if *apply {
		if existingBackupPath == "" {
			backupFile := filepath.Join(backup, *expected+".json")
			if info, e := os.Lstat(backupFile); e == nil {
				if !info.Mode().IsRegular() {
					return fmt.Errorf("existing backup must be an independent regular file")
				}
				objectInfo, e := os.Stat(filepath.Join(root, "versions", *expected+".json"))
				if e != nil {
					return e
				}
				if os.SameFile(info, objectInfo) {
					return fmt.Errorf("existing backup must not alias the active immutable object")
				}
			} else if !errors.Is(e, os.ErrNotExist) {
				return e
			}
		}
		if err = deps.appClosed(); err != nil {
			return err
		}
		if deps.beforeCommit != nil {
			if err = deps.beforeCommit(); err != nil {
				return err
			}
		}
		if err = checkPointer(); err != nil {
			return err
		}
		next, e := store.Commit(candidate, *expected, nil) // immutable static image copies are caller-owned
		if e != nil {
			return e
		}
		committed = next.Revision
	}
	mode := "audit"
	if *apply {
		mode = "apply"
	}
	report := map[string]any{
		"mode": mode, "current_revision": snapshot.Revision,
		"candidate_sha256": catalogstore.Hash(candidate), "manifest_sha256": catalogstore.Hash(manifestBytes),
		"committed_revision": committed, "changes": changes, "already_applied": bytes.Equal(current, candidate),
	}
	if existingBackupPath != "" {
		// Exact backup bytes were checked above and the corresponding current
		// catalog schema was validated by Open. Never publish the private path.
		report["existing_backup_verified"] = true
	}
	return json.NewEncoder(stdout).Encode(report)
}

func validateCatalog(raw []byte) error {
	c, err := catalog.Parse(raw)
	if err != nil {
		return err
	}
	return catalogrecovery.Validate(c)
}

func validHash(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func parseManifest(raw []byte) (*manifest, error) {
	var m manifest
	if err := decodeStrict(raw, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if m.Version != 1 || !validHash(m.BaselineSHA256) || !validHash(m.CandidateSHA256) || m.Changes == nil || m.NewMonsterIDs == nil || m.NewSkillIDs == nil || m.NewTraitIDs == nil || m.LeaderAvatarIDs == nil {
		return nil, fmt.Errorf("manifest v1 requires exact hashes and explicit changes/new_monster_ids/new_skill_ids/new_trait_ids/leader_avatar_ids arrays")
	}
	if len(m.Changes) > maxChanges || len(m.NewMonsterIDs) > 64 || len(m.NewSkillIDs) > 29 || len(m.NewTraitIDs) > 64 || len(m.LeaderAvatarIDs) > 43 {
		return nil, fmt.Errorf("manifest exceeds bounded change/append scope")
	}
	seen := map[string]bool{}
	for _, p := range m.Changes {
		if !validPointer(p) || seen[p] {
			return nil, fmt.Errorf("manifest contains invalid or duplicate exact diff pointer %q", p)
		}
		seen[p] = true
	}
	for _, ids := range [][]int{m.NewMonsterIDs, m.NewSkillIDs, m.LeaderAvatarIDs} {
		seen := map[int]bool{}
		for _, id := range ids {
			if id <= 0 || id > 2147483647 || id == 9001 || seen[id] {
				return nil, fmt.Errorf("invalid or duplicate manifest ID %d", id)
			}
			seen[id] = true
		}
	}
	seen = map[string]bool{}
	for _, id := range m.NewTraitIDs {
		if strings.TrimSpace(id) == "" || len(id) > 256 || seen[id] {
			return nil, fmt.Errorf("invalid or duplicate manifest trait ID")
		}
		seen[id] = true
	}
	return &m, nil
}

func verifyCandidate(before, after []byte, m *manifest) ([]string, error) {
	// Raw JSON rather than Marshal(Parse(...)): unknown fields, sparse extensions,
	// number precision and missing-vs-null values cannot be normalized away.
	a, err := decodeJSON(before)
	if err != nil {
		return nil, err
	}
	b, err := decodeJSON(after)
	if err != nil {
		return nil, err
	}
	old, ok := a.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("baseline must be an object")
	}
	next, ok := b.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("candidate must be an object")
	}
	if !semanticEqual(old["schema_version"], next["schema_version"]) {
		return nil, fmt.Errorf("schema version changes are outside batch scope")
	}
	changes := []string{}
	appendIDs := map[string][]string{"monsters": intStrings(m.NewMonsterIDs), "skills": intStrings(m.NewSkillIDs), "traits": m.NewTraitIDs, "learnsets": intStrings(m.NewMonsterIDs)}
	leaderIDs := map[string]bool{}
	for _, id := range m.LeaderAvatarIDs {
		leaderIDs[strconv.Itoa(id)] = true
	}
	foundLeaders := map[string]bool{}
	collections := []struct {
		name, key string
		shape     reflect.Type
	}{
		{"monsters", "id", reflect.TypeOf(catalog.Monster{})}, {"skills", "id", reflect.TypeOf(catalog.Skill{})},
		{"traits", "id", reflect.TypeOf(catalog.Trait{})}, {"learnsets", "monster_id", reflect.TypeOf(catalog.Learnset{})},
		{"skill_rules", "skill_id", reflect.TypeOf(catalog.SkillRule{})},
	}
	for _, collection := range collections {
		name := collection.name
		if name == "skill_rules" {
			_, oldPresent := old[name]
			_, newPresent := next[name]
			if oldPresent && !newPresent {
				return nil, fmt.Errorf("existing skill_rules array cannot be removed")
			}
			if !oldPresent && newPresent {
				values, ok := next[name].([]any)
				if !ok || len(values) == 0 {
					return nil, fmt.Errorf("empty skill_rules field addition is outside append scope")
				}
			}
		}
		prior, e := collectionRows(old, name)
		if e != nil {
			return nil, e
		}
		rows, e := collectionRows(next, name)
		if e != nil {
			return nil, e
		}
		if len(rows) < len(prior) {
			return nil, fmt.Errorf("%s deletion refused", name)
		}
		oldIDs := map[string]bool{}
		for i, row := range prior {
			id := rowID(row[collection.key])
			if id == "" || oldIDs[id] {
				return nil, fmt.Errorf("invalid baseline %s IDs", name)
			}
			oldIDs[id] = true
			if id != rowID(rows[i][collection.key]) {
				return nil, fmt.Errorf("%s old ID order or identity changed at %d", name, i)
			}
			prefix := "/" + name + "/" + strconv.Itoa(i)
			diff := []string{}
			diffObject(row, rows[i], prefix, &diff)
			if name == "monsters" && leaderIDs[id] {
				if row["is_leader_form"] != true {
					return nil, fmt.Errorf("avatar manifest ID %s is not an existing leader", id)
				}
				foundLeaders[id] = true
			}
			for _, path := range diff {
				relative := strings.TrimPrefix(path, prefix+"/")
				switch name {
				case "monsters":
					metadataCleanup := id == "410" && relative == "extensions/legacy_omit" && allowed410ImageOmitCleanup(row, rows[i])
					if !allowedMonsterPath(id, relative, leaderIDs[id]) && !metadataCleanup {
						return nil, fmt.Errorf("existing monster %s unauthorized field: %s", id, path)
					}
				case "learnsets":
					learningField := relative == "skills" || relative == "mode" || relative == "from_id"
					metadataCleanup := id == "619" && completedMonster619(next) && allowed619MetadataCleanup(row, rows[i], relative)
					if (id != "619" && id != "623") || (!learningField && !metadataCleanup) {
						return nil, fmt.Errorf("existing learnset %s is protected: %s", id, path)
					}
					if !hasEffectiveSkills(rows[i], rows, map[string]bool{}) {
						return nil, fmt.Errorf("619/623 replacement must retain a nonempty explicit effective learnset")
					}
					if id == "623" {
						for _, skillID := range []string{"244", "245"} {
							if containsEffectiveSkill(row, prior, skillID, map[string]bool{}) && !containsEffectiveSkill(rows[i], rows, skillID, map[string]bool{}) {
								return nil, fmt.Errorf("623 replacement must retain approved old skill %s", skillID)
							}
						}
					}
				default:
					return nil, fmt.Errorf("existing %s records are protected: %s", name, path)
				}
			}
			if name == "monsters" && len(diff) > 0 {
				extensionsPreserved := preservedExtensions(row, rows[i])
				if !extensionsPreserved && id == "410" && allowed410ImageOmitCleanup(row, rows[i]) {
					oldRow, newRow := cloneMap(row), cloneMap(rows[i])
					oldExt, _ := row["extensions"].(map[string]any)
					newExt, _ := rows[i]["extensions"].(map[string]any)
					oldExt, newExt = cloneMap(oldExt), cloneMap(newExt)
					delete(oldExt, "legacy_omit")
					delete(newExt, "legacy_omit")
					oldRow["extensions"], newRow["extensions"] = oldExt, newExt
					extensionsPreserved = preservedExtensions(oldRow, newRow)
				}
				if !extensionsPreserved {
					return nil, fmt.Errorf("existing monster %s extensions/unknown data must be preserved", id)
				}
				if id == "619" {
					approved := map[string]any{"hp": json.Number("118"), "phy_atk": json.Number("128"), "phy_def": json.Number("81"), "mag_atk": json.Number("42"), "mag_def": json.Number("63"), "speed": json.Number("70")}
					stats, _ := rows[i]["stats"].(map[string]any)
					for k, v := range approved {
						if !semanticEqual(stats[k], v) {
							return nil, fmt.Errorf("619 approved stats must remain exact")
						}
					}
					if !semanticEqual(rows[i]["type_ids"], []any{json.Number("8"), json.Number("15")}) {
						return nil, fmt.Errorf("619 ordered Dragon/Ghost types must remain exact")
					}
					if row["placeholder"] == true && rows[i]["placeholder"] != true {
						learning, e := collectionRows(next, "learnsets")
						if e != nil {
							return nil, e
						}
						complete := false
						for _, l := range learning {
							if rowID(l["monster_id"]) == "619" {
								complete = hasEffectiveSkills(l, learning, map[string]bool{})
							}
						}
						if !complete {
							return nil, fmt.Errorf("619 placeholder completion must include an explicit nonempty effective learnset")
						}
					}
				}
				if id == "623" {
					for _, p := range diff {
						if strings.HasPrefix(p, prefix+"/stats/") {
							approved := map[string]any{"hp": json.Number("126"), "phy_atk": json.Number("105"), "phy_def": json.Number("122"), "mag_atk": json.Number("45"), "mag_def": json.Number("80"), "speed": json.Number("100")}
							stats, _ := rows[i]["stats"].(map[string]any)
							for k, v := range approved {
								if !semanticEqual(stats[k], v) {
									return nil, fmt.Errorf("623 replacement stats must match complete approved tuple")
								}
							}
							break
						}
					}
				}
			}
			changes = append(changes, diff...)
		}
		actual := []string{}
		for i := len(prior); i < len(rows); i++ {
			row := rows[i]
			id := rowID(row[collection.key])
			if id == "" || oldIDs[id] {
				return nil, fmt.Errorf("new %s ID collision", name)
			}
			oldIDs[id] = true
			if err := checkRowShape(row, collection.shape); err != nil {
				return nil, fmt.Errorf("new %s row: %w", name, err)
			}
			if name == "skill_rules" {
				allowed := false
				for _, sid := range m.NewSkillIDs {
					if strconv.Itoa(sid) == id {
						allowed = true
					}
				}
				combo := rowID(row["base_combo"])
				if !allowed || len(row) != 2 || (combo != "2" && combo != "3" && combo != "5") {
					return nil, fmt.Errorf("only new explicit base_combo 2/3/5 rules for declared new skills may append")
				}
			} else {
				actual = append(actual, id)
			}
			changes = append(changes, "/"+name+"/"+strconv.Itoa(i))
		}
		if name == "skill_rules" {
			if len(rows)-len(prior) > len(m.NewSkillIDs) {
				return nil, fmt.Errorf("too many appended rules")
			}
		} else if !sameStrings(actual, appendIDs[name]) {
			return nil, fmt.Errorf("%s appended IDs do not exactly match manifest", name)
		}
	}
	if len(foundLeaders) != len(leaderIDs) {
		return nil, fmt.Errorf("avatar manifest references a missing existing monster")
	}
	// Every other top-level field, including types, unknown fields, global source
	// baseline, choices and identity reservations, is deeply protected.
	protectedOld, protectedNext := cloneMap(old), cloneMap(next)
	for _, c := range collections {
		delete(protectedOld, c.name)
		delete(protectedNext, c.name)
	}
	if !semanticEqual(protectedOld, protectedNext) {
		return nil, fmt.Errorf("types, global extensions or other top-level values changed")
	}
	sort.Strings(changes)
	if !sameStrings(changes, m.Changes) {
		return nil, fmt.Errorf("actual deep diff does not exactly equal manifest changes: actual=%v", changes)
	}
	return changes, nil
}

func allowedMonsterPath(id, path string, avatarAllowed bool) bool {
	if avatarAllowed && path == "images/avatar" {
		return true
	}
	if id == "410" {
		return path == "images/avatar" || path == "images/portrait"
	}
	if id != "619" && id != "623" {
		return false
	}
	// Existing identity and all level controls remain immutable. Extensions and
	// unknown fields are not blanket-authorized; season is the reviewed schema field.
	allowed := map[string]bool{"dex_number": true, "type_ids": true, "trait_id": true, "form": true, "form_category": true, "main_form_id": true, "evolution_stage": true, "evolves_from_id": true, "evolution_members": true, "leader_of_id": true, "evolution_chain_name": true, "is_leader_form": true, "placeholder": true, "data_note": true, "season": true}
	if allowed[path] {
		return true
	}
	if path == "images/avatar" || path == "images/portrait" {
		return true
	}
	for _, key := range []string{"hp", "phy_atk", "phy_def", "mag_atk", "mag_def", "speed"} {
		if path == "stats/"+key {
			return true
		}
	}
	if path == "source_ref" {
		return true
	} // explicit add/remove is bound to hash and exact path
	for _, key := range []string{"provider", "id", "identity"} {
		if path == "source_ref/"+key {
			return true
		}
	}
	return false
}

// This is not an extensions whitelist. Only obsolete 619 projection declarations
// may be removed, after completion with a real portrait and nonempty learning.
// Unknown metadata, note text and all remaining omission order/items stay exact.
func completedMonster619(root map[string]any) bool {
	rows, err := collectionRows(root, "monsters")
	if err != nil {
		return false
	}
	for _, m := range rows {
		if rowID(m["id"]) != "619" {
			continue
		}
		images, _ := m["images"].(map[string]any)
		portrait, _ := images["portrait"].(string)
		return m["placeholder"] == false && strings.TrimSpace(portrait) != ""
	}
	return false
}
func allowed619MetadataCleanup(old, next map[string]any, path string) bool {
	oldExtensions, _ := old["extensions"].(map[string]any)
	nextExtensions, ok := next["extensions"].(map[string]any)
	if !ok {
		return false
	}
	switch path {
	case "extensions/legacy/data_status":
		oldLegacy, _ := oldExtensions["legacy"].(map[string]any)
		nextLegacy, ok := nextExtensions["legacy"].(map[string]any)
		if !ok {
			return false
		}
		_, stillPresent := nextLegacy["data_status"]
		return oldLegacy["data_status"] == "placeholder" && !stillPresent
	case "extensions/legacy_omit":
		return removesOnlyImageOmission(oldExtensions, nextExtensions)
	default:
		return false
	}
}

func allowed410ImageOmitCleanup(old, next map[string]any) bool {
	images, _ := next["images"].(map[string]any)
	avatar, _ := images["avatar"].(string)
	if strings.TrimSpace(avatar) == "" {
		return false
	}
	oldExt, _ := old["extensions"].(map[string]any)
	newExt, ok := next["extensions"].(map[string]any)
	return ok && removesOnlyImageOmission(oldExt, newExt)
}
func removesOnlyImageOmission(oldExt, newExt map[string]any) bool {
	oldOmit, ok := oldExt["legacy_omit"].([]any)
	if !ok {
		return false
	}
	remaining := []any{}
	removed := false
	for _, item := range oldOmit {
		if item == "image" {
			removed = true
		} else {
			remaining = append(remaining, item)
		}
	}
	if !removed {
		return false
	}
	value, exists := newExt["legacy_omit"]
	if !exists {
		return len(remaining) == 0
	}
	nextOmit, ok := value.([]any)
	return ok && semanticEqual(remaining, nextOmit)
}

func hasEffectiveSkills(row map[string]any, rows []map[string]any, seen map[string]bool) bool {
	id := rowID(row["monster_id"])
	if seen[id] {
		return false
	}
	seen[id] = true
	if row["mode"] == "own" {
		skills, ok := row["skills"].([]any)
		return ok && len(skills) > 0
	}
	from := rowID(row["from_id"])
	for _, parent := range rows {
		if rowID(parent["monster_id"]) == from {
			return hasEffectiveSkills(parent, rows, seen)
		}
	}
	return false
}
func containsEffectiveSkill(row map[string]any, rows []map[string]any, skillID string, seen map[string]bool) bool {
	id := rowID(row["monster_id"])
	if seen[id] {
		return false
	}
	seen[id] = true
	if row["mode"] == "own" {
		skills, _ := row["skills"].([]any)
		for _, s := range skills {
			item, _ := s.(map[string]any)
			if rowID(item["skill_id"]) == skillID {
				return true
			}
		}
		return false
	}
	from := rowID(row["from_id"])
	for _, parent := range rows {
		if rowID(parent["monster_id"]) == from {
			return containsEffectiveSkill(parent, rows, skillID, seen)
		}
	}
	return false
}
func preservedExtensions(a, b map[string]any) bool {
	for key, v := range a {
		if key == "extensions" {
			w, ok := b[key]
			if !ok || !semanticEqual(v, w) {
				return false
			}
			continue
		}
		if nested, ok := v.(map[string]any); ok {
			next, ok := b[key].(map[string]any)
			if !ok {
				next = map[string]any{}
			}
			if !preservedExtensions(nested, next) {
				return false
			}
		}
	}
	return true
}

func collectionRows(root map[string]any, name string) ([]map[string]any, error) {
	value, exists := root[name]
	if !exists && name == "skill_rules" {
		return []map[string]any{}, nil
	}
	rows, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an explicit array", name)
	}
	result := make([]map[string]any, len(rows))
	for i, row := range rows {
		object, ok := row.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s row must be an object", name)
		}
		result[i] = object
	}
	return result, nil
}

func checkRowShape(row map[string]any, typ reflect.Type) error {
	allowed := map[string]reflect.Type{}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		allowed[strings.Split(field.Tag.Get("json"), ",")[0]] = field.Type
	}
	for key, value := range row {
		field, ok := allowed[key]
		if !ok {
			return fmt.Errorf("unrecognized new field %q", key)
		}
		if key == "extensions" {
			continue
		}
		if field.Kind() == reflect.Pointer {
			field = field.Elem()
		}
		if field.Kind() == reflect.Struct {
			if nested, ok := value.(map[string]any); ok {
				if err := checkRowShape(nested, field); err != nil {
					return err
				}
			}
		} else if field.Kind() == reflect.Slice && field.Elem().Kind() == reflect.Struct {
			if values, ok := value.([]any); ok {
				for _, v := range values {
					if nested, ok := v.(map[string]any); ok {
						if err := checkRowShape(nested, field.Elem()); err != nil {
							return err
						}
					}
				}
			}
		}
	}
	return nil
}

func rowID(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		n, err := strconv.ParseInt(x.String(), 10, 64)
		if err == nil && n > 0 && n <= 2147483647 {
			return strconv.FormatInt(n, 10)
		}
	}
	return ""
}
func intStrings(ids []int) []string {
	result := make([]string, len(ids))
	for i, id := range ids {
		result[i] = strconv.Itoa(id)
	}
	return result
}
func cloneMap(m map[string]any) map[string]any {
	result := map[string]any{}
	for k, v := range m {
		result[k] = v
	}
	return result
}
func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x, y := append([]string{}, a...), append([]string{}, b...)
	sort.Strings(x)
	sort.Strings(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}
func pointerEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
func validPointer(p string) bool {
	if p == "" || len(p) > 2048 || !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "*\x00") {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] == '~' {
			if i+1 >= len(p) || p[i+1] != '0' && p[i+1] != '1' {
				return false
			}
			i++
		}
	}
	return true
}
func diffObject(a, b map[string]any, prefix string, out *[]string) {
	keys := map[string]bool{}
	for k := range a {
		keys[k] = true
	}
	for k := range b {
		keys[k] = true
	}
	for k := range keys {
		av, ao := a[k]
		bv, bo := b[k]
		path := prefix + "/" + pointerEscape(k)
		if !ao || !bo {
			*out = append(*out, path)
			continue
		}
		if semanticEqual(av, bv) {
			continue
		}
		am, aok := av.(map[string]any)
		bm, bok := bv.(map[string]any)
		if aok && bok {
			diffObject(am, bm, path, out)
		} else {
			*out = append(*out, path)
		}
	}
}
func semanticEqual(a, b any) bool {
	switch av := a.(type) {
	case json.Number:
		bv, ok := b.(json.Number)
		if !ok {
			return false
		}
		if av == bv {
			return true
		}
		return normalizedNumber(av.String()) == normalizedNumber(bv.String())
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for k, v := range av {
			w, ok := bv[k]
			if !ok || !semanticEqual(v, w) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i, v := range av {
			if !semanticEqual(v, bv[i]) {
				return false
			}
		}
		return true
	default:
		return reflect.DeepEqual(a, b)
	}
}

// Compare numeric values without float rounding or expanding hostile exponents.
// Extremely long tokens retain exact-token equality only, bounding normalization.
func normalizedNumber(s string) string {
	if len(s) > 4096 {
		return "raw:" + s
	}
	sign := ""
	if strings.HasPrefix(s, "-") {
		sign = "-"
		s = s[1:]
	}
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == 'e' || r == 'E' })
	mantissa := parts[0]
	exponent := new(big.Int)
	if len(parts) > 1 {
		if _, ok := exponent.SetString(parts[1], 10); !ok {
			return "raw:" + sign + s
		}
	}
	fraction := 0
	if dot := strings.IndexByte(mantissa, '.'); dot >= 0 {
		fraction = len(mantissa) - dot - 1
		mantissa = mantissa[:dot] + mantissa[dot+1:]
	}
	digits := strings.TrimLeft(mantissa, "0")
	if digits == "" {
		return "0"
	}
	trimmed := strings.TrimRight(digits, "0")
	adjustment := len(digits) - len(trimmed) - fraction
	exponent.Add(exponent, big.NewInt(int64(adjustment)))
	return sign + trimmed + "e" + exponent.String()
}

// Decoder rejects duplicates, trailing values and nesting >100 for manifests too.
func decodeJSON(raw []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var walk func(int) (any, error)
	walk = func(depth int) (any, error) {
		if depth > 100 {
			return nil, fmt.Errorf("JSON nesting exceeds 100")
		}
		token, err := d.Token()
		if err != nil {
			return nil, err
		}
		delim, ok := token.(json.Delim)
		if !ok {
			return token, nil
		}
		switch delim {
		case '{':
			result := map[string]any{}
			for d.More() {
				key, err := d.Token()
				if err != nil {
					return nil, err
				}
				s, ok := key.(string)
				if !ok {
					return nil, fmt.Errorf("invalid JSON key")
				}
				if _, exists := result[s]; exists {
					return nil, fmt.Errorf("duplicate JSON key %q", s)
				}
				v, err := walk(depth + 1)
				if err != nil {
					return nil, err
				}
				result[s] = v
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return nil, fmt.Errorf("invalid JSON object end")
			}
			return result, nil
		case '[':
			result := []any{}
			for d.More() {
				v, err := walk(depth + 1)
				if err != nil {
					return nil, err
				}
				result = append(result, v)
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return nil, fmt.Errorf("invalid JSON array end")
			}
			return result, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter")
		}
	}
	v, err := walk(0)
	if err != nil {
		return nil, err
	}
	if _, err = d.Token(); err != io.EOF {
		return nil, fmt.Errorf("JSON requires exactly one document")
	}
	return v, nil
}
func decodeStrict(raw []byte, out any) error {
	if _, err := decodeJSON(raw); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}

// This preflight is also used in audit mode, where Commit never runs. It only
// reads the explicitly named file: no filename guessing, backup staging, schema
// normalization or write fallback. Exact current bytes are schema-validated by
// catalogstore.Open before any successful audit/apply report is emitted.
func verifyExistingBackup(path, backup, root string, current []byte, revision string, aliases []string) (string, error) {
	resolved, before, err := existingBackupLocation(path, backup, root)
	if err != nil {
		return "", err
	}
	if before.Size() <= 0 || before.Size() > catalogstore.MaxCatalogBytes || before.Size() != int64(len(current)) {
		return "", fmt.Errorf("existing backup must be bounded exact active catalog bytes")
	}
	f, err := os.Open(resolved)
	if err != nil {
		return "", err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) || opened.Size() != before.Size() || !opened.ModTime().Equal(before.ModTime()) {
		return "", fmt.Errorf("existing backup file identity changed during verification")
	}
	for _, alias := range aliases {
		if alias == "" {
			continue
		}
		info, e := os.Stat(alias)
		if errors.Is(e, os.ErrNotExist) {
			continue // previous.json and the optional baseline may not exist
		}
		if e != nil {
			return "", e
		}
		if os.SameFile(opened, info) {
			return "", fmt.Errorf("existing backup must not alias store objects, pointers or candidate/manifest/baseline inputs")
		}
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(len(current))+1))
	if err != nil {
		return "", err
	}
	if !bytes.Equal(raw, current) || catalogstore.Hash(raw) != revision {
		return "", fmt.Errorf("existing backup does not match exact manifest baseline and active catalog bytes")
	}
	finished, err := f.Stat()
	if err != nil {
		return "", err
	}
	resolvedAfter, after, err := existingBackupLocation(path, backup, root)
	if err != nil {
		return "", err
	}
	if resolvedAfter != resolved || !os.SameFile(opened, after) || !os.SameFile(opened, finished) ||
		after.Size() != opened.Size() || finished.Size() != opened.Size() ||
		!after.ModTime().Equal(opened.ModTime()) || !finished.ModTime().Equal(opened.ModTime()) {
		return "", fmt.Errorf("existing backup changed during read-only verification")
	}
	return resolved, nil
}

func existingBackupLocation(path, backup, root string) (string, os.FileInfo, error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", nil, fmt.Errorf("-existingBackupFile must be an explicit absolute already-existing file")
	}
	path = filepath.Clean(path)
	if !sameOrWithin(backup, path) || strings.EqualFold(filepath.Clean(backup), path) || sameOrWithin(root, path) {
		return "", nil, fmt.Errorf("existing backup must be strictly within backupDir and outside storeRoot")
	}
	// Do not erase symlinks by resolving the flag first. Reject every link below
	// the already-resolved backup root, including directory links/junctions.
	for p := filepath.Dir(path); ; p = filepath.Dir(p) {
		info, err := os.Lstat(p)
		if err != nil {
			return "", nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", nil, fmt.Errorf("existing backup must not traverse symbolic links or non-directories")
		}
		if strings.EqualFold(filepath.Clean(backup), p) {
			break
		}
		if parent := filepath.Dir(p); parent == p {
			return "", nil, fmt.Errorf("existing backup escaped backupDir")
		}
	}
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", nil, fmt.Errorf("existing backup must be an independent regular file, not a symbolic link")
	}
	resolved, err := filepath.EvalSymlinks(path) // every component must already exist
	if err != nil {
		return "", nil, err
	}
	if !sameOrWithin(backup, resolved) || strings.EqualFold(filepath.Clean(backup), filepath.Clean(resolved)) || sameOrWithin(root, resolved) {
		return "", nil, fmt.Errorf("resolved existing backup must be strictly within backupDir and outside storeRoot")
	}
	return resolved, info, nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > limit {
		return nil, fmt.Errorf("not a regular bounded file: %s", path)
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("file exceeds size limit")
	}
	return b, nil
}
func resolvedPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent := filepath.Dir(absolute)
	if parent == absolute {
		return "", err
	}
	resolved, err = resolvedPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(absolute)), nil
}
func sameOrWithin(root, target string) bool {
	rel, err := filepath.Rel(strings.ToLower(filepath.Clean(root)), strings.ToLower(filepath.Clean(target)))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Read-only process query, not an app shutdown/control command. No profile paths
// are inferred. Apply fails closed if the Windows probe cannot complete.
func checkAppClosed() error {
	if runtime.GOOS != "windows" {
		return fmt.Errorf("production apply requires Windows process verification; unsupported on this platform")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	script := "$ErrorActionPreference='Stop'; @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -eq '小黑猫 Wiki' -or $_.ProcessName -eq '小黑猫Wiki' }).Count"
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	var stdout, stderr boundedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("cannot verify app closed (no commit): %w", err)
	}
	n, err := strconv.Atoi(strings.TrimSpace(stdout.String()))
	if err != nil || n < 0 {
		return fmt.Errorf("invalid app process query result; commit refused")
	}
	if n != 0 {
		return fmt.Errorf("小黑猫 Wiki is running; close it and wait for all saves before applying")
	}
	return nil
}

type boundedOutput struct{ bytes.Buffer }

func (w *boundedOutput) Write(p []byte) (int, error) {
	if w.Len()+len(p) > 4096 {
		return 0, fmt.Errorf("process query output exceeded limit")
	}
	return w.Buffer.Write(p)
}
