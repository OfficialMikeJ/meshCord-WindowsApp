package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"
)

// ChatServer is a server (guild) on the connected MeshCord instance.
type ChatServer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	IconColor   string `json:"iconColor"`
	MemberCount int    `json:"memberCount"`
	IsPublic    bool   `json:"isPublic"`
}

// Channel is a text or voice channel inside a server.
type Channel struct {
	ID       string `json:"id"`
	ServerID string `json:"serverId"`
	Name     string `json:"name"`
	Type     string `json:"type"` // "text" | "voice"
	Topic    string `json:"topic"`
}

// ChatMessage mirrors the server's message object.
type ChatMessage struct {
	ID          string              `json:"id"`
	ChannelID   string              `json:"channelId"`
	ServerID    string              `json:"serverId"`
	AuthorID    string              `json:"authorId"`
	AuthorName  string              `json:"authorName"`
	AuthorColor string              `json:"authorColor"`
	Content     string              `json:"content"`
	ReplyToID   string              `json:"replyToId"`
	Timestamp   int64               `json:"timestamp"`
	Edited      bool                `json:"edited"`
	Reactions   map[string][]string `json:"reactions,omitempty"`
}

func requireSession() (Session, error) {
	sess := loadSession()
	if sess.Domain == "" || sess.Token == "" {
		return sess, errors.New("Not connected — complete onboarding first")
	}
	return sess, nil
}

// ListServers returns all servers on the connected instance.
func (a *App) ListServers() ([]ChatServer, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/servers", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load servers")
	}
	var out struct {
		Servers []ChatServer `json:"servers"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Servers, nil
}

// ListChannels returns the channels of a server.
func (a *App) ListChannels(serverID string) ([]Channel, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/servers/"+url.PathEscape(serverID)+"/channels", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load channels")
	}
	var out struct {
		Channels []Channel `json:"channels"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Channels, nil
}

// FetchMessages returns the most recent messages of a channel (oldest first).
func (a *App) FetchMessages(channelID string) ([]ChatMessage, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/channels/"+url.PathEscape(channelID)+"/messages?limit=100", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load messages")
	}
	var out struct {
		Messages []ChatMessage `json:"messages"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Messages, nil
}

// SendChatMessage posts a message to a channel and returns the stored message.
func (a *App) SendChatMessage(channelID, content, authorName, authorColor string) (ChatMessage, error) {
	sess, err := requireSession()
	if err != nil {
		return ChatMessage{}, err
	}
	if authorName == "" {
		authorName = sess.Username
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/channels/"+url.PathEscape(channelID)+"/messages", sess.Token, map[string]string{
		"content": content, "authorName": authorName, "authorColor": authorColor,
	})
	if err != nil {
		return ChatMessage{}, err
	}
	if status < 200 || status >= 300 {
		return ChatMessage{}, errorFromBody(body, "Could not send message")
	}
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return ChatMessage{}, err
	}
	return out.Message, nil
}

// CreateServer creates a server on the connected instance and returns it.
func (a *App) CreateServer(name, description, category, template string, isPublic bool) (ChatServer, error) {
	sess, err := requireSession()
	if err != nil {
		return ChatServer{}, err
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/servers", sess.Token, map[string]any{
		"name": name, "description": description, "category": category,
		"template": template, "isPublic": isPublic,
	})
	if err != nil {
		return ChatServer{}, err
	}
	if status < 200 || status >= 300 {
		return ChatServer{}, errorFromBody(body, "Could not create server")
	}
	var out struct {
		Server ChatServer `json:"server"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return ChatServer{}, err
	}
	a.subscribeRealtime(out.Server.ID)
	return out.Server, nil
}

// CreateChannel creates a text channel in a server and returns it.
func (a *App) CreateChannel(serverID, name string) (Channel, error) {
	sess, err := requireSession()
	if err != nil {
		return Channel{}, err
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/servers/"+url.PathEscape(serverID)+"/channels", sess.Token, map[string]string{
		"name": name, "type": "text",
	})
	if err != nil {
		return Channel{}, err
	}
	if status < 200 || status >= 300 {
		return Channel{}, errorFromBody(body, "Could not create channel")
	}
	var out struct {
		Channel Channel `json:"channel"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Channel{}, err
	}
	return out.Channel, nil
}

// UpdateServer renames a server and/or changes its description.
func (a *App) UpdateServer(serverID, name, description string) (ChatServer, error) {
	sess, err := requireSession()
	if err != nil {
		return ChatServer{}, err
	}
	status, body, err := a.apiPatch(sess.Domain, "/api/v1/servers/"+url.PathEscape(serverID), sess.Token,
		map[string]string{"name": name, "description": description})
	if err != nil {
		return ChatServer{}, err
	}
	if status < 200 || status >= 300 {
		return ChatServer{}, errorFromBody(body, "Could not update server")
	}
	var out struct {
		Server ChatServer `json:"server"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return ChatServer{}, err
	}
	return out.Server, nil
}

// DeleteServer permanently removes a server from the instance.
func (a *App) DeleteServer(serverID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiDelete(sess.Domain, "/api/v1/servers/"+url.PathEscape(serverID), sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not delete server")
	}
	return nil
}

// LeaveServer removes us from a server's member list.
func (a *App) LeaveServer(serverID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	if sess.UserID == "" {
		return errors.New("This session predates member tracking — sign in again to leave servers")
	}
	status, body, err := a.apiDelete(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/members/"+url.PathEscape(sess.UserID), sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not leave server")
	}
	return nil
}

// PingServer measures the round-trip time to the instance's /health endpoint
// in milliseconds. Returns an error when not connected or unreachable.
func (a *App) PingServer() (int64, error) {
	sess, err := requireSession()
	if err != nil {
		return 0, err
	}
	start := time.Now()
	status, _, err := a.apiGet(sess.Domain, "/health", "")
	if err != nil {
		return 0, err
	}
	if status < 200 || status >= 300 {
		return 0, fmt.Errorf("health check failed (HTTP %d)", status)
	}
	return time.Since(start).Milliseconds(), nil
}

// ReplyChatMessage posts a message that replies to another message.
func (a *App) ReplyChatMessage(channelID, replyToID, content, authorName, authorColor string) (ChatMessage, error) {
	sess, err := requireSession()
	if err != nil {
		return ChatMessage{}, err
	}
	if authorName == "" {
		authorName = sess.Username
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/channels/"+url.PathEscape(channelID)+"/messages", sess.Token, map[string]string{
		"content": content, "authorName": authorName, "authorColor": authorColor,
		"replyToId": replyToID,
	})
	if err != nil {
		return ChatMessage{}, err
	}
	if status < 200 || status >= 300 {
		return ChatMessage{}, errorFromBody(body, "Could not send reply")
	}
	var out struct {
		Message ChatMessage `json:"message"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return ChatMessage{}, err
	}
	return out.Message, nil
}

// ToggleReaction flips the caller's emoji on a message.
func (a *App) ToggleReaction(channelID, msgID, emoji string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(msgID)+"/reactions",
		sess.Token, map[string]string{"emoji": emoji})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not react")
	}
	return nil
}

// EditChatMessage edits one of the caller's own messages.
func (a *App) EditChatMessage(channelID, msgID, content string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPatch(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(msgID),
		sess.Token, map[string]string{"content": content})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not edit message")
	}
	return nil
}

// DeleteChatMessage deletes a message (own, or any when staff).
func (a *App) DeleteChatMessage(channelID, msgID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiDelete(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(msgID),
		sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not delete message")
	}
	return nil
}
