package main

import (
	"os"
	"path/filepath"
)

// dataDir returns the per-user MeshCord config directory, creating it if needed.
// Replaces the Qt AppData on-disk location and the Electron servers.json file.
func dataDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "MeshCord")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func statePath() (string, error) {
	dir, err := dataDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "state.json"), nil
}

// LoadData returns the saved client state as a raw JSON string (profile +
// servers). Returns "{}" when nothing has been saved yet. The frontend owns the
// shape of this blob, exactly like the old renderer.js did with servers.json.
func (a *App) LoadData() (string, error) {
	path, err := statePath()
	if err != nil {
		return "{}", err
	}
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return "{}", nil
	}
	if err != nil {
		return "{}", err
	}
	if len(b) == 0 {
		return "{}", nil
	}
	return string(b), nil
}

// SaveData persists the client state JSON blob to disk.
func (a *App) SaveData(data string) error {
	path, err := statePath()
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(data), 0o644)
}
