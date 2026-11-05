package main

import (
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

func liveTestFrame(op string, body any) []byte {
	b, _ := json.Marshal(map[string]any{"opencode": op, "content": body})
	return b
}
func liveTestPet(id, base int, active bool) map[string]any {
	attrs := make([]int, 26)
	attrs[1] = 400
	attrs[25] = 400
	pos := -1
	if active {
		pos = 1
	}
	return map[string]any{"battle_inside_pet_info": map[string]any{"pet_id": id, "pos": pos, "base_conf_id": base, "conf_id": base + 10000, "battle_attr": attrs, "skill_round_data": []any{map[string]any{"id": 700001000, "cost_energy": 0}, map[string]any{"id": 700002000, "cost_energy": 3}}}, "battle_common_pet_info": map[string]any{"base_conf_id": base, "conf_id": base + 10000, "level": 60, "energy": 10, "attribute_info": map[string]any{"hp": map[string]any{"talent": 54}}}, "full_for_data_level": true}
}
func liveTestStart(id string) []byte {
	return liveTestFrame("0x1316", map[string]any{"init_info": map[string]any{"battle_id": json.Number(id), "battle_start_time": 1793631526, "player_team": []any{map[string]any{"base": map[string]any{"side": 0}, "pets": []any{liveTestPet(1, 3001, true)}}}, "enemy_team": []any{map[string]any{"base": map[string]any{"side": 1}, "pets": []any{liveTestPet(401, 3002, true)}}}}})
}
func liveTestFinish(id string, result, side int) []byte {
	return liveTestFrame("0x132c", map[string]any{"settle_info": map[string]any{"battle_id": json.Number(id), "rounds": 2, "seconds": 20, "result": result, "side": side, "real_pvp": 1, "enter_battle_time": 1793631526, "monster_info": []any{map[string]any{"pet_id": 1, "side": 0}, map[string]any{"pet_id": 401, "side": 1}}}})
}
func liveTestCommand(seq int, entries ...any) []byte {
	return liveTestFrame("0x1324", map[string]any{"perform_cmd": map[string]any{"round": 1, "seq_num": seq, "perform_info": entries}})
}
func liveTestCast(index int, actor int, skill int) map[string]any {
	return map[string]any{"type": 1, "exec_index": index, "group_id": 1, "is_group_head": true, "skill_cast": map[string]any{"caster_id": actor, "skill_id": skill, "type": 1, "target_id": []int{401}}}
}
func liveTestPush(t *testing.T, a *BattleStreamAssembler, frame []byte) []BattleRecord {
	t.Helper()
	r, ok, e := a.Push(frame)
	if e != nil || !ok {
		t.Fatalf("push accepted=%v err=%v", ok, e)
	}
	return r
}

func TestBattleLiveFinalBoundaryLosslessAndReplay(t *testing.T) {
	id := "2306377934505522485"
	a := NewBattleStreamAssembler()
	if r := liveTestPush(t, a, liveTestStart(id)); len(r) != 0 || a.Pending() != 1 {
		t.Fatal("opening emitted or missing pending")
	}
	cast := liveTestCast(1, 1, 700001000)
	cast["sync_data"] = map[string]any{"pet_sync_info": []any{map[string]any{"pet_id": 1, "energy_change": 3, "energy_result": 13}}}
	primary := liveTestCommand(7, cast)
	if len(liveTestPush(t, a, primary)) != 0 {
		t.Fatal("premature emission")
	}
	liveTestPush(t, a, primary)
	ignored := liveTestFrame("0x13f3", map[string]any{"settle_info": map[string]any{"battle_id": json.Number(id), "result": 12}, "perform_cmd": map[string]any{"is_battle_finished": true}})
	if len(liveTestPush(t, a, ignored)) != 0 {
		t.Fatal("preview finalized")
	}
	records := liveTestPush(t, a, liveTestFinish(id, 12, 0))
	if len(records) != 1 || a.Pending() != 0 {
		t.Fatal("finish missing")
	}
	r := records[0]
	if r.ID != "rkpp:"+id || r.Source != battleLiveSource || r.Outcome != "loss" || r.Quality.Actions {
		t.Fatalf("bad finalized metadata %+v", r)
	}
	if p := r.Sides["me"].Pets[0]; p.IV["hp"].Value == nil || *p.IV["hp"].Value != 54 || len(p.Nature) != 0 {
		t.Fatal("direct IV or missing nature changed")
	}
	n := 0
	for _, e := range r.Events {
		if e.ProtocolSkillID == "700001000" {
			n++
			if e.Kind != "effect" || e.SkillClass != "system" || e.EnergyCost == nil || *e.EnergyCost != 0 {
				t.Fatal("charge classification/cost")
			}
		}
	}
	if n != 1 {
		t.Fatal("duplicate casts", n)
	}
	if len(liveTestPush(t, a, liveTestFinish(id, 12, 0))) != 0 {
		t.Fatal("duplicate settlement emitted")
	}
	liveTestPush(t, a, liveTestStart(id))
	liveTestPush(t, a, primary)
	if len(liveTestPush(t, a, liveTestFinish(id, 12, 0))) != 0 {
		t.Fatal("complete replay emitted")
	}
	// Caller mutation must not alias pending state or suppress later valid replay.
	records[0].Sides["me"].Pets[0].MonsterID = 999
	liveTestPush(t, a, liveTestStart(id))
	if len(liveTestPush(t, a, liveTestFinish(id, 12, 0))) != 0 {
		t.Fatal("returned value aliased assembler")
	}
}
func TestBattleLiveDamageComplementAndStableKeys(t *testing.T) {
	build := func(reverse bool) BattleRecord {
		a := NewBattleStreamAssembler()
		liveTestPush(t, a, liveTestStart("1876469132858231472"))
		cast := liveTestCast(1, 1, 700002000)
		damage := map[string]any{"type": 4, "exec_index": 2, "group_id": 1, "damage_info": map[string]any{"caster_id": 1, "target_id": 401, "source_id": 700002000, "restraint_type": -1}}
		sync := map[string]any{"type": 6, "exec_index": 2, "group_id": 1, "sync_data": map[string]any{"pet_sync_info": []any{map[string]any{"pet_id": 401, "hp_change": json.Number("18446744073709551516")}, map[string]any{"pet_id": 401, "hp_result": 300, "damage_result": 110}}}}
		frames := [][]byte{liveTestCommand(5, cast, damage), liveTestCommand(5, sync)}
		if reverse {
			frames[0], frames[1] = frames[1], frames[0]
		}
		for _, f := range frames {
			liveTestPush(t, a, f)
			liveTestPush(t, a, f)
		}
		return liveTestPush(t, a, liveTestFinish("1876469132858231472", 12, 0))[0]
	}
	a, b := build(false), build(true)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("arrival order changes normalized complement")
	}
	damageCount := 0
	for _, e := range a.Events {
		if e.Kind == "damage" {
			damageCount++
			if e.HPChange == nil || *e.HPChange != -100 || e.HPAfter == nil || *e.HPAfter != 300 || e.Amount == nil || *e.Amount != 110 || e.Combat == nil || e.Combat.ActionID == "" || e.Combat.HPBefore == nil || *e.Combat.HPBefore != 400 || e.Combat.EffectivenessClass != "resisted" {
				t.Fatalf("missing exact damage facts %+v", e)
			}
		}
		if e.Kind == "resource" && e.StateStage == "" && e.Actor == "401" && e.HPChange != nil {
			t.Fatal("double counted damage resource")
		}
	}
	if damageCount != 1 {
		t.Fatal(damageCount)
	}
}
func TestBattleLiveFinishedComplementAndEventIsolation(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("123"))
	cast := liveTestCast(1, 1, 700002000)
	damage := map[string]any{"type": 4, "exec_index": 2, "group_id": 1, "damage_info": map[string]any{"caster_id": 1, "target_id": 401, "source_id": 700002000, "restraint_type": 1}}
	original := liveTestCommand(5, cast, damage)
	liveTestPush(t, a, original)
	first := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	for i := range first.Events {
		ev := &first.Events[i]
		if ev.Kind == "damage" {
			if ev.Amount != nil {
				t.Fatal("unknown amount filled")
			}
			ev.Combat.ActionID = "caller-mutation"
			if ev.ExecIndex != nil {
				*ev.ExecIndex = 999
			}
		}
	}
	liveTestPush(t, a, liveTestStart("123"))
	liveTestPush(t, a, original)
	if len(liveTestPush(t, a, liveTestFinish("123", 12, 0))) != 0 {
		t.Fatal("caller event pointer mutated pending replay")
	}
	liveTestPush(t, a, liveTestStart("123"))
	damage["sync_data"] = map[string]any{"pet_sync_info": []any{map[string]any{"pet_id": 401, "damage_result": 100, "hp_change": -100, "hp_result": 300}}}
	liveTestPush(t, a, liveTestCommand(5, damage))
	second := liveTestPush(t, a, liveTestFinish("123", 12, 0))
	if len(second) != 1 {
		t.Fatal("finished complement not emitted")
	}
	found := 0
	for _, ev := range second[0].Events {
		if ev.Kind == "damage" {
			found++
			if ev.Amount == nil || *ev.Amount != 100 || ev.Combat.ActionID == "caller-mutation" {
				t.Fatal("complement/isolation failed")
			}
		}
	}
	if found != 1 {
		t.Fatal("complement duplicated action")
	}
}
func TestBattleLiveInitialRosterCoverageAndReconnect(t *testing.T) {
	a := NewBattleStreamAssembler()
	open, _ := battleReadJSON(liveTestStart("123"))
	obj := battleObject(open)
	body := battleObject(obj["content"])
	info := battleObject(body["init_info"])
	own := []any{}
	enemy := []any{}
	for i := 1; i <= 6; i++ {
		own = append(own, liveTestPet(i, 3000+i, i == 1))
		enemy = append(enemy, liveTestPet(400+i, 4000+i, i == 1))
	}
	info["player_team"] = []any{map[string]any{"base": map[string]any{"side": 0}, "pets": own}}
	info["enemy_team"] = []any{map[string]any{"base": map[string]any{"side": 1}, "pets": enemy[:1]}}
	info["others"] = []any{map[string]any{"pets": enemy}}
	frame, _ := json.Marshal(obj)
	liveTestPush(t, a, frame)
	r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	if !r.Quality.Roster["me"] || !r.Quality.Roster["enemy"] || len(r.Sides["enemy"].Pets) != 6 || !r.Quality.Lead["enemy"] {
		t.Fatal("explicit initial overlap roster lost")
	}
	// Two auxiliary candidates are ambiguous: never upgrade the one visible enemy.
	info["others"] = []any{map[string]any{"pets": enemy}, map[string]any{"pets": enemy}}
	frame, _ = json.Marshal(obj)
	b := NewBattleStreamAssembler()
	liveTestPush(t, b, frame)
	r = liveTestPush(t, b, liveTestFinish("123", 12, 0))[0]
	if r.Quality.Roster["enemy"] || len(r.Sides["enemy"].Pets) != 1 {
		t.Fatal("ambiguous initial roster guessed")
	}
	body["is_reconnect"] = true
	frame, _ = json.Marshal(obj)
	c := NewBattleStreamAssembler()
	if len(liveTestPush(t, c, frame)) != 0 || c.Pending() != 0 {
		t.Fatal("reconnect current snapshot treated as initial")
	}
	if len(liveTestPush(t, c, liveTestFinish("123", 12, 0))) != 0 {
		t.Fatal("reconnect-only battle finalized")
	}
}

func TestBattleLiveMalformedAtomicIrrelevantAndUnknown(t *testing.T) {
	a := NewBattleStreamAssembler()
	liveTestPush(t, a, liveTestStart("18446744073709551615"))
	for _, raw := range []string{`{"opencode":"0x9999","content":"secret-not-json"}`, `{"type":"heartbeat","account":"secret"}`} {
		r, ok, e := a.Push([]byte(raw))
		if e != nil || ok || len(r) != 0 {
			t.Fatal("irrelevant frame rejected")
		}
	}
	bad := []string{`{"opencode":"0x1324","content":{"perform_cmd":{"round":1,"round":2,"seq_num":4}}}`, `{"opencode":"0x1316","content":{"init_info":{"battle_id":18446744073709551616}}}`, `{"opencode":"0x1324","content":"secret-malformed"}`}
	for _, raw := range bad {
		_, _, e := a.Push([]byte(raw))
		if e == nil || strings.Contains(e.Error(), "secret") {
			t.Fatal("malformed accepted or payload echoed")
		}
	}
	if a.Pending() != 1 {
		t.Fatal("failed frame mutated pending")
	}
	original := liveTestCommand(4, liveTestCast(1, 1, 700002000))
	liveTestPush(t, a, original)
	conflict := liveTestCommand(4, liveTestCast(1, 1, 700003000))
	if _, _, e := a.Push(conflict); e == nil {
		t.Fatal("conflicting stable ID accepted")
	}
	records := liveTestPush(t, a, liveTestFinish("18446744073709551615", 99, 0))
	if len(records) != 1 || records[0].Outcome != "unknown" {
		t.Fatal("unknown result guessed")
	}
	if _, e := battleIdentifier(json.Number("18446744073709551615")); e == nil {
		t.Fatal("old normal-JSON identifier safety relaxed")
	}
	if _, _, e := a.Push([]byte(`{"opencode":"0x1316","content":{"init_info":{"battle_id":1e3}}}`)); e == nil {
		t.Fatal("exponent battle ID accepted")
	}
}
func TestBattleLiveNoGuessedFinishAndFormIdentity(t *testing.T) {
	a := NewBattleStreamAssembler()
	if len(liveTestPush(t, a, liveTestCommand(1, liveTestCast(1, 1, 700002000)))) != 0 || a.Pending() != 0 {
		t.Fatal("orphan guessed")
	}
	liveTestPush(t, a, liveTestStart("123"))
	if len(liveTestPush(t, a, liveTestFinish("124", 12, 0))) != 0 {
		t.Fatal("mismatched finish finalized active")
	}
	if a.Pending() != 1 {
		t.Fatal("wrong pending count")
	}
	pet := liveTestPet(1, 3009, true)
	form := map[string]any{"type": 24, "exec_index": 5, "group_id": 1, "change_model": map[string]any{"pet_id": 1, "old_base_id": 3001, "pet_info": pet}}
	liveTestPush(t, a, liveTestCommand(3, form))
	r := liveTestPush(t, a, liveTestFinish("123", 12, 0))[0]
	if r.Sides["me"].Pets[0].ProtocolBaseID != "3001" {
		t.Fatal("later form overwrote initial identity")
	}
	n := 0
	for _, e := range r.Events {
		if e.Kind == "form" {
			n++
			if e.Form.FromBaseID != "3001" || e.Form.ToBaseID != "3009" {
				t.Fatal("bad form")
			}
		}
	}
	if n != 1 {
		t.Fatal("missing form")
	}
}

// Explicit opt-in read-only test, not a default path or automatic archive scan.
// Only the authorized opencode/meaning/content fields are used; only named battle
// JSON is decoded. No CSV copy, raw packet, account output, DB or server I/O.
func TestBattleLiveAuthorizedFourBattleEvidence(t *testing.T) {
	path := os.Getenv("BATTLE_LIVE_AUTHORIZED_CSV")
	if path == "" {
		t.Skip("explicit authorized source opt-in only")
	}
	allowed := "D:/HabilynX/Roco-Kingdom-Protocol-Parser/runs/20261102-225658-31124/opencode_summary.csv"
	if filepath.Clean(path) != filepath.Clean(allowed) {
		t.Fatal("source not authorized for this test")
	}
	f, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	reader := csv.NewReader(f)
	header, e := reader.Read()
	if e != nil {
		t.Fatal(e)
	}
	col := map[string]int{}
	for i, k := range header {
		col[strings.TrimPrefix(k, "\ufeff")] = i
	}
	for _, k := range []string{"opencode", "meaning", "content"} {
		if _, ok := col[k]; !ok {
			t.Fatal("required named column missing")
		}
	}
	a := NewBattleStreamAssembler()
	records := []BattleRecord{}
	logical := 1
	for {
		row, e := reader.Read()
		if e == io.EOF {
			break
		}
		logical++
		if e != nil {
			t.Fatalf("CSV parse at logical row %d", logical)
		}
		meaning := row[col["meaning"]]
		if !strings.HasPrefix(meaning, "ZoneBattle") {
			continue
		}
		frame := liveTestFrame(row[col["opencode"]], row[col["content"]])
		got, accepted, e := a.Push(frame)
		if e != nil {
			if state := a.states[a.active]; state != nil && meaning == "ZoneBattleFinishNotify" {
				copyState, _ := battleLiveCloneState(state)
				decoded, _ := battleReadJSON([]byte(row[col["content"]]))
				obj := battleObject(decoded)
				if settleError := copyState.settlement(battleObject(obj["settle_info"]), obj); settleError != nil {
					t.Log("settlement error:", settleError)
				} else {
					_, finalError := copyState.finalize()
					t.Log("final validation error:", finalError)
					for _, event := range copyState.Events {
						if event.Phase == "interrupted" && event.Kind != "skill" {
							t.Logf("interrupted non-skill kind=%s class=%s runtime=%s", event.Kind, event.SkillClass, event.ProtocolSkillID)
						}
					}
				}
			}
			t.Fatalf("safe battle failure logical row=%d meaning=%s: %v", logical, meaning, e)
		}
		if !accepted {
			t.Fatalf("recognized battle rejected row=%d", logical)
		}
		records = append(records, got...)
		if len(records) == 4 {
			break
		} // do not parse later growing capture data
	}
	expected := []struct {
		id              string
		rounds, seconds int
	}{{"2306377934505522485", 29, 403}, {"1876469132858231472", 3, 47}, {"1876469132858231473", 8, 161}, {"1876469132858231474", 31, 551}}
	if len(records) != 4 || a.Pending() != 0 {
		t.Fatalf("records=%d pending=%d", len(records), a.Pending())
	}
	for i, r := range records {
		want := expected[i]
		if r.ID != "rkpp:"+want.id || r.Rounds != want.rounds || r.DurationSeconds == nil || *r.DurationSeconds != want.seconds {
			t.Fatal("boundary mismatch", r.ID)
		}
		counts := map[string]int{}
		casts, mapped := 0, 0
		for _, e := range r.Events {
			counts[e.Kind]++
			if battleCombatSourceAction(e) {
				casts++
			}
			if e.Kind == "skill" && e.SkillID > 0 {
				mapped++
			}
		}
		if casts != []int{60, 4, 19, 64}[i] || counts["damage"] != []int{21, 3, 5, 17}[i] || counts["switch"] != []int{2, 1, 5, 25}[i] || counts["form"] != []int{4, 0, 0, 2}[i] {
			t.Fatal("primary counts differ from independent source audit", r.ID, casts, counts)
		}
		if r.Outcome != []string{"win", "loss", "loss", "win"}[i] {
			t.Fatal("audited outcome mismatch", r.ID)
		}
		profiles, natures, loadouts := 0, 0, 0
		for _, p := range r.Sides["me"].Pets {
			if len(p.IV) == 6 {
				profiles++
			}
			if len(p.Nature) == 6 {
				natures++
			}
			if p.InitialSkills != nil && p.InitialSkills.Complete {
				loadouts++
			}
		}
		t.Logf("direct own IV profiles=%d nature profiles=%d initial loadouts=%d mapped ordinary/response skills=%d/%d", profiles, natures, loadouts, mapped, counts["skill"])
		if profiles != 6 || natures != 6 {
			t.Fatal("proven own initial profiles not retained")
		}
		for _, p := range r.Sides["enemy"].Pets {
			if p.InitialSkills != nil || len(p.IV) > 0 || len(p.Nature) > 0 {
				t.Fatal("unknown enemy initial profile/loadout fabricated")
			}
		}
		if counts["skill"] == 0 || counts["resource"] < 12 {
			t.Fatal("lifecycle stub")
		}
		if len(r.Sides["me"].Pets) != 6 || len(r.Sides["enemy"].Pets) != 6 {
			t.Fatal("initial full-roster evidence missing", r.ID)
		}
		t.Logf("%s rounds=%d seconds=%d outcome=%s pets=%d/%d events=%d kinds=%v quality=%+v", r.ID, r.Rounds, *r.DurationSeconds, r.Outcome, len(r.Sides["me"].Pets), len(r.Sides["enemy"].Pets), len(r.Events), counts, r.Quality)
	}
	// Replay the same authorized ordered source without retaining source frames.
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		t.Fatal(e)
	}
	reader = csv.NewReader(f)
	if _, e = reader.Read(); e != nil {
		t.Fatal(e)
	}
	finishes := 0
	for {
		row, e := reader.Read()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal("replay CSV parse failed")
		}
		if !strings.HasPrefix(row[col["meaning"]], "ZoneBattle") {
			continue
		}
		got, _, e := a.Push(liveTestFrame(row[col["opencode"]], row[col["content"]]))
		if e != nil || len(got) != 0 {
			t.Fatalf("replay changed already finalized facts: emitted=%d error=%v", len(got), e)
		}
		if row[col["meaning"]] == "ZoneBattleFinishNotify" {
			finishes++
			if finishes == 4 {
				break
			}
		}
	}
	if out := os.Getenv("BATTLE_LIVE_NORMALIZED_OUTPUT"); out != "" {
		if _, e := os.Stat(out); e == nil {
			t.Fatal("refuse overwrite existing output")
		}
		b, e := json.MarshalIndent(map[string]any{"version": 1, "records": records}, "", "  ")
		if e != nil {
			t.Fatal(e)
		}
		for _, blocked := range []string{"role_uin", "visit_owner", "nickname", "uin_brief", "capture.log", "src_ip"} {
			if strings.Contains(string(b), blocked) {
				t.Fatal("forbidden output field")
			}
		}
		if e = os.WriteFile(out, append(b, '\n'), 0600); e != nil {
			t.Fatal(e)
		}
		t.Log(fmt.Sprintf("normalized records written to explicit output (%d bytes)", len(b)))
	}
}
