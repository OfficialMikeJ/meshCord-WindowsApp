package main

import (
	"context"
)

// App is the Wails backend. Methods with exported names are bound and callable
// from the frontend via ../wailsjs/go/main/App. The actual logic lives in the
// sibling files: store.go (persistence), totp.go / qr.go (2FA), activity.go.
type App struct {
	ctx context.Context
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
