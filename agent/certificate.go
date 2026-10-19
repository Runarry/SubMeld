package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"regexp"
	"strings"
	"time"
)

type certificatePair struct {
	CertificatePEM string `json:"certificatePEM"`
	PrivateKeyPEM  string `json:"privateKeyPEM"`
}

func generateCertificate(serverName string) (certificatePair, error) {
	var pair certificatePair
	namePattern := regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$`)
	ip := net.ParseIP(serverName)
	if len(serverName) == 0 || len(serverName) > 253 || (ip == nil && (!namePattern.MatchString(serverName) || strings.Contains(serverName, ".."))) {
		return pair, errors.New("server-name must be a DNS name or IP address")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return pair, errors.New("cannot generate tunnel key")
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return pair, errors.New("cannot generate certificate serial")
	}
	now := time.Now()
	cert := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: serverName},
		NotBefore: now.Add(-5 * time.Minute), NotAfter: now.AddDate(3, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true, IsCA: true,
	}
	if ip != nil {
		cert.IPAddresses = []net.IP{ip}
	} else {
		cert.DNSNames = []string{serverName}
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		return pair, errors.New("cannot create tunnel certificate")
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return pair, errors.New("cannot encode tunnel key")
	}
	pair.CertificatePEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	pair.PrivateKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	return pair, nil
}
