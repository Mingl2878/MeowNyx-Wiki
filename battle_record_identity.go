package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"

	"xhmwiki/internal/catalog"
	"xhmwiki/internal/mielicalibrate"
)

var errBattleMapping = errors.New("canonical battle identity mapping is unavailable or invalid; no changes were saved")

// Only this explicit petbase namespace is supported. conf_id, dex numbers,
// nicknames and SourceRef IDs are deliberately not alternative lookup keys.
func battleBaseID(id string, required bool) bool {
	if id == "" {
		return !required
	}
	n, err := strconv.ParseUint(id, 10, 32)
	return err == nil && n > 0 && n <= 1000000000 && strconv.FormatUint(n, 10) == id
}

func battleMappingRevision(revision string) bool {
	if revision == "" {
		return true
	}
	decoded, err := hex.DecodeString(revision)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == revision
}

type battleIdentityMap struct {
	revision string
	monsters map[string]int
	skills   map[int]bool
}

// Read only the exact canonical bytes supplied by the owner of the active
// catalogue. Missing calibration is supported, but malformed or ambiguous
// calibration fails closed. No source tables, legacy files or network I/O.
func battleReadIdentityMap(data []byte) (*battleIdentityMap, error) {
	if len(data) == 0 || len(data) > 64<<20 {
		return nil, errBattleMapping
	}
	value, err := battleSharedCatalogDomain(data, "identity-mieli-v1", battleBuildIdentityMap)
	if err != nil {
		return nil, errBattleMapping
	}
	// The index is private and immutable: apply changes only detached records,
	// never the catalogue or these mapping/skill maps.
	return value.(*battleIdentityMap), nil
}

func battleBuildIdentityMap(c *catalog.Catalog, revision string) (any, error) {
	m := &battleIdentityMap{revision: revision, monsters: map[string]int{}, skills: map[int]bool{}}
	for _, skill := range c.Skills {
		m.skills[skill.ID] = true
	}
	raw, exists := c.Extensions["mieli_calibration"]
	if !exists {
		return m, nil
	}
	var calibration struct {
		Version      int                      `json:"version"`
		Repository   string                   `json:"repository"`
		Revision     string                   `json:"revision"`
		SourceHashes map[string]string        `json:"source_hashes"`
		Mapping      []mielicalibrate.Mapping `json:"mapping"`
	}
	if json.Unmarshal(raw, &calibration) != nil || calibration.Version != 1 || calibration.Repository != mielicalibrate.Repository || calibration.Revision != mielicalibrate.Revision {
		return nil, errBattleMapping
	}
	// Pin the species table's reviewed namespace, not a similarly named mapping
	// from another producer/table. Other source hashes retain explicit provenance.
	if calibration.SourceHashes["PETBASE_CONF.json"] != "dd82df4d55043407637718dcbd4624014fc6b0069009d3a479ecd66dbc5d485b" {
		return nil, errBattleMapping
	}
	for _, key := range []string{"PETBASE_CONF.json", "PET_HANDBOOK.json", "PET_EVOLUTION_CONF.json", "SKILL_CONF.json", "LEVEL_SKILL_CONF.json", "LEVEL_SKILL_EXTRA_CONF.json"} {
		if hash := calibration.SourceHashes[key]; hash == "" || !battleMappingRevision(hash) {
			return nil, errBattleMapping
		}
	}
	local := map[int]bool{}
	for _, pet := range c.Monsters {
		local[pet.ID] = !pet.Placeholder
	}
	clients, locals := map[int]int{}, map[int]int{}
	for _, row := range calibration.Mapping {
		if row.ClientID <= 0 || row.ClientID > 1000000000 || row.LocalID <= 0 || row.LocalID > 1000000000 || !battleOneOf(row.Method, "name_form_handbook", "explicit_boss_target_of_mapped_base") {
			return nil, errBattleMapping
		}
		// Even a deleted target must not hide an ambiguous declaration.
		if prior := clients[row.ClientID]; prior != 0 && prior != row.LocalID {
			return nil, errBattleMapping
		}
		if prior := locals[row.LocalID]; prior != 0 && prior != row.ClientID {
			return nil, errBattleMapping
		}
		clients[row.ClientID], locals[row.LocalID] = row.LocalID, row.ClientID
		if local[row.LocalID] {
			m.monsters[strconv.Itoa(row.ClientID)] = row.LocalID
		}
	}
	return m, nil
}

func (m *battleIdentityMap) apply(r *BattleRecord, preserveRevision bool) error {
	if m == nil {
		return nil
	}
	resolve := func(base string, id *int) (bool, error) {
		mapped := m.monsters[base]
		if mapped == 0 {
			return false, nil
		}
		if *id != 0 && *id != mapped {
			return false, errBattleInvalid
		}
		*id = mapped
		return true, nil
	}
	for side, roster := range r.Sides {
		for i := range roster.Pets {
			p := &roster.Pets[i]
			if !battleBaseID(p.ProtocolBaseID, false) || !battleMappingRevision(p.MappingRevision) {
				return errBattleInvalid
			}
			oldID := p.MonsterID
			mapped, err := resolve(p.ProtocolBaseID, &p.MonsterID)
			if err != nil {
				return err
			}
			if mapped && (!preserveRevision || oldID == 0 || p.MappingRevision == "") {
				p.MappingRevision = m.revision
			}
		}
		r.Sides[side] = roster
	}
	for i := range r.Events {
		event := &r.Events[i]
		if err := battleApplyUserConfirmedSkill(event, m.skills); err != nil {
			return err
		}
		if event.ProtocolSkillConfigID != "" {
			if !battleBaseID(event.ProtocolSkillConfigID, true) || event.ProtocolSkillID == "" {
				return errBattleInvalid
			}
			local := battleStreamSkillLocal(event.ProtocolSkillConfigID)
			if local > 0 && !m.skills[local] && !preserveRevision && r.Source == "rkpp-live-v1" && event.SkillID == local && battleUserConfirmedSkillLocal(event.ProtocolSkillID) == 0 {
				// Configuration-only producer lookups remain provisional until the
				// active catalogue confirms existence. Independently user-confirmed
				// stable identities and stored historical mappings are not erased.
				event.SkillID = 0
			}
			if local > 0 && m.skills[local] && !battleOneOf(event.SkillClass, "passive", "system") {
				if event.SkillID != 0 && event.SkillID != local {
					return errBattleInvalid
				}
				event.SkillID = local
			}
		}
		f := r.Events[i].Form
		if f == nil {
			continue
		}
		if !battleBaseID(f.FromBaseID, true) || !battleBaseID(f.ToBaseID, true) || !battleMappingRevision(f.MappingRevision) {
			return errBattleInvalid
		}
		oldFrom, oldTo := f.FromMonsterID, f.ToMonsterID
		from, err := resolve(f.FromBaseID, &f.FromMonsterID)
		if err != nil {
			return err
		}
		to, err := resolve(f.ToBaseID, &f.ToMonsterID)
		if err != nil {
			return err
		}
		if (from || to) && (!preserveRevision || oldFrom != f.FromMonsterID || oldTo != f.ToMonsterID || f.MappingRevision == "") {
			f.MappingRevision = m.revision
		}
	}
	// Completeness, profiles, first/initial species and all other event facts
	// are not inferred from the existence of a mapping.
	return nil
}
