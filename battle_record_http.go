package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Registration is completely lazy. Defer the returned close function at shutdown
// to cancel a manually opened relay and release SQLite (if it was ever opened).
func RegisterBattleRecordRoutes(mux *http.ServeMux, dbPath string, optionalReader ...func() ([]byte, error)) func() error {
	s, err := NewBattleService(dbPath, optionalReader...)
	if err != nil {
		s = &BattleService{initErr: err, relay: BattleRelayStatus{State: "stopped", Issues: []string{}}}
	}
	s.Register(mux)
	return s.Close
}

func (s *BattleService) Register(mux *http.ServeMux) {
	for _, path := range []string{"list", "record", "import", "stats", "rules", "status", "revision", "scan", "source/export", "source/status", "relay/start", "relay/stop"} {
		mux.HandleFunc("/api/battles/"+path, s.serveBattleHTTP)
	}
}

func battleJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func battleHTTPError(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	message := "battle request failed; no changes were confirmed"
	switch {
	case errors.Is(err, errBattleRuleConflict):
		code = 409
		message = errBattleRuleConflict.Error()
	case errors.Is(err, errBattleNotFound):
		code = 404
		message = errBattleNotFound.Error()
	case errors.Is(err, errBattleFilterRule):
		code = 400
		message = errBattleFilterRule.Error()
	case errors.Is(err, errBattleInvalid):
		code = 400
		message = errBattleInvalid.Error()
	case errors.Is(err, errBattleLimit):
		code = 413
		message = errBattleLimit.Error()
	case errors.Is(err, errBattleSchema):
		code = 409
		message = errBattleSchema.Error()
	case errors.Is(err, errBattleClosed):
		code = 503
		message = errBattleClosed.Error()
	case errors.Is(err, errBattleMapping):
		code = 409
		message = errBattleMapping.Error()
	case errors.Is(err, errBattleStorage):
		code = 503
		message = errBattleStorage.Error()
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = 408
		message = "battle request timed out or was cancelled; retry to verify the result"
	}
	battleJSON(w, code, map[string]string{"error": message})
}

func battleLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Zone() == "" && ip.Unmap().IsLoopback()
}

func battleAuthority(authority string) bool {
	host := authority
	if h, p, err := net.SplitHostPort(authority); err == nil {
		port, e := strconv.Atoi(p)
		if e != nil || port < 1 || port > 65535 {
			return false
		}
		host = h
	} else if strings.HasPrefix(authority, "[") && strings.HasSuffix(authority, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(authority, "["), "]")
	} else if strings.Contains(authority, ":") {
		return false
	}
	return battleLoopbackHost(host)
}

// No CORS opt-in. Exact same-origin browser mutations, and loopback Host checks
// even for Origin-less local tools (prevents DNS-rebinding through a hostile Host).
func battleRequestAllowed(r *http.Request) bool {
	if !battleAuthority(r.Host) {
		return false
	}
	if r.RemoteAddr != "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil || !battleLoopbackHost(host) {
			return false
		}
	}
	site := r.Header.Get("Sec-Fetch-Site")
	if site != "" && site != "same-origin" && site != "none" {
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 || origins[0] == "null" {
		return false
	}
	origin, err := url.Parse(origins[0])
	if err != nil || origin.User != nil || origin.RawQuery != "" || origin.ForceQuery || strings.Contains(origins[0], "#") || origin.Fragment != "" || origin.Path != "" || origin.Opaque != "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return origin.Scheme == scheme && strings.EqualFold(origin.Host, r.Host)
}

func battleReadBody(w http.ResponseWriter, r *http.Request, limit int64, ndjson bool) ([]byte, error) {
	typ, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (typ != "application/json" && !(ndjson && typ == "application/x-ndjson")) {
		return nil, errors.New("content-type")
	}
	if charset := params["charset"]; charset != "" && !strings.EqualFold(charset, "utf-8") {
		return nil, errors.New("content-type")
	}
	if enc := r.Header.Get("Content-Encoding"); enc != "" && enc != "identity" {
		return nil, errors.New("content-type")
	}
	if r.ContentLength > limit {
		return nil, errBattleLimit
	}
	// A socket deadline, not an abandoned goroutine racing ReadAll. Supported by
	// the application's net/http server; no goroutine is created for slow bodies.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(15 * time.Second))
	defer rc.SetReadDeadline(time.Time{})
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	defer r.Body.Close()
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var large *http.MaxBytesError
		if errors.As(err, &large) {
			return nil, errBattleLimit
		}
		return nil, context.DeadlineExceeded
	}
	return data, nil
}

func battleStrictJSON(data []byte, v any) bool {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return false
	}
	var extra any
	return d.Decode(&extra) == io.EOF
}

func (s *BattleService) serveBattleHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/battles/")
	if !battleRequestAllowed(r) {
		message := "battle endpoints require a loopback, same-origin request"
		if path == "scan" {
			message = "扫描只接受本机同源请求。"
		}
		battleJSON(w, 403, map[string]string{"error": message})
		return
	}
	methods := "GET"
	if path == "import" || path == "relay/start" || path == "relay/stop" {
		methods = "POST"
	}
	if path == "rules" {
		methods = "GET, PUT"
	}
	if path == "scan" {
		methods = "GET, POST"
	}
	if !(r.Method == methods || path == "rules" && (r.Method == "GET" || r.Method == "PUT") || path == "scan" && (r.Method == "GET" || r.Method == "POST")) {
		w.Header().Set("Allow", methods)
		message := "method not allowed"
		if path == "scan" {
			message = "扫描只允许读取配置或手动提交扫描。"
		}
		battleJSON(w, 405, map[string]string{"error": message})
		return
	}
	if path == "scan" && r.Method == http.MethodPost && !s.scanAuthorized(r) {
		battleJSON(w, 403, map[string]string{"error": "扫描会话已失效，请重新打开战报页后再点击扫描。"})
		return
	}
	s.mu.Lock()
	initErr := s.initErr
	closed := s.closed
	s.mu.Unlock()
	if initErr != nil {
		message := "battle database path is not configured; supply an absolute file path"
		if path == "scan" {
			message = "战报存储尚未配置，无法扫描。"
		}
		battleJSON(w, 503, map[string]string{"error": message})
		return
	}
	if closed {
		if path == "scan" {
			scanHTTPError(w, errBattleClosed)
		} else {
			battleHTTPError(w, errBattleClosed)
		}
		return
	}
	if path != "status" && path != "relay/stop" {
		select {
		case s.requests <- struct{}{}:
			defer func() { <-s.requests }()
		default:
			w.Header().Set("Retry-After", "1")
			battleJSON(w, 429, map[string]string{"error": "请求繁忙，请稍后重试。"})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	var body []byte
	if r.Method == "POST" || r.Method == "PUT" {
		limit := int64(128 << 10)
		if path == "import" {
			limit = battleImportLimit
		} else if path == "scan" {
			limit = 32 << 10
		}
		var err error
		body, err = battleReadBody(w, r, limit, path == "import")
		if err != nil {
			if path == "scan" {
				if err.Error() == "content-type" {
					battleJSON(w, 415, map[string]string{"error": "请使用未压缩的 UTF-8 application/json 请求。"})
				} else {
					scanHTTPError(w, err)
				}
				return
			}
			if err.Error() == "content-type" {
				battleJSON(w, 415, map[string]string{"error": "use application/json (or application/x-ndjson for imports), UTF-8, without compression"})
			} else {
				battleHTTPError(w, err)
			}
			return
		}
	}
	switch path {
	case "source/export", "source/status":
		s.serveSourceHTTP(w, r, ctx, path)
	case "scan":
		s.serveScanHTTP(w, r, ctx, body)
	case "import":
		records, issues, err := DecodeBattleImport(body)
		if err != nil {
			battleJSON(w, 400, map[string]any{"error": battleImportErrorMessage(err), "issues": battleImportIssues(issues)})
			return
		}
		result, err := s.Import(ctx, records)
		if err != nil {
			battleHTTPError(w, err)
			return
		}
		result.Issues = battleImportIssues(issues)
		battleJSON(w, 200, result)
	case "record":
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(values) != 1 || len(values["id"]) != 1 || values.Get("id") == "" || len(values.Get("id")) > 256 {
			battleJSON(w, 400, map[string]string{"error": "provide exactly one battle id"})
			return
		}
		record, err := s.Record(ctx, values.Get("id"))
		if err != nil {
			battleHTTPError(w, err)
			return
		}
		battleJSON(w, 200, record)
	case "list", "stats":
		values, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			battleJSON(w, 400, map[string]string{"error": "invalid query"})
			return
		}
		filter, err := ParseBattleFilter(values)
		if err != nil {
			battleJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		if path == "list" {
			page, size := 1, 25
			if v := values.Get("page"); v != "" {
				page, err = strconv.Atoi(v)
				if err != nil {
					page = 0
				}
			}
			if v := values.Get("pageSize"); v != "" {
				size, err = strconv.Atoi(v)
				if err != nil {
					size = 0
				}
			}
			if page < 1 || page > 1000000 || size < 1 || size > 100 {
				battleJSON(w, 400, map[string]string{"error": "page must be 1..1000000 and pageSize 1..100"})
				return
			}
			result, err := s.List(ctx, filter, page, size)
			if err != nil {
				battleHTTPError(w, err)
				return
			}
			battleJSON(w, 200, result)
		} else {
			result, err := s.Stats(ctx, filter)
			if err != nil {
				battleHTTPError(w, err)
				return
			}
			battleJSON(w, 200, result)
		}
	case "rules":
		var rules []BattleTeamRule
		var err error
		if r.Method == "PUT" {
			var input struct {
				Rules        *[]BattleTeamRule `json:"rules"`
				BaseRevision *string           `json:"baseRevision,omitempty"`
			}
			if !battleStrictJSON(body, &input) || input.Rules == nil || input.BaseRevision == nil {
				battleHTTPError(w, errBattleInvalid)
				return
			}
			rules, err = s.PutRules(ctx, *input.Rules, *input.BaseRevision)
		} else {
			rules, err = s.Rules(ctx)
		}
		if err != nil {
			battleHTTPError(w, err)
			return
		}
		defaults, defaultErr := defaultBattleRules()
		if defaultErr != nil {
			battleHTTPError(w, defaultErr)
			return
		}
		battleJSON(w, 200, map[string]any{"rules": rules, "sourceRules": battleRuleSourceInputs(rules), "revision": battleRulesRevision(rules), "defaults": defaults})
	case "revision":
		if r.URL.RawQuery != "" {
			battleHTTPError(w, errBattleInvalid)
			return
		}
		revision, err := s.QueryRevision(ctx)
		if err != nil {
			battleHTTPError(w, err)
			return
		}
		battleJSON(w, 200, map[string]string{"revision": revision})
	case "status":
		battleJSON(w, 200, s.RelayStatus())
	case "relay/start":
		var input struct {
			URL string `json:"url"`
		}
		if !battleStrictJSON(body, &input) {
			battleHTTPError(w, errBattleInvalid)
			return
		}
		if _, err := validateBattleRelayURL(input.URL); err != nil {
			battleJSON(w, 400, map[string]string{"error": "relay URL must be http://localhost:PORT or an explicit loopback IP and port, with no credentials, query, or fragment"})
			return
		}
		status, err := s.StartRelay(input.URL)
		if err != nil {
			battleJSON(w, 409, map[string]string{"error": "relay is already active or the battle service is closed; stop it before starting again"})
			return
		}
		battleJSON(w, 200, status)
	case "relay/stop":
		var input struct{}
		if !battleStrictJSON(body, &input) || string(bytes.TrimSpace(body)) != "{}" {
			battleHTTPError(w, errBattleInvalid)
			return
		}
		battleJSON(w, 200, s.StopRelay())
	default:
		battleJSON(w, 404, map[string]string{"error": "battle endpoint not found"})
	}
}

// Unknown parameters and duplicate values fail closed so list/statistics cannot
// accidentally interpret different filters. Time comparisons belong to domain.
func ParseBattleFilter(values url.Values) (BattleFilter, error) {
	f := BattleFilter{}
	invalid := errors.New("invalid battle filter; use RFC3339 times or ISO dates, a known outcome, positive monster id, and explicit rank metric/side")
	allowed := map[string]bool{"from": true, "to": true, "toExclusive": true, "outcome": true, "monsterId": true, "teamRuleId": true, "rankSide": true, "rankMetric": true, "rankMin": true, "rankMax": true, "tier": true, "page": true, "pageSize": true}
	for k, v := range values {
		if !allowed[k] || len(v) != 1 || len(v[0]) > 256 {
			return f, invalid
		}
	}
	f.From = values.Get("from")
	f.To = values.Get("to")
	if raw, present := values["toExclusive"]; present {
		if raw[0] != "true" && raw[0] != "false" {
			return f, invalid
		}
		f.ToExclusive = raw[0] == "true"
	}
	if f.ToExclusive && f.To == "" {
		return f, invalid
	}
	f.Outcome = values.Get("outcome")
	f.TeamRuleID = values.Get("teamRuleId")
	f.RankSide = values.Get("rankSide")
	f.RankMetric = values.Get("rankMetric")
	f.Tier = values.Get("tier")
	var from, to time.Time
	var err error
	if f.From != "" {
		from, err = parseBattleFilterBoundary(f.From, false)
		if err != nil {
			return f, invalid
		}
	}
	if f.To != "" {
		to, err = parseBattleFilterBoundary(f.To, !f.ToExclusive)
		if err != nil {
			return f, invalid
		}
	}
	if !from.IsZero() && !to.IsZero() && from.After(to) {
		return f, invalid
	}
	if f.Outcome != "" && f.Outcome != "win" && f.Outcome != "loss" && f.Outcome != "draw" && f.Outcome != "unknown" {
		return f, invalid
	}
	if raw := values.Get("monsterId"); raw != "" {
		f.MonsterID, err = strconv.Atoi(raw)
		if err != nil || f.MonsterID <= 0 || f.MonsterID > 1000000000 {
			return f, invalid
		}
	}
	if f.TeamRuleID != "" && !battleSafeToken(f.TeamRuleID, 80) {
		return f, invalid
	}
	if f.RankSide != "" && f.RankSide != "me" && f.RankSide != "enemy" {
		return f, invalid
	}
	if f.RankMetric != "" && f.RankMetric != "score" && f.RankMetric != "rank" && f.RankMetric != "tier" {
		return f, invalid
	}
	for _, entry := range []struct {
		key string
		dst **float64
	}{{"rankMin", &f.RankMin}, {"rankMax", &f.RankMax}} {
		if raw := values.Get(entry.key); raw != "" {
			n, err := strconv.ParseFloat(raw, 64)
			if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 1e12 {
				return f, invalid
			}
			if f.RankMetric == "rank" && (n < 1 || math.Trunc(n) != n) {
				return f, invalid
			}
			*entry.dst = &n
		}
	}
	if f.RankMin != nil && f.RankMax != nil && *f.RankMin > *f.RankMax {
		return f, invalid
	}
	if (f.RankMin != nil || f.RankMax != nil) && (f.RankMetric != "score" && f.RankMetric != "rank") {
		return f, invalid
	}
	if f.Tier != "" && f.RankMetric != "tier" {
		return f, invalid
	}
	if f.RankMetric != "" && f.RankSide == "" {
		return f, invalid
	}
	return f, nil
}

// Classify decoder failures into fixed actionable diagnostics. Never forward an
// arbitrary error/issue string: future adapters might include source text in it.
func battleImportErrorMessage(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "no supported"):
		return "No supported battle records found. Use normalized version 1 JSON or RKPP lifecycle metadata with an explicit battle ID; raw packets and orphan action/profile frames are unsupported. Nothing was saved."
	case strings.Contains(message, "version"):
		return "Unsupported battle schema version. Export normalized version 1 records; future versions are not reset or guessed. Nothing was saved."
	case strings.Contains(message, "exceed") || strings.Contains(message, "too many") || strings.Contains(message, "limit"):
		return "Import exceeds a record, event, nesting or size limit. Split the export into smaller supported batches. Nothing was saved."
	case strings.Contains(message, "conflict") || strings.Contains(message, "duplicate"):
		return "Conflicting identifiers, declarations or duplicate JSON keys were found. Correct the conflicting export instead of overwriting saved evidence. Nothing was saved."
	case strings.Contains(message, "json") || strings.Contains(message, "malformed"):
		return "Invalid JSON or NDJSON. Import a UTF-8 JSON export, not a packet capture or raw binary file. Nothing was saved."
	case strings.Contains(message, "rkpp") || strings.Contains(message, "named"):
		return "Unsupported or invalid RKPP metadata. Supply lifecycle records with explicit battle IDs and verified named fields, or use normalized version 1 JSON. Nothing was saved."
	default:
		return "Invalid normalized battle schema. Check identifiers, timestamps, enums, evidence values and side/actor consistency. Nothing was saved."
	}
}

func battleImportIssues(issues []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, issue := range issues {
		var safe string
		lower := strings.ToLower(issue)
		switch {
		case strings.Contains(lower, "normalized completeness"):
			safe = "Normalized completeness and evidence are importer declarations, not independently verified game facts."
		case strings.Contains(lower, "rkpp"):
			safe = "RKPP support is conservative: unverified mappings, orphan actions and raw profile fields are not complete gameplay evidence."
		default:
			safe = "Some frames or fields were unsupported or incomplete; review the saved record's quality warnings."
		}
		if !seen[safe] {
			out = append(out, safe)
			seen[safe] = true
		}
	}
	return out
}

func parseBattleFilterBoundary(value string, end bool) (time.Time, error) {
	if len(value) == 10 {
		date, err := time.Parse("2006-01-02", value)
		if err == nil && end {
			date = date.AddDate(0, 0, 1).Add(-time.Nanosecond)
		}
		return date, err
	}
	return time.Parse(time.RFC3339Nano, value)
}
