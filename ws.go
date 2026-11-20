package main

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// The realtime bridge keeps a WebSocket open to the connected instance's /ws
// endpoint and forwards every server frame to the frontend:
//
//	EventsEmit("realtime:event", "<raw JSON frame>")   — chat events
//	EventsEmit("realtime:status", "connecting" | "connected" | "disconnected" | "auth-failed")
//
// The frontend starts it with StartRealtime() after boot/onboarding and adds
// subscriptions with SubscribeServer(id) when joining or creating servers.

type wsFrame struct {
	Type string         `json:"type"`
	Data map[string]any `json:"data,omitempty"`
}

type realtimeBridge struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	desired map[string]bool // server ids to (re)subscribe to on every connect
	stop    chan struct{}
	running bool
}

var bridge = realtimeBridge{desired: map[string]bool{}}

var wsDialer = &websocket.Dialer{HandshakeTimeout: 10 * time.Second}

func (a *App) emit(event string, payload ...any) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, event, payload...)
}

// StartRealtime connects to the instance's WebSocket and keeps the connection
// alive with automatic reconnects. Safe to call more than once.
func (a *App) StartRealtime() error {
	if _, err := requireSession(); err != nil {
		return err
	}

	bridge.mu.Lock()
	if bridge.running {
		bridge.mu.Unlock()
		return nil
	}
	bridge.running = true
	bridge.stop = make(chan struct{})
	stop := bridge.stop
	bridge.mu.Unlock()

	go a.realtimeLoop(stop)
	return nil
}

// StopRealtime closes the WebSocket and stops reconnecting.
func (a *App) StopRealtime() {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if !bridge.running {
		return
	}
	bridge.running = false
	close(bridge.stop)
	if bridge.conn != nil {
		bridge.conn.Close()
		bridge.conn = nil
	}
}

// SubscribeServer subscribes the realtime connection to a server's events and
// remembers it for future reconnects.
func (a *App) SubscribeServer(serverID string) {
	a.subscribeRealtime(serverID)
}

func (a *App) subscribeRealtime(serverID string) {
	if serverID == "" {
		return
	}
	bridge.mu.Lock()
	bridge.desired[serverID] = true
	conn := bridge.conn
	bridge.mu.Unlock()
	if conn != nil {
		writeFrame(conn, wsFrame{Type: "subscribe", Data: map[string]any{"serverId": serverID}})
	}
}

func writeFrame(conn *websocket.Conn, frame wsFrame) error {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(frame)
}

// SendRealtime forwards a raw JSON frame from the frontend to the instance over
// the realtime socket. Voice signalling uses this: the SDP/ICE payloads are
// produced by the WebView's WebRTC stack and pass through untouched.
func (a *App) SendRealtime(payload string) error {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if bridge.conn == nil {
		return errors.New("realtime connection is not open")
	}
	bridge.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return bridge.conn.WriteMessage(websocket.TextMessage, []byte(payload))
}

func stopped(stop chan struct{}) bool {
	select {
	case <-stop:
		return true
	default:
		return false
	}
}

func (a *App) realtimeLoop(stop chan struct{}) {
	backoff := time.Second

	for !stopped(stop) {
		// Session is re-read every attempt so a re-login picks up a new token.
		sess := loadSession()
		if sess.Domain == "" || sess.Token == "" {
			a.emit("realtime:status", "auth-failed")
			a.markStopped(stop)
			return
		}

		a.emit("realtime:status", "connecting")
		wsURL := "wss://" + strings.TrimPrefix(sess.Domain, "https://") + "/ws"
		conn, _, err := wsDialer.Dial(wsURL, nil)
		if err != nil {
			a.emit("realtime:status", "disconnected")
			if !sleepOrStop(backoff, stop) {
				a.markStopped(stop)
				return
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}

		bridge.mu.Lock()
		bridge.conn = conn
		bridge.mu.Unlock()

		writeFrame(conn, wsFrame{Type: "auth", Data: map[string]any{
			"token": sess.Token, "username": sess.Username, "userId": sess.MeshID,
		}})

		// (Re)subscribe: everything the instance lists plus anything requested
		// explicitly since the last connect.
		if servers, err := a.ListServers(); err == nil {
			bridge.mu.Lock()
			for _, s := range servers {
				bridge.desired[s.ID] = true
			}
			bridge.mu.Unlock()
		}
		bridge.mu.Lock()
		ids := make([]string, 0, len(bridge.desired))
		for id := range bridge.desired {
			ids = append(ids, id)
		}
		bridge.mu.Unlock()
		for _, id := range ids {
			writeFrame(conn, wsFrame{Type: "subscribe", Data: map[string]any{"serverId": id}})
		}

		a.emit("realtime:status", "connected")
		backoff = time.Second

		authFailed := a.readLoop(conn, stop)

		bridge.mu.Lock()
		bridge.conn = nil
		bridge.mu.Unlock()
		conn.Close()

		if authFailed {
			a.emit("realtime:status", "auth-failed")
			a.markStopped(stop)
			return
		}
		a.emit("realtime:status", "disconnected")
		if !sleepOrStop(backoff, stop) {
			a.markStopped(stop)
			return
		}
	}
	a.markStopped(stop)
}

// readLoop forwards frames until the connection drops. Returns true when the
// server rejected our credentials (do not reconnect with the same token).
func (a *App) readLoop(conn *websocket.Conn, stop chan struct{}) bool {
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return false
		}
		if stopped(stop) {
			return false
		}
		var frame wsFrame
		if json.Unmarshal(data, &frame) == nil && frame.Type == "auth.fail" {
			return true
		}
		a.emit("realtime:event", string(data))
	}
}

// markStopped clears the running flag, but only when this loop is still the
// current one — a Stop/Start pair may already have spawned a replacement.
func (a *App) markStopped(stop chan struct{}) {
	bridge.mu.Lock()
	if bridge.stop == stop {
		bridge.running = false
	}
	bridge.mu.Unlock()
}

// sleepOrStop waits for d; returns false if stopped first.
func sleepOrStop(d time.Duration, stop chan struct{}) bool {
	select {
	case <-stop:
		return false
	case <-time.After(d):
		return true
	}
}
