package main

import (
	"encoding/json"
	"net/url"
)

// Role is a permission group on a server, mirroring the instance's role object.
// Permissions is a free-form flag map so a new server-side permission does not
// require a client change to round-trip.
type Role struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Color       string          `json:"color"`
	Badge       string          `json:"badge"`
	Permissions map[string]bool `json:"permissions"`
}

func rolesPath(serverID string) string {
	return "/api/v1/servers/" + url.PathEscape(serverID) + "/roles"
}

// ListRoles returns every role defined on a server.
func (a *App) ListRoles(serverID string) ([]Role, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain, rolesPath(serverID), sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load roles")
	}
	var out struct {
		Roles []Role `json:"roles"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Roles, nil
}

// CreateRole adds a role to a server and returns it.
func (a *App) CreateRole(serverID, name, color string) (Role, error) {
	sess, err := requireSession()
	if err != nil {
		return Role{}, err
	}
	status, body, err := a.apiPost(sess.Domain, rolesPath(serverID), sess.Token, map[string]any{
		"name": name, "color": color,
	})
	if err != nil {
		return Role{}, err
	}
	if status < 200 || status >= 300 {
		return Role{}, errorFromBody(body, "Could not create role")
	}
	var out struct {
		Role Role `json:"role"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Role{}, err
	}
	return out.Role, nil
}

// UpdateRole renames/recolours a role and replaces its permission flags.
func (a *App) UpdateRole(serverID, roleID, name, color string, permissions map[string]bool) (Role, error) {
	sess, err := requireSession()
	if err != nil {
		return Role{}, err
	}
	payload := map[string]any{"name": name, "color": color}
	// A nil map would clear every flag; only send permissions when supplied.
	if permissions != nil {
		payload["permissions"] = permissions
	}
	status, body, err := a.apiPatch(sess.Domain,
		rolesPath(serverID)+"/"+url.PathEscape(roleID), sess.Token, payload)
	if err != nil {
		return Role{}, err
	}
	if status < 200 || status >= 300 {
		return Role{}, errorFromBody(body, "Could not update role")
	}
	var out struct {
		Role Role `json:"role"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return Role{}, err
	}
	return out.Role, nil
}

// DeleteRole removes a role from a server.
func (a *App) DeleteRole(serverID, roleID string) error {
	sess, err := requireSession()
	if err != nil {
		return err
	}
	status, body, err := a.apiDelete(sess.Domain,
		rolesPath(serverID)+"/"+url.PathEscape(roleID), sess.Token)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not delete role")
	}
	return nil
}

// Member is a user who has joined a server, as shown in the member list.
type Member struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	AvatarColor string `json:"avatarColor"`
	AvatarURL   string `json:"avatarUrl"`
	Pronouns    string `json:"pronouns"`
	Decoration  string `json:"decoration"`
	Status      string `json:"status"` // "online" | "idle" | "dnd" | "offline"
	Role        string   `json:"role"`   // "admin" | "user"
	RoleIDs     []string `json:"roleIds,omitempty"`
	IsBot       bool     `json:"isBot"`
	Owner       bool     `json:"owner"`
}

// ListMembers returns the members of a server.
func (a *App) ListMembers(serverID string) ([]Member, error) {
	sess, err := requireSession()
	if err != nil {
		return nil, err
	}
	status, body, err := a.apiGet(sess.Domain,
		"/api/v1/servers/"+url.PathEscape(serverID)+"/members", sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load members")
	}
	var out struct {
		Members []Member `json:"members"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Members, nil
}
