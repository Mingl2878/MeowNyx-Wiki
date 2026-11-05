package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func domainNamedFrame(t *testing.T) map[string]any {
	t.Helper()
	// Fully synthetic, matching the actual named schema field paths. IDs and
	// hex pet names below are test data; no captured profile/traffic is consulted.
	const input = `{"opcode":4890,"summary_kind":"round_start","captured_at":"2026-10-28T02:00:00Z","content":{
 "state_info":{"battle_id":"18446744073709551615","round":2,
 "player_team":[{"base":{"role_uin":333,"side":92,"name":"PRIVATE_SENTINEL"},"first_team":[42],"pets":[{"battle_inside_pet_info":{"pet_id":101,"conf_id":10001,"pos":0},"battle_common_pet_info":{"gid":999,"conf_id":10001,"name":"53656c66","level":60}}]}],
 "enemy_team":[{"base":{"role_uin":444,"side":91,"rank_order":1},"pets":[{"battle_inside_pet_info":{"pet_id":202,"conf_id":10002,"is_entered":true,"enter_index":1},"battle_common_pet_info":{"gid":888,"conf_id":10002,"name":"456e656d79","level":60,"nature":25,"talent_rank":10,"grow_times":999}},{"battle_inside_pet_info":{"pet_id":203,"conf_id":10003},"battle_common_pet_info":{"conf_id":10003,"level":50}}]}]},
 "perform_cmd":{"round":2,"seq_num":9,"perform_info":[
 {"type":1,"exec_index":1,"skill_cast":{"caster_id":202,"target_id":[101],"skill_id":90001}},
 {"type":4,"exec_index":2,"damage_info":{"caster_id":202,"target_id":101,"source_id":90001,"is_hit":true}},
 {"type":4,"exec_index":3,"damage_info":{"caster_id":202,"target_id":101,"source_id":90001}},
 {"type":5,"exec_index":4,"heal_info":{"caster_id":101,"target_id":101,"source_id":90002}},
 {"type":13,"exec_index":5,"change_pet":{"player_id":91,"battle_pet_id":203,"rest_pet_id":202}},
 {"type":2,"exec_index":6,"buff_change":{"caster_id":202,"target_id":101,"buff_id":77}},
 {"type":22,"exec_index":7,"weather_change":{"skill_id":90003,"weather_id":2}},
 {"type":20,"exec_index":8,"pet_evolution":{"uninterpreted":"PRIVATE_SENTINEL"}}
 ]},"keys":{"session":"PRIVATE_SENTINEL"}}}`
	var out map[string]any
	d := json.NewDecoder(strings.NewReader(input))
	d.UseNumber()
	if err := d.Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}
func domainNamedParts(frame map[string]any) (map[string]any, map[string]any) {
	c := frame["content"].(map[string]any)
	return c["state_info"].(map[string]any), c["perform_cmd"].(map[string]any)
}

func TestBattleDomainNamedSchemaRosterAndTimeline(t *testing.T) {
	frame := domainNamedFrame(t)
	records, issues, err := DecodeBattleImport(domainEncode(t, frame))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatal(records)
	}
	r := records[0]
	if r.ID != "rkpp:18446744073709551615" || r.Source != "rkpp-named-schema" || len(r.Sides["me"].Pets) != 1 || len(r.Sides["enemy"].Pets) != 2 || len(r.Events) != 9 {
		t.Fatalf("lost named schema content %+v", r)
	}
	p := r.Sides["enemy"].Pets[0]
	if p.InstanceID != "202" || p.ProtocolID != "10002" || p.MonsterID != 0 || p.Name != "Enemy" || p.Level == nil || *p.Level != 60 || len(p.IV) > 0 || len(p.Nature) > 0 {
		t.Fatalf("incorrect pet mapping %+v", p)
	}
	if r.Sides["enemy"].Lead != "" || r.Quality.Roster["enemy"] || r.Quality.Actions || r.Quality.Lead["enemy"] || r.Sides["enemy"].Before.Rank != nil {
		t.Fatal("raw complete/rank/lead guessed")
	}
	cast := r.Events[1]
	if cast.Kind != "skill" || cast.ProtocolSkillID != "90001" || cast.SkillID != 0 || cast.Actor != "202" || cast.Side != "enemy" || cast.Target != "101" || cast.TargetSide != "me" || cast.Phase != "executed" {
		t.Fatalf("cast %+v", cast)
	}
	for _, e := range r.Events {
		if e.Kind == "damage" && (e.Amount != nil || e.SkillID != 0 || e.ProtocolSkillID != "") {
			t.Fatal("source_id invented damage or skill")
		}
		if e.Kind == "growth" {
			t.Fatal("grow_times became growth")
		}
	}
	if strings.Contains(string(domainEncode(t, r))+strings.Join(issues, " "), "PRIVATE_SENTINEL") {
		t.Fatal("private fields leaked")
	}
	// Same round packet replay has stable identity, not one cast per hit/row.
	replay, _, err := DecodeBattleImport(append(append(domainEncode(t, frame), '\n'), domainEncode(t, frame)...))
	if err != nil || len(replay) != 1 || len(replay[0].Events) != 9 {
		t.Fatal("replay duplicated", err)
	}
}

func TestBattleDomainNamedSchemaExplicitManualMapping(t *testing.T) {
	records, _, err := DecodeBattleImport(domainEncode(t, domainNamedFrame(t)))
	if err != nil {
		t.Fatal(err)
	}
	raw := records[0]
	mapped := domainClone(t, raw)
	for side, s := range mapped.Sides {
		for i := range s.Pets {
			s.Pets[i].MonsterID = 100 + i
		}
		mapped.Sides[side] = s
	}
	mapped.Events[1].SkillID = 501
	merged, err := MergeBattleRecord(raw, mapped)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Events[1].SkillID != 501 || merged.Events[1].ProtocolSkillID != "90001" || merged.Sides["enemy"].Pets[0].MonsterID != 100 {
		t.Fatal("unknown mapping enrichment failed")
	}
	if raw.Events[1].SkillID != 0 || raw.Sides["enemy"].Pets[0].MonsterID != 0 {
		t.Fatal("input mutated")
	}
	again, err := MergeBattleRecord(merged, raw)
	if err != nil || again.Events[1].SkillID != 501 {
		t.Fatal("raw replay erased mapping", err)
	}
	bad := domainClone(t, mapped)
	bad.Events[1].ProtocolSkillID = "other"
	if _, err = MergeBattleRecord(raw, bad); err == nil {
		t.Fatal("protocol skill conflict accepted")
	}
	bad = domainClone(t, mapped)
	bad.Events[1].Amount = domainFloat(99)
	if _, err = MergeBattleRecord(raw, bad); err == nil {
		t.Fatal("mapping changed effect fields")
	}
	bad = domainClone(t, mapped)
	bad.Events[1].SkillID = 502
	if _, err = MergeBattleRecord(merged, bad); err == nil {
		t.Fatal("known mapping conflict accepted")
	}
	// Canonical numeric protocol IDs are safe-string normalized too.
	var obj map[string]any
	json.Unmarshal(domainEncode(t, mapped), &obj)
	obj["events"].([]any)[1].(map[string]any)["protocolSkillId"] = 90001
	if _, _, err = DecodeBattleImport(domainEncode(t, obj)); err != nil {
		t.Fatal(err)
	}
}

func TestBattleDomainNamedSchemaUnknownsAndBounds(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
		fail   bool
	}{
		{"type conflict", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["type"] = json.Number("4")
		}, true},
		{"double branch", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["damage_info"] = map[string]any{}
		}, true},
		{"unsafe caster", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["skill_cast"].(map[string]any)["caster_id"] = json.Number("9007199254740992")
		}, true},
		{"invalid repeated", func(f map[string]any) { state, _ := domainNamedParts(f); state["player_team"] = map[string]any{} }, true},
		{"unknown actor", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["skill_cast"].(map[string]any)["caster_id"] = json.Number("987")
		}, false},
		{"missing sequence", func(f map[string]any) { _, cmd := domainNamedParts(f); delete(cmd, "seq_num") }, false},
		{"multi target", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["skill_cast"].(map[string]any)["target_id"] = []any{json.Number("101"), json.Number("203")}
		}, false},
		{"interrupted", func(f map[string]any) {
			_, cmd := domainNamedParts(f)
			cmd["perform_info"].([]any)[0].(map[string]any)["skill_cast"].(map[string]any)["is_interupt"] = true
		}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			frame := domainNamedFrame(t)
			tc.mutate(frame)
			rs, _, err := DecodeBattleImport(domainEncode(t, frame))
			if (err != nil) != tc.fail {
				t.Fatal(err)
			}
			if err != nil {
				return
			}
			r := rs[0]
			if r.Quality.Actions {
				t.Fatal("incomplete action became complete")
			}
			if tc.name == "unknown actor" && r.Events[1].Side != "unknown" {
				t.Fatal("guessed actor side")
			}
			if tc.name == "missing sequence" && len(r.Events) != 1 {
				t.Fatal("undedupeable actions retained")
			}
			if tc.name == "interrupted" && r.Events[1].Phase != "unknown" {
				t.Fatal("interrupted cast executed")
			}
		})
	}
}

func TestBattleDomainNamedAnalyzerAndEnterEnvelopes(t *testing.T) {
	frame := domainNamedFrame(t)
	state, _ := domainNamedParts(frame)
	envelope := map[string]any{"record": map[string]any{"opcode": 4886, "raw_key": "PRIVATE_SENTINEL"}, "summary_kind": "battle_enter", "summary_obj": map[string]any{"detail": map[string]any{"battle_id": 123, "schema_found": true}}}
	rs, _, err := DecodeBattleImport(domainEncode(t, envelope))
	if err != nil || len(rs) != 1 {
		t.Fatal(err)
	}
	frame = map[string]any{"opcode": 4886, "decoded_json": string(domainEncode(t, map[string]any{"round": 0, "init_info": state}))}
	rs, _, err = DecodeBattleImport(domainEncode(t, frame))
	if err != nil || len(rs[0].Sides["enemy"].Pets) != 2 {
		t.Fatal("named enter not supported", err)
	}
	// Even when a display name looks like an ID, it is never used as one.
	if rs[0].Sides["enemy"].Pets[0].MonsterID != 0 {
		t.Fatal("name identity guessed")
	}
}

func TestBattleDomainAdditionalDenominatorAndIdempotency(t *testing.T) {
	r := domainFixture("test")
	r.Quality.Roster["enemy"] = false
	e := domainEnemy(t, BuildBattleStats([]BattleRecord{r}, nil), 2)
	if e.CarriedLeadSamples != 1 || e.Leads != 1 || e.CarrySamples != 0 {
		t.Fatal("conditional lead denominator inconsistent", e)
	}
	r.Sides["enemy"].Pets[0].IV["attack"] = BattleEvidence{Certainty: "candidate", Candidates: []float64{60}}
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	m, err := MergeBattleRecord(r, r)
	if err != nil || !reflect.DeepEqual(domainEncode(t, m), domainEncode(t, r)) {
		t.Fatal("singleton candidate idempotency", err)
	}
}
