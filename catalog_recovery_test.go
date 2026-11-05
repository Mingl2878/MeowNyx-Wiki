package main

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogrecovery"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/sourcebaseline"
)

// Real updater API operations and commits are exercised, but every mutable
// runtime path and backup belongs to catalogTestNew's t.TempDir fixture.
func recoveryTestRoundTrip(t *testing.T, fx *catalogTestFixture, original *catalog.Catalog, source []byte, names []string) {
	t.Helper()
	before, err := catalog.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	deleted, report, err := catalogrecovery.DeleteMonsters(original, names)
	if err != nil {
		t.Fatal(err)
	}
	unchanged, _ := catalog.Marshal(original)
	if !bytes.Equal(before, unchanged) {
		t.Fatal("candidate creation changed original catalog")
	}
	if !reflect.DeepEqual(original.Skills, deleted.Skills) || !reflect.DeepEqual(original.Types, deleted.Types) || !reflect.DeepEqual(original.Traits, deleted.Traits) || !reflect.DeepEqual(original.SkillRules, deleted.SkillRules) {
		t.Fatal("deletion changed shared tables")
	}
	for key, raw := range original.Extensions {
		if key != catalogrecovery.Extension && !bytes.Equal(raw, deleted.Extensions[key]) {
			t.Fatalf("deletion changed extension %s", key)
		}
	}
	data, err := catalog.Marshal(deleted)
	if err != nil {
		t.Fatal(err)
	}
	fx.opts.Baseline = data
	fx.opts.Validate = func(b []byte) error {
		c, err := catalog.Parse(b)
		if err != nil {
			return err
		}
		return catalogrecovery.Validate(c)
	}
	fx.rt.store, err = catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
	missing := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, source)
	selected := []catalogChoice{}
	for _, r := range report.Removed {
		if choiceMonster(choiceTestCurrent(t, fx), r.LocalID) != nil {
			t.Fatalf("check restored deleted local ID %d", r.LocalID)
		}
		found := false
		for _, item := range s.Candidates {
			if item.Entity == "monster" && item.ID == r.LocalID && item.Field == "entity" {
				if !item.SourceAvailable || item.Kind != "add" {
					t.Fatalf("recovery candidate unavailable: %+v", item)
				}
				selected = append(selected, catalogChoice{Key: item.Key, Choice: "source", AcknowledgeOnly: true})
				found = true
			}
		}
		if !found {
			t.Fatalf("baseline hid missing local ID %d: candidates=%+v, issues=%+v", r.LocalID, s.Candidates, s.Issues)
		}
	}
	catalogTestNoWrite(t, fx, missing)
	if err := fx.rt.update.Cancel(s.TaskID); err != nil {
		t.Fatal(err)
	}
	catalogTestNoWrite(t, fx, missing)
	s = catalogTestPreview(t, fx, source)
	out := choiceTestApply(t, fx, s, selected)
	if out.State != "applied" {
		t.Fatalf("official recovery apply failed: %+v", out)
	}
	recovered := choiceTestCurrent(t, fx)
	if len(recovered.Monsters) != len(original.Monsters) || len(recovered.Learnsets) != len(original.Learnsets) {
		t.Fatal("recovery did not restore exactly the deleted records")
	}
	if err := catalogrecovery.Validate(recovered); err != nil {
		t.Fatal(err)
	}
	oldMemory, oldMemoryErr := readCatalogChoiceMemory(deleted)
	newMemory, newMemoryErr := readCatalogChoiceMemory(recovered)
	if oldMemoryErr != nil || newMemoryErr != nil || !reflect.DeepEqual(oldMemory, newMemory) {
		t.Fatal("revision-only recovery changed saved policies")
	}
	removed := map[int]bool{}
	for _, r := range report.Removed {
		removed[r.LocalID] = true
		m := choiceMonster(recovered, r.LocalID)
		l := choiceLearnset(recovered, r.LocalID)
		if m == nil || m.SourceRef == nil || m.SourceRef.ID != r.SourceID || m.SourceRef.Identity != r.Identity || l == nil || len(l.Skills) == 0 {
			t.Fatalf("identity/learning recovery failed for %+v", r)
		}
		t.Logf("RECOVERED local=%d source=%s identity=%s skills=%d", m.ID, m.SourceRef.ID, m.SourceRef.Identity, len(l.Skills))
	}
	for _, m := range deleted.Monsters {
		if !reflect.DeepEqual(m, *choiceMonster(recovered, m.ID)) || !reflect.DeepEqual(choiceLearnset(deleted, m.ID), choiceLearnset(recovered, m.ID)) {
			t.Fatalf("unselected survivor %d changed during recovery", m.ID)
		}
	}
	if !reflect.DeepEqual(deleted.Skills, recovered.Skills) || !reflect.DeepEqual(deleted.Types, recovered.Types) || !reflect.DeepEqual(deleted.SkillRules, recovered.SkillRules) {
		t.Fatal("unselected shared table changed during recovery")
	}
	for _, trait := range deleted.Traits {
		if !reflect.DeepEqual(&trait, choiceTrait(recovered, trait.ID)) {
			t.Fatalf("existing shared trait %s changed", trait.ID)
		}
	}
	for key, raw := range deleted.Extensions {
		if key != sourcebaseline.Extension && !bytes.Equal(raw, recovered.Extensions[key]) {
			t.Fatalf("recovery changed unrelated extension %s", key)
		}
	}
	second := catalogTestPreview(t, fx, source)
	for _, item := range second.Candidates {
		if item.Entity == "monster" && removed[item.ID] {
			t.Fatalf("recovered entity repeated as difference: %+v", item)
		}
	}
	t.Logf("DELETION %+v; first candidates=%d; second candidates=%d; original and fixture input files remain untouched", report, len(s.Candidates), len(second.Candidates))
}

func TestCanonicalDeletionOfficialRecoveryCheckSelectApply(t *testing.T) {
	fx := catalogTestNew(t, 4, true, nil)
	source := catalogTestSource(t, 4, false)
	baselineTestSeed(t, fx, source, func(c *catalog.Catalog) {
		if c.Extensions == nil {
			c.Extensions = catalog.Extensions{}
		}
		c.Extensions["personal_unknown"] = json.RawMessage(`{"do_not_change":[1,2,3]}`)
	})
	recoveryTestRoundTrip(t, fx, choiceTestCurrent(t, fx), source, []string{"测试精灵1", "测试精灵2", "测试精灵3"})
}

// Opt-in fixture proof, not a permanent assertion that factory data is missing
// these records. The full input must contain the explicitly selected targets.
func TestCanonicalDeletionOfficialRecoveryRealFixture(t *testing.T) {
	catalogPath, sourcePath := os.Getenv("CATALOG_RECOVERY_CATALOG"), os.Getenv("CATALOG_RECOVERY_SOURCE")
	if catalogPath == "" && sourcePath == "" {
		t.Skip("set CATALOG_RECOVERY_CATALOG and CATALOG_RECOVERY_SOURCE for isolated real-source recovery proof")
	}
	if catalogPath == "" || sourcePath == "" {
		t.Fatal("both recovery fixture paths required")
	}
	raw, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := sourcebaseline.Decode(c.Extensions[sourcebaseline.Extension])
	if err != nil || baseline == nil {
		t.Fatal("real recovery proof requires existing source baseline", err)
	}
	t.Logf("INPUT monsters=%d baseline=%d", len(c.Monsters), len(baseline.Entries))
	fx := catalogTestNew(t, 1, false, nil)
	recoveryTestRoundTrip(t, fx, c, source, []string{"机械方方", "多彩方方", "立方人"})
	for path, original := range map[string][]byte{catalogPath: raw, sourcePath: source} {
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(current, original) {
			t.Fatalf("read-only fixture input changed: %s: %v", path, err)
		}
	}
}
