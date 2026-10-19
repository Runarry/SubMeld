package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

var actionNames = strings.Fields("core.install core.update core.start core.stop core.restart core.uninstall node.add node.edit node.delete node.switch node.ip-policy dns.set dns.reset exit.add exit.edit exit.delete binding.add binding.delete forward.add forward.edit forward.delete forward.refresh time.sync tunnel.apply tunnel.delete")
var parameterName = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

func validateCommand(c Command) error {
	if c.SchemaVersion != 1 || !uuidPattern.MatchString(c.RequestID) || !revisionPattern.MatchString(c.ExpectedRevision) {
		return errors.New("invalid command identity or revision")
	}
	found := false
	for _, action := range actionNames {
		found = found || c.Action == action
	}
	if !found {
		return errors.New("unsupported command action")
	}
	for name, raw := range c.Params {
		if !parameterName.MatchString(name) {
			return errors.New("invalid command parameter name")
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return errors.New("invalid command parameter")
		}
		switch v := value.(type) {
		case string:
			if len(v) > 65536 {
				return errors.New("command parameter is too long")
			}
		case float64, bool:
		case []any:
			if len(v) > 2000 {
				return errors.New("command parameter array is too long")
			}
			for _, item := range v {
				text, ok := item.(string)
				if !ok || len(text) > 65536 {
					return errors.New("invalid command parameter array")
				}
			}
		default:
			return errors.New("unsupported command parameter type")
		}
	}
	return nil
}

func validateSnapshot(data Snapshot) (string, error) {
	// Pointer fields distinguish a missing or null field from an empty real list.
	var s struct {
		SchemaVersion int     `json:"schemaVersion"`
		Revision      string  `json:"revision"`
		VpsctlVersion *string `json:"vpsctlVersion"`
		Capabilities  *struct {
			Actions  *[]string          `json:"actions"`
			Profiles *[]json.RawMessage `json:"profiles"`
		} `json:"capabilities"`
		Cores        *[]json.RawMessage `json:"cores"`
		Nodes        *[]json.RawMessage `json:"nodes"`
		Exports      *[]json.RawMessage `json:"exports"`
		PendingCores *[]string          `json:"pendingCores"`
		Relay        *struct {
			Exits    *[]json.RawMessage `json:"exits"`
			Bindings *[]json.RawMessage `json:"bindings"`
			Forwards *[]json.RawMessage `json:"forwards"`
		} `json:"relay"`
	}
	if len(data) > maxPayload || decodeJSON(data, &s, false) != nil || s.SchemaVersion != 1 || !revisionPattern.MatchString(s.Revision) ||
		s.VpsctlVersion == nil || s.Capabilities == nil || s.Capabilities.Actions == nil || s.Capabilities.Profiles == nil ||
		s.Cores == nil || s.Nodes == nil || s.Exports == nil || s.PendingCores == nil || s.Relay == nil ||
		s.Relay.Exits == nil || s.Relay.Bindings == nil || s.Relay.Forwards == nil {
		return "", errors.New("vpsctl did not provide a complete valid snapshot")
	}
	if len(*s.Cores) > 2 || len(*s.Nodes) > 2000 || len(*s.Exports) > 2000 || len(*s.PendingCores) > 2 || len(*s.Capabilities.Actions) > 100 || len(*s.Capabilities.Profiles) > 100 {
		return "", errors.New("snapshot exceeds item limits")
	}
	return s.Revision, nil
}

func withAgentCapabilities(data Snapshot) (Snapshot, error) {
	if _, err := validateSnapshot(data); err != nil {
		return nil, err
	}
	var snapshot map[string]json.RawMessage
	var capabilities map[string]json.RawMessage
	var actions []string
	if json.Unmarshal(data, &snapshot) != nil || json.Unmarshal(snapshot["capabilities"], &capabilities) != nil || json.Unmarshal(capabilities["actions"], &actions) != nil {
		return nil, errors.New("invalid snapshot capabilities")
	}
	for _, ownAction := range []string{"tunnel.apply", "tunnel.delete"} {
		found := false
		for _, action := range actions {
			found = found || ownAction == action
		}
		if !found {
			actions = append(actions, ownAction)
		}
	}
	capabilities["actions"], _ = json.Marshal(actions)
	snapshot["capabilities"], _ = json.Marshal(capabilities)
	// Keep native revision untouched: it is the vpsctl compare-and-swap token.
	return json.Marshal(snapshot)
}

func validateResult(r Result, id string) error {
	if r.SchemaVersion != 1 || r.RequestID != id || !revisionPattern.MatchString(r.Revision) || len(r.Message) > 2048 {
		return errors.New("invalid vpsctl result identity or revision")
	}
	switch r.Status {
	case "applied", "pending_restart", "conflict", "failed", "unknown":
	default:
		return errors.New("invalid vpsctl result status")
	}
	if len(r.Snapshot) > 0 {
		if _, err := validateSnapshot(r.Snapshot); err != nil {
			return err
		}
	}
	return nil
}

type machineControl interface {
	Snapshot(context.Context) (Snapshot, error)
	Result(context.Context, string) (Result, bool, error)
	Apply(context.Context, Command) (Result, error)
}

type commandRunner func(context.Context, string, []string, []byte) ([]byte, int, error)

type vpsctl struct {
	path string
	run  commandRunner
}

// An output cap prevents runaway helper output from exhausting Agent memory.
type cappedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if len(p) > b.limit-b.Len() {
		return 0, errors.New("vpsctl output exceeds limit")
	}
	return b.Buffer.Write(p)
}

func runVpsctl(ctx context.Context, path string, args []string, input []byte) ([]byte, int, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	configureChildProcess(cmd)
	cmd.Stdin = bytes.NewReader(input)
	output := &cappedBuffer{limit: maxPayload}
	cmd.Stdout, cmd.Stderr = output, io.Discard
	cmd.WaitDelay = 3 * time.Second
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		exitCode = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		// Never include subprocess stderr, argv, or raw stdout in an error.
		err = errors.New("vpsctl execution failed")
	}
	return output.Bytes(), exitCode, err
}

func (v *vpsctl) call(ctx context.Context, operation string, args []string, input []byte, timeout time.Duration) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	argv := append([]string{"--non-interactive", "service", "proxy", "machine", operation}, args...)
	return v.run(ctx, v.path, argv, input)
}

func (v *vpsctl) Snapshot(ctx context.Context) (Snapshot, error) {
	data, _, err := v.call(ctx, "snapshot", nil, nil, 30*time.Second)
	if err != nil {
		return nil, err
	}
	if _, err = validateSnapshot(data); err != nil {
		return nil, err
	}
	return Snapshot(data), nil
}

func (v *vpsctl) Result(ctx context.Context, id string) (Result, bool, error) {
	var result Result
	data, _, err := v.call(ctx, "result", []string{"--id", id}, nil, 30*time.Second)
	if decodeJSON(data, &result, false) != nil || validateResult(result, id) != nil {
		return result, false, errors.New("vpsctl result lookup returned no valid receipt")
	}
	if err != nil && (result.Status == "applied" || result.Status == "pending_restart") {
		return result, false, errors.New("vpsctl result lookup failed despite success payload")
	}
	var envelope struct {
		Found *bool `json:"found"`
	}
	if decodeJSON(data, &envelope, false) != nil {
		return result, false, errors.New("invalid vpsctl result lookup envelope")
	}
	// Only an explicit missing receipt permits apply. Recorded unknown outcomes
	// must be returned to the panel, never interpreted as permission to reexecute.
	if envelope.Found != nil && !*envelope.Found {
		if err != nil || result.Status != "unknown" || result.ExitCode != 30 {
			return result, false, errors.New("inconsistent missing vpsctl receipt")
		}
		return result, false, nil
	}
	return result, true, nil
}

func (v *vpsctl) Apply(ctx context.Context, command Command) (Result, error) {
	data, err := json.Marshal(command)
	if err != nil {
		return Result{}, err
	}
	data, exitCode, runErr := v.call(ctx, "apply", nil, data, 15*time.Minute)
	var result Result
	if decodeJSON(data, &result, false) != nil || validateResult(result, command.RequestID) != nil {
		return Result{}, errors.New("vpsctl apply returned no valid receipt")
	}
	if runErr != nil && (result.Status == "applied" || result.Status == "pending_restart") {
		result.Status = "unknown"
		result.ExitCode = exitCode
		result.Message = "vpsctl exited unsuccessfully after reporting success; verify the current snapshot"
	}
	return result, nil
}
