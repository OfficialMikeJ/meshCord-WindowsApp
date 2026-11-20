package main

import (
	"encoding/json"
	"net/url"
)

// ── Member moderation + context-menu actions ────────────────────────────────

type Dm struct {
	ID           string   `json:"id"`
	Participants []string `json:"participants"`
}

// OpenDm creates-or-returns a DM with the given username.
func (a *App) OpenDm(username string) (Dm, error) {
	sess, err := requireSession()
	if err != nil {
		return Dm{}, err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/users/"+url.PathEscape(username)+"/dm", sess.Token, nil)
	if err != nil {
		return Dm{}, err
	}
	if status < 200 || status >= 300 {
		return Dm{}, errorFromBody(body, "Could not open DM")
	}
	var out struct {
		Dm Dm `json:"dm"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Dm{}, err
	}
	return out.Dm, nil
}

// TimeoutMember silences a member for durationMs (staff only).
func (a *App) TimeoutMember(serverID, userID string, durationMs int64) error {
	return a.memberAction(serverID, userID, "mute",
		map[string]int64{"durationMs": durationMs}, "Could not time out member")
}

// KickMember removes a member from the server (staff only).
func (a *App) KickMember(serverID, userID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiDelete(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/members/"+url.PathEscape(userID),
		sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not kick member")
	}
	return nil
}

// BanMember permanently bans a member from the server (staff only).
func (a *App) BanMember(serverID, userID, reason string) error {
	return a.memberAction(serverID, userID, "ban",
		map[string]string{"reason": reason}, "Could not ban member")
}

func (a *App) memberAction(serverID, userID, action string,
	payload interface{}, failMsg string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/members/"+url.PathEscape(userID)+"/"+action,
		sess.Token, payload)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, failMsg)
	}
	return nil
}

// SetMemberRoles replaces a member's role assignment (staff only).
func (a *App) SetMemberRoles(serverID, userID string, roleIDs []string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPatch(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/members/"+url.PathEscape(userID)+"/roles",
		sess.Token, map[string][]string{"roleIds": roleIDs})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not update member roles")
	}
	return nil
}

// AddAdminNote leaves a staff-visible note on a user (admin only).
func (a *App) AddAdminNote(username, serverID, note string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/users/"+url.PathEscape(username)+"/admin-notes", sess.Token,
		map[string]string{"note": note, "serverId": serverID})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not save note")
	}
	return nil
}

// ReportMessage files a staff-visible report on a message.
func (a *App) ReportMessage(serverID, channelID, messageID, reason string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiPost(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/reports", sess.Token,
		map[string]string{
			"channelId": channelID, "messageId": messageID, "reason": reason,
		})
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not report message")
	}
	return nil
}
