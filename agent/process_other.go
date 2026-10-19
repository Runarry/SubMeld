//go:build !linux

package main

import (
	"errors"
	"os/exec"
)

func configureChildProcess(*exec.Cmd) {}

func lockAgent(string) (func(), error) {
	return nil, errors.New("Agent service requires Linux; setup and certificate helpers are portable")
}
