package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const agentTestID = "f304002a-1059-4e32-b9fa-1c53be731dd1"

var agentTestRevision = strings.Repeat("a", 64)

func agentTestCommand() Command {
	return Command{SchemaVersion: 1, RequestID: agentTestID, ExpectedRevision: agentTestRevision,
		Action: "core.restart", Params: map[string]json.RawMessage{"core": json.RawMessage(`"xray"`)}}
}

func agentTestSnapshot() Snapshot {
	return Snapshot(`{"schemaVersion":1,"revision":"` + agentTestRevision + `","vpsctlVersion":"test","capabilities":{"actions":[],"profiles":[]},"cores":[],"nodes":[],"relay":{"exits":[],"bindings":[],"forwards":[]},"exports":[],"pendingCores":[],"nativeExtra":{"secret":"never-log-me"}}`)
}

func agentTestResult() Result {
	return Result{SchemaVersion: 1, RequestID: agentTestID, Status: "applied", Revision: agentTestRevision, Message: "done"}
}

type agentFakeMachine struct {
	applyCount  int
	result      Result
	found       bool
	snapshotErr error
}

func (m *agentFakeMachine) Snapshot(context.Context) (Snapshot, error) {
	return agentTestSnapshot(), m.snapshotErr
}
func (m *agentFakeMachine) Result(context.Context, string) (Result, bool, error) {
	return m.result, m.found, nil
}
func (m *agentFakeMachine) Apply(context.Context, Command) (Result, error) {
	m.applyCount++
	m.result, m.found = agentTestResult(), true
	return m.result, nil
}

type agentFakePanel struct {
	failure bool
	results []Result
	reports int
}

func (p *agentFakePanel) poll(ctx context.Context) (*Command, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func (p *agentFakePanel) result(_ context.Context, result Result) error {
	p.results = append(p.results, result)
	if p.failure {
		return errors.New("offline")
	}
	return nil
}
func (p *agentFakePanel) report(context.Context, string, Snapshot, []TunnelStatus) error {
	p.reports++
	return nil
}

type agentFakeTunnels struct {
	calls int
	saved *Result
}

func (t *agentFakeTunnels) Apply(context.Context, Command) (Result, error) {
	t.calls++
	return agentTestResult(), nil
}
func (*agentFakeTunnels) Status() []TunnelStatus { return nil }
func (*agentFakeTunnels) Close() error           { return nil }
func (t *agentFakeTunnels) Lookup(Command) (Result, bool, error) {
	if t.saved != nil {
		return *t.saved, true, nil
	}
	return Result{}, false, nil
}

func agentFixture(t *testing.T) (*agent, *agentFakeMachine, *agentFakePanel) {
	t.Helper()
	machine, panel := &agentFakeMachine{}, &agentFakePanel{}
	a := &agent{stateDir: t.TempDir(), bootID: agentTestID, machine: machine, panel: panel,
		tunnels: &agentFakeTunnels{}, logger: log.New(io.Discard, "", 0)}
	return a, machine, panel
}

func TestAgentOutboxRestartAndDuplicateNeverReexecute(t *testing.T) {
	a, machine, panel := agentFixture(t)
	panel.failure = true
	pending, err := a.begin(agentTestCommand())
	if err != nil {
		t.Fatal(err)
	}
	if err = a.finish(context.Background(), pending); err == nil {
		t.Fatal("offline send unexpectedly succeeded")
	}
	if machine.applyCount != 1 {
		t.Fatal("operation was not executed once")
	}
	// A replacement Agent only reads durable state; execution is already complete.
	restarted := &agent{stateDir: a.stateDir, bootID: a.bootID, machine: machine, panel: panel,
		tunnels: a.tunnels, logger: a.logger}
	pending, err = restarted.loadPending()
	if err != nil || pending == nil || pending.Result == nil {
		t.Fatalf("durable outbox missing: %v", err)
	}
	panel.failure = false
	if err = restarted.finish(context.Background(), pending); err != nil {
		t.Fatal(err)
	}
	if machine.applyCount != 1 {
		t.Fatal("restart repeated the operation")
	}
	if _, err = os.Stat(a.pendingPath()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("acknowledged outbox not cleared")
	}
	pending, err = restarted.begin(agentTestCommand())
	if err != nil {
		t.Fatal(err)
	}
	if err = restarted.finish(context.Background(), pending); err != nil {
		t.Fatal(err)
	}
	if machine.applyCount != 1 || len(panel.results) != 3 {
		t.Fatal("duplicate request did not reuse receipt")
	}
	stored, err := os.ReadFile(a.receiptPath(agentTestID))
	if err != nil || bytes.Contains(stored, []byte("never-log-me")) || bytes.Contains(stored, []byte("snapshot")) {
		t.Fatal("acknowledged receipt retains native snapshot")
	}
	changed := agentTestCommand()
	changed.Action = "core.stop"
	if _, err = a.begin(changed); err == nil {
		t.Fatal("reused request id with different content accepted")
	}
}

func TestAgentRestartRecoversVpsctlReceiptAndUnknown(t *testing.T) {
	for _, status := range []string{"applied", "unknown"} {
		t.Run(status, func(t *testing.T) {
			a, machine, panel := agentFixture(t)
			_, err := a.begin(agentTestCommand())
			if err != nil {
				t.Fatal(err)
			}
			machine.found, machine.result = true, agentTestResult()
			machine.result.Status = status
			pending, err := a.loadPending()
			if err != nil {
				t.Fatal(err)
			}
			if err = a.finish(context.Background(), pending); err != nil {
				t.Fatal(err)
			}
			if machine.applyCount != 0 || len(panel.results) != 1 || panel.results[0].Status != status {
				t.Fatal("existing receipt was reexecuted or changed")
			}
		})
	}
}

func TestAgentSnapshotFailureNeverReportsEmptyState(t *testing.T) {
	a, machine, panel := agentFixture(t)
	machine.snapshotErr = errors.New("helper failed")
	if a.reportOnce(context.Background()) == nil || panel.reports != 0 {
		t.Fatal("snapshot error was reported as a state update")
	}
	for _, payload := range []string{`{}`, `null`, `{"schemaVersion":1,"revision":"` + agentTestRevision + `"}`} {
		if _, err := validateSnapshot(Snapshot(payload)); err == nil {
			t.Fatal("partial snapshot accepted")
		}
	}
	if _, err := validateSnapshot(agentTestSnapshot()); err != nil {
		t.Fatal(err)
	}
	enriched, err := withAgentCapabilities(agentTestSnapshot())
	if err != nil || !bytes.Contains(enriched, []byte("tunnel.apply")) || !bytes.Contains(enriched, []byte("never-log-me")) {
		t.Fatal("Agent capabilities lost native fields")
	}
	if revision, err := validateSnapshot(enriched); err != nil || revision != agentTestRevision {
		t.Fatal("capabilities changed native revision")
	}
}

func TestAgentTunnelRevisionAndSavedReceipt(t *testing.T) {
	a, _, _ := agentFixture(t)
	command := agentTestCommand()
	command.Action = "tunnel.apply"
	command.ExpectedRevision = strings.Repeat("b", 64)
	result, err := a.execute(context.Background(), command)
	if err != nil || result.Status != "conflict" {
		t.Fatalf("stale revision allowed: %v", err)
	}
	tunnels := a.tunnels.(*agentFakeTunnels)
	if tunnels.calls != 0 {
		t.Fatal("stale tunnel was applied")
	}
	saved := agentTestResult()
	tunnels.saved = &saved
	result, err = a.execute(context.Background(), command)
	if err != nil || result.Status != "applied" || tunnels.calls != 0 {
		t.Fatal("saved tunnel receipt lost to newer machine revision")
	}
}

type agentPublishingMachine struct {
	snapshotCaptured chan struct{}
	releaseSnapshot  chan struct{}
	applied          chan struct{}
	newRevision      string
}

func (m *agentPublishingMachine) Snapshot(ctx context.Context) (Snapshot, error) {
	// Capture the old state before a mutation, then delay returning it.
	snapshot := agentTestSnapshot()
	close(m.snapshotCaptured)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-m.releaseSnapshot:
		return snapshot, nil
	}
}

func (*agentPublishingMachine) Result(context.Context, string) (Result, bool, error) {
	return Result{}, false, nil
}

func (m *agentPublishingMachine) Apply(context.Context, Command) (Result, error) {
	result := agentTestResult()
	result.Revision = m.newRevision
	result.Snapshot = bytes.ReplaceAll(agentTestSnapshot(), []byte(agentTestRevision), []byte(m.newRevision))
	close(m.applied)
	return result, nil
}

func TestAgentReportCannotOverwriteNewerResult(t *testing.T) {
	for _, delayedStage := range []string{"snapshot", "http"} {
		t.Run(delayedStage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			machine := &agentPublishingMachine{snapshotCaptured: make(chan struct{}), releaseSnapshot: make(chan struct{}),
				applied: make(chan struct{}), newRevision: strings.Repeat("b", 64)}
			reportStarted, resultStarted := make(chan struct{}), make(chan struct{})
			releaseReport := make(chan struct{})
			events := make(chan string, 2)
			if delayedStage == "snapshot" {
				close(releaseReport)
			} else {
				close(machine.releaseSnapshot)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/agent/report":
					var payload struct {
						Snapshot Snapshot `json:"snapshot"`
					}
					if json.NewDecoder(r.Body).Decode(&payload) != nil {
						t.Error("invalid report payload")
					}
					close(reportStarted)
					select {
					case <-r.Context().Done():
						return
					case <-releaseReport:
					}
					revision, _ := validateSnapshot(payload.Snapshot)
					events <- "report:" + revision
				case "/api/agent/results":
					close(resultStarted)
					var payload struct {
						Result Result `json:"result"`
					}
					if json.NewDecoder(r.Body).Decode(&payload) != nil {
						t.Error("invalid result payload")
					}
					events <- "result:" + payload.Result.Revision
				default:
					t.Error("unexpected panel request")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer func() { cancel(); server.Close() }()
			client := newPanelClient(Config{Server: server.URL, MachineID: agentTestID, Token: "unit-test-token-value"})
			defer client.http.CloseIdleConnections()
			a := &agent{stateDir: t.TempDir(), bootID: agentTestID, machine: machine, panel: client,
				tunnels: &agentFakeTunnels{}, logger: log.New(io.Discard, "", 0)}
			pending, err := a.begin(agentTestCommand())
			if err != nil {
				t.Fatal(err)
			}
			reportDone, finishDone := make(chan error, 1), make(chan error, 1)
			go func() { reportDone <- a.reportOnce(ctx) }()
			select {
			case <-machine.snapshotCaptured:
			case <-time.After(3 * time.Second):
				t.Fatal("report did not capture snapshot")
			}
			if delayedStage == "http" {
				select {
				case <-reportStarted:
				case <-time.After(3 * time.Second):
					t.Fatal("report HTTP request did not start")
				}
			}
			go func() { finishDone <- a.finish(ctx, pending) }()
			select {
			case <-machine.applied:
			case <-time.After(3 * time.Second):
				t.Fatal("report publication blocked native mutation execution")
			}
			select {
			case <-resultStarted:
				t.Fatal("new result overtook the older pending report")
			case <-time.After(100 * time.Millisecond):
			}
			if delayedStage == "snapshot" {
				close(machine.releaseSnapshot)
			} else {
				close(releaseReport)
			}
			for _, done := range []chan error{reportDone, finishDone} {
				select {
				case err := <-done:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(3 * time.Second):
					t.Fatal("publication did not finish after releasing its delay")
				}
			}
			if first, second := <-events, <-events; first != "report:"+agentTestRevision || second != "result:"+machine.newRevision {
				t.Fatalf("incorrect publication order: %s, %s", first, second)
			}
		})
	}
}

func TestAgentClientAuthorizationCancellationAndRedirect(t *testing.T) {
	token := "unit-test-token-not-secret"
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true); w.WriteHeader(200) }))
	defer target.Close()
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("missing authorization")
		}
		if strings.Contains(r.URL.RawQuery, "token") {
			t.Error("token present in query")
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, target.URL, 302)
			return
		}
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	client := newPanelClient(Config{Server: server.URL, MachineID: agentTestID, Token: token, AllowHTTP: true})
	defer client.http.CloseIdleConnections()
	if err := client.request(context.Background(), "GET", "/redirect", nil, nil, 1024); err == nil || leaked.Load() {
		t.Fatal("redirect followed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := client.poll(ctx); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("incorrect cancellation: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("poll did not stop")
	}
}

func TestAgentClientStrictSizeAndTLS(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, strings.Repeat("x", 2048)) }))
	defer server.Close()
	client := newPanelClient(Config{Server: server.URL, Token: "unit-test-token-value"})
	defer client.http.CloseIdleConnections()
	if client.request(context.Background(), "GET", "/", nil, nil, 1024) == nil {
		t.Fatal("oversized response accepted")
	}
	tlsServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer tlsServer.Close()
	client.config.Server = tlsServer.URL
	if client.request(context.Background(), "GET", "/", nil, nil, 1024) == nil {
		t.Fatal("untrusted TLS certificate accepted")
	}
}

func TestAgentVpsctlJSONFailureAndMissingReceipt(t *testing.T) {
	result := agentTestResult()
	result.Status = "failed"
	result.ExitCode = 9
	encoded, _ := json.Marshal(result)
	v := &vpsctl{path: "/test/vpsctl", run: func(_ context.Context, path string, args []string, input []byte) ([]byte, int, error) {
		if path != "/test/vpsctl" || !reflect.DeepEqual(args, []string{"--non-interactive", "service", "proxy", "machine", "apply"}) {
			t.Fatal("incorrect helper interface")
		}
		var received Command
		if json.Unmarshal(input, &received) != nil || received.RequestID != agentTestID {
			t.Fatal("command not provided on stdin")
		}
		return encoded, 9, errors.New("failed")
	}}
	got, err := v.Apply(context.Background(), agentTestCommand())
	if err != nil || got.Status != "failed" || got.ExitCode != 9 {
		t.Fatal("valid failed JSON discarded")
	}
	result.Status = "applied"
	encoded, _ = json.Marshal(result)
	got, err = v.Apply(context.Background(), agentTestCommand())
	if err != nil || got.Status != "unknown" {
		t.Fatal("nonzero exit was presented as success")
	}
	result.Status = "unknown"
	result.ExitCode = 30
	encoded, _ = json.Marshal(struct {
		Result
		Found bool `json:"found"`
	}{Result: result, Found: false})
	v.run = func(context.Context, string, []string, []byte) ([]byte, int, error) { return encoded, 0, nil }
	_, found, err := v.Result(context.Background(), agentTestID)
	if err != nil || found {
		t.Fatal("explicit missing receipt did not permit apply")
	}
	encoded, _ = json.Marshal(result)
	_, found, err = v.Result(context.Background(), agentTestID)
	if err != nil || !found {
		t.Fatal("recorded unknown was confused with missing")
	}
}

func TestAgentSetupPreservesIdentityAndRotatesToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	args := []string{"setup", "--config", path, "--server", "https://panel.example", "--token-stdin", "--state-dir", dir, "--vpsctl", filepath.Join(dir, "vpsctl")}
	var output bytes.Buffer
	if err := runCLI(args, strings.NewReader("first-unit-test-token"), &output); err != nil {
		t.Fatal(err)
	}
	first, err := loadConfig(path)
	if err != nil || !uuidPattern.MatchString(first.MachineID) {
		t.Fatal("identity not persisted")
	}
	if err = runCLI([]string{"setup", "--config", path, "--token-stdin"}, strings.NewReader("second-unit-test-token"), &output); err != nil {
		t.Fatal(err)
	}
	second, err := loadConfig(path)
	if err != nil || second.MachineID != first.MachineID || second.Token != "second-unit-test-token" || second.Server != first.Server {
		t.Fatal("rotation changed identity or unrelated fields")
	}
	if strings.Contains(output.String(), "token") {
		t.Fatal("setup printed token")
	}
	second.Server = "http://panel.example"
	if second.validate() == nil {
		t.Fatal("implicit insecure HTTP accepted")
	}
	second.AllowHTTP = true
	if second.validate() != nil {
		t.Fatal("explicit local HTTP rejected")
	}
	second.Server = "https://name:password@panel.example"
	if second.validate() == nil {
		t.Fatal("URL credentials accepted")
	}
	if err := bindStateIdentity(dir, first.MachineID); err != nil {
		t.Fatal(err)
	}
	if err := bindStateIdentity(dir, first.MachineID); err != nil {
		t.Fatal(err)
	}
	if err := bindStateIdentity(dir, agentTestID); err == nil {
		t.Fatal("outbox accepted a different machine identity")
	}
}

func TestAgentCertificateHasVerifiedServerIdentity(t *testing.T) {
	pair, err := generateCertificate("relay.example")
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode([]byte(pair.CertificatePEM))
	if block == nil {
		t.Fatal("missing certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	if _, err = cert.Verify(x509.VerifyOptions{DNSName: "relay.example", Roots: roots}); err != nil {
		t.Fatal(err)
	}
	if _, err = cert.Verify(x509.VerifyOptions{DNSName: "other.example", Roots: roots}); err == nil {
		t.Fatal("wrong name accepted")
	}
	block, _ = pem.Decode([]byte(pair.PrivateKeyPEM))
	if block == nil {
		t.Fatal("missing private key")
	}
	if _, err = x509.ParsePKCS8PrivateKey(block.Bytes); err != nil {
		t.Fatal(err)
	}
}
