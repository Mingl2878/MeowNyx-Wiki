// Package officialdex builds a reviewable, side-effect-free legacy catalog proposal.
// It never reads files, downloads images, writes data, or imports package main.
package officialdex

import "xhmwiki/internal/sourcebaseline"

const (
	Provider     = "tencent-compendium"
	SourceURL    = "https://static.gamecenter.qq.com/xgame/roco-kingdom/compendium/d.json"
	ImageBaseURL = "https://static.gamecenter.qq.com/xgame/roco-kingdom/compendium/"
)

// LegacyFiles contains the four complete UTF-8 JSON documents. Bytes are never
// mutated. Types and semantically unchanged documents are returned byte-for-byte.
type LegacyFiles struct {
	Monsters []byte `json:"monsters"`
	Moves    []byte `json:"moves"`
	Types    []byte `json:"types"`
	Wiki     []byte `json:"wiki"`
}

type Change struct {
	Entity string `json:"entity"`
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
	Kind   string `json:"kind"` // add, update, merge
}

type Issue struct {
	Severity string `json:"severity"` // blocking (affected item), warning, review
	Code     string `json:"code"`
	Entity   string `json:"entity"`
	ID       int    `json:"id,omitempty"` // local stable ID; zero if not mapped
	SourceID string `json:"source_id,omitempty"`
	Name     string `json:"name,omitempty"`
	Field    string `json:"field,omitempty"`
	Message  string `json:"message"`
}

// ImageCandidate is evidence, not permission to overwrite an existing asset.
// ExistingPath may be empty; a caller must download/decode/check dimensions and
// quality before deciding any destination. URL is restricted to the source CDN.
type ImageCandidate struct {
	Entity       string `json:"entity"`
	ID           int    `json:"id,omitempty"`
	Name         string `json:"name"`
	Purpose      string `json:"purpose"` // monster, wiki, move, trait, type
	URL          string `json:"url"`
	ExistingPath string `json:"existing_path,omitempty"`
	SourceID     string `json:"source_id,omitempty"`
}

type Stats struct {
	SourceDetails          int `json:"source_details"`
	SourceList             int `json:"source_list"`
	SourceMoves            int `json:"source_moves"`
	MatchedMonsters        int `json:"matched_monsters"`
	AddedMonsters          int `json:"added_monsters"`
	AddedMoves             int `json:"added_moves"`
	PreservedLocalMonsters int `json:"preserved_local_monsters"`
	RefreshedLearningRows  int `json:"refreshed_learning_rows"` // derived wiki metadata; not separate business Changes
}

type Proposal struct {
	Files                   LegacyFiles                  `json:"-"`
	Changes                 []Change                     `json:"changes"`
	Issues                  []Issue                      `json:"issues"`
	Images                  []ImageCandidate             `json:"images"`
	Stats                   Stats                        `json:"stats"`
	SourceSHA256            string                       `json:"source_sha256"`
	SourceObservations      []sourcebaseline.Observation `json:"-"`
	SourceIssueFingerprints map[string]string            `json:"-"`
}

// HasBlockingIssues indicates that affected items need explicit review. Safe
// unrelated changes may still be proposed; callers must surface these issues.
func (p *Proposal) HasBlockingIssues() bool {
	for _, i := range p.Issues {
		if i.Severity == "blocking" {
			return true
		}
	}
	return false
}

type object = map[string]any

func (p *Proposal) issue(severity, code, entity string, id int, sourceID, name, field, message string) {
	if !safeDisplayText(name, false) {
		name = "（非法显示文本，详见源ID）"
	}
	p.Issues = append(p.Issues, Issue{severity, code, entity, id, sourceID, name, field, message})
}
