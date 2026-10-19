//go:build linux

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestAgentLinuxLockAndPrivateConfig(t *testing.T) {
	dir := t.TempDir()
	lockPath := filepath.Join(dir, "agent.lock")
	unlock, err := lockAgent(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	if release, err := lockAgent(lockPath); err == nil {
		release()
		unlock()
		t.Fatal("second Agent acquired the same state lock")
	}
	unlock()
	unlock, err = lockAgent(lockPath)
	if err != nil {
		t.Fatal("lock was not released")
	}
	defer unlock()
	config := Config{Server: "https://panel.example", MachineID: agentTestID, Token: "unit-test-token-value", StateDir: dir}
	path := filepath.Join(dir, "config.json")
	if err = saveConfig(path, config); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("configuration is not private")
	}
	if err = os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = loadConfig(path); err == nil {
		t.Fatal("publicly readable configuration accepted")
	}
}

func TestAgentLinuxCancellationStopsHelperChildren(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	started := time.Now()
	data, _, err := runVpsctl(ctx, "/bin/sh", []string{"-c", "sleep 60 & echo $!; wait"}, nil)
	if err == nil || time.Since(started) > 2*time.Second {
		t.Fatal("helper cancellation did not terminate promptly")
	}
	pid, parseErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if parseErr != nil {
		t.Fatalf("controlled helper did not start child: %v", parseErr)
	}
	// A killed child can briefly remain as a zombie until PID 1 reaps it.
	stat, readErr := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if errors.Is(readErr, os.ErrNotExist) || errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
		return
	}
	fields := strings.Fields(string(stat))
	if readErr != nil || len(fields) < 3 || fields[2] != "Z" {
		t.Fatal("helper descendant survived cancellation")
	}
}
