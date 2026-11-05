package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"strconv"
	"sync"
)

// This is a source fingerprint, not a Stats-result cache. Include all data that
// selects or derives results, and bump when Stats interpretation changes. The
// process epoch prevents an old tab from reusing results across a server restart.
const battleReadRevisionSemantics = "battle-statistics-source-snapshot-v1"

var battleReadRevisionProcess struct {
	once  sync.Once
	epoch string
	err   error
}

func battleReadRevisionEpoch() (string, error) {
	battleReadRevisionProcess.once.Do(func() {
		var seed [32]byte
		if _, err := rand.Read(seed[:]); err != nil {
			battleReadRevisionProcess.err = errBattleStorage
			return
		}
		battleReadRevisionProcess.epoch = hex.EncodeToString(seed[:])
	})
	return battleReadRevisionProcess.epoch, battleReadRevisionProcess.err
}

type battleRevisionHasher struct{ hash hash.Hash }

func battleNewRevisionHasher(catalogData []byte, epoch string) *battleRevisionHasher {
	h := &battleRevisionHasher{hash: sha256.New()}
	h.field(battleReadRevisionSemantics)
	h.field(epoch)
	h.field(strconv.Itoa(battleCatalogCacheSemanticsVersion))
	h.field(battleRuleSemanticsVersion)
	h.field(string(battleDefaultRulesJSON))
	catalogSum := sha256.Sum256(catalogData)
	h.field(hex.EncodeToString(catalogSum[:]))
	return h
}

// Length framing prevents concatenation ambiguities, including embedded NULs,
// empty fields and reordered values. Counts alone are never a revision.
func (h *battleRevisionHasher) field(value string) {
	var size [8]byte
	binary.BigEndian.PutUint64(size[:], uint64(len(value)))
	_, _ = h.hash.Write(size[:])
	_, _ = h.hash.Write([]byte(value))
}

func (h *battleRevisionHasher) record(id, startedAt, outcome, raw string) {
	h.field("record")
	for _, value := range []string{id, startedAt, outcome, raw} {
		h.field(value)
	}
}

func (h *battleRevisionHasher) rule(id string, position int, raw string) {
	h.field("rule")
	h.field(id)
	h.field(strconv.Itoa(position))
	h.field(raw)
}

func (h *battleRevisionHasher) configured(configured bool) {
	h.field("configured")
	h.field(strconv.FormatBool(configured))
}

func (h *battleRevisionHasher) revision() string { return hex.EncodeToString(h.hash.Sum(nil)) }

// QueryRevision is an explicitly requested, read-only query. It uses the same
// service lock/lazy database owner and exact catalogue reader as Stats. There is
// no archive scan, relay action, network request, JSON decoding or data write.
// Large stores exceed the existing snapshot budget and should bypass frontend
// reuse rather than treating a failed revision query as proof of freshness.
func (s *BattleService) QueryRevision(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(ctx); err != nil {
		return "", err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return "", errBattleStorage
	}
	defer tx.Rollback()
	catalogData, err := s.ruleCatalogLocked()
	if err != nil {
		return "", err
	}
	if len(catalogData) != 0 {
		if _, err := battleSharedCatalog(catalogData); err != nil {
			return "", errBattleMapping
		}
	}
	return battleReadRevisionTx(ctx, tx, catalogData)
}

// Parent Stats/List integration MUST invoke this within the SAME transaction
// that captures their records/rules, passing the SAME owned catalogue bytes.
// Calling QueryRevision after Stats cannot certify the earlier result (TOCTOU).
// The helper does not acquire s.mu itself and does not commit/close the caller's
// transaction. Record JSON and rule JSON are hashed as stored, never re-marshaled.
func battleReadRevisionTx(ctx context.Context, tx *sql.Tx, catalogData []byte) (string, error) {
	epoch, err := battleReadRevisionEpoch()
	if err != nil {
		return "", err
	}
	h := battleNewRevisionHasher(catalogData, epoch)
	rows, err := tx.QueryContext(ctx, "SELECT id,started_at,outcome,record_json FROM battles ORDER BY id")
	if err != nil {
		return "", errBattleStorage
	}
	count, totalBytes := 0, 0
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			rows.Close()
			return "", err
		}
		var id, startedAt, outcome, raw string
		if rows.Scan(&id, &startedAt, &outcome, &raw) != nil {
			rows.Close()
			return "", errBattleStorage
		}
		count++
		totalBytes += len(raw)
		if len(raw) > battleRecordLimit || totalBytes > battleSnapshotLimit || count > battleSnapshotRecords {
			rows.Close()
			return "", errBattleLimit
		}
		h.record(id, startedAt, outcome, raw)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return "", errBattleStorage
	}
	if err := rows.Close(); err != nil {
		return "", errBattleStorage
	}
	ruleRows, err := tx.QueryContext(ctx, "SELECT id,position,rule_json FROM battle_rules ORDER BY position,id")
	if err != nil {
		return "", errBattleStorage
	}
	count = 0
	for ruleRows.Next() {
		if err := ctx.Err(); err != nil {
			ruleRows.Close()
			return "", err
		}
		var id, raw string
		var position int
		if ruleRows.Scan(&id, &position, &raw) != nil {
			ruleRows.Close()
			return "", errBattleStorage
		}
		count++
		if len(raw) > 16384 || count > 100 {
			ruleRows.Close()
			return "", errBattleSchema
		}
		h.rule(id, position, raw)
	}
	if err := ruleRows.Err(); err != nil {
		ruleRows.Close()
		return "", errBattleStorage
	}
	if err := ruleRows.Close(); err != nil {
		return "", errBattleStorage
	}
	var configured int
	err = tx.QueryRowContext(ctx, "SELECT configured FROM battle_rule_state WHERE singleton=1").Scan(&configured)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", errBattleStorage
	}
	if err == nil && configured != 1 {
		return "", errBattleSchema
	}
	h.configured(err == nil)
	return h.revision(), nil
}
