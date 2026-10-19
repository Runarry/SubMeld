package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"
)

type panelClient struct {
	config Config
	http   *http.Client
}

func newPanelClient(config Config) *panelClient {
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 35 * time.Second,
		IdleConnTimeout: 90 * time.Second, MaxIdleConns: 4, MaxIdleConnsPerHost: 2,
		MaxResponseHeaderBytes: 32 << 10, ForceAttemptHTTP2: true,
	}
	return &panelClient{config: config, http: &http.Client{
		Transport: transport, Timeout: 45 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func decodeJSON(data []byte, target any, strict bool) error {
	d := json.NewDecoder(bytes.NewReader(data))
	if strict {
		d.DisallowUnknownFields()
	}
	if err := d.Decode(target); err != nil {
		return errors.New("invalid JSON payload")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (c *panelClient) request(ctx context.Context, method, path string, body any, target any, limit int64) error {
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		if err != nil || len(data) > maxPayload {
			return errors.New("request payload is invalid or exceeds size limit")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.Server+path, bytes.NewReader(data))
	if err != nil {
		return errors.New("cannot create panel request")
	}
	req.Header.Set("Authorization", "Bearer "+c.config.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("panel connection failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("panel returned HTTP %d", resp.StatusCode)
	}
	data, err = io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		return errors.New("panel response is unreadable or exceeds size limit")
	}
	if target != nil {
		return decodeJSON(data, target, true)
	}
	return nil
}

func (c *panelClient) poll(ctx context.Context) (*Command, error) {
	var envelope struct {
		Command json.RawMessage `json:"command"`
	}
	if err := c.request(ctx, http.MethodGet, "/api/agent/commands?machineId="+c.config.MachineID+"&wait=25", nil, &envelope, maxCommand); err != nil {
		return nil, err
	}
	if len(envelope.Command) == 0 {
		return nil, errors.New("panel response omitted command")
	}
	if bytes.Equal(bytes.TrimSpace(envelope.Command), []byte("null")) {
		return nil, nil
	}
	var command Command
	if decodeJSON(envelope.Command, &command, true) != nil || validateCommand(command) != nil {
		return nil, errors.New("panel command is invalid")
	}
	return &command, nil
}

func (c *panelClient) result(ctx context.Context, result Result) error {
	return c.request(ctx, http.MethodPost, "/api/agent/results", struct {
		MachineID string `json:"machineId"`
		Result    Result `json:"result"`
	}{c.config.MachineID, result}, nil, 64<<10)
}

func (c *panelClient) report(ctx context.Context, bootID string, snapshot Snapshot, tunnels []TunnelStatus) error {
	if _, err := validateSnapshot(snapshot); err != nil {
		return err
	}
	if tunnels == nil {
		tunnels = []TunnelStatus{}
	}
	return c.request(ctx, http.MethodPost, "/api/agent/report", struct {
		MachineID    string         `json:"machineId"`
		AgentVersion string         `json:"agentVersion"`
		BootID       string         `json:"bootId"`
		Snapshot     Snapshot       `json:"snapshot"`
		Tunnels      []TunnelStatus `json:"tunnels"`
	}{c.config.MachineID, version, bootID, snapshot, tunnels}, nil, 64<<10)
}
