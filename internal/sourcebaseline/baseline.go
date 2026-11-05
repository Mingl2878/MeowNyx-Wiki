// Package sourcebaseline defines the versioned, inert acknowledgement metadata.
// Values describe the source, never a patch, local ID, or permanent preference.
package sourcebaseline

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const Extension = "tencent_source_baseline"
const Provider = "tencent-compendium"
const Version = 1
const NormalizerVersion = 1

type Entry struct {
	Entity   string          `json:"entity"`
	Identity string          `json:"identity"`
	Field    string          `json:"field"`
	Value    json.RawMessage `json:"value"`
}
type Baseline struct {
	Version           int               `json:"version"`
	NormalizerVersion int               `json:"normalizer_version"`
	Provider          string            `json:"provider"`
	SourceSHA256      string            `json:"source_sha256"`
	Entries           map[string]Entry  `json:"entries"`
	Issues            map[string]string `json:"issues,omitempty"`
}

// Observation adds a preview-only mapped local ID and availability. Neither is
// persisted; provisional allocation can change after accepting another entity.
type Observation struct {
	Entry
	LocalID   int
	Available bool
}

func Key(entity, identity, field string) string {
	return fmt.Sprintf("%s:%x:%s", entity, sha256.Sum256([]byte(identity)), field)
}
func FieldKnown(entity, field string) bool {
	if entity == "catalog" {
		return field == "image_policy"
	}
	if entity == "monster" {
		return field == "identity" || field == "evolution" || field == "leader_form" || field == "learning" || field == "evolution_stage" || field == "type_ids" || field == "data_note" || field == "trait" || field == "entity" || strings.Contains("|stats.hp|stats.phy_atk|stats.mag_atk|stats.phy_def|stats.mag_def|stats.speed|", "|"+field+"|")
	}
	return entity == "skill" && (field == "identity" || field == "entity" || field == "description" || field == "type_id" || field == "category" || field == "energy_cost" || field == "power" || field == "season")
}

var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func New(hash string) Baseline {
	return Baseline{Version: Version, NormalizerVersion: NormalizerVersion, Provider: Provider, SourceSHA256: hash, Entries: map[string]Entry{}}
}
func Validate(b Baseline) error {
	if b.Version != Version || b.NormalizerVersion != NormalizerVersion || b.Provider != Provider {
		return fmt.Errorf("unsupported Tencent source baseline version/provider")
	}
	if !digest.MatchString(b.SourceSHA256) || b.Entries == nil {
		return fmt.Errorf("invalid Tencent source baseline header")
	}
	for key, fingerprint := range b.Issues {
		if !digest.MatchString(key) || !digest.MatchString(fingerprint) {
			return fmt.Errorf("invalid Tencent source baseline diagnostic")
		}
	}
	for key, entry := range b.Entries {
		if !FieldKnown(entry.Entity, entry.Field) || entry.Identity == "" || len(entry.Identity) > 2048 || strings.ContainsAny(entry.Identity, "\r\n\x00") || key != Key(entry.Entity, entry.Identity, entry.Field) || len(entry.Value) == 0 || !json.Valid(entry.Value) {
			return fmt.Errorf("invalid Tencent source baseline entry %q", key)
		}
		var value struct {
			Available *bool           `json:"available"`
			Value     json.RawMessage `json:"value"`
		}
		dec := json.NewDecoder(bytes.NewReader(entry.Value))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&value); err != nil || value.Available == nil || len(value.Value) == 0 {
			return fmt.Errorf("invalid Tencent source observation %q", key)
		}
	}
	return nil
}
func Decode(raw []byte) (*Baseline, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var b Baseline
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, fmt.Errorf("invalid Tencent source baseline: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("trailing Tencent source baseline JSON")
	}
	if err := Validate(b); err != nil {
		return nil, err
	}
	return &b, nil
}
func Equal(a, b json.RawMessage) bool {
	var av, bv any
	da := json.NewDecoder(bytes.NewReader(a))
	da.UseNumber()
	db := json.NewDecoder(bytes.NewReader(b))
	db.UseNumber()
	if da.Decode(&av) != nil || db.Decode(&bv) != nil {
		return false
	}
	aa, _ := json.Marshal(av)
	bb, _ := json.Marshal(bv)
	return bytes.Equal(aa, bb)
}
func (b *Baseline) Matches(o Observation) bool {
	if b == nil {
		return false
	}
	old, ok := b.Entries[Key(o.Entity, o.Identity, o.Field)]
	return ok && Equal(old.Value, o.Value)
}
func (b *Baseline) Put(o Observation) { b.Entries[Key(o.Entity, o.Identity, o.Field)] = o.Entry }
