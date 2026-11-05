package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// All ordinary fixtures and databases are synthetic and isolated. The real
// fixture test is opt-in and copies the supplied frozen DB before opening it.
func metadataFixture() BattleRecord {
	return BattleRecord{Version: 1, ID: "metadata-synthetic", Mode: "pvp", Outcome: "unknown", Rounds: 2,
		ImportedAt: "2026-10-29T05:26:58.680494Z",
		Quality:    BattleQuality{Roster: map[string]bool{"me": true, "enemy": true}, Lead: map[string]bool{"me": false, "enemy": false}, Actions: false},
		Sides: map[string]BattleSide{
			"me":    {Pets: []BattlePet{{InstanceID: "m", MonsterID: 1, ProtocolBaseID: "101", ProtocolID: "901", Name: "independent source alias", Level: domainInt(60)}}},
			"enemy": {Pets: []BattlePet{{InstanceID: "e", MonsterID: 2, ProtocolBaseID: "102", ProtocolID: "902", Level: domainInt(60)}}},
		},
		Events: []BattleEvent{
			{ID: "me-cast", Round: 1, Seq: 2, ExecIndex: domainInt(1), Kind: "skill", Phase: "executed", Side: "me", Actor: "m", SkillID: 1, SkillClass: "ordinary"},
			{ID: "enemy-cast", Round: 1, Seq: 2, ExecIndex: domainInt(2), Kind: "skill", Phase: "executed", Side: "enemy", Actor: "e", SkillID: 1, SkillClass: "ordinary"},
		}, Issues: []string{"Synthetic metadata validation fixture."},
	}
}
func metadataObservation() BattleSpeedObservation {
	return BattleSpeedObservation{ID: "speed-pair", Round: 1, MeEvent: "me-cast", EnemyEvent: "enemy-cast",
		MeMonsterID: 1, EnemyMonsterID: 2, MeLevel: 60, EnemyLevel: 60, MeSpeed: 260,
		MePriority: domainInt(0), EnemyPriority: domainInt(0), First: "me", Conditions: "synthetic-unmodified-condition",
		PrioritiesVerified: true, SpeedConditionsVerified: true, Evidence: []string{"Synthetic explicit final-priority and unchanged-speed declarations."}}
}
func metadataEnriched(r BattleRecord) BattleRecord {
	r.DurationSeconds = domainInt(613)
	r.StartedAt = "2026-10-29T05:10:22Z"
	r.Outcome = "loss"
	me := r.Sides["me"]
	me.Lead = "m"
	me.Before = BattleRank{Score: domainFloat(1389), Rank: domainInt(15904), Stars: domainInt(142)}
	me.After = BattleRank{Score: domainFloat(1349), Rank: domainInt(17215), Stars: domainInt(141)}
	me.Pets[0].Speed = domainInt(260)
	me.Pets[0].SpeedMin = domainInt(178)
	me.Pets[0].SpeedMax = domainInt(260)
	me.Pets[0].IV = map[string]BattleEvidence{"hp": {Value: domainFloat(54), Certainty: "direct", Evidence: []string{"Synthetic exact talent54."}}}
	me.Pets[0].Nature = map[string]BattleEvidence{"speed": {Value: domainFloat(1), Certainty: "direct", Evidence: []string{"Synthetic reviewed nature."}}}
	enemy := r.Sides["enemy"]
	enemy.Lead = "e"
	enemy.Matching = &BattleRank{Score: domainFloat(1277), Rank: domainInt(20053), Stars: domainInt(135)}
	enemy.Pets[0].SpeedMin = domainInt(144)
	enemy.Pets[0].SpeedMax = domainInt(214)
	r.Sides["me"], r.Sides["enemy"] = me, enemy
	r.Quality.Lead["me"], r.Quality.Lead["enemy"] = true, true
	return r
}
func metadataValidated(t *testing.T, r BattleRecord) BattleRecord {
	t.Helper()
	r = domainClone(t, r)
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	return r
}
func metadataStored(t *testing.T, s *BattleService, id string) string {
	t.Helper()
	var raw string
	if err := s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	return raw
}
func metadataHash(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }

func TestBattleMetadataDurationZeroNilBoundsAndMerge(t *testing.T) {
	for _, n := range []*int{nil, domainInt(0), domainInt(613), domainInt(31536000)} {
		r := metadataFixture()
		r.DurationSeconds = n
		got := metadataValidated(t, r)
		records, _, err := DecodeBattleImport(domainEncode(t, got))
		if err != nil || len(records) != 1 || !reflect.DeepEqual(records[0].DurationSeconds, n) {
			t.Fatalf("duration roundtrip %v %v", n, err)
		}
		for _, pair := range [][2]BattleRecord{{metadataFixture(), got}, {got, metadataFixture()}} {
			merged, err := MergeBattleRecord(pair[0], pair[1])
			if err != nil || !reflect.DeepEqual(merged.DurationSeconds, n) {
				t.Fatalf("duration merge %v %v", n, err)
			}
		}
	}
	for _, n := range []int{-1, 31536001} {
		r := metadataFixture()
		r.DurationSeconds = domainInt(n)
		if ValidateBattleRecord(&r) == nil {
			t.Fatal("invalid duration accepted", n)
		}
	}
	a, b := metadataFixture(), metadataFixture()
	a.DurationSeconds = domainInt(0)
	b.DurationSeconds = domainInt(1)
	if _, err := MergeBattleRecord(a, b); err == nil {
		t.Fatal("known zero duration overwritten")
	}
	if a.DurationSeconds == nil || *a.DurationSeconds != 0 || *b.DurationSeconds != 1 {
		t.Fatal("merge mutated duration inputs")
	}
}

func TestBattleMetadataRankStarsAndUnphasedMatching(t *testing.T) {
	r := metadataFixture()
	s := r.Sides["enemy"]
	s.Matching = &BattleRank{Score: domainFloat(1277), Rank: domainInt(20053), Stars: domainInt(0), Tier: "SyntheticTier"}
	r.Sides["enemy"] = s
	got := metadataValidated(t, r)
	merged, err := MergeBattleRecord(metadataFixture(), got)
	if err != nil {
		t.Fatal(err)
	}
	enemy := merged.Sides["enemy"]
	if enemy.Matching == nil || enemy.Matching.Stars == nil || *enemy.Matching.Stars != 0 || !reflect.DeepEqual(enemy.Before, BattleRank{}) || !reflect.DeepEqual(enemy.After, BattleRank{}) {
		t.Fatal("matching copied to phase or zero lost", enemy)
	}
	for _, f := range []BattleFilter{{RankSide: "enemy", RankMetric: "score", RankMin: domainFloat(1)}, {RankSide: "enemy", RankMetric: "rank", RankMin: domainFloat(1)}, {RankSide: "enemy", Tier: "SyntheticTier"}} {
		if MatchBattleRecord(merged, f, nil) {
			t.Fatal("unphased rank entered pre-match filter", f)
		}
	}
	for _, phase := range []string{"before", "after", "matching"} {
		for _, n := range []int{-1, 1000000001} {
			bad := metadataFixture()
			side := bad.Sides["me"]
			rank := BattleRank{Stars: domainInt(n)}
			switch phase {
			case "before":
				side.Before = rank
			case "after":
				side.After = rank
			case "matching":
				side.Matching = &rank
			}
			bad.Sides["me"] = side
			if ValidateBattleRecord(&bad) == nil {
				t.Fatal("invalid stars accepted", phase, n)
			}
		}
	}
	conflict := domainClone(t, got)
	*conflict.Sides["enemy"].Matching.Stars = 1
	if _, err := MergeBattleRecord(got, conflict); err == nil {
		t.Fatal("known matching stars overwritten")
	}
}

func TestBattleMetadataPetSpeedBoundsAndHiddenZero(t *testing.T) {
	tests := []struct {
		name          string
		speed, lo, hi *int
		valid         bool
	}{
		{"unknown", nil, nil, nil, true}, {"ownactual", domainInt(260), domainInt(178), domainInt(260), true},
		{"enemybounds", nil, domainInt(144), domainInt(214), true}, {"knownzero", domainInt(0), nil, nil, false},
		{"zeromin", nil, domainInt(0), nil, false}, {"zeromax", nil, nil, domainInt(0), false},
		{"negative", domainInt(-1), nil, nil, false}, {"tooLarge", domainInt(1000001), nil, nil, false},
		{"reversed", nil, domainInt(260), domainInt(178), false}, {"below", domainInt(177), domainInt(178), domainInt(260), false},
		{"above", domainInt(261), domainInt(178), domainInt(260), false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := metadataFixture()
			p := &r.Sides["enemy"].Pets[0]
			p.Speed, p.SpeedMin, p.SpeedMax = tc.speed, tc.lo, tc.hi
			if err := ValidateBattleRecord(&r); (err == nil) != tc.valid {
				t.Fatalf("validation valid=%v err=%v", tc.valid, err)
			}
		})
	}
}

func TestBattleMetadataAdditiveProfilesPreserveIdentityAndEvents(t *testing.T) {
	original := metadataValidated(t, metadataFixture())
	incoming := metadataEnriched(domainClone(t, original))
	a, b := domainEncode(t, original), domainEncode(t, incoming)
	got, err := MergeBattleRecord(original, incoming)
	if err != nil {
		t.Fatal(err)
	}
	if string(domainEncode(t, original)) != string(a) || string(domainEncode(t, incoming)) != string(b) {
		t.Fatal("caller records mutated")
	}
	if !reflect.DeepEqual(got.Events, original.Events) || got.ImportedAt != original.ImportedAt || got.Quality.Actions || got.EndedAt != "" {
		t.Fatal("metadata rewrote core history/quality")
	}
	p := got.Sides["me"].Pets[0]
	if p.InstanceID != "m" || p.MonsterID != 1 || p.ProtocolBaseID != "101" || p.ProtocolID != "901" || *p.IV["hp"].Value != 54 || p.IV["hp"].Certainty != "direct" || *p.Nature["speed"].Value != 1 {
		t.Fatal("identity/exact evidence lost", p)
	}
	if got.Sides["enemy"].Pets[0].Speed != nil {
		t.Fatal("hidden enemy speed fabricated")
	}
	again, err := MergeBattleRecord(got, incoming)
	if err != nil || !reflect.DeepEqual(got, again) {
		t.Fatal("nonidempotent metadata merge", err)
	}
	*got.DurationSeconds = 0
	*got.Sides["me"].Pets[0].IV["hp"].Value = 0
	if *incoming.DurationSeconds != 613 || *incoming.Sides["me"].Pets[0].IV["hp"].Value != 54 {
		t.Fatal("merged metadata aliases input pointers")
	}
}

func TestBattleMetadataMergeConflictsDoNotMutateInputs(t *testing.T) {
	mutate := map[string]func(*BattleRecord){
		"duration": func(r *BattleRecord) { r.DurationSeconds = domainInt(614) },
		"stars":    func(r *BattleRecord) { s := r.Sides["me"]; s.Before.Stars = domainInt(143); r.Sides["me"] = s },
		"matching": func(r *BattleRecord) { r.Sides["enemy"].Matching.Score = domainFloat(1000) },
		"speed":    func(r *BattleRecord) { r.Sides["me"].Pets[0].Speed = domainInt(259) },
		"iv": func(r *BattleRecord) {
			p := &r.Sides["me"].Pets[0]
			p.IV["hp"] = BattleEvidence{Value: domainFloat(55), Certainty: "direct"}
		},
		"nature": func(r *BattleRecord) {
			p := &r.Sides["me"].Pets[0]
			p.Nature["speed"] = BattleEvidence{Value: domainFloat(2), Certainty: "direct"}
		},
		"identity": func(r *BattleRecord) { r.Sides["me"].Pets[0].MonsterID = 2 },
	}
	for name, change := range mutate {
		t.Run(name, func(t *testing.T) {
			a := metadataValidated(t, metadataEnriched(metadataFixture()))
			b := domainClone(t, a)
			change(&b)
			oldA, oldB := domainEncode(t, a), domainEncode(t, b)
			if _, err := MergeBattleRecord(a, b); err == nil {
				t.Fatal("known metadata conflict accepted")
			}
			if string(oldA) != string(domainEncode(t, a)) || string(oldB) != string(domainEncode(t, b)) {
				t.Fatal("conflict mutated caller")
			}
		})
	}
}

func TestBattleMetadataObservationZeroPriorityAndDedup(t *testing.T) {
	r := metadataFixture()
	o := metadataObservation()
	r.SpeedObservations = []BattleSpeedObservation{o, o}
	got := metadataValidated(t, r)
	if len(got.SpeedObservations) != 1 || got.SpeedObservations[0].MePriority == nil || *got.SpeedObservations[0].MePriority != 0 {
		t.Fatal("zero priority or ID dedup lost")
	}
	decoded, _, err := DecodeBattleImport(domainEncode(t, got))
	if err != nil || len(decoded) != 1 || *decoded[0].SpeedObservations[0].EnemyPriority != 0 {
		t.Fatal("priority zero did not survive decode", err)
	}
	merged, err := MergeBattleRecord(metadataFixture(), got)
	if err != nil || len(merged.SpeedObservations) != 1 {
		t.Fatal("additive observation lost", err)
	}
	again, err := MergeBattleRecord(merged, got)
	if err != nil || !reflect.DeepEqual(again, merged) {
		t.Fatal("observation merge not idempotent", err)
	}
	bad := domainClone(t, got)
	b := bad.SpeedObservations[0]
	b.ID = "different-id"
	bad.SpeedObservations = append(bad.SpeedObservations, b)
	if ValidateBattleRecord(&bad) == nil {
		t.Fatal("duplicate pair with distinct ID accepted")
	}
	bad = domainClone(t, got)
	b = bad.SpeedObservations[0]
	b.Conditions = "different-condition"
	bad.SpeedObservations = append(bad.SpeedObservations, b)
	if ValidateBattleRecord(&bad) == nil {
		t.Fatal("conflicting observation ID accepted")
	}
}

func TestBattleMetadataObservationRejectsUnprovenOrWrongActions(t *testing.T) {
	mutations := map[string]func(*BattleRecord){
		"missing-priority":   func(r *BattleRecord) { r.SpeedObservations[0].MePriority = nil },
		"different-priority": func(r *BattleRecord) { r.SpeedObservations[0].EnemyPriority = domainInt(1) },
		"priority-bound": func(r *BattleRecord) {
			r.SpeedObservations[0].MePriority = domainInt(1000001)
			r.SpeedObservations[0].EnemyPriority = domainInt(1000001)
		},
		"unverified-priority": func(r *BattleRecord) { r.SpeedObservations[0].PrioritiesVerified = false },
		"unverified-speed":    func(r *BattleRecord) { r.SpeedObservations[0].SpeedConditionsVerified = false },
		"missing-condition":   func(r *BattleRecord) { r.SpeedObservations[0].Conditions = "" },
		"blank-condition":     func(r *BattleRecord) { r.SpeedObservations[0].Conditions = " \t\n " },
		"long-condition":      func(r *BattleRecord) { r.SpeedObservations[0].Conditions = strings.Repeat("x", 129) },
		"blank-evidence":      func(r *BattleRecord) { r.SpeedObservations[0].Evidence = []string{" \t\n "} },
		"long-evidence":       func(r *BattleRecord) { r.SpeedObservations[0].Evidence = []string{strings.Repeat("x", 513)} },
		"missing-evidence":    func(r *BattleRecord) { r.SpeedObservations[0].Evidence = nil },
		"empty-evidence":      func(r *BattleRecord) { r.SpeedObservations[0].Evidence = []string{""} },
		"excess-evidence":     func(r *BattleRecord) { r.SpeedObservations[0].Evidence = make([]string, 17) },
		"zero-speed":          func(r *BattleRecord) { r.SpeedObservations[0].MeSpeed = 0 },
		"speed-bound":         func(r *BattleRecord) { r.SpeedObservations[0].MeSpeed = 1000001 },
		"level-zero":          func(r *BattleRecord) { r.SpeedObservations[0].MeLevel = 0 },
		"level-bound":         func(r *BattleRecord) { r.SpeedObservations[0].EnemyLevel = 100 },
		"round-zero":          func(r *BattleRecord) { r.SpeedObservations[0].Round = 0 },
		"round-wrong":         func(r *BattleRecord) { r.SpeedObservations[0].Round = 2 },
		"round-outside":       func(r *BattleRecord) { r.SpeedObservations[0].Round = 3 },
		"missing-event":       func(r *BattleRecord) { r.SpeedObservations[0].EnemyEvent = "missing" },
		"same-event":          func(r *BattleRecord) { r.SpeedObservations[0].EnemyEvent = "me-cast" },
		"swapped-sides": func(r *BattleRecord) {
			r.SpeedObservations[0].MeEvent = "enemy-cast"
			r.SpeedObservations[0].EnemyEvent = "me-cast"
		},
		"wrong-species":   func(r *BattleRecord) { r.SpeedObservations[0].MeMonsterID = 2 },
		"wrong-first":     func(r *BattleRecord) { r.SpeedObservations[0].First = "enemy" },
		"unknown-first":   func(r *BattleRecord) { r.SpeedObservations[0].First = "unknown" },
		"no-exec-index":   func(r *BattleRecord) { r.Events[0].ExecIndex = nil },
		"same-coordinate": func(r *BattleRecord) { r.Events[1].ExecIndex = domainInt(1) },
		"response":        func(r *BattleRecord) { r.Events[0].SkillClass = "response" },
		"passive":         func(r *BattleRecord) { r.Events[0].SkillClass = "passive" },
		"interrupted":     func(r *BattleRecord) { r.Events[0].Phase = "interrupted" },
		"preview":         func(r *BattleRecord) { r.Events[0].Phase = "preview" },
		"switch":          func(r *BattleRecord) { r.Events[0].Kind = "switch"; r.Events[0].SkillClass = "" },
	}
	for name, change := range mutations {
		t.Run(name, func(t *testing.T) {
			r := metadataFixture()
			r.SpeedObservations = []BattleSpeedObservation{metadataObservation()}
			change(&r)
			if ValidateBattleRecord(&r) == nil {
				t.Fatal("invalid speed observation accepted")
			}
		})
	}
}

func TestBattleMetadataObservationUsesActionTimeForm(t *testing.T) {
	for _, topIndex := range []bool{true, false} {
		t.Run(fmt.Sprintf("top-index-%v", topIndex), func(t *testing.T) {
			r := metadataFixture()
			r.Events[0].ExecIndex = domainInt(2)
			r.Events[1].ExecIndex = domainInt(3)
			form := BattleEvent{ID: "form", Round: 1, Seq: 2, Kind: "form", Phase: "executed", Side: "me", Actor: "m", Form: &BattleFormChange{FromBaseID: "101", ToBaseID: "103", FromMonsterID: 1, ToMonsterID: 3, ExecIndex: 1}}
			if topIndex {
				form.ExecIndex = domainInt(1)
			}
			r.Events = append(r.Events, form)
			o := metadataObservation()
			o.MeMonsterID = 3
			r.SpeedObservations = []BattleSpeedObservation{o}
			if err := ValidateBattleRecord(&r); err != nil {
				t.Fatalf("explicit prior form not resolved: %v", err)
			}
			r.SpeedObservations[0].MeMonsterID = 1
			if ValidateBattleRecord(&r) == nil {
				t.Fatal("initial species used after form transition")
			}
		})
	}
}

func TestBattleMetadataObservationMergeConflictsAtomic(t *testing.T) {
	a := metadataFixture()
	a.SpeedObservations = []BattleSpeedObservation{metadataObservation()}
	a = metadataValidated(t, a)
	b := domainClone(t, a)
	b.DurationSeconds = domainInt(613)
	b.SpeedObservations[0].Conditions = "another-explicit-condition"
	oldA, oldB := domainEncode(t, a), domainEncode(t, b)
	if _, err := MergeBattleRecord(a, b); err == nil {
		t.Fatal("conflicting observation ID accepted")
	}
	if string(oldA) != string(domainEncode(t, a)) || string(oldB) != string(domainEncode(t, b)) {
		t.Fatal("observation conflict partially mutated caller")
	}
	b = domainClone(t, a)
	b.SpeedObservations[0].ID = "other-id"
	if _, err := MergeBattleRecord(a, b); err == nil {
		t.Fatal("duplicate action pair accepted across merge")
	}
}

func TestBattleMetadataWhitelistStripsUnknownFields(t *testing.T) {
	r := metadataEnriched(metadataFixture())
	r.SpeedObservations = []BattleSpeedObservation{metadataObservation()}
	var object map[string]any
	if err := json.Unmarshal(domainEncode(t, r), &object); err != nil {
		t.Fatal(err)
	}
	object["raw_packet"] = "PRIVATE_SENTINEL"
	object["durationGuess"] = 613
	side := object["sides"].(map[string]any)["enemy"].(map[string]any)
	side["role_uin"] = "PRIVATE_SENTINEL"
	side["matching"].(map[string]any)["raw_rank"] = 999
	side["pets"].([]any)[0].(map[string]any)["account"] = "PRIVATE_SENTINEL"
	object["speedObservations"].([]any)[0].(map[string]any)["staticPriority"] = 5
	records, _, err := DecodeBattleImport(domainEncode(t, object))
	if err != nil || len(records) != 1 {
		t.Fatal(err)
	}
	encoded := string(domainEncode(t, records[0]))
	for _, word := range []string{"PRIVATE_SENTINEL", "raw_packet", "role_uin", "raw_rank", "staticPriority", "durationGuess"} {
		if strings.Contains(encoded, word) {
			t.Fatal("unknown private field persisted", word)
		}
	}
	if records[0].DurationSeconds == nil || *records[0].DurationSeconds != 613 || *records[0].SpeedObservations[0].MePriority != 0 {
		t.Fatal("known metadata discarded by whitelist")
	}
}

func TestBattleMetadataServiceGuardIdempotenceAndBatchRollback(t *testing.T) {
	c, meta := identityCatalog(t)
	catalogBytes := identityBytes(t, c, meta)
	calls := 0
	s, err := NewBattleService(filepath.Join(t.TempDir(), "metadata.sqlite"), func() ([]byte, error) { calls++; return catalogBytes, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if calls != 0 {
		t.Fatal("eager catalogue access")
	}
	original := metadataFixture()
	backendImport(t, s, original)
	old := metadataStored(t, s, original.ID)
	incoming := metadataEnriched(domainClone(t, original))
	result, err := s.Import(context.Background(), []BattleRecord{incoming}, map[string]string{original.ID: metadataHash([]byte(old))})
	if err != nil || result.Imported != 1 {
		t.Fatalf("guarded metadata merge %+v %v", result, err)
	}
	saved, err := s.Record(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Sides["me"].Pets[0].MonsterID != 1 || saved.Sides["me"].Pets[0].Name != "independent source alias" || saved.ImportedAt != original.ImportedAt || !reflect.DeepEqual(saved.Events, metadataValidated(t, original).Events) {
		t.Fatal("catalogue mapping borrowed source name or changed history")
	}
	stored := metadataStored(t, s, original.ID)
	if _, err := s.Import(context.Background(), []BattleRecord{incoming}, map[string]string{original.ID: metadataHash([]byte(old))}); !errors.Is(err, errBattleInvalid) {
		t.Fatal("stale guard accepted", err)
	}
	catalogBytes = append(append([]byte{}, catalogBytes...), '\n')
	result, err = s.Import(context.Background(), []BattleRecord{incoming}, map[string]string{original.ID: metadataHash([]byte(stored))})
	if err != nil || result.Imported != 0 || result.Duplicates != 1 || metadataStored(t, s, original.ID) != stored {
		t.Fatal("metadata replay changed bytes/mapping provenance", result, err)
	}
	fresh := metadataFixture()
	fresh.ID = "must-rollback"
	bad := domainClone(t, incoming)
	bad.DurationSeconds = domainInt(614)
	if result, err = s.Import(context.Background(), []BattleRecord{fresh, bad}); !errors.Is(err, errBattleInvalid) || result.Imported != 0 {
		t.Fatal("conflict batch committed", result, err)
	}
	if _, err = s.Record(context.Background(), fresh.ID); !errors.Is(err, errBattleNotFound) {
		t.Fatal("new record escaped rollback", err)
	}
	if metadataStored(t, s, original.ID) != stored {
		t.Fatal("conflict mutated existing stored JSON")
	}
	if calls < 4 {
		t.Fatal("current catalogue reader not consulted")
	}
}

func TestBattleMetadataActualFixture(t *testing.T) {
	if os.Getenv("XHM_METADATA_INPUT") == "" {
		t.Skip("explicit frozen metadata fixture required")
	}
	paths := map[string]string{}
	initialHashes := map[string]string{}
	read := func(key string) []byte {
		p := os.Getenv(key)
		if !filepath.IsAbs(p) {
			t.Fatal("absolute frozen input required", key)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		paths[key] = p
		initialHashes[key] = metadataHash(b)
		return b
	}
	before := read("XHM_METADATA_BEFORE")
	var original BattleRecord
	if err := json.Unmarshal(before, &original); err != nil {
		t.Fatal(err)
	}
	records, _, err := DecodeBattleImport(read("XHM_METADATA_INPUT"))
	if err != nil || len(records) != 1 || records[0].ID != original.ID {
		t.Fatal("wrong candidate", err)
	}
	frozenDB := read("XHM_METADATA_DB")
	catalogBytes := read("XHM_METADATA_CATALOG")
	db := filepath.Join(t.TempDir(), "frozen-metadata-copy.sqlite")
	if err = os.WriteFile(db, frozenDB, 0600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	s, err := NewBattleService(db, func() ([]byte, error) { calls++; return catalogBytes, nil })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	result, err := s.Import(context.Background(), records, map[string]string{original.ID: metadataHash(before)})
	if err != nil || result.Imported != 1 {
		t.Fatalf("guarded actual metadata merge %+v %v", result, err)
	}
	got, err := s.Record(context.Background(), original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Events) != 283 || !reflect.DeepEqual(got.Events, original.Events) || got.ImportedAt != original.ImportedAt || got.EndedAt != original.EndedAt || got.Quality.Actions != original.Quality.Actions {
		t.Fatal("283 original event/timestamp/action-quality invariant failed")
	}
	if got.Outcome != "loss" || got.StartedAt != "2026-10-29T05:10:22Z" || got.DurationSeconds == nil || *got.DurationSeconds != 613 || got.Rounds != 36 {
		t.Fatal("wrong direct settlement metadata")
	}
	me, enemy := got.Sides["me"], got.Sides["enemy"]
	if me.Lead != "3" || enemy.Lead != "401" || !got.Quality.Lead["me"] || !got.Quality.Lead["enemy"] {
		t.Fatal("explicit leads not retained")
	}
	if me.Before.Score == nil || *me.Before.Score != 1389 || me.Before.Rank == nil || *me.Before.Rank != 15904 || me.Before.Stars == nil || *me.Before.Stars != 142 || me.After.Score == nil || *me.After.Score != 1349 || me.After.Rank == nil || *me.After.Rank != 17215 || me.After.Stars == nil || *me.After.Stars != 141 {
		t.Fatal("old/new rank timing lost")
	}
	if !reflect.DeepEqual(enemy.Before, BattleRank{}) || !reflect.DeepEqual(enemy.After, BattleRank{}) || enemy.Matching == nil || *enemy.Matching.Score != 1277 || *enemy.Matching.Rank != 20053 || *enemy.Matching.Stars != 135 {
		t.Fatal("unphased enemy matching rank misrepresented")
	}
	if me.Before.Tier != "" || me.After.Tier != "" || enemy.Matching.Tier != "" || len(got.SpeedObservations) != 0 {
		t.Fatal("unsupported tier/speed observations fabricated")
	}
	for _, side := range []string{"me", "enemy"} {
		for i, p := range got.Sides[side].Pets {
			old := original.Sides[side].Pets[i]
			if p.InstanceID != old.InstanceID || p.MonsterID != old.MonsterID || p.ProtocolID != old.ProtocolID || p.ProtocolBaseID != old.ProtocolBaseID || p.MappingRevision != old.MappingRevision || p.Name != old.Name || !reflect.DeepEqual(p.Level, old.Level) {
				t.Fatal("stable identity changed", side, i)
			}
			if p.SpeedMin == nil || p.SpeedMax == nil {
				t.Fatal("explicit range missing", side, i)
			}
			if side == "enemy" {
				if p.Speed != nil || len(p.IV) != 0 || len(p.Nature) != 0 {
					t.Fatal("enemy placeholders became direct facts")
				}
				continue
			}
			if len(p.IV) != 6 || len(p.Nature) != 6 || p.Speed == nil {
				t.Fatal("own six-stat facts incomplete")
			}
			for _, e := range p.IV {
				if e.Certainty != "direct" || e.Value == nil {
					t.Fatal("own IV not direct")
				}
			}
			for _, e := range p.Nature {
				if e.Certainty != "direct" || e.Value == nil {
					t.Fatal("own nature not direct")
				}
			}
		}
	}
	if *me.Pets[0].Speed != 260 || *me.Pets[0].IV["speed"].Value != 60 || *me.Pets[0].Nature["speed"].Value != 1 || *me.Pets[3].IV["hp"].Value != 54 {
		t.Fatal("exact green speed/54talent regression")
	}
	stored := metadataStored(t, s, original.ID)
	result, err = s.Import(context.Background(), records, map[string]string{original.ID: metadataHash([]byte(stored))})
	if err != nil || result.Imported != 0 || result.Duplicates != 1 || metadataStored(t, s, original.ID) != stored {
		t.Fatal("real candidate replay is not byte-idempotent", result, err)
	}
	bad := domainClone(t, records[0])
	bad.DurationSeconds = domainInt(614)
	if _, err = s.Import(context.Background(), []BattleRecord{bad}); !errors.Is(err, errBattleInvalid) {
		t.Fatal("real metadata conflict accepted", err)
	}
	if metadataStored(t, s, original.ID) != stored {
		t.Fatal("real conflict changed temporary DB")
	}
	if calls < 3 {
		t.Fatal("real current catalogue callbacks not exercised")
	}
	for key, path := range paths {
		b, err := os.ReadFile(path)
		if err != nil || metadataHash(b) != initialHashes[key] {
			t.Fatal("frozen source changed", key, err)
		}
	}
	if output := os.Getenv("XHM_METADATA_OUTPUT"); output != "" {
		if !filepath.IsAbs(output) || strings.ToLower(filepath.Ext(output)) != ".json" {
			t.Fatal("absolute new JSON output required")
		}
		for _, p := range paths {
			if strings.EqualFold(filepath.Clean(p), filepath.Clean(output)) {
				t.Fatal("output must not overwrite input")
			}
		}
		f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.MarshalIndent(got, "", "  ")
		if err == nil {
			_, err = f.Write(append(data, '\n'))
		}
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			t.Fatal(err, closeErr)
		}
	}
}
