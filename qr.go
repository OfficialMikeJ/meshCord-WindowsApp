package main

import (
	"encoding/base64"

	"github.com/skip2/go-qrcode"
)

// qrDataURI renders text as a QR code and returns it as a PNG data URI.
// Replaces the 461-line hand-rolled QR generator in src/crypto/QrCode.cpp.
func qrDataURI(text string) (string, error) {
	png, err := qrcode.Encode(text, qrcode.Medium, 256)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}
