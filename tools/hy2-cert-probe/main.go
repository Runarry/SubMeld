// The probe performs only a QUIC TLS handshake. It never authenticates a HY2
// proxy session and accepts a certificate only after checking the supplied pin.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/apernet/quic-go"
	"golang.org/x/crypto/blake2b"
)

type request struct {
	Server       string `json:"server"`
	Port         int    `json:"port"`
	Ports        string `json:"ports"`
	ServerName   string `json:"serverName"`
	Obfs         string `json:"obfs"`
	ObfsPassword string `json:"obfsPassword"`
	Pin          string `json:"pinSHA256"`
}
type response struct {
	CertificatePEM string `json:"certificatePem,omitempty"`
	Code           string `json:"code,omitempty"`
}

func main() {
	var r request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 65537))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&r) != nil {
		fail("HY2_PROBE_INVALID")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	certificate, code := probe(ctx, r)
	if code != "" {
		fail(code)
	}
	_ = json.NewEncoder(os.Stdout).Encode(response{CertificatePEM: certificate})
}
func fail(code string) {
	_ = json.NewEncoder(os.Stdout).Encode(response{Code: code})
	os.Exit(1)
}

func ports(r request) ([]int, error) {
	if r.Port < 1 || r.Port > 65535 {
		return nil, errors.New("port")
	}
	if r.Ports == "" {
		return []int{r.Port}, nil
	}
	var result []int
	for _, part := range strings.Split(r.Ports, ",") {
		bounds := strings.Split(part, "-")
		if len(bounds) > 2 {
			return nil, errors.New("ports")
		}
		start, err := strconv.Atoi(bounds[0])
		if err != nil {
			return nil, err
		}
		end := start
		if len(bounds) == 2 {
			end, err = strconv.Atoi(bounds[1])
		}
		if err != nil || start < 1 || end < start || end > 65535 {
			return nil, errors.New("ports")
		}
		for p := start; p <= end; p++ {
			result = append(result, p)
		}
		if len(result) > 65535 {
			return nil, errors.New("ports")
		}
	}
	return result, nil
}

func probe(ctx context.Context, r request) (string, string) {
	pin, err := hex.DecodeString(r.Pin)
	if err != nil || len(pin) != 32 || r.Server == "" || (r.Obfs != "" && r.Obfs != "salamander") {
		return "", "HY2_PROBE_INVALID"
	}
	candidates, err := ports(r)
	if err != nil {
		return "", "HY2_PROBE_INVALID"
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, r.Server)
	if err != nil || len(ips) == 0 {
		return "", "HY2_CERTIFICATE_DNS"
	}
	// Try the supplied candidate if it belongs to mport, then other ports.
	for i, port := range candidates {
		if port == r.Port {
			candidates[0], candidates[i] = candidates[i], candidates[0]
			break
		}
	}
	lastCode := "HY2_CERTIFICATE_UNREACHABLE"
	for attempt := 0; attempt < 3 && ctx.Err() == nil; attempt++ {
		ip := ips[attempt%len(ips)]
		port := candidates[attempt%len(candidates)]
		remote := &net.UDPAddr{IP: ip.IP, Zone: ip.Zone, Port: port}
		attemptCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		certificate, code := handshake(attemptCtx, r, remote, pin)
		cancel()
		if code == "" || code == "HY2_CERTIFICATE_MISMATCH" {
			return certificate, code
		}
		lastCode = code
	}
	if ctx.Err() != nil {
		lastCode = "HY2_CERTIFICATE_TIMEOUT"
	}
	return "", lastCode
}

func handshake(ctx context.Context, r request, remote *net.UDPAddr, pin []byte) (string, string) {
	var socket net.PacketConn
	var err error
	socket, err = net.ListenUDP("udp", nil)
	if err != nil {
		return "", "HY2_CERTIFICATE_UNREACHABLE"
	}
	defer socket.Close()
	if r.Obfs == "salamander" {
		socket = &salamander{PacketConn: socket, password: []byte(r.ObfsPassword)}
	}
	name := r.ServerName
	if name == "" {
		name = r.Server
	}
	var certificate string
	mismatch := false
	tlsConfig := &tls.Config{
		ServerName: name, NextProtos: []string{"h3"}, MinVersion: tls.VersionTLS13,
		InsecureSkipVerify: true, // Replaced by the exact, required certificate pin below.
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("no certificate")
			}
			leaf := state.PeerCertificates[0].Raw
			hash := sha256.Sum256(leaf)
			if !equal(hash[:], pin) {
				mismatch = true
				return errors.New("certificate pin mismatch")
			}
			certificate = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leaf}))
			return nil
		},
	}
	conn, err := quic.Dial(ctx, socket, remote, tlsConfig, &quic.Config{EnableDatagrams: true, HandshakeIdleTimeout: 3 * time.Second})
	if mismatch {
		return "", "HY2_CERTIFICATE_MISMATCH"
	}
	if err != nil {
		if ctx.Err() != nil {
			return "", "HY2_CERTIFICATE_TIMEOUT"
		}
		return "", "HY2_CERTIFICATE_UNREACHABLE"
	}
	defer conn.CloseWithError(0, "")
	if certificate == "" {
		return "", "HY2_CERTIFICATE_INVALID"
	}
	return certificate, ""
}
func equal(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := range a {
		d |= a[i] ^ b[i]
	}
	return d == 0
}

type salamander struct {
	net.PacketConn
	password []byte
}

func (s *salamander) WriteTo(p []byte, address net.Addr) (int, error) {
	packet := make([]byte, len(p)+8)
	if _, err := rand.Read(packet[:8]); err != nil {
		return 0, err
	}
	salt := append(append([]byte{}, s.password...), packet[:8]...)
	hash := blake2b.Sum256(salt)
	for i, b := range p {
		packet[i+8] = b ^ hash[i%32]
	}
	_, err := s.PacketConn.WriteTo(packet, address)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}
func (s *salamander) ReadFrom(p []byte) (int, net.Addr, error) {
	packet := make([]byte, 65535)
	for {
		n, address, err := s.PacketConn.ReadFrom(packet)
		if err != nil {
			return 0, address, err
		}
		if n <= 8 {
			continue
		}
		salt := append(append([]byte{}, s.password...), packet[:8]...)
		hash := blake2b.Sum256(salt)
		count := min(n-8, len(p))
		for i := 0; i < count; i++ {
			p[i] = packet[i+8] ^ hash[i%32]
		}
		return count, address, nil
	}
}
