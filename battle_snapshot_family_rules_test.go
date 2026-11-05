package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"xhmwiki/internal/catalog"
)

func TestStoreFamilyRulesStatsPinsSingleCatalogForEveryProjection(t *testing.T) {
	dataA := familyRulesCatalog(t)
	changed, err := catalog.Parse(dataA)
	if err != nil {
		t.Fatal(err)
	}
	hp := 0
	for i := range changed.Monsters {
		if changed.Monsters[i].ID == 14 {
			hp = changed.Monsters[i].Stats.HP
			changed.Monsters[i].Stats.HP += 100
			changed.Monsters[i].LeaderOfID = 0
			changed.Monsters[i].TraitID = changed.Monsters[0].TraitID
		}
	}
	for i := range changed.Skills {
		if changed.Skills[i].ID == 113 {
			changed.Skills[i].Name = "不同快照的技能"
			changed.Skills[i].Category = "Status"
		}
	}
	dataB, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := catalog.Parse(dataB); err != nil {
		t.Fatal("invalid isolated second catalog", err)
	}
	if hp == 0 {
		t.Fatal("missing real leader identity")
	}

	r := familyRulesRecord("single-catalog", 14)
	r.Sides["enemy"].Pets[0].Level = familyUsageInt(60)
	r.Sides["enemy"].Pets[0].InitialSkills = &BattleInitialSkills{SkillIDs: []int{113}, Complete: true}
	r.Quality.Actions = true
	health := battleInferenceStat(hp, "hp", 0, 60, 60)
	r.Events = []BattleEvent{
		{ID: "initial-hp", Kind: "resource", Phase: "executed", Side: "enemy", Actor: "a", StateStage: "initial", HPMax: familyUsageInt(health), HPAfter: familyUsageInt(health)},
		familyUsageCast("first-fire", "enemy", "a", 113, 1),
		familyUsageCast("second-fire", "enemy", "a", 113, 2),
	}
	for _, mode := range []string{"changed-catalog", "reader-error"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			s := familyRulesService(t, filepath.Join(t.TempDir(), "pinned.sqlite"), func() ([]byte, error) {
				calls++
				if calls == 1 {
					return dataA, nil
				}
				if mode == "reader-error" {
					return nil, errors.New("second read must never happen")
				}
				return dataB, nil
			})
			ctx := context.Background()
			if _, err := s.Import(ctx, []BattleRecord{r}); err != nil {
				t.Fatal(err)
			}
			raw, err := s.Record(ctx, r.ID)
			if err != nil {
				t.Fatal(err)
			}
			rules, err := defaultBattleRules()
			if err != nil {
				t.Fatal(err)
			}
			rules, err = battlePrepareRuleFamilies(rules, dataA)
			if err != nil {
				t.Fatal(err)
			}
			records := []BattleRecord{raw}
			view, inference := PrepareBattleInference(records, dataA)
			want := BuildBattleStats(view, rules)
			want.Inference = inference
			want.Growth = BuildBattleGrowthStats(records, dataA)
			want.SelfPerformance = BuildBattlePerformance(records, dataA)
			want.EnemyPerformance = BuildBattleEnemyPerformance(records, dataA)
			want.Archetypes = BuildBattleArchetypeStats(view, rules)
			_, differentInference := PrepareBattleInference(records, dataB)
			if cbJSON(inference) == cbJSON(differentInference) || cbJSON(want.Growth) == cbJSON(BuildBattleGrowthStats(records, dataB)) || cbJSON(want.EnemyPerformance) == cbJSON(BuildBattleEnemyPerformance(records, dataB)) {
				t.Fatal("fixture must distinguish catalog A/B for inference, growth and performance")
			}
			calls = 0
			got, err := s.Stats(ctx, BattleFilter{TeamRuleID: "fire-god"})
			if err != nil || calls != 1 {
				t.Fatalf("Stats must read exactly one catalog, got %d reads, error %v", calls, err)
			}
			if got.Revision == "" {
				t.Fatal("missing same-snapshot revision")
			}
			want.Revision = got.Revision
			if cbJSON(got) != cbJSON(want) {
				t.Fatal("Stats mixed catalog generations across filtering/inference/growth/performance/archetypes")
			}
			stored, err := s.Record(ctx, r.ID)
			if err != nil || cbJSON(stored) != cbJSON(raw) {
				t.Fatal("derived pinned view changed raw record", err)
			}
		})
	}
}

func TestStoreFamilyRulesSnapshotOwnsCatalogBytesAndReportsReaderFailure(t *testing.T) {
	ctx := context.Background()
	original := familyRulesCatalog(t)
	source := append([]byte{}, original...)
	s := familyRulesService(t, filepath.Join(t.TempDir(), "owned.sqlite"), func() ([]byte, error) { return source, nil })
	_, rules, captured, err := s.snapshotWithCatalog(ctx, BattleFilter{})
	if err != nil || len(rules) != 15 || !bytes.Equal(captured, original) {
		t.Fatal("snapshot", err)
	}
	source[0] = '!'
	if !bytes.Equal(captured, original) {
		t.Fatal("snapshot retained reader-owned mutable buffer")
	}
	captured[1] = '!'
	if source[1] != original[1] {
		t.Fatal("returned snapshot mutates reader storage")
	}

	calls := 0
	failed := familyRulesService(t, filepath.Join(t.TempDir(), "failure.sqlite"), func() ([]byte, error) { calls++; return nil, errors.New("unavailable catalog") })
	out, err := failed.Stats(ctx, BattleFilter{})
	if !errors.Is(err, errBattleMapping) || calls != 1 || !reflect.DeepEqual(out, BattleStats{}) {
		t.Fatalf("reader failure was swallowed: calls=%d out=%+v err=%v", calls, out, err)
	}
}
