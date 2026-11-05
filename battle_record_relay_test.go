package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func backendWait(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("relay condition timed out")
}

func TestBackendRelayURLValidation(t *testing.T) {
	valid := []string{"http://127.0.0.1:18765", "http://localhost:1/", "http://[::1]:65535/events", "http://127.2.3.4:42", "http://[::ffff:127.0.0.1]:42"}
	for _, raw := range valid {
		u, err := validateBattleRelayURL(raw)
		if err != nil || u.Path != "/events" {
			t.Fatal(raw, u, err)
		}
	}
	invalid := []string{"https://127.0.0.1:80", "file:///events", "http://example.org:80", "http://0.0.0.0:80", "http://192.168.1.1:80", "http://[::]:80", "http://127.0.0.1.evil:80", "http://localhost.:80", "http://user:secret@127.0.0.1:80", "http://127.0.0.1", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:80/private", "http://127.0.0.1:80?key=secret", "http://127.0.0.1:80?", "http://127.0.0.1:80#", "http://127.0.0.1:80/#secret", "http://127.0.0.1:80/%65vents", "http://[::1%25zone]:80", " http://127.0.0.1:80"}
	for _, raw := range invalid {
		if _, err := validateBattleRelayURL(raw); err == nil {
			t.Fatal("unsafe URL accepted", raw)
		}
	}
	_, mux := backendMux(t)
	for _, raw := range invalid {
		data, _ := json.Marshal(map[string]string{"url": raw})
		w := backendRequest(mux, "POST", "/api/battles/relay/start", string(data))
		if w.Code != 400 {
			t.Fatal(raw, w.Code)
		}
		if strings.Contains(w.Body.String(), "secret") {
			t.Fatal("URL secret echoed")
		}
	}
	client, tr := battleRelayClient()
	defer tr.CloseIdleConnections()
	if tr.Proxy != nil || client.CheckRedirect == nil {
		t.Fatal("proxy or redirects enabled")
	}
}

func TestBackendRelaySSEMergeCancelAndNoStartup(t *testing.T) {
	s := backendService(t)
	first := backendBattle(t, "streamed")
	second := backendBattle(t, "streamed")
	second.Events[0].ID = "event-2"
	second.Events[0].Seq = 2
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	serverDone := make(chan struct{})
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		defer close(serverDone)
		if r.URL.Path != "/events" {
			t.Error(r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, ": heartbeat\n\ndata: %s\n\ndata: %s\n\ndata: %s\n\n", a, b, b)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	if hits.Load() != 0 || s.RelayStatus().State != "stopped" {
		t.Fatal("automatic startup")
	}
	if _, err := s.StartRelay(server.URL); err != nil {
		t.Fatal(err)
	}
	backendWait(t, func() bool { return s.RelayStatus().Received == 3 })
	if _, err := s.StartRelay(server.URL); err == nil {
		t.Fatal("second live start accepted")
	}
	got, err := s.Record(context.Background(), "streamed")
	if err != nil || len(got.Events) != 2 {
		t.Fatal(len(got.Events), err)
	}
	if got.Quality.Actions || got.Quality.Roster["me"] || got.Quality.Lead["enemy"] {
		t.Fatal("unverified relay claimed coverage")
	}
	stopped := s.StopRelay()
	if stopped.State != "stopped" || stopped.Imported != 2 {
		t.Fatal(stopped)
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("stop did not close stream")
	}
	if s.relayDone != nil || s.relayCancel != nil {
		t.Fatal("stop retained active task")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartRelay(server.URL); err == nil {
		t.Fatal("closed service started relay")
	}
}

func TestBackendRelayUnsupportedEndedAndErrors(t *testing.T) {
	for _, test := range []struct {
		name, content, body  string
		status               int
		unsupported, ignored int
	}{
		{"ignored", "application/x-ndjson", `{"payload":"secret-aes-key","src_ip":"203.0.113.5"}` + "\n", 200, 0, 1},
		{"invalid-battle", "application/x-ndjson", `{"opencode":"0x1324","content":"secret payload"}` + "\n", 200, 1, 0},
		{"html", "text/html", "secret payload", 200, 0, 0},
		{"failure", "application/x-ndjson", "secret payload", 500, 0, 0},
		{"oversize", "application/x-ndjson", strings.Repeat("x", battleRelayFrameLimit+1), 200, 0, 0},
		{"partial-sse", "text/event-stream", "data: {\"secret\":true}\n", 200, 1, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := backendService(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", test.content)
				w.WriteHeader(test.status)
				fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			if _, err := s.StartRelay(server.URL); err != nil {
				t.Fatal(err)
			}
			backendWait(t, func() bool { return s.RelayStatus().State == "error" })
			status := s.RelayStatus()
			if status.Unsupported != test.unsupported || status.Ignored != test.ignored || status.Error == "" {
				t.Fatal(status)
			}
			data, _ := json.Marshal(status)
			if strings.Contains(string(data), "secret") || strings.Contains(string(data), "203.0.113.5") {
				t.Fatal("raw relay data leaked", string(data))
			}
			s.StopRelay()
		})
	}
}

func TestBackendRelayRedirectAndConnectCancellation(t *testing.T) {
	var followed atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer redirect.Close()
	s := backendService(t)
	if _, err := s.StartRelay(redirect.URL); err != nil {
		t.Fatal(err)
	}
	backendWait(t, func() bool { return s.RelayStatus().State == "error" })
	if followed.Load() != 0 {
		t.Fatal("redirect followed")
	}
	s.StopRelay()
	connected := make(chan struct{})
	ended := make(chan struct{})
	hanging := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(connected)
		defer close(ended)
		<-r.Context().Done()
	}))
	defer hanging.Close()
	if _, err := s.StartRelay(hanging.URL); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(time.Second):
		t.Fatal("not connected")
	}
	start := time.Now()
	s.StopRelay()
	if time.Since(start) > time.Second {
		t.Fatal("stop blocked on headers")
	}
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("connect cancellation leaked request")
	}
}

func TestBackendRelayNDJSONAtomicFailure(t *testing.T) {
	s := backendService(t)
	a := backendBattle(t, "existing")
	backendImport(t, s, a)
	bad := backendBattle(t, "existing")
	bad.Events[0].SkillID = 123
	batch, _ := json.Marshal([]BattleRecord{backendBattle(t, "not-committed"), bad})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprintf(w, "%s\n", batch)
	}))
	defer server.Close()
	if _, err := s.StartRelay(server.URL); err != nil {
		t.Fatal(err)
	}
	backendWait(t, func() bool { return s.RelayStatus().State == "error" })
	if _, err := s.Record(context.Background(), "not-committed"); err == nil {
		t.Fatal("relay frame partially committed")
	}
	s.StopRelay()
}

func TestBackendRelayRKPPFramesGroupedByExplicitBattleID(t *testing.T) {
	s := backendService(t)
	const firstID, secondID, unfinishedID, wrongFinishID = "9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"
	// Preserve numeric-64 tokens while adding forbidden envelope fields. They
	// must never enter normalized records or relay diagnostics.
	privateFrame := func(frame []byte) []byte {
		return append([]byte(`{"key":"secret","src_ip":"203.0.113.77","flow_id":"must-not-guess-most-recent-battle",`), frame[1:]...)
	}
	command := liveTestCommand(7, liveTestCast(1, 1, 700001000))
	prefix := [][]byte{privateFrame(liveTestStart(firstID)), privateFrame(command), liveTestFinish(wrongFinishID, 12, 0)}
	suffix := [][]byte{
		liveTestFinish(firstID, 12, 0),
		liveTestStart(firstID), command, liveTestFinish(firstID, 12, 0), // exact replay
		liveTestStart(secondID), liveTestFinish(secondID, 11, 0),
		liveTestStart(unfinishedID),
		[]byte(`{"payload":"secret-aes-key","src_ip":"203.0.113.77"}`),
	}
	resume := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ndjson")
		for _, frame := range prefix {
			fmt.Fprintf(w, "%s\n", frame)
		}
		w.(http.Flusher).Flush()
		select {
		case <-resume:
		case <-r.Context().Done():
			return
		}
		for _, frame := range suffix {
			fmt.Fprintf(w, "%s\n", frame)
		}
	}))
	defer server.Close()
	defer s.StopRelay()
	if _, err := s.StartRelay(server.URL); err != nil {
		t.Fatal(err)
	}
	backendWait(t, func() bool { return s.RelayStatus().Received == len(prefix) })
	beforeFinish := s.RelayStatus()
	if beforeFinish.Completed != 0 || beforeFinish.Imported != 0 || beforeFinish.Pending != 1 {
		t.Fatal("opening or mismatched finish committed a battle", beforeFinish)
	}
	for _, id := range []string{firstID, wrongFinishID} {
		if _, err := s.Record(context.Background(), "rkpp:"+id); !errors.Is(err, errBattleNotFound) {
			t.Fatal("battle stored without matching completed lifecycle", err)
		}
	}
	close(resume)
	backendWait(t, func() bool { return s.RelayStatus().State == "error" })
	status := s.RelayStatus()
	if status.Received != len(prefix)+len(suffix) || status.Completed != 2 || status.Imported != 2 || status.Updated != 0 || status.Pending != 1 || status.Ignored != 1 || status.Unsupported != 0 {
		t.Fatal(status)
	}
	for _, id := range []string{firstID, secondID} {
		saved, err := s.Record(context.Background(), "rkpp:"+id)
		if err != nil || saved.ID != "rkpp:"+id || saved.Source != "rkpp-live-v1" || saved.Rounds != 2 || saved.DurationSeconds == nil || *saved.DurationSeconds != 20 {
			t.Fatal("completed battles lost their distinct identity or finish", err)
		}
		data, _ := json.Marshal(saved)
		if strings.Contains(string(data), "secret") || strings.Contains(string(data), "203.0.113.77") || strings.Contains(string(data), "flow_id") {
			t.Fatal("raw envelope fields retained")
		}
		if saved.Quality.Actions || saved.Quality.Roster["enemy"] {
			t.Fatal("unverified actions or unmapped roster asserted coverage")
		}
		if id == firstID {
			casts := 0
			for _, event := range saved.Events {
				if event.ProtocolSkillID == "700001000" {
					casts++
				}
			}
			if casts != 1 {
				t.Fatal("replay duplicated execution evidence", casts)
			}
		}
	}
	for _, id := range []string{unfinishedID, wrongFinishID} {
		if _, err := s.Record(context.Background(), "rkpp:"+id); !errors.Is(err, errBattleNotFound) {
			t.Fatal("unfinished or orphan settlement was committed", err)
		}
	}
	data, _ := json.Marshal(status)
	if strings.Contains(string(data), "secret") || strings.Contains(string(data), "203.0.113.77") || strings.Contains(string(data), "flow_id") {
		t.Fatal("raw envelope fields entered relay status")
	}
	listed, err := s.List(context.Background(), BattleFilter{}, 1, 25)
	if err != nil || listed.Total != 2 {
		t.Fatal("replay created extra battles", listed.Total, err)
	}
}
