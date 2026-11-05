package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
)

func cliTestCatalog(t *testing.T) []byte {
	t.Helper()
	c := &catalog.Catalog{SchemaVersion: catalog.SchemaVersion,
		Monsters:  []catalog.Monster{{ID: 5, Name: "猫", DexNumber: 1, TypeIDs: []int{1}, TraitID: "trait", Stats: catalog.Stats{HP: 1, PhyAtk: 1, PhyDef: 1, MagAtk: 1, MagDef: 1, Speed: 1}, Form: "default", FormCategory: "无多形态", EvolutionStage: "基础形态", EvolutionMembers: []int{5}, SourceRef: &catalog.SourceRef{Provider: catalogrecovery.Provider, ID: "10", Identity: "NO.001|猫|"}}},
		Skills:    []catalog.Skill{{ID: 1, Name: "技能", Description: "保留", TypeID: 1, Category: "Physical Attack"}},
		Types:     []catalog.Type{{ID: 1, Name: "普通", Code: "Normal", VulnerableTo: []int{}, ResistantTo: []int{}}},
		Traits:    []catalog.Trait{{ID: "trait", Name: "特性", Description: "保留"}},
		Learnsets: []catalog.Learnset{{MonsterID: 5, Mode: "own", Skills: []catalog.LearnedSkill{}}},
	}
	survivor := c.Monsters[0]
	survivor.ID, survivor.Name, survivor.SourceRef, survivor.EvolutionMembers = 6, "保留猫", nil, []int{6}
	c.Monsters = append(c.Monsters, survivor)
	c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: 6, Mode: "own", Skills: []catalog.LearnedSkill{}})
	original, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return original
}

func TestDeveloperCLIOnlyWritesNewCandidate(t *testing.T) {
	root := t.TempDir()
	input, output := filepath.Join(root, "original.json"), filepath.Join(root, "candidate.json")
	original := cliTestCatalog(t)
	if err := os.WriteFile(input, original, 0600); err != nil {
		t.Fatal(err)
	}
	args := []string{"-catalog", input, "-names", "猫"}
	if err := run(args, new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("audit wrote candidate")
	}
	if err := run(append(args, "-out", input), new(bytes.Buffer)); err == nil {
		t.Fatal("CLI overwrote input")
	}
	if err := run(append(args, "-out", output), new(bytes.Buffer)); err != nil {
		t.Fatal(err)
	}
	if err := run(append(args, "-out", output), new(bytes.Buffer)); err == nil {
		t.Fatal("CLI overwrote existing candidate")
	}
	current, _ := os.ReadFile(input)
	if !bytes.Equal(current, original) {
		t.Fatal("CLI modified canonical input")
	}
	candidate, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := catalog.Parse(candidate)
	if err != nil || len(deleted.Monsters) != 1 || len(deleted.Learnsets) != 1 || len(deleted.Traits) != 1 || catalogrecovery.Validate(deleted) != nil {
		t.Fatal("invalid isolated candidate", err)
	}
}
