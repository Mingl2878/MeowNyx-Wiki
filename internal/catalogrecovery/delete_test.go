package catalogrecovery

import (
	"encoding/json"
	"reflect"
	"testing"

	"xhmwiki/internal/catalog"
)

func recoveryFixture(t *testing.T) *catalog.Catalog {
	t.Helper()
	c := &catalog.Catalog{SchemaVersion: catalog.SchemaVersion,
		Types:      []catalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}},
		Traits:     []catalog.Trait{{ID: "shared", Name: "特性", Description: "保留"}},
		Skills:     []catalog.Skill{{ID: 1, Name: "技能", Description: "保留", TypeID: 1, Category: "Physical Attack"}},
		Extensions: catalog.Extensions{"catalog_choices": json.RawMessage(`{"version":1,"entries":{}}`), "tencent_source_baseline": json.RawMessage(`{"version":1,"normalizer_version":1,"provider":"tencent-compendium","source_sha256":"0000000000000000000000000000000000000000000000000000000000000000","entries":{}}`), "personal_unknown": json.RawMessage(`{"keep":[1,2,3]}`)},
	}
	for i, name := range []string{"父", "子", "孙"} {
		id := i + 1
		c.Monsters = append(c.Monsters, catalog.Monster{ID: id, Name: name, DexNumber: id, TypeIDs: []int{1}, TraitID: "shared", Stats: catalog.Stats{HP: 1, PhyAtk: 1, PhyDef: 1, MagAtk: 1, MagDef: 1, Speed: 1}, Form: "default", FormCategory: "无多形态", EvolutionStage: "基础形态", EvolutionMembers: []int{1, 2, 3}})
		c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: id, Mode: "own", Skills: []catalog.LearnedSkill{}})
	}
	c.Monsters[0].SourceRef = &catalog.SourceRef{Provider: Provider, ID: "100", Identity: "NO.001|父|"}
	c.Monsters[1].EvolvesFromID = 1
	c.Monsters[1].EvolutionChainName = "父"
	c.Monsters[2].LeaderOfID = 1
	c.Monsters[2].IsLeaderForm = true
	c.Learnsets[0].Skills = []catalog.LearnedSkill{{SkillID: 1, Source: "默认", Extensions: catalog.Extensions{"note": json.RawMessage(`"retained"`)}}}
	c.Learnsets[1].Mode, c.Learnsets[1].FromID = "inherit", 1
	c.Learnsets[2].Mode, c.Learnsets[2].FromID = "inherit", 2
	if err := catalog.Validate(c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestDeletePreservesEffectiveChildrenTablesAndExtensions(t *testing.T) {
	before := recoveryFixture(t)
	original, _ := catalog.Marshal(before)
	after, report, err := DeleteMonsters(before, []string{"父"})
	if err != nil {
		t.Fatal(err)
	}
	unchanged, _ := catalog.Marshal(before)
	if string(original) != string(unchanged) {
		t.Fatal("mutated caller input")
	}
	if len(after.Monsters) != 2 || len(after.Learnsets) != 2 || !reflect.DeepEqual(report.DetachedLearning, []int{2}) || !reflect.DeepEqual(report.CleanedRelations, []int{2, 3}) {
		t.Fatalf("imprecise deletion: %+v", report)
	}
	if after.Learnsets[0].Mode != "own" || after.Learnsets[0].FromID != 0 || !reflect.DeepEqual(after.Learnsets[0].Skills, before.Learnsets[0].Skills) || after.Learnsets[1].Mode != "inherit" || after.Learnsets[1].FromID != 2 {
		t.Fatal("lost effective learning or unnecessarily flattened descendants")
	}
	if !reflect.DeepEqual(before.Skills, after.Skills) || !reflect.DeepEqual(before.Traits, after.Traits) || !reflect.DeepEqual(before.Types, after.Types) || !reflect.DeepEqual(before.SkillRules, after.SkillRules) {
		t.Fatal("shared source tables changed")
	}
	for key, value := range before.Extensions {
		if string(after.Extensions[key]) != string(value) {
			t.Fatalf("extension %s changed", key)
		}
	}
	for _, m := range after.Monsters {
		if !reflect.DeepEqual(m.EvolutionMembers, []int{2, 3}) || m.EvolvesFromID != 0 || m.LeaderOfID != 0 {
			t.Fatal("dangling relation", m)
		}
	}
	r, err := Read(after)
	if err != nil || len(r.Entries) != 1 || r.Entries[0].LocalID != 1 {
		t.Fatal("missing stable ID reservation", r, err)
	}
	if _, _, err := DeleteMonsters(after, []string{"父"}); err == nil {
		t.Fatal("silently accepted already-deleted target")
	}
}

func TestReservationValidationAndExactMatching(t *testing.T) {
	c := recoveryFixture(t)
	entry := Reservation{LocalID: 1, Provider: Provider, SourceID: "100", Identity: "NO.001|父|"}
	for _, raw := range []string{`null`, `{}`, `{"version":2,"entries":[]}`, `{"version":1,"entries":null}`, `{"version":1,"entries":[],"records":[]}`} {
		c.Extensions[Extension] = json.RawMessage(raw)
		if Validate(c) == nil {
			t.Fatalf("invalid reservation accepted: %s", raw)
		}
	}
	set := func(entries ...Reservation) {
		c.Extensions[Extension], _ = json.Marshal(Reservations{Version: 1, Entries: entries})
	}
	set(entry)
	r, err := Read(c)
	if err != nil {
		t.Fatal(err)
	}
	if id, err := r.Match(Provider, "100", "NO.001|父|"); id != 1 || err != nil {
		t.Fatal("exact match rejected")
	}
	for _, pair := range [][2]string{{"100", "NO.002|另一只|"}, {"101", "NO.001|父|"}} {
		if _, err := r.Match(Provider, pair[0], pair[1]); err == nil {
			t.Fatal("numeric-only or identity-only fallback allowed")
		}
	}
	set(entry, entry)
	if Validate(c) == nil {
		t.Fatal("duplicate reservation accepted")
	}
	set(entry)
	c.Monsters[0].SourceRef = nil
	if Validate(c) == nil {
		t.Fatal("occupied stable ID allowed")
	}
}

func TestDeleteRefusesMissingAmbiguousOrUnrecoverableTargets(t *testing.T) {
	for _, names := range [][]string{nil, {"missing"}, {"父", "父"}, {"子"}} {
		if _, _, err := DeleteMonsters(recoveryFixture(t), names); err == nil {
			t.Fatalf("accepted deletion %v", names)
		}
	}
}
