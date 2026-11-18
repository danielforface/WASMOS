package trust

import (
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

//go:embed roots.json
var roots []byte

//go:embed blocked-spki.json
var blocked []byte

// No platform roots, private keys, or trust input from rendered pages.
func Profile() (*x509.CertPool, map[[32]byte]bool, error) {
	pool := x509.NewCertPool()
	deny := map[[32]byte]bool{}
	var certs, keys []string
	if json.Unmarshal(roots, &certs) != nil || json.Unmarshal(blocked, &keys) != nil || len(keys) == 0 || len(certs) == 0 {
		return nil, nil, errors.New("missing trust profile")
	}
	for _, s := range certs {
		der, e := base64.StdEncoding.DecodeString(s)
		if e != nil {
			return nil, nil, e
		}
		x, e := x509.ParseCertificate(der)
		if e != nil {
			return nil, nil, e
		}
		pool.AddCert(x)
	}
	for _, s := range keys {
		b, e := hex.DecodeString(s)
		if e != nil || len(b) != 32 {
			return nil, nil, errors.New("invalid distrust pin")
		}
		deny[[32]byte(b)] = true
	}
	return pool, deny, nil
}
