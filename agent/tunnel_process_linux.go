package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func tunnelConfigureProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

func tunnelTerminate(process *os.Process) { _ = process.Signal(syscall.SIGTERM) }

// Readiness checks sockets owned by this exact child, not just whether something
// accepts a connection on the requested port. This also verifies UDP listeners.
func tunnelOwnsListeners(pid int, endpoints []tunnelEndpoint) bool {
	fdDir := filepath.Join("/proc", strconv.Itoa(pid), "fd")
	fds, err := os.ReadDir(fdDir)
	if err != nil {
		return false
	}
	inodes := map[string]bool{}
	for _, fd := range fds {
		link, _ := os.Readlink(filepath.Join(fdDir, fd.Name()))
		if strings.HasPrefix(link, "socket:[") && strings.HasSuffix(link, "]") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(link, "socket:["), "]")] = true
		}
	}
	for _, endpoint := range endpoints {
		found := false
		for _, suffix := range []string{"", "6"} {
			data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "net", endpoint.Network+suffix))
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(data), "\n") {
				fields := strings.Fields(line)
				if len(fields) < 10 || !inodes[fields[9]] || (endpoint.Network == "tcp" && fields[3] != "0A") {
					continue
				}
				address := strings.Split(fields[1], ":")
				if len(address) != 2 {
					continue
				}
				port, err := strconv.ParseInt(address[1], 16, 32)
				if err == nil && int(port) == endpoint.Port {
					found = true
				}
			}
		}
		if !found {
			return false
		}
	}
	return true
}
