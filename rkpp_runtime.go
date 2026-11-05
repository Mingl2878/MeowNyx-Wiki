package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const (
	rkppRelayURL    = "http://127.0.0.1:18765/events"
	rkppHealthURL   = "http://127.0.0.1:18765/health"
	rkppLogLimit    = 1 << 20
	rkppHealthLimit = 64 << 10
)

type rkppRelay interface {
	StartRelay(string) (BattleRelayStatus, error)
	StopRelay() BattleRelayStatus
	RelayStatus() BattleRelayStatus
}

type rkppProcess interface {
	PID() int
	Kill() error
	Wait() error
}

type rkppLaunchSpec struct{ Program, Script, DataRoot string }

type RKPPStatus struct {
	State      string `json:"state"`
	Owned      bool   `json:"owned"`
	PID        int    `json:"pid,omitempty"`
	Connected  bool   `json:"connected"`
	RelayState string `json:"relayState"`
	Error      string `json:"error,omitempty"`
}

// The only injectable producer is internal, for isolated tests; HTTP never accepts
// a program, command, path, port, or URL. Construction has no filesystem/network I/O.
type RKPPRuntime struct {
	op                              sync.Mutex
	mu                              sync.Mutex
	relay                           rkppRelay
	spec                            rkppLaunchSpec
	launch                          func(rkppLaunchSpec) (rkppProcess, error)
	probe                           func(context.Context) (bool, error)
	poll, readyTimeout, stopTimeout time.Duration
	status                          RKPPStatus
	cancel                          context.CancelFunc
	done                            chan struct{}
	child                           rkppProcess
	childDone                       chan struct{}
	closed                          bool
	token                           string
}

func NewRKPPRuntime(exeDir, userDataRoot string, relay rkppRelay) (*RKPPRuntime, error) {
	if !filepath.IsAbs(exeDir) || !filepath.IsAbs(userDataRoot) || relay == nil {
		return nil, errors.New("RKPP requires fixed absolute application and user-data roots")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	client := rkppHealthClient()
	return &RKPPRuntime{
		relay:  relay,
		spec:   rkppLaunchSpec{filepath.Join(exeDir, "rkpp", "python", "python.exe"), filepath.Join(exeDir, "rkpp", "launch.py"), filepath.Join(userDataRoot, "rkpp")},
		launch: launchRKPPProcess,
		probe:  func(ctx context.Context) (bool, error) { return probeRKPPHealth(ctx, client, rkppHealthURL) },
		poll:   150 * time.Millisecond, readyTimeout: 15 * time.Second, stopTimeout: 3 * time.Second,
		status: RKPPStatus{State: "stopped", RelayState: "stopped"}, token: hex.EncodeToString(secret[:]),
	}, nil
}

func (c *RKPPRuntime) Status() RKPPStatus {
	c.mu.Lock()
	s := c.status
	c.mu.Unlock()
	r := c.relay.RelayStatus()
	s.RelayState = r.State
	// StartRelay only schedules a receiver. Report connected after the verified
	// health check AND that receiver's successful HTTP handshake, never earlier.
	s.Connected = s.State == "running" && r.State == "running"
	if s.State == "running" && r.State != "running" {
		s.State = "ready"
		if r.State == "error" {
			s.State, s.Error = "error", "RKPP relay disconnected; retry manually."
		}
	}
	return s
}

func (c *RKPPRuntime) StartIfConfigured(settings UserSettings) {
	if settings.RKPPAutostart {
		_, _ = c.Start()
	}
}

// Start is asynchronous and idempotent while an operation/root is active.
func (c *RKPPRuntime) Start() (RKPPStatus, error) {
	c.op.Lock()
	defer c.op.Unlock()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return c.Status(), errors.New("RKPP runtime closed")
	}
	if c.done != nil {
		select {
		case <-c.done:
			c.done = nil
		default:
			c.mu.Unlock()
			return c.Status(), nil
		}
	}
	// A child that could not be reaped remains owned; do not spawn a second root.
	if c.status.Owned {
		c.mu.Unlock()
		return c.Status(), errors.New("owned RKPP root has not exited")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	c.cancel, c.done = cancel, done
	c.status = RKPPStatus{State: "starting", RelayState: "stopped"}
	c.mu.Unlock()
	go c.run(ctx, done)
	return c.Status(), nil
}

func (c *RKPPRuntime) setState(state, message string) {
	c.mu.Lock()
	c.status.State, c.status.Error = state, message
	c.mu.Unlock()
}

func (c *RKPPRuntime) run(ctx context.Context, done chan struct{}) {
	defer close(done)
	readyCtx, cancelReady := context.WithTimeout(ctx, c.readyTimeout)
	defer cancelReady()
	var child rkppProcess
	var exited chan struct{}
	var exitErr error // written before exited closes; read only after that close
	relayManaged := false
	failure := ""
	defer func() {
		if relayManaged {
			c.relay.StopRelay()
		}
		if child != nil {
			select {
			case <-exited:
			default:
				_ = child.Kill() // only the exact process handle created by this runtime
			}
			timer := time.NewTimer(c.stopTimeout)
			defer timer.Stop()
			select {
			case <-exited:
				c.mu.Lock()
				c.status.Owned, c.status.PID = false, 0
				c.mu.Unlock()
			case <-timer.C:
				failure = "Owned RKPP root did not finish stopping; no replacement was launched."
			}
		}
		if failure != "" {
			c.setState("error", failure)
		} else {
			c.setState("stopped", "")
		}
	}()
	ready, err := c.probe(readyCtx)
	if ctx.Err() != nil {
		return
	}
	if err != nil {
		failure = "Local RKPP health is incompatible or invalid; no root was launched."
		return
	}
	if !ready {
		child, err = c.launch(c.spec)
		if err != nil {
			failure = "Cannot launch packaged RKPP; check its files and user-data access."
			return
		}
		exited = make(chan struct{})
		c.mu.Lock()
		c.status.Owned, c.status.PID = true, child.PID()
		c.child, c.childDone = child, exited
		c.mu.Unlock()
		go func() {
			exitErr = child.Wait()
			c.mu.Lock()
			c.status.Owned, c.status.PID = false, 0
			c.child, c.childDone = nil, nil
			c.mu.Unlock()
			close(exited)
		}()
		ticker := time.NewTicker(c.poll)
		defer ticker.Stop()
		for !ready {
			select {
			case <-ctx.Done():
				return
			case <-readyCtx.Done():
				failure = "RKPP did not become healthy before the startup timeout."
				return
			case <-exited:
				failure = "Owned RKPP root exited before becoming ready."
				return
			case <-ticker.C:
				ready, err = c.probe(readyCtx)
				if err != nil {
					failure = "RKPP returned incompatible health; owned root was stopped."
					return
				}
			}
		}
	}
	if ctx.Err() != nil {
		return
	}
	c.setState("connecting", "")
	r := c.relay.RelayStatus()
	if r.State == "running" || r.State == "connecting" {
		if r.URL != rkppRelayURL {
			failure = "Another relay receiver is already active; disconnect it before starting RKPP."
			return
		}
		relayManaged = true // reuse the one existing receiver, never duplicate it
	} else {
		if _, err := c.relay.StartRelay(rkppRelayURL); err != nil {
			failure = "Cannot start the RKPP battle receiver."
			return
		}
		relayManaged = true
	}
	ticker := time.NewTicker(c.poll)
	defer ticker.Stop()
	for {
		r = c.relay.RelayStatus()
		if r.State == "running" {
			break
		}
		if r.State != "connecting" {
			failure = "RKPP health succeeded but the battle receiver failed to connect."
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-readyCtx.Done():
			failure = "RKPP battle receiver connection timed out."
			return
		case <-exited:
			failure = "Owned RKPP root exited while connecting."
			return
		case <-ticker.C:
		}
	}
	c.setState("running", "")
	cancelReady()
	for {
		select {
		case <-ctx.Done():
			return
		case <-exited:
			failure = "Owned RKPP root exited; battle receiver was disconnected."
			if exitErr == nil {
				failure = "Owned RKPP root stopped; battle receiver was disconnected."
			}
			return
		case <-ticker.C:
			if c.relay.RelayStatus().State != "running" {
				failure = "RKPP battle receiver disconnected; retry manually."
				return
			}
		}
	}
}

func (c *RKPPRuntime) stopLocked() RKPPStatus {
	c.mu.Lock()
	cancel, done := c.cancel, c.done
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
	// Retain the exact handle if an earlier bounded stop timed out. A repeated
	// explicit Stop can retry it, and late Wait completion clears ownership.
	c.mu.Lock()
	child, childDone := c.child, c.childDone
	c.mu.Unlock()
	if child != nil {
		_ = child.Kill()
		timer := time.NewTimer(c.stopTimeout)
		select {
		case <-childDone:
		case <-timer.C:
		}
		timer.Stop()
	}
	// Explicit stop disconnects this BattleService's receiver even if it was
	// manually opened first; the external process itself is never terminated.
	c.relay.StopRelay()
	c.mu.Lock()
	c.cancel, c.done = nil, nil
	if !c.status.Owned {
		c.status = RKPPStatus{State: "stopped", RelayState: "stopped"}
	}
	c.mu.Unlock()
	return c.Status()
}

func (c *RKPPRuntime) Stop() RKPPStatus {
	c.op.Lock()
	defer c.op.Unlock()
	return c.stopLocked()
}
func (c *RKPPRuntime) Close() {
	c.op.Lock()
	defer c.op.Unlock()
	c.mu.Lock()
	c.closed = true
	c.mu.Unlock()
	c.stopLocked()
}

func (c *RKPPRuntime) Register(mux *http.ServeMux) {
	for _, p := range []string{"start", "stop", "status"} {
		mux.HandleFunc("/api/rkpp/"+p, c.serveHTTP)
	}
}

func (c *RKPPRuntime) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if !guardUserConfigRequest(w, r) {
		return
	}
	method := http.MethodPost
	if r.URL.Path == "/api/rkpp/status" {
		method = http.MethodGet
	}
	if r.Method != method {
		w.Header().Set("Allow", method)
		configError(w, 405, errors.New("method not allowed"))
		return
	}
	if r.URL.RawQuery != "" {
		configError(w, 400, errors.New("RKPP API accepts no query parameters"))
		return
	}
	if method == http.MethodGet {
		battleJSON(w, 200, struct {
			RKPPStatus
			SessionToken string `json:"sessionToken"`
		}{c.Status(), c.token})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-RKPP-Session-Token")), []byte(c.token)) != 1 {
		configError(w, 403, errors.New("RKPP session expired; reload component status"))
		return
	}
	// Empty JSON object only. Bound both reading time and size, reject unknown
	// command/path/URL keys and trailing/duplicate JSON without invoking anything.
	data, err := battleReadBody(w, r, 1024, false)
	if err != nil {
		configError(w, 400, errors.New("invalid or oversized RKPP request"))
		return
	}
	obj, err := parseObject(data)
	if err != nil || len(obj) != 0 {
		configError(w, 400, errors.New("RKPP request must be an empty JSON object"))
		return
	}
	if r.URL.Path == "/api/rkpp/stop" {
		battleJSON(w, 200, c.Stop())
		return
	}
	s, err := c.Start()
	if err != nil {
		configError(w, 409, err)
		return
	}
	battleJSON(w, http.StatusAccepted, s)
}

func rkppHealthClient() *http.Client {
	tr := &http.Transport{Proxy: nil, DisableCompression: true, DisableKeepAlives: true,
		ResponseHeaderTimeout: time.Second, MaxResponseHeaderBytes: 16 << 10,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if addr != "127.0.0.1:18765" {
				return nil, errors.New("RKPP health endpoint rejected")
			}
			return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, addr)
		},
	}
	return &http.Client{Transport: tr, Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Unavailable is distinguished from an occupied but incompatible health endpoint:
// the latter must not cause a competing process to be launched or killed.
func probeRKPPHealth(ctx context.Context, client *http.Client, fixedURL string) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fixedURL, nil)
	if err != nil {
		return false, err
	}
	response, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		var op *net.OpError
		if errors.As(err, &op) && op.Op == "dial" {
			return false, nil
		}
		return false, errors.New("RKPP health request failed")
	}
	defer response.Body.Close()
	typ, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode != 200 || err != nil || typ != "application/json" || response.Header.Get("Content-Encoding") != "" && response.Header.Get("Content-Encoding") != "identity" {
		return false, errors.New("incompatible RKPP health response")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, rkppHealthLimit+1))
	if err != nil || len(data) > rkppHealthLimit {
		return false, errors.New("invalid RKPP health body")
	}
	var health struct {
		Status     string `json:"status"`
		Mode       string `json:"mode"`
		Time       string `json:"time"`
		Events     *int   `json:"events"`
		History    *int   `json:"history"`
		Clients    *int   `json:"clients"`
		OK         *bool  `json:"ok"`
		Service    string `json:"service"`
		StreamPath string `json:"stream_path"`
		RelayPort  int    `json:"relay_port"`
	}
	if checkJSON(data) != nil || json.Unmarshal(data, &health) != nil || health.Status != "ok" || health.Mode != "normal" || health.Time == "" || len(health.Time) > 128 || health.Events == nil || *health.Events < 0 || health.History == nil || *health.History < 0 || health.Clients == nil || *health.Clients < 0 {
		return false, errors.New("incompatible RKPP health shape")
	}
	// Original RKPP has no branding fields. If any branded field is supplied,
	// require the complete packaged contract rather than silently downgrading.
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	_, hasOK := fields["ok"]
	_, hasService := fields["service"]
	_, hasPort := fields["relay_port"]
	_, hasPath := fields["stream_path"]
	if hasOK || hasService || hasPort || hasPath {
		if health.OK == nil || !*health.OK || health.Service != "rkpp" || health.StreamPath != "/events" || health.RelayPort != 18765 {
			return false, errors.New("incompatible packaged RKPP health shape")
		}
	}
	return true, nil
}

type rkppCappedLog struct {
	mu   sync.Mutex
	file *os.File
	size int
}

func (w *rkppCappedLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	if remaining := rkppLogLimit - w.size; remaining > 0 {
		part := p
		if len(part) > remaining {
			part = part[:remaining]
		}
		written, err := w.file.Write(part)
		w.size += written
		if err != nil {
			return written, err
		}
	}
	return n, nil // drain/discard beyond cap so a verbose child cannot block Wait
}

type rkppExecProcess struct {
	cmd *exec.Cmd
	log *os.File
}

func (p *rkppExecProcess) PID() int    { return p.cmd.Process.Pid }
func (p *rkppExecProcess) Kill() error { return p.cmd.Process.Kill() }
func (p *rkppExecProcess) Wait() error { defer p.log.Close(); return p.cmd.Wait() }
func rkppCommand(spec rkppLaunchSpec) *exec.Cmd {
	cmd := exec.Command(spec.Program, "-I", "-B", "-u", spec.Script, "--data-root", spec.DataRoot, "--relay-port", "18765")
	cmd.Dir = filepath.Dir(spec.Script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	return cmd
}
func launchRKPPProcess(spec rkppLaunchSpec) (rkppProcess, error) {
	for _, p := range []string{spec.Program, spec.Script} {
		info, err := os.Stat(p)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, errors.New("RKPP package file is not regular")
		}
	}
	if err := os.MkdirAll(spec.DataRoot, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(spec.DataRoot, "runtime.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return nil, err
	}
	cmd := rkppCommand(spec)
	output := &rkppCappedLog{file: f}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		f.Close()
		return nil, err
	}
	return &rkppExecProcess{cmd: cmd, log: f}, nil
}
