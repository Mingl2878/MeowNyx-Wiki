package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/sourcebaseline"
)

func testCatalog(t *testing.T) *catalog.Catalog {
	t.Helper()
	ext := func() catalog.Extensions {
		return catalog.Extensions{"unrelated": json.RawMessage(`{"large":9007199254740993,"nested":[true,null,"keep"]}`)}
	}
	c := &catalog.Catalog{SchemaVersion: 2,
		Monsters: []catalog.Monster{
			{ID: monsterID, Name: monsterName, TypeIDs: []int{0}, TraitID: traitID,
				Stats:  catalog.Stats{HP: 100, PhyAtk: 100, PhyDef: 100, MagAtk: 100, MagDef: 100, Speed: 100, Extensions: ext()},
				Images: catalog.Images{Extensions: ext()},
				Form:   "default", FormCategory: "无多形态", EvolutionStage: "待定", EvolutionMembers: []int{619},
				DefaultLevel: 99, LevelConfigurable: true, Placeholder: true, DataNote: oldNote, Extensions: ext()},
			{ID: 5, Name: "保留猫", DexNumber: 1, TypeIDs: []int{1}, TraitID: "other-trait",
				Stats: catalog.Stats{HP: 9, PhyAtk: 8, PhyDef: 7, MagAtk: 6, MagDef: 5, Speed: 4},
				Form:  "default", FormCategory: "无多形态", EvolutionStage: "基础形态", EvolutionMembers: []int{5},
				SourceRef: &catalog.SourceRef{Provider: catalogrecovery.Provider, ID: "10", Identity: "NO.001|保留猫|", Extensions: ext()}, Extensions: ext()},
		},
		Skills: []catalog.Skill{{ID: 1, Name: "保留技能", Description: "保留说明", TypeID: 1, Category: "Physical Attack", Extensions: ext()}},
		Types: []catalog.Type{
			{ID: 0, Name: "无", Code: "None", VulnerableTo: []int{}, ResistantTo: []int{}, RuntimeOnly: true, Extensions: ext()},
			{ID: 1, Name: "普通", Code: "Normal", VulnerableTo: []int{}, ResistantTo: []int{}, Extensions: ext()},
		},
		Traits: []catalog.Trait{{ID: traitID, Name: traitName, Description: oldDescription, Extensions: ext()}, {ID: "other-trait", Name: "保留特性", Description: "保留说明", Extensions: ext()}},
		Learnsets: []catalog.Learnset{
			{MonsterID: 619, Mode: "own", Skills: []catalog.LearnedSkill{}, Extensions: ext()},
			{MonsterID: 5, Mode: "own", Skills: []catalog.LearnedSkill{{SkillID: 1, Source: "本地", Extensions: ext()}}, Extensions: ext()},
		},
		SkillRules: []catalog.SkillRule{{SkillID: 1, PowerFormula: "20+20", Extensions: ext()}},
		Extensions: ext(),
	}
	b := sourcebaseline.New(strings.Repeat("a", 64))
	observation := sourcebaseline.Observation{Entry: sourcebaseline.Entry{Entity: "monster", Identity: "NO.001|保留猫|", Field: "stats.hp", Value: json.RawMessage(`{"available":true,"value":120}`)}}
	b.Put(observation)
	baseline, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	c.Extensions[sourcebaseline.Extension] = baseline
	c.Extensions["catalog_choices"] = json.RawMessage(`{"version":1,"entries":{"arbitrary-user-policy":{"choice":"local"}}}`)
	c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":1,"entries":[{"local_id":408,"provider":"tencent-compendium","source_id":"9999","identity":"NO.123|保留身份|"}]}`)
	return c
}

func marshalTest(t *testing.T, c *catalog.Catalog) []byte {
	t.Helper()
	b, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func put(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}

func readTest(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func assertBytes(t *testing.T, path string, expected []byte) {
	t.Helper()
	if !bytes.Equal(readTest(t, path), expected) {
		t.Fatalf("unexpected write to %s", path)
	}
}

// Independent semantic comparison reverses exactly the eight approved leaves;
// the complete raw JSON tree (not merely record counts) must then be identical.
func assertOnlyPatch(t *testing.T, before, after []byte) {
	t.Helper()
	a, err := jsonValue(before)
	if err != nil {
		t.Fatal(err)
	}
	b, err := jsonValue(after)
	if err != nil {
		t.Fatal(err)
	}
	oldRoot, newRoot := a.(map[string]any), b.(map[string]any)
	var oldMonster, newMonster, oldTrait, newTrait map[string]any
	for _, item := range oldRoot["monsters"].([]any) {
		m := item.(map[string]any)
		if m["id"] == json.Number("619") {
			oldMonster = m
		}
	}
	for _, item := range newRoot["monsters"].([]any) {
		m := item.(map[string]any)
		if m["id"] == json.Number("619") {
			newMonster = m
		}
	}
	for _, item := range oldRoot["traits"].([]any) {
		tr := item.(map[string]any)
		if tr["id"] == traitID {
			oldTrait = tr
		}
	}
	for _, item := range newRoot["traits"].([]any) {
		tr := item.(map[string]any)
		if tr["id"] == traitID {
			newTrait = tr
		}
	}
	values := map[string]json.Number{"hp": "118", "phy_atk": "128", "phy_def": "81", "mag_atk": "42", "mag_def": "63", "speed": "70"}
	for key, want := range values {
		if newMonster["stats"].(map[string]any)[key] != want {
			t.Fatalf("incorrect %s", key)
		}
		newMonster["stats"].(map[string]any)[key] = oldMonster["stats"].(map[string]any)[key]
	}
	if newMonster["data_note"] != newNote || newTrait["description"] != newDescription {
		t.Fatal("incorrect text patch")
	}
	newMonster["data_note"] = oldMonster["data_note"]
	newTrait["description"] = oldTrait["description"]
	if !reflect.DeepEqual(a, b) {
		t.Fatal("patch changed a nonapproved JSON field")
	}
	if err := validateCatalog(after); err != nil {
		t.Fatal(err)
	}
}

func TestPatchExactDiffAndIdempotence(t *testing.T) {
	for state := 0; state < 8; state++ {
		t.Run(string(rune('0'+state)), func(t *testing.T) {
			c := testCatalog(t)
			if state&1 != 0 {
				s := &c.Monsters[0].Stats
				s.HP, s.PhyAtk, s.PhyDef, s.MagAtk, s.MagDef, s.Speed = 118, 128, 81, 42, 63, 70
			}
			if state&2 != 0 {
				c.Monsters[0].DataNote = newNote
			}
			if state&4 != 0 {
				c.Traits[0].Description = newDescription
			}
			original := marshalTest(t, c)
			untouched := bytes.Clone(original)
			candidate, changes, err := patch(original)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(original, untouched) {
				t.Fatal("mutated input bytes")
			}
			assertOnlyPatch(t, original, candidate)
			if (len(changes) == 0) != (state == 7) {
				t.Fatal("wrong change report")
			}
			// Exact-byte no-op includes noncanonical whitespace.
			candidate = append(candidate, '\n')
			again, changes, err := patch(candidate)
			if err != nil || len(changes) != 0 || !bytes.Equal(candidate, again) {
				t.Fatal("not idempotent", err)
			}
		})
	}
}

func TestPatchRefusesConflicts(t *testing.T) {
	cases := map[string]func(*catalog.Catalog){
		"missing target": func(c *catalog.Catalog) { c.Monsters = c.Monsters[1:]; c.Learnsets = c.Learnsets[1:] },
		"wrong name":     func(c *catalog.Catalog) { c.Monsters[0].Name = "本地名字" },
		"wrong stable id": func(c *catalog.Catalog) {
			c.Monsters[0].ID = 620
			c.Monsters[0].EvolutionMembers = []int{620}
			c.Learnsets[0].MonsterID = 620
		},
		"wrong trait":       func(c *catalog.Catalog) { c.Monsters[0].TraitID = "other-trait" },
		"shared trait":      func(c *catalog.Catalog) { c.Monsters[1].TraitID = traitID },
		"missing trait":     func(c *catalog.Catalog) { c.Traits = c.Traits[1:] },
		"renamed trait":     func(c *catalog.Catalog) { c.Traits[0].Name = "用户名称" },
		"local description": func(c *catalog.Catalog) { c.Traits[0].Description = "用户说明" },
		"local note":        func(c *catalog.Catalog) { c.Monsters[0].DataNote = "用户备注" },
		"changed stats":     func(c *catalog.Catalog) { c.Monsters[0].Stats.Speed = 101 },
		"mixed stats":       func(c *catalog.Catalog) { c.Monsters[0].Stats.HP = 118 },
		"not placeholder":   func(c *catalog.Catalog) { c.Monsters[0].Placeholder = false },
		"changed attribute": func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{1} },
		"changed stage":     func(c *catalog.Catalog) { c.Monsters[0].EvolutionStage = "基础形态" },
		"changed level":     func(c *catalog.Catalog) { c.Monsters[0].DefaultLevel = 60 },
		"nonconfigurable":   func(c *catalog.Catalog) { c.Monsters[0].LevelConfigurable = false },
		"learning modified": func(c *catalog.Catalog) {
			c.Learnsets[0].Skills = []catalog.LearnedSkill{{SkillID: 1, Source: "本地"}}
		},
		"learning inherited": func(c *catalog.Catalog) { c.Learnsets[0].Mode = "inherit"; c.Learnsets[0].FromID = 5 },
		"future baseline":    func(c *catalog.Catalog) { c.Extensions[sourcebaseline.Extension] = json.RawMessage(`{"version":999}`) },
		"invalid reservation": func(c *catalog.Catalog) {
			c.Extensions[catalogrecovery.Extension] = json.RawMessage(`{"version":99,"entries":[]}`)
		},
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			c := testCatalog(t)
			modify(c)
			// json.Marshal deliberately permits malformed catalog fixtures.
			raw, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			before := bytes.Clone(raw)
			if _, _, err = patch(raw); err == nil {
				t.Fatal("accepted conflict")
			}
			if !bytes.Equal(raw, before) {
				t.Fatal("mutated rejected input")
			}
		})
	}
}

func TestRefusesNonapprovedNormalization(t *testing.T) {
	raw := marshalTest(t, testCatalog(t))
	// An unknown schema-level field would otherwise move into extensions.
	unknown := append([]byte(`{"unmodeled":true,`), raw[1:]...)
	if _, _, err := patch(unknown); err == nil || !strings.Contains(err.Error(), "nonapproved") {
		t.Fatal(err)
	}
	v1 := bytes.Replace(raw, []byte(`"schema_version":2`), []byte(`"schema_version":1`), 1)
	if _, _, err := patch(v1); err == nil {
		t.Fatal("silently migrated v1")
	}
}

func TestAuditAndNewCandidateOnly(t *testing.T) {
	root := t.TempDir()
	input, output := filepath.Join(root, "input", "catalog.json"), filepath.Join(root, "candidate.json")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	var report bytes.Buffer
	if err := run([]string{"-catalog", input}, &report); err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(report.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["current_revision"] != catalogstore.Hash(original) || fields["committed_revision"] != "" || len(fields["changes"].([]any)) != 8 {
		t.Fatal("bad audit report")
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("audit wrote output")
	}
	for _, path := range []string{input, output} {
		err := run([]string{"-catalog", input, "-out", path}, ioBuffer())
		if (path == input) != (err != nil) {
			t.Fatal("bad new-output handling", err)
		}
	}
	if err := run([]string{"-catalog", input, "-out", output}, ioBuffer()); err == nil {
		t.Fatal("overwrote candidate")
	}
	assertBytes(t, input, original)
	assertOnlyPatch(t, original, readTest(t, output))
}

func ioBuffer() *bytes.Buffer { return new(bytes.Buffer) }

func TestFlagsRefuseImplicitOrIncompatibleWrites(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "input", "catalog.json")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	base := []string{"-catalog", input}
	for _, extra := range [][]string{
		{"-write-catalog"}, {"-commit-local"}, {"-app-closed"}, {"-backup-dir", root},
		{"-write-catalog", "-commit-local"}, {"-write-catalog", "-out", filepath.Join(root, "out.json")},
		{"-commit-local", "-out", filepath.Join(root, "out.json")}, {"-write-catalog", "-store-root", root},
		{"-store-root", "relative", "-backup-dir", root}, {"-store-root", root},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", "relative"},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", filepath.Join(root, "input", "backups")},
		{"unexpected-argument"},
	} {
		if err := run(append(append([]string{}, base...), extra...), ioBuffer()); err == nil {
			t.Fatalf("accepted %v", extra)
		}
	}
	if err := run(nil, ioBuffer()); err == nil {
		t.Fatal("accepted missing explicit input")
	}
	assertBytes(t, input, original)
}

func TestFactoryReplacementBackupAndStaleRefusal(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "project", "data", "catalog.json")
	backup := filepath.Join(root, "backups")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	args := []string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}
	if err := run(args, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	candidate := readTest(t, input)
	assertOnlyPatch(t, original, candidate)
	assertBytes(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), original)
	if err := run(args, ioBuffer()); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale revision", err)
	}
	assertBytes(t, input, candidate)
	args[4] = catalogstore.Hash(candidate)
	if err := run(args, ioBuffer()); err != nil {
		t.Fatal("idempotent write failed", err)
	}
	assertBytes(t, input, candidate)
	files, err := os.ReadDir(backup)
	if err != nil || len(files) != 1 {
		t.Fatal("no-op created unnecessary backup", err)
	}
	// This catches a change between audit and the replacement helper itself.
	if err := replaceCatalog(input, backup, original, candidate, catalogstore.Hash(original)); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal(err)
	}
}

func TestFactoryBackupFailureNeverWrites(t *testing.T) {
	for _, mode := range []string{"blocked-directory", "corrupt-existing-backup", "internal-project"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "project", "data", "catalog.json")
			backup := filepath.Join(root, "backups")
			original := marshalTest(t, testCatalog(t))
			put(t, input, original)
			switch mode {
			case "blocked-directory":
				put(t, backup, []byte("not a directory"))
			case "corrupt-existing-backup":
				put(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), []byte("wrong backup"))
			case "internal-project":
				backup = filepath.Join(root, "project", "backups")
			}
			if err := run([]string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}, ioBuffer()); err == nil {
				t.Fatal("accepted unsafe backup")
			}
			assertBytes(t, input, original)
		})
	}
}

func initializeStore(t *testing.T, root, backup string, raw []byte) *catalogstore.Store {
	t.Helper()
	s, err := catalogstore.Open(catalogstore.Options{Root: root, BackupDir: backup, Baseline: raw, Validate: validateCatalog, Replace: catalogstore.ReplaceFile})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Commit(raw, catalogstore.Hash(raw), nil); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStoreCurrentCommitPreservesAllOtherFiles(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "factory", "catalog.json")
	storeRoot := filepath.Join(root, "store")
	backup := filepath.Join(root, "backups")
	factory := marshalTest(t, testCatalog(t))
	put(t, input, factory)
	local := testCatalog(t)
	local.Monsters[1].Stats.Speed = 222
	local.Extensions["local-only"] = json.RawMessage(`{"preserve":true}`)
	original := marshalTest(t, local)
	initializeStore(t, storeRoot, backup, original)
	pointer := readTest(t, filepath.Join(storeRoot, "current.json"))
	put(t, filepath.Join(storeRoot, "images", "keep.png"), []byte("untouched image"))
	put(t, filepath.Join(root, "user-config.json"), []byte("untouched personal data"))
	args := []string{"-catalog", input, "-store-root", storeRoot, "-backup-dir", backup}
	var audit bytes.Buffer
	if err := run(args, &audit); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(audit.String(), catalogstore.Hash(original)) {
		t.Fatal("audited baseline, not actual store")
	}
	assertBytes(t, filepath.Join(storeRoot, "current.json"), pointer)
	if err := run(append(args, "-out", filepath.Join(storeRoot, "candidate.json")), ioBuffer()); err == nil {
		t.Fatal("allowed output inside store")
	}
	commit := append(append([]string{}, args...), "-commit-local", "-app-closed", "-expected-revision", catalogstore.Hash(original))
	if err := run(commit, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	s, err := openCurrentStore(storeRoot, backup, factory)
	if err != nil {
		t.Fatal(err)
	}
	candidate := s.Current().Data
	assertOnlyPatch(t, original, candidate)
	assertBytes(t, filepath.Join(backup, catalogstore.Hash(original)+".json"), original)
	assertBytes(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), original)
	assertBytes(t, input, factory)
	assertBytes(t, filepath.Join(storeRoot, "images", "keep.png"), []byte("untouched image"))
	assertBytes(t, filepath.Join(root, "user-config.json"), []byte("untouched personal data"))
	if err := run(commit, ioBuffer()); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("accepted stale local revision", err)
	}
	currentPointer := readTest(t, filepath.Join(storeRoot, "current.json"))
	commit[len(commit)-1] = catalogstore.Hash(candidate)
	if err := run(commit, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, filepath.Join(storeRoot, "current.json"), currentPointer)
}

func TestStoreRefusesMissingRecoveryWrongTargetAndBackupFailure(t *testing.T) {
	for _, mode := range []string{"missing", "recovery", "future-pointer", "bad-hash", "wrong-target", "backup-failure", "stale"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			input := filepath.Join(root, "factory", "catalog.json")
			storeRoot := filepath.Join(root, "store")
			backup := filepath.Join(root, "backups")
			factory := marshalTest(t, testCatalog(t))
			put(t, input, factory)
			local := testCatalog(t)
			if mode == "wrong-target" {
				local.Monsters[0].Name = "用户自己的619"
				local.Monsters[0].Placeholder = false
			}
			original := marshalTest(t, local)
			if mode != "missing" {
				initializeStore(t, storeRoot, filepath.Join(root, "setup-backups"), original)
			}
			pointerPath := filepath.Join(storeRoot, "current.json")
			switch mode {
			case "recovery":
				put(t, pointerPath, []byte(`{"version":1,"revision":"bad"}`))
			case "future-pointer":
				put(t, pointerPath, []byte(`{"version":99,"revision":"`+catalogstore.Hash(original)+`"}`))
			case "bad-hash":
				put(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), []byte("corrupted version"))
			case "backup-failure":
				put(t, backup, []byte("blocked"))
			}
			var before []byte
			if mode != "missing" {
				before = readTest(t, pointerPath)
			}
			expected := catalogstore.Hash(original)
			if mode == "stale" {
				expected = strings.Repeat("0", 64)
			}
			args := []string{"-catalog", input, "-store-root", storeRoot, "-backup-dir", backup, "-commit-local", "-app-closed", "-expected-revision", expected}
			if err := run(args, ioBuffer()); err == nil {
				t.Fatal("accepted invalid store operation")
			}
			if mode == "missing" {
				if _, err := os.Stat(storeRoot); !os.IsNotExist(err) {
					t.Fatal("bootstrapped missing store")
				}
			} else {
				assertBytes(t, pointerPath, before)
			}
			assertBytes(t, input, factory)
		})
	}
}

func TestFactoryBackupSymlinkIsNotIndependent(t *testing.T) {
	root := t.TempDir()
	input, backup := filepath.Join(root, "input", "catalog.json"), filepath.Join(root, "backup")
	original := marshalTest(t, testCatalog(t))
	put(t, input, original)
	if err := os.MkdirAll(backup, 0700); err != nil {
		t.Fatal(err)
	}
	backupFile := filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json")
	if err := os.Symlink(input, backupFile); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := run([]string{"-catalog", input, "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup}, ioBuffer()); err == nil {
		t.Fatal("symlink accepted as independent backup")
	}
	assertBytes(t, input, original)
}

func TestStoreCommitDetectsPointerChangedAfterOpen(t *testing.T) {
	root := t.TempDir()
	storeRoot, backup := filepath.Join(root, "store"), filepath.Join(root, "backups")
	original := marshalTest(t, testCatalog(t))
	store := initializeStore(t, storeRoot, backup, original)
	candidate, _, err := patch(original)
	if err != nil {
		t.Fatal(err)
	}
	pointerPath := filepath.Join(storeRoot, "current.json")
	changed := append(readTest(t, pointerPath), '\n')
	put(t, pointerPath, changed)
	if _, err = store.Commit(candidate, catalogstore.Hash(original), nil); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale pointer accepted", err)
	}
	assertBytes(t, pointerPath, changed)
	if _, err = os.Stat(filepath.Join(storeRoot, "versions", catalogstore.Hash(candidate)+".json")); !os.IsNotExist(err) {
		t.Fatal("stale commit staged candidate")
	}
}

func TestFactorySchemaThroughTempCopy(t *testing.T) {
	// Synthetic canonical data only: tests never inspect or patch the real tree.
	original := marshalTest(t, testCatalog(t))
	root := t.TempDir()
	input := filepath.Join(root, "project", "data", "catalog.json")
	output := filepath.Join(root, "candidate.json")
	put(t, input, original)
	if err := run([]string{"-catalog", input, "-out", output}, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	assertOnlyPatch(t, original, readTest(t, output))
	assertBytes(t, input, original)
}
