//go:build !linux

package main

import (
	"os"
	"os/exec"
)

func tunnelConfigureProcess(command *exec.Cmd)                     {}
func tunnelTerminate(process *os.Process)                          { _ = process.Kill() }
func tunnelOwnsListeners(pid int, endpoints []tunnelEndpoint) bool { return false }
