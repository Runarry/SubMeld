package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type panelAPI interface {
	poll(context.Context) (*Command, error)
	result(context.Context, Result) error
	report(context.Context, string, Snapshot, []TunnelStatus) error
}

type pendingRequest struct {
	Command Command `json:"command"`
	Result  *Result `json:"result,omitempty"`
}

type receipt struct {
	CommandHash string `json:"commandHash"`
	Result      Result `json:"result"`
}

type agent struct {
	publishMu sync.Mutex
	stateDir  string
	bootID    string
	panel     panelAPI
	machine   machineControl
	tunnels   TunnelManager
	logger    *log.Logger
}

func commandHash(command Command) string {
	data, _ := json.Marshal(command)
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (a *agent) pendingPath() string { return filepath.Join(a.stateDir, "active.json") }
func (a *agent) receiptPath(id string) string {
	return filepath.Join(a.stateDir, "results", strings.ToLower(id)+".json")
}

func (a *agent) loadPending() (*pendingRequest, error) {
	data, err := readLimitedFile(a.pendingPath(), maxPayload+maxCommand)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var pending pendingRequest
	if err != nil || decodeJSON(data, &pending, true) != nil || validateCommand(pending.Command) != nil {
		return nil, errors.New("cannot read pending command; preserve state and repair before continuing")
	}
	if pending.Result != nil && validateResult(*pending.Result, pending.Command.RequestID) != nil {
		return nil, errors.New("pending command has an invalid result")
	}
	return &pending, nil
}

func (a *agent) begin(command Command) (*pendingRequest, error) {
	if err := validateCommand(command); err != nil {
		return nil, err
	}
	pending := &pendingRequest{Command: command}
	data, err := readLimitedFile(a.receiptPath(command.RequestID), maxPayload)
	if err == nil {
		var old receipt
		if decodeJSON(data, &old, true) != nil || validateResult(old.Result, command.RequestID) != nil {
			return nil, errors.New("cannot read saved command receipt")
		}
		if old.CommandHash != commandHash(command) {
			return nil, errors.New("request ID was reused with different command content")
		}
		pending.Result = &old.Result
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("cannot inspect saved command receipt")
	}
	if err := writeJSONPrivate(a.pendingPath(), pending); err != nil {
		return nil, errors.New("cannot persist pending command")
	}
	return pending, nil
}

func (a *agent) execute(ctx context.Context, command Command) (Result, error) {
	var result Result
	var err error
	if strings.HasPrefix(command.Action, "tunnel.") {
		if lookup, ok := a.tunnels.(interface {
			Lookup(Command) (Result, bool, error)
		}); ok {
			saved, found, lookupErr := lookup.Lookup(command)
			if lookupErr != nil {
				return result, lookupErr
			}
			if found {
				return saved, validateResult(saved, command.RequestID)
			}
		}
		// The tunnel manager owns its own request journal. It must check that
		// journal before applying a repeated request, even after a restart.
		snapshot, snapshotErr := a.machine.Snapshot(ctx)
		if snapshotErr != nil {
			return result, snapshotErr
		}
		revision, _ := validateSnapshot(snapshot)
		if revision != command.ExpectedRevision {
			result = Result{SchemaVersion: 1, RequestID: command.RequestID, Status: "conflict", ExitCode: 23,
				Message: "Machine configuration changed; refresh before retrying", Revision: revision, Snapshot: snapshot}
		} else {
			result, err = a.tunnels.Apply(ctx, command)
		}
	} else {
		var found bool
		result, found, err = a.machine.Result(ctx, command.RequestID)
		if err == nil && !found {
			result, err = a.machine.Apply(ctx, command)
		}
		if err != nil && ctx.Err() == nil {
			// The helper may have finished before the pipe/connection failed.
			// Recover its persisted result instead of running the operation again.
			if recovered, exists, lookupErr := a.machine.Result(ctx, command.RequestID); lookupErr == nil && exists {
				result, err = recovered, nil
			}
		}
	}
	if err != nil {
		return Result{}, err
	}
	if err = validateResult(result, command.RequestID); err != nil {
		return Result{}, err
	}
	if len(result.Snapshot) == 0 {
		if snapshot, snapshotErr := a.machine.Snapshot(ctx); snapshotErr == nil {
			// Keep the execution revision and only attach a matching snapshot;
			// a later local edit is reported separately as the current state.
			if revision, _ := validateSnapshot(snapshot); revision == result.Revision {
				result.Snapshot = snapshot
			}
		}
	}
	return result, nil
}

func (a *agent) finish(ctx context.Context, pending *pendingRequest) error {
	if pending.Result == nil {
		result, err := a.execute(ctx, pending.Command)
		if err != nil {
			return err
		}
		if len(result.Snapshot) > 0 {
			result.Snapshot, err = withAgentCapabilities(result.Snapshot)
			if err != nil {
				return err
			}
		}
		pending.Result = &result
		if err := writeJSONPrivate(a.pendingPath(), pending); err != nil {
			return errors.New("cannot persist command result")
		}
	}
	// Persist again before any send, including after a failed previous fsync.
	if err := writeJSONPrivate(a.pendingPath(), pending); err != nil {
		return errors.New("cannot persist result outbox")
	}
	a.publishMu.Lock()
	err := a.panel.result(ctx, *pending.Result)
	a.publishMu.Unlock()
	if err != nil {
		return err
	}
	compact := *pending.Result
	compact.Snapshot = nil
	if err := writeJSONPrivate(a.receiptPath(pending.Command.RequestID), receipt{CommandHash: commandHash(pending.Command), Result: compact}); err != nil {
		return errors.New("cannot save acknowledged result")
	}
	if err := os.Remove(a.pendingPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.New("cannot clear acknowledged outbox")
	}
	return syncDirectory(a.stateDir)
}

func waitRetry(ctx context.Context, attempt int) error {
	if attempt > 6 {
		attempt = 6
	}
	delay := min(time.Second<<attempt, 60*time.Second)
	delay = time.Duration(float64(delay) * (0.8 + rand.Float64()*0.4))
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (a *agent) deliver(ctx context.Context, pending *pendingRequest) error {
	for attempt := 0; ; attempt++ {
		if err := a.finish(ctx, pending); err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		a.logger.Print("command is pending; retrying execution receipt or delivery")
		if err := waitRetry(ctx, attempt); err != nil {
			return err
		}
	}
}

func (a *agent) reportOnce(ctx context.Context) error {
	// Snapshot capture and publication share ordering with result delivery;
	// an older in-flight report must finish before a newer result is sent.
	a.publishMu.Lock()
	defer a.publishMu.Unlock()
	snapshot, err := a.machine.Snapshot(ctx)
	if err != nil {
		return err
	}
	snapshot, err = withAgentCapabilities(snapshot)
	if err != nil {
		return err
	}
	return a.panel.report(ctx, a.bootID, snapshot, a.tunnels.Status())
}

func (a *agent) run(ctx context.Context) error {
	pending, err := a.loadPending()
	if err != nil {
		return err
	}
	// A previous process's durable result always precedes reporting and polling.
	if pending != nil {
		if err := a.deliver(ctx, pending); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	workers.Go(func() {
		for {
			if err := a.reportOnce(ctx); err != nil && ctx.Err() == nil {
				a.logger.Print("machine snapshot report failed; previous panel snapshot retained")
			}
			timer := time.NewTimer(30 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	})
	for attempt := 0; ctx.Err() == nil; {
		command, err := a.panel.poll(ctx)
		if err != nil {
			a.logger.Print("panel command poll failed; reconnecting")
			if err = waitRetry(ctx, attempt); err != nil {
				return err
			}
			attempt++
			continue
		}
		attempt = 0
		if command == nil {
			// Bound traffic even if a server returns an immediate empty poll.
			if err = waitRetry(ctx, 0); err != nil {
				return err
			}
			continue
		}
		pending, err = a.begin(*command)
		if err != nil {
			return err
		}
		if err = a.deliver(ctx, pending); err != nil {
			return err
		}
	}
	return ctx.Err()
}
