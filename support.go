package main

import (
	"encoding/json"
	"net/url"
)

// SupportConfig mirrors the node's per-server support-forum settings.
type SupportConfig struct {
	Open     bool   `json:"open"`
	Hours    string `json:"hours"`
	Timezone string `json:"timezone"`
}

// Invite mirrors a server invite code/link.
type Invite struct {
	Code       string `json:"code"`
	ServerID   string `json:"serverId"`
	ServerName string `json:"serverName"`
	IsCustom   bool   `json:"isCustom"`
	Uses       int    `json:"uses"`
	MaxUses    int    `json:"maxUses"`
	ExpiresAt  int64  `json:"expiresAt"`
}

// GetSupport returns the support-forum settings of a Community server.
func (a *App) GetSupport(serverID string) (SupportConfig, error) {
	sess, err := requireSession()
	if err != nil {
		return SupportConfig{}, err
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/support", sess.Token)
	if err != nil {
		return SupportConfig{}, err
	}
	if status < 200 || status >= 300 {
		return SupportConfig{}, errorFromBody(body, "Support is not available on this server")
	}
	var out struct {
		Support SupportConfig `json:"support"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return SupportConfig{}, err
	}
	return out.Support, nil
}

// OpenTicket opens a support ticket — the node enforces one ticket per user
// per 48h and the support open/closed hours.
func (a *App) OpenTicket(serverID string) (Channel, error) {
	sess, err := requireSession()
	if err != nil {
		return Channel{}, err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/support/tickets",
		sess.Token, nil)
	if err != nil {
		return Channel{}, err
	}
	if status < 200 || status >= 300 {
		return Channel{}, errorFromBody(body, "Could not open a ticket")
	}
	var out struct {
		Channel Channel `json:"channel"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Channel{}, err
	}
	return out.Channel, nil
}

// UpdateServerSupport saves the support settings — Main Admin only, and only
// on Community-category servers.
func (a *App) UpdateServerSupport(serverID string, open bool, hours, timezone string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPatch(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID), sess.Token,
		map[string]interface{}{
			"support": map[string]interface{}{
				"open": open, "hours": hours, "timezone": timezone,
			},
		})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not save support settings")
	}
	return nil
}

// ListInvites returns a server's invite links.
func (a *App) ListInvites(serverID string) ([]Invite, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/invites", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load invites")
	}
	var out struct {
		Invites []Invite `json:"invites"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Invites, nil
}

// CreateCustomInvite creates a permanent vanity invite on the node's domain:
// https://<node-domain>/invite/<slug>. Returns the invite plus the full URL.
func (a *App) CreateCustomInvite(serverID, slug string) (Invite, error) {
	sess, err := requireSession()
	if err != nil {
		return Invite{}, err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/invites", sess.Token,
		map[string]interface{}{
			"customSlug": slug, "expiresInHours": 0, "maxUses": 0,
		})
	if err != nil {
		return Invite{}, err
	}
	if status < 200 || status >= 300 {
		return Invite{}, errorFromBody(body, "Could not create invite")
	}
	var out struct {
		Invite Invite `json:"invite"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Invite{}, err
	}
	return out.Invite, nil
}
