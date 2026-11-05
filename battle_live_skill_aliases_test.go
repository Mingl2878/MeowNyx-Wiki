package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func liveAliasItem(round, caster, runtime, original int) map[string]any {
	return map[string]any{"type": 1, "skill_op": map[string]any{"round": round, "caster": caster, "skill_id": runtime, "original_skill_id": original}}
}
func liveAliasQuery(items ...any) []byte {
	return liveTestFrame("0x1336", map[string]any{"items": items})
}
func liveAliasCast(round, seq, index, caster, runtime int) []byte {
	cast := liveTestCast(index, caster, runtime)
	cast["skill_cast"].(map[string]any)["type"] = 3
	return liveTestFrame("0x1324", map[string]any{"perform_cmd": map[string]any{"round": round, "seq_num": seq, "perform_info": []any{cast}}})
}
func liveAliasBinding(runtime, config int) []byte {
	return liveTestCommand(0, map[string]any{"type": 35, "exec_index": 0, "data_update": map[string]any{"pet_skill": map[string]any{"pet_id": 1, "skills": []any{map[string]any{"id": runtime, "skill_id": config}}}}})
}
func liveAliasState(t *testing.T, a *BattleStreamAssembler) []byte {
	t.Helper()
	b, err := json.Marshal(struct {
		Active      string
		AliasActive string
		States      map[string]*battleLiveState
	}{a.active, a.aliasActive, a.states})
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func liveAliasRejectAtomic(t *testing.T, a *BattleStreamAssembler, frame []byte) {
	t.Helper()
	before := liveAliasState(t, a)
	out, accepted, err := a.Push(frame)
	if err == nil || !accepted || len(out) != 0 || !bytes.Equal(before, liveAliasState(t, a)) {
		t.Fatal("invalid alias query must reject atomically without emitting")
	}
}

func TestBattleLiveSkillAliasExplicitChainOrderReplayIdentityOnly(t *testing.T) {
	var expected BattleRecord
	for i, order := range [][]int{{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}} {
		a := NewBattleStreamAssembler()
		liveTestPush(t, a, liveTestStart("123"))
		frames := [][]byte{liveAliasQuery(liveAliasItem(1, 1, 705027199, 705027000)), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270)}
		for _, index := range order {
			before, _ := battleLiveCloneState(a.states["123"])
			if got := liveTestPush(t, a, frames[index]); len(got) != 0 || a.Pending() != 1 {
				t.Fatal("query/action prematurely finalized")
			}
			if index == 0 {
				after, _ := battleLiveCloneState(a.states["123"])
				before.SkillAliases, after.SkillAliases = nil, nil
				if !reflect.DeepEqual(before, after) {
					t.Fatal("identity query changed execution, quality, resources or loadout facts")
				}
			}
			liveTestPush(t, a, frames[index])
		}
		r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
		n := 0
		for _, ev := range r.Events {
			if ev.Kind == "skill" {
				n++
				if ev.SkillID != 161 || ev.ProtocolSkillID != "705027199" || ev.ProtocolSkillConfigID != "" || ev.SkillClass != "response" || ev.Combat == nil || ev.Combat.ResponseAttempt == nil || !*ev.Combat.ResponseAttempt {
					t.Fatal("explicit chain direction/response metadata changed")
				}
			}
		}
		if n != 1 || r.Quality.Actions {
			t.Fatal("query counted as execution/coverage")
		}
		if i == 0 {
			expected = r
		} else if !reflect.DeepEqual(expected, r) {
			t.Fatal("query/cast/binding order affects identity")
		}
		for _, p := range r.Sides["me"].Pets {
			if p.InitialSkills != nil {
				t.Fatal("alias inferred initial loadout")
			}
		}
		liveTestPush(t, a, liveTestStart("123"))
		for _, f := range frames {
			liveTestPush(t, a, f)
		}
		if len(liveTestPush(t, a, liveTestFinish("123", 12, 0))) != 0 {
			t.Fatal("full source replay reemitted")
		}
	}
}

func TestBattleLiveSkillAliasIsolationAndUnproved(t *testing.T) {
	cases := []struct {
		name    string
		item    map[string]any
		cast    []byte
		binding []byte
		second  []byte
	}{
		{"round", liveAliasItem(2, 1, 705027199, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), nil},
		{"caster", liveAliasItem(1, 401, 705027199, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), nil},
		{"runtime", liveAliasItem(1, 1, 705027101, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), nil},
		{"missingDirectBase", liveAliasItem(1, 1, 705027199, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), nil, nil},
		{"unreviewedBase", liveAliasItem(1, 1, 705021199, 705021000), liveAliasCast(1, 5, 1, 1, 705021199), liveAliasBinding(705021000, 7050211), nil},
		{"zeroOriginalNoWaitGuess", liveAliasItem(1, 1, 700001200, 0), liveTestCommand(5, liveTestCast(1, 1, 700001200)), nil, nil},
		{"sameRoundMultipleSequences", liveAliasItem(1, 1, 705027199, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), liveAliasCast(1, 6, 1, 1, 705027199)},
		{"sameRoundMultipleExecutions", liveAliasItem(1, 1, 705027199, 705027000), liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), liveAliasCast(1, 5, 2, 1, 705027199)},
		{"notSkillItem", map[string]any{"type": 2, "skill_op": map[string]any{"round": 1, "caster": 1, "skill_id": 705027199, "original_skill_id": 705027000}}, liveAliasCast(1, 5, 1, 1, 705027199), liveAliasBinding(705027000, 7050270), nil},
		{"notResponse", liveAliasItem(1, 1, 705027199, 705027000), liveTestCommand(5, liveTestCast(1, 1, 705027199)), liveAliasBinding(705027000, 7050270), nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := NewBattleStreamAssembler()
			liveTestPush(t, a, liveTestStart("123"))
			if tc.binding != nil {
				liveTestPush(t, a, tc.binding)
			}
			liveTestPush(t, a, liveAliasQuery(tc.item))
			liveTestPush(t, a, tc.cast)
			if tc.second != nil {
				liveTestPush(t, a, tc.second)
			}
			r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
			for _, ev := range r.Events {
				if ev.Kind == "skill" && ev.SkillID != 0 {
					t.Fatal("out-of-scope/ambiguous/unproven alias guessed")
				}
				if ev.ProtocolSkillID == "700001200" && (ev.Kind != "skill" || ev.SkillClass != "ordinary") {
					t.Fatal("unknown runtime guessed as system")
				}
			}
		})
	}
	for _, cfg := range []int{7050211, 7090131} {
		a := NewBattleStreamAssembler()
		liveTestPush(t, a, liveTestStart("123"))
		liveTestPush(t, a, liveAliasBinding(705021199, cfg))
		liveTestPush(t, a, liveAliasCast(1, 5, 1, 1, 705021199))
		r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
		for _, ev := range r.Events {
			if ev.Kind == "skill" && (ev.SkillID != 0 || ev.ProtocolSkillConfigID != fmt.Sprint(cfg)) {
				t.Fatal("unproven exact config guessed or discarded")
			}
		}
	}
}

func TestBattleLiveSkillAliasBattleAnchors(t *testing.T) {
	query := liveAliasQuery(liveAliasItem(1, 1, 705027199, 705027000))
	a := NewBattleStreamAssembler()
	before := liveAliasState(t, a)
	liveTestPush(t, a, query)
	if a.Pending() != 0 || !bytes.Equal(before, liveAliasState(t, a)) {
		t.Fatal("orphan query created pending state")
	}
	liveTestPush(t, a, liveTestStart("123"))
	liveTestPush(t, a, liveAliasBinding(705027000, 7050270))
	liveTestPush(t, a, liveAliasCast(1, 5, 1, 1, 705027199))
	liveAliasRejectAtomic(t, a, liveTestFrame("0x1336", map[string]any{"battle_id": 124, "items": []any{liveAliasItem(1, 1, 705027199, 705027000)}}))
	liveAliasRejectAtomic(t, a, liveTestFrame("0x1336", map[string]any{"settle_info": map[string]any{"battle_id": 124}, "items": []any{liveAliasItem(1, 1, 705027199, 705027000)}}))
	liveTestPush(t, a, liveTestFinish("123", 12, 0))
	before = liveAliasState(t, a)
	liveTestPush(t, a, query)
	liveTestPush(t, a, liveTestFrame("0x1336", map[string]any{"battle_id": 123, "items": []any{liveAliasItem(1, 1, 705027199, 705027000)}}))
	if !bytes.Equal(before, liveAliasState(t, a)) {
		t.Fatal("late query attached to retained finished state")
	}
	liveTestPush(t, a, liveTestStart("124"))
	liveTestPush(t, a, query)
	liveTestPush(t, a, liveAliasCast(1, 5, 1, 1, 705027199))
	r := liveTestPush(t, a, liveTestFinish("124", 12, 0))[0]
	for _, ev := range r.Events {
		if ev.SkillID != 0 {
			t.Fatal("base config leaked across battles")
		}
	}
	b := NewBattleStreamAssembler()
	liveTestPush(t, b, liveTestStart("125"))
	liveTestPush(t, b, query)
	liveTestPush(t, b, liveTestFinish("125", 12, 0))
	liveTestPush(t, b, liveTestStart("126"))
	liveTestPush(t, b, liveAliasBinding(705027000, 7050270))
	liveTestPush(t, b, liveAliasCast(1, 5, 1, 1, 705027199))
	r = liveTestPush(t, b, liveTestFinish("126", 12, 0))[0]
	for _, ev := range r.Events {
		if ev.SkillID != 0 {
			t.Fatal("alias leaked across battles")
		}
	}
	c := NewBattleStreamAssembler()
	liveTestPush(t, c, liveTestStart("140"))
	liveTestPush(t, c, liveTestFinish("141", 12, 0))
	before = liveAliasState(t, c)
	liveTestPush(t, c, query)
	if !bytes.Equal(before, liveAliasState(t, c)) {
		t.Fatal("unrelated explicit finish silently restored previous query context")
	}
	for _, partial := range []bool{false, true} {
		c := NewBattleStreamAssembler()
		liveTestPush(t, c, liveTestStart("130"))
		if partial {
			liveTestPush(t, c, liveTestFrame("0x131a", map[string]any{"state_info": map[string]any{"battle_id": 131, "round": 1}}))
		} else {
			liveTestPush(t, c, liveTestStart("131"))
		}
		before = liveAliasState(t, c)
		liveTestPush(t, c, query)
		if !bytes.Equal(before, liveAliasState(t, c)) {
			t.Fatal("ambiguous battle context accepted query")
		}
	}
}

func TestBattleLiveSkillAliasMalformedConflictAtomicLimits(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	for _, tc := range []struct {
		field string
		value any
	}{{"caster", nil}, {"caster", "1"}, {"caster", map[string]any{"pet_id": 1}}, {"caster", 0}, {"caster", 4294967296}, {"round", 0}, {"round", 1000001}, {"round", 1.5}, {"skill_id", 0}, {"skill_id", -1}, {"original_skill_id", -1}, {"original_skill_id", 4294967296}, {"original_skill_id", "705027000"}} {
		item := liveAliasItem(1, 1, 705027199, 705027000)
		item["skill_op"].(map[string]any)[tc.field] = tc.value
		liveAliasRejectAtomic(t, a, liveAliasQuery(liveAliasItem(2, 1, 707027100, 707027000), item))
	}
	wrong := liveAliasItem(1, 1, 705027199, 705027000)
	delete(wrong["skill_op"].(map[string]any), "caster")
	wrong["skill_op"].(map[string]any)["caster_id"] = 1
	liveAliasRejectAtomic(t, a, liveAliasQuery(wrong))
	for _, item := range []any{nil, map[string]any{"type": 1}, map[string]any{"type": "1"}, liveAliasItem(1, 1, 705027199, 705027199)} {
		liveAliasRejectAtomic(t, a, liveAliasQuery(item))
	}
	liveTestPush(t, a, liveAliasQuery(liveAliasItem(1, 1, 705027199, 705027000)))
	liveAliasRejectAtomic(t, a, liveAliasQuery(liveAliasItem(2, 1, 707027100, 707027000), liveAliasItem(1, 1, 705027199, 702116000)))
	liveAliasRejectAtomic(t, a, liveAliasQuery(liveAliasItem(1, 1, 705027000, 705027199)))
	liveAliasRejectAtomic(t, a, liveAliasQuery(liveAliasItem(1, 1, 705027000, 702116000), liveAliasItem(1, 1, 702116000, 705027199)))
	items := make([]any, battleLiveMaxSkillAliases)
	for i := range items {
		items[i] = liveAliasItem(i+1, 1, 705027199, 705027000)
	}
	liveTestPush(t, a, liveAliasQuery(items...))
	liveTestPush(t, a, liveAliasQuery(items...))
	if len(a.states["123"].SkillAliases) != battleLiveMaxSkillAliases {
		t.Fatal("duplicate consumed alias capacity")
	}
	liveAliasRejectAtomic(t, a, liveAliasQuery(liveAliasItem(battleLiveMaxSkillAliases+1, 1, 705027199, 705027000)))
	liveAliasRejectAtomic(t, a, liveAliasQuery(append(items, items[0])...))
}

func TestBattleLiveSkillAliasKnownIdentityAndNoTransitiveJoin(t *testing.T) {
	for _, tc := range []struct {
		name   string
		id     int
		config string
		fail   bool
	}{{"empty", 0, "", false}, {"sameKnown", 161, "7050211", false}, {"conflictingKnown", 68, "", true}, {"conflictingConfig", 0, "7021160", true}} {
		t.Run(tc.name, func(t *testing.T) {
			s := battleLiveNewState("123")
			s.SkillAliases[battleLiveSkillAliasKey(1, "1", "705027199")] = "705027000"
			event := BattleEvent{ID: "cast", Round: 1, Kind: "skill", Phase: "executed", Actor: "1", SkillClass: "response", ProtocolSkillID: "705027199", ProtocolSkillConfigID: tc.config, SkillID: tc.id, Label: "应对·原样保留"}
			r := BattleRecord{Events: []BattleEvent{event}}
			err := s.enrichSkillAliases(&r, map[string]string{"705027000": "7050270"})
			if (err != nil) != tc.fail {
				t.Fatal("known identity conflict handling")
			}
			if !tc.fail {
				event.SkillID = 161
				if !reflect.DeepEqual(event, r.Events[0]) {
					t.Fatal("alias changed more than absent SkillID")
				}
			}
		})
	}
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	liveTestPush(t, a, liveAliasQuery(liveAliasItem(1, 1, 705027199, 705027001), liveAliasItem(1, 1, 705027001, 705027000)))
	liveTestPush(t, a, liveAliasBinding(705027000, 7050270))
	liveTestPush(t, a, liveAliasCast(1, 5, 1, 1, 705027199))
	r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	for _, ev := range r.Events {
		if ev.SkillID != 0 {
			t.Fatal("alias chain resolved transitively without direct base config")
		}
	}
}

func TestBattleLiveSkillAliasNoExecutionAndFinalConflictAtomic(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	before, _ := battleLiveCloneState(a.states["123"])
	frame := liveTestFrame("0x1336", map[string]any{
		"items":       []any{liveAliasItem(1, 1, 705027199, 705027000)},
		"settle_info": map[string]any{"battle_id": 123, "rounds": 1, "result": 12},
		"perform_cmd": map[string]any{"round": 1, "seq_num": 2, "perform_info": []any{liveTestCast(1, 1, 705027199)}, "is_battle_finished": true},
	})
	if len(liveTestPush(t, a, frame)) != 0 || a.Pending() != 1 {
		t.Fatal("query finalized or counted actions")
	}
	after, _ := battleLiveCloneState(a.states["123"])
	before.SkillAliases, after.SkillAliases = nil, nil
	if !reflect.DeepEqual(before, after) {
		t.Fatal("query embedded execution/settlement consumed")
	}
	liveTestPush(t, a, liveAliasBinding(705027000, 7050270))
	cast := liveTestCast(1, 1, 705027199)
	cast["skill_cast"].(map[string]any)["type"] = 3
	cast["skill_cast"].(map[string]any)["is_interupt"] = true
	liveTestPush(t, a, liveTestCommand(5, cast))
	r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	for _, ev := range r.Events {
		if ev.Kind == "skill" && (ev.SkillID != 0 || ev.Phase != "interrupted") {
			t.Fatal("nonexecution mapped by query")
		}
	}
	b := NewBattleStreamAssembler()
	liveTestPush(t, b, liveTestStart("124"))
	liveTestPush(t, b, liveAliasQuery(liveAliasItem(1, 1, 705027199, 705027000)))
	liveTestPush(t, b, liveAliasBinding(705027000, 7050270))
	liveTestPush(t, b, liveTestCommand(1, map[string]any{"type": 35, "exec_index": 0, "data_update": map[string]any{"pet_skill": map[string]any{"pet_id": 1, "skills": []any{map[string]any{"id": 705027199, "skill_id": 7021160}}}}}))
	liveTestPush(t, b, liveAliasCast(1, 5, 1, 1, 705027199))
	liveAliasRejectAtomic(t, b, liveTestFinish("124", 12, 0))
	if b.Pending() != 1 {
		t.Fatal("conflicting known identity committed finish")
	}
}

// Opt-in only. Reads the one whitelisted CSV's named battle fields, bounded at
// the fourth finish. It exports no source/normalized files and opens no DB.
func TestBattleLiveSkillAliasAuthorizedSnapshot(t *testing.T) {
	path := os.Getenv("BATTLE_LIVE_AUTHORIZED_CSV")
	if path == "" {
		t.Skip("explicit authorized source opt-in only")
	}
	allowed := "D:/HabilynX/Roco-Kingdom-Protocol-Parser/runs/20261102-225658-31124/opencode_summary.csv"
	if filepath.Clean(path) != filepath.Clean(allowed) {
		t.Fatal("source not authorized")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	reader := csv.NewReader(io.LimitReader(f, 256<<20))
	header, err := reader.Read()
	if err != nil {
		t.Fatal("CSV header")
	}
	col := map[string]int{}
	for i, k := range header {
		col[strings.TrimPrefix(k, "\ufeff")] = i
	}
	for _, k := range []string{"opencode", "meaning", "content"} {
		if _, ok := col[k]; !ok {
			t.Fatal("missing named column")
		}
	}
	a, without := NewBattleStreamAssembler(), NewBattleStreamAssembler()
	var records, controls []BattleRecord
	for logical := 2; logical <= 100000; logical++ {
		row, e := reader.Read()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatalf("CSV parse row %d", logical)
		}
		if !strings.HasPrefix(row[col["meaning"]], "ZoneBattle") {
			continue
		}
		op := row[col["opencode"]]
		frame := liveTestFrame(op, row[col["content"]])
		got, _, e := a.Push(frame)
		if e != nil {
			t.Fatalf("named battle failure row=%d opcode=%s: %v", logical, op, e)
		}
		records = append(records, got...)
		code, e := battleOpcode(op)
		if e != nil {
			t.Fatalf("opcode row=%d", logical)
		}
		if code != 0x1336 {
			got, _, e = without.Push(frame)
			if e != nil {
				t.Fatalf("control row=%d: %v", logical, e)
			}
			controls = append(controls, got...)
		}
		if len(records) == 4 {
			break
		}
	}
	if len(records) != 4 || len(controls) != 4 || a.Pending() != 0 {
		t.Fatal("four settled battles required")
	}
	want := map[string]int{
		"rkpp:2306377934505522485:live:2:10:18:cast:403": 491,
		"rkpp:2306377934505522485:live:7:43:2:cast:1":    161,
		"rkpp:2306377934505522485:live:9:53:2:cast:1":    161,
		"rkpp:2306377934505522485:live:11:63:2:cast:1":   161,
		"rkpp:2306377934505522485:live:14:78:2:cast:402": 68,
		"rkpp:2306377934505522485:live:19:103:2:cast:1":  161,
	}
	seen := map[string]bool{}
	for i, r := range records {
		control := controls[i]
		if len(r.Events) != len(control.Events) {
			t.Fatal("query changed action/event count")
		}
		for j, ev := range r.Events {
			if local := want[ev.ID]; local != 0 {
				if ev.SkillID != local || ev.ProtocolSkillConfigID != "" {
					t.Fatal("audited response identity chain mismatch", ev.ID)
				}
				// User-confirmed runtime identities no longer require this query.
				// Unconfirmed IDs still need its exact same-battle evidence.
				wantWithout := battleUserConfirmedSkillLocal(ev.ProtocolSkillID)
				if control.Events[j].SkillID != wantWithout {
					t.Fatal("query-independent identity provenance mismatch", ev.ID)
				}
				control.Events[j].SkillID = local
				seen[ev.ID] = true
			}
		}
		if !reflect.DeepEqual(r, control) {
			t.Fatal("query changed facts other than six absent local identities", r.ID)
		}
	}
	if len(seen) != 6 {
		t.Fatal("missing audited aliases")
	}
	data, err := os.ReadFile(filepath.Join("..", "records-before.json"))
	if err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Records []BattleRecord `json:"records"`
	}
	if json.Unmarshal(data, &snapshot) != nil {
		t.Fatal("normalized snapshot parse")
	}
	old := map[string]BattleRecord{}
	for _, r := range snapshot.Records {
		old[r.ID] = r
	}
	confirmedAdditions := 0
	for _, r := range records {
		prior, ok := old[r.ID]
		if !ok {
			t.Fatal("snapshot lacks battle", r.ID)
		}
		if len(r.Events) != len(prior.Events) || !reflect.DeepEqual(r.Quality, prior.Quality) || r.Rounds != prior.Rounds || r.Outcome != prior.Outcome || r.StartedAt != prior.StartedAt || !reflect.DeepEqual(r.DurationSeconds, prior.DurationSeconds) {
			t.Fatal("counts/quality/battle metadata differ from snapshot", r.ID)
		}
		for i, ev := range r.Events {
			before := prior.Events[i]
			if before.ID != ev.ID {
				t.Fatal("event order changed", r.ID)
			}
			if local := battleUserConfirmedSkillLocal(before.ProtocolSkillID); local != 0 && before.SkillID == 0 && battleUserConfirmedSkillEvent(before) {
				if ev.SkillID != local {
					t.Fatal("user-confirmed snapshot identity delta", ev.ID)
				}
				before.SkillID = local
				confirmedAdditions++
			}
			// Stored snapshots have independently mapped form species/revision;
			// assembler does not run catalog/store enrichment. Keep protocol form
			// identity/index intact while excluding only those three store fields.
			if before.Form != nil {
				before.Form.FromMonsterID = 0
				before.Form.ToMonsterID = 0
				before.Form.MappingRevision = ""
			}
			if !reflect.DeepEqual(before, ev) {
				t.Fatal("nonidentity event facts differ from old normalized snapshot", ev.ID)
			}
		}
	}
	// The authorized snapshot can predate the user-confirmed backfill (six
	// additions here) or already contain it (zero). In either case every event
	// above is compared, so known identities and all other facts stay exact.
	if confirmedAdditions != 0 && confirmedAdditions != 6 {
		t.Fatal("unexpected authorized snapshot confirmation delta", confirmedAdditions)
	}
	t.Logf("current snapshot: %d user-confirmed SkillID additions in four captured battles; prior config/query identities, all other event fields, order, counts and quality unchanged", confirmedAdditions)
}
