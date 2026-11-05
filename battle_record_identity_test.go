package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/mielicalibrate"
)

func identityCatalog(t *testing.T) (*catalog.Catalog, map[string]any) {
	t.Helper()
	c := &catalog.Catalog{
		SchemaVersion: 2,
		Types:         []catalog.Type{{ID: 1, Code: "Normal", Name: "普通", VulnerableTo: []int{}, ResistantTo: []int{}}},
		Traits:        []catalog.Trait{{ID: "test", Name: "合成特性", Description: "仅测试"}},
		Skills:        []catalog.Skill{{ID: 1, Name: "合成技能", Description: "仅测试", TypeID: 1, Category: "Status"}},
		Extensions:    catalog.Extensions{},
	}
	for i := 1; i <= 2; i++ {
		c.Monsters = append(c.Monsters, catalog.Monster{ID: i, Name: fmt.Sprintf("合成精灵%d", i), DexNumber: 101, TypeIDs: []int{1}, TraitID: "test", Stats: catalog.Stats{HP: 100, PhyAtk: 100, PhyDef: 100, MagAtk: 100, MagDef: 100, Speed: 100}, Form: "default", FormCategory: "无多形态", EvolutionStage: "高级形态", EvolutionMembers: []int{i}})
		c.Learnsets = append(c.Learnsets, catalog.Learnset{MonsterID: i, Mode: "own", Skills: []catalog.LearnedSkill{}})
	}
	hashes := map[string]string{}
	for _, key := range []string{"PETBASE_CONF.json", "PET_HANDBOOK.json", "PET_EVOLUTION_CONF.json", "SKILL_CONF.json", "LEVEL_SKILL_CONF.json", "LEVEL_SKILL_EXTRA_CONF.json"} {
		hashes[key] = strings.Repeat("a", 64)
	}
	hashes["PETBASE_CONF.json"] = "dd82df4d55043407637718dcbd4624014fc6b0069009d3a479ecd66dbc5d485b"
	metadata := map[string]any{"version": 1, "repository": mielicalibrate.Repository, "revision": mielicalibrate.Revision, "source_hashes": hashes, "mapping": []mielicalibrate.Mapping{{LocalID: 1, ClientID: 101, Method: "name_form_handbook"}, {LocalID: 2, ClientID: 102, Method: "name_form_handbook"}}}
	return c, metadata
}

func identityBytes(t *testing.T, c *catalog.Catalog, metadata map[string]any) []byte {
	t.Helper()
	if metadata != nil {
		c.Extensions["mieli_calibration"] = domainEncode(t, metadata)
	}
	b, err := catalog.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func identityRecord() BattleRecord {
	return BattleRecord{Version: 1, ID: "identity", Source: "first-source", Sides: map[string]BattleSide{
		"me":    {Pets: []BattlePet{{InstanceID: "m", ProtocolBaseID: "101", ProtocolID: "99901"}}},
		"enemy": {Pets: []BattlePet{{InstanceID: "e", ProtocolBaseID: "102", ProtocolID: "99902", IV: map[string]BattleEvidence{"speed": {Value: domainFloat(0), Certainty: "direct", Evidence: []string{"explicit zero"}}}}}},
	}, Events: []BattleEvent{{ID: "form-1", Round: 3, Seq: 4, Kind: "form", Phase: "executed", Side: "enemy", Actor: "e", Form: &BattleFormChange{FromBaseID: "102", ToBaseID: "101", ExecIndex: 2}}}, Rounds: 36}
}

func TestBattleIdentityExplicitMapAndNamespaces(t *testing.T) {
	c, meta := identityCatalog(t)
	b := identityBytes(t, c, meta)
	m, err := battleReadIdentityMap(b)
	if err != nil {
		t.Fatal(err)
	}
	r := identityRecord()
	if err := m.apply(&r, false); err != nil {
		t.Fatal(err)
	}
	if err := ValidateBattleRecord(&r); err != nil {
		t.Fatal(err)
	}
	wantRevision := fmt.Sprintf("%x", sha256.Sum256(b))
	if r.Sides["me"].Pets[0].MonsterID != 1 || r.Sides["enemy"].Pets[0].MonsterID != 2 || r.Sides["enemy"].Pets[0].MappingRevision != wantRevision {
		t.Fatal("explicit initial mapping lost", r.Sides)
	}
	f := r.Events[0].Form
	if f.FromMonsterID != 2 || f.ToMonsterID != 1 || f.MappingRevision != wantRevision || len(r.Sides["enemy"].Pets) != 1 {
		t.Fatal("form replaced initial instance", r)
	}
	if r.Quality.Actions || r.Quality.Lead["enemy"] || r.Quality.Roster["enemy"] || r.Sides["enemy"].Pets[0].IV["speed"].Value == nil || *r.Sides["enemy"].Pets[0].IV["speed"].Value != 0 {
		t.Fatal("mapping changed flags/zero evidence")
	}
	for _, base := range []string{"", "99999"} {
		r := identityRecord()
		p := &r.Sides["me"].Pets[0]
		p.ProtocolBaseID = base
		p.ProtocolID = "101"
		p.Name = "合成精灵1"
		if err := m.apply(&r, false); err != nil || p.MonsterID != 0 || p.MappingRevision != "" {
			t.Fatal("guessed conf/name/dex mapping", err, p)
		}
	}
	stats := BuildBattleStats([]BattleRecord{r}, nil)
	for _, enemy := range stats.Enemy {
		if enemy.Appeared != 0 || len(enemy.Skills) != 0 {
			t.Fatal("form became appearance/cast", enemy)
		}
	}
}

func TestBattleIdentityMissingDeletedAndInvalidMaps(t *testing.T) {
	for _, kind := range []string{"missing", "deleted", "wrong extension"} {
		t.Run(kind, func(t *testing.T) {
			c, meta := identityCatalog(t)
			switch kind {
			case "missing":
				meta = nil
			case "wrong extension":
				c.Extensions["other_mapping"] = domainEncode(t, meta)
				meta = nil
			case "deleted":
				c.Monsters = c.Monsters[1:]
				c.Learnsets = c.Learnsets[1:]
			}
			m, err := battleReadIdentityMap(identityBytes(t, c, meta))
			if err != nil {
				t.Fatal(err)
			}
			r := identityRecord()
			if err := m.apply(&r, false); err != nil || r.Sides["me"].Pets[0].MonsterID != 0 {
				t.Fatal("missing identity was invented", err)
			}
		})
	}
	for _, kind := range []string{"future", "namespace", "revision", "source hash", "missing hash", "method", "ambiguous", "reverse ambiguous", "invalid id", "null"} {
		t.Run(kind, func(t *testing.T) {
			c, meta := identityCatalog(t)
			rows := meta["mapping"].([]mielicalibrate.Mapping)
			switch kind {
			case "future":
				meta["version"] = 2
			case "namespace":
				meta["repository"] = "https://example.invalid/conf_id"
			case "revision":
				meta["revision"] = "unreviewed"
			case "source hash":
				meta["source_hashes"].(map[string]string)["PETBASE_CONF.json"] = strings.Repeat("b", 64)
			case "missing hash":
				delete(meta["source_hashes"].(map[string]string), "SKILL_CONF.json")
			case "method":
				rows[0].Method = "name_guess"
			case "ambiguous":
				rows[1].ClientID = 101
			case "reverse ambiguous":
				rows[1].LocalID = 1
			case "invalid id":
				rows[0].ClientID = 0
			}
			b := identityBytes(t, c, meta)
			if kind == "null" {
				c.Extensions["mieli_calibration"] = json.RawMessage(`null`)
				b = identityBytes(t, c, nil)
			}
			if _, err := battleReadIdentityMap(b); !errors.Is(err, errBattleMapping) {
				t.Fatal("accepted invalid calibration", err)
			}
		})
	}
	if _, err := battleReadIdentityMap([]byte(`{"schema_version":999}`)); err == nil {
		t.Fatal("future catalogue accepted")
	}
}

func TestBattleIdentityServiceReplayConflictAndGuard(t *testing.T) {
	c, meta := identityCatalog(t)
	data := identityBytes(t, c, meta)
	calls := 0
	reader := func() ([]byte, error) { calls++; return data, nil }
	path := filepath.Join(t.TempDir(), "private", "battle.sqlite")
	s, err := NewBattleService(path, reader)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if calls != 0 {
		t.Fatal("eager catalogue read")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("eager db", err)
	}
	ctx := context.Background()
	r := identityRecord()
	r.ImportedAt = "2026-10-30T00:00:00Z"
	if result := backendImport(t, s, r); result.Imported != 1 {
		t.Fatal(result)
	}
	first, err := s.Record(ctx, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if r.Sides["me"].Pets[0].MonsterID != 0 {
		t.Fatal("caller mutated")
	}
	data = append(append([]byte{}, data...), '\n') // exact bytes change; identity does not
	if result := backendImport(t, s, r); result.Duplicates != 1 || result.Imported != 0 {
		t.Fatal("replay rewrote mapping provenance", result)
	}
	again, err := s.Record(ctx, r.ID)
	if err != nil || !reflect.DeepEqual(first, again) {
		t.Fatal("replay changed evidence", err)
	}
	var stored string
	if err := s.db.QueryRow("SELECT record_json FROM battles WHERE id=?", r.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(stored)))
	for _, guard := range []map[string]string{{r.ID: strings.Repeat("0", 64)}, {}, {"other": hash}, {r.ID: hash, "extra": hash}} {
		if _, err := s.Import(ctx, []BattleRecord{r}, guard); !errors.Is(err, errBattleInvalid) {
			t.Fatal("bad guard accepted", guard, err)
		}
	}
	if result, err := s.Import(ctx, []BattleRecord{r}, map[string]string{r.ID: hash}); err != nil || result.Duplicates != 1 {
		t.Fatal("correct guard failed", result, err)
	}
	missing := identityRecord()
	missing.ID = "missing"
	if _, err := s.Import(ctx, []BattleRecord{missing}, map[string]string{missing.ID: hash}); !errors.Is(err, errBattleInvalid) {
		t.Fatal("guard created new row", err)
	}
	bad := identityRecord()
	bad.Sides["enemy"].Pets[0].MonsterID = 1
	if result, err := s.Import(ctx, []BattleRecord{missing, bad}); !errors.Is(err, errBattleInvalid) || result.Imported != 0 {
		t.Fatal("mapping conflict not atomic", result, err)
	}
	if _, err := s.Record(ctx, missing.ID); !errors.Is(err, errBattleNotFound) {
		t.Fatal("batch partially committed")
	}
	// Conflicting current calibration cannot silently reassign stored identity.
	rows := meta["mapping"].([]mielicalibrate.Mapping)
	rows[0].LocalID, rows[1].LocalID = 2, 1
	data = identityBytes(t, c, meta)
	if _, err := s.Import(ctx, []BattleRecord{r}); !errors.Is(err, errBattleInvalid) {
		t.Fatal("known mapping reassigned", err)
	}
}

func TestBattleIdentityReaderFailureAndHTTPInjection(t *testing.T) {
	ctx := context.Background()
	without := backendService(t)
	backendImport(t, without, identityRecord())
	unknown, _ := without.Record(ctx, "identity")
	if unknown.Sides["me"].Pets[0].MonsterID != 0 {
		t.Fatal("fallback mapping")
	}
	path := filepath.Join(t.TempDir(), "no-read", "battle.sqlite")
	s, err := NewBattleService(path, func() ([]byte, error) { return nil, errors.New("PRIVATE_READER_ERROR") })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.Import(ctx, []BattleRecord{identityRecord()}); !errors.Is(err, errBattleMapping) {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("reader failure touched database")
	}
	c, meta := identityCatalog(t)
	data := identityBytes(t, c, meta)
	count := 0
	mux := http.NewServeMux()
	defer RegisterBattleRecordRoutes(mux, filepath.Join(t.TempDir(), "http.sqlite"), func() ([]byte, error) { count++; return data, nil })()
	if w := backendRequest(mux, "GET", "/api/battles/status", ""); w.Code != 200 || count != 0 {
		t.Fatal("status reads catalogue", w.Code)
	}
	if w := backendRequest(mux, "POST", "/api/battles/import", string(domainEncode(t, identityRecord()))); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := backendRequest(mux, "GET", "/api/battles/record?id=identity", "")
	var got BattleRecord
	if json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Sides["me"].Pets[0].MonsterID != 1 || got.Events[0].Form.ToMonsterID != 1 || count != 1 {
		t.Fatal("HTTP did not use exact reader", w.Body.String(), count)
	}
}

func TestBattleIdentityFormModelMergeAndValidation(t *testing.T) {
	a := identityRecord()
	a.Rounds = 0
	b := domainClone(t, a)
	b.Rounds = 36
	b.Events[0].Form.FromMonsterID = 2
	b.Events[0].Form.ToMonsterID = 1
	b.Events[0].Form.MappingRevision = strings.Repeat("a", 64)
	merged, err := MergeBattleRecord(a, b)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Rounds != 36 || merged.Events[0].Form.ToMonsterID != 1 || merged.Sides["enemy"].Pets[0].MonsterID != 0 {
		t.Fatal("form overwrote roster")
	}
	again, err := MergeBattleRecord(merged, a)
	if err != nil || !reflect.DeepEqual(domainEncode(t, merged), domainEncode(t, again)) {
		t.Fatal("raw form replay not idempotent", err)
	}
	b.Events[0].Form.MappingRevision = strings.Repeat("b", 64)
	again, err = MergeBattleRecord(merged, b)
	if err != nil || again.Events[0].Form.MappingRevision != strings.Repeat("a", 64) {
		t.Fatal("form replay changed revision", err)
	}
	for _, kind := range []string{"round conflict", "form conflict", "exec conflict", "base conflict"} {
		bad := domainClone(t, merged)
		switch kind {
		case "round conflict":
			bad.Rounds = 37
		case "form conflict":
			bad.Events[0].Form.ToMonsterID = 2
		case "exec conflict":
			bad.Events[0].Form.ExecIndex++
		case "base conflict":
			bad.Events[0].Form.ToBaseID = "999"
		}
		if _, err := MergeBattleRecord(merged, bad); err == nil {
			t.Fatal("accepted", kind)
		}
	}
	for _, mutate := range []func(*BattleRecord){
		func(r *BattleRecord) { r.Rounds = -1 }, func(r *BattleRecord) { r.Rounds = 1000001 },
		func(r *BattleRecord) { r.Events[0].Form = nil }, func(r *BattleRecord) { r.Events[0].Kind = "note" },
		func(r *BattleRecord) { r.Events[0].Phase = "preview" }, func(r *BattleRecord) { r.Events[0].Side = "unknown" },
		func(r *BattleRecord) { r.Events[0].Actor = "absent" }, func(r *BattleRecord) { r.Events[0].SkillID = 1 },
		func(r *BattleRecord) { r.Events[0].Form.ExecIndex = -1 }, func(r *BattleRecord) { r.Events[0].Form.ToBaseID = "0101" },
		func(r *BattleRecord) { r.Events[0].Form.MappingRevision = "bad" }, func(r *BattleRecord) { r.Sides["me"].Pets[0].ProtocolBaseID = "conf:101" },
	} {
		r := identityRecord()
		mutate(&r)
		if err := ValidateBattleRecord(&r); err == nil {
			t.Fatal("invalid additive field accepted", r)
		}
	}
	ordered := identityRecord()
	later := *ordered.Events[0].Form
	later.ExecIndex = 1
	ordered.Events = append(ordered.Events, BattleEvent{ID: "form-before", Round: 3, Seq: 4, Kind: "form", Phase: "executed", Side: "enemy", Actor: "e", Form: &later})
	ordered.Quality.Actions = true
	if err := ValidateBattleRecord(&ordered); err != nil || ordered.Events[0].ID != "form-before" || ordered.Quality.Actions {
		t.Fatal("form execution ordering/coverage", err)
	}
	// Existing multi-capture rules: merely unioning partial captures never sets
	// completeness; an extension of a declared complete capture withdraws it.
	full := domainFixture("captures")
	partial := domainClone(t, full)
	partial.Quality.Actions = false
	partial.Events = append(partial.Events, BattleEvent{ID: "form-extra", Kind: "form", Phase: "executed", Side: "enemy", Actor: "e1", Form: &BattleFormChange{FromBaseID: "102", ToBaseID: "101"}})
	union, err := MergeBattleRecord(full, partial)
	if err != nil || union.Quality.Actions {
		t.Fatal("form bypassed multicapture completeness", err)
	}
	full.Quality.Actions = false
	union, err = MergeBattleRecord(full, partial)
	if err != nil || union.Quality.Actions {
		t.Fatal("partial union manufactured completeness", err)
	}
	for _, boolean := range []string{"true", "false"} {
		obj := strings.Replace(string(domainEncode(t, identityRecord())), `"rounds":36`, `"rounds":`+boolean, 1)
		if _, _, err := DecodeBattleImport([]byte(obj)); err == nil {
			t.Fatal("rounds accepted boolean")
		}
	}
}
