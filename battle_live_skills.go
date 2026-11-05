package main

import (
	"bytes"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// This is a reviewed configuration-ID identity table, not a runtime skill-ID
// decoder. Callers must first prove a runtime -> configuration binding from
// explicit protocol fields. No division, suffix matching, names or prior battle
// runtime bindings are used here. Current catalog edits never rematch identities.
//
//go:embed data/battle-protocol-skills.json
var battleStreamSkillProofJSON string

const (
	battleStreamSkillSourceRevision = "727614cc195299cce6b3398c2dd82e23e4db9318"
	battleStreamSkillSourceSHA256   = "9e91429400ba14e2a194d0c14c63b157cee0dcc049ced78c89b2042a414026c0"
	battleStreamSkillSourceURL      = "https://raw.githubusercontent.com/mieli1722/roco_kingdom_world_conf/" + battleStreamSkillSourceRevision + "/SKILL_CONF.json"
)

type battleStreamSkillProof struct {
	Name                   string    `json:"name"`
	SourceNameCount        int       `json:"sourceNameCount"`
	CanonicalNameCount     int       `json:"canonicalNameCount"`
	SourceType             int       `json:"sourceType"`
	SourceSkillType        int       `json:"sourceSkillType"`
	SourceDamageType       int       `json:"sourceDamageType"`
	SourceElement          int       `json:"sourceElement"`
	LocalTypeID            int       `json:"localTypeId"`
	LocalCategory          string    `json:"localCategory"`
	SourceEnergyCost       []float64 `json:"sourceEnergyCost"`
	LocalEnergyCost        float64   `json:"localEnergyCost"`
	SourceDamageParameters []float64 `json:"sourceDamageParameters"`
	LocalPower             *float64  `json:"localPower"`
	SourceDescription      string    `json:"sourceDescription"`
	LocalDescription       string    `json:"localDescription"`
}

type battleStreamSkillBinding struct {
	ConfigID     string                 `json:"configId"`
	LocalSkillID int                    `json:"localSkillId"`
	Proof        battleStreamSkillProof `json:"proof"`
}

type battleStreamSkillExclusion struct {
	ConfigID   string `json:"configId"`
	Name       string `json:"name"`
	SourceType int    `json:"sourceType"`
	Reason     string `json:"reason"`
}

type battleStreamSkillDocument struct {
	Version int `json:"version"`
	Source  struct {
		Revision string `json:"revision"`
		SHA256   string `json:"sha256"`
		URL      string `json:"url"`
		RowCount int    `json:"rowCount"`
	} `json:"source"`
	CatalogReviewSHA256     string                       `json:"catalogReviewSha256"`
	CanonicalReviewedSkills int                          `json:"canonicalReviewedSkills"`
	Policy                  string                       `json:"policy"`
	Mappings                []battleStreamSkillBinding   `json:"mappings"`
	Excluded                []battleStreamSkillExclusion `json:"excluded"`
}

var battleStreamSkillMarkup = regexp.MustCompile(`<desc_id=[0-9]+>|<span fork_road="or">|</>`)

func battleStreamSkillSemanticText(text string) (string, bool) {
	text = battleStreamSkillMarkup.ReplaceAllString(text, "")
	if strings.ContainsAny(text, "<>") {
		return "", false
	}
	text = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, text)
	return text, text != ""
}

func battleStreamSkillElement(source int) int {
	// Explicit reviewed SkillDamType -> canonical type IDs, not an offset.
	switch source {
	case 2:
		return 1
	case 3:
		return 2
	case 4:
		return 3
	case 5:
		return 4
	case 6:
		return 5
	case 8:
		return 6
	case 9:
		return 7
	case 10:
		return 8
	case 11:
		return 9
	case 12:
		return 10
	case 13:
		return 11
	case 14:
		return 12
	case 15:
		return 13
	case 16:
		return 14
	case 17:
		return 15
	case 18:
		return 16
	case 19:
		return 17
	case 20:
		return 18
	}
	return 0
}

func battleStreamSkillCategory(kind, damage int) string {
	switch {
	case kind == 1 && damage == 2:
		return "Physical Attack"
	case kind == 1 && damage == 3:
		return "Magic Attack"
	case kind == 2 && damage == 1:
		return "Status"
	case kind == 3 && damage == 1:
		return "Defense"
	}
	return ""
}

func battleStreamSkillConfigID(id string) bool {
	n, err := strconv.ParseUint(id, 10, 32)
	return err == nil && n != 0 && strconv.FormatUint(n, 10) == id
}

// Validate only the embedded frozen review, never read or name-match the current
// catalog here. Duplicate IDs (even equal duplicates), conflicting evidence,
// ambiguous canonical names and nonordinary rows fail the entire table closed.
// Multiple source rows may share a name: each exact configuration ID must have
// its own complete matching semantic proof; source-name uniqueness is not needed.
func battleStreamSkillDecode(data []byte) (map[string]int, error) {
	fail := func() (map[string]int, error) {
		return nil, errors.New("invalid reviewed battle skill identity table")
	}
	if len(data) == 0 || len(data) > 2<<20 {
		return fail()
	}
	var doc battleStreamSkillDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&doc) != nil {
		return fail()
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return fail()
	}
	catalogHash, err := hex.DecodeString(doc.CatalogReviewSHA256)
	if doc.Version != 1 || doc.Source.Revision != battleStreamSkillSourceRevision || doc.Source.SHA256 != battleStreamSkillSourceSHA256 || doc.Source.URL != battleStreamSkillSourceURL || doc.Source.RowCount != 1988 || err != nil || len(catalogHash) != 32 || doc.CanonicalReviewedSkills <= 0 || doc.Policy == "" || len(doc.Mappings) == 0 || len(doc.Mappings) > 4096 || len(doc.Excluded) > 4096 {
		return fail()
	}
	ids := make(map[string]int, len(doc.Mappings))
	for _, row := range doc.Mappings {
		p := row.Proof
		if !battleStreamSkillConfigID(row.ConfigID) || row.LocalSkillID <= 0 || ids[row.ConfigID] != 0 || p.Name == "" || p.SourceNameCount < 1 || p.CanonicalNameCount != 1 || p.SourceType != 1 || p.LocalTypeID == 0 || battleStreamSkillElement(p.SourceElement) != p.LocalTypeID || battleStreamSkillCategory(p.SourceSkillType, p.SourceDamageType) != p.LocalCategory || p.LocalCategory == "" || len(p.SourceEnergyCost) == 0 || p.LocalEnergyCost < 0 || p.SourceEnergyCost[0] != p.LocalEnergyCost || len(p.SourceDamageParameters) == 0 {
			return fail()
		}
		sourceText, sourceOK := battleStreamSkillSemanticText(p.SourceDescription)
		localText, localOK := battleStreamSkillSemanticText(p.LocalDescription)
		if !sourceOK || !localOK || sourceText != localText || (p.LocalPower != nil && *p.LocalPower != p.SourceDamageParameters[0]) {
			return fail()
		}
		ids[row.ConfigID] = row.LocalSkillID
	}
	excluded := make(map[string]bool, len(doc.Excluded))
	for _, row := range doc.Excluded {
		if !battleStreamSkillConfigID(row.ConfigID) || ids[row.ConfigID] != 0 || excluded[row.ConfigID] || row.Reason == "" {
			return fail()
		}
		excluded[row.ConfigID] = true
	}
	return ids, nil
}

var battleStreamSkillIDs = func() map[string]int {
	ids, _ := battleStreamSkillDecode([]byte(battleStreamSkillProofJSON))
	return ids // A corrupt/unsupported embedded table resolves every ID to unknown.
}()

// battleStreamSkillLocal returns only a fixed, reviewed configuration mapping.
// Zero means unknown, excluded, ambiguous, system, passive, or malformed ID.
// Runtime IDs and current display names are deliberately not accepted aliases.
func battleStreamSkillLocal(configID string) int {
	return battleStreamSkillIDs[configID]
}
