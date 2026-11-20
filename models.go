package main

// Activity is the currently-detected foreground/running app, mirroring the
// old Qt ActivityDetector::ActivityInfo. Empty Name means "nothing detected".
type Activity struct {
	Type string `json:"type"` // e.g. "Playing", "Listening to"
	Name string `json:"name"` // e.g. "Arma 3", "Spotify"
}

// TOTPSetup is everything the UI needs to show a 2FA enrolment screen:
// the base32 secret (for manual entry), the otpauth:// URI, and a ready-to-show
// QR code as a PNG data URI.
type TOTPSetup struct {
	Secret string `json:"secret"` // base32, no padding
	URI    string `json:"uri"`    // otpauth://totp/...
	QR     string `json:"qr"`     // data:image/png;base64,...
}
