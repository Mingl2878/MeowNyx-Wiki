package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Every process in this file is a fake. No helper launches Python, RKPP, a
// capture/app executable, or the real 18765 endpoint, and no SQLite is opened.
type rkppFakeProcess struct {
	exit  chan struct{}
	once  sync.Once
	kills atomic.Int32
	err   error
}

func newRKPPFakeProcess() *rkppFakeProcess { return &rkppFakeProcess{exit: make(chan struct{})} }
func (p *rkppFakeProcess) PID() int        { return 42 }
func (p *rkppFakeProcess) Kill() error {
	p.kills.Add(1)
	p.once.Do(func() { close(p.exit) })
	return nil
}
func (p *rkppFakeProcess) Wait() error { <-p.exit; return p.err }
func (p *rkppFakeProcess) finish()     { p.once.Do(func() { close(p.exit) }) }

type rkppFakeRelay struct {
	mu            sync.Mutex
	status        BattleRelayStatus
	starts, stops int
	autoRunning   bool
	startError    bool
}

func (s *rkppFakeRelay) RelayStatus() BattleRelayStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}
func (s *rkppFakeRelay) StartRelay(url string) (BattleRelayStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.starts++
	if s.startError {
		return s.status, errors.New("private fake transport error")
	}
	s.status = BattleRelayStatus{State: "connecting", URL: url}
	if s.autoRunning {
		s.status.State = "running"
	}
	return s.status, nil
}
func (s *rkppFakeRelay) StopRelay() BattleRelayStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stops++
	s.status.State = "stopped"
	return s.status
}
func (s *rkppFakeRelay) setState(state string) { s.mu.Lock(); s.status.State = state; s.mu.Unlock() }
func (s *rkppFakeRelay) counts() (int, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.starts, s.stops
}

func fakeRKPPRuntime(t *testing.T, relay *rkppFakeRelay) *RKPPRuntime {
	t.Helper()
	root := t.TempDir()
	c, err := NewRKPPRuntime(filepath.Join(root, "app"), filepath.Join(root, "user"), relay)
	if err != nil {
		t.Fatal(err)
	}
	c.poll, c.readyTimeout, c.stopTimeout = time.Millisecond, 100*time.Millisecond, 100*time.Millisecond
	c.probe = func(context.Context) (bool, error) { return true, nil }
	c.launch = func(rkppLaunchSpec) (rkppProcess, error) {
		t.Error("unexpected launch even though health is ready")
		return nil, errors.New("fake")
	}
	t.Cleanup(c.Close)
	return c
}
func awaitRKPP(t *testing.T, c *RKPPRuntime, predicate func(RKPPStatus) bool) RKPPStatus {
	t.Helper()
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		s := c.Status()
		if predicate(s) {
			return s
		}
		select {
		case <-timer.C:
			t.Fatalf("runtime did not reach expected state: %+v", s)
		case <-tick.C:
		}
	}
}

func TestRKPPRuntimeDefaultFalseAndExternalReuse(t *testing.T) {
	s := defaultSettings()
	if s.RKPPAutostart || s.CloseToBackground {
		t.Fatal("default settings must not opt in")
	}
	relay := &rkppFakeRelay{autoRunning: true}
	c := fakeRKPPRuntime(t, relay)
	var probes atomic.Int32
	c.probe = func(context.Context) (bool, error) { probes.Add(1); return true, nil }
	c.StartIfConfigured(s)
	if probes.Load() != 0 || c.Status().State != "stopped" {
		t.Fatal("default startup touched RKPP")
	}
	s.RKPPAutostart = true
	c.StartIfConfigured(s)
	status := awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	if status.Owned || status.PID != 0 {
		t.Fatal("existing external process must never become owned")
	}
	if _, err := os.Stat(c.spec.DataRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("external reuse created user data")
	}
	if _, err := c.Start(); err != nil {
		t.Fatal(err)
	}
	starts, _ := relay.counts()
	if starts != 1 {
		t.Fatal("duplicate receiver")
	}
	c.Stop()
	_, stops := relay.counts()
	if stops == 0 {
		t.Fatal("receiver was not disconnected")
	}
}

func TestRKPPRuntimeOwnChildReadyExitAndFixedArguments(t *testing.T) {
	relay := &rkppFakeRelay{autoRunning: true}
	c := fakeRKPPRuntime(t, relay)
	p := newRKPPFakeProcess()
	p.err = errors.New("private child error contains secrets")
	var probes, launches atomic.Int32
	c.probe = func(context.Context) (bool, error) { return probes.Add(1) > 1, nil }
	c.launch = func(spec rkppLaunchSpec) (rkppProcess, error) {
		launches.Add(1)
		cmd := rkppCommand(spec) // construction only, never Start or Run
		want := []string{spec.Program, "-I", "-B", "-u", spec.Script, "--data-root", spec.DataRoot, "--relay-port", "18765"}
		if !reflect.DeepEqual(cmd.Args, want) || cmd.Dir != filepath.Dir(spec.Script) || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags != 0x08000000 {
			t.Errorf("unsafe command shape: %#v", cmd.Args)
		}
		return p, nil
	}
	if _, err := c.Start(); err != nil {
		t.Fatal(err)
	}
	s := awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	if !s.Owned || s.PID != 42 || launches.Load() != 1 {
		t.Fatalf("wrong ownership: %+v", s)
	}
	p.finish()
	s = awaitRKPP(t, c, func(s RKPPStatus) bool { return s.State == "error" && !s.Owned })
	if s.Connected || strings.Contains(s.Error, "private") || p.kills.Load() != 0 {
		t.Fatalf("bad exit cleanup: %+v", s)
	}
	_, stops := relay.counts()
	if stops == 0 {
		t.Fatal("child exit kept receiver")
	}
}

func TestRKPPRuntimeNoConnectedBeforeHandshakeAndStopOwnOnly(t *testing.T) {
	relay := &rkppFakeRelay{}
	c := fakeRKPPRuntime(t, relay)
	p := newRKPPFakeProcess()
	var probes atomic.Int32
	c.probe = func(context.Context) (bool, error) { return probes.Add(1) > 1, nil }
	c.launch = func(rkppLaunchSpec) (rkppProcess, error) { return p, nil }
	c.Start()
	s := awaitRKPP(t, c, func(s RKPPStatus) bool { return s.State == "connecting" && s.RelayState == "connecting" })
	if s.Connected {
		t.Fatal("connected before receiver handshake")
	}
	relay.setState("running")
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	s = c.Stop()
	if s.Owned || s.Connected || p.kills.Load() != 1 {
		t.Fatalf("stop did not kill exact owned child: %+v", s)
	}
}

func TestRKPPRuntimeTimeoutAndRelayFailureCleanUp(t *testing.T) {
	for _, which := range []string{"health-timeout", "start-error", "receiver-error"} {
		t.Run(which, func(t *testing.T) {
			relay := &rkppFakeRelay{startError: which == "start-error"}
			c := fakeRKPPRuntime(t, relay)
			p := newRKPPFakeProcess()
			var probes atomic.Int32
			c.readyTimeout = 15 * time.Millisecond
			c.probe = func(context.Context) (bool, error) { return which != "health-timeout" && probes.Add(1) > 1, nil }
			c.launch = func(rkppLaunchSpec) (rkppProcess, error) { return p, nil }
			c.Start()
			if which == "receiver-error" {
				awaitRKPP(t, c, func(s RKPPStatus) bool { return s.RelayState == "connecting" })
				relay.setState("error")
			}
			s := awaitRKPP(t, c, func(s RKPPStatus) bool { return s.State == "error" && !s.Owned })
			if s.Connected || p.kills.Load() != 1 {
				t.Fatalf("failure did not clean child: %+v", s)
			}
		})
	}
}

func TestRKPPRuntimeExistingReceiverNotDuplicated(t *testing.T) {
	relay := &rkppFakeRelay{status: BattleRelayStatus{State: "running", URL: rkppRelayURL}}
	c := fakeRKPPRuntime(t, relay)
	c.Start()
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	starts, _ := relay.counts()
	if starts != 0 {
		t.Fatal("started another receiver")
	}
}

func TestRKPPRuntimeIncompatibleDoesNotLaunchAndCanRetry(t *testing.T) {
	relay := &rkppFakeRelay{autoRunning: true}
	c := fakeRKPPRuntime(t, relay)
	c.probe = func(context.Context) (bool, error) { return false, errors.New("private incompatible health") }
	c.Start()
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.State == "error" })
	c.mu.Lock()
	done := c.done
	c.mu.Unlock()
	<-done
	c.probe = func(context.Context) (bool, error) { return true, nil }
	c.Start()
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	relay.setState("error")
	c.mu.Lock()
	done = c.done
	c.mu.Unlock()
	<-done
	if c.Status().Connected {
		t.Fatal("receiver failure remained connected")
	}
	c.Start()
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	starts, _ := relay.counts()
	if starts != 2 {
		t.Fatal("explicit retry did not reconnect", starts)
	}
	c.Close()
	if _, err := c.Start(); err == nil {
		t.Fatal("closed runtime restarted")
	}
}

func TestRKPPSettingsSaveEffectsOnlyAfterSuccess(t *testing.T) {
	dir := t.TempDir()
	oldStore := sharedUserConfig
	gCloseMu.Lock()
	oldDispatch, oldBehavior := gWindowDispatch, gCloseBehavior
	gCloseMu.Unlock()
	defer func() {
		sharedUserConfig = oldStore
		gCloseMu.Lock()
		gWindowDispatch, gCloseBehavior = oldDispatch, oldBehavior
		gCloseMu.Unlock()
	}()
	calls := 0
	gCloseMu.Lock()
	gWindowDispatch = func(func()) { calls++ } // never invoke native tray/window APIs
	gCloseBehavior = "minimize"
	gCloseMu.Unlock()
	request := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8788/api/settings", strings.NewReader(`{"rkpp_autostart":true,"close_to_background":true,"close_behavior":"minimize"}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handleSaveSettings(w, r)
		return w
	}
	sharedUserConfig = &userConfigStore{initErr: errors.New("fake access denied")}
	if w := request(); w.Code != 500 || calls != 0 {
		t.Fatal("failed save applied native effects", w.Code, calls)
	}
	sharedUserConfig = newUserConfigStore(filepath.Join(dir, "profile"), filepath.Join(dir, "backups"))
	if w := request(); w.Code != 200 || calls != 1 {
		t.Fatal("successful save did not queue tray effect", w.Code, calls, w.Body.String())
	}
	s, err := sharedUserConfig.settings()
	if err != nil || !s.RKPPAutostart || !s.CloseToBackground || s.CloseBehavior != "minimize" {
		t.Fatal("settings/legacy behavior not preserved", s, err)
	}
}

func TestRKPPHealthShapesAndBounds(t *testing.T) {
	legacy := `{"status":"ok","mode":"normal","events":0,"history":0,"clients":1,"time":"2026-11-05T01:00:00"}`
	branded := strings.TrimSuffix(legacy, "}") + `,"ok":true,"service":"rkpp","relay_port":18765,"stream_path":"/events"}`
	for _, tc := range []struct {
		name, body string
		status     int
		valid      bool
	}{
		{"legacy", legacy, 200, true}, {"packaged", branded, 200, true},
		{"negative", strings.Replace(legacy, `"events":0`, `"events":-1`, 1), 200, false},
		{"null", strings.Replace(legacy, `"clients":1`, `"clients":null`, 1), 200, false},
		{"false-brand", strings.Replace(branded, `"ok":true`, `"ok":false`, 1), 200, false},
		{"wrong-port", strings.Replace(branded, `18765`, `80`, 1), 200, false},
		{"empty-object", `{}`, 200, false}, {"redirect", legacy, 302, false},
		{"oversized", legacy + strings.Repeat(" ", rkppHealthLimit), 200, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := server.Client()
			client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			ok, err := probeRKPPHealth(context.Background(), client, server.URL+"/health")
			if ok != tc.valid || tc.valid && err != nil || !tc.valid && err == nil {
				t.Fatalf("health result %v %v", ok, err)
			}
		})
	}
}

func TestRKPPHTTPGuardTokenAndNoArguments(t *testing.T) {
	relay := &rkppFakeRelay{autoRunning: true}
	c := fakeRKPPRuntime(t, relay)
	mux := http.NewServeMux()
	c.Register(mux)
	request := func(path, method, body, token, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "http://127.0.0.1:8788"+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("X-RKPP-Session-Token", token)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := request("/api/rkpp/status", "GET", "", "", "")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var status struct {
		SessionToken string `json:"sessionToken"`
	}
	if json.Unmarshal(w.Body.Bytes(), &status) != nil || status.SessionToken == "" {
		t.Fatal("missing capability")
	}
	for _, tc := range []struct {
		path, method, body, token, origin string
		code                              int
	}{
		{"/api/rkpp/start", "POST", "{}", "", "", 403},
		{"/api/rkpp/start", "POST", "{}", status.SessionToken, "http://evil.example", 403},
		{"/api/rkpp/start", "GET", "", status.SessionToken, "", 405},
		{"/api/rkpp/start", "POST", `{"program":"evil"}`, status.SessionToken, "", 400},
		{"/api/rkpp/start", "POST", `{"url":"http://evil"}`, status.SessionToken, "", 400},
		{"/api/rkpp/start", "POST", "null", status.SessionToken, "", 400},
		{"/api/rkpp/start?path=evil", "POST", "{}", status.SessionToken, "", 400},
		{"/api/rkpp/start", "POST", "{} {}", status.SessionToken, "", 400},
		{"/api/rkpp/start", "POST", strings.Repeat("x", 1025), status.SessionToken, "", 400},
	} {
		if w := request(tc.path, tc.method, tc.body, tc.token, tc.origin); w.Code != tc.code {
			t.Fatalf("%+v -> %d %s", tc, w.Code, w.Body.String())
		}
	}
	if starts, _ := relay.counts(); starts != 0 {
		t.Fatal("invalid request touched relay")
	}
	w = request("/api/rkpp/start", "POST", "{}", status.SessionToken, "")
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	awaitRKPP(t, c, func(s RKPPStatus) bool { return s.Connected })
	w = request("/api/rkpp/stop", "POST", "{}", status.SessionToken, "")
	if w.Code != 200 || c.Status().Connected {
		t.Fatal("stop failed")
	}
}

func TestRKPPBoundedLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	w := &rkppCappedLog{file: f}
	input := []byte(strings.Repeat("x", rkppLogLimit+100))
	if n, err := w.Write(input); n != len(input) || err != nil {
		t.Fatal(n, err)
	}
	if n, err := w.Write(input); n != len(input) || err != nil {
		t.Fatal(n, err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() != rkppLogLimit {
		t.Fatal("unbounded log", info, err)
	}
}

func TestRKPPSettingsBoolValidationAndOldClosePolicy(t *testing.T) {
	for _, field := range []string{"rkpp_autostart", "close_to_background"} {
		for _, raw := range []string{"null", `"true"`, "1", "[]", "{}"} {
			if _, err := settingsFromJSON(json.RawMessage(`{"`+field+`":`+raw+`}`), false); err == nil {
				t.Fatalf("accepted %s=%s", field, raw)
			}
		}
	}
	s, err := settingsFromJSON(json.RawMessage(`{"close_behavior":"minimize"}`), false)
	if err != nil || s.RKPPAutostart || s.CloseToBackground || s.CloseBehavior != "minimize" {
		t.Fatal("old settings/defaults changed", s, err)
	}
	for _, tc := range []struct {
		approved, real, background, iconic bool
		behavior, want                     string
	}{
		{false, false, false, false, "close", "flush"}, {false, false, false, false, "minimize", "minimize"},
		{false, false, false, true, "minimize", "flush"}, {false, false, true, false, "minimize", "hide"},
		{false, true, true, false, "minimize", "flush"}, {true, true, true, false, "minimize", "close"},
	} {
		if got := closeWindowAction(tc.approved, tc.real, tc.background, tc.behavior, tc.iconic); got != tc.want {
			t.Fatalf("close policy %+v -> %s", tc, got)
		}
	}
}
