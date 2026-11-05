package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
	"xhmwiki/internal/sourcebaseline"
)

func baselineTestSeed(t *testing.T, fx *catalogTestFixture, source []byte, modify func(*catalog.Catalog)) {
	t.Helper()
	c := choiceTestCurrent(t, fx)
	if modify != nil {
		modify(c)
	}
	before, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	seeded, _, err := officialdex.SeedTencentBaseline(c, source)
	if err != nil {
		t.Fatal(err)
	}
	after, err := catalog.Marshal(c)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("seed mutated input", err)
	}
	fx.opts.Baseline, err = catalog.Marshal(seeded)
	if err != nil {
		t.Fatal(err)
	}
	fx.rt.store, err = catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
}
func baselineTestRead(t *testing.T, fx *catalogTestFixture) *sourcebaseline.Baseline {
	t.Helper()
	b, err := sourcebaseline.Decode(choiceTestCurrent(t, fx).Extensions[sourcebaseline.Extension])
	if err != nil || b == nil {
		t.Fatal(err)
	}
	return b
}
func baselineTestHP(t *testing.T, hp int) []byte {
	return choiceTestSourceChange(t, 1, func(s map[string]any) {
		r := s["d"].(map[string]any)["101"].(map[string]any)
		r["hp"] = hp
		r["rt"] = hp + 515
	})
}
func baselineTestPolicies(t *testing.T, c *catalog.Catalog, values map[string]string) {
	t.Helper()
	m := catalogChoiceMemory{Version: 1, Entries: map[string]catalogRememberedChoice{}}
	for key, choice := range values {
		parts := strings.Split(key, ":")
		id := 1
		if parts[0] == "skill" {
			id = 3
		}
		m.Entries[key] = catalogRememberedChoice{Key: key, Entity: parts[0], ID: id, Name: "test", Field: parts[2], Choice: choice}
	}
	if err := writeCatalogChoiceMemory(c, m); err != nil {
		t.Fatal(err)
	}
}
func TestTencentBaselineShieldsAllKnownDifferencesAndInheritedSourcePolicies(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, baselineTestHP(t, 90), func(c *catalog.Catalog) {
		c.Monsters[0].Stats.HP = 100
		baselineTestPolicies(t, c, map[string]string{"monster:1:stats.hp": "source", "monster:1:evolution": "source"})
	})
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, baselineTestHP(t, 90))
	if !s.SourceBaselineActive || len(s.Candidates) != 0 || s.AutomaticSourceChanges != 0 || len(s.Changes) != 0 || len(s.Issues) != 0 {
		t.Fatalf("unchanged source not shielded: %+v", s)
	}
	catalogTestNoWrite(t, fx, before)
	if err := fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, []catalogChoice{}); err == nil {
		t.Fatal("empty apply accepted")
	}
	fresh := baselineTestHP(t, 110)
	s = catalogTestPreview(t, fx, fresh)
	if s.AutomaticSourceChanges != 1 || choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatalf("new revision lost source policy %+v", s)
	}
	catalogTestNoWrite(t, fx, before)
	if out := choiceTestApply(t, fx, s, []catalogChoice{}); out.State != "applied" {
		t.Fatal(out)
	}
	if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 110 {
		t.Fatal("fresh source not applied")
	}
	if s = catalogTestPreview(t, fx, fresh); len(s.Candidates) != 0 || s.AutomaticSourceChanges != 0 {
		t.Fatal("applied revision repeated", s)
	}
}
func TestTencentBaselineLocalAcknowledgementIsRevisionOnlyAndCanRepeat(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, baselineTestHP(t, 90), func(c *catalog.Catalog) { c.Monsters[0].Stats.HP = 100 })
	for _, hp := range []int{110, 120, 90} {
		source := baselineTestHP(t, hp)
		s := catalogTestPreview(t, fx, source)
		if !choiceTestHas(s, "monster:1:stats.hp") {
			t.Fatalf("new source %d missing", hp)
		}
		out := choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local", AcknowledgeOnly: true}})
		if out.State != "applied" {
			t.Fatal(out)
		}
		if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 100 || len(choiceTestMemory(t, fx).Entries) != 0 {
			t.Fatal("revision acknowledgement became permanent policy/data patch")
		}
		s = catalogTestPreview(t, fx, source)
		if choiceTestHas(s, "monster:1:stats.hp") {
			t.Fatal("same local acknowledgement repeated")
		}
	}
}
func TestTencentBaselinePartialApplyNeverAcknowledgesUnselectedFields(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), nil)
	source := choiceTestSourceChange(t, 1, func(s map[string]any) {
		r := s["d"].(map[string]any)["101"].(map[string]any)
		r["hp"] = 110
		r["spd"] = 120
		r["rt"] = 640
	})
	s := catalogTestPreview(t, fx, source)
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "source", AcknowledgeOnly: true}})
	s = catalogTestPreview(t, fx, source)
	if choiceTestHas(s, "monster:1:stats.hp") || !choiceTestHas(s, "monster:1:stats.speed") {
		t.Fatal("partial apply acknowledged unrelated revision", s)
	}
	if choiceTestCurrent(t, fx).Monsters[0].Stats.Speed != 90 || len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("partial apply changed unrelated data/policy")
	}
}
func TestTencentBaselinePreservesManualLocalLocksAndClearDoesNotClearBaseline(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), func(c *catalog.Catalog) { baselineTestPolicies(t, c, map[string]string{"monster:1:stats.hp": "local"}) })
	source := choiceTestSourceChange(t, 1, func(s map[string]any) {
		r := s["d"].(map[string]any)["101"].(map[string]any)
		r["hp"] = 110
		r["spd"] = 120
		r["rt"] = 640
	})
	s := catalogTestPreview(t, fx, source)
	if choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("manual local lock ignored")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.speed", Choice: "source", AcknowledgeOnly: true}})
	before := choiceTestCurrent(t, fx).Extensions[sourcebaseline.Extension]
	if err := fx.rt.update.ClearChoices(fx.rt.store.Current().Revision, nil, true); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, choiceTestCurrent(t, fx).Extensions[sourcebaseline.Extension]) {
		t.Fatal("clear policies reset source baseline")
	}
	s = catalogTestPreview(t, fx, source)
	if !choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("unselected locked source revision was silently acknowledged")
	}
}
func TestTencentBaselineCheckCancelFailedCommitAndRestartAreAtomic(t *testing.T) {
	var reject atomic.Bool
	fx := catalogTestNew(t, 1, false, func(a, b string) error {
		if reject.Load() && filepath.Base(b) == "current.json" {
			return errors.New("reject baseline commit")
		}
		return catalogstore.ReplaceFile(a, b)
	})
	baselineTestSeed(t, fx, baselineTestHP(t, 90), nil)
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, baselineTestHP(t, 110))
	if err := fx.rt.update.Cancel(s.TaskID); err != nil {
		t.Fatal(err)
	}
	catalogTestNoWrite(t, fx, before)
	s = catalogTestPreview(t, fx, baselineTestHP(t, 110))
	reject.Store(true)
	out := choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local", AcknowledgeOnly: true}})
	if out.State != "error" || fx.rt.store.Current().Revision != before.Revision {
		t.Fatal("failed baseline commit leaked", out)
	}
	reopened, err := catalogstore.Open(fx.opts)
	if err != nil || reopened.Current().Revision != before.Revision {
		t.Fatal("failed baseline survived restart", err)
	}
	reject.Store(false)
	s = catalogTestPreview(t, fx, baselineTestHP(t, 110))
	if !choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("failed commit acknowledged source")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local", AcknowledgeOnly: true}})
	reopened, err = catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
	fx.rt.store = reopened
	if s = catalogTestPreview(t, fx, baselineTestHP(t, 110)); choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("successful baseline lost on restart")
	}
}
func TestTencentBaselineMalformedFieldCannotMasqueradeAsUnchangedOrBeAcknowledged(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), nil)
	old := choiceTestCurrent(t, fx).Extensions[sourcebaseline.Extension]
	source := choiceTestSourceChange(t, 1, func(s map[string]any) { r := s["d"].(map[string]any)["101"].(map[string]any); delete(r, "hp") })
	s := catalogTestPreview(t, fx, source)
	found := false
	for _, item := range s.Candidates {
		if item.Key == "monster:1:stats.hp" {
			found = true
			if item.SourceAvailable {
				t.Fatal("malformed field became source candidate")
			}
		}
	}
	if !found {
		t.Fatal("malformed field hidden by baseline")
	}
	w := catalogTestUpdate(t, fx.rt, "apply", map[string]any{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": []catalogChoice{{Key: "monster:1:stats.hp", Choice: "source", AcknowledgeOnly: true}}})
	if w.Code < 400 {
		t.Fatal("malformed source applied")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local", AcknowledgeOnly: true}})
	if !bytes.Equal(old, choiceTestCurrent(t, fx).Extensions[sourcebaseline.Extension]) {
		t.Fatal("malformed field advanced baseline")
	}
	if s = catalogTestPreview(t, fx, source); !choiceTestHas(s, "monster:1:stats.hp") {
		t.Fatal("malformed source acknowledged by local choice")
	}
}
func TestTencentBaselineProtectedPowerIsObservedEvenWhenBuildSuppressesPatch(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), func(c *catalog.Catalog) {
		c.SkillRules = []catalog.SkillRule{{SkillID: 3, PowerFormula: "60+10*n"}}
		baselineTestPolicies(t, c, map[string]string{"skill:3:power": "source"})
	})
	for _, power := range []string{"95", "105"} {
		source := choiceTestSourceChange(t, 1, func(s map[string]any) {
			s["d"].(map[string]any)["101"].(map[string]any)["sk"].(map[string]any)["s"].([]any)[0].(map[string]any)["pw"] = power
		})
		s := catalogTestPreview(t, fx, source)
		found := false
		for _, item := range s.Candidates {
			if item.Key == "skill:3:power" {
				found = true
				if item.Kind != "source_review" || item.SourceAvailable || len(item.SourceRevision) == 0 {
					t.Fatal("protected power lost raw-source evidence", item)
				}
			}
		}
		if !found {
			t.Fatal("suppressed Build difference vanished", s)
		}
		choiceTestApply(t, fx, s, []catalogChoice{{Key: "skill:3:power", Choice: "local", AcknowledgeOnly: true}})
		if *choiceTestCurrent(t, fx).Skills[0].Power != 60 || choiceTestCurrent(t, fx).SkillRules[0].PowerFormula != "60+10*n" || choiceTestMemory(t, fx).Entries["skill:3:power"].Choice != "source" {
			t.Fatal("source acknowledgement changed formula/policy")
		}
		if s = catalogTestPreview(t, fx, source); choiceTestHas(s, "skill:3:power") {
			t.Fatal("protected source revision repeats")
		}
	}
}
func TestTencentBaselineNewEntitiesUseSemanticIdentityAcrossIDAllocation(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), nil)
	source2 := catalogTestSource(t, 2, false)
	s := catalogTestPreview(t, fx, source2)
	key2 := ""
	for _, item := range s.Candidates {
		if item.Entity == "monster" && item.Field == "entity" {
			key2 = item.Key
		}
	}
	if key2 == "" {
		t.Fatal("new entity missing")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: key2, Choice: "local", AcknowledgeOnly: true}})
	source3 := catalogTestSource(t, 3, false)
	s = catalogTestPreview(t, fx, source3)
	key3 := ""
	for _, item := range s.Candidates {
		if item.Entity == "monster" && item.Field == "entity" {
			if item.Key == key2 {
				t.Fatal("unchanged declined entity repeated")
			}
			key3 = item.Key
		}
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: key3, Choice: "source", AcknowledgeOnly: true}})
	s = catalogTestPreview(t, fx, source3)
	if choiceTestHas(s, key2) {
		t.Fatal("provisional ID shift lost acknowledgement")
	}
	changed := choiceTestSourceChange(t, 3, func(src map[string]any) {
		r := src["d"].(map[string]any)["102"].(map[string]any)
		r["hp"] = 111
		r["rt"] = 626
	})
	s = catalogTestPreview(t, fx, changed)
	if !choiceTestHas(s, key2) {
		t.Fatal("declined new entity future revision was locked")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: key2, Choice: "source", AcknowledgeOnly: true}})
	if len(choiceTestCurrent(t, fx).Monsters) != 3 || len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("new-entity acknowledgement mutated permanent policies")
	}
	s = catalogTestPreview(t, fx, changed)
	if len(s.Candidates) != 0 || s.AutomaticSourceChanges != 0 {
		t.Fatal("accepted entity constituent baseline not seeded", s)
	}
}
func TestTencentBaselineRejectsFutureAndMalformedExtensionAndSeedSource(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	baselineTestSeed(t, fx, catalogTestSource(t, 1, false), nil)
	c := choiceTestCurrent(t, fx)
	for _, mutate := range []func(map[string]any){func(m map[string]any) { m["version"] = 2 }, func(m map[string]any) { m["normalizer_version"] = 2 }, func(m map[string]any) { m["entries"] = nil }, func(m map[string]any) { m["arbitrary"] = true }} {
		clone := choiceTestCurrent(t, fx)
		var raw map[string]any
		_ = json.Unmarshal(clone.Extensions[sourcebaseline.Extension], &raw)
		mutate(raw)
		clone.Extensions[sourcebaseline.Extension] = catalogTestJSON(t, raw)
		if _, err := catalog.Marshal(clone); err == nil {
			t.Fatal("future/malformed baseline accepted")
		}
	}
	source := choiceTestSourceChange(t, 1, func(s map[string]any) { s["d"].(map[string]any)["101"].(map[string]any)["nm"] = "<img>" })
	if _, _, err := officialdex.SeedTencentBaseline(c, source); err == nil {
		t.Fatal("blocking source seeded")
	}
	fx.rt.update.fetchSource = func(context.Context) ([]byte, error) { return source, nil }
	if err := fx.rt.update.Start(); err != nil {
		t.Fatal(err)
	}
	catalogTestWait(t, fx.rt.update)
	if fx.rt.update.Status().CanApply {
		t.Fatal("blocking source hidden by shipped baseline")
	}
}
func TestTencentBaselineRealSnapshotReadOnly(t *testing.T) {
	sourcePath, catalogPath := os.Getenv("MEOWNYX_TENCENT_FIXTURE"), os.Getenv("MEOWNYX_CATALOG_FIXTURE")
	if sourcePath == "" || catalogPath == "" {
		t.Skip("set read-only full snapshot paths to run release evidence")
	}
	raw, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Parse(b)
	if err != nil {
		t.Fatal(err)
	}
	seeded, p, err := officialdex.SeedTencentBaseline(c, raw)
	if err != nil {
		t.Fatal(err)
	}
	before, err := catalog.Marshal(seeded)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := buildCatalogChoicePlan(before, p)
	if err != nil {
		t.Fatal(err)
	}
	pending, automatic := plan.pending()
	issues := plan.visibleIssues(p.Issues)
	if len(pending) != 0 || automatic != 0 || len(issues) != 0 {
		t.Fatalf("real seeded baseline: pending=%d auto=%d issues=%+v", len(pending), automatic, issues)
	}
	if prior := c.Extensions[sourcebaseline.Extension]; len(prior) > 0 && !sourcebaseline.Equal(prior, seeded.Extensions[sourcebaseline.Extension]) {
		t.Fatal("shipped baseline differs from final normalizer; reseed required")
	}
	t.Logf("real source: %d normalized entries, %d source diagnostics; existing shipped baseline matches final normalizer", len(plan.baseline.Entries), len(plan.baseline.Issues))
}
