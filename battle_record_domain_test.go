package main

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
)

func domainFloat(v float64) *float64 { return &v }
func domainInt(v int) *int           { return &v }
func domainFixture(id string) BattleRecord {
	return BattleRecord{Version: 1, ID: id, StartedAt: "2026-10-28T10:00:00+08:00", Mode: "pvp", Outcome: "win", Source: "manual-normalized", Quality: BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Actions: true, Lead: map[string]bool{"me": true, "enemy": true}}, Sides: map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "m1", MonsterID: 1, Name: "Self"}}, Lead: "m1", Before: BattleRank{Score: domainFloat(100), Rank: domainInt(5), Tier: "Gold"}},
		"enemy": {Pets: []BattlePet{{InstanceID: "e1", MonsterID: 2, Name: "Enemy", IV: map[string]BattleEvidence{"speed": {Certainty: "direct", Value: domainFloat(60)}}, Nature: map[string]BattleEvidence{"speed": {Certainty: "direct", Value: domainFloat(1)}}}, {InstanceID: "e2", MonsterID: 3, Name: "Bench"}}, Lead: "e1"},
	}, Events: []BattleEvent{{ID: "s1", Round: 1, Seq: 1, Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e1", Target: "m1", TargetSide: "me", SkillID: 10}, {ID: "s2", Round: 1, Seq: 2, Kind: "skill", Phase: "executed", Side: "me", Actor: "m1", Target: "e1", TargetSide: "enemy", SkillID: 20}}}
}
func domainClone(t *testing.T, r BattleRecord) BattleRecord {
	t.Helper()
	c, err := battleClone(r)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func domainEncode(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func domainEnemy(t *testing.T, s BattleStats, id int) BattleEnemyStats {
	t.Helper()
	for _, e := range s.Enemy {
		if e.MonsterID == id {
			return e
		}
	}
	t.Fatalf("missing enemy %d: %+v", id, s.Enemy)
	return BattleEnemyStats{}
}

func TestBattleDomainCanonicalMultipleAndWhitelist(t *testing.T) {
	a, b := domainFixture("18446744073709551615"), domainFixture("second")
	input := map[string]any{"version": 1, "records": []BattleRecord{a, b}}
	forms := [][]byte{domainEncode(t, input), domainEncode(t, []BattleRecord{a, b}), append(append(domainEncode(t, a), '\n'), domainEncode(t, b)...)}
	for _, data := range forms {
		records, issues, err := DecodeBattleImport(data)
		if err != nil || len(records) != 2 || len(issues) == 0 {
			t.Fatalf("decode: %d %v %v", len(records), issues, err)
		}
		if len(records[0].Sides["enemy"].Pets) != 2 || len(records[0].Events) != 2 || records[0].ID != a.ID {
			t.Fatal("meaningful contents or uint64 string lost")
		}
		if records[0].StartedAt != "2026-10-28T02:00:00Z" {
			t.Fatal(records[0].StartedAt)
		}
	}
	var raw map[string]any
	json.Unmarshal(domainEncode(t, a), &raw)
	raw["keys"] = map[string]any{"session_key": "PRIVATE_SENTINEL"}
	raw["packet_hex"] = "PRIVATE_SENTINEL"
	raw["account"] = "PRIVATE_SENTINEL"
	sides := raw["sides"].(map[string]any)
	enemy := sides["enemy"].(map[string]any)
	enemy["uin"] = "PRIVATE_SENTINEL"
	enemy["pets"].([]any)[0].(map[string]any)["raw"] = "PRIVATE_SENTINEL"
	records, _, err := DecodeBattleImport(domainEncode(t, raw))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(domainEncode(t, records)), "PRIVATE_SENTINEL") {
		t.Fatal("unknown private fields survived whitelist")
	}
}

func TestBattleDomainIdentifierSafetyAndMalformedImports(t *testing.T) {
	tests := []string{
		`{"version":1,"id":9007199254740992,"sides":{}}`,
		`{"version":1,"id":18446744073709551615,"sides":{}}`,
		`{"version":1,"id":1.5,"sides":{}}`,
		`{"version":1,"id":"a","id":"b","sides":{}}`,
		`{"version":2,"records":[]}`,
		`{"version":1,"records":[{"version":2,"id":"a","sides":{}}]}`,
		`{"version":1,"id":"a","sides":{"enemy":{"pets":[{"instanceId":9007199254740992,"monsterId":1}]}}}`,
		`{"version":1,"id":"a","sides":{"enemy":{"pets":[{"instanceId":"e","monsterId":9007199254740992}]}}}`,
		`{"version":1,"id":"a","sides":{},"events":{},"secret":"PRIVATE_SENTINEL"}`,
		"{bad json PRIVATE_SENTINEL}", `null`, `[]`, `{"profile":{"raw":"PRIVATE_SENTINEL"}}`,
	}
	for _, input := range tests {
		_, issues, err := DecodeBattleImport([]byte(input))
		if err == nil {
			t.Fatalf("accepted %s", input)
		}
		if strings.Contains(err.Error()+strings.Join(issues, ""), "PRIVATE_SENTINEL") {
			t.Fatal("error leaked input")
		}
	}
	good := `{"version":1,"id":9007199254740991,"sides":{}}`
	r, _, err := DecodeBattleImport([]byte(good))
	if err != nil || r[0].ID != "9007199254740991" {
		t.Fatal(r, err)
	}
	_, _, err = DecodeBattleImport([]byte(strings.Repeat("[", 50) + "1" + strings.Repeat("]", 50)))
	if err == nil {
		t.Fatal("unbounded nesting")
	}
	_, _, err = DecodeBattleImport(make([]byte, BattleMaxImportBytes+1))
	if err == nil {
		t.Fatal("size bound")
	}
}

func TestBattleDomainDeepValidation(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*BattleRecord)
	}{
		{"future version", func(r *BattleRecord) { r.Version = 2 }},
		{"id", func(r *BattleRecord) { r.ID = " bad " }},
		{"timestamp", func(r *BattleRecord) { r.StartedAt = "2026-10-28 10:00:00" }},
		{"end before start", func(r *BattleRecord) { r.EndedAt = "2020-01-01T00:00:00Z" }},
		{"enum", func(r *BattleRecord) { r.Outcome = "victory" }},
		{"side", func(r *BattleRecord) { r.Sides["42"] = BattleSide{} }},
		{"quality", func(r *BattleRecord) { r.Quality.Lead["42"] = true }},
		{"rank", func(r *BattleRecord) { s := r.Sides["me"]; s.Before.Rank = domainInt(0); r.Sides["me"] = s }},
		{"nan", func(r *BattleRecord) { r.Events[0].Amount = domainFloat(math.NaN()) }},
		{"negative", func(r *BattleRecord) { r.Events[0].Round = -1 }},
		{"phase", func(r *BattleRecord) { r.Events[0].Phase = "cast" }},
		{"duplicate event", func(r *BattleRecord) { e := r.Events[0]; e.SkillID = 11; r.Events = append(r.Events, e) }},
		{"duplicate pet", func(r *BattleRecord) {
			s := r.Sides["enemy"]
			p := s.Pets[0]
			p.MonsterID = 999
			s.Pets = append(s.Pets, p)
			r.Sides["enemy"] = s
		}},
		{"evidence units", func(r *BattleRecord) {
			r.Sides["enemy"].Pets[0].IV["speed"] = BattleEvidence{Certainty: "direct", Value: domainFloat(61)}
		}},
		{"nature enum", func(r *BattleRecord) {
			r.Sides["enemy"].Pets[0].Nature["speed"] = BattleEvidence{Certainty: "direct", Value: domainFloat(-1)}
		}},
		{"missing evidence", func(r *BattleRecord) { r.Sides["enemy"].Pets[0].IV["speed"] = BattleEvidence{Certainty: "unique"} }},
		{"unknown evidence asserts value", func(r *BattleRecord) {
			r.Sides["enemy"].Pets[0].IV["speed"] = BattleEvidence{Certainty: "unknown", Value: domainFloat(0)}
		}},
		{"candidate asserts value", func(r *BattleRecord) {
			r.Sides["enemy"].Pets[0].IV["speed"] = BattleEvidence{Certainty: "candidate", Value: domainFloat(60), Candidates: []float64{0, 60}}
		}},
		{"unknown stat", func(r *BattleRecord) { r.Sides["enemy"].Pets[0].IV["keys"] = BattleEvidence{Certainty: "unknown"} }},
		{"actor conflicting side", func(r *BattleRecord) { r.Events[0].Side = "me" }},
		{"target conflicting side", func(r *BattleRecord) { r.Events[0].TargetSide = "enemy" }},
		{"growth no trigger", func(r *BattleRecord) { r.Events[0].Kind = "growth" }},
		{"growth selection", func(r *BattleRecord) {
			r.Events[0].Kind = "growth"
			r.Events[0].Trigger = "manual explicit trigger"
			r.Events[0].Phase = "selection"
		}},
		{"oversize text", func(r *BattleRecord) { r.Events[0].Text = strings.Repeat("x", 2049) }},
		{"too many events", func(r *BattleRecord) { r.Events = make([]BattleEvent, BattleMaxEvents+1) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := domainFixture("test")
			tc.mutate(&r)
			if err := ValidateBattleRecord(&r); err == nil {
				t.Fatal("accepted invalid record")
			}
		})
	}
}

func TestBattleDomainConservativeFlagsAndAttribution(t *testing.T) {
	r := domainFixture("test")
	r.Sides["enemy"] = BattleSide{}
	r.Events = nil
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Quality.Roster["enemy"] || r.Quality.Lead["enemy"] || r.Quality.Actions {
		t.Fatal("empty data claims complete")
	}
	r = domainFixture("test")
	r.Events[0].Side = "unknown"
	r.Events[0].TargetSide = "unknown"
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Events[0].Side != "enemy" || r.Events[0].TargetSide != "me" {
		t.Fatal("unique side mapping failed")
	}
	r = domainFixture("test")
	s := r.Sides["me"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "e1", MonsterID: 9})
	r.Sides["me"] = s
	r.Events[0].Side = "unknown"
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Events[0].Side != "unknown" || r.Quality.Actions {
		t.Fatal("ambiguous side guessed")
	}
	r = domainFixture("test")
	r.Events[0].Actor = "unseen"
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Quality.Actions {
		t.Fatal("unmapped actor complete")
	}
	r = domainFixture("test")
	r.Sides["enemy"].Pets[0].MonsterID = 0
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	if r.Quality.Actions || r.Quality.Roster["enemy"] || r.Quality.Lead["enemy"] {
		t.Fatal("unmapped species complete")
	}
}

func TestBattleDomainMergeAndEvidence(t *testing.T) {
	a := domainFixture("test")
	if err := ValidateBattleRecord(&a); err != nil {
		t.Fatal(err)
	}
	merged, err := MergeBattleRecord(a, a)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(domainEncode(t, a), domainEncode(t, merged)) {
		t.Fatalf("non-idempotent merge\n%s\n%s", domainEncode(t, a), domainEncode(t, merged))
	}
	b := domainClone(t, a)
	b.Events[0].SkillID = 999
	if _, err = MergeBattleRecord(a, b); err == nil {
		t.Fatal("event conflict accepted")
	}
	b = domainClone(t, a)
	b.Sides["enemy"].Pets[0].MonsterID = 999
	if _, err = MergeBattleRecord(a, b); err == nil {
		t.Fatal("identity conflict accepted")
	}
	b = domainClone(t, a)
	b.Sides["enemy"].Pets[0].IV["speed"] = BattleEvidence{Certainty: "unique", Value: domainFloat(0)}
	if _, err = MergeBattleRecord(a, b); err == nil {
		t.Fatal("direct evidence overwritten")
	}
	b = domainClone(t, a)
	b.Sides["enemy"].Pets[0].IV["attack"] = BattleEvidence{Certainty: "candidate", Candidates: []float64{60, 0, 60}}
	merged, err = MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Sides["enemy"].Pets[0].IV["attack"].Candidates) != 2 {
		t.Fatal("candidate enrichment missing")
	}
	if _, ok := a.Sides["enemy"].Pets[0].IV["attack"]; ok {
		t.Fatal("input mutated")
	}
	c := domainClone(t, merged)
	c.Sides["enemy"].Pets[0].IV["attack"] = BattleEvidence{Certainty: "unique", Value: domainFloat(60)}
	merged, err = MergeBattleRecord(merged, c)
	if err != nil || merged.Sides["enemy"].Pets[0].IV["attack"].Certainty != "unique" {
		t.Fatal("unique enrichment failed", err)
	}
	b = domainClone(t, a)
	b.Events = append(b.Events, BattleEvent{ID: "extra", Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e1", SkillID: 10})
	merged, err = MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Quality.Actions {
		t.Fatal("extended completeness retained")
	}
	b = domainClone(t, a)
	s := b.Sides["enemy"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "e3", MonsterID: 4})
	b.Sides["enemy"] = s
	merged, err = MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Quality.Roster["enemy"] {
		t.Fatal("extended roster retained complete")
	}
	a.Quality.Actions = false
	b = domainClone(t, a)
	merged, err = MergeBattleRecord(a, b)
	if err != nil || merged.Quality.Actions {
		t.Fatal("partial union became complete")
	}
}

func TestBattleDomainConstraintsAndGrowth(t *testing.T) {
	r := domainFixture("test")
	c := BattleConstraint{ID: "condition", Side: "enemy", InstanceID: "e1", Stat: "speed", Kind: "speedOrder", KnownStat: 123, Level: 60, Before: true, SamePriority: true, ModifiersKnown: true, Provenance: "manual explicit equal-priority order", Round: 2}
	r.Constraints = []BattleConstraint{c}
	records, _, err := DecodeBattleImport(domainEncode(t, r))
	if err != nil || len(records[0].Constraints) != 1 {
		t.Fatal(err)
	}
	partial := domainClone(t, r)
	partial.Constraints[0].ModifiersKnown = false
	if err = ValidateBattleRecord(&partial); err != nil || len(partial.Issues) == 0 {
		t.Fatal("incomplete constraint not visible", err)
	}
	invalid := []func(*BattleConstraint){func(c *BattleConstraint) { c.Stat = "hp" }, func(c *BattleConstraint) { c.Side = "unknown" }, func(c *BattleConstraint) { c.InstanceID = "absent" }, func(c *BattleConstraint) { c.KnownStat = -1 }, func(c *BattleConstraint) { c.Level = 1000 }, func(c *BattleConstraint) { c.Reduction = 101 }, func(c *BattleConstraint) { c.Effectiveness = math.Inf(1) }, func(c *BattleConstraint) { c.Damage = domainInt(-1) }}
	for _, fn := range invalid {
		bad := domainClone(t, r)
		fn(&bad.Constraints[0])
		if err = ValidateBattleRecord(&bad); err == nil {
			t.Fatal("invalid constraint accepted")
		}
	}
	incoming := domainClone(t, r)
	incoming.Constraints[0].KnownStat = 999
	if _, err = MergeBattleRecord(r, incoming); err == nil {
		t.Fatal("constraint conflict accepted")
	}
	incoming = domainClone(t, r)
	c.ID = "another"
	incoming.Constraints = append(incoming.Constraints, c)
	m, err := MergeBattleRecord(r, incoming)
	if err != nil || len(m.Constraints) != 2 {
		t.Fatal("constraint addition failed", err)
	}
	r.Events = append(r.Events, BattleEvent{ID: "growth", Round: 2, Kind: "growth", Phase: "executed", Side: "enemy", Actor: "e1", SkillID: 10, Trigger: "explicit confirmed trigger", Stacks: domainInt(1)})
	if err = ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	s := BuildBattleStats([]BattleRecord{r}, nil)
	if domainEnemy(t, s, 2).Skills[0].Casts != 1 {
		t.Fatal("growth counted as cast")
	}
}

func TestBattleDomainRKPPCheckedShapesAndLimitations(t *testing.T) {
	// Synthetic shapes matching checked extractors/relay, not captured user data.
	frames := []string{
		`{"opcode":4886,"opencode":"0x1316","summary_kind":"battle_enter","content":{"detail":{"battle_id":"18446744073709551615","battle_start_time":1234,"battle_mode":2,"wrappers":[{"name":"Enemy","slot":2,"pet_id":100020,"level":60,"talent":60,"nature":1,"grow_times":99}]}}}`,
		`{"opcode":4890,"summary_kind":"round_start","content":{"state_info":{"battle_id":"18446744073709551615","round":2},"perform_cmd":{}}}`,
		`{"opcode":4908,"summary_kind":"battle_finish","content":{"settle_info":{"battle_id":"18446744073709551615","result":2},"pvp_score":100,"total_pvp_score":200,"seen_monster_id":[123],"pet_info":[{"pet_gid":42,"uin":1}]}}`,
		`{"opcode":4886,"summary_kind":"battle_enter","summary_json":"{\"detail\":{\"battle_id\":77,\"round\":1}}"}`,
		`{"opcode":5107,"summary_kind":"preplay","content":{"entries":[{"kind":"skill_cast","skill_id":888,"actor_side":2}],"battle_id":77}}`,
		`{"opcode":4900,"summary_kind":"action_resolve","content":{"detail":{"entries":[{"kind":"skill_cast","skill_id":888},{"kind":"damage","damage":99}]}}}`,
		`{"profile":{"rank_order":1,"session_key":"PRIVATE_SENTINEL","talent":[60,60]}}`,
	}
	records, issues, err := DecodeBattleImport([]byte(strings.Join(frames, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || len(records[0].Events) != 3 {
		t.Fatalf("records: %+v", records)
	}
	for _, r := range records {
		if r.Outcome != "unknown" || r.Mode != "unknown" || r.StartedAt != "" || r.EndedAt != "" || r.Quality.Actions || r.Quality.Roster["enemy"] || r.Quality.Lead["enemy"] || len(r.Sides["enemy"].Pets) > 0 || r.Sides["me"].After.Score != nil || len(r.Constraints) > 0 {
			t.Fatal("raw fields guessed", r)
		}
		for _, e := range r.Events {
			if e.Kind != "note" || e.Phase != "unknown" || e.SkillID != 0 {
				t.Fatal("raw cast invented")
			}
		}
	}
	if !strings.Contains(strings.Join(issues, " "), "lifecycle-only") || !strings.Contains(strings.Join(issues, " "), "Unsupported") {
		t.Fatal("limitations omitted", issues)
	}
	if strings.Contains(string(domainEncode(t, records))+strings.Join(issues, " "), "PRIVATE_SENTINEL") {
		t.Fatal("privacy leak")
	}
	for _, bad := range []string{`{"opcode":4886,"content":{"detail":{"battle_id":9007199254740992}}}`, `{"opcode":4886,"opencode":"0x132c","content":{"detail":{"battle_id":1}}}`, `{"opcode":4886,"summary_kind":"battle_finish","content":{"detail":{"battle_id":1}}}`} {
		if _, _, err = DecodeBattleImport([]byte(bad)); err == nil {
			t.Fatal("unsafe/conflicting raw accepted")
		}
	}
	// Stable retransmission identity ignores transport row/flow/seq/capture time.
	duplicates, _, err := DecodeBattleImport([]byte(frames[0] + "\n" + frames[0]))
	if err != nil || len(duplicates) != 1 || len(duplicates[0].Events) != 1 {
		t.Fatal("RKPP retransmission duplicated", err)
	}
	if _, _, err = DecodeBattleImport([]byte(frames[5])); err == nil {
		t.Fatal("orphan actions reported successful import")
	}
}

func TestBattleDomainStatisticsDenominators(t *testing.T) {
	a := domainFixture("a")
	a.Events = append(a.Events, BattleEvent{ID: "cast2", Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e1", SkillID: 10}, BattleEvent{ID: "preview", Kind: "skill", Phase: "preview", Side: "enemy", Actor: "e2", SkillID: 99}, BattleEvent{ID: "choice", Kind: "skill", Phase: "selection", Side: "enemy", Actor: "e2", SkillID: 99}, BattleEvent{ID: "hit1", Kind: "damage", Phase: "executed", Side: "enemy", Actor: "e1", Target: "m1", TargetSide: "me", Amount: domainFloat(12)}, BattleEvent{ID: "hit2", Kind: "damage", Phase: "executed", Side: "enemy", Actor: "e1", Target: "m1", TargetSide: "me", Amount: domainFloat(12)})
	a.Events = append(a.Events, a.Events[0]) // duplicate event ID must not count twice
	b := domainFixture("b")
	b.Quality.Actions = false
	b.Events = append(b.Events, BattleEvent{ID: "partialcast", Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e1", SkillID: 11})
	b.Outcome = "loss"
	c := domainFixture("c")
	c.Events[0].Actor = "e2"
	c.Events[0].SkillID = 30
	c.Events[1].Target = "e2"
	c.Outcome = "draw"
	s := c.Sides["enemy"]
	s.Lead = "e2"
	c.Sides["enemy"] = s
	d := domainFixture("d")
	d.Quality.Roster["enemy"] = false
	d.Quality.Lead["enemy"] = false
	d.Quality.Actions = false
	d.Outcome = "unknown"
	rules := []BattleTeamRule{{ID: "team", Name: "Both", MonsterIDs: []int{2, 3, 2}}, {ID: "absent", MonsterIDs: []int{2, 999}}}
	result := BuildBattleStats([]BattleRecord{a, b, c, d, a}, rules)
	if result.MatchedBattles != 4 || result.Outcomes != (BattleOutcomeStats{1, 1, 1, 1}) || result.Quality != (BattleQualityStats{3, 2, 3}) {
		t.Fatalf("summary %+v", result)
	}
	e := domainEnemy(t, result, 2)
	if e.Carried != 3 || e.CarrySamples != 3 || e.Appeared != 1 || e.AppearSamples != 2 || e.Leads != 2 || e.LeadSamples != 3 || e.CarriedLeadSamples != 3 {
		t.Fatalf("denominators %+v", e)
	}
	if len(e.Skills) != 1 || e.Skills[0] != (BattleSkillStats{SkillID: 10, UsedBattles: 1, Samples: 1, Casts: 2}) {
		t.Fatalf("skill denominator %+v", e.Skills)
	}
	bench := domainEnemy(t, result, 3)
	if bench.Appeared != 1 || len(bench.Skills) != 1 || bench.Skills[0].SkillID != 30 || bench.Skills[0].Samples != 1 {
		t.Fatalf("bench/preview %+v", bench)
	}
	if result.Teams[0].Battles != 3 || result.Teams[0].Samples != 3 || result.Teams[1].Battles != 0 {
		t.Fatal(result.Teams)
	}
	if len(result.SelfSkills) != 1 || result.SelfSkills[0] != (BattleSelfSkillStats{MonsterID: 1, SkillID: 20, Casts: 4, TotalCasts: 4, UsedBattles: 4, Samples: 4}) {
		t.Fatal(result.SelfSkills)
	}
	if e.ProfileSamples != 4 || e.IVSamples["speed"] != 4 || e.IVDistributions["speed"]["60"] != 4 || e.UnknownProfiles != 4 {
		t.Fatalf("profile samples %+v", e)
	}
}

func TestBattleDomainSameSpeciesProfilesAndAttribution(t *testing.T) {
	r := domainFixture("r")
	s := r.Sides["enemy"]
	p := s.Pets[0]
	p.InstanceID = "e3"
	s.Pets = append(s.Pets, p)
	r.Sides["enemy"] = s
	r.Events = append(r.Events, BattleEvent{ID: "other-instance", Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e3", SkillID: 10})
	stats := BuildBattleStats([]BattleRecord{r}, nil)
	e := domainEnemy(t, stats, 2)
	if e.Carried != 1 || e.Appeared != 1 || e.Skills[0].Casts != 2 || e.Skills[0].UsedBattles != 1 || e.IVSamples["speed"] != 1 {
		t.Fatal("species not deduplicated", e)
	}
	r = domainClone(t, r)
	r.Sides["enemy"].Pets[2].IV["speed"] = BattleEvidence{Certainty: "direct", Value: domainFloat(0)}
	e = domainEnemy(t, BuildBattleStats([]BattleRecord{r}, nil), 2)
	if e.IVSamples["speed"] != 0 {
		t.Fatal("conflicting same-species profiles guessed", e)
	}
	r = domainFixture("r")
	bad := domainClone(t, r)
	bad.Events[0].SkillID = 999
	stats = BuildBattleStats([]BattleRecord{r, bad}, nil)
	if stats.MatchedBattles != 0 || len(stats.Issues) == 0 {
		t.Fatal("conflicting duplicate counted")
	}
	empty := BuildBattleStats(nil, nil)
	if empty.MatchedBattles != 0 || empty.Enemy == nil || empty.SelfSkills == nil || empty.Teams == nil {
		t.Fatal("empty stats not valid arrays")
	}
}

func TestBattleDomainFilters(t *testing.T) {
	r := domainFixture("r")
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	rules := []BattleTeamRule{{ID: "team", MonsterIDs: []int{2, 3, 2}}}
	tests := []struct {
		f    BattleFilter
		want bool
	}{
		{BattleFilter{}, true}, {BattleFilter{From: "2026-10-28", To: "2026-10-28"}, true}, {BattleFilter{To: "2026-10-27"}, false}, {BattleFilter{From: "bad"}, false},
		{BattleFilter{From: "2026-10-28T03:00:00Z"}, false}, {BattleFilter{Outcome: "win"}, true}, {BattleFilter{Outcome: "loss"}, false}, {BattleFilter{MonsterID: 1}, true}, {BattleFilter{MonsterID: 3}, true}, {BattleFilter{MonsterID: 999}, false},
		{BattleFilter{TeamRuleID: "team"}, true}, {BattleFilter{TeamRuleID: "missing"}, false},
		{BattleFilter{RankSide: "me", RankMetric: "rank", RankMin: domainFloat(5), RankMax: domainFloat(5)}, true},
		{BattleFilter{RankSide: "me", RankMetric: "score", RankMin: domainFloat(100), RankMax: domainFloat(100)}, true},
		{BattleFilter{RankSide: "enemy", RankMetric: "score", RankMin: domainFloat(0)}, false},
		{BattleFilter{RankSide: "me", Tier: "Gold"}, true}, {BattleFilter{RankSide: "me", Tier: "Silver"}, false},
		{BattleFilter{RankSide: "bad", RankMin: domainFloat(0)}, false}, {BattleFilter{RankMetric: "bad", RankMin: domainFloat(0)}, false},
		{BattleFilter{RankMin: domainFloat(math.NaN())}, false}, {BattleFilter{RankMin: domainFloat(101), RankMax: domainFloat(100)}, false},
	}
	for _, tc := range tests {
		if got := MatchBattleRecord(r, tc.f, rules); got != tc.want {
			t.Fatalf("filter %+v got %v want %v", tc.f, got, tc.want)
		}
	}
	r.StartedAt = ""
	if !MatchBattleRecord(r, BattleFilter{}, nil) || MatchBattleRecord(r, BattleFilter{From: "2026-10-28"}, nil) {
		t.Fatal("unknown time handling")
	}
}

func FuzzBattleDomainDecodeDoesNotPanic(f *testing.F) {
	for _, s := range []string{`{"version":1,"id":"seed","sides":{}}`, `[]`, `{"opcode":4886,"content":{"detail":{"battle_id":"42"}}}`, `{"version":1,"records":[]}`} {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > 1<<20 {
			t.Skip()
		}
		records, _, err := DecodeBattleImport(data)
		if err != nil {
			return
		}
		for _, r := range records {
			if err := ValidateBattleRecord(&r); err != nil {
				t.Fatalf("decoder emitted invalid record: %v", err)
			}
		}
	})
}
