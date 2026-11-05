package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

// This whitelist records user confirmation, NOT independent configuration-table
// proof. The reviewed 503 configuration mappings remain a separate authority.
// Pin the complete dated declaration so even a valid-looking changed ID, target,
// provenance, duplicate JSON key or added alias fails closed. Names are audit
// labels only: the live catalog is consulted by stable ID, never name-rematched.
//
//go:embed data/battle-user-confirmed-skills.json
var battleUserConfirmedSkillsJSON string

const battleUserConfirmedSkillsSHA256 = "1ea4e52c0aca43c797d9ce6d41d658d77e5e772d0677b9a2d859671f9449c3cc"

type battleUserConfirmedSkillRow struct {
	RuntimeID    string `json:"runtimeId"`
	LocalSkillID int    `json:"localSkillId"`
	Name         string `json:"name"`
	Source       string `json:"source"`
	ConfirmedAt  string `json:"confirmedAt"`
}
type battleUserConfirmedNoOpRow struct {
	RuntimeID   string `json:"runtimeId"`
	Label       string `json:"label"`
	Source      string `json:"source"`
	ConfirmedAt string `json:"confirmedAt"`
}
type battleUserConfirmedSkillDocument struct {
	Version     int                           `json:"version"`
	Source      string                        `json:"source"`
	ConfirmedAt string                        `json:"confirmedAt"`
	Policy      string                        `json:"policy"`
	Mappings    []battleUserConfirmedSkillRow `json:"mappings"`
	NoOps       []battleUserConfirmedNoOpRow  `json:"noOps"`
}
type battleUserConfirmedTable struct {
	skills map[string]int
	noOps  map[string]bool
}

func battleUserConfirmedDecode(data []byte) (*battleUserConfirmedTable, error) {
	fail := func() (*battleUserConfirmedTable, error) {
		return nil, errors.New("invalid dated user-confirmed battle identity whitelist")
	}
	if len(data) == 0 || len(data) > 16<<10 {
		return fail()
	}
	var doc battleUserConfirmedSkillDocument
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&doc) != nil {
		return fail()
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF {
		return fail()
	}
	provenance := func(source, date string) bool { return source == "user_confirmed" && date == "2026-11-03" }
	if doc.Version != 1 || !provenance(doc.Source, doc.ConfirmedAt) || doc.Policy == "" || len(doc.Mappings) != 12 || len(doc.NoOps) != 1 {
		return fail()
	}
	out := &battleUserConfirmedTable{skills: map[string]int{}, noOps: map[string]bool{}}
	for _, row := range doc.Mappings {
		if !battleStreamSkillConfigID(row.RuntimeID) || row.LocalSkillID <= 0 || row.LocalSkillID > 1000000000 || out.skills[row.RuntimeID] != 0 || row.Name == "" || !provenance(row.Source, row.ConfirmedAt) {
			return fail()
		}
		out.skills[row.RuntimeID] = row.LocalSkillID
	}
	for _, row := range doc.NoOps {
		if !battleStreamSkillConfigID(row.RuntimeID) || out.skills[row.RuntimeID] != 0 || out.noOps[row.RuntimeID] || row.Label == "" || !provenance(row.Source, row.ConfirmedAt) {
			return fail()
		}
		out.noOps[row.RuntimeID] = true
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != battleUserConfirmedSkillsSHA256 {
		return fail()
	}
	return out, nil
}

var battleUserConfirmedSkills, battleUserConfirmedSkillsError = battleUserConfirmedDecode([]byte(battleUserConfirmedSkillsJSON))

func battleUserConfirmedSkillLocal(runtime string) int {
	if battleUserConfirmedSkills == nil {
		return 0
	}
	return battleUserConfirmedSkills.skills[runtime]
}

func battleUserConfirmedSkillEvent(e BattleEvent) bool {
	return e.Kind == "skill" && battleOneOf(e.SkillClass, "", "unknown", "ordinary", "response")
}

// battleIsStunSkip is a derived view only. In particular, retain the historical
// Kind=skill/Phase=executed/class, order, source IDs, resources and quality. A
// conflicting positive local identity must be rejected, never hidden as a no-op.
func battleIsStunSkip(e BattleEvent) bool {
	return battleUserConfirmedSkills != nil && battleUserConfirmedSkills.noOps[e.ProtocolSkillID] && e.SkillID == 0 && battleUserConfirmedSkillEvent(e) && battleOneOf(e.Phase, "executed", "interrupted")
}

// Validation is nonmutating and also runs when no live catalog is available.
func battleValidateUserConfirmedSkill(e BattleEvent) error {
	if battleUserConfirmedSkillsError != nil {
		return battleUserConfirmedSkillsError
	}
	if !battleUserConfirmedSkillEvent(e) {
		return nil
	}
	local := battleUserConfirmedSkillLocal(e.ProtocolSkillID)
	direct := battleStreamSkillLocal(e.ProtocolSkillConfigID)
	if local != 0 && (e.SkillID != 0 && e.SkillID != local || direct != 0 && direct != local) {
		return errBattleInvalid
	}
	if battleUserConfirmedSkills.noOps[e.ProtocolSkillID] && (e.SkillID != 0 || direct != 0 || e.Combat != nil && e.Combat.ActionKind != "") {
		return errBattleInvalid
	}
	return nil
}

// Fill missing identities only; nil catalog means the assembler's provisional
// lookup. Import supplies the same immutable catalog snapshot used for identity.
func battleApplyUserConfirmedSkill(e *BattleEvent, catalogSkills map[int]bool) error {
	if err := battleValidateUserConfirmedSkill(*e); err != nil {
		return err
	}
	if !battleUserConfirmedSkillEvent(*e) || e.SkillID != 0 {
		return nil
	}
	local := battleUserConfirmedSkillLocal(e.ProtocolSkillID)
	if local > 0 && (catalogSkills == nil || catalogSkills[local]) {
		e.SkillID = local
	}
	return nil
}
