package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const (
	defaultConfig = "/etc/submeld-agent/config.json"
	defaultState  = "/var/lib/submeld-agent"
	maxPayload    = 16 << 20
	maxCommand    = 1 << 20
)

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var revisionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Config struct {
	Server    string `json:"server"`
	MachineID string `json:"machineId"`
	Token     string `json:"token"`
	Vpsctl    string `json:"vpsctl,omitempty"`
	StateDir  string `json:"stateDir,omitempty"`
	AllowHTTP bool   `json:"allowHttp,omitempty"`
}

func (c *Config) validate() error {
	u, err := url.Parse(c.Server)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("server must be an HTTP(S) origin without credentials, path or query")
	}
	if u.Scheme != "https" && !(c.AllowHTTP && u.Scheme == "http") {
		return errors.New("HTTPS is required; allowHttp is only for trusted local networks")
	}
	if !uuidPattern.MatchString(c.MachineID) {
		return errors.New("machineId must be a UUID")
	}
	if len(c.Token) < 16 || len(c.Token) > 4096 || strings.ContainsAny(c.Token, " \t\r\n") {
		return errors.New("token must contain 16 to 4096 non-whitespace characters")
	}
	c.Server = strings.TrimRight(c.Server, "/")
	c.MachineID = strings.ToLower(c.MachineID)
	if c.Vpsctl == "" {
		c.Vpsctl = "/usr/local/bin/vpsctl"
	}
	if c.StateDir == "" {
		c.StateDir = defaultState
	}
	if !filepath.IsAbs(c.Vpsctl) || !filepath.IsAbs(c.StateDir) {
		return errors.New("vpsctl and stateDir must be absolute paths")
	}
	return nil
}

func loadConfig(path string) (Config, error) {
	var c Config
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return c, errors.New("configuration must be a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		return c, errors.New("configuration permissions must be 0600")
	}
	data, err := readLimitedFile(path, 64<<10)
	if err != nil || decodeJSON(data, &c, true) != nil {
		return c, errors.New("cannot read valid configuration JSON")
	}
	return c, c.validate()
}

func saveConfig(path string, c Config) error {
	if err := c.validate(); err != nil {
		return err
	}
	return writeJSONPrivate(path, c)
}

func bindStateIdentity(stateDir, machineID string) error {
	path := filepath.Join(stateDir, "machine-id.json")
	data, err := readLimitedFile(path, 1024)
	if errors.Is(err, os.ErrNotExist) {
		return writeJSONPrivate(path, machineID)
	}
	var previous string
	if err != nil || decodeJSON(data, &previous, false) != nil {
		return errors.New("cannot read state directory machine identity")
	}
	if previous != machineID {
		return errors.New("state directory belongs to a different machine; use its original ID or a new empty stateDir")
	}
	return nil
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	s := hex.EncodeToString(b[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", s[:8], s[8:12], s[12:16], s[16:20], s[20:]), nil
}

func readLimitedFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) > limit {
		return nil, errors.New("file exceeds size limit or cannot be read")
	}
	return b, nil
}

// Rename and fsync keep the old file or the complete new file across a crash.
func writeJSONPrivate(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".submeld-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	defer f.Close()
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err == nil {
		err = syncDirectory(dir)
	}
	return err
}

func syncDirectory(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
