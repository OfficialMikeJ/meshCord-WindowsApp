package main

import (
	"encoding/json"
	"errors"
	"net/url"
)

// NodeInfo is the public node card returned by GET /api/v1/node.
type NodeInfo struct {
	NodeID           string `json:"nodeId"`
	Domain           string `json:"domain"`
	Version          string `json:"version"`
	DiscoveryEnabled bool   `json:"discoveryEnabled"`
	UptimeSec        int64  `json:"uptimeSec"`
	Me               struct {
		UserID   string `json:"userId"`
		Username string `json:"username"`
		Role     string `json:"role"`
	} `json:"me"`
}

// MyProfile is the signed-in user's profile (GET/PATCH /api/v1/auth/me).
type MyProfile struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	Role         string `json:"role"`
	IsBot        bool   `json:"isBot"`
	AvatarColor  string `json:"avatarColor"`
	AvatarURL    string `json:"avatarUrl"`
	Status       string `json:"status"`
	CustomStatus string `json:"customStatus"`
	Pronouns     string `json:"pronouns"`
	Decoration   string `json:"decoration"`
	About        string `json:"about"`
	MeshID       string `json:"meshId"`
	CreatedAt    int64  `json:"createdAt"`
}

// BotCard is a MeshCord bot directory entry.
type BotCard struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	AvatarColor string   `json:"avatarColor"`
	Online      bool     `json:"online"`
	Servers     []string `json:"servers"`
}

// DmInfo is a direct-message channel with its latest message.
type DmInfo struct {
	ID           string      `json:"id"`
	Participants []string    `json:"participants"`
	LastMessage  *ChatMessage `json:"lastMessage"`
}

// ThreadInfo is a message thread inside a channel.
type ThreadInfo struct {
	ID            string       `json:"id"`
	ParentMsgID   string       `json:"parentMsgId"`
	ChannelID     string       `json:"channelId"`
	Name          string       `json:"name"`
	CreatedAt     int64        `json:"createdAt"`
	MessageCount  int          `json:"messageCount"`
	ParentMessage *ChatMessage `json:"parentMessage"`
}

// GetNodeInfo returns the connected node's public card — including whether
// discovery is enabled and the caller's role.
func (a *App) GetNodeInfo() (NodeInfo, error) {
	sess, err := requireSession()
	if err != nil {
		return NodeInfo{}, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/node", sess.Token)
	if err != nil {
		return NodeInfo{}, err
	}
	if status < 200 || status >= 300 {
		return NodeInfo{}, errorFromBody(body, "Could not load node info")
	}
	var out NodeInfo
	if err := json.Unmarshal(body, &out); err != nil {
		return NodeInfo{}, err
	}
	return out, nil
}

// SetNodeDiscovery toggles whether the node appears in public discovery
// (admin only — non-admin calls are rejected by the server).
func (a *App) SetNodeDiscovery(enabled bool) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPatch(sess.Domain, "/api/v1/node", sess.Token,
		map[string]bool{"discoveryEnabled": enabled})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not update node settings")
	}
	return nil
}

// GetMyProfile returns the signed-in user's profile from the instance.
func (a *App) GetMyProfile() (MyProfile, error) {
	sess, err := requireSession()
	if err != nil {
		return MyProfile{}, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/auth/me", sess.Token)
	if err != nil {
		return MyProfile{}, err
	}
	if status < 200 || status >= 300 {
		return MyProfile{}, errorFromBody(body, "Could not load profile")
	}
	var out struct {
		Profile MyProfile `json:"profile"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return MyProfile{}, err
	}
	return out.Profile, nil
}

// UploadAvatar pushes a base64 data-URL profile picture to the node.
// The node stores it under data/avatars/ and returns the new avatar URL.
func (a *App) UploadAvatar(dataURL string) (string, error) {
	sess, err := requireSession()
	if err != nil {
		return "", err
	}
	// Empty string removes the avatar (DELETE), anything else uploads.
	if dataURL == "" {
		status, body, err := a.apiDelete(sess.Domain, "/api/v1/users/@me/avatar", sess.Token)
		if err != nil {
			return "", err
		}
		if status < 200 || status >= 300 {
			return "", errorFromBody(body, "Could not remove avatar")
		}
		return "", nil
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/users/@me/avatar",
		sess.Token, map[string]string{"avatar": dataURL})
	if err != nil {
		return "", err
	}
	var out struct {
		AvatarURL string `json:"avatarUrl"`
	}
	json.Unmarshal(body, &out)
	if status < 200 || status >= 300 {
		return "", errorFromBody(body, "Avatar upload failed")
	}
	return out.AvatarURL, nil
}

// SetMyStatus updates presence on the node — "online" | "idle" | "dnd" |
// "offline" (invisible). The node broadcasts it to every member list.
func (a *App) SetMyStatus(status string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	code, body, err := a.apiPatch(sess.Domain, "/api/v1/users/@me/status",
		sess.Token, map[string]string{"status": status})
	if err != nil {
		return err
	}
	if code < 200 || code >= 300 {
		return errorFromBody(body, "Could not update status")
	}
	return nil
}

// UpdateMyProfile saves profile fields to the instance (custom status, avatar
// colour, pronouns, about, decoration). Other users see these next to your
// messages and on your profile card.
func (a *App) UpdateMyProfile(customStatus, avatarColor, pronouns, decoration, about string) (MyProfile, error) {
	sess, err := requireSession()
	if err != nil {
		return MyProfile{}, err
	}
	status, body, err := a.apiPatch(sess.Domain, "/api/v1/auth/me", sess.Token,
		map[string]string{
			"customStatus": customStatus,
			"avatarColor":  avatarColor,
			"pronouns":     pronouns,
			"decoration":   decoration,
			"about":        about,
		})
	if err != nil {
		return MyProfile{}, err
	}
	if status < 200 || status >= 300 {
		return MyProfile{}, errorFromBody(body, "Could not save profile")
	}
	var out struct {
		User MyProfile `json:"user"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return MyProfile{}, err
	}
	return out.User, nil
}

// SetServerPublic toggles a server's public listing in this node's discovery.
func (a *App) SetServerPublic(serverID string, isPublic bool) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPatch(sess.Domain, "/api/v1/servers/"+url.PathEscape(serverID),
		sess.Token, map[string]bool{"isPublic": isPublic})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not update server")
	}
	return nil
}

// ListBots returns the node's registered MeshCord bots for the Bot Discovery tab.
func (a *App) ListBots() ([]BotCard, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/bots", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load bots")
	}
	var out struct {
		Bots []BotCard `json:"bots"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Bots, nil
}

// AddBotToServer installs a registered bot into one of your servers (admin only).
func (a *App) AddBotToServer(botID, serverID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/bots/"+url.PathEscape(botID)+"/servers/"+url.PathEscape(serverID),
		sess.Token, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not add bot")
	}
	return nil
}

// ListPins returns the pinned messages of a channel.
func (a *App) ListPins(channelID string) ([]ChatMessage, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/pins", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load pins")
	}
	var out struct {
		Pins []ChatMessage `json:"pins"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Pins, nil
}

// PinMessage pins a message in the channel (any member may pin, like Discord).
func (a *App) PinMessage(channelID, msgID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPut(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/pins/"+url.PathEscape(msgID),
		sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not pin message")
	}
	return nil
}

// UnpinMessage removes a pin.
func (a *App) UnpinMessage(channelID, msgID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiDelete(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/pins/"+url.PathEscape(msgID),
		sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not unpin message")
	}
	return nil
}

// ListThreads returns the threads that live in a channel.
func (a *App) ListThreads(channelID string) ([]ThreadInfo, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/threads", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load threads")
	}
	var out struct {
		Threads []ThreadInfo `json:"threads"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Threads, nil
}

// CreateThread starts a thread on a message.
func (a *App) CreateThread(channelID, msgID, name string) (ThreadInfo, error) {
	sess, err := requireSession()
	if err != nil {
		return ThreadInfo{}, err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/channels/"+url.PathEscape(channelID)+"/messages/"+url.PathEscape(msgID)+"/thread",
		sess.Token, map[string]string{"name": name})
	if err != nil {
		return ThreadInfo{}, err
	}
	if status < 200 || status >= 300 {
		return ThreadInfo{}, errorFromBody(body, "Could not create thread")
	}
	var out struct {
		Thread ThreadInfo `json:"thread"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return ThreadInfo{}, err
	}
	return out.Thread, nil
}

// ListDMs returns your direct-message channels with their latest message —
// feeds the Inbox dropdown.
func (a *App) ListDMs() ([]DmInfo, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, "/api/v1/users/@me/dms", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load direct messages")
	}
	var out struct {
		DMs []DmInfo `json:"dms"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.DMs, nil
}

// SearchChannel runs a server-side search inside the current channel.
func (a *App) SearchChannel(channelID, query string) ([]ChatMessage, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	if len(query) < 2 {
		return nil, errors.New("Search needs at least 2 characters")
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/search?q="+url.QueryEscape(query)+"&channelId="+url.PathEscape(channelID),
		sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Search failed")
	}
	var out struct {
		Results []ChatMessage `json:"results"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Results, nil
}
