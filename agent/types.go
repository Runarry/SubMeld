package main

import (
	"context"
	"encoding/json"
)

// Snapshot preserves the complete vpsctl payload, including native fields.
type Snapshot = json.RawMessage

type Command struct {
	SchemaVersion    int                        `json:"schemaVersion"`
	RequestID        string                     `json:"requestId"`
	ExpectedRevision string                     `json:"expectedRevision"`
	Action           string                     `json:"action"`
	Params           map[string]json.RawMessage `json:"params"`
}

type Result struct {
	SchemaVersion int             `json:"schemaVersion"`
	RequestID     string          `json:"requestId"`
	Status        string          `json:"status"`
	ExitCode      int             `json:"exitCode"`
	Message       string          `json:"message"`
	Revision      string          `json:"revision"`
	Snapshot      json.RawMessage `json:"snapshot,omitempty"`
}

type TunnelStatus struct {
	ID       string `json:"id"`
	Revision string `json:"revision"`
	Running  bool   `json:"running"`
	Error    string `json:"error"`
}

type TunnelManager interface {
	Apply(context.Context, Command) (Result, error)
	Status() []TunnelStatus
	Close() error
}
