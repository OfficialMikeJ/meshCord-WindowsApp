package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Session is the desktop client's connection to a MeshCord instance, persisted
// across launches. An empty Domain means "not onboarded yet" (show onboarding).
type Session struct {
	Domain   string `json:"domain"`   // includes https:// scheme
	Token    string `json:"token"`    // JWT from bootstrap/login
	UserID   string `json:"userId"`   // our user id on the instance (JWT sub)
	Username string `json:"username"`
	Role     string `json:"role"`     // "admin" (Master Admin) or "user"
	MeshID   string `json:"meshId"`
}

func sessionPath() (string, error) {
	dir, err := dataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "session.json"), nil
}

func loadSession() Session {
	var s Session
	path, err := sessionPath()
	if err != nil {
		return s
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	_ = json.Unmarshal(b, &s)
	return s
}

func saveSession(s Session) error {
	path, err := sessionPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// GetSession returns the stored session (empty Domain => not onboarded).
func (a *App) GetSession() Session {
	return loadSession()
}

// Logout clears the stored session.
func (a *App) Logout() error {
	path, err := sessionPath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
