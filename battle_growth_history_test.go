package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"testing"
)

func historyRecord(monster int) BattleRecord {
	r := growthRecord("history", monster)
	s := r.Sides["me"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "c", MonsterID: 182})
	s.Lead = "c"
	r.Sides["me"] = s
	s = r.Sides["enemy"]
	s.Pets = append(s.Pets, BattlePet{InstanceID: "d", MonsterID: 1})
	r.Sides["enemy"] = s
	return r
}
func historyEntry(seq int) BattleEvent {
	return BattleEvent{ID: "entry" + strconv.Itoa(seq), Round: 1, Seq: seq, Kind: "switch", Phase: "executed", Side: "me", Actor: "a", Target: "c", TargetSide: "me", ExecIndex: growthInt(0)}
}
func historySnapshot(t *testing.T, h *BattleGrowthHistory, id string) BattleGrowthEntrySnapshot {
	t.Helper()
	for _, s := range h.Entries {
		if s.EventID == id {
			return s
		}
	}
	t.Fatalf("missing entry %s: %+v", id, h.Entries)
	return BattleGrowthEntrySnapshot{}
}
func assertHistoryCount(t *testing.T, s BattleGrowthEntrySnapshot, count int, mode string) {
	t.Helper()
	if !s.Known || s.Count == nil || *s.Count != count || s.Coverage.Mode != mode {
		t.Fatalf("wrong snapshot %+v; want %d/%s", s, count, mode)
	}
}
func TestBattleHistoryAll22ExactDefinitionsAndSupportedConditions(t *testing.T) {
	data, c := growthCatalog(t)
	h := BuildBattleGrowthHistory(historyRecord(202), data)
	if len(h.Audit) != 22 {
		t.Fatal("selection changed")
	}
	selected, historical := 0, 0
	for _, a := range h.Audit {
		for _, trait := range c.Traits {
			if trait.ID == a.TraitID && (trait.Name != a.Name || trait.Description != a.Description) {
				t.Fatalf("unpinned canonical trait %s", a.Name)
			}
		}
		if a.Supported {
			selected++
		}
		if battleGrowthHistorical(a.Derive) {
			historical++
		}
		if a.Note == "" {
			t.Fatal("missing unsupported reason")
		}
	}
	if selected != 16 || historical != 13 {
		t.Fatalf("support audit changed: %d/%d", selected, historical)
	}
	for _, tc := range []struct {
		monster, skill int
		side           string
		want           int
	}{
		{202, 155, "me", 1}, {203, 155, "me", 1}, {311, 187, "me", 1}, {337, 321, "me", 1},
		{341, 113, "me", 1}, {349, 343, "me", 1}, {545, 113, "me", 1}, {620, 113, "me", 1}, {596, 155, "me", 1}, {623, 244, "me", 1},
	} {
		t.Run(strconv.Itoa(tc.monster), func(t *testing.T) {
			r := historyRecord(tc.monster)
			e := growthCast("use", tc.side, "c", tc.skill, 1)
			e.EnergyCost = growthInt(3) // actual executed cost, not catalog/default cost
			r.Events = []BattleEvent{e, historyEntry(2)}
			growthValid(t, r)
			testData := data
			if tc.monster == 623 {
				// Preserve the old exact-definition rule in a test-local historical
				// binding, never enrolling the revised current trait by name.
				old := *c
				old.Monsters = append(old.Monsters[:0:0], c.Monsters...)
				for i := range old.Monsters {
					if old.Monsters[i].ID == 623 {
						old.Monsters[i].TraitID = "trait-2d62e65c758af0457fe3fcdc3054ae81"
					}
				}
				var err error
				testData, err = json.Marshal(old)
				if err != nil {
					t.Fatal(err)
				}
			}
			assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, testData), "entry2"), tc.want, "observedPrefix")
		})
	}
	for _, monster := range []int{477, 480} {
		r := historyRecord(monster)
		r.Events = []BattleEvent{{ID: "charge", Round: 1, Seq: 1, Kind: "effect", Phase: "executed", Side: "enemy", Actor: "b", SkillClass: "system", ProtocolSkillID: "700001000"}, {ID: "switch-enemy", Round: 1, Seq: 2, Kind: "switch", Phase: "executed", Side: "enemy", Actor: "d", Target: "b"}, historyEntry(3)}
		growthValid(t, r)
		assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry3"), 2, "observedPrefix")
		r.Quality.Actions = true
		r.Events = []BattleEvent{growthCast("unknown-enemy", "enemy", "b", 0, 1), historyEntry(3)}
		if s := historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry3"); s.Known || s.Coverage.UnknownActions != 1 {
			t.Fatalf("unknown enemy cast became zero %+v", s)
		}
	}
	r := historyRecord(290)
	attempt := growthCast("countered", "enemy", "b", 321, 1)
	attempt.Phase = "interrupted"
	response := growthCast("response", "me", "c", 164, 2)
	response.SkillClass = "response"
	response.Combat = &BattleCombatEvidence{CounteredActionID: attempt.ID}
	r.Events = []BattleEvent{attempt, response, historyEntry(3)}
	growthValid(t, r)
	assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry3"), 1, "observedPrefix")
	response.Combat = nil
	r.Events = []BattleEvent{attempt, response, historyEntry(3)}
	if s := historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry3"); s.Known || s.Coverage.UnknownActions != 1 {
		t.Fatalf("response without linkage guessed %+v", s)
	}
}
func TestBattleHistoryRevisedAndOrdinaryAbuStayUnselected(t *testing.T) {
	data, c := growthCatalog(t)
	before, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, monster := range []int{623, 648} {
		for _, m := range c.Monsters {
			if m.ID == monster {
				if m.TraitID == "trait-2d62e65c758af0457fe3fcdc3054ae81" {
					t.Fatal("new Abu still selects old trait")
				}
				if _, ok := battleGrowthTraitRuleFor(m.TraitID); ok {
					t.Fatal("unreviewed new definition enrolled in history registry")
				}
			}
		}
		r := historyRecord(monster)
		e := growthCast("cost3", "me", "c", 245, 1)
		e.EnergyCost = growthInt(3)
		r.Events = []BattleEvent{e, historyEntry(2)}
		for _, complete := range []bool{false, true} {
			r.Quality.Actions = complete
			growthValid(t, r)
			raw, _ := json.Marshal(r)
			if h := BuildBattleGrowthHistory(r, data); len(h.Entries) != 0 {
				t.Fatalf("unselected %d inherited old entry-cost3 history: %+v", monster, h.Entries)
			}
			row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", monster)
			if row.Trait != nil {
				t.Fatalf("unselected %d reported a fake trait sample/zero: %+v", monster, row.Trait)
			}
			after, _ := json.Marshal(r)
			if !bytes.Equal(raw, after) {
				t.Fatal("unselected history changed raw record")
			}
		}
	}
	after, _ := json.Marshal(c)
	if !bytes.Equal(before, after) {
		t.Fatal("historical binding mutated current catalog")
	}
}

func TestBattleHistoryStrictPrefixDuplicatesFormsAndNoFutureBackfill(t *testing.T) {
	data, _ := growthCatalog(t)
	r := historyRecord(200)
	before := growthCast("water", "me", "c", 155, 1)
	entry := historyEntry(2)
	form := BattleEvent{ID: "form", Round: 1, Seq: 2, Kind: "form", Phase: "executed", Side: "me", Actor: "a", ExecIndex: growthInt(1), Form: &BattleFormChange{FromBaseID: "200", ToBaseID: "202", FromMonsterID: 200, ToMonsterID: 202, ExecIndex: 1}}
	future := growthCast("late-water", "me", "c", 161, 3)
	r.Events = []BattleEvent{future, form, entry, before, before, {ID: "hit", Round: 1, Seq: 1, Kind: "damage", Phase: "executed", Side: "me", Actor: "c", Target: "b", TargetSide: "enemy", HPChange: growthInt(-1)}}
	growthValid(t, r)
	beforeBytes, _ := json.Marshal(r)
	h := BuildBattleGrowthHistory(r, data)
	s := historySnapshot(t, h, entry.ID)
	assertHistoryCount(t, s, 1, "observedPrefix")
	if s.MonsterID != 200 || !reflect.DeepEqual(s.EvidenceEventIDs, []string{"water"}) || len(h.Entries) != 1 {
		t.Fatalf("form/future/hit/dedup failed %+v", h)
	}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 200)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 1, 1, 0)
	if row.Trait.ObservedPrefixSamples != 1 {
		t.Fatal("lower bound hidden as complete")
	}
	afterBytes, _ := json.Marshal(r)
	if !bytes.Equal(beforeBytes, afterBytes) {
		t.Fatal("projection changed record")
	}
	// Same stable native trait across explicitly ordered forms is recognized;
	// a different unlinked identity never inherits it by name/family.
	form.Seq = 1
	form.ExecIndex = growthInt(2)
	form.Form.ExecIndex = 2
	before.ExecIndex = growthInt(1)
	r.Events = []BattleEvent{before, form, entry}
	assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, data), entry.ID), 1, "observedPrefix")
	r.Sides["me"].Pets[0].MonsterID = 595
	if len(BuildBattleGrowthHistory(r, data).Entries) != 0 {
		t.Fatal("unrelated acquired trait guessed")
	}
}
func TestBattleHistoryUnknownZeroActualTypeAndNonexecutedExclusions(t *testing.T) {
	data, _ := growthCatalog(t)
	r := historyRecord(202)
	r.Events = []BattleEvent{historyEntry(10)}
	if s := historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry10"); s.Known || s.Count != nil {
		t.Fatal("absence became zero")
	}
	r.Quality.Actions = true
	assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry10"), 0, "completePrefix")
	r.Quality.Actions = false
	r.Events = []BattleEvent{growthCast("water", "me", "c", 155, 1), growthCast("unknown", "me", "c", 0, 2), historyEntry(10)}
	for i, phase := range []string{"preview", "interrupted", "unknown"} {
		e := growthCast("not-used"+phase, "me", "c", 155, i+3)
		e.Phase = phase
		r.Events = append(r.Events, e)
	}
	r.Events = append(r.Events, BattleEvent{ID: "stun", Round: 1, Seq: 6, Kind: "skill", Phase: "executed", Side: "me", Actor: "c", ProtocolSkillID: "700001200"}, BattleEvent{ID: "charge", Round: 1, Seq: 7, Kind: "effect", Phase: "executed", Side: "me", Actor: "c", SkillClass: "system", ProtocolSkillID: "700001000"})
	// Explicit wish type is actual; unknown wish type is not the actor's water type.
	r.Events = append(r.Events, BattleEvent{ID: "wish", Round: 1, Seq: 8, Kind: "effect", Phase: "executed", Side: "me", Actor: "c", SkillClass: "system", Combat: &BattleCombatEvidence{ActionKind: "wishImpact", TypeID: growthInt(4)}}, BattleEvent{ID: "wish-unknown", Round: 1, Seq: 9, Kind: "effect", Phase: "executed", Side: "me", Actor: "c", SkillClass: "system", Combat: &BattleCombatEvidence{ActionKind: "wishImpact"}})
	s := historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry10")
	assertHistoryCount(t, s, 2, "observedPrefix")
	if s.Coverage.UnknownActions != 3 {
		t.Fatalf("unknown casts/types not qualified %+v", s)
	}
	// Same-frame action with absent order is excluded, not moved before entry.
	r.Events[0].Seq = 10
	s = historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry10")
	assertHistoryCount(t, s, 1, "observedPrefix")
	if s.Coverage.AmbiguousOrder != 1 {
		t.Fatalf("missing-index action counted %+v", s)
	}
}
func TestBattleHistoryDistinctCapRepeatedEntriesAndDescriptionGuard(t *testing.T) {
	data, c := growthCatalog(t)
	r := historyRecord(596)
	r.Events = []BattleEvent{growthCast("water1", "me", "c", 155, 1), growthCast("water2", "me", "c", 161, 2), growthCast("fire", "me", "c", 113, 3), historyEntry(4)}
	assertHistoryCount(t, historySnapshot(t, BuildBattleGrowthHistory(r, data), "entry4"), 2, "observedPrefix")
	r = historyRecord(545)
	for i := 1; i <= 12; i++ {
		r.Events = append(r.Events, growthCast("fire"+strconv.Itoa(i), "me", "c", 113, i))
	}
	r.Events = append(r.Events, historyEntry(13), BattleEvent{ID: "out", Round: 1, Seq: 14, Kind: "switch", Phase: "executed", Side: "me", Actor: "c", Target: "a"}, historyEntry(15))
	h := BuildBattleGrowthHistory(r, data)
	assertHistoryCount(t, historySnapshot(t, h, "entry13"), 10, "observedPrefix")
	assertHistoryCount(t, historySnapshot(t, h, "entry15"), 10, "observedPrefix")
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{r}, data), "me", 545)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 10, 1, 0)
	for i := range c.Traits {
		if c.Traits[i].ID == row.Trait.TraitID {
			c.Traits[i].Description += " changed"
		}
	}
	changed, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if s := historySnapshot(t, BuildBattleGrowthHistory(r, changed), "entry13"); s.Known {
		t.Fatal("changed exact definition still derived")
	}
}

func TestBattleHistoryFrozenOldRecordR22Nine(t *testing.T) {
	// Optional fixture in the isolated staging directory, never AppData/DB/raw capture.
	path := os.Getenv("BATTLE_HISTORY_AUDIT_RECORDS")
	if path == "" {
		path = "../records-before.json"
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		t.Skip("isolated seven-record frozen snapshot unavailable")
	}
	if err != nil {
		t.Fatal(err)
	}
	catalog, _ := growthCatalog(t)
	var input struct {
		Records []BattleRecord `json:"records"`
	}
	if json.Unmarshal(data, &input) != nil {
		t.Fatal("invalid frozen normalized snapshots")
	}
	var old *BattleRecord
	for i := range input.Records {
		if input.Records[i].ID == "rkpp:1876469132858231449" {
			old = &input.Records[i]
		}
	}
	if old == nil {
		t.Fatal("old acceptance record missing")
	}
	before, _ := json.Marshal(old)
	h := BuildBattleGrowthHistory(*old, catalog)
	s := historySnapshot(t, h, "rkpp:action:22:120:9:switch")
	assertHistoryCount(t, s, 9, "observedPrefix")
	if s.Side != "me" || s.Actor != "5" || s.MonsterID != 202 || s.Unit != "层" || len(s.EvidenceEventIDs) != 9 {
		t.Fatalf("bad actual snapshot %+v", s)
	}
	for _, id := range s.EvidenceEventIDs {
		for _, e := range old.Events {
			if e.ID == id && (e.Round < 13 || e.Round > 21 || e.SkillID != 155 || e.Actor != "2" || e.Phase != "executed") {
				t.Fatalf("bad actual source %+v", e)
			}
		}
	}
	for _, e := range h.Entries {
		if e.Known && e.EventID != s.EventID {
			t.Fatalf("unreviewed actual known entry %+v", e)
		}
	}
	row := growthRow(t, BuildBattleGrowthStats([]BattleRecord{*old}, catalog), "me", 202)
	growthAssert(t, row.Trait.Total, row.Trait.Samples, row.Trait.Unknown, row.Trait.Average, 9, 1, 0)
	if row.Trait.ObservedPrefixSamples != 1 || old.Quality.Actions {
		t.Fatal("partial capture upgraded")
	}
	after, _ := json.Marshal(old)
	diskAfter, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) || !bytes.Equal(data, diskAfter) {
		t.Fatal("raw JSON changed")
	}
	t.Logf("frozen7 SHA256=%x; old R22 water prefix=9; future R27/31/34 and R24 leader form excluded", sha256.Sum256(data))
}
