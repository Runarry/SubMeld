package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// These are deliberately smaller than GOST's configuration language: no file
// paths, executable plugins, Web API, remote configuration or arbitrary metadata.
type tunnelHopConfig struct {
	ListenHost     string `json:"listenHost"`
	ListenPort     int    `json:"listenPort"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	CertificatePEM string `json:"certificatePEM"`
	PrivateKeyPEM  string `json:"privateKeyPEM"`
}

type tunnelPeer struct {
	Address        string `json:"address"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	CertificatePEM string `json:"certificatePEM"`
	ServerName     string `json:"serverName"`
}

type tunnelEntryConfig struct {
	ListenHost string       `json:"listenHost"`
	ListenPort int          `json:"listenPort"`
	Network    string       `json:"network"`
	TargetHost string       `json:"targetHost"`
	TargetPort int          `json:"targetPort"`
	Hops       []tunnelPeer `json:"hops"`
}

type tunnelDesired struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	Revision string `json:"revision"`
	Config   string `json:"config"`
}

type tunnelEndpoint struct {
	Network string
	Host    string
	Port    int
}

var tunnelUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var tunnelRevisionPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var tunnelDNSPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$`)

func tunnelDigest(b []byte) string {
	d := sha256.Sum256(b)
	return hex.EncodeToString(d[:])
}

func tunnelDecode(data string, v any) error {
	if len(data) == 0 || len(data) > 512*1024 {
		return errors.New("invalid tunnel configuration size")
	}
	d := json.NewDecoder(strings.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(v) != nil {
		return errors.New("invalid tunnel configuration fields")
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("invalid tunnel configuration JSON")
	}
	return nil
}

func tunnelHost(s string) bool {
	return net.ParseIP(s) != nil || (len(s) <= 253 && tunnelDNSPattern.MatchString(s) && !strings.Contains(s, ".."))
}

func tunnelPort(p int) bool { return p > 0 && p <= 65535 }

func tunnelCredentials(username, password string) bool {
	if len(username) == 0 || len(username) > 255 || len(password) < 16 || len(password) > 255 {
		return false
	}
	return !strings.ContainsAny(username+password, "\x00\r\n")
}

func tunnelCertificate(cert string) (*x509.CertPool, error) {
	pool := x509.NewCertPool()
	if len(cert) > 64*1024 || !pool.AppendCertsFromPEM([]byte(cert)) {
		return nil, errors.New("invalid tunnel TLS certificate")
	}
	return pool, nil
}

func (d tunnelDesired) validate() ([]tunnelEndpoint, error) {
	if !tunnelUUIDPattern.MatchString(d.ID) || !tunnelRevisionPattern.MatchString(d.Revision) || tunnelDigest([]byte(d.Config)) != d.Revision {
		return nil, errors.New("invalid tunnel identity or configuration revision")
	}
	if d.Role == "hop" {
		var c tunnelHopConfig
		if err := tunnelDecode(d.Config, &c); err != nil {
			return nil, err
		}
		if net.ParseIP(c.ListenHost) == nil || !tunnelPort(c.ListenPort) || !tunnelCredentials(c.Username, c.Password) {
			return nil, errors.New("invalid tunnel relay address or credentials")
		}
		pair, err := tls.X509KeyPair([]byte(c.CertificatePEM), []byte(c.PrivateKeyPEM))
		if err != nil || len(pair.Certificate) == 0 {
			return nil, errors.New("invalid tunnel TLS key pair")
		}
		cert, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil || time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
			return nil, errors.New("invalid or expired tunnel TLS certificate")
		}
		return []tunnelEndpoint{{"tcp", c.ListenHost, c.ListenPort}}, nil
	}
	if d.Role != "entry" {
		return nil, errors.New("invalid tunnel role")
	}
	var c tunnelEntryConfig
	if err := tunnelDecode(d.Config, &c); err != nil {
		return nil, err
	}
	if net.ParseIP(c.ListenHost) == nil || !tunnelPort(c.ListenPort) || !tunnelHost(c.TargetHost) || !tunnelPort(c.TargetPort) || len(c.Hops) == 0 || len(c.Hops) > 16 {
		return nil, errors.New("invalid tunnel entry address or hop count")
	}
	for _, hop := range c.Hops {
		if !tunnelHost(hop.Address) || !tunnelPort(hop.Port) || !tunnelHost(hop.ServerName) || !tunnelCredentials(hop.Username, hop.Password) {
			return nil, errors.New("invalid tunnel peer address or credentials")
		}
		if _, err := tunnelCertificate(hop.CertificatePEM); err != nil {
			return nil, err
		}
	}
	var endpoints []tunnelEndpoint
	if c.Network == "tcp" || c.Network == "both" {
		endpoints = append(endpoints, tunnelEndpoint{"tcp", c.ListenHost, c.ListenPort})
	}
	if c.Network == "udp" || c.Network == "both" {
		endpoints = append(endpoints, tunnelEndpoint{"udp", c.ListenHost, c.ListenPort})
	}
	if len(endpoints) == 0 {
		return nil, errors.New("invalid tunnel network")
	}
	return endpoints, nil
}

func (d tunnelDesired) render(dir string) (string, []tunnelEndpoint, error) {
	endpoints, err := d.validate()
	if err != nil {
		return "", nil, err
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", nil, errors.New("cannot create tunnel runtime directory")
	}
	config := map[string]any{"log": map[string]any{"level": "error"}}
	var services []any
	if d.Role == "hop" {
		var c tunnelHopConfig
		_ = json.Unmarshal([]byte(d.Config), &c)
		certPath, keyPath := filepath.Join(dir, "relay.crt"), filepath.Join(dir, "relay.key")
		if err := tunnelWritePrivate(certPath, []byte(c.CertificatePEM)); err != nil {
			return "", nil, err
		}
		if err := tunnelWritePrivate(keyPath, []byte(c.PrivateKeyPEM)); err != nil {
			return "", nil, err
		}
		services = append(services, map[string]any{
			"name": "relay", "addr": net.JoinHostPort(c.ListenHost, strconv.Itoa(c.ListenPort)),
			"handler":  map[string]any{"type": "relay", "auth": map[string]string{"username": c.Username, "password": c.Password}, "metadata": map[string]any{"udpBufferSize": "65535", "nodelay": true}},
			"listener": map[string]any{"type": "tls", "tls": map[string]any{"certFile": certPath, "keyFile": keyPath, "options": map[string]string{"minVersion": "VersionTLS12"}}},
		})
	} else {
		var c tunnelEntryConfig
		_ = json.Unmarshal([]byte(d.Config), &c)
		var hops []any
		for i, hop := range c.Hops {
			caPath := filepath.Join(dir, fmt.Sprintf("hop-%d.crt", i))
			if err := tunnelWritePrivate(caPath, []byte(hop.CertificatePEM)); err != nil {
				return "", nil, err
			}
			hops = append(hops, map[string]any{"name": fmt.Sprintf("hop-%d", i), "nodes": []any{map[string]any{
				"name": "relay", "addr": net.JoinHostPort(hop.Address, strconv.Itoa(hop.Port)),
				"connector": map[string]any{"type": "relay", "auth": map[string]string{"username": hop.Username, "password": hop.Password}, "metadata": map[string]any{"nodelay": true}},
				"dialer":    map[string]any{"type": "tls", "tls": map[string]any{"caFile": caPath, "secure": true, "serverName": hop.ServerName, "options": map[string]string{"minVersion": "VersionTLS12"}}},
			}}})
		}
		config["chains"] = []any{map[string]any{"name": "route", "hops": hops}}
		for _, endpoint := range endpoints {
			listener := map[string]any{"type": endpoint.Network}
			if endpoint.Network == "udp" {
				// GOST's metadata GetInt accepts strings and Go ints, but not the
				// float64 values produced by its JSON loader. Preserve the buffer.
				listener["metadata"] = map[string]any{"keepalive": true, "ttl": "30s", "readBufferSize": "65535"}
			}
			services = append(services, map[string]any{
				"name": endpoint.Network, "addr": net.JoinHostPort(c.ListenHost, strconv.Itoa(c.ListenPort)),
				"handler": map[string]any{"type": endpoint.Network, "chain": "route", "metadata": map[string]any{"bufferSize": "65535"}}, "listener": listener,
				"forwarder": map[string]any{"nodes": []any{map[string]string{"name": "target", "addr": net.JoinHostPort(c.TargetHost, strconv.Itoa(c.TargetPort))}}},
			})
		}
	}
	config["services"] = services
	data, err := json.Marshal(config)
	if err != nil {
		return "", nil, errors.New("cannot encode tunnel configuration")
	}
	path := filepath.Join(dir, "gost.json")
	if err := tunnelWritePrivate(path, data); err != nil {
		return "", nil, err
	}
	return path, endpoints, nil
}

func tunnelWritePrivate(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tunnel-*")
	if err != nil {
		return errors.New("cannot write tunnel state")
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = io.Copy(f, bytes.NewReader(data))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		return errors.New("cannot persist tunnel state")
	}
	if os.Rename(f.Name(), path) != nil {
		return errors.New("cannot replace tunnel state")
	}
	return nil
}
