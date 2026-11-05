package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Optional real-source, sanitized identity fixture. Databases always live in
// t.TempDir; only copies/normalized input files are read. No actual profile I/O.
func TestBattleIdentityReconstructionFixture(t *testing.T) {
	input := os.Getenv("XHM_IDENTITY_INPUT")
	if input == "" {
		t.Skip("set explicit sanitized identity fixture paths")
	}
	read := func(name string) []byte {
		p := os.Getenv(name)
		if !filepath.IsAbs(p) {
			t.Fatal("absolute fixture path required", name)
		}
		b, e := os.ReadFile(p)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	originalBytes := read("XHM_IDENTITY_ORIGINAL")
	catalogue := read("XHM_IDENTITY_CATALOG")
	var original BattleRecord
	if err := json.Unmarshal(originalBytes, &original); err != nil {
		t.Fatal(err)
	}
	incoming, _, err := DecodeBattleImport(read("XHM_IDENTITY_INPUT"))
	if err != nil {
		t.Fatal(err)
	}
	if len(incoming) != 1 || incoming[0].ID != original.ID {
		t.Fatal("expected enrichment of exactly one existing battle")
	}
	service, err := NewBattleService(filepath.Join(t.TempDir(), "records.sqlite"), func() ([]byte, error) { return catalogue, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	if _, err = service.Import(context.Background(), []BattleRecord{original}); err != nil {
		t.Fatal(err)
	}
	first, err := service.Import(context.Background(), incoming)
	if err != nil || first.Imported != 1 {
		t.Fatalf("enrich: %+v %v", first, err)
	}
	r, err := service.Record(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Rounds != 36 || len(r.Events) != 45 || r.Outcome != original.Outcome || r.ImportedAt != original.ImportedAt {
		t.Fatal("rounds/events/provenance changed", r.Rounds, len(r.Events))
	}
	expected := map[string][]int{"me": {348, 182, 501, 599, 202, 129}, "enemy": {132, 264, 485, 111, 232, 77}}
	for side, ids := range expected {
		got := []int{}
		for _, p := range r.Sides[side].Pets {
			got = append(got, p.MonsterID)
			if p.ProtocolBaseID == "" || p.MappingRevision == "" {
				t.Fatal("missing identity evidence")
			}
			if len(p.IV) > 0 || len(p.Nature) > 0 {
				t.Fatal("invented hidden configuration")
			}
		}
		if !reflect.DeepEqual(got, ids) || !r.Quality.Roster[side] {
			t.Fatalf("%s identity: %+v", side, got)
		}
	}
	if r.Quality.Actions || r.Quality.Lead["me"] || r.Quality.Lead["enemy"] {
		t.Fatal("identity enrichment invented other coverage")
	}
	old := map[string]BattleEvent{}
	for _, e := range original.Events {
		old[e.ID] = e
	}
	forms := 0
	for _, e := range r.Events {
		if e.Kind == "form" {
			forms++
			if e.Form == nil {
				t.Fatal("lost form")
			}
		} else if !reflect.DeepEqual(old[e.ID], e) {
			t.Fatal("preexisting event changed", e.ID)
		}
	}
	if forms != 7 {
		t.Fatal("form transitions lost or duplicated", forms)
	}
	stats, err := service.Stats(context.Background(), BattleFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if stats.MatchedBattles != 1 || len(stats.Enemy) != 6 || stats.Quality.Actions != 0 {
		t.Fatal("statistics invented action coverage", stats)
	}
	for _, e := range stats.Enemy {
		if e.Carried != 1 || e.CarrySamples != 1 || e.Appeared != 0 || len(e.Skills) != 0 {
			t.Fatal("identity/form confused with deployment or skill use", e)
		}
	}
	again, err := service.Import(context.Background(), incoming)
	if err != nil || again.Imported != 0 || again.Duplicates != 1 {
		t.Fatalf("replay: %+v %v", again, err)
	}
	invalid := incoming[0]
	invalid.Rounds = 38
	if _, err := service.Import(context.Background(), []BattleRecord{invalid}); err == nil {
		t.Fatal("conflicting round count accepted")
	}
	after, err := service.Record(context.Background(), original.ID)
	if err != nil || !reflect.DeepEqual(r, after) {
		t.Fatal("failed import did not roll back")
	}
	if output := os.Getenv("XHM_IDENTITY_OUTPUT"); output != "" {
		if !filepath.IsAbs(output) {
			t.Fatal("absolute output path required")
		}
		b, _ := json.MarshalIndent(r, "", "  ")
		if e := os.WriteFile(output, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
}
