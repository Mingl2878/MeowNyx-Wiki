package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/catalogstore"
	"xhmwiki/internal/officialdex"
)

func choiceTestCurrent(t *testing.T, fx *catalogTestFixture) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Parse(fx.rt.store.Current().Data)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func choiceTestMemory(t *testing.T, fx *catalogTestFixture) catalogChoiceMemory {
	t.Helper()
	m, err := readCatalogChoiceMemory(choiceTestCurrent(t, fx))
	if err != nil {
		t.Fatal(err)
	}
	return m
}
func choiceTestApply(t *testing.T, fx *catalogTestFixture, s catalogUpdateStatus, choices []catalogChoice) catalogUpdateStatus {
	t.Helper()
	w := catalogTestUpdate(t, fx.rt, "apply", map[string]any{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": choices})
	if w.Code != 200 {
		t.Fatalf("apply: %d %s", w.Code, w.Body.String())
	}
	catalogTestWait(t, fx.rt.update)
	return fx.rt.update.Status()
}
func choiceTestHas(s catalogUpdateStatus, key string) bool {
	for _, c := range s.Candidates {
		if c.Key == key {
			return true
		}
	}
	return false
}
func choiceTestSourceChange(t *testing.T, count int, change func(map[string]any)) []byte {
	t.Helper()
	var source map[string]any
	_ = json.Unmarshal(catalogTestSource(t, count, false), &source)
	change(source)
	return catalogTestJSON(t, source)
}
func choiceTestPlan(t *testing.T, modify func(*catalog.Catalog)) (*catalogChoicePlan, []byte) {
	t.Helper()
	c, err := catalog.ImportLegacy(catalogTestLegacy(t, 2, false))
	if err != nil {
		t.Fatal(err)
	}
	before, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	modify(c)
	files, err := catalog.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	proposal := &officialdex.Proposal{Files: officialdex.LegacyFiles{Monsters: files.Monsters, Moves: files.Moves, Types: files.Types, Wiki: files.Wiki}}
	plan, err := buildCatalogChoicePlan(before, proposal)
	if err != nil {
		t.Fatal(err)
	}
	return plan, before
}

func TestCatalogChoicesLocalPersistsWithoutChangingDataAndNeverReturnsPending(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	key := "monster:1:stats.hp"
	if !choiceTestHas(s, key) {
		t.Fatal("no HP candidate")
	}
	out := choiceTestApply(t, fx, s, []catalogChoice{{Key: key, Choice: "local"}})
	if out.State != "applied" {
		t.Fatal(out)
	}
	c := choiceTestCurrent(t, fx)
	previous, _ := catalog.Parse(before.Data)
	c.Extensions = previous.Extensions
	unchanged, _ := catalog.Marshal(c)
	if !bytes.Equal(unchanged, before.Data) {
		t.Fatal("local-only choice changed canonical business data")
	}
	if choiceTestMemory(t, fx).Entries[key].Choice != "local" {
		t.Fatal("local policy not committed")
	}
	s = catalogTestPreview(t, fx, choiceTestSourceChange(t, 1, func(src map[string]any) { src["d"].(map[string]any)["101"].(map[string]any)["hp"] = 200 }))
	if choiceTestHas(s, key) {
		t.Fatal("remembered local choice returned as pending")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.speed", Choice: "source"}})
	if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 90 {
		t.Fatal("source overrode remembered local HP")
	}
	backup, err := os.ReadFile(filepath.Join(fx.opts.BackupDir, before.Revision+".json"))
	if err != nil || !bytes.Equal(backup, before.Data) {
		t.Fatal("memory-only transaction did not back up original", err)
	}
}

func TestCatalogChoicesSourceFollowsLatestSourceButCheckNeverWrites(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	key := "monster:1:stats.hp"
	choiceTestApply(t, fx, s, []catalogChoice{{Key: key, Choice: "source"}})
	saved := fx.rt.store.Current()
	s = catalogTestPreview(t, fx, choiceTestSourceChange(t, 1, func(src map[string]any) { src["d"].(map[string]any)["101"].(map[string]any)["hp"] = 130 }))
	if choiceTestHas(s, key) || s.AutomaticSourceChanges != 1 {
		t.Fatalf("remembered source not auto pending: %+v", s)
	}
	if fx.rt.store.Current().Revision != saved.Revision || choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 100 {
		t.Fatal("check wrote remembered source value")
	}
	choiceTestApply(t, fx, s, []catalogChoice{})
	c := choiceTestCurrent(t, fx)
	if c.Monsters[0].Stats.HP != 130 || c.Monsters[0].Stats.Speed != 90 || *c.Skills[0].Power != 60 {
		t.Fatal("automatic HP choice changed unselected fields")
	}
}

func TestCatalogChoicesRememberedSourceWaitsForValidFutureValue(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "source"}})
	saved := fx.rt.store.Current()
	source := choiceTestSourceChange(t, 1, func(src map[string]any) { delete(src["d"].(map[string]any)["101"].(map[string]any), "hp") })
	s = catalogTestPreview(t, fx, source)
	if s.AutomaticSourceChanges != 0 || fx.rt.store.Current().Revision != saved.Revision {
		t.Fatal("unavailable remembered source became an automatic change")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.speed", Choice: "source"}})
	if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 100 || choiceTestMemory(t, fx).Entries["monster:1:stats.hp"].Choice != "source" {
		t.Fatal("unavailable source overwrote local or forgot source policy")
	}
	source = choiceTestSourceChange(t, 1, func(src map[string]any) { src["d"].(map[string]any)["101"].(map[string]any)["hp"] = 140 })
	s = catalogTestPreview(t, fx, source)
	choiceTestApply(t, fx, s, []catalogChoice{})
	if choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 140 {
		t.Fatal("valid future value did not follow source")
	}
}

func TestCatalogChoicesUnavailableSourceAndMissingLegacyRequestRejected(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, choiceTestSourceChange(t, 1, func(src map[string]any) { delete(src["d"].(map[string]any)["101"].(map[string]any), "s") }))
	key := "monster:1:evolution_stage"
	found := false
	for _, c := range s.Candidates {
		if c.Key == key {
			found = true
			if c.SourceAvailable || c.SourceValue != nil || !c.LocalAvailable {
				t.Fatal("missing stage fabricated source", c)
			}
		}
	}
	if !found {
		t.Fatal("missing stage has no local choice")
	}
	requests := []map[string]any{
		{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true},
		{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": []catalogChoice{{Key: key, Choice: "source"}}},
		{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": []catalogChoice{}},
	}
	for _, body := range requests {
		w := catalogTestUpdate(t, fx.rt, "apply", body)
		if w.Code < 400 {
			t.Fatal("dangerous request accepted", w.Body.String())
		}
		catalogTestNoWrite(t, fx, before)
	}
	if out := choiceTestApply(t, fx, s, []catalogChoice{{Key: key, Choice: "local"}}); out.State != "applied" {
		t.Fatal(out)
	}
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	if choiceTestHas(s, key) {
		t.Fatal("available future source ignored local preference")
	}
}

func TestCatalogChoicesRejectUnknownDuplicateAndClientValues(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	key := "monster:1:stats.hp"
	for _, choices := range []any{
		[]catalogChoice{{Key: key, Choice: "local"}, {Key: key, Choice: "local"}}, []catalogChoice{{Key: key, Choice: "source"}, {Key: key, Choice: "local"}}, []catalogChoice{{Key: "monster:1:arbitrary/path", Choice: "source"}}, []catalogChoice{{Key: key, Choice: "anything"}},
		[]any{map[string]any{"key": key, "choice": "source", "source_value": 999}}, []any{map[string]any{"key": key, "choice": "source", "field": "stats.hp"}},
	} {
		w := catalogTestUpdate(t, fx.rt, "apply", map[string]any{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": choices})
		if w.Code < 400 {
			t.Fatal("invalid choice request accepted")
		}
		catalogTestNoWrite(t, fx, before)
	}
}

func TestCatalogChoicesPartialSelectionPreservesUnselectedEntitiesAndRules(t *testing.T) {
	plan, before := choiceTestPlan(t, func(c *catalog.Catalog) {
		c.Monsters[0].Stats.HP = 130
		c.Monsters[0].DataNote = "已确认关系备注"
		c.Monsters[1].Stats.Speed = 120
		c.Skills[0].Description = "changed"
	})
	c, _, err := plan.resolve([]catalogChoice{{Key: "monster:1:stats.hp", Choice: "source"}})
	if err != nil {
		t.Fatal(err)
	}
	old, _ := catalog.Parse(before)
	old.Monsters[0].Stats.HP = 130
	c.Extensions = nil
	data, _ := catalog.Marshal(c)
	want, _ := catalog.Marshal(old)
	if !bytes.Equal(data, want) {
		t.Fatal("partial choice applied other proposal changes")
	}
}

func TestCatalogChoicesEvolutionAndLeaderFieldsAreIndependentAndClearOptionalEdges(t *testing.T) {
	plan, _ := choiceTestPlan(t, func(c *catalog.Catalog) {
		c.Monsters[0].EvolutionMembers = []int{1, 2}
		c.Monsters[0].LeaderOfID = 2
		c.Monsters[0].IsLeaderForm = true
	})
	c, _, err := plan.resolve([]catalogChoice{{Key: "monster:1:evolution", Choice: "source"}})
	if err != nil {
		t.Fatal(err)
	}
	if c.Monsters[0].EvolvesFromID != 0 || len(c.Monsters[0].EvolutionMembers) != 2 || c.Monsters[0].LeaderOfID != 0 {
		t.Fatal("evolution selection changed leader source")
	}
	c.Monsters[0].EvolvesFromID = 2
	before, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	c.Monsters[0].EvolvesFromID = 0
	c.Monsters[0].EvolutionMembers = []int{}
	f, err := catalog.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	p, err := buildCatalogChoicePlan(before, &officialdex.Proposal{Files: officialdex.LegacyFiles{Monsters: f.Monsters, Moves: f.Moves, Types: f.Types, Wiki: f.Wiki}})
	if err != nil {
		t.Fatal(err)
	}
	next, _, err := p.resolve([]catalogChoice{{Key: "monster:1:evolution", Choice: "source"}})
	if err != nil {
		t.Fatal(err)
	}
	if next.Monsters[0].EvolvesFromID != 0 || next.Monsters[0].EvolutionMembers == nil || len(next.Monsters[0].EvolutionMembers) != 0 {
		t.Fatal("explicit empty source failed to clear optional predecessor")
	}
}

func TestCatalogChoicesUnavailableLeaderDoesNotDisableValidEvolution(t *testing.T) {
	plan, _ := choiceTestPlan(t, func(c *catalog.Catalog) { c.Monsters[0].EvolutionMembers = []int{1, 2} })
	// Rebuild against the same complete canonical proposal with explicit source diagnostic.
	source, _, err := plan.resolve([]catalogChoice{{Key: "monster:1:evolution", Choice: "source"}})
	if err != nil {
		t.Fatal(err)
	}
	files, err := catalog.ExportLegacy(source)
	if err != nil {
		t.Fatal(err)
	}
	p, err := buildCatalogChoicePlan(plan.before, &officialdex.Proposal{Files: officialdex.LegacyFiles{Monsters: files.Monsters, Moves: files.Moves, Types: files.Types, Wiki: files.Wiki}, Issues: []officialdex.Issue{{Code: "source_relationship_unavailable", Field: "leader_of_id", Entity: "monster", ID: 1, Severity: "warning"}}})
	if err != nil {
		t.Fatal(err)
	}
	flags := map[string]bool{}
	for _, item := range p.candidates {
		flags[item.Key] = item.SourceAvailable
	}
	if !flags["monster:1:evolution"] || flags["monster:1:leader_form"] {
		t.Fatal("source families were conflated", flags)
	}
}

func TestCatalogChoicesInvalidDependencyCombinationDoesNotWriteMemory(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	before := fx.rt.store.Current()
	source := choiceTestSourceChange(t, 1, func(src map[string]any) {
		row := src["d"].(map[string]any)["101"].(map[string]any)
		skills := row["sk"].(map[string]any)["s"].([]any)
		copy := map[string]any{}
		for k, v := range skills[0].(map[string]any) {
			copy[k] = v
		}
		copy["nm"] = "新技能"
		row["sk"].(map[string]any)["s"] = append(skills, copy)
	})
	s := catalogTestPreview(t, fx, source)
	if !choiceTestHas(s, "monster:1:learning") {
		t.Fatal("missing composite learning candidate")
	}
	w := catalogTestUpdate(t, fx.rt, "apply", map[string]any{"task_id": s.TaskID, "base_revision": s.BaseRevision, "acknowledge_reviews": true, "choices": []catalogChoice{{Key: "monster:1:learning", Choice: "source"}}})
	if w.Code < 400 || !strings.Contains(w.Body.String(), "候选组合无效") {
		t.Fatal("new skill dependency silently accepted", w.Body.String())
	}
	catalogTestNoWrite(t, fx, before)
	if len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("invalid combination persisted memory")
	}
}

func TestCatalogChoicesAtomicMemoryFailureAndClearRevisionProtection(t *testing.T) {
	var reject atomic.Bool
	fx := catalogTestNew(t, 1, false, func(from, to string) error {
		if reject.Load() && filepath.Base(to) == "current.json" {
			return errors.New("choice commit rejected")
		}
		return catalogstore.ReplaceFile(from, to)
	})
	original := fx.rt.store.Current()
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	reject.Store(true)
	out := choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local"}})
	if out.State != "error" || fx.rt.store.Current().Revision != original.Revision || len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("failed data transaction committed memory")
	}
	reopened, err := catalogstore.Open(fx.opts)
	if err != nil || reopened.Current().Revision != original.Revision {
		t.Fatal("failed transaction leaked after restart", err)
	}
	reject.Store(false)
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local"}, {Key: "monster:1:stats.speed", Choice: "source"}})
	committed := fx.rt.store.Current()
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	if err = fx.rt.update.ClearChoices(original.Revision, nil, true); !errors.Is(err, catalogstore.ErrConflict) {
		t.Fatal("stale clear accepted", err)
	}
	reject.Store(true)
	if err = fx.rt.update.ClearChoices(committed.Revision, nil, true); err == nil {
		t.Fatal("failed clear reported success")
	}
	if fx.rt.store.Current().Revision != committed.Revision || len(choiceTestMemory(t, fx).Entries) != 2 || fx.rt.update.Status().TaskID != s.TaskID {
		t.Fatal("failed clear mutated preview or memory")
	}
	reject.Store(false)
	if err = fx.rt.update.ClearChoices(committed.Revision, []string{"monster:1:stats.hp"}, false); err != nil {
		t.Fatal(err)
	}
	if fx.rt.update.Status().State != "idle" || len(choiceTestMemory(t, fx).Entries) != 1 {
		t.Fatal("clear did not invalidate preview/remove one entry")
	}
	if err = fx.rt.update.Apply(s.TaskID, s.BaseRevision, true, catalogTestSourceChoices(s)); err == nil {
		t.Fatal("old preview applied after clear")
	}
	if choiceTestCurrent(t, fx).Monsters[0].Stats.Speed != 105 {
		t.Fatal("clear reverted committed data")
	}
	if err = fx.rt.update.ClearChoices(fx.rt.store.Current().Revision, nil, true); err != nil {
		t.Fatal(err)
	}
	if len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("all clear failed")
	}
}

func TestCatalogChoicesMemoryRestoredAfterStoreAndManagerRemount(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local"}})
	reopened, err := catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
	rt := &catalogRuntime{store: reopened}
	rt.update = newCatalogUpdateManager(rt)
	defer rt.update.Close()
	w := httptest.NewRecorder()
	rt.handleUpdate(w, catalogTestRequest(http.MethodGet, "/api/catalog/update/choices", nil))
	var status catalogUpdateStatus
	if err = json.Unmarshal(w.Body.Bytes(), &status); err != nil || w.Code != 200 || len(status.RememberedChoices) != 1 {
		t.Fatal("memory not restored", err, w.Body.String())
	}
	rt.update.fetchSource = func(context.Context) ([]byte, error) { return catalogTestSource(t, 1, false), nil }
	if err = rt.update.Start(); err != nil {
		t.Fatal(err)
	}
	catalogTestWait(t, rt.update)
	if choiceTestHas(rt.update.Status(), "monster:1:stats.hp") {
		t.Fatal("remount forgot local choice")
	}
}

func TestCatalogChoicesImagesAreOnePolicyAndNeverImportUnselectedEntity(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	source := catalogTestSource(t, 2, true)
	var calls atomic.Int32
	fx.rt.update.fetchImage = func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		return catalogTestImage(t, 16, 16, "png"), nil
	}
	s := catalogTestPreview(t, fx, source)
	images := 0
	for _, item := range s.Candidates {
		if item.Field == "image_policy" {
			images++
			if item.Entity != "catalog" || item.ID != 0 {
				t.Fatal(item)
			}
		}
	}
	if images != 1 {
		t.Fatal("must expose exactly one policy, not fake pixel differences")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local"}})
	if calls.Load() != 0 {
		t.Fatal("unselected policy downloaded images")
	}
	s = catalogTestPreview(t, fx, source)
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "catalog:0:image_policy", Choice: "source"}})
	if calls.Load() != 1 || len(choiceTestCurrent(t, fx).Monsters) != 1 {
		t.Fatal("image policy imported unselected new monster", calls.Load())
	}
}

func TestCatalogChoicesDeclinedAdditionsDoNotShareProvisionalIDPolicies(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 2, false))
	firstKey := ""
	for _, item := range s.Candidates {
		if item.Entity == "monster" && item.Kind == "add" {
			firstKey = item.Key
		}
	}
	if firstKey == "" {
		t.Fatal("missing new entity")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: firstKey, Choice: "local"}})
	other := choiceTestSourceChange(t, 2, func(src map[string]any) {
		r := src["d"].(map[string]any)["102"].(map[string]any)
		r["nm"] = "另一个新精灵"
		r["fn"] = "另一个新精灵"
		r["n"] = "NO.003"
		for _, value := range src["l"].([]any) {
			entry := value.(map[string]any)
			if entry["i"] == float64(102) {
				entry["nm"] = r["nm"]
				entry["fn"] = r["fn"]
				entry["n"] = r["n"]
			}
		}
	})
	s = catalogTestPreview(t, fx, other)
	secondKey := ""
	for _, item := range s.Candidates {
		if item.Entity == "monster" && item.Kind == "add" {
			secondKey = item.Key
		}
	}
	if secondKey == "" || secondKey == firstKey {
		t.Fatal("different identities share provisional key")
	}
	choiceTestApply(t, fx, s, []catalogChoice{{Key: secondKey, Choice: "local"}})
	if len(choiceTestMemory(t, fx).Entries) != 2 {
		t.Fatal("declined identity policy overwritten")
	}
	s = catalogTestPreview(t, fx, catalogTestSource(t, 2, false))
	if choiceTestHas(s, firstKey) {
		t.Fatal("declined entity asked again")
	}
	reopened, err := catalogstore.Open(fx.opts)
	if err != nil {
		t.Fatal(err)
	}
	rt := &catalogRuntime{store: reopened}
	rt.update = newCatalogUpdateManager(rt)
	defer rt.update.Close()
	s = catalogTestPreview(t, &catalogTestFixture{rt: rt}, catalogTestSource(t, 2, false))
	if choiceTestHas(s, firstKey) || len(s.RememberedChoices) != 2 {
		t.Fatal("restart mixed provisional identities")
	}
}

func TestCatalogChoicesAcceptedNewEntityFollowsFutureSourceFields(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 2, false))
	key := ""
	for _, item := range s.Candidates {
		if item.Entity == "monster" && item.Kind == "add" {
			key = item.Key
		}
	}
	if key == "" {
		t.Fatal("missing addition")
	}
	out := choiceTestApply(t, fx, s, []catalogChoice{{Key: key, Choice: "source"}})
	if out.State != "applied" {
		t.Fatal(out)
	}
	if choiceTestMemory(t, fx).Entries["monster:2:entity"].Choice != "source" {
		t.Fatal("new source policy not bound to committed local ID")
	}
	source := choiceTestSourceChange(t, 2, func(src map[string]any) { src["d"].(map[string]any)["102"].(map[string]any)["hp"] = 131 })
	s = catalogTestPreview(t, fx, source)
	if choiceTestHas(s, "monster:2:stats.hp") || s.AutomaticSourceChanges < 1 {
		t.Fatal("accepted entity forgot source policy")
	}
	choiceTestApply(t, fx, s, []catalogChoice{})
	if choiceTestCurrent(t, fx).Monsters[1].Stats.HP != 131 || choiceTestCurrent(t, fx).Monsters[0].Stats.HP != 90 {
		t.Fatal("entity source policy applied wrong ID")
	}
}

func TestCatalogChoicesRememberedLocalReviewDoesNotAskAgain(t *testing.T) {
	fx := catalogTestNew(t, 2, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:2:identity", Choice: "local"}})
	s = catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	for _, issue := range s.Issues {
		if issue.Code == "local_only_monster" && issue.ID == 2 {
			t.Fatal("remembered local still listed as pending review")
		}
	}
	if err := fx.rt.update.Apply(s.TaskID, s.BaseRevision, false, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "source"}}); err != nil {
		t.Fatal("hidden review trapped apply", err)
	}
	catalogTestWait(t, fx.rt.update)
}

func TestCatalogChoicesMixedLeaderCombinationRejectsWithoutRemembering(t *testing.T) {
	fx := catalogTestNew(t, 2, false, nil)
	c := choiceTestCurrent(t, fx)
	c.Monsters[0].EvolutionMembers = []int{1, 2}
	c.Monsters[0].EvolvesFromID = 2
	data, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	before, err := fx.rt.store.Commit(data, fx.rt.store.Current().Revision, nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Monsters[0].EvolvesFromID = 0
	c.Monsters[0].LeaderOfID = 2
	c.Monsters[0].IsLeaderForm = true
	files, err := catalog.ExportLegacy(c)
	if err != nil {
		t.Fatal(err)
	}
	proposal := &officialdex.Proposal{Files: officialdex.LegacyFiles{Monsters: files.Monsters, Moves: files.Moves, Types: files.Types, Wiki: files.Wiki}}
	plan, err := buildCatalogChoicePlan(before.Data, proposal)
	if err != nil {
		t.Fatal(err)
	}
	m := fx.rt.update
	m.proposal = proposal
	m.choicePlan = plan
	m.status = catalogUpdateStatus{OK: true, State: "preview", TaskID: "mixed-test", BaseRevision: before.Revision, CanApply: true, Summary: map[string]any{}}
	if err = m.Apply("mixed-test", before.Revision, true, []catalogChoice{{Key: "monster:1:leader_form", Choice: "source"}}); err == nil {
		t.Fatal("mixed leader and predecessor accepted")
	}
	if fx.rt.store.Current().Revision != before.Revision || len(choiceTestMemory(t, fx).Entries) != 0 {
		t.Fatal("mixed source dependency saved policy")
	}
	if err = m.Apply("mixed-test", before.Revision, true, []catalogChoice{{Key: "monster:1:leader_form", Choice: "source"}, {Key: "monster:1:evolution", Choice: "source"}}); err != nil {
		t.Fatal(err)
	}
	catalogTestWait(t, m)
	if c = choiceTestCurrent(t, fx); c.Monsters[0].LeaderOfID != 2 || c.Monsters[0].EvolvesFromID != 0 {
		t.Fatal("valid composite choices lost")
	}
}

func TestCatalogChoicesClearHTTPGuardsAndBadKeys(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	s := catalogTestPreview(t, fx, catalogTestSource(t, 1, false))
	choiceTestApply(t, fx, s, []catalogChoice{{Key: "monster:1:stats.hp", Choice: "local"}})
	before := fx.rt.store.Current()
	for _, body := range []any{map[string]any{"base_revision": before.Revision, "keys": []string{"unknown"}}, map[string]any{"base_revision": before.Revision, "keys": []string{"monster:1:stats.hp", "monster:1:stats.hp"}}, map[string]any{"base_revision": before.Revision, "keys": []string{"monster:1:stats.hp"}, "all": true}, map[string]any{"base_revision": before.Revision, "all": true, "value": 100}} {
		w := catalogTestUpdate(t, fx.rt, "choices/clear", body)
		if w.Code < 400 || fx.rt.store.Current().Revision != before.Revision {
			t.Fatal("invalid memory clear accepted")
		}
	}
	for _, operation := range []string{"choices", "choices/clear"} {
		method := http.MethodGet
		body := []byte(nil)
		if operation == "choices/clear" {
			method = http.MethodPost
			body = catalogTestJSON(t, map[string]any{"base_revision": before.Revision, "all": true})
		}
		r := catalogTestRequest(method, "/api/catalog/update/"+operation, body)
		r.Header.Set("Origin", "http://evil.invalid")
		w := httptest.NewRecorder()
		fx.rt.handleUpdate(w, r)
		if w.Code != 403 || fx.rt.store.Current().Revision != before.Revision {
			t.Fatal("memory endpoint bypassed same-origin guard")
		}
	}
}

func TestCatalogChoicesUnknownPolicyVersionStopsCheckWithoutReplacingAnything(t *testing.T) {
	fx := catalogTestNew(t, 1, false, nil)
	snap := fx.rt.store.Current()
	c := choiceTestCurrent(t, fx)
	c.Extensions = catalog.Extensions{catalogChoicesExtension: json.RawMessage(`{"version":999,"entries":{}}`)}
	data, _ := catalog.Marshal(c)
	if _, err := fx.rt.store.Commit(data, snap.Revision, nil); err != nil {
		t.Fatal(err)
	}
	before := fx.rt.store.Current()
	fx.rt.update.fetchSource = func(context.Context) ([]byte, error) { return catalogTestSource(t, 1, false), nil }
	if err := fx.rt.update.Start(); err != nil {
		t.Fatal(err)
	}
	catalogTestWait(t, fx.rt.update)
	if fx.rt.update.Status().State != "error" || fx.rt.store.Current().Revision != before.Revision {
		t.Fatal("unknown memory version overwritten")
	}
}
