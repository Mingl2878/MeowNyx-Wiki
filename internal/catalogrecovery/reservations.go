// Package catalogrecovery supports explicit developer deletion fixtures without
// making deletion or restoration a startup migration. Reservations contain only
// source identity and stable local IDs, never deleted business records.
package catalogrecovery

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"

	"xhmwiki/internal/catalog"
)

const Extension = "monster_identity_reservations"
const Provider = "tencent-compendium"

type Reservation struct {
	LocalID  int    `json:"local_id"`
	Provider string `json:"provider"`
	SourceID string `json:"source_id"`
	Identity string `json:"identity"`
}

type Reservations struct {
	Version int           `json:"version"`
	Entries []Reservation `json:"entries"`
}

// Read rejects future versions, unknown fields and conflicting identity claims.
// Catalog.Parse already rejects duplicate JSON keys, including extension keys.
func Read(c *catalog.Catalog) (*Reservations, error) {
	if c == nil {
		return nil, fmt.Errorf("identity reservations: nil catalog")
	}
	r := &Reservations{Version: 1, Entries: []Reservation{}}
	if raw, ok := c.Extensions[Extension]; ok {
		r = &Reservations{}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(r); err != nil {
			return nil, fmt.Errorf("identity reservations: %w", err)
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			return nil, fmt.Errorf("identity reservations: trailing JSON")
		}
		if r.Version != 1 || r.Entries == nil {
			return nil, fmt.Errorf("identity reservations: unsupported version or missing entries")
		}
	}
	ids, sources, identities := map[int]bool{}, map[string]bool{}, map[string]bool{}
	for _, e := range r.Entries {
		sid, err := strconv.Atoi(e.SourceID)
		parts := strings.Split(e.Identity, "|")
		identityOK := len(parts) == 3
		if identityOK {
			dex, parseErr := strconv.Atoi(strings.TrimPrefix(parts[0], "NO."))
			identityOK = parseErr == nil && dex > 0 && parts[0] == fmt.Sprintf("NO.%03d", dex) && strings.TrimSpace(parts[1]) != "" && len(e.Identity) <= 1024
		}
		if e.LocalID <= 0 || e.LocalID > 2147483647 || e.LocalID == 9001 || e.Provider != Provider || err != nil || sid <= 0 || strconv.Itoa(sid) != e.SourceID || !identityOK {
			return nil, fmt.Errorf("identity reservations: invalid entry for local ID %d", e.LocalID)
		}
		if ids[e.LocalID] || sources[e.SourceID] || identities[e.Identity] {
			return nil, fmt.Errorf("identity reservations: duplicate local/source/semantic identity")
		}
		ids[e.LocalID], sources[e.SourceID], identities[e.Identity] = true, true, true
		for _, m := range c.Monsters {
			refMatches := m.SourceRef != nil && m.SourceRef.Provider == e.Provider && m.SourceRef.ID == e.SourceID && m.SourceRef.Identity == e.Identity
			if m.ID == e.LocalID && !refMatches {
				return nil, fmt.Errorf("identity reservations: local ID %d occupied by a different identity", e.LocalID)
			}
			if m.ID != e.LocalID && m.SourceRef != nil && m.SourceRef.Provider == e.Provider && (m.SourceRef.ID == e.SourceID || m.SourceRef.Identity == e.Identity) {
				return nil, fmt.Errorf("identity reservations: identity for %d occupied by local ID %d", e.LocalID, m.ID)
			}
		}
	}
	return r, nil
}

func Validate(c *catalog.Catalog) error { _, err := Read(c); return err }

// Match never falls back to source number alone. A changed tuple is an error,
// not permission to reuse its ID or allocate another ID for the same identity.
func (r *Reservations) Match(provider, sourceID, identity string) (int, error) {
	if r == nil {
		return 0, nil
	}
	for _, e := range r.Entries {
		if e.Provider == provider && (e.SourceID == sourceID || e.Identity == identity) {
			if e.SourceID != sourceID || e.Identity != identity {
				return 0, fmt.Errorf("identity reservations: source tuple changed for local ID %d", e.LocalID)
			}
			return e.LocalID, nil
		}
	}
	return 0, nil
}

func (r *Reservations) MaxID() int {
	max := 0
	if r != nil {
		for _, e := range r.Entries {
			if e.LocalID > max {
				max = e.LocalID
			}
		}
	}
	return max
}
