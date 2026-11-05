package officialdex

import (
	"bytes"
	"crypto/sha256"
	"os"
	"sort"
	"testing"

	canonical "xhmwiki/internal/catalog"
)

// Opt-in read-only integration audit. Normal tests need no checkout data or
// backup fixtures. Both paths must be explicitly supplied; no files are written.
func TestReadOnlyCurrentCatalogReviewedRoundTrip(t *testing.T) {
	catalogPath, sourcePath := os.Getenv("OFFICIALDEX_AUDIT_CATALOG"), os.Getenv("OFFICIALDEX_AUDIT_SOURCE")
	if catalogPath == "" && sourcePath == "" {
		t.Skip("set OFFICIALDEX_AUDIT_CATALOG and OFFICIALDEX_AUDIT_SOURCE for a read-only real audit")
	}
	if catalogPath == "" || sourcePath == "" {
		t.Fatal("both audit paths are required")
	}
	catalogBytes, err := os.ReadFile(catalogPath)
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	before, err := canonical.Parse(catalogBytes)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Monsters) != 619 && len(before.Monsters) != 622 {
		t.Fatalf("expected authorized 619/622-monster input, got %d", len(before.Monsters))
	}
	local := exportCanonical(t, before)
	p := proposal(t, local, source)
	if p.HasBlockingIssues() || p.Stats.MatchedMonsters != len(before.Monsters)-1 || p.Stats.AddedMonsters != 622-len(before.Monsters) || p.Stats.PreservedLocalMonsters != 1 || p.Stats.AddedMoves != 0 {
		t.Fatalf("unexpected real proposal: %+v / %+v", p.Stats, p.Issues)
	}
	after := importProposal(t, p)
	if len(after.Monsters) != 622 || len(after.Skills) != len(before.Skills) || !equal(before.SkillRules, after.SkillRules) {
		t.Fatal("canonical count/master-skill/rule contract failed")
	}
	for _, old := range before.Monsters {
		m := canonicalMonster(t, after, old.ID)
		if m.MainFormID != old.MainFormID || !equal(m.Images, old.Images) {
			t.Fatalf("existing relation/image changed for %d", m.ID)
		}
		for _, alias := range old.Aliases {
			if !hasAlias(m.Aliases, alias) {
				t.Fatalf("old canonical alias lost for %d: %s", m.ID, alias)
			}
		}
		if m.ID == 619 && !equal(m, old) {
			t.Fatal("local-only placeholder changed")
		}
	}
	for _, r := range reviewedIdentities {
		m := canonicalMonster(t, after, r.localID)
		if m.Name != r.name || m.Form != r.newForm() || !hasAlias(m.Aliases, r.oldName) {
			t.Fatalf("real reviewed identity/old bare alias missing: %+v", m)
		}
	}
	for i, sid := range []string{"344", "382", "383"} {
		m := canonicalMonster(t, after, 620+i)
		if m.SourceRef == nil || m.SourceRef.ID != sid || m.MainFormID != 0 || m.EvolvesFromID != 0 || m.FormCategory != "无多形态" {
			t.Fatalf("new identity %d incorrect: %+v", m.ID, m)
		}
		if m.EvolutionStage != "首领形态" || !m.IsLeaderForm || m.LeaderOfID != []int{343, 379, 380}[i] {
			t.Fatalf("new moon stage guessed: %+v", m)
		}
	}
	issues := map[string]int{}
	for _, issue := range p.Issues {
		issues[issue.Code]++
		if issue.Code == "local_only_monster" && issue.ID != 619 {
			t.Fatalf("unexpected unmapped monster: %+v", issue)
		}
	}
	for _, forbidden := range []string{"legend_source_mapping", "inherited_learnset_difference", "local_learning_preserved", "evolution_relationship_difference", "new_identity_not_proven", "new_form_identity_not_proven"} {
		if issues[forbidden] != 0 {
			t.Fatalf("resolved review repeated: %s", forbidden)
		}
	}
	// Verify each effective surface against the fully validated official table.
	exported := exportCanonical(t, after)
	monsters, _ := objectArray(exported.Monsters, "monsters")
	x, err := makeLocalIndex(monsters, decodeObject(t, exported.Wiki), &Proposal{})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseSource(source, &Proposal{})
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range after.Monsters {
		if m.ID == 619 {
			continue
		}
		s := parsed.byID[m.SourceRef.ID]
		if s == nil || !s.learnOK || len(s.skills) == 0 || !sameLearning(effectiveLearning(m.ID, x, map[int]bool{}), s.skills) {
			t.Fatalf("real effective official learning mismatch: %d", m.ID)
		}
	}
	second := proposal(t, exported, source)
	if len(second.Changes) != 0 || second.HasBlockingIssues() || second.Stats.AddedMonsters != 0 || second.Stats.MatchedMonsters != 621 || second.Stats.PreservedLocalMonsters != 1 {
		t.Fatalf("real canonical second proposal not idempotent: %+v / %+v", second.Changes, second.Issues)
	}
	for _, file := range []struct {
		path     string
		original []byte
	}{{catalogPath, catalogBytes}, {sourcePath, source}} {
		current, err := os.ReadFile(file.path)
		if err != nil || !bytes.Equal(current, file.original) {
			t.Fatalf("read-only audit input changed: %s / %v", file.path, err)
		}
	}
	cleared, leaders, ordinaryRepairs, changedMembers := []int{}, []int{}, []int{}, []int{}
	for _, old := range before.Monsters {
		m := canonicalMonster(t, after, old.ID)
		if old.EvolvesFromID != 0 && m.EvolvesFromID == 0 {
			cleared = append(cleared, m.ID)
		}
		if m.LeaderOfID != 0 {
			leaders = append(leaders, m.ID)
		}
		if m.EvolvesFromID != 0 && m.EvolvesFromID != old.EvolvesFromID {
			ordinaryRepairs = append(ordinaryRepairs, m.ID)
		}
		if !equal(old.EvolutionMembers, m.EvolutionMembers) {
			changedMembers = append(changedMembers, m.ID)
		}
	}
	t.Logf("RELATIONS old ordinary cleared=%d ids=%v; independent leaders=%d ids=%v; ordinary repairs=%v; member lists replaced=%d", len(cleared), cleared, len(leaders), leaders, ordinaryRepairs, len(changedMembers))
	for _, r := range reviewedRelations {
		m := canonicalMonster(t, after, r.id)
		t.Logf("CONFIRMED %d <- %d => ordinary=%d leader=%d members=%v", r.id, r.parent, m.EvolvesFromID, m.LeaderOfID, m.EvolutionMembers)
	}
	if canonicalMonster(t, after, 479).EvolvesFromID != canonicalMonster(t, before, 479).EvolvesFromID {
		t.Fatal("479 predecessor guessed")
	}
	detached, learningChanges := []int{}, 0
	setChanged, addedRelations, removedRelations := []int{}, 0, 0
	for _, change := range p.Changes {
		if change.Entity == "monster" && change.Field == "learnset_mode" && change.After == "own" {
			detached = append(detached, change.ID)
		}
		if change.Entity == "wiki" && change.Field == "skills" {
			learningChanges++
			sets := []map[string]bool{{}, {}}
			for index, raw := range []any{change.Before, change.After} {
				for _, row := range raw.([]any) {
					sets[index][equivalentLearningKey(asObject(row))] = true
				}
			}
			if !equal(sets[0], sets[1]) {
				setChanged = append(setChanged, change.ID)
			}
			for key := range sets[0] {
				if !sets[1][key] {
					removedRelations++
				}
			}
			for key := range sets[1] {
				if !sets[0][key] {
					addedRelations++
				}
			}
		}
	}
	sort.Ints(detached)
	sort.Ints(setChanged)
	t.Logf("READ-ONLY VERIFIED catalog_sha256=%x source_sha256=%x first=%+v changes=%d learningChanges=%d setChanged=%v addedRelations=%d removedRelations=%d detached=%v issues=%v; canonical=622 second_changes=%d", sha256.Sum256(catalogBytes), sha256.Sum256(source), p.Stats, len(p.Changes), learningChanges, setChanged, addedRelations, removedRelations, detached, issues, len(second.Changes))
}
