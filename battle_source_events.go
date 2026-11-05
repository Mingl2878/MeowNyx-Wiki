package main

// The source archive is independent of normalized battle facts. Only explicitly
// received/scanned RKPP JSON enters it; construction and GET never open writable
// storage, migrate a schema, inspect an archive path, or reconstruct old records.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	battleSourceDDL        = `CREATE TABLE battle_source_events (position INTEGER PRIMARY KEY, frame_hash TEXT NOT NULL UNIQUE CHECK(length(frame_hash)=64), raw_frame BLOB NOT NULL CHECK(typeof(raw_frame)='blob' AND length(raw_frame)>0 AND length(raw_frame)<=1048576))`
	battleSourceStateDDL   = `CREATE TABLE battle_source_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), warnings INTEGER NOT NULL CHECK(warnings>=0 AND warnings<=15))`
	battleSourcePrivate    = 1
	battleSourceInvalid    = 2
	battleSourceLimit      = 4
	battleSourceFailed     = 8
	battleSourceFrameLimit = 1 << 20
)

var (
	errBattleSourceStore  = errors.New("原事件归档未完整保存，请检查存储后重试核对；已有战报不会被清空。")
	errBattleSourceExport = errors.New("无法完整、安全地导出原事件，请检查存储后重试；未导出部分内容冒充全部。")
	errBattleSourceQuota  = errors.New("原事件超过 10000 条或 64 MiB 归档预算，未完整归档；已有战报仍按原规则导入。")
)

type BattleSourceStatus struct {
	Available bool     `json:"available"`
	Count     int      `json:"count"`
	Bytes     int64    `json:"bytes"`
	Complete  bool     `json:"complete"`
	Issues    []string `json:"issues"`
}

func battleSourceIssues(warnings int) []string {
	issues := []string{"仅导出已保留的 RKPP 对战源事件；历史战报没有原事件时无法逆向恢复，需另行手动扫描采集记录。"}
	for _, item := range []struct {
		bit     int
		message string
	}{
		{battleSourcePrivate, "含密钥、密码、认证 token/cookie 或原包字段的源帧未归档；导出不包含这些帧，不能视为全部采集事件。"},
		{battleSourceInvalid, "部分源帧格式无效或不受支持，未归档；导出覆盖不完整。"},
		{battleSourceLimit, errBattleSourceQuota.Error()},
		{battleSourceFailed, errBattleSourceStore.Error()},
	} {
		if warnings&item.bit != 0 {
			issues = append(issues, item.message)
		}
	}
	return issues
}

// Validate without re-encoding. Decoder.UseNumber in battleReadJSON keeps every
// numeric lexeme, including uint64 IDs, intact. The returned bytes are owned and
// captured BEFORE Push converts anything; accepted=false/error never archives.
func battlePrepareSourceFrame(data []byte) ([]byte, int) {
	if len(data) == 0 || len(bytes.TrimSpace(data)) == 0 {
		return nil, 0
	}
	if len(data) > battleSourceFrameLimit {
		return nil, battleSourceLimit
	}
	if !utf8.Valid(data) || !json.Valid(data) {
		return nil, battleSourceInvalid
	}
	v, err := battleReadJSON(data)
	if err != nil {
		return nil, battleSourceInvalid
	}
	obj := battleObject(v)
	if obj == nil {
		return nil, 0
	}
	if battleSourceCanonical(obj) {
		return nil, 0
	}
	_, body, recognized, err := battleLiveEnvelope(obj)
	if !recognized {
		return nil, 0
	} // heartbeat, wire-key and non-battle messages
	if err != nil {
		return nil, battleSourceInvalid
	}
	if battleSourceCanonical(body) {
		return nil, battleSourceInvalid
	}
	budget := 1000000
	if !battleSourceSafe(v, 0, &budget) {
		return nil, battleSourcePrivate
	}
	return append([]byte(nil), data...), 0
}

func battleSourceCanonical(obj map[string]any) bool {
	if obj == nil {
		return false
	}
	if _, exists := obj["records"]; exists {
		return true
	}
	_, id := obj["id"]
	_, sides := obj["sides"]
	_, events := obj["events"]
	_, version := obj["version"]
	return id && (sides || events || version)
}

func battleSourceProtectedKey(key string) bool {
	key = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, key)
	// Explicitly authorized protocol account/profile/flow metadata is retained.
	// Authentication material, passwords, keys and raw captures remain excluded.
	for _, part := range []string{"privatekey", "secret", "password", "passwd", "credential", "authtoken", "authkey", "authsecret", "authenticationtoken", "authenticationkey", "sessiontoken", "accesstoken", "refreshtoken", "wirekey", "aeskey", "decryptkey", "decryptionkey", "sessionkey", "cookie", "pcap", "rawpacket", "packetbytes"} {
		if strings.Contains(key, part) {
			return true
		}
	}
	switch key {
	case "key", "keys", "token", "authorization", "proxyauthorization":
		return true
	}
	return false
}

// All fields, including unknown extras and JSON embedded in string content, are
// checked. Never redact/rebuild a frame: protected input is rejected as a whole.
func battleSourceSafe(v any, depth int, budget *int) bool {
	*budget--
	if depth > 48 || *budget < 0 {
		return false
	}
	switch value := v.(type) {
	case map[string]any:
		for key, child := range value {
			if battleSourceProtectedKey(key) || !battleSourceSafe(child, depth+1, budget) {
				return false
			}
		}
	case []any:
		for _, child := range value {
			if !battleSourceSafe(child, depth+1, budget) {
				return false
			}
		}
	case string:
		upper := strings.ToUpper(value)
		if strings.Contains(upper, "PRIVATE KEY-----") || strings.HasPrefix(upper, "BEARER ") {
			return false
		}
		text := strings.TrimSpace(value)
		if (strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[")) && json.Valid([]byte(text)) {
			embedded, err := battleReadJSON([]byte(text))
			if err != nil || !battleSourceSafe(embedded, depth+1, budget) {
				return false
			}
		}
	}
	return true
}

func (s *BattleService) sourceWarn(warnings int) {
	if warnings == 0 {
		return
	}
	s.mu.Lock()
	s.sourceWarnings |= warnings
	s.mu.Unlock()
}

func battleScanRetainSource(acc *scanAccumulator, frame []byte) {
	if acc.sourceSeen == nil {
		acc.sourceSeen = map[[32]byte]bool{}
	}
	hash := sha256.Sum256(frame)
	if acc.sourceSeen[hash] {
		return
	}
	if len(acc.sourceFrames) >= battleSnapshotRecords || len(frame) > battleSnapshotLimit-acc.sourceBytes {
		acc.sourceWarnings |= battleSourceLimit
		return
	}
	acc.sourceSeen[hash] = true
	acc.sourceFrames = append(acc.sourceFrames, frame)
	acc.sourceBytes += len(frame)
}

// Archive failure is visible, but never stops/rewrites the existing normalized
// assembler/import path or changes its coverage. Only fixed diagnostics survive.
func (s *BattleService) retainRelaySource(ctx context.Context, frame []byte, warning int, accepted bool) {
	s.sourceWarn(warning)
	var err error
	if accepted && frame != nil {
		err = s.appendSourceFrames(ctx, [][]byte{frame})
	} else if warning != 0 {
		err = s.appendSourceFrames(ctx, nil)
	}
	if err != nil {
		if errors.Is(err, errBattleSourceQuota) {
			warning |= battleSourceLimit
		} else {
			warning |= battleSourceFailed
		}
	}
	if warning == 0 {
		return
	}
	s.relayMu.Lock()
	defer s.relayMu.Unlock()
	if err != nil {
		s.relay.Error = errBattleSourceStore.Error()
	}
	for _, issue := range battleSourceIssues(warning)[1:] {
		found := false
		for _, old := range s.relay.Issues {
			if old == issue {
				found = true
				break
			}
		}
		if !found {
			s.relay.Issues = append(s.relay.Issues, issue)
		}
	}
}

// Exact auxiliary DDL, including constraints, plus no unexpected triggers or
// indexes on either table. A malformed table never gets repaired or overwritten.
func battleSourceSchema(ctx context.Context, tx *sql.Tx, create bool) (bool, error) {
	missing := 0
	for _, item := range []struct{ name, ddl string }{{"battle_source_events", battleSourceDDL}, {"battle_source_state", battleSourceStateDDL}} {
		var typ, ddl string
		err := tx.QueryRowContext(ctx, "SELECT type,sql FROM sqlite_master WHERE name=?", item.name).Scan(&typ, &ddl)
		if errors.Is(err, sql.ErrNoRows) {
			missing++
		} else if err != nil || typ != "table" || ddl != item.ddl {
			return false, errBattleSourceExport
		}
	}
	if missing == 2 {
		if !create {
			return false, nil
		}
		for _, ddl := range []string{battleSourceDDL, battleSourceStateDDL} {
			if _, err := tx.ExecContext(ctx, ddl); err != nil {
				return false, errBattleSourceStore
			}
		}
	} else if missing != 0 {
		return false, errBattleSourceExport
	}
	var extra int
	if tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE tbl_name IN ('battle_source_events','battle_source_state') AND type!='table' AND name NOT LIKE 'sqlite_%'").Scan(&extra) != nil || extra != 0 {
		return false, errBattleSourceExport
	}
	return true, nil
}

// One explicit receiver/scan append owns one transaction. Quotas apply to the
// entire archive, not an arbitrarily truncated export. Exact full-frame hashing
// deduplicates replays but preserves changed event IDs/times and safe extras.
func (s *BattleService) appendSourceFrames(ctx context.Context, frames [][]byte) error {
	// Preserve rejection diagnostics across receiver restarts, but never create
	// a DB/source table for rejected-only input. This precheck is read-only.
	if len(frames) == 0 {
		s.mu.Lock()
		unopened := s.db == nil
		s.mu.Unlock()
		if unopened {
			db, tx, _, err := s.sourceReadSnapshot(ctx)
			if err != nil {
				s.sourceWarn(battleSourceFailed)
				return errBattleSourceStore
			}
			if tx == nil {
				return nil
			}
			var exists int
			err = tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='battle_source_events'").Scan(&exists)
			tx.Rollback()
			db.Close()
			if err != nil {
				s.sourceWarn(battleSourceFailed)
				return errBattleSourceStore
			}
			if exists == 0 {
				return nil
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	fail := func(err error) error { s.sourceWarnings |= battleSourceFailed; return err }
	if err := s.openLocked(ctx); err != nil {
		return fail(errBattleSourceStore)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fail(errBattleSourceStore)
	}
	defer tx.Rollback()
	exists, err := battleSourceSchema(ctx, tx, len(frames) > 0)
	if err != nil {
		return fail(errBattleSourceStore)
	}
	if !exists {
		return nil
	}
	var count, position int
	var size int64
	if tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(length(raw_frame)),0),coalesce(max(position),0) FROM battle_source_events").Scan(&count, &size, &position) != nil {
		return fail(errBattleSourceStore)
	}
	if count > battleSnapshotRecords || size > battleSnapshotLimit || position < 0 {
		return fail(errBattleSourceStore)
	}
	quota := false
	for _, frame := range frames {
		candidate, warning := battlePrepareSourceFrame(frame)
		if candidate == nil || warning != 0 {
			return fail(errBattleSourceStore)
		}
		hash := sha256.Sum256(frame)
		key := hex.EncodeToString(hash[:])
		var same bool
		err := tx.QueryRowContext(ctx, "SELECT raw_frame=? FROM battle_source_events WHERE frame_hash=?", frame, key).Scan(&same)
		if err == nil {
			if !same {
				return fail(errBattleSourceStore)
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fail(errBattleSourceStore)
		}
		if count >= battleSnapshotRecords || int64(len(frame)) > battleSnapshotLimit-size {
			quota = true
			continue
		}
		position++
		if position <= 0 {
			return fail(errBattleSourceStore)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO battle_source_events(position,frame_hash,raw_frame) VALUES(?,?,?)", position, key, frame); err != nil {
			return fail(errBattleSourceStore)
		}
		count++
		size += int64(len(frame))
	}
	warnings := s.sourceWarnings
	if quota {
		warnings |= battleSourceLimit
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO battle_source_state(singleton,warnings) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET warnings=warnings|excluded.warnings", warnings); err != nil {
		return fail(errBattleSourceStore)
	}
	if err := tx.Commit(); err != nil {
		return fail(errBattleSourceStore)
	}
	s.sourceWarnings = warnings
	if quota {
		return errBattleSourceQuota
	}
	return nil
}

// Never use s.db/openLocked here: that connection has an immediate write-lock
// policy and its lazy opener can create/migrate core state. mode=ro guarantees
// these GETs cannot create a missing DB or even the schema-1 rule marker.
func (s *BattleService) sourceReadSnapshot(ctx context.Context) (*sql.DB, *sql.Tx, BattleSourceStatus, error) {
	s.mu.Lock()
	path, warnings, closed, initErr := s.path, s.sourceWarnings, s.closed, s.initErr
	s.mu.Unlock()
	status := BattleSourceStatus{Complete: true, Issues: battleSourceIssues(warnings)}
	if closed || initErr != nil {
		return nil, nil, status, errBattleSourceExport
	}
	info, err := os.Stat(path)
	if os.IsNotExist(err) {
		return nil, nil, status, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil, status, errBattleSourceExport
	}
	uriPath := filepath.ToSlash(path)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := &url.URL{Scheme: "file", Path: uriPath}
	q := u.Query()
	q.Set("mode", "ro")
	q.Set("_pragma", "busy_timeout(1000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, nil, status, errBattleSourceExport
	}
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		db.Close()
		return nil, nil, status, errBattleSourceExport
	}
	fail := func() (*sql.DB, *sql.Tx, BattleSourceStatus, error) {
		tx.Rollback()
		db.Close()
		return nil, nil, status, errBattleSourceExport
	}
	var version, appID int
	if tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version) != nil || tx.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID) != nil || version != battleSchemaVersion || appID != battleApplicationID {
		return fail()
	}
	for _, ddl := range battleSchemaDDL {
		var found int
		if tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE sql=?", ddl).Scan(&found) != nil || found != 1 {
			return fail()
		}
	}
	exists, err := battleSourceSchema(ctx, tx, false)
	if err != nil {
		return fail()
	}
	if exists {
		if tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(length(raw_frame)),0) FROM battle_source_events").Scan(&status.Count, &status.Bytes) != nil {
			return fail()
		}
		var stored int
		err := tx.QueryRowContext(ctx, "SELECT warnings FROM battle_source_state WHERE singleton=1").Scan(&stored)
		if err != nil && !errors.Is(err, sql.ErrNoRows) || stored < 0 || stored > 15 {
			return fail()
		}
		warnings |= stored
		status.Issues = battleSourceIssues(warnings)
		status.Available = status.Count > 0
	}
	return db, tx, status, nil
}

func (s *BattleService) SourceStatus(ctx context.Context) (BattleSourceStatus, error) {
	db, tx, status, err := s.sourceReadSnapshot(ctx)
	if tx != nil {
		defer db.Close()
		defer tx.Rollback()
	}
	if err != nil {
		return status, err
	}
	if status.Count > battleSnapshotRecords || status.Bytes > battleSnapshotLimit {
		status.Complete = false
		status.Issues = battleSourceIssues(battleSourceLimit)
	}
	return status, nil
}

// Preflight all rows before HTTP headers, one bounded frame at a time. Corrupt
// private/invalid/oversized stored rows fail the WHOLE export, never silently skip.
func battleSourceCheckRows(ctx context.Context, tx *sql.Tx, status BattleSourceStatus) error {
	if status.Count == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT position,frame_hash,CASE WHEN length(raw_frame)<=? THEN raw_frame ELSE NULL END FROM battle_source_events ORDER BY position", battleSourceFrameLimit)
	if err != nil {
		return errBattleSourceExport
	}
	defer rows.Close()
	count, previous := 0, 0
	var size int64
	for rows.Next() {
		var position int
		var key string
		var frame []byte
		if rows.Scan(&position, &key, &frame) != nil || position <= previous {
			return errBattleSourceExport
		}
		previous = position
		candidate, warning := battlePrepareSourceFrame(frame)
		hash := sha256.Sum256(frame)
		if candidate == nil || warning != 0 || key != hex.EncodeToString(hash[:]) {
			return errBattleSourceExport
		}
		count++
		size += int64(len(frame))
		if count > battleSnapshotRecords || size > battleSnapshotLimit {
			return errBattleSourceExport
		}
	}
	if rows.Err() != nil || count != status.Count || size != status.Bytes {
		return errBattleSourceExport
	}
	return nil
}

func battleSourceWrite(ctx context.Context, tx *sql.Tx, status BattleSourceStatus, writer io.Writer, format string) error {
	write := func(data []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n != len(data) {
			return io.ErrShortWrite
		}
		return nil
	}
	if format == "json" {
		if err := write([]byte("[")); err != nil {
			return err
		}
	}
	if status.Count > 0 {
		rows, err := tx.QueryContext(ctx, "SELECT raw_frame FROM battle_source_events ORDER BY position")
		if err != nil {
			return errBattleSourceExport
		}
		defer rows.Close()
		first := true
		for rows.Next() {
			var frame []byte
			if rows.Scan(&frame) != nil {
				return errBattleSourceExport
			}
			if format == "json" {
				if !first {
					if err := write([]byte(",")); err != nil {
						return err
					}
				}
			} else {
				// Original single-line bytes are untouched. Multi-line JSON only
				// loses insignificant outer whitespace, not string/number lexemes.
				if bytes.ContainsAny(frame, "\r\n") {
					var compact bytes.Buffer
					if json.Compact(&compact, frame) != nil {
						return errBattleSourceExport
					}
					frame = compact.Bytes()
				}
			}
			if err := write(frame); err != nil {
				return err
			}
			if format == "ndjson" {
				if err := write([]byte("\n")); err != nil {
					return err
				}
			}
			first = false
		}
		if rows.Err() != nil {
			return errBattleSourceExport
		}
	}
	if format == "json" {
		return write([]byte("]\n"))
	}
	return nil
}

func battleSourceHTTPError(w http.ResponseWriter, err error) {
	code, message := 503, errBattleSourceExport.Error()
	if errors.Is(err, errBattleSourceQuota) {
		code, message = 413, "原事件快照超过 10000 条或 64 MiB 导出预算，未导出；请核对归档，不能将截断内容视为全部。"
	}
	battleJSON(w, code, map[string]string{"error": message})
}

func (s *BattleService) serveSourceHTTP(w http.ResponseWriter, r *http.Request, ctx context.Context, path string) {
	if path == "source/status" {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			battleJSON(w, 400, map[string]string{"error": "原事件状态接口不接受查询参数。"})
			return
		}
		status, err := s.SourceStatus(ctx)
		if err != nil {
			battleSourceHTTPError(w, err)
			return
		}
		battleJSON(w, 200, status)
		return
	}
	values, err := url.ParseQuery(r.URL.RawQuery)
	format := values.Get("format")
	if err != nil || len(values) != 1 || len(values["format"]) != 1 || format != "json" && format != "ndjson" {
		battleJSON(w, 400, map[string]string{"error": "请只提供一个 format=json 或 format=ndjson 参数；不接受路径、文件名或筛选条件。"})
		return
	}
	db, tx, status, err := s.sourceReadSnapshot(ctx)
	if tx != nil {
		defer db.Close()
		defer tx.Rollback()
	}
	if err != nil {
		battleSourceHTTPError(w, err)
		return
	}
	if status.Count > battleSnapshotRecords || status.Bytes > battleSnapshotLimit {
		battleSourceHTTPError(w, errBattleSourceQuota)
		return
	}
	if tx != nil {
		if err := battleSourceCheckRows(ctx, tx, status); err != nil {
			battleSourceHTTPError(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if format == "ndjson" {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	}
	w.Header().Set("Content-Disposition", `attachment; filename="battle-source-events.`+format+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Source-Event-Count", strconv.Itoa(status.Count))
	w.Header().Set("X-Source-Complete", strconv.FormatBool(status.Complete))
	w.Header().Set("X-Battle-Source-Count", strconv.Itoa(status.Count))
	w.Header().Set("X-Battle-Source-Bytes", strconv.FormatInt(status.Bytes, 10))
	w.Header().Set("X-Battle-Source-Complete", strconv.FormatBool(status.Complete))
	if len(status.Issues) > 1 {
		w.Header().Set("X-Battle-Source-Warning", "Archive coverage is incomplete; consult /api/battles/source/status.")
	}
	// A cancelled/slow writer must not pin the SQLite snapshot indefinitely.
	rc := http.NewResponseController(w)
	if deadline, ok := ctx.Deadline(); ok {
		_ = rc.SetWriteDeadline(deadline)
	}
	defer rc.SetWriteDeadline(time.Time{})
	w.WriteHeader(http.StatusOK)
	if err := battleSourceWrite(ctx, tx, status, w, format); err != nil {
		// Do not append an error object to a half-written JSON/NDJSON download.
		// Abort the transport so clients cannot mistake a partial body for success.
		panic(http.ErrAbortHandler)
	}
}
