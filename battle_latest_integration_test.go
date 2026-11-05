package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLatestSeasonFilterExclusiveNanosecondBoundary(t *testing.T) {
	f, err := ParseBattleFilter(url.Values{"from": {"2026-10-29T04:00:00+08:00"}, "to": {"2026-11-05T04:00:00+08:00"}, "toExclusive": {"true"}, "rankSide": {"enemy"}, "rankMetric": {"rank"}, "rankMin": {"1"}, "rankMax": {"10000"}})
	if err != nil || !f.ToExclusive {
		t.Fatal(f, err)
	}
	r := domainFixture("season-nano")
	rank := 10000
	s := r.Sides["enemy"]
	s.Before.Rank = &rank
	r.Sides["enemy"] = s
	end, _ := time.Parse(time.RFC3339Nano, "2026-11-05T04:00:00+08:00")
	r.StartedAt = end.Add(-time.Nanosecond).Format(time.RFC3339Nano)
	if !MatchBattleRecord(r, f, nil) {
		t.Fatal("last nanosecond excluded")
	}
	r.StartedAt = end.Format(time.RFC3339Nano)
	if MatchBattleRecord(r, f, nil) {
		t.Fatal("exclusive boundary included")
	}
	for _, bad := range []url.Values{{"toExclusive": {"true"}}, {"to": {"2026-11-05"}, "toExclusive": {"yes"}}, {"to": {"2026-11-05"}, "toExclusive": {""}}} {
		if _, e := ParseBattleFilter(bad); e == nil {
			t.Fatal("accepted malformed exclusive boundary", bad)
		}
	}
}

func TestLatestActualIntegratedStats(t *testing.T) {
	dbpath, catpath := os.Getenv("BGS_ACTUAL_DATABASE"), os.Getenv("BGS_ACTUAL_CATALOG")
	if dbpath == "" || catpath == "" {
		t.Skip("explicit immutable actual fixture paths not supplied")
	}
	dbbytes, err := os.ReadFile(dbpath)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := os.ReadFile(catpath)
	if err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(t.TempDir(), "battle.sqlite")
	if err = os.WriteFile(temp, dbbytes, 0600); err != nil {
		t.Fatal(err)
	}
	service, err := NewBattleService(temp, func() ([]byte, error) { return append([]byte(nil), catalog...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	ctx := context.Background()
	id := "rkpp:1876469132858231449"
	before, err := service.Record(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	beforeBytes, _ := json.Marshal(before)
	existingRules, err := service.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	existingJSON, _ := json.Marshal(existingRules)
	originalService := service
	// Use a second TEMPORARY byte-for-byte database copy, not re-import (which
	// legitimately enriches identity provenance). Remove only its rule setup to
	// exercise a fresh installation while preserving the exact battle JSON.
	freshPath := filepath.Join(t.TempDir(), "fresh-defaults.sqlite")
	if err = os.WriteFile(freshPath, dbbytes, 0600); err != nil {
		t.Fatal(err)
	}
	service, err = NewBattleService(freshPath, func() ([]byte, error) { return append([]byte(nil), catalog...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err = service.Rules(ctx); err != nil {
		t.Fatal(err)
	}
	if service.path != freshPath || !filepath.IsAbs(freshPath) {
		t.Fatal("invalid temporary fixture path")
	}
	if _, err = service.db.ExecContext(ctx, "DELETE FROM battle_rules"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.db.ExecContext(ctx, "DELETE FROM battle_rule_state"); err != nil {
		t.Fatal(err)
	}
	rules, err := service.Rules(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 15 {
		t.Fatalf("defaults=%d", len(rules))
	}
	expectedNames := []string{"雨天", "雪天", "星陨", "毒队", "萌队", "虫队", "地武", "火队", "雷暴", "狼王", "火神", "高脚", "三三", "电鹿", "罗隐"}
	for i, n := range expectedNames {
		if rules[i].Name != n {
			t.Fatalf("default[%d]=%s", i, rules[i].Name)
		}
	}
	stats, err := service.Stats(ctx, BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if stats.MatchedBattles != 1 || stats.Archetypes == nil || stats.EnemyPerformance == nil || stats.SelfPerformance == nil || stats.Growth == nil {
		t.Fatalf("missing stats modules %+v", stats)
	}
	var wolf *BattleArchetypeTeam
	for i := range stats.Archetypes.Teams {
		if stats.Archetypes.Teams[i].ID == "wolf" {
			wolf = &stats.Archetypes.Teams[i]
		}
	}
	if wolf == nil || wolf.Battles != 1 || len(wolf.Components) != 6 {
		t.Fatalf("actual wolf assignment %+v", wolf)
	}
	observed := 0
	for _, event := range before.Events {
		if event.Side == "enemy" && event.Kind == "skill" && event.Phase == "executed" && event.SkillID > 0 && event.ProtocolSkillID != "700001000" {
			observed++
		}
	}
	casts := 0
	for _, component := range wolf.Components {
		total := 0
		for _, skill := range component.SkillUsage {
			total += skill.Casts
			if skill.TotalCasts != component.UsageTotalCasts {
				t.Fatal("wrong per-component denominator")
			}
		}
		if total != component.UsageTotalCasts {
			t.Fatal("missing component skill uses")
		}
		casts += total
		if component.Profile.IVSamples["hp"] != 1 || component.Profile.NatureSamples["hp"] != 1 || component.Profile.IVConditionalSamples["hp"] != 1 || component.Profile.NatureConditionalSamples["hp"] != 1 {
			t.Fatalf("conditional HP lost for %d: %+v", component.MonsterID, component.Profile)
		}
		if component.Profile.IVDistributions["hp"]["60"] != 1 {
			t.Fatal("unexpected HP conditional value")
		}
		for _, stat := range []string{"attack", "magic_attack", "defense", "magic_defense", "speed"} {
			if component.Profile.IVSamples[stat] != 0 || component.Profile.NatureSamples[stat] != 0 {
				t.Fatalf("unsupported profile guessed: %d %s", component.MonsterID, stat)
			}
		}
	}
	if casts != observed || casts == 0 {
		t.Fatalf("observed enemy actions=%d, scoped=%d", observed, casts)
	}
	for _, side := range [][]BattleSpeciesGrowth{stats.Growth.Me, stats.Growth.Enemy} {
		for _, pet := range side {
			if pet.Trait != nil && pet.Trait.Average != nil {
				t.Fatal("partial actual capture invented complete trait average")
			}
			for _, skill := range pet.Skills {
				if skill.Average != nil {
					t.Fatal("partial actual capture invented complete skill average")
				}
			}
		}
	}
	after, err := service.Record(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	afterBytes, _ := json.Marshal(after)
	if string(beforeBytes) != string(afterBytes) {
		t.Fatal("derived statistics rewrote original battle")
	}
	preservedRules, readErr := originalService.Rules(ctx)
	preservedJSON, _ := json.Marshal(preservedRules)
	if readErr != nil || string(preservedJSON) != string(existingJSON) {
		t.Fatal("existing custom rules overwritten", readErr)
	}
	originalAfter, readErr := originalService.Record(ctx, id)
	originalAfterBytes, _ := json.Marshal(originalAfter)
	if readErr != nil || string(originalAfterBytes) != string(beforeBytes) {
		t.Fatal("original fixture record changed", readErr)
	}
	var rows int
	if err = service.db.QueryRowContext(ctx, "SELECT count(*) FROM battle_rules").Scan(&rows); err != nil || rows != 0 {
		t.Fatal("default read wrote rule rows", rows, err)
	}
	list, err := service.List(ctx, BattleFilter{}, 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	if output := os.Getenv("BGS_ACTUAL_UI_OUTPUT"); output != "" {
		payload := map[string]any{"stats": stats, "rules": rules, "revision": battleRulesRevision(rules), "record": before, "list": list}
		data, e := json.MarshalIndent(payload, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		file, e := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			t.Fatal(e)
		}
		_, e = file.Write(data)
		closeErr := file.Close()
		if e != nil || closeErr != nil {
			t.Fatal(e, closeErr)
		}
	}
	sum := sha256.Sum256(beforeBytes)
	t.Logf("raw semantic hash unchanged %s; enemy casts=%d; default wolf=1; conditional HP=6", hex.EncodeToString(sum[:]), casts)
}
