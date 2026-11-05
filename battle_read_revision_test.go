package main

import (
	"strings"
	"sync"
	"testing"
)

func TestBattleReadRevisionExactSourceFingerprint(t *testing.T) {
	catalogData := performanceCatalog(t)
	type record struct{ id, at, outcome, raw string }
	type rule struct {
		id       string
		position int
		raw      string
	}
	records := []record{{"a", "2026-11-04T00:00:00Z", "win", `{"id":"a","damage":123}`}, {"b", "2026-11-04T01:00:00Z", "loss", `{"id":"b","damage":456}`}}
	rules := []rule{{"first", 0, `{"id":"first","monsterIds":[1]}`}, {"second", 1, `{"id":"second","monsterIds":[2]}`}}
	fingerprint := func(rs []record, rules []rule, data []byte, configured bool, epoch string) string {
		h := battleNewRevisionHasher(data, epoch)
		for _, r := range rs {
			h.record(r.id, r.at, r.outcome, r.raw)
		}
		for _, rule := range rules {
			h.rule(rule.id, rule.position, rule.raw)
		}
		h.configured(configured)
		return h.revision()
	}
	base := fingerprint(records, rules, catalogData, false, "process-one")
	if len(base) != 64 || base != fingerprint(records, rules, catalogData, false, "process-one") {
		t.Fatal("identical snapshot revision unstable")
	}
	for _, field := range []string{"id", "at", "outcome", "raw"} {
		changed := append([]record(nil), records...)
		switch field {
		case "id":
			changed[0].id = "c"
		case "at":
			changed[0].at = "2026-11-04T00:00:01Z"
		case "outcome":
			changed[0].outcome = "tie"
		case "raw":
			changed[0].raw = strings.Replace(changed[0].raw, "123", "124", 1)
		}
		if base == fingerprint(changed, rules, catalogData, false, "process-one") {
			t.Fatalf("same-count/length change to %s did not invalidate", field)
		}
	}
	for _, field := range []string{"id", "position", "raw"} {
		changed := append([]rule(nil), rules...)
		switch field {
		case "id":
			changed[0].id = "third"
		case "position":
			changed[0].position = 2
		case "raw":
			changed[0].raw = strings.Replace(changed[0].raw, "[1]", "[3]", 1)
		}
		if base == fingerprint(records, changed, catalogData, false, "process-one") {
			t.Fatalf("rule %s did not invalidate", field)
		}
	}
	if base == fingerprint(records, []rule{rules[1], rules[0]}, catalogData, false, "process-one") {
		t.Fatal("rule order did not invalidate")
	}
	if base == fingerprint(records, rules, append(append([]byte(nil), catalogData...), '\n'), false, "process-one") {
		t.Fatal("exact catalog bytes not included")
	}
	if base == fingerprint(records, rules, catalogData, true, "process-one") {
		t.Fatal("explicit configured marker not included")
	}
	if base == fingerprint(records, rules, catalogData, false, "process-two") {
		t.Fatal("restart epoch not included")
	}
	if base == fingerprint(records[:1], rules, catalogData, false, "process-one") {
		t.Fatal("record deletion did not invalidate")
	}
	if fingerprint(nil, nil, catalogData, false, "process-one") == fingerprint(nil, nil, catalogData, true, "process-one") {
		t.Fatal("unconfigured default rules conflated with saved empty rules")
	}
}

func TestBattleReadRevisionLengthFramingAndRecordRuleSeparation(t *testing.T) {
	a, b := battleNewRevisionHasher(nil, "same"), battleNewRevisionHasher(nil, "same")
	a.field("ab")
	a.field("c")
	b.field("a")
	b.field("bc")
	if a.revision() == b.revision() {
		t.Fatal("ambiguous concatenation")
	}
	a, b = battleNewRevisionHasher(nil, "same"), battleNewRevisionHasher(nil, "same")
	a.record("x", "0", "", "json")
	b.rule("x", 0, "json")
	if a.revision() == b.revision() {
		t.Fatal("record/rule domain conflated")
	}
}

func TestBattleReadRevisionProcessEpochConcurrentStable(t *testing.T) {
	const workers = 32
	epochs := make([]string, workers)
	var wg sync.WaitGroup
	for i := range epochs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var err error
			epochs[i], err = battleReadRevisionEpoch()
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	for _, epoch := range epochs {
		if len(epoch) != 64 || epoch != epochs[0] {
			t.Fatal("concurrent callers use different process epochs")
		}
	}
}
