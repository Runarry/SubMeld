package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const tunnelTestID = "a4608a7e-4c5d-45eb-bcf8-5d1c681def01"

func tunnelTestCertificate(t *testing.T) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "tunnel.test"}, DNSNames: []string{"tunnel.test"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), BasicConstraintsValid: true, IsCA: true,
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
}

func tunnelTestCommand(id, role, expected, request string, config any) Command {
	data, _ := json.Marshal(config)
	params := map[string]json.RawMessage{}
	for key, value := range map[string]string{"id": id, "role": role, "revision": tunnelDigest(data), "config": string(data), "expected-tunnel-revision": expected} {
		params[key], _ = json.Marshal(value)
	}
	return Command{SchemaVersion: 1, RequestID: request, ExpectedRevision: strings.Repeat("a", 64), Action: "tunnel.apply", Params: params}
}

func tunnelTestDelete(id, revision, request string) Command {
	params := map[string]json.RawMessage{}
	for key, value := range map[string]string{"id": id, "expected-tunnel-revision": revision} {
		params[key], _ = json.Marshal(value)
	}
	return Command{SchemaVersion: 1, RequestID: request, ExpectedRevision: strings.Repeat("a", 64), Action: "tunnel.delete", Params: params}
}

func TestTunnelRejectsUnrestrictedConfiguration(t *testing.T) {
	cert, key := tunnelTestCertificate(t)
	valid := tunnelHopConfig{ListenHost: "127.0.0.1", ListenPort: 24831, Username: "test", Password: "test-random-password", CertificatePEM: cert, PrivateKeyPEM: key}
	data, _ := json.Marshal(valid)
	desired := tunnelDesired{ID: tunnelTestID, Role: "hop", Revision: tunnelDigest(data), Config: string(data)}
	if _, err := desired.validate(); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*tunnelDesired){
		func(d *tunnelDesired) { d.ID = "../escape" },
		func(d *tunnelDesired) { d.Revision = strings.Repeat("0", 64) },
		func(d *tunnelDesired) { d.Role = "shell" },
		func(d *tunnelDesired) {
			d.Config = strings.TrimSuffix(d.Config, "}") + `,"api":{"addr":":19080"}}`
			d.Revision = tunnelDigest([]byte(d.Config))
		},
		func(d *tunnelDesired) {
			d.Config = strings.Replace(d.Config, `"listenHost":"127.0.0.1"`, `"listenHost":"127.0.0.1:22"`, 1)
			d.Revision = tunnelDigest([]byte(d.Config))
		},
	} {
		copy := desired
		mutate(&copy)
		if _, err := copy.validate(); err == nil {
			t.Fatal("unrestricted or malformed configuration was accepted")
		}
	}
	entry := tunnelEntryConfig{ListenHost: "127.0.0.1", ListenPort: 24831, Network: "both", TargetHost: "127.0.0.1", TargetPort: 443,
		Hops: []tunnelPeer{{Address: "localhost", Port: 24832, Username: "test", Password: "test-random-password", CertificatePEM: cert, ServerName: "tunnel.test"}}}
	data, _ = json.Marshal(entry)
	desired = tunnelDesired{ID: tunnelTestID, Role: "entry", Revision: tunnelDigest(data), Config: string(data)}
	path, endpoints, err := desired.render(t.TempDir())
	if err != nil || len(endpoints) != 2 {
		t.Fatalf("valid entry failed: %v", err)
	}
	output, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(output, []byte(`"secure":true`)) || !bytes.Contains(output, []byte(`"serverName":"tunnel.test"`)) {
		t.Fatal("rendered TLS configuration does not enforce certificate verification")
	}
}

func TestTunnelDurableIdempotenceAndCAS(t *testing.T) {
	dir := t.TempDir()
	manager, err := NewTunnelManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	cmd := tunnelTestDelete(tunnelTestID, "", "delete-empty")
	first, err := manager.Apply(context.Background(), cmd)
	if err != nil || first.Status != "applied" {
		t.Fatalf("delete failed: %+v %v", first, err)
	}
	_ = manager.Close()
	manager, err = NewTunnelManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	repeated, err := manager.Apply(context.Background(), cmd)
	if err != nil || repeated.Status != first.Status || repeated.Message != first.Message {
		t.Fatalf("durable receipt not replayed: %+v %v", repeated, err)
	}
	conflict := tunnelTestDelete(tunnelTestID, strings.Repeat("1", 64), cmd.RequestID)
	result, _ := manager.Apply(context.Background(), conflict)
	if result.Status != "conflict" {
		t.Fatal("same request ID accepted different command")
	}
	conflict.RequestID = "wrong-revision"
	result, _ = manager.Apply(context.Background(), conflict)
	if result.Status != "conflict" {
		t.Fatal("stale resource revision was accepted")
	}
	if len(result.Snapshot) != 0 || result.Revision != cmd.ExpectedRevision {
		t.Fatal("tunnel result changed the vpsctl snapshot contract")
	}
}

func tunnelTestPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

func tunnelEchoTarget(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	u, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		_ = l.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close(); _ = u.Close() })
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer conn.Close(); _, _ = io.Copy(conn, conn) }()
		}
	}()
	go func() {
		buffer := make([]byte, 65535)
		for {
			n, address, err := u.ReadFrom(buffer)
			if err != nil {
				return
			}
			_, _ = u.WriteTo(buffer[:n], address)
		}
	}()
	return port
}

func tunnelEcho(port int, network string, size int) error {
	conn, err := net.DialTimeout(network, fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(1200 * time.Millisecond))
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	if _, err := conn.Write(payload); err != nil {
		return err
	}
	result := make([]byte, len(payload))
	if network == "tcp" {
		_, err = io.ReadFull(conn, result)
	} else {
		var n int
		n, err = conn.Read(result)
		if n != len(result) && err == nil {
			err = fmt.Errorf("datagram was truncated: %d", n)
		}
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(result, payload) {
		return fmt.Errorf("echo payload changed")
	}
	return nil
}

// The explicit environment switch is for the separately invoked real-runtime
// acceptance run; ordinary unit tests must not download or start a network proxy.
func TestTunnelRealGOST(t *testing.T) {
	if os.Getenv("SUBMELD_TUNNEL_REAL") != "1" {
		t.Skip("real official GOST acceptance is invoked with SUBMELD_TUNNEL_REAL=1")
	}
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		t.Fatal("this acceptance fixture requires Linux amd64")
	}
	dir := t.TempDir()
	if archive := os.Getenv("SUBMELD_TUNNEL_ARCHIVE"); archive != "" {
		data, err := os.ReadFile(archive)
		if err != nil {
			t.Fatal(err)
		}
		cache := filepath.Join(dir, "tunnels", "gost", "3.3.0")
		if err := os.MkdirAll(cache, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cache, "release.tar.gz"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	manager, err := NewTunnelManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	apply := func(command Command) Result {
		t.Helper()
		result, err := manager.Apply(ctx, command)
		if err != nil || result.Status != "applied" {
			t.Fatalf("command %s: %+v, %v", command.RequestID, result, err)
		}
		return result
	}
	cert1, key1 := tunnelTestCertificate(t)
	cert2, key2 := tunnelTestCertificate(t)
	hopIDs := []string{"a4608a7e-4c5d-45eb-bcf8-5d1c681def02", "a4608a7e-4c5d-45eb-bcf8-5d1c681def03"}
	hopConfigs := []tunnelHopConfig{
		{ListenHost: "127.0.0.1", ListenPort: tunnelTestPort(t), Username: "first", Password: "first-random-password", CertificatePEM: cert1, PrivateKeyPEM: key1},
		{ListenHost: "127.0.0.1", ListenPort: tunnelTestPort(t), Username: "second", Password: "second-random-password", CertificatePEM: cert2, PrivateKeyPEM: key2},
	}
	peers := make([]tunnelPeer, 0, 2)
	hopRevisions := make([]string, 2)
	for i, hop := range hopConfigs {
		command := tunnelTestCommand(hopIDs[i], "hop", "", fmt.Sprintf("hop-%d", i), hop)
		apply(command)
		hopRevisions[i], _ = tunnelStringParam(command, "revision")
		peers = append(peers, tunnelPeer{Address: "127.0.0.1", Port: hop.ListenPort, Username: hop.Username, Password: hop.Password, CertificatePEM: hop.CertificatePEM, ServerName: "tunnel.test"})
	}
	target := tunnelEchoTarget(t)
	entry := tunnelEntryConfig{ListenHost: "::", ListenPort: tunnelTestPort(t), Network: "both", TargetHost: "127.0.0.1", TargetPort: target}
	revision := ""
	for count := 1; count <= 2; count++ {
		entry.Hops = peers[:count]
		command := tunnelTestCommand(tunnelTestID, "entry", revision, fmt.Sprintf("entry-%d", count), entry)
		apply(command)
		revision, _ = tunnelStringParam(command, "revision")
		for _, network := range []string{"tcp", "udp"} {
			if err := tunnelEcho(entry.ListenPort, network, 8192); err != nil {
				t.Fatalf("%d-hop %s echo: %v", count, network, err)
			}
		}
		t.Logf("PASS: official GOST %d-hop TCP and UDP echo, 8192-byte payload", count)
	}
	// A different listener's occupied port must never be treated as this child's readiness.
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	bad := entry
	bad.ListenPort = occupied.Addr().(*net.TCPAddr).Port
	result, err := manager.Apply(ctx, tunnelTestCommand(tunnelTestID, "entry", revision, "port-conflict", bad))
	if err != nil || result.Status != "failed" {
		t.Fatalf("port conflict accepted: %+v %v", result, err)
	}
	for _, network := range []string{"tcp", "udp"} {
		if err := tunnelEcho(entry.ListenPort, network, 256); err != nil {
			t.Fatalf("rollback lost old %s entry: %v", network, err)
		}
	}
	t.Log("PASS: occupied-port update failed and previous TCP/UDP listeners were restored")
	udpOccupied, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udpOccupied.Close()
	bad.ListenPort = udpOccupied.LocalAddr().(*net.UDPAddr).Port
	result, err = manager.Apply(ctx, tunnelTestCommand(tunnelTestID, "entry", revision, "udp-port-conflict", bad))
	if err != nil || result.Status != "failed" {
		t.Fatalf("UDP port conflict accepted: %+v %v", result, err)
	}
	partialTCP, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", bad.ListenPort))
	if err != nil {
		t.Fatal("failed composite start leaked a TCP listener", err)
	}
	_ = partialTCP.Close()
	if tunnelEcho(entry.ListenPort, "tcp", 128) != nil || tunnelEcho(entry.ListenPort, "udp", 128) != nil {
		t.Fatal("UDP conflict rollback lost the previous route")
	}
	t.Log("PASS: UDP port conflict cleans partially started TCP listener and restores previous route")
	cancelled, cancelApply := context.WithCancel(ctx)
	cancelApply()
	result, err = manager.Apply(cancelled, tunnelTestCommand(tunnelTestID, "entry", revision, "cancelled-update", bad))
	if err != nil || result.Status != "failed" || tunnelEcho(entry.ListenPort, "tcp", 128) != nil {
		t.Fatal("cancelled update disturbed the previous listener")
	}
	t.Log("PASS: cancelled update preserves the previous listener")
	for _, mode := range []string{"password", "ca", "name"} {
		bad = entry
		bad.Hops = append([]tunnelPeer(nil), entry.Hops...)
		switch mode {
		case "password":
			bad.Hops[1].Password = "incorrect-password"
		case "ca":
			bad.Hops[1].CertificatePEM = cert1
		case "name":
			bad.Hops[1].ServerName = "incorrect.test"
		}
		command := tunnelTestCommand(tunnelTestID, "entry", revision, "invalid-"+mode, bad)
		apply(command)
		revision, _ = tunnelStringParam(command, "revision")
		for _, network := range []string{"tcp", "udp"} {
			if err := tunnelEcho(entry.ListenPort, network, 128); err == nil {
				t.Fatalf("wrong %s was accepted for %s", mode, network)
			}
		}
		t.Logf("PASS: incorrect %s rejected for TCP and UDP", mode)
	}
	validCommand := tunnelTestCommand(tunnelTestID, "entry", revision, "restore-valid", entry)
	apply(validCommand)
	revision, _ = tunnelStringParam(validCommand, "revision")
	// Removing the intermediate hop proves forwarding depends on it, and cannot
	// silently fall back to the target directly.
	apply(tunnelTestDelete(hopIDs[0], hopRevisions[0], "remove-first-hop"))
	for _, network := range []string{"tcp", "udp"} {
		if tunnelEcho(entry.ListenPort, network, 128) == nil {
			t.Fatalf("%s bypassed the removed first hop", network)
		}
	}
	apply(tunnelTestCommand(hopIDs[0], "hop", "", "restore-first-hop", hopConfigs[0]))
	t.Log("PASS: the first hop is required, with no direct fallback")
	// Kill only the managed entry process; the supervisor must restart it and
	// leave both other resources running.
	m := manager.(*gostTunnelManager)
	m.mu.Lock()
	oldPID := m.runtimes[tunnelTestID].process.command.Process.Pid
	_ = m.runtimes[tunnelTestID].process.command.Process.Kill()
	m.mu.Unlock()
	deadline := time.Now().Add(8 * time.Second)
	restarted := false
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		m.mu.Lock()
		p := m.runtimes[tunnelTestID].process
		restarted = p.running() && p.command.Process.Pid != oldPID
		m.mu.Unlock()
		if restarted {
			break
		}
	}
	if !restarted || tunnelEcho(entry.ListenPort, "tcp", 256) != nil || tunnelEcho(entry.ListenPort, "udp", 256) != nil {
		t.Fatal("supervisor did not recover the real TCP/UDP route")
	}
	t.Log("PASS: unexpected process exit restarts the affected resource")
	if err := manager.Close(); err != nil {
		t.Fatal(err)
	}
	manager, err = NewTunnelManager(dir)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		statuses := manager.Status()
		allRunning := len(statuses) == 3
		for _, status := range statuses {
			allRunning = allRunning && status.Running
		}
		if allRunning {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if tunnelEcho(entry.ListenPort, "tcp", 256) != nil || tunnelEcho(entry.ListenPort, "udp", 256) != nil {
		t.Fatal("agent restart failed to restore the real route")
	}
	if result, found, err := manager.(*gostTunnelManager).Lookup(validCommand); !found || err != nil || result.Status != "applied" {
		t.Fatal("agent restart did not preserve request receipt")
	}
	t.Log("PASS: persisted desired state and command receipt restore after agent restart")
	apply(tunnelTestDelete(tunnelTestID, revision, "remove-entry"))
	if tunnelEcho(entry.ListenPort, "tcp", 128) == nil {
		t.Fatal("deleted TCP entry remains reachable")
	}
	tcp, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", entry.ListenPort))
	if err != nil {
		t.Fatal("deleted TCP port not released", err)
	}
	_ = tcp.Close()
	udp, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", entry.ListenPort))
	if err != nil {
		t.Fatal("deleted UDP port not released", err)
	}
	_ = udp.Close()
	if _, err := os.Stat(filepath.Join(dir, "tunnels", "resources", tunnelTestID)); !os.IsNotExist(err) {
		t.Fatal("deleted entry retained credential files")
	}
	t.Log("PASS: deletion releases TCP/UDP ports and removes private resource files")
}
