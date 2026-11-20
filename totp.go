package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Port of src/crypto/Totp.cpp — RFC 6238 TOTP, SHA1, 6 digits, 30s period.

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

func generateSecretRaw() ([]byte, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	return secret, nil
}

func otpauthURI(account, base32Secret, issuer string) string {
	iss := strings.ReplaceAll(issuer, " ", "+")
	acc := strings.ReplaceAll(account, " ", "+")
	return fmt.Sprintf(
		"otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=6&period=30",
		iss, acc, base32Secret, iss,
	)
}

func totpCompute(rawSecret []byte, timeStep int64) int {
	msg := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		msg[i] = byte(timeStep & 0xFF)
		timeStep >>= 8
	}
	mac := hmac.New(sha1.New, rawSecret)
	mac.Write(msg)
	sum := mac.Sum(nil)
	if len(sum) < 20 {
		return -1
	}
	offset := sum[19] & 0x0F
	code := (int(sum[offset]&0x7F) << 24) |
		(int(sum[offset+1]&0xFF) << 16) |
		(int(sum[offset+2]&0xFF) << 8) |
		int(sum[offset+3]&0xFF)
	return code % 1000000
}

// GenerateTOTP creates a fresh secret and returns the base32 secret, otpauth
// URI, and a QR-code PNG data URI for the given account name.
func (a *App) GenerateTOTP(account string) (TOTPSetup, error) {
	raw, err := generateSecretRaw()
	if err != nil {
		return TOTPSetup{}, err
	}
	secret := b32.EncodeToString(raw)
	uri := otpauthURI(account, secret, "MeshCord")
	qr, err := qrDataURI(uri)
	if err != nil {
		return TOTPSetup{}, err
	}
	return TOTPSetup{Secret: secret, URI: uri, QR: qr}, nil
}

// VerifyTOTP checks a 6-digit code against a base32 secret, allowing ±1 step.
func (a *App) VerifyTOTP(base32Secret, code string) bool {
	raw, err := b32.DecodeString(strings.ToUpper(strings.TrimSpace(base32Secret)))
	if err != nil {
		return false
	}
	icode, err := strconv.Atoi(strings.TrimSpace(code))
	if err != nil {
		return false
	}
	step := time.Now().Unix() / 30
	for d := int64(-1); d <= 1; d++ {
		if totpCompute(raw, step+d) == icode {
			return true
		}
	}
	return false
}
