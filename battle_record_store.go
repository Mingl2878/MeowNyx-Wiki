package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	_ "modernc.org/sqlite"
)

const (
	battleSchemaVersion   = 1
	battleApplicationID   = 1296974418
	battleImportLimit     = 8 << 20
	battleRecordLimit     = 1 << 20
	battleBatchLimit      = 500
	battleSnapshotLimit   = 64 << 20
	battleSnapshotRecords = 10000
)

var (
	errBattleClosed       = errors.New("battle service is closed")
	errBattleSchema       = errors.New("incompatible battle database schema; preserve the database and use a compatible application")
	errBattleStorage      = errors.New("battle database operation failed; check access and available space, then retry")
	errBattleInvalid      = errors.New("invalid battle data or conflicting record; no changes were saved")
	errBattleNotFound     = errors.New("battle record not found")
	errBattleFilterRule   = errors.New("selected team rule no longer exists; choose another rule or clear the filter")
	errBattleRuleConflict = errors.New("阵容规则已被更新，请重新载入后再保存；当前草稿未提交")
	errBattleLimit        = errors.New("battle data limit exceeded; use a smaller import or narrower query")
)

// BattleService owns only its explicitly supplied independent database. Construction
// and route registration perform no filesystem I/O and never consult user configuration.
type BattleService struct {
	mu             sync.Mutex
	path           string
	db             *sql.DB
	initErr        error
	closed         bool
	relayOp        sync.Mutex
	relayMu        sync.Mutex
	relay          BattleRelayStatus
	relayCancel    context.CancelFunc
	relayDone      chan struct{}
	scanMu         sync.Mutex         // one explicitly requested archive scan at a time
	scanCancel     context.CancelFunc // guarded by mu; Close cancels and joins scans
	scanDone       chan struct{}
	sourceWarnings int                    // fixed source-archive diagnostics, never payload
	scanToken      string                 // per-service HTTP capability; memory only
	requests       chan struct{}          // bounded HTTP admission before bodies/snapshots are allocated
	catalogReader  func() ([]byte, error) // optional current catalog for explicit import/rule/query requests; never a startup/path fallback
}

type BattleImportResult struct {
	Imported   int      `json:"imported"` // all changed records; retained legacy API meaning
	Updated    int      `json:"updated"`  // subset of Imported that enriched an existing ID
	Duplicates int      `json:"duplicates"`
	Issues     []string `json:"issues"`
}

type BattleListResult struct {
	Revision string         `json:"revision,omitempty"`
	Records  []BattleRecord `json:"records"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	PageSize int            `json:"pageSize"`
}

func NewBattleService(dbPath string, optionalReader ...func() ([]byte, error)) (*BattleService, error) {
	if dbPath == "" || !filepath.IsAbs(dbPath) || strings.ContainsAny(dbPath, "\x00\r\n") {
		return nil, errors.New("battle database requires an explicit absolute file path")
	}
	if len(optionalReader) > 1 {
		return nil, errors.New("battle service accepts at most one canonical catalogue reader")
	}
	s := &BattleService{path: filepath.Clean(dbPath), relay: BattleRelayStatus{State: "stopped", Issues: []string{}}, requests: make(chan struct{}, 2)}
	if len(optionalReader) == 1 {
		s.catalogReader = optionalReader[0]
	}
	return s, nil
}

var battleSchemaDDL = []string{
	`CREATE TABLE battles (id TEXT PRIMARY KEY NOT NULL, started_at TEXT NOT NULL, outcome TEXT NOT NULL, record_json TEXT NOT NULL)`,
	`CREATE INDEX battles_time ON battles(started_at DESC, id)`,
	`CREATE INDEX battles_outcome ON battles(outcome, started_at DESC)`,
	`CREATE TABLE battle_rules (id TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL, rule_json TEXT NOT NULL)`,
}

// An auxiliary marker distinguishes never-configured schema-1 databases from an
// explicitly saved empty rule set. Core schema/version remain compatible.
const battleRuleStateDDL = `CREATE TABLE battle_rule_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), configured INTEGER NOT NULL CHECK(configured=1))`

// Caller holds mu. Initialization is transactional; unknown or damaged databases
// are rejected rather than dropped, rewritten or treated as an empty database.
func (s *BattleService) openLocked(ctx context.Context) error {
	if s.closed {
		return errBattleClosed
	}
	if s.initErr != nil {
		return s.initErr
	}
	if s.db != nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return errBattleStorage
	}
	uriPath := filepath.ToSlash(s.path)
	// Windows drive paths need a leading slash in a file URI (file:///C:/...).
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := &url.URL{Scheme: "file", Path: uriPath}
	q := u.Query()
	q.Set("_pragma", "busy_timeout(5000)")
	q.Set("_txlock", "immediate")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return errBattleStorage
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	success := false
	defer func() {
		if !success {
			db.Close()
		}
	}()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return errBattleStorage
	}
	defer tx.Rollback()
	var version, appID int
	if tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version) != nil || tx.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID) != nil {
		return errBattleSchema
	}
	if version == 0 && appID == 0 {
		var count int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").Scan(&count) != nil || count != 0 {
			return errBattleSchema
		}
		for _, ddl := range battleSchemaDDL {
			if _, err = tx.ExecContext(ctx, ddl); err != nil {
				return errBattleStorage
			}
		}
		if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", battleSchemaVersion)); err != nil {
			return errBattleStorage
		}
		if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA application_id=%d", battleApplicationID)); err != nil {
			return errBattleStorage
		}
	} else if version != battleSchemaVersion || appID != battleApplicationID {
		return errBattleSchema
	}
	// Verify the exact schema we authored, including indexes. No guessed migrations.
	for _, ddl := range battleSchemaDDL {
		var found int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE sql = ?", ddl).Scan(&found) != nil || found != 1 {
			return errBattleSchema
		}
	}
	var stateSchema string
	err = tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE name='battle_rule_state'").Scan(&stateSchema)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err = tx.ExecContext(ctx, battleRuleStateDDL); err != nil {
			return errBattleStorage
		}
	} else if err != nil || stateSchema != battleRuleStateDDL {
		return errBattleSchema
	}
	if err = tx.Commit(); err != nil {
		return errBattleStorage
	}
	s.db = db
	success = true
	return nil
}

func (s *BattleService) Close() error {
	s.relayOp.Lock()
	defer s.relayOp.Unlock()
	s.mu.Lock()
	s.closed = true
	scanCancel, scanDone := s.scanCancel, s.scanDone
	s.mu.Unlock()
	if scanCancel != nil {
		scanCancel()
	}
	if scanDone != nil {
		<-scanDone
	}
	s.stopRelayLocked()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		if err := s.db.Close(); err != nil {
			return errBattleStorage
		}
		s.db = nil
	}
	return nil
}

func (s *BattleService) Import(ctx context.Context, records []BattleRecord, expectedExisting ...map[string]string) (BattleImportResult, error) {
	result := BattleImportResult{Issues: []string{}}
	if len(records) == 0 {
		return result, errBattleInvalid
	}
	if len(records) > battleBatchLimit {
		return result, errBattleLimit
	}
	if len(expectedExisting) > 1 {
		return result, errBattleInvalid
	}
	var expected map[string]string
	if len(expectedExisting) == 1 {
		if len(expectedExisting[0]) != len(records) {
			return result, errBattleInvalid
		}
		expected = map[string]string{}
		for _, record := range records {
			hash := expectedExisting[0][record.ID]
			if hash == "" || !battleMappingRevision(hash) || expected[record.ID] != "" {
				return result, errBattleInvalid
			}
			expected[record.ID] = hash
		}
	}
	// Deep-copy only the normalized schema. Never retain caller-owned maps/slices.
	data, err := json.Marshal(records)
	if err != nil {
		return result, errBattleInvalid
	}
	if len(data) > battleImportLimit {
		return result, errBattleLimit
	}
	var incoming []BattleRecord
	if json.Unmarshal(data, &incoming) != nil {
		return result, errBattleInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return result, errBattleClosed
	}
	var identities *battleIdentityMap
	if s.catalogReader != nil {
		data, readErr := s.catalogReader()
		if readErr != nil {
			return result, errBattleMapping
		}
		identities, err = battleReadIdentityMap(data)
		if err != nil {
			return result, err
		}
	}
	if err := s.openLocked(ctx); err != nil {
		return result, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, errBattleStorage
	}
	defer tx.Rollback()
	fail := func(e error) (BattleImportResult, error) { return BattleImportResult{Issues: []string{}}, e }
	for _, record := range incoming {
		if ctx.Err() != nil {
			return fail(ctx.Err())
		}
		var oldJSON string
		err := tx.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id = ?", record.ID).Scan(&oldJSON)
		// An explicit guarded enrichment must match the exact stored bytes in
		// this transaction, not a pre-transaction read or re-encoded projection.
		if expected != nil {
			if errors.Is(err, sql.ErrNoRows) || err == nil && fmt.Sprintf("%x", sha256.Sum256([]byte(oldJSON))) != expected[record.ID] {
				return fail(errBattleInvalid)
			}
		}
		var existing BattleRecord
		if err == nil {
			if len(oldJSON) > battleRecordLimit || json.Unmarshal([]byte(oldJSON), &existing) != nil || ValidateBattleRecord(&existing) != nil {
				return fail(errBattleSchema)
			}
			// Automatic live/archive import must not rewrite older manually enriched
			// sources whose event/instance ID scheme may differ. In particular do not
			// re-map, re-encode or merge the old bytes even when the new capture is rich.
			if record.Source == "rkpp-live-v1" && existing.Source != "rkpp-live-v1" {
				result.Duplicates++
				if len(result.Issues) == 0 {
					result.Issues = append(result.Issues, "已保留同编号的历史来源战报，未覆盖其已有证据。")
				}
				continue
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return fail(errBattleStorage)
		}
		// Every record actually admitted still follows the existing mapping then
		// validation path. A protected old-source ID is skipped before attempting
		// to reconcile a different incoming identity/event scheme.
		if err := identities.apply(&record, false); err != nil {
			return fail(err)
		}
		if err := ValidateBattleRecord(&record); err != nil {
			return fail(errBattleInvalid)
		}
		if oldJSON != "" {
			// Recheck stored declarations against the same snapshot, filling only
			// previously unknown identity and retaining established provenance.
			if err := identities.apply(&existing, true); err != nil {
				return fail(err)
			}
			// Import time describes first admission, not how often the same file was read.
			record.ImportedAt = existing.ImportedAt
			record, err = MergeBattleRecord(existing, record)
			if err != nil {
				return fail(errBattleInvalid)
			}
		} else if record.ImportedAt == "" {
			record.ImportedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if ValidateBattleRecord(&record) != nil {
			return fail(errBattleInvalid)
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			return fail(errBattleInvalid)
		}
		if len(encoded) > battleRecordLimit {
			return fail(errBattleLimit)
		}
		if oldJSON != "" && oldJSON == string(encoded) {
			result.Duplicates++
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO battles(id,started_at,outcome,record_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at,outcome=excluded.outcome,record_json=excluded.record_json`, record.ID, record.StartedAt, record.Outcome, string(encoded)); err != nil {
			return fail(errBattleStorage)
		}
		result.Imported++
		if oldJSON != "" {
			result.Updated++
		}
	}
	if err := tx.Commit(); err != nil {
		return fail(errBattleStorage)
	}
	return result, nil
}

func (s *BattleService) Record(ctx context.Context, id string) (BattleRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var record BattleRecord
	if err := s.openLocked(ctx); err != nil {
		return record, err
	}
	var data string
	err := s.db.QueryRowContext(ctx, "SELECT record_json FROM battles WHERE id=?", id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return record, errBattleNotFound
	}
	if err != nil {
		return record, errBattleStorage
	}
	if len(data) > battleRecordLimit {
		return record, errBattleLimit
	}
	if json.Unmarshal([]byte(data), &record) != nil || ValidateBattleRecord(&record) != nil {
		return BattleRecord{}, errBattleSchema
	}
	return record, nil
}

func readBattleRules(ctx context.Context, tx *sql.Tx) ([]BattleTeamRule, error) {
	rows, err := tx.QueryContext(ctx, "SELECT rule_json FROM battle_rules ORDER BY position,id")
	if err != nil {
		return nil, errBattleStorage
	}
	defer rows.Close()
	rules := []BattleTeamRule{}
	for rows.Next() {
		var data string
		var rule BattleTeamRule
		if rows.Scan(&data) != nil || len(data) > 16384 || json.Unmarshal([]byte(data), &rule) != nil {
			return nil, errBattleSchema
		}
		rules = append(rules, rule)
		if len(rules) > 100 {
			return nil, errBattleSchema
		}
	}
	if rows.Err() != nil {
		return nil, errBattleStorage
	}
	if _, err := normalizeBattleRules(rules); err != nil {
		return nil, errBattleSchema
	}
	if err := rows.Close(); err != nil {
		return nil, errBattleStorage
	}
	if len(rules) == 0 {
		var configured int
		err := tx.QueryRowContext(ctx, "SELECT configured FROM battle_rule_state WHERE singleton=1").Scan(&configured)
		if errors.Is(err, sql.ErrNoRows) {
			return defaultBattleRules()
		}
		if err != nil {
			return nil, errBattleStorage
		}
		if configured != 1 {
			return nil, errBattleSchema
		}
	}
	return rules, nil
}

func normalizeBattleRules(rules []BattleTeamRule) ([]BattleTeamRule, error) {
	if len(rules) > 100 {
		return nil, errBattleLimit
	}
	out := make([]BattleTeamRule, 0, len(rules))
	ids := map[string]bool{}
	for _, rule := range rules {
		if rule.ID != strings.TrimSpace(rule.ID) {
			return nil, errBattleInvalid
		}
		rule.Name = strings.TrimSpace(rule.Name)
		if !battleSafeToken(rule.ID, 80) || rule.ID == "__other__" || rule.Name == "" || len(rule.Name) > 160 || strings.IndexFunc(rule.Name, unicode.IsControl) >= 0 || ids[rule.ID] || len(rule.MonsterIDs) == 0 && len(rule.AnyOf) == 0 || len(rule.MonsterIDs) > 24 || len(rule.ExcludedMonsterIDs) > 24 || len(rule.AnyOf) > 24 {
			return nil, errBattleInvalid
		}
		ids[rule.ID] = true
		seen := map[int]bool{}
		pets := []int{}
		for _, id := range rule.MonsterIDs {
			if id <= 0 || id > 1000000000 {
				return nil, errBattleInvalid
			}
			if !seen[id] {
				pets = append(pets, id)
				seen[id] = true
			}
		}
		rule.MonsterIDs = pets
		excluded := []int{}
		excludedSeen := map[int]bool{}
		for _, id := range rule.ExcludedMonsterIDs {
			if id <= 0 || id > 1000000000 || seen[id] {
				return nil, errBattleInvalid
			}
			if !excludedSeen[id] {
				excluded = append(excluded, id)
				excludedSeen[id] = true
			}
		}
		rule.ExcludedMonsterIDs = excluded
		rule.AnyOf = battleCloneRuleGroups(rule.AnyOf)
		for i, group := range rule.AnyOf {
			if len(group) == 0 || len(group) > 24 {
				return nil, errBattleInvalid
			}
			groupSeen := map[int]bool{}
			cleanGroup := []int{}
			for _, id := range group {
				if id <= 0 || id > 1000000000 {
					return nil, errBattleInvalid
				}
				if !groupSeen[id] {
					cleanGroup = append(cleanGroup, id)
					groupSeen[id] = true
				}
			}
			rule.AnyOf[i] = cleanGroup
		}
		rule.familyMatch = nil
		out = append(out, rule)
	}
	return out, nil
}

func battleSafeToken(s string, max int) bool {
	if s == "" || len(s) > max {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == ':') {
			return false
		}
	}
	return true
}

func (s *BattleService) Rules(ctx context.Context) ([]BattleTeamRule, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(ctx); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, errBattleStorage
	}
	defer tx.Rollback()
	rules, err := readBattleRules(ctx, tx)
	if err != nil {
		return nil, err
	}
	data, err := s.ruleCatalogLocked()
	if err != nil {
		return nil, err
	}
	return battlePrepareRuleFamilies(rules, data)
}

func (s *BattleService) ruleCatalogLocked() ([]byte, error) {
	if s.catalogReader == nil {
		return nil, nil
	}
	data, err := s.catalogReader()
	if err != nil || len(data) == 0 || len(data) > 64<<20 {
		return nil, errBattleMapping
	}
	// The reader may reuse its buffer after returning. Every request retains
	// its own immutable bytes for classification and all downstream projections.
	return append([]byte(nil), data...), nil
}

func battleRulesRevision(rules []BattleTeamRule) string {
	if rules == nil {
		rules = []BattleTeamRule{}
	}
	familyRevision := ""
	for _, rule := range rules {
		if rule.familyMatch != nil {
			familyRevision = rule.familyMatch.revision
			break
		}
	}
	data, _ := json.Marshal(struct {
		Semantics       string
		Defaults        string
		CatalogFamilies string
		Rules           []BattleTeamRule
	}{battleRuleSemanticsVersion, fmt.Sprintf("%x", sha256.Sum256(battleDefaultRulesJSON)), familyRevision, battleRuleSourceInputs(rules)})
	return fmt.Sprintf("%x", sha256.Sum256(data))
}

func (s *BattleService) PutRules(ctx context.Context, rules []BattleTeamRule, expectedRevision ...string) ([]BattleTeamRule, error) {
	if len(expectedRevision) > 1 {
		return nil, errBattleInvalid
	}
	if len(expectedRevision) == 1 {
		if len(expectedRevision[0]) != 64 {
			return nil, errBattleInvalid
		}
		for _, ch := range expectedRevision[0] {
			if !(ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f') {
				return nil, errBattleInvalid
			}
		}
	}
	clean, err := normalizeBattleRules(rules)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(ctx); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, errBattleStorage
	}
	defer tx.Rollback()
	catalogData, err := s.ruleCatalogLocked()
	if err != nil {
		return nil, err
	}
	prepared, err := battlePrepareRuleFamilies(clean, catalogData)
	if err != nil {
		return nil, err
	}
	// Explicit PUT saves the normalized view, never a startup/read migration.
	// Recompile detached saved inputs so the returned CAS hashes exactly what
	// the subsequent GET will load, not the pre-normalization request draft.
	clean = make([]BattleTeamRule, 0, len(prepared))
	for _, rule := range prepared {
		rule.familyMatch = nil
		clean = append(clean, rule)
	}
	prepared, err = battlePrepareRuleFamilies(clean, catalogData)
	if err != nil {
		return nil, err
	}
	if len(expectedRevision) == 1 {
		current, readErr := readBattleRules(ctx, tx)
		if readErr != nil {
			return nil, readErr
		}
		current, readErr = battlePrepareRuleFamilies(current, catalogData)
		if readErr != nil {
			return nil, readErr
		}
		if battleRulesRevision(current) != expectedRevision[0] {
			return nil, errBattleRuleConflict
		}
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM battle_rules"); err != nil {
		return nil, errBattleStorage
	}
	for i, rule := range clean {
		data, _ := json.Marshal(rule)
		if _, err = tx.ExecContext(ctx, "INSERT INTO battle_rules(id,position,rule_json) VALUES(?,?,?)", rule.ID, i, string(data)); err != nil {
			return nil, errBattleStorage
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO battle_rule_state(singleton,configured) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET configured=1"); err != nil {
		return nil, errBattleStorage
	}
	if tx.Commit() != nil {
		return nil, errBattleStorage
	}
	return prepared, nil
}

// Shared filtering snapshot for list AND statistics: never silently truncate.
// SQL uses indexed outcome/coarse UTC-second bounds; the domain applies exact
// semantic timestamps (including nanoseconds) and all other conditions.
func (s *BattleService) snapshotWithCatalog(ctx context.Context, filter BattleFilter, revisionOut ...*string) ([]BattleRecord, []BattleTeamRule, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(ctx); err != nil {
		return nil, nil, nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, nil, nil, errBattleStorage
	}
	defer tx.Rollback()
	rules, err := readBattleRules(ctx, tx)
	if err != nil {
		return nil, nil, nil, err
	}
	catalogData, err := s.ruleCatalogLocked()
	if err != nil {
		return nil, nil, nil, err
	}
	if len(revisionOut) > 0 && revisionOut[0] != nil {
		// Certify the same source snapshot, never a later read. Oversized stores
		// may still serve a narrow filter but must bypass frontend result reuse.
		*revisionOut[0] = ""
		if revision, revisionErr := battleReadRevisionTx(ctx, tx, catalogData); revisionErr == nil {
			*revisionOut[0] = revision
		} else if ctx.Err() != nil {
			return nil, nil, nil, ctx.Err()
		}
	}
	rules, err = battlePrepareRuleFamilies(rules, catalogData)
	if err != nil {
		return nil, nil, nil, err
	}
	if filter.TeamRuleID != "" {
		found := filter.TeamRuleID == "__other__"
		for _, r := range rules {
			found = found || r.ID == filter.TeamRuleID
		}
		if !found {
			return nil, nil, nil, errBattleFilterRule
		}
	}
	query := "SELECT record_json FROM battles"
	args := []any{}
	clauses := []string{}
	if filter.Outcome != "" {
		clauses = append(clauses, "outcome=?")
		args = append(args, filter.Outcome)
	}
	// Persisted timestamps are normalized UTC RFC3339Nano. Omit the suffix
	// from coarse bounds so both whole-second Z and fractional forms survive;
	// MatchBattleRecord performs the exact comparison after this indexed scan.
	if filter.From != "" {
		from, ok := battleFilterTime(filter.From, false)
		if !ok {
			return nil, nil, nil, errBattleInvalid
		}
		clauses = append(clauses, "started_at >= ?")
		args = append(args, from.UTC().Truncate(time.Second).Format("2006-01-02T15:04:05"))
	}
	if filter.To != "" {
		to, ok := battleFilterTime(filter.To, !filter.ToExclusive)
		if !ok {
			return nil, nil, nil, errBattleInvalid
		}
		next := to.UTC().Truncate(time.Second).Add(time.Second)
		if next.Year() <= 9999 {
			clauses = append(clauses, "started_at < ? AND started_at <> ''")
			args = append(args, next.Format("2006-01-02T15:04:05"))
		}
	}
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, nil, errBattleStorage
	}
	defer rows.Close()
	records := []BattleRecord{}
	totalBytes := 0
	for rows.Next() {
		if ctx.Err() != nil {
			return nil, nil, nil, ctx.Err()
		}
		var data string
		var record BattleRecord
		if rows.Scan(&data) != nil {
			return nil, nil, nil, errBattleStorage
		}
		if len(data) > battleRecordLimit {
			return nil, nil, nil, errBattleLimit
		}
		if json.Unmarshal([]byte(data), &record) != nil || ValidateBattleRecord(&record) != nil {
			return nil, nil, nil, errBattleSchema
		}
		if MatchBattleRecord(record, filter, rules) {
			totalBytes += len(data)
			if totalBytes > battleSnapshotLimit || len(records) >= battleSnapshotRecords {
				return nil, nil, nil, errBattleLimit
			}
			records = append(records, record)
		}
	}
	if rows.Err() != nil {
		return nil, nil, nil, errBattleStorage
	}
	sort.Slice(records, func(i, j int) bool {
		a, _ := time.Parse(time.RFC3339Nano, records[i].StartedAt)
		b, _ := time.Parse(time.RFC3339Nano, records[j].StartedAt)
		if a.Equal(b) {
			return records[i].ID < records[j].ID
		}
		return a.After(b)
	})
	return records, rules, catalogData, nil
}

func (s *BattleService) snapshot(ctx context.Context, filter BattleFilter) ([]BattleRecord, []BattleTeamRule, error) {
	records, rules, _, err := s.snapshotWithCatalog(ctx, filter)
	return records, rules, err
}

func (s *BattleService) List(ctx context.Context, filter BattleFilter, page, pageSize int) (BattleListResult, error) {
	result := BattleListResult{Records: []BattleRecord{}, Page: page, PageSize: pageSize}
	if page < 1 || page > 1000000 || pageSize < 1 || pageSize > 100 {
		return result, errors.New("page must be 1..1000000 and pageSize 1..100")
	}
	records, _, _, err := s.snapshotWithCatalog(ctx, filter, &result.Revision)
	if err != nil {
		return result, err
	}
	result.Total = len(records)
	start := (page - 1) * pageSize
	if start >= len(records) {
		return result, nil
	}
	end := start + pageSize
	if end > len(records) {
		end = len(records)
	}
	result.Records = records[start:end]
	for i := range result.Records {
		result.Records[i].Events = nil
		result.Records[i].SpeedObservations = nil
	}
	return result, nil
}

func (s *BattleService) Stats(ctx context.Context, filter BattleFilter) (BattleStats, error) {
	// One owned catalog snapshot governs filtering, inference, growth and both
	// performance projections. Never reread (or swallow a later reader failure)
	// after the family-based cohort has already been selected.
	var revision string
	records, rules, catalogData, err := s.snapshotWithCatalog(ctx, filter, &revision)
	if err != nil {
		return BattleStats{}, err
	}
	viewRecords, inference := PrepareBattleInference(records, catalogData)
	out := BuildBattleStats(viewRecords, rules)
	out.Revision = revision
	out.Inference = inference
	out.Growth = BuildBattleGrowthStats(records, catalogData)
	out.SelfPerformance = BuildBattlePerformance(records, catalogData)
	out.EnemyPerformance = BuildBattleEnemyPerformance(records, catalogData)
	out.Archetypes = BuildBattleArchetypeStats(viewRecords, rules)
	return out, nil
}
