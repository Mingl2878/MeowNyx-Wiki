package main

import (
	"encoding/json"
	"testing"
)

func TestBattleLiveCanonicalObjectsArraysAndEnvelopes(t *testing.T) {
	r := backendBattle(t, "canonical-live-compat")
	r.Source = "canonical-source-kept"
	for _, value := range []any{r, []BattleRecord{r}, map[string]any{"version": 1, "records": []BattleRecord{r}}} {
		frame, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		a := NewBattleStreamAssembler()
		records, accepted, e := a.Push(frame)
		if e != nil || !accepted || len(records) != 1 {
			t.Fatal("canonical compatibility", accepted, e)
		}
		if records[0].ID != r.ID || records[0].Source != r.Source || a.Pending() != 0 {
			t.Fatal("canonical source changed or became pending")
		}
	}
}
func TestBattleLiveCanonicalSafetyAndNoRawBypass(t *testing.T) {
	a := NewBattleStreamAssembler()
	for _, raw := range []string{
		`{"version":2,"records":[{"version":1,"id":"x","events":[],"sides":{}}]}`,
		`{"version":1,"id":2306377934505522485,"events":[],"sides":{}}`,
		`[{"version":1,"id":"canonical","events":[],"sides":{}},{"opencode":"0x1316","content":{"init_info":{"battle_id":123}}}]`,
		`{"version":1,"records":[{"opencode":"0x1316","content":{"init_info":{"battle_id":123}}}]}`,
		`{"version":1,"records":null}`,
		`{"version":1,"id":null,"events":[],"sides":{}}`,
	} {
		records, _, e := a.Push([]byte(raw))
		if e == nil || len(records) != 0 || a.Pending() != 0 {
			t.Fatal("unsafe normalized or mixed raw input bypassed", e)
		}
	}
	// A raw opening still enters the stateful path and cannot emit a record.
	if records, accepted, e := a.Push(liveTestStart("123")); e != nil || !accepted || len(records) != 0 || a.Pending() != 1 {
		t.Fatal("raw opening bypassed stateful finalization")
	}
	if records, accepted, e := a.Push([]byte(`[{"heartbeat":true}]`)); e != nil || accepted || len(records) != 0 {
		t.Fatal("irrelevant array not ignored")
	}
}
