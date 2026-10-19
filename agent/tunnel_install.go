package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

//go:embed gost.lock.json
var tunnelGOSTLock []byte

type tunnelAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

func tunnelFileDigest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Every process starts a binary derived from a verified official archive. The
// archive remains cached so an offline agent restart needs no untrusted receipt.
func tunnelInstall(ctx context.Context, stateDir string) (string, string, error) {
	var lock struct {
		Version string                 `json:"version"`
		Assets  map[string]tunnelAsset `json:"assets"`
	}
	if json.Unmarshal(tunnelGOSTLock, &lock) != nil {
		return "", "", errors.New("invalid built-in GOST release lock")
	}
	asset, ok := lock.Assets[runtime.GOOS+"/"+runtime.GOARCH]
	if !ok {
		return "", "", errors.New("GOST tunnels require Linux amd64 or arm64")
	}
	dir := filepath.Join(stateDir, "gost", lock.Version)
	if os.MkdirAll(dir, 0700) != nil {
		return "", "", errors.New("cannot create GOST cache")
	}
	archive := filepath.Join(dir, "release.tar.gz")
	if digest, _ := tunnelFileDigest(archive); digest != asset.SHA256 {
		if err := tunnelDownload(ctx, asset, archive); err != nil {
			return "", "", err
		}
	}
	f, err := os.Open(archive)
	if err != nil {
		return "", "", errors.New("cannot read verified GOST archive")
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", "", errors.New("invalid GOST archive")
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	var binary []byte
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", "", errors.New("invalid GOST archive contents")
		}
		if h.Name != "gost" && h.Name != "LICENSE" && h.Name != "README.md" {
			continue
		}
		if h.Typeflag != tar.TypeReg || h.Size <= 0 || h.Size > 128*1024*1024 {
			return "", "", errors.New("invalid GOST archive entry")
		}
		data, err := io.ReadAll(io.LimitReader(tr, 128*1024*1024+1))
		if err != nil || int64(len(data)) != h.Size {
			return "", "", errors.New("incomplete GOST archive entry")
		}
		if h.Name == "gost" {
			binary = data
		} else if err := tunnelWritePrivate(filepath.Join(dir, h.Name), data); err != nil {
			return "", "", err
		}
	}
	if len(binary) == 0 {
		return "", "", errors.New("official GOST archive has no executable")
	}
	path := filepath.Join(dir, "gost")
	if digest, _ := tunnelFileDigest(path); digest != tunnelDigest(binary) {
		if err := tunnelWritePrivate(path, binary); err != nil {
			return "", "", err
		}
	}
	if os.Chmod(path, 0700) != nil {
		return "", "", errors.New("cannot set GOST executable permissions")
	}
	return path, tunnelDigest(binary), nil
}

func tunnelDownload(ctx context.Context, asset tunnelAsset, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return errors.New("invalid GOST release URL")
	}
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" || len(via) > 5 {
			return errors.New("invalid GOST download redirect")
		}
		return nil
	}}
	res, err := client.Do(req)
	if err != nil {
		return errors.New("official GOST release download failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("official GOST release download was rejected")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 64*1024*1024+1))
	if err != nil || len(data) > 64*1024*1024 || tunnelDigest(data) != asset.SHA256 {
		return errors.New("official GOST release checksum mismatch or incomplete download")
	}
	return tunnelWritePrivate(path, data)
}
