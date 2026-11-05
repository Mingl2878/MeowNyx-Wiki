package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const battleRelayFrameLimit = 1 << 20

// Status contains only fixed diagnostics and the validated local endpoint. Never
// expose transport errors (which can contain credentials, addresses or payload).
type BattleRelayStatus struct {
	State       string   `json:"state"`
	URL         string   `json:"url"`
	Received    int      `json:"received"`
	Imported    int      `json:"imported"` // all changes, preserving the existing contract
	Updated     int      `json:"updated"`
	Unchanged   int      `json:"unchanged"`
	Completed   int      `json:"completed"`
	Pending     int      `json:"pending"` // currently unfinished battles in this connection
	Ignored     int      `json:"ignored"`
	Unsupported int      `json:"unsupported"`
	Issues      []string `json:"issues"`
	Error       string   `json:"error,omitempty"`
}

func validateBattleRelayURL(raw string) (*url.URL, error) {
	bad := errors.New("invalid loopback relay URL")
	if len(raw) > 256 || strings.TrimSpace(raw) != raw {
		return nil, bad
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || u.RawPath != "" {
		return nil, bad
	}
	if u.Path != "" && u.Path != "/" && u.Path != "/events" {
		return nil, bad
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil || !battleLoopbackHost(host) {
		return nil, bad
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return nil, bad
	}
	// localhost is pinned without DNS resolution. Literal addresses are checked
	// again by the dialer; no DNS, redirects, environment proxies or auto-start.
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
	}
	u.Host = net.JoinHostPort(host, strconv.Itoa(n))
	u.Path = "/events"
	return u, nil
}

type battleDeadlineConn struct{ net.Conn }

func (c battleDeadlineConn) Read(p []byte) (int, error) {
	if err := c.Conn.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return 0, err
	}
	return c.Conn.Read(p)
}

func battleRelayClient() (*http.Client, *http.Transport) {
	tr := &http.Transport{
		Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		ResponseHeaderTimeout: 5 * time.Second, MaxResponseHeaderBytes: 16 << 10,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil || !battleLoopbackHost(host) || strings.EqualFold(host, "localhost") {
				return nil, errors.New("relay dial rejected")
			}
			conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			return battleDeadlineConn{conn}, nil
		},
	}
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, tr
}

func (s *BattleService) RelayStatus() BattleRelayStatus {
	s.relayMu.Lock()
	defer s.relayMu.Unlock()
	status := s.relay
	status.Issues = append([]string{}, status.Issues...)
	return status
}

func (s *BattleService) StartRelay(raw string) (BattleRelayStatus, error) {
	u, err := validateBattleRelayURL(raw)
	if err != nil {
		return s.RelayStatus(), err
	}
	s.relayOp.Lock()
	defer s.relayOp.Unlock()
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		return s.RelayStatus(), errBattleClosed
	}
	s.relayMu.Lock()
	if s.relay.State == "connecting" || s.relay.State == "running" {
		s.relayMu.Unlock()
		return s.RelayStatus(), errors.New("relay already active")
	}
	previousDone := s.relayDone
	s.relayMu.Unlock()
	if previousDone != nil {
		<-previousDone
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.relayMu.Lock()
	s.relay = BattleRelayStatus{State: "connecting", URL: u.String(), Issues: []string{"Live relay coverage is incomplete until verified; no capture or parser is started by this application."}}
	s.relayCancel = cancel
	s.relayDone = done
	s.relayMu.Unlock()
	go s.runBattleRelay(ctx, u, done)
	return s.RelayStatus(), nil
}

// Caller holds relayOp. Cancelling the HTTP request closes the underlying stream;
// waiting for done guarantees stop/Close leave no consumer or timer goroutine.
func (s *BattleService) stopRelayLocked() BattleRelayStatus {
	s.relayMu.Lock()
	cancel, done := s.relayCancel, s.relayDone
	s.relayMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	s.relayMu.Lock()
	s.relayCancel = nil
	s.relayDone = nil
	s.relay.State = "stopped"
	s.relayMu.Unlock()
	return s.RelayStatus()
}

func (s *BattleService) StopRelay() BattleRelayStatus {
	s.relayOp.Lock()
	defer s.relayOp.Unlock()
	return s.stopRelayLocked()
}

func (s *BattleService) relayFailure(message string) {
	s.relayMu.Lock()
	defer s.relayMu.Unlock()
	s.relay.State = "error"
	s.relay.Error = message
}

func (s *BattleService) relayUnsupported() {
	s.relayMu.Lock()
	defer s.relayMu.Unlock()
	s.relay.Unsupported++
	warning := "Unsupported relay frames were skipped; capture coverage remains incomplete."
	if len(s.relay.Issues) < 2 {
		s.relay.Issues = append(s.relay.Issues, warning)
	}
}

func (s *BattleService) importRelayFrame(ctx context.Context, assembler *BattleStreamAssembler, data []byte) error {
	if len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	s.relayMu.Lock()
	s.relay.Received++
	s.relayMu.Unlock()
	// Own an exact source copy before the assembler converts named JSON facts.
	// Canonical records and protected/non-battle envelopes are never archived.
	sourceFrame, sourceWarning := battlePrepareSourceFrame(data)
	records, accepted, err := assembler.Push(data)
	if err != nil && sourceFrame != nil {
		sourceWarning |= battleSourceInvalid
	}
	s.retainRelaySource(ctx, sourceFrame, sourceWarning, accepted && err == nil)
	s.relayMu.Lock()
	s.relay.Pending = assembler.Pending()
	s.relayMu.Unlock()
	if err != nil {
		// Only fixed diagnostics survive; never retain the rejected source frame.
		s.relayUnsupported()
		return nil
	}
	s.relayMu.Lock()
	if !accepted {
		s.relay.Ignored++
	}
	s.relay.Completed += len(records)
	s.relayMu.Unlock()
	if len(records) == 0 {
		return nil
	}
	for i := range records {
		// Live assembler outputs carry per-record verified coverage. Keep it.
		// Legacy canonical frames remain supported, but their declared coverage
		// is not newly certified merely because they arrived over a relay.
		if records[i].Source != "rkpp-live-v1" {
			records[i].Quality = BattleQuality{Roster: map[string]bool{"me": false, "enemy": false}, Actions: false, Lead: map[string]bool{"me": false, "enemy": false}}
			records[i].Issues = append(records[i].Issues, "Live relay capture is unverified and may be incomplete.")
		}
	}
	result, err := s.Import(ctx, records)
	if err != nil {
		return err
	}
	s.relayMu.Lock()
	s.relay.Imported += result.Imported
	s.relay.Updated += result.Updated
	s.relay.Unchanged += result.Duplicates
	for _, issue := range result.Issues {
		if len(s.relay.Issues) < 4 {
			s.relay.Issues = append(s.relay.Issues, issue)
		}
	}
	s.relayMu.Unlock()
	return nil
}

func (s *BattleService) runBattleRelay(ctx context.Context, u *url.URL, done chan struct{}) {
	defer close(done)
	client, tr := battleRelayClient()
	defer tr.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		s.relayFailure("Unable to create local relay request.")
		return
	}
	req.Header.Set("Accept", "text/event-stream, application/x-ndjson")
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			s.relayFailure("Cannot connect to the existing local relay; check its port and /events endpoint.")
		}
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		s.relayFailure("Local relay returned an unsuccessful HTTP status; redirects are not followed.")
		return
	}
	typ, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || (typ != "text/event-stream" && typ != "application/x-ndjson" && typ != "application/ndjson") || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		s.relayFailure("Unsupported relay response; /events must return UTF-8 SSE or NDJSON without compression.")
		return
	}
	s.relayMu.Lock()
	s.relay.State = "running"
	s.relayMu.Unlock()
	// Synchronous read -> decode -> transaction is bounded backpressure. There is
	// no unbounded queue and no goroutine per frame. SSE blank lines delimit one
	// frame; NDJSON lines delimit one frame. Raw bytes live only for this decode.
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), battleRelayFrameLimit+1)
	var frame []byte
	// Exactly one bounded assembly state belongs to this explicitly opened
	// connection. Ending/restarting the connection discards unfinished battles.
	assembler := NewBattleStreamAssembler()
	consume := func(data []byte) bool {
		if err := s.importRelayFrame(ctx, assembler, data); err != nil {
			if ctx.Err() == nil {
				s.relayFailure("Relay import failed or exceeded a storage limit; stream stopped without discarding saved records.")
			}
			return false
		}
		return true
	}
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		line := scanner.Bytes()
		if len(line) > battleRelayFrameLimit {
			s.relayFailure("Relay frame exceeded the size limit; stream stopped and coverage remains incomplete.")
			return
		}
		if typ != "text/event-stream" {
			if !consume(line) {
				return
			}
			continue
		}
		if len(line) == 0 {
			if len(frame) > 0 {
				if !consume(frame) {
					return
				}
				frame = nil
			}
			continue
		}
		if bytes.HasPrefix(line, []byte(":")) {
			continue
		}
		if bytes.HasPrefix(line, []byte("data:")) {
			value := bytes.TrimPrefix(line, []byte("data:"))
			value = bytes.TrimPrefix(value, []byte(" "))
			if len(frame)+len(value)+1 > battleRelayFrameLimit {
				s.relayFailure("Relay frame exceeded the size limit; stream stopped and coverage remains incomplete.")
				return
			}
			frame = append(frame, value...)
			frame = append(frame, '\n')
		}
	}
	if ctx.Err() != nil {
		return
	}
	if scanner.Err() != nil {
		s.relayFailure("Relay stream timed out, failed, or exceeded the frame limit; coverage remains incomplete.")
		return
	}
	// An unterminated SSE event is not a confirmed frame and is not imported.
	if len(frame) > 0 {
		s.relayUnsupported()
	}
	s.relayFailure("Relay stream ended; coverage remains incomplete. Restart manually after checking the external relay.")
}
