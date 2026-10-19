package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
)

var version = "dev"

func main() {
	if err := runCLI(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		// All returned CLI errors are authored messages, never native output.
		fmt.Fprintln(os.Stderr, "submeld-agent:", err)
		os.Exit(1)
	}
}

func runCLI(args []string, stdin io.Reader, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: submeld-agent <run|setup|certificate|version> [options]")
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Fprintln(stdout, version)
		return nil
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	if args[0] == "certificate" {
		name := fs.String("server-name", "", "certificate DNS name or IP")
		if fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
			return errors.New("usage: submeld-agent certificate --server-name NAME")
		}
		pair, err := generateCertificate(*name)
		if err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(pair)
	}
	path := fs.String("config", defaultConfig, "configuration file")
	if args[0] == "setup" {
		server := fs.String("server", "", "panel origin")
		machineID := fs.String("machine-id", "", "machine UUID; generated if missing")
		token := fs.String("token", "", "per-machine token")
		tokenStdin := fs.Bool("token-stdin", false, "read token from standard input")
		vpsPath := fs.String("vpsctl", "", "vpsctl executable")
		stateDir := fs.String("state-dir", "", "private state directory")
		allowHTTP := fs.Bool("allow-http", false, "permit trusted local HTTP")
		if fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
			return errors.New("invalid setup flags; use --server ORIGIN --token TOKEN [--machine-id UUID] [--allow-http]")
		}
		visited := map[string]bool{}
		fs.Visit(func(f *flag.Flag) { visited[f.Name] = true })
		config := Config{}
		if _, err := os.Lstat(*path); err == nil {
			config, err = loadConfig(*path)
			if err != nil {
				return err
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return errors.New("cannot inspect configuration")
		}
		if visited["server"] {
			config.Server = *server
		}
		if visited["machine-id"] {
			config.MachineID = *machineID
		}
		if visited["vpsctl"] {
			config.Vpsctl = *vpsPath
		}
		if visited["state-dir"] {
			config.StateDir = *stateDir
		}
		if visited["allow-http"] {
			config.AllowHTTP = *allowHTTP
		}
		if visited["token"] {
			config.Token = *token
		}
		if *tokenStdin {
			if visited["token"] {
				return errors.New("use only one token input option")
			}
			data, err := io.ReadAll(io.LimitReader(stdin, 4098))
			if err != nil || len(data) > 4097 {
				return errors.New("cannot read token input")
			}
			config.Token = strings.TrimSpace(string(data))
		}
		if config.MachineID == "" {
			var err error
			config.MachineID, err = newUUID()
			if err != nil {
				return errors.New("cannot generate machine identity")
			}
		}
		if err := saveConfig(*path, config); err != nil {
			return err
		}
		fmt.Fprintln(stdout, config.MachineID)
		return nil
	}
	if args[0] != "run" || fs.Parse(args[1:]) != nil || fs.NArg() != 0 {
		return errors.New("usage: submeld-agent run [--config PATH]")
	}
	if runtime.GOOS != "linux" {
		return errors.New("Agent service requires Linux")
	}
	config, err := loadConfig(*path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(config.StateDir, 0700); err != nil {
		return errors.New("cannot create private state directory")
	}
	if err := os.Chmod(config.StateDir, 0700); err != nil {
		return errors.New("cannot protect private state directory")
	}
	unlock, err := lockAgent(filepath.Join(config.StateDir, "agent.lock"))
	if err != nil {
		return err
	}
	defer unlock()
	if err = bindStateIdentity(config.StateDir, config.MachineID); err != nil {
		return err
	}
	tunnels, err := NewTunnelManager(config.StateDir)
	if err != nil {
		return errors.New("cannot initialize tunnel runtime; inspect private state and binary installation")
	}
	defer tunnels.Close()
	bootID, err := newUUID()
	if err != nil {
		return errors.New("cannot generate Agent boot identity")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := newPanelClient(config)
	defer client.http.CloseIdleConnections()
	a := &agent{stateDir: config.StateDir, bootID: bootID, panel: client,
		machine: &vpsctl{path: config.Vpsctl, run: runVpsctl}, tunnels: tunnels, logger: log.New(os.Stderr, "submeld-agent: ", log.LstdFlags)}
	err = a.run(ctx)
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
