package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type tunnelReceipt struct {
	Digest string `json:"digest"`
	Result Result `json:"result"`
}

type tunnelDiskState struct {
	SchemaVersion int                      `json:"schemaVersion"`
	Resources     map[string]tunnelDesired `json:"resources"`
	Requests      map[string]tunnelReceipt `json:"requests"`
}

type tunnelProcess struct {
	command *exec.Cmd
	done    chan struct{}
}

func (p *tunnelProcess) running() bool {
	if p == nil {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *tunnelProcess) stop() {
	if !p.running() {
		return
	}
	tunnelTerminate(p.command.Process)
	select {
	case <-p.done:
	case <-time.After(2 * time.Second):
		_ = p.command.Process.Kill()
		<-p.done
	}
}

type tunnelRuntime struct {
	desired   tunnelDesired
	process   *tunnelProcess
	err       string
	attempts  int
	nextRetry time.Time
	started   time.Time
}

type gostTunnelManager struct {
	mu         sync.Mutex
	dir        string
	state      tunnelDiskState
	runtimes   map[string]*tunnelRuntime
	binary     string
	binaryHash string
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
	closed     bool
}

func NewTunnelManager(stateDir string) (TunnelManager, error) {
	root, err := filepath.Abs(filepath.Join(stateDir, "tunnels"))
	if err != nil || os.MkdirAll(root, 0700) != nil {
		return nil, errors.New("cannot create tunnel state directory")
	}
	if err := os.Chmod(root, 0700); err != nil {
		return nil, errors.New("cannot protect tunnel state directory")
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := &gostTunnelManager{dir: root, runtimes: map[string]*tunnelRuntime{}, ctx: ctx, cancel: cancel, done: make(chan struct{}),
		state: tunnelDiskState{SchemaVersion: 1, Resources: map[string]tunnelDesired{}, Requests: map[string]tunnelReceipt{}}}
	data, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err == nil {
		if json.Unmarshal(data, &m.state) != nil || m.state.SchemaVersion != 1 || m.state.Resources == nil || m.state.Requests == nil {
			cancel()
			return nil, errors.New("invalid persisted tunnel state")
		}
		for id, d := range m.state.Resources {
			if id != d.ID || !tunnelUUIDPattern.MatchString(id) || !tunnelRevisionPattern.MatchString(d.Revision) || tunnelDigest([]byte(d.Config)) != d.Revision {
				cancel()
				return nil, errors.New("invalid persisted tunnel resource")
			}
			// An expired certificate or an address removed while offline is a
			// resource error, not a reason to prevent the whole agent starting.
			m.runtimes[id] = &tunnelRuntime{desired: d, err: "restoring tunnel listener"}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, errors.New("cannot read persisted tunnel state")
	}
	// Restore asynchronously: a release download or a temporarily occupied port
	// must not prevent the agent from connecting and reporting actual state.
	go m.supervise()
	return m, nil
}

func (m *gostTunnelManager) persist() error {
	data, err := json.Marshal(m.state)
	if err != nil {
		return errors.New("cannot encode tunnel state")
	}
	return tunnelWritePrivate(filepath.Join(m.dir, "state.json"), data)
}

func tunnelResult(command Command, status, message string) Result {
	exit := 0
	if status != "applied" {
		exit = 1
	}
	return Result{SchemaVersion: 1, RequestID: command.RequestID, Status: status, ExitCode: exit, Message: message, Revision: command.ExpectedRevision}
}

func tunnelStringParam(command Command, key string) (string, bool) {
	raw, ok := command.Params[key]
	var value string
	if !ok || json.Unmarshal(raw, &value) != nil {
		return "", false
	}
	return value, true
}

// Lookup lets the agent replay a durable result before rechecking the unrelated
// vpsctl revision. A repeated request must not become a new mutation after reboot.
func (m *gostTunnelManager) Lookup(command Command) (Result, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	receipt, ok := m.state.Requests[command.RequestID]
	if !ok {
		return Result{}, false, nil
	}
	data, _ := json.Marshal(command)
	if receipt.Digest != tunnelDigest(data) {
		return tunnelResult(command, "conflict", "request ID already belongs to another tunnel command"), true, nil
	}
	return receipt.Result, true, nil
}

func (m *gostTunnelManager) record(command Command, digest string, result Result) (Result, error) {
	m.state.Requests[command.RequestID] = tunnelReceipt{Digest: digest, Result: result}
	if err := m.persist(); err != nil {
		delete(m.state.Requests, command.RequestID)
		return tunnelResult(command, "unknown", "could not persist tunnel command result"), err
	}
	return result, nil
}

func (m *gostTunnelManager) Apply(ctx context.Context, command Command) (Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return tunnelResult(command, "failed", "tunnel manager is closed"), nil
	}
	if command.SchemaVersion != 1 || len(command.RequestID) == 0 || len(command.RequestID) > 128 || (command.Action != "tunnel.apply" && command.Action != "tunnel.delete") {
		return tunnelResult(command, "failed", "invalid tunnel command"), nil
	}
	data, _ := json.Marshal(command)
	digest := tunnelDigest(data)
	if receipt, ok := m.state.Requests[command.RequestID]; ok {
		if receipt.Digest != digest {
			return tunnelResult(command, "conflict", "request ID already belongs to another tunnel command"), nil
		}
		return receipt.Result, nil
	}
	id, idOK := tunnelStringParam(command, "id")
	expected, expectedOK := tunnelStringParam(command, "expected-tunnel-revision")
	if !idOK || !tunnelUUIDPattern.MatchString(id) || !expectedOK || (expected != "" && !tunnelRevisionPattern.MatchString(expected)) {
		return tunnelResult(command, "failed", "invalid tunnel identity or expected revision"), nil
	}
	old := m.runtimes[id]
	current := ""
	if old != nil {
		current = old.desired.Revision
	}
	if expected != current {
		return m.record(command, digest, tunnelResult(command, "conflict", "tunnel configuration changed; refresh its revision"))
	}
	if err := ctx.Err(); err != nil {
		return m.record(command, digest, tunnelResult(command, "failed", "tunnel command cancelled"))
	}
	if command.Action == "tunnel.delete" {
		for key := range command.Params {
			if key != "id" && key != "expected-tunnel-revision" {
				return tunnelResult(command, "failed", "unsupported tunnel deletion parameter"), nil
			}
		}
		if old != nil {
			old.process.stop()
		}
		delete(m.state.Resources, id)
		result, err := m.record(command, digest, tunnelResult(command, "applied", "tunnel listener removed"))
		if err != nil {
			m.restore(old)
			return result, err
		}
		delete(m.runtimes, id)
		// id has been validated and this directory is owned solely by this runtime.
		if os.RemoveAll(filepath.Join(m.dir, "resources", id)) != nil {
			return result, errors.New("listener removed but private tunnel files could not be cleaned")
		}
		return result, nil
	}
	for key := range command.Params {
		if key != "id" && key != "expected-tunnel-revision" && key != "role" && key != "revision" && key != "config" {
			return tunnelResult(command, "failed", "unsupported tunnel application parameter"), nil
		}
	}
	role, roleOK := tunnelStringParam(command, "role")
	revision, revisionOK := tunnelStringParam(command, "revision")
	config, configOK := tunnelStringParam(command, "config")
	desired := tunnelDesired{ID: id, Role: role, Revision: revision, Config: config}
	if !roleOK || !revisionOK || !configOK {
		return m.record(command, digest, tunnelResult(command, "failed", "missing tunnel configuration"))
	}
	if _, err := desired.validate(); err != nil {
		return m.record(command, digest, tunnelResult(command, "failed", err.Error()))
	}
	if old != nil && old.desired == desired && old.process.running() {
		return m.record(command, digest, tunnelResult(command, "applied", "tunnel listener already running; end-to-end connectivity is not verified"))
	}
	if err := m.ensureBinary(ctx); err != nil {
		return m.record(command, digest, tunnelResult(command, "failed", err.Error()))
	}
	// Validate GOST parsing before stopping the previous resource. -O only emits
	// normalized configuration; both streams are discarded because they contain secrets.
	path, endpoints, err := desired.render(m.resourceDir(desired))
	if err == nil {
		err = m.validateGOST(ctx, path)
	}
	if err != nil {
		m.cleanCandidate(desired, old)
		return m.record(command, digest, tunnelResult(command, "failed", err.Error()))
	}
	if old != nil {
		old.process.stop()
	}
	process, err := m.start(ctx, path, endpoints)
	if err != nil {
		m.restore(old)
		m.cleanCandidate(desired, old)
		message := err.Error()
		if old != nil && !old.process.running() {
			message += "; previous listener also failed to restart"
		}
		return m.record(command, digest, tunnelResult(command, "failed", message))
	}
	run := &tunnelRuntime{desired: desired, process: process, started: time.Now()}
	m.state.Resources[id] = desired
	result, err := m.record(command, digest, tunnelResult(command, "applied", "tunnel listener running; end-to-end connectivity is not verified"))
	if err != nil {
		process.stop()
		delete(m.state.Resources, id)
		m.restore(old)
		m.cleanCandidate(desired, old)
		return result, err
	}
	m.runtimes[id] = run
	if old != nil && old.desired.Revision != revision {
		_ = os.RemoveAll(m.resourceDir(old.desired))
	}
	return result, nil
}

func (m *gostTunnelManager) resourceDir(d tunnelDesired) string {
	return filepath.Join(m.dir, "resources", d.ID, d.Revision)
}

func (m *gostTunnelManager) cleanCandidate(d tunnelDesired, old *tunnelRuntime) {
	if old == nil || d.Revision != old.desired.Revision {
		_ = os.RemoveAll(m.resourceDir(d))
	}
}

func (m *gostTunnelManager) ensureBinary(ctx context.Context) error {
	if m.binary != "" {
		if digest, err := tunnelFileDigest(m.binary); err == nil && digest == m.binaryHash {
			return nil
		}
		return errors.New("installed GOST binary checksum changed")
	}
	var err error
	m.binary, m.binaryHash, err = tunnelInstall(ctx, m.dir)
	return err
}

func (m *gostTunnelManager) validateGOST(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.binary, "-C", path, "-O", "json")
	cmd.Dir = filepath.Dir(path)
	cmd.Env = append(os.Environ(), "HOME="+filepath.Dir(path))
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	tunnelConfigureProcess(cmd)
	if cmd.Run() != nil {
		return errors.New("GOST configuration validation failed")
	}
	return nil
}

func (m *gostTunnelManager) start(ctx context.Context, path string, endpoints []tunnelEndpoint) (*tunnelProcess, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.New("tunnel command cancelled")
	}
	if err := m.ensureBinary(ctx); err != nil {
		return nil, err
	}
	cmd := exec.Command(m.binary, "-C", path)
	cmd.Dir = filepath.Dir(path)
	// Official GOST persists its fallback certificate under HOME/.gost. Keep
	// that state inside this resource instead of touching the machine user's home.
	cmd.Env = append(os.Environ(), "HOME="+filepath.Dir(path))
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	tunnelConfigureProcess(cmd)
	if cmd.Start() != nil {
		return nil, errors.New("GOST process could not start")
	}
	p := &tunnelProcess{command: cmd, done: make(chan struct{})}
	go func() { _ = cmd.Wait(); close(p.done) }()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-p.done:
			return nil, errors.New("GOST listener startup failed; check address and port conflicts")
		case <-ctx.Done():
			p.stop()
			return nil, errors.New("tunnel command cancelled")
		case <-deadline.C:
			p.stop()
			return nil, errors.New("GOST listener readiness timed out")
		case <-ticker.C:
			if tunnelOwnsListeners(cmd.Process.Pid, endpoints) && p.running() {
				return p, nil
			}
		}
	}
}

func (m *gostTunnelManager) restore(old *tunnelRuntime) {
	if old == nil {
		return
	}
	m.state.Resources[old.desired.ID] = old.desired
	ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
	defer cancel()
	path, endpoints, err := old.desired.render(m.resourceDir(old.desired))
	if err == nil {
		old.process, err = m.start(ctx, path, endpoints)
	}
	if err != nil {
		old.err = "previous tunnel listener could not be restored"
		old.nextRetry = time.Now().Add(time.Second)
	} else {
		old.err, old.attempts, old.started = "", 0, time.Now()
	}
}

func (m *gostTunnelManager) supervise() {
	defer close(m.done)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			for _, run := range m.runtimes {
				if run.process.running() {
					if time.Since(run.started) > time.Minute {
						run.attempts = 0
					}
					continue
				}
				if run.attempts >= 5 {
					run.err = "tunnel restart limit reached; apply again after resolving the cause"
					continue
				}
				if time.Now().Before(run.nextRetry) {
					continue
				}
				run.attempts++
				ctx, cancel := context.WithTimeout(m.ctx, 2*time.Minute)
				err := m.ensureBinary(ctx)
				if err == nil {
					var path string
					var endpoints []tunnelEndpoint
					path, endpoints, err = run.desired.render(m.resourceDir(run.desired))
					if err == nil {
						run.process, err = m.start(ctx, path, endpoints)
					}
				}
				cancel()
				run.nextRetry = time.Now().Add(time.Second * time.Duration(1<<uint(run.attempts-1)))
				if err != nil {
					run.err = err.Error()
				} else {
					run.err, run.started = "", time.Now()
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *gostTunnelManager) Status() []TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	statuses := make([]TunnelStatus, 0, len(m.runtimes))
	for id, run := range m.runtimes {
		running, message := run.process.running(), run.err
		if !running && message == "" {
			message = "tunnel process stopped; awaiting restart"
		}
		statuses = append(statuses, TunnelStatus{ID: id, Revision: run.desired.Revision, Running: running, Error: message})
	}
	sort.Slice(statuses, func(i, j int) bool { return statuses[i].ID < statuses[j].ID })
	return statuses
}

func (m *gostTunnelManager) Close() error {
	m.cancel()
	m.mu.Lock()
	if !m.closed {
		m.closed = true
		for _, run := range m.runtimes {
			run.process.stop()
		}
	}
	m.mu.Unlock()
	<-m.done
	return nil
}
