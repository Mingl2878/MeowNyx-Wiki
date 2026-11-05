package main

import (
	"context"
	"encoding/json"
	"math"
	"path/filepath"
	"reflect"
	"testing"
)

func liveMergeEventFixture() BattleEvent {
	return BattleEvent{ID: "rkpp:123:live:1:2:3:damage:1:401", Round: 1, Seq: 2, ExecIndex: battleCombatCopy(ptrLiveMerge(3)), Kind: "damage", Phase: "executed", Side: "unknown", ProtocolSkillID: ""}
}
func ptrLiveMerge[T any](v T) *T { return &v }
func TestBattleLiveMergeUnknownCoreAndPointerIsolation(t *testing.T) {
	a := liveMergeEventFixture()
	b := a
	b.Actor = "self"
	b.Side = "me"
	b.Target = "enemy"
	b.TargetSide = "enemy"
	b.Amount = ptrLiveMerge(0.0)
	b.HPAfter = ptrLiveMerge(300)
	b.Combat = &BattleCombatEvidence{HPBefore: ptrLiveMerge(400), EffectivenessClass: "usual"}
	for _, pair := range [][2]BattleEvent{{a, b}, {b, a}} {
		got, e := battleMergeLiveEvent(pair[0], pair[1])
		if e != nil {
			t.Fatal(e)
		}
		if !reflect.DeepEqual(got, b) {
			t.Fatalf("unknown core not complemented: %+v", got)
		}
		*got.Amount = 10
		*got.HPAfter = 1
		*got.Combat.HPBefore = 1
		*got.ExecIndex = 500
		if *b.Amount != 0 || *b.HPAfter != 300 || *b.Combat.HPBefore != 400 || *b.ExecIndex != 3 {
			t.Fatal("result aliases source pointers")
		}
	}
	// Exact runtime is immutable; only absent configuration evidence may fill.
	a = BattleEvent{ID: "cast", Round: 1, Seq: 1, Kind: "skill", Phase: "executed", Side: "me", Actor: "self", ProtocolSkillID: "700002000"}
	b = a
	b.ProtocolSkillConfigID = "7000020"
	got, e := battleMergeLiveEvent(a, b)
	if e != nil || got.ProtocolSkillConfigID != "7000020" {
		t.Fatal("explicit configuration complement rejected", e)
	}
}
func TestBattleLiveMergeKnownConflictsAndSchema(t *testing.T) {
	base := liveMergeEventFixture()
	base.Amount = ptrLiveMerge(0.0)
	base.Actor = "self"
	base.Side = "me"
	base.Target = "enemy"
	base.TargetSide = "enemy"
	base.Label = "known"
	cases := map[string]func(*BattleEvent){"id": func(e *BattleEvent) { e.ID = "other" }, "kind": func(e *BattleEvent) { e.Kind = "heal" }, "phase": func(e *BattleEvent) { e.Phase = "preview" }, "round": func(e *BattleEvent) { e.Round = 2 }, "seq": func(e *BattleEvent) { e.Seq = 3 }, "runtime": func(e *BattleEvent) { e.ProtocolSkillID = "999" }, "actor": func(e *BattleEvent) { e.Actor = "other" }, "target": func(e *BattleEvent) { e.Target = "other" }, "side": func(e *BattleEvent) { e.Side = "enemy" }, "targetSide": func(e *BattleEvent) { e.TargetSide = "me" }, "amount": func(e *BattleEvent) { e.Amount = ptrLiveMerge(1.0) }, "negative": func(e *BattleEvent) { e.Amount = ptrLiveMerge(-1.0) }, "nonfinite": func(e *BattleEvent) { e.Amount = ptrLiveMerge(math.Inf(1)) }, "invalidSide": func(e *BattleEvent) { e.Side = "invalid" }, "configWithoutRuntime": func(e *BattleEvent) { e.ProtocolSkillConfigID = "123" }, "index": func(e *BattleEvent) { e.ExecIndex = ptrLiveMerge(99) }, "label": func(e *BattleEvent) { e.Label = "changed" }}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			b := base
			mutate(&b)
			if _, e := battleMergeLiveEvent(base, b); e == nil {
				t.Fatal("known/schema conflict accepted")
			}
		})
	}
	a := BattleEvent{ID: "cast", Round: 1, Seq: 1, Kind: "skill", Phase: "executed", Side: "me"}
	b := a
	b.Amount = ptrLiveMerge(1.0)
	if _, e := battleMergeLiveEvent(a, b); e == nil {
		t.Fatal("amount complement allowed outside damage/heal")
	}
	a = base
	a.Kind = "invalid"
	if _, e := battleMergeLiveEvent(a, a); e == nil {
		t.Fatal("matching invalid schema accepted")
	}
}
func liveMergeRecord(t *testing.T, source string, full bool) BattleRecord {
	r := backendBattle(t, "live-complement")
	r.Source = source
	r.Quality.Actions = false
	e := liveMergeEventFixture()
	if full {
		e.Actor = "self"
		e.Side = "me"
		e.Target = "enemy"
		e.TargetSide = "enemy"
		e.Amount = ptrLiveMerge(10.0)
	}
	r.Events = []BattleEvent{e}
	return r
}
func TestBattleLiveMergeSourceIsolation(t *testing.T) {
	for _, pair := range [][2]string{{battleLiveSource, battleLiveSource}, {"canonical", "canonical"}, {battleLiveSource, "canonical"}, {"canonical", battleLiveSource}, {"rkpp-named-schema", battleLiveSource}, {battleLiveSource, ""}} {
		a, b := liveMergeRecord(t, pair[0], false), liveMergeRecord(t, pair[1], true)
		_, e := MergeBattleRecord(a, b)
		allowed := pair[0] == battleLiveSource && pair[1] == battleLiveSource
		if allowed && e != nil {
			t.Fatal("live gate did not call helper", e)
		}
		if !allowed && e == nil {
			t.Fatal("legacy/mixed source core immutability relaxed", pair)
		}
	}
}
func TestBattleLiveMergeActualScanPartialComplementUnchanged(t *testing.T) {
	service := backendService(t)
	path := filepath.Join(t.TempDir(), scanArchiveName)
	damage := map[string]any{"type": 4, "exec_index": 2, "group_id": 1, "damage_info": map[string]any{"caster_id": 1, "target_id": 401, "source_id": 700002000, "restraint_type": 1}}
	write := func() {
		frames := [][]byte{liveTestStart("123"), liveTestCommand(5, liveTestCast(1, 1, 700002000), damage), liveTestFinish("123", 12, 0)}
		rows := [][]string{}
		for _, frame := range frames {
			raw, e := battleReadJSON(frame)
			if e != nil {
				t.Fatal(e)
			}
			obj := battleObject(raw)
			op := obj["opencode"].(string)
			code, e := battleOpcode(op)
			if e != nil {
				t.Fatal(e)
			}
			content, e := json.Marshal(obj["content"])
			if e != nil {
				t.Fatal(e)
			}
			rows = append(rows, []string{op, battleLiveNames[code], string(content)})
		}
		scanTestCSV(t, path, rows...)
	}
	write()
	first, e := service.ScanArchive(context.Background(), path)
	if e != nil || first.Imported != 1 || first.Updated != 0 || first.Completed != 1 {
		t.Fatal("partial finalized scan", first, e)
	}
	damage["sync_data"] = map[string]any{"pet_sync_info": []any{map[string]any{"pet_id": 401, "damage_result": 100, "hp_change": -100, "hp_result": 300}}}
	write()
	second, e := service.ScanArchive(context.Background(), path)
	if e != nil || second.Imported != 0 || second.Updated != 1 || second.Completed != 1 {
		t.Fatal("complement finalized scan", second, e)
	}
	third, e := service.ScanArchive(context.Background(), path)
	if e != nil || third.Imported != 0 || third.Updated != 0 || third.Unchanged != 1 {
		t.Fatal("unchanged rescan", third, e)
	}
}

func TestBattleLiveMergePartialFinalComplementRescan(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	damage := map[string]any{"type": 4, "exec_index": 2, "group_id": 1, "damage_info": map[string]any{"caster_id": 1, "target_id": 401, "source_id": 700002000, "restraint_type": 1}}
	cast := liveTestCast(1, 1, 700002000)
	liveTestPush(t, a, liveTestCommand(5, cast, damage))
	partial := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	service := backendService(t)
	if result := backendImport(t, service, partial); result.Imported != 1 || result.Updated != 0 {
		t.Fatal(result)
	}
	liveTestPush(t, a, liveTestStart("123"))
	damage["sync_data"] = map[string]any{"pet_sync_info": []any{map[string]any{"pet_id": 401, "damage_result": 100, "hp_change": -100, "hp_result": 300}}}
	liveTestPush(t, a, liveTestCommand(5, damage))
	complete := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	if result := backendImport(t, service, complete); result.Imported != 1 || result.Updated != 1 {
		t.Fatal("complement failed to update", result)
	}
	if result := backendImport(t, service, complete); result.Updated != 0 || result.Duplicates != 1 {
		t.Fatal("rescan not unchanged", result)
	}
	saved, e := service.Record(context.Background(), partial.ID)
	if e != nil {
		t.Fatal(e)
	}
	count := 0
	for _, event := range saved.Events {
		if event.Kind == "damage" {
			count++
			if event.Amount == nil || *event.Amount != 100 {
				t.Fatal("missing complemented observed amount")
			}
		}
	}
	if count != 1 {
		t.Fatal("duplicate damage events")
	}
	// Saved JSON remains the same normalized schema, with no source frame data.
	if _, e = json.Marshal(saved); e != nil {
		t.Fatal(e)
	}
}
