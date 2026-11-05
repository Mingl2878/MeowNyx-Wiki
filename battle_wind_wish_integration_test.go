package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestBattleWindWishActualEnrichment(t *testing.T) {
	paths := []string{os.Getenv("WW_INPUT"), os.Getenv("WW_BEFORE"), os.Getenv("WW_DATABASE"), os.Getenv("WW_CATALOG")}
	for _, p := range paths {
		if p == "" {
			t.Skip("explicit frozen wind/wish fixture opt-in")
		}
	}
	inputs := map[string][]byte{}
	for _, p := range paths {
		b, e := os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
		inputs[p] = b
	}
	records, _, err := DecodeBattleImport(inputs[paths[0]])
	if err != nil || len(records) != 1 {
		t.Fatal("candidate", err)
	}
	candidate := records[0]
	var before BattleRecord
	if err = json.Unmarshal(inputs[paths[1]], &before); err != nil {
		t.Fatal(err)
	}
	if len(candidate.Events) != 283 || candidate.Quality.Actions {
		t.Fatal("changed capture completeness/count")
	}
	patch := map[string]string{"rkpp:action:5:30:6:switch": "forced", "rkpp:action:5:30:73:switch": "self"}
	restored, _ := battleClone(candidate)
	found := 0
	oldByID := map[string]BattleEvent{}
	for _, e := range before.Events {
		oldByID[e.ID] = e
	}
	for i, e := range candidate.Events {
		if reason, ok := patch[e.ID]; ok {
			found++
			if e.Combat == nil || e.Combat.LeaveReason != reason || e.Combat.ActionID != "rkpp:action:5:26:1:cast" {
				t.Fatal("incorrect wind repair", e)
			}
			if oldByID[e.ID].Combat == nil || oldByID[e.ID].Combat.LeaveReason != "unknown" {
				t.Fatal("not the approved unknown source")
			}
			restored.Events[i].Combat = oldByID[e.ID].Combat
		}
	}
	if found != 2 || !reflect.DeepEqual(restored, before) {
		t.Fatal("changed facts beyond approved two wind envelopes")
	}
	merged, err := MergeBattleRecord(before, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if cbJSON(merged) != cbJSON(candidate) {
		t.Fatal("candidate differs from canonical compatible merge")
	}
	dbPath := filepath.Join(t.TempDir(), "records.sqlite")
	if err = os.WriteFile(dbPath, inputs[paths[2]], 0600); err != nil {
		t.Fatal(err)
	}
	s, err := NewBattleService(dbPath, func() ([]byte, error) { return append([]byte{}, inputs[paths[3]]...), nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	if _, err = s.Record(ctx, before.ID); err != nil {
		t.Fatal(err)
	}
	var oldJSON string
	if err = s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", before.ID).Scan(&oldJSON); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(oldJSON)))
	result, err := s.Import(ctx, records, map[string]string{before.ID: hash})
	if err != nil || result.Imported != 1 {
		t.Fatalf("guarded import %+v %v", result, err)
	}
	stored, err := s.Record(ctx, before.ID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := cbJSON(stored)
	stats, err := s.Stats(ctx, BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	castSum := 0
	for _, row := range stats.SelfSkills {
		castSum += row.Casts
		if row.Kind == "wishImpact" {
			t.Fatal("fabricated an unproven wish cast")
		}
	}
	if castSum != 26 {
		t.Fatal("ordinary cast count changed", castSum)
	}
	haveMech := false
	for _, row := range stats.SelfPerformance.Species {
		if row.MonsterID == 501 {
			haveMech = true
			if row.Totals.Departures.Total != 1 || row.Totals.Departures.Self != 1 || row.Totals.Deaths != 0 || row.Totals.Entries != 1 || row.CarriedBattles != 1 {
				t.Fatal(row)
			}
			if len(row.DeparturesByOpponent) != 1 || row.DeparturesByOpponent[0].MonsterID != 132 || row.DeparturesByOpponent[0].Attribution != "facing" || row.DeparturesByOpponent[0].Totals.Self != 1 {
				t.Fatal("wrong source-time opponent", row.DeparturesByOpponent)
			}
			if row.RollerCoaster == nil || row.RollerCoaster.SuccessRate == nil || *row.RollerCoaster.SuccessRate != 1 || row.RollerCoaster.WinRate == nil || *row.RollerCoaster.WinRate != 0 {
				t.Fatal("roller changed")
			}
		}
	}
	if !haveMech {
		t.Fatal("missing mech")
	}
	// An old import cannot erase newly confirmed causes.
	result, err = s.Import(ctx, []BattleRecord{before})
	if err != nil || result.Duplicates != 1 {
		t.Fatalf("stale import %+v %v", result, err)
	}
	again, _ := s.Record(ctx, before.ID)
	if cbJSON(again) != snapshot {
		t.Fatal("old unknown replaced a confirmed cause")
	}
	conflict, _ := battleClone(candidate)
	for i := range conflict.Events {
		if conflict.Events[i].ID == "rkpp:action:5:30:73:switch" {
			conflict.Events[i].Combat.LeaveReason = "forced"
		}
	}
	if _, err = s.Import(ctx, []BattleRecord{conflict}); err == nil {
		t.Fatal("known conflicting cause accepted")
	}
	again, _ = s.Record(ctx, before.ID)
	if cbJSON(again) != snapshot {
		t.Fatal("conflict altered row")
	}
	// Flip the observation perspective in memory only: opponent401 was forced out by source501.
	reverse, _ := battleClone(candidate)
	reverse.ID = "mirrored-wind-fixture"
	reverse.Sides["me"], reverse.Sides["enemy"] = reverse.Sides["enemy"], reverse.Sides["me"]
	flip := func(v string) string {
		if v == "me" {
			return "enemy"
		}
		if v == "enemy" {
			return "me"
		}
		return v
	}
	for i := range reverse.Events {
		reverse.Events[i].Side = flip(reverse.Events[i].Side)
		reverse.Events[i].TargetSide = flip(reverse.Events[i].TargetSide)
	}
	rev := BuildBattlePerformance([]BattleRecord{reverse}, inputs[paths[3]])
	forced := false
	for _, row := range rev.Species {
		if row.MonsterID == 132 {
			for _, m := range row.DeparturesByOpponent {
				if m.MonsterID == 501 && m.Attribution == "cause" && m.Totals.Forced == 1 {
					forced = true
				}
			}
		}
	}
	if !forced {
		t.Fatal("other side of the same wind did not count as forced")
	}
	for key, value := range map[string]any{"WW_VALIDATED_OUTPUT": stored, "WW_STATS_OUTPUT": stats} {
		if out := os.Getenv(key); out != "" {
			f, e := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if e != nil {
				t.Fatal(e)
			}
			b, _ := json.MarshalIndent(value, "", "  ")
			_, e = f.Write(b)
			ce := f.Close()
			if e != nil || ce != nil {
				t.Fatal(e, ce)
			}
		}
	}
	for p, old := range inputs {
		b, e := os.ReadFile(p)
		if e != nil || !reflect.DeepEqual(old, b) {
			t.Fatal("changed source input", p)
		}
	}
}
