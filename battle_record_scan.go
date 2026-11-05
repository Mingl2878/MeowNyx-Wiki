package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Archive access exists only behind explicit ScanArchive/POST calls. These are
// budgets, not background intervals. No watcher, startup scan or path fallback.
const (
	scanArchiveName = "opencode_summary.csv"
	scanTokenHeader = "X-Battle-Scan-Token"
	scanSettingsDDL = `CREATE TABLE battle_scan_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), path TEXT NOT NULL)`
)

var (
	errScanPath  = errors.New("请选择本机绝对路径下的 opencode_summary.csv、单次运行目录、runs 目录或 RKPP 根目录；不允许链接或其他文件。")
	errScanLimit = errors.New("扫描超过文件、大小、行数或时间预算；请改选单次运行目录或较小的汇总文件。")
	errScanRead  = errors.New("无法安全读取所选汇总文件，请检查文件权限和 CSV 格式后重试。")
	errScanBusy  = errors.New("已有扫描正在进行，请等待完成后重试。")
	errScanStore = errors.New("扫描结果或路径未完整保存，请检查存储后重试核对；已有战报不会被清空。")
)

type BattleScanResult struct {
	Path      string   `json:"path"`
	Files     int      `json:"files"`
	Completed int      `json:"completed"`
	Imported  int      `json:"imported"` // newly inserted IDs, not updates
	Updated   int      `json:"updated"`
	Unchanged int      `json:"unchanged"`
	Pending   int      `json:"pending"` // unfinished battles at each file's bounded EOF
	Ignored   int      `json:"ignored"`
	Issues    []string `json:"issues"`
	Error     string   `json:"error,omitempty"` // partial source-store failure; facts may already be saved
}

type scanLimits struct {
	files    int
	entries  int
	bytes    int64
	rows     int
	rowBytes int64
	budget   time.Duration
}

func scanDefaultLimits() scanLimits {
	return scanLimits{files: 256, entries: 4096, bytes: 128 << 20, rows: 250000, rowBytes: 8 << 20, budget: 15 * time.Second}
}

func scanAddIssue(result *BattleScanResult, message string) {
	for _, old := range result.Issues {
		if old == message {
			return
		}
	}
	if len(result.Issues) < 8 {
		result.Issues = append(result.Issues, message)
	}
}

func scanInputPath(data []byte) (string, bool) {
	// A token-level shape check rejects duplicate keys and null, unlike decoding
	// into a string field. The archive's JSON numbers never pass this guard.
	d := json.NewDecoder(bytes.NewReader(data))
	t, err := d.Token()
	if err != nil || t != json.Delim('{') {
		return "", false
	}
	t, err = d.Token()
	if err != nil || t != "path" {
		return "", false
	}
	t, err = d.Token()
	path, ok := t.(string)
	if err != nil || !ok || path == "" {
		return "", false
	}
	t, err = d.Token()
	if err != nil || t != json.Delim('}') {
		return "", false
	}
	_, err = d.Token()
	return path, err == io.EOF
}

func scanCleanPath(path string) (string, error) {
	if path == "" || len(path) > 4096 || !utf8.ValidString(path) || strings.TrimSpace(path) != path || strings.IndexFunc(path, unicode.IsControl) >= 0 || !filepath.IsAbs(path) {
		return "", errScanPath
	}
	// Reject UNC/device paths, alternate streams, traversal, and Windows alias
	// spellings even when this code is being tested on another operating system.
	slashes := strings.ReplaceAll(path, "\\", "/")
	if strings.HasPrefix(slashes, "//") {
		return "", errScanPath
	}
	volume := filepath.VolumeName(path)
	rest := strings.TrimPrefix(path, volume)
	if strings.Contains(rest, ":") {
		return "", errScanPath
	}
	for _, part := range strings.Split(strings.ReplaceAll(rest, "\\", "/"), "/") {
		if part == "." || part == ".." || strings.TrimRight(part, " .") != part || scanForbidden(part) {
			return "", errScanPath
		}
	}
	return filepath.Clean(path), nil
}

func scanForbidden(name string) bool {
	switch strings.ToLower(name) {
	case "keys", "decoded_packets", "pcap", "pcaps", "logs":
		return true
	}
	return false
}

// Lstat every component, including the ancestors selected by the user. A safe
// leaf under a symlink/junction parent is not accepted as a local archive path.
func scanSafeInfo(path string) (os.FileInfo, error) {
	var leaf os.FileInfo
	for current := path; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err != nil {
			return nil, err
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 || !info.IsDir() && !info.Mode().IsRegular() {
			return nil, errScanPath
		}
		if leaf == nil {
			leaf = info
		} else if !info.IsDir() {
			return nil, errScanPath
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	return leaf, nil
}

func scanOpen(path string, directory bool) (*os.File, os.FileInfo, error) {
	before, err := scanSafeInfo(path)
	if err != nil || before.IsDir() != directory {
		return nil, nil, errScanPath
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, errScanRead
	}
	after, err := f.Stat()
	checked, checkErr := scanSafeInfo(path)
	if err != nil || checkErr != nil || after.IsDir() != directory || !os.SameFile(before, after) || !os.SameFile(after, checked) {
		f.Close()
		return nil, nil, errScanPath
	}
	return f, after, nil
}

func scanArchiveFiles(ctx context.Context, path string, limits scanLimits) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := scanSafeInfo(path)
	if err != nil {
		return nil, errScanPath
	}
	if !info.IsDir() {
		if filepath.Base(path) != scanArchiveName {
			return nil, errScanPath
		}
		if info.Size() > limits.bytes {
			return nil, errScanLimit
		}
		return []string{path}, nil
	}
	files := []string{}
	var total int64
	add := func(candidate string) (bool, error) {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		info, err := scanSafeInfo(candidate)
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil || !info.Mode().IsRegular() {
			return false, errScanPath
		}
		if len(files) >= limits.files || info.Size() > limits.bytes-total {
			return false, errScanLimit
		}
		total += info.Size()
		files = append(files, candidate)
		return true, nil
	}
	if found, err := add(filepath.Join(path, scanArchiveName)); err != nil || found {
		return files, err // a selected single run never discovers sibling runs
	}
	runs := path
	if filepath.Base(path) != "runs" {
		runs = filepath.Join(path, "runs")
	}
	dir, _, err := scanOpen(runs, true)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	entries := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		batch, readErr := dir.ReadDir(64)
		for _, entry := range batch {
			entries++
			if entries > limits.entries {
				return nil, errScanLimit
			}
			if scanForbidden(entry.Name()) {
				continue
			}
			if entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 {
				return nil, errScanPath
			}
			if !entry.IsDir() {
				continue
			}
			// This is the only descent: root/runs/run/file (depth 2), or
			// runs/run/file (depth 1). Never recursive Walk or global discovery.
			if _, err := add(filepath.Join(runs, entry.Name(), scanArchiveName)); err != nil {
				return nil, err
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return nil, errScanRead
		}
	}
	if len(files) == 0 {
		return nil, errScanPath
	}
	sort.Strings(files)
	return files, nil
}

// Limit source bytes allocated by encoding/csv before Read returns, including a
// malformed multiline row. The allowance is reset per record; bufio read-ahead
// is bounded by its small fixed buffer. Every source read checks cancellation.
type scanBoundReader struct {
	ctx     context.Context
	reader  io.Reader
	read    int64
	ceiling int64
	fault   error // encoding/csv may replace an underlying read error with ErrFieldCount
}

func (r *scanBoundReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		r.fault = err
		return 0, err
	}
	left := r.ceiling - r.read
	if left <= 0 {
		r.fault = errScanLimit
		return 0, errScanLimit
	}
	if int64(len(p)) > left {
		p = p[:left]
	}
	n, err := r.reader.Read(p)
	r.read += int64(n)
	return n, err
}

type scanAccumulator struct {
	result          BattleScanResult
	records         []BattleRecord
	bytes           int64
	rows            int
	normalizedBytes int
	sourceFrames    [][]byte // exact decoded CSV content, captured before Push
	sourceBytes     int
	sourceWarnings  int
	sourceSeen      map[[32]byte]bool
}

func scanReadArchive(ctx context.Context, path string, limits scanLimits, acc *scanAccumulator) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	file, info, err := scanOpen(path, false)
	if err != nil {
		return err
	}
	defer file.Close()
	size := info.Size() // fixed snapshot; an active append is left to the next click
	if size <= 0 {
		return errScanRead
	}
	if size > limits.bytes-acc.bytes {
		return errScanLimit
	}
	acc.bytes += size
	var tail [1]byte
	if _, err := file.ReadAt(tail[:], size-1); err != nil {
		return errScanRead
	}
	terminated := tail[0] == '\n'
	bounded := &scanBoundReader{ctx: ctx, reader: io.NewSectionReader(file, 0, size), ceiling: limits.rowBytes}
	reader := csv.NewReader(bounded)
	reader.FieldsPerRecord = 3
	header, err := reader.Read()
	if bounded.fault != nil {
		return bounded.fault
	}
	if errors.Is(err, errScanLimit) {
		return errScanLimit
	}
	if err != nil || len(header) != 3 {
		return errScanRead
	}
	header[0] = strings.TrimPrefix(header[0], "\ufeff")
	columns := map[string]int{}
	for i, name := range header {
		if name != "opencode" && name != "meaning" && name != "content" {
			return errScanRead
		}
		if _, exists := columns[name]; exists {
			return errScanRead
		}
		columns[name] = i
	}
	assembler := NewBattleStreamAssembler() // never join identities across run files
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		start := reader.InputOffset()
		bounded.ceiling = start + limits.rowBytes
		row, err := reader.Read()
		if bounded.fault != nil {
			return bounded.fault
		}
		if errors.Is(err, errScanLimit) {
			return errScanLimit
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		if err == io.EOF {
			break
		}
		end := reader.InputOffset()
		if end-start > limits.rowBytes {
			return errScanLimit
		}
		// encoding/csv returns a final un-terminated record, and may return a
		// partially decoded row alongside a parse error. Neither is committed.
		if end >= size && (!terminated || err != nil) {
			scanAddIssue(&acc.result, "汇总文件末尾尚未写完，该条记录已留待下次手动扫描。")
			break
		}
		if err != nil {
			return errScanRead
		}
		acc.rows++
		if acc.rows > limits.rows {
			return errScanLimit
		}
		// Marshal only the CSV opcode string, not RawMessage content (Marshal
		// compacts/escapes it). Keep every original content number/string lexeme.
		content := []byte(row[columns["content"]])
		if !json.Valid(content) {
			acc.sourceWarnings |= battleSourceInvalid
			scanAddIssue(&acc.result, "部分汇总行不是有效 JSON，已跳过；未保存原始内容。")
			continue
		}
		opcode, _ := json.Marshal(row[columns["opencode"]])
		frame := append([]byte(`{"opencode":`), opcode...)
		frame = append(frame, []byte(`,"content":`)...)
		frame = append(frame, content...)
		frame = append(frame, '}')
		sourceFrame, sourceWarning := battlePrepareSourceFrame(frame)
		acc.sourceWarnings |= sourceWarning
		records, accepted, err := assembler.Push(frame)
		if err != nil {
			if sourceFrame != nil {
				acc.sourceWarnings |= battleSourceInvalid
			}
			scanAddIssue(&acc.result, "部分战斗帧不受支持或证据无效，已跳过；未保存原始内容。")
			continue
		}
		if !accepted {
			acc.result.Ignored++
		} else if sourceFrame != nil {
			battleScanRetainSource(acc, sourceFrame)
		}
		for _, record := range records {
			data, err := json.Marshal(record)
			if err != nil {
				return errScanRead
			}
			acc.normalizedBytes += len(data) + 1
			if len(data) > battleRecordLimit || acc.normalizedBytes+2 > battleImportLimit || len(acc.records) >= battleBatchLimit {
				return errScanLimit
			}
			acc.records = append(acc.records, record)
			acc.result.Completed++
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Reject truncation/replacement while reading; appending is intentionally OK.
	after, err := file.Stat()
	checked, checkErr := scanSafeInfo(path)
	if err != nil || checkErr != nil || after.Size() < size || !os.SameFile(after, checked) {
		return errScanRead
	}
	acc.result.Files++
	acc.result.Pending += assembler.Pending()
	return nil
}

func (s *BattleService) ScanArchive(ctx context.Context, input string) (BattleScanResult, error) {
	return s.scanArchiveWithLimits(ctx, input, scanDefaultLimits())
}

func (s *BattleService) scanArchiveWithLimits(ctx context.Context, input string, limits scanLimits) (BattleScanResult, error) {
	result := BattleScanResult{Issues: []string{}}
	if !s.scanMu.TryLock() {
		return result, errScanBusy
	}
	defer s.scanMu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, limits.budget)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return result, err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return result, errBattleClosed
	}
	done := make(chan struct{})
	s.scanCancel, s.scanDone = cancel, done
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.scanCancel, s.scanDone = nil, nil
		s.mu.Unlock()
		close(done)
	}()
	path, err := scanCleanPath(input)
	if err != nil {
		return result, err
	}
	files, err := scanArchiveFiles(ctx, path, limits)
	if err != nil {
		return result, err
	}
	acc := scanAccumulator{result: result}
	for _, file := range files {
		if err := scanReadArchive(ctx, file, limits, &acc); err != nil {
			return result, err
		}
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	// Both completed normalized facts and safe original event frames survive to
	// this point. Budget/cancel/CSV failures cannot commit a half-parsed scan.
	if len(acc.records) != 0 {
		imported, err := s.Import(ctx, acc.records)
		if err != nil {
			if ctx.Err() != nil {
				return result, ctx.Err()
			}
			return result, errScanStore
		}
		acc.result.Imported = imported.Imported - imported.Updated
		acc.result.Updated = imported.Updated
		acc.result.Unchanged = imported.Duplicates
		for _, issue := range imported.Issues {
			scanAddIssue(&acc.result, issue)
		}
	}
	s.sourceWarn(acc.sourceWarnings)
	sourceErr := s.appendSourceFrames(ctx, acc.sourceFrames)
	if sourceErr != nil {
		if errors.Is(sourceErr, errBattleSourceQuota) {
			acc.sourceWarnings |= battleSourceLimit
		} else {
			acc.sourceWarnings |= battleSourceFailed
		}
	}
	for _, issue := range battleSourceIssues(acc.sourceWarnings)[1:] {
		scanAddIssue(&acc.result, issue)
	}
	if err := s.scanStorePath(ctx, path); err != nil {
		if sourceErr != nil || acc.sourceWarnings&battleSourceLimit != 0 {
			acc.result.Error = errBattleSourceStore.Error()
			return acc.result, errBattleSourceStore
		}
		return acc.result, err
	}
	acc.result.Path = path
	if sourceErr != nil || acc.sourceWarnings&battleSourceLimit != 0 {
		acc.result.Error = errBattleSourceStore.Error()
		return acc.result, errBattleSourceStore
	}
	return acc.result, nil
}

// Auxiliary SQLite state is written only after an explicit successful scan. It
// is independent of rule configuration, profiles and canonical data.
func (s *BattleService) scanStorePath(ctx context.Context, path string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.openLocked(ctx); err != nil {
		return errScanStore
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errScanStore
	}
	defer tx.Rollback()
	var ddl string
	err = tx.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE name='battle_scan_state'").Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err = tx.ExecContext(ctx, scanSettingsDDL); err != nil {
			return errScanStore
		}
	} else if err != nil || ddl != scanSettingsDDL {
		return errScanStore
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO battle_scan_state(singleton,path) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET path=excluded.path", path); err != nil {
		return errScanStore
	}
	if err = tx.Commit(); err != nil {
		return errScanStore
	}
	return nil
}

// ScanPath reads the chosen setting only. It neither resolves nor stats the
// archive path. On a fresh service it does not even create the database.
func (s *BattleService) ScanPath(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return "", errBattleClosed
	}
	db := s.db
	if db == nil {
		if _, err := os.Stat(s.path); os.IsNotExist(err) {
			return "", nil
		} else if err != nil {
			return "", errScanStore
		}
		uriPath := filepath.ToSlash(s.path)
		if !strings.HasPrefix(uriPath, "/") {
			uriPath = "/" + uriPath
		}
		u := &url.URL{Scheme: "file", Path: uriPath}
		q := u.Query()
		q.Set("mode", "ro")
		q.Set("_pragma", "busy_timeout(1000)")
		u.RawQuery = q.Encode()
		var err error
		db, err = sql.Open("sqlite", u.String())
		if err != nil {
			return "", errScanStore
		}
		defer db.Close()
		db.SetMaxOpenConns(1)
	}
	var version, appID int
	if db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version) != nil || db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID) != nil || version != battleSchemaVersion || appID != battleApplicationID {
		return "", errScanStore
	}
	var ddl string
	err := db.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE name='battle_scan_state'").Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil || ddl != scanSettingsDDL {
		return "", errScanStore
	}
	var path string
	err = db.QueryRowContext(ctx, "SELECT path FROM battle_scan_state WHERE singleton=1").Scan(&path)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", errScanStore
	}
	if _, err := scanCleanPath(path); err != nil {
		return "", errScanStore
	}
	return path, nil
}

func (s *BattleService) scanSessionToken() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.scanToken == "" {
		var entropy [32]byte
		if _, err := rand.Read(entropy[:]); err != nil {
			return "", errScanStore
		}
		s.scanToken = hex.EncodeToString(entropy[:])
	}
	return s.scanToken, nil
}

func (s *BattleService) scanAuthorized(r *http.Request) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	values := r.Header.Values(scanTokenHeader)
	return len(values) == 1 && len(s.scanToken) == 64 && len(values[0]) == 64 && subtle.ConstantTimeCompare([]byte(values[0]), []byte(s.scanToken)) == 1
}

func scanHTTPError(w http.ResponseWriter, err error) {
	code, message := 500, "扫描未完整完成，请重试核对；已有战报不会被清空。"
	switch {
	case errors.Is(err, errScanPath):
		code, message = 400, errScanPath.Error()
	case errors.Is(err, errScanRead):
		code, message = 400, errScanRead.Error()
	case errors.Is(err, errScanLimit), errors.Is(err, errBattleLimit):
		code, message = 413, errScanLimit.Error()
	case errors.Is(err, errScanBusy):
		code, message = 409, errScanBusy.Error()
	case errors.Is(err, errScanStore):
		code, message = 503, errScanStore.Error()
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code, message = 408, "扫描已取消或超时，请缩小范围后手动重试。"
	case errors.Is(err, errBattleClosed):
		code, message = 503, "战报服务已关闭，未继续扫描。"
	}
	battleJSON(w, code, map[string]string{"error": message})
}

func (s *BattleService) serveScanHTTP(w http.ResponseWriter, r *http.Request, ctx context.Context, body []byte) {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		battleJSON(w, 400, map[string]string{"error": "扫描接口不接受查询参数，请通过请求正文明确选择路径。"})
		return
	}
	if r.Method == http.MethodGet {
		path, err := s.ScanPath(ctx)
		if err != nil {
			scanHTTPError(w, err)
			return
		}
		token, err := s.scanSessionToken()
		if err != nil {
			scanHTTPError(w, err)
			return
		}
		w.Header().Set(scanTokenHeader, token)
		battleJSON(w, 200, map[string]string{"path": path, "scanToken": token})
		return
	}
	path, ok := scanInputPath(body)
	if !ok {
		battleJSON(w, 400, map[string]string{"error": "请只提交一个非空字符串路径字段 path。"})
		return
	}
	result, err := s.ScanArchive(ctx, path)
	if err != nil {
		if errors.Is(err, errBattleSourceStore) {
			// Keep successful fact-import counts visible: source failure is not
			// a rollback of the separately committed existing battle import.
			battleJSON(w, 503, result)
			return
		}
		scanHTTPError(w, err)
		return
	}
	battleJSON(w, 200, result)
}
