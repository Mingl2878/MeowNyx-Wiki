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
	"xhmwiki/internal/catalogstore"
)

func dragonGhostFixture(t *testing.T) *catalog.Catalog {
	t.Helper()
	c := testCatalog(t)
	c.Types = append(c.Types,
		catalog.Type{ID: 8, Name: "龙", Code: "Dragon", VulnerableTo: []int{}, ResistantTo: []int{}},
		catalog.Type{ID: 15, Name: "幽", Code: "Ghost", VulnerableTo: []int{}, ResistantTo: []int{}})
	s := &c.Monsters[0].Stats
	s.HP, s.PhyAtk, s.PhyDef, s.MagAtk, s.MagDef, s.Speed = 118, 128, 81, 42, 63, 70
	c.Monsters[0].DataNote = newNote
	c.Traits[0].Description = newDescription
	return c
}

// Reverse precisely the two approved fields and compare every other JSON value,
// including stats, trait, source refs, extensions, unrelated records and order.
func assertOnlyDragonGhost(t *testing.T, before, after []byte) {
	t.Helper()
	a, err := jsonValue(before)
	if err != nil {
		t.Fatal(err)
	}
	b, err := jsonValue(after)
	if err != nil {
		t.Fatal(err)
	}
	find := func(root any) map[string]any {
		for _, item := range root.(map[string]any)["monsters"].([]any) {
			m := item.(map[string]any)
			if m["id"] == json.Number("619") {
				return m
			}
		}
		t.Fatal("missing 619")
		return nil
	}
	oldMonster, newMonster := find(a), find(b)
	if !reflect.DeepEqual(newMonster["type_ids"], []any{json.Number("8"), json.Number("15")}) || newMonster["data_note"] != dragonGhostNote {
		t.Fatal("wrong main/secondary types or note")
	}
	newMonster["type_ids"], newMonster["data_note"] = oldMonster["type_ids"], oldMonster["data_note"]
	if !reflect.DeepEqual(a, b) {
		t.Fatal("type patch changed nonapproved JSON fields")
	}
	if err := validateCatalog(after); err != nil {
		t.Fatal(err)
	}
}

func TestDragonGhostPatchExactDiffAndIdempotence(t *testing.T) {
	c := dragonGhostFixture(t)
	// Preserving supplied source refs is not inventing new provenance.
	c.Monsters[0].SourceRef = &catalog.SourceRef{Provider: "fixture", ID: "619", Identity: monsterName}
	c.Traits[0].SourceRef = &catalog.SourceRef{Provider: "fixture", ID: traitID, Identity: traitName}
	original := marshalTest(t, c)
	untouched := bytes.Clone(original)
	candidate, changes, err := patchForMode(original, dragonGhostMode)
	if err != nil {
		t.Fatal(err)
	}
	want := []change{
		{"monsters[id=619].type_ids", []int{0}, []int{8, 15}},
		{"monsters[id=619].data_note", newNote, dragonGhostNote},
	}
	if !reflect.DeepEqual(changes, want) || !bytes.Equal(original, untouched) {
		t.Fatal("incorrect diff report or input mutation", changes)
	}
	assertOnlyDragonGhost(t, original, candidate)
	candidate = append(candidate, '\n')
	again, changes, err := patchForMode(candidate, dragonGhostMode)
	if err != nil || len(changes) != 0 || !bytes.Equal(again, candidate) {
		t.Fatal("not exact-byte idempotent", err)
	}
	if _, _, err = patch(candidate); err == nil || !strings.Contains(err.Error(), "-dragon-ghost") {
		t.Fatal("original patch must actionable-refuse approved dual types", err)
	}
}

func TestDragonGhostFindsStableIDsAfterReordering(t *testing.T) {
	c := dragonGhostFixture(t)
	c.Monsters[0], c.Monsters[1] = c.Monsters[1], c.Monsters[0]
	c.Traits[0], c.Traits[1] = c.Traits[1], c.Traits[0]
	c.Types[2], c.Types[3] = c.Types[3], c.Types[2]
	original := marshalTest(t, c)
	candidate, changes, err := patchForMode(original, dragonGhostMode)
	if err != nil || len(changes) != 2 {
		t.Fatal("stable ID lookup/diff failed", err)
	}
	assertOnlyDragonGhost(t, original, candidate)
}

func TestDragonGhostPatchRefusesConflicts(t *testing.T) {
	cases := map[string]func(*catalog.Catalog){
		"old stats": func(c *catalog.Catalog) {
			s := &c.Monsters[0].Stats
			s.HP, s.PhyAtk, s.PhyDef, s.MagAtk, s.MagDef, s.Speed = 100, 100, 100, 100, 100, 100
		},
		"mixed stats":          func(c *catalog.Catalog) { c.Monsters[0].Stats.HP = 100 },
		"arbitrary stats":      func(c *catalog.Catalog) { c.Monsters[0].Stats.Speed = 71 },
		"old description":      func(c *catalog.Catalog) { c.Traits[0].Description = oldDescription },
		"custom description":   func(c *catalog.Catalog) { c.Traits[0].Description = "用户效果" },
		"old note":             func(c *catalog.Catalog) { c.Monsters[0].DataNote = oldNote },
		"custom note":          func(c *catalog.Catalog) { c.Monsters[0].DataNote = "用户备注" },
		"new note with None":   func(c *catalog.Catalog) { c.Monsters[0].DataNote = dragonGhostNote },
		"old note with dual":   func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{8, 15} },
		"reversed types":       func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{15, 8} },
		"only Dragon":          func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{8} },
		"only Ghost":           func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{15} },
		"other pair":           func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{8, 1} },
		"missing Dragon":       func(c *catalog.Catalog) { c.Types = append(c.Types[:2], c.Types[3:]...) },
		"missing Ghost":        func(c *catalog.Catalog) { c.Types = c.Types[:3] },
		"wrong Dragon code":    func(c *catalog.Catalog) { c.Types[2].Code = "NotDragon" },
		"wrong Ghost code":     func(c *catalog.Catalog) { c.Types[3].Code = "NotGhost" },
		"swapped codes":        func(c *catalog.Catalog) { c.Types[2].Code, c.Types[3].Code = "Ghost", "Dragon" },
		"missing target":       func(c *catalog.Catalog) { c.Monsters = c.Monsters[1:]; c.Learnsets = c.Learnsets[1:] },
		"wrong name":           func(c *catalog.Catalog) { c.Monsters[0].Name = "本地名字" },
		"wrong trait":          func(c *catalog.Catalog) { c.Monsters[0].TraitID = "other-trait" },
		"shared trait":         func(c *catalog.Catalog) { c.Monsters[1].TraitID = traitID },
		"renamed trait":        func(c *catalog.Catalog) { c.Traits[0].Name = "用户名称" },
		"not placeholder":      func(c *catalog.Catalog) { c.Monsters[0].Placeholder = false },
		"changed stage":        func(c *catalog.Catalog) { c.Monsters[0].EvolutionStage = "基础形态" },
		"changed level":        func(c *catalog.Catalog) { c.Monsters[0].DefaultLevel = 60 },
		"nonconfigurable":      func(c *catalog.Catalog) { c.Monsters[0].LevelConfigurable = false },
		"avatar":               func(c *catalog.Catalog) { c.Monsters[0].Images.Avatar = "local.png" },
		"portrait":             func(c *catalog.Catalog) { c.Monsters[0].Images.Portrait = "local.png" },
		"learning inherited":   func(c *catalog.Catalog) { c.Learnsets[0].Mode = "inherit"; c.Learnsets[0].FromID = 5 },
		"missing own learning": func(c *catalog.Catalog) { c.Learnsets = c.Learnsets[1:] },
		"learning modified": func(c *catalog.Catalog) {
			c.Learnsets[0].Skills = []catalog.LearnedSkill{{SkillID: 1, Source: "本地"}}
		},
		"wrong stable id": func(c *catalog.Catalog) {
			c.Monsters[0].ID = 620
			c.Monsters[0].EvolutionMembers = []int{620}
			c.Learnsets[0].MonsterID = 620
		},
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			c := dragonGhostFixture(t)
			modify(c)
			raw, err := json.Marshal(c) // Deliberately permits invalid fixtures.
			if err != nil {
				t.Fatal(err)
			}
			before := bytes.Clone(raw)
			if _, _, err = patchForMode(raw, dragonGhostMode); err == nil {
				t.Fatal("accepted conflict")
			}
			if !bytes.Equal(raw, before) {
				t.Fatal("mutated rejected input")
			}
		})
	}
}

func TestPatchModeDiffAllowlists(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*catalog.Catalog)
		stats  bool
		types  bool
	}{
		{"types", func(c *catalog.Catalog) { c.Monsters[0].TypeIDs = []int{8, 15} }, false, true},
		{"note", func(c *catalog.Catalog) { c.Monsters[0].DataNote = dragonGhostNote }, true, true},
		{"stats", func(c *catalog.Catalog) { c.Monsters[0].Stats.Speed++ }, true, false},
		{"description", func(c *catalog.Catalog) { c.Traits[0].Description = oldDescription }, true, false},
		{"name", func(c *catalog.Catalog) { c.Monsters[0].Name = "另一只" }, false, false},
		{"other monster", func(c *catalog.Catalog) { c.Monsters[1].Stats.Speed++ }, false, false},
		{"trait name", func(c *catalog.Catalog) { c.Traits[0].Name = "新名称" }, false, false},
		{"placeholder", func(c *catalog.Catalog) { c.Monsters[0].Placeholder = false }, false, false},
		{"source ref", func(c *catalog.Catalog) {
			c.Monsters[0].SourceRef = &catalog.SourceRef{Provider: "fixture", ID: "619", Identity: monsterName}
		}, false, false},
		{"stat extension", func(c *catalog.Catalog) { c.Monsters[0].Stats.Extensions["unrelated"] = json.RawMessage(`false`) }, false, false},
		{"root extension", func(c *catalog.Catalog) { c.Extensions["unrelated"] = json.RawMessage(`false`) }, false, false},
		{"schema", func(c *catalog.Catalog) { c.SchemaVersion = 1 }, false, false},
	}
	before := marshalTest(t, dragonGhostFixture(t))
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := dragonGhostFixture(t)
			tc.modify(c)
			after, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			for _, mode := range []patchMode{statsMode, dragonGhostMode} {
				want := tc.stats
				if mode == dragonGhostMode {
					want = tc.types
				}
				if err := approvedDiffOnly(before, after, 0, 0, mode); (err == nil) != want {
					t.Fatalf("%s diff accepted=%v: %v", mode, want, err)
				}
			}
		})
	}
	if _, _, err := patchForMode(before, "unknown"); err == nil {
		t.Fatal("unknown patch mode accepted")
	}
	if err := approvedDiffOnly(before, before, 0, 0, "unknown"); err == nil {
		t.Fatal("unknown diff mode accepted")
	}
}

func TestDragonGhostRefusesNonapprovedNormalization(t *testing.T) {
	for _, applied := range []bool{false, true} {
		c := dragonGhostFixture(t)
		if applied {
			c.Monsters[0].TypeIDs, c.Monsters[0].DataNote = []int{8, 15}, dragonGhostNote
		}
		raw := marshalTest(t, c)
		unknown := append([]byte(`{"unmodeled":true,`), raw[1:]...)
		if _, _, err := patchForMode(unknown, dragonGhostMode); err == nil || !strings.Contains(err.Error(), "nonapproved") {
			t.Fatal("silently normalized unrelated fields", err)
		}
		v1 := bytes.Replace(raw, []byte(`"schema_version":2`), []byte(`"schema_version":1`), 1)
		if _, _, err := patchForMode(v1, dragonGhostMode); err == nil {
			t.Fatal("silently migrated v1")
		}
	}
}

func TestDragonGhostFactoryAuditCandidateCommitAndNoop(t *testing.T) {
	root := t.TempDir()
	input, output, backup := filepath.Join(root, "project", "data", "catalog.json"), filepath.Join(root, "candidate.json"), filepath.Join(root, "backups")
	original := marshalTest(t, dragonGhostFixture(t))
	put(t, input, original)
	base := []string{"-dragon-ghost", "-catalog", input}
	var report bytes.Buffer
	if err := run(base, &report); err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(report.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	if fields["mode"] != "dragon-ghost" || fields["current_revision"] != catalogstore.Hash(original) || fields["committed_revision"] != "" || len(fields["changes"].([]any)) != 2 {
		t.Fatal("incorrect audit", fields)
	}
	assertBytes(t, input, original)
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 1 {
		t.Fatal("audit created files/directories", err)
	}
	if err := run(append(append([]string{}, base...), "-out", output), ioBuffer()); err != nil {
		t.Fatal(err)
	}
	assertOnlyDragonGhost(t, original, readTest(t, output))
	assertBytes(t, input, original)
	for _, path := range []string{input, output} {
		if err := run(append(append([]string{}, base...), "-out", path), ioBuffer()); err == nil {
			t.Fatal("overwrote candidate/input")
		}
	}
	args := append(append([]string{}, base...), "-write-catalog", "-backup-dir", backup, "-expected-revision", catalogstore.Hash(original))
	if err := run(args, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	candidate := readTest(t, input)
	assertOnlyDragonGhost(t, original, candidate)
	assertBytes(t, filepath.Join(backup, "catalog-"+catalogstore.Hash(original)+".json"), original)
	if err := run(args, ioBuffer()); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale revision accepted", err)
	}
	args[len(args)-1] = catalogstore.Hash(candidate)
	if err := run(args, ioBuffer()); err != nil {
		t.Fatal("no-op write failed", err)
	}
	assertBytes(t, input, candidate)
	if entries, err := os.ReadDir(backup); err != nil || len(entries) != 1 {
		t.Fatal("no-op wrote backup", err)
	}
	// The old command cannot revert the approved dual types or the new note.
	if err := run(args[1:], ioBuffer()); err == nil || !strings.Contains(err.Error(), "-dragon-ghost") {
		t.Fatal("old mode did not refuse safely", err)
	}
	assertBytes(t, input, candidate)
}

func TestDragonGhostFlagsAndBackupFailuresNeverWrite(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "project", "data", "catalog.json")
	backup := filepath.Join(root, "backup")
	original := marshalTest(t, dragonGhostFixture(t))
	put(t, input, original)
	base := []string{"-dragon-ghost", "-catalog", input}
	for _, extra := range [][]string{
		{"-write-catalog"}, {"-commit-local"}, {"-app-closed"}, {"-backup-dir", backup},
		{"-write-catalog", "-commit-local"}, {"-write-catalog", "-out", filepath.Join(root, "out.json")},
		{"-commit-local", "-out", filepath.Join(root, "out.json")}, {"-write-catalog", "-store-root", root},
		{"-store-root", "relative", "-backup-dir", backup}, {"-store-root", root},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", "relative"},
		{"-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", filepath.Join(root, "project", "backups")},
		{"-write-catalog", "-expected-revision", strings.Repeat("0", 64), "-backup-dir", backup},
		{"unexpected-argument"},
	} {
		if err := run(append(append([]string{}, base...), extra...), ioBuffer()); err == nil {
			t.Fatalf("accepted unsafe flags %v", extra)
		}
		assertBytes(t, input, original)
	}
	if err := run([]string{"-dragon-ghost"}, ioBuffer()); err == nil {
		t.Fatal("implicit input accepted")
	}
	put(t, backup, []byte("blocked directory"))
	if err := run(append(append([]string{}, base...), "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", backup), ioBuffer()); err == nil {
		t.Fatal("wrote despite backup failure")
	}
	assertBytes(t, input, original)
	corruptBackup := filepath.Join(root, "corrupt-backup")
	put(t, filepath.Join(corruptBackup, "catalog-"+catalogstore.Hash(original)+".json"), []byte("not original"))
	if err := run(append(append([]string{}, base...), "-write-catalog", "-expected-revision", catalogstore.Hash(original), "-backup-dir", corruptBackup), ioBuffer()); err == nil {
		t.Fatal("wrote despite corrupt existing backup")
	}
	assertBytes(t, input, original)
}

func TestDragonGhostStoreCommitPreservesEverythingElse(t *testing.T) {
	root := t.TempDir()
	input, storeRoot, backup := filepath.Join(root, "factory", "catalog.json"), filepath.Join(root, "store"), filepath.Join(root, "backups")
	factory := marshalTest(t, dragonGhostFixture(t))
	put(t, input, factory)
	local := dragonGhostFixture(t)
	local.Monsters[1].Stats.Speed = 222
	local.Extensions["local-only"] = json.RawMessage(`{"keep":true}`)
	original := marshalTest(t, local)
	initializeStore(t, storeRoot, backup, original)
	pointerPath := filepath.Join(storeRoot, "current.json")
	pointer := readTest(t, pointerPath)
	personal := filepath.Join(root, "user-config.json")
	image := filepath.Join(storeRoot, "images", "keep.png")
	put(t, personal, []byte("untouched personal data"))
	put(t, image, []byte("untouched image"))
	base := []string{"-dragon-ghost", "-catalog", input, "-store-root", storeRoot, "-backup-dir", backup}
	var report bytes.Buffer
	if err := run(base, &report); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(report.String(), catalogstore.Hash(original)) {
		t.Fatal("audited factory instead of actual store")
	}
	assertBytes(t, pointerPath, pointer)
	for _, output := range []string{filepath.Join(storeRoot, "candidate.json"), filepath.Join(backup, "candidate.json")} {
		if err := run(append(append([]string{}, base...), "-out", output), ioBuffer()); err == nil {
			t.Fatal("candidate inside protected directory accepted")
		}
	}
	commit := append(append([]string{}, base...), "-commit-local", "-app-closed", "-expected-revision", catalogstore.Hash(original))
	if err := run(commit, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	store, err := openCurrentStore(storeRoot, backup, factory)
	if err != nil {
		t.Fatal(err)
	}
	candidate := store.Current().Data
	assertOnlyDragonGhost(t, original, candidate)
	assertBytes(t, filepath.Join(backup, catalogstore.Hash(original)+".json"), original)
	assertBytes(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), original)
	assertBytes(t, input, factory)
	assertBytes(t, personal, []byte("untouched personal data"))
	assertBytes(t, image, []byte("untouched image"))
	if err := run(commit, ioBuffer()); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale local revision accepted", err)
	}
	currentPointer := readTest(t, pointerPath)
	commit[len(commit)-1] = catalogstore.Hash(candidate)
	if err := run(commit, ioBuffer()); err != nil {
		t.Fatal(err)
	}
	assertBytes(t, pointerPath, currentPointer)
}

func TestDragonGhostStoreRefusesUnsafeTargets(t *testing.T) {
	for _, mode := range []string{"missing", "recovery", "future-pointer", "bad-hash", "wrong-target", "backup-failure", "stale", "app-not-closed"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			input, storeRoot, backup := filepath.Join(root, "factory", "catalog.json"), filepath.Join(root, "store"), filepath.Join(root, "backups")
			factory := marshalTest(t, dragonGhostFixture(t))
			put(t, input, factory)
			local := dragonGhostFixture(t)
			if mode == "wrong-target" {
				local.Monsters[0].Name, local.Monsters[0].Placeholder = "另一个619", false
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
				put(t, filepath.Join(storeRoot, "versions", catalogstore.Hash(original)+".json"), []byte("corrupt"))
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
			args := []string{"-dragon-ghost", "-catalog", input, "-store-root", storeRoot, "-backup-dir", backup, "-commit-local", "-expected-revision", expected}
			if mode != "app-not-closed" {
				args = append(args, "-app-closed")
			}
			if err := run(args, ioBuffer()); err == nil {
				t.Fatal("accepted unsafe store operation")
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
