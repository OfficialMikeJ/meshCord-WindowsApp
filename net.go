package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

// DiscoveryServer is a public-safe server entry from the Discover tab.
// Note: the server's domain/owner is intentionally never included.
type DiscoveryServer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Category    string `json:"category"`
	IconColor   string `json:"iconColor"`
	MemberCount int    `json:"memberCount"`
}

type authResponse struct {
	Token string `json:"token"`
	User  struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Role     string `json:"role"`
		MeshID   string `json:"meshId"`
	} `json:"user"`
	Error string `json:"error"`
}

// normalizeDomain enforces the https:// requirement and trims trailing slashes.
func normalizeDomain(domain string) (string, error) {
	d := strings.TrimSpace(domain)
	if d == "" {
		return "", errors.New("Please enter your server domain")
	}
	if strings.HasPrefix(strings.ToLower(d), "http://") {
		return "", errors.New("Insecure http:// is not allowed — use https://")
	}
	if !strings.HasPrefix(strings.ToLower(d), "https://") {
		return "", errors.New("Domain must start with https://")
	}
	return strings.TrimRight(d, "/"), nil
}

func (a *App) apiPost(domain, path, token string, body any) (int, []byte, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return 0, nil, err
		}
	}
	req, err := http.NewRequest(http.MethodPost, domain+path, &buf)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("could not reach server: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func (a *App) apiGet(domain, path, token string) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodGet, domain+path, nil)
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("could not reach server: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func (a *App) apiPatch(domain, path, token string, body any) (int, []byte, error) {
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			return 0, nil, err
		}
	}
	req, err := http.NewRequest(http.MethodPatch, domain+path, &buf)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("could not reach server: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func (a *App) apiPut(domain, path, token string) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodPut, domain+path, nil)
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("could not reach server: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func (a *App) apiDelete(domain, path, token string) (int, []byte, error) {
	req, err := http.NewRequest(http.MethodDelete, domain+path, nil)
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("could not reach server: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, data, nil
}

func errorFromBody(data []byte, fallback string) error {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &e) == nil && e.Error != "" {
		return errors.New(e.Error)
	}
	return errors.New(fallback)
}

// Connect performs first-run onboarding: it tries to create the Master Admin
// (bootstrap); if one already exists it falls back to logging in with the same
// credentials. On success the session is persisted and returned.
func (a *App) Connect(domain, username, password string) (Session, error) {
	d, err := normalizeDomain(domain)
	if err != nil {
		return Session{}, err
	}

	// 1) Try to create the Master Admin.
	status, body, err := a.apiPost(d, "/api/v1/auth/bootstrap", "", map[string]string{
		"username": username, "password": password,
	})
	if err != nil {
		return Session{}, err
	}

	// 2) If an admin already exists, fall back to login.
	if status == http.StatusConflict {
		status, body, err = a.apiPost(d, "/api/v1/auth/login", "", map[string]string{
			"username": username, "password": password,
		})
		if err != nil {
			return Session{}, err
		}
	}

	if status < 200 || status >= 300 {
		return Session{}, errorFromBody(body, "Sign-in failed")
	}

	var ar authResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return Session{}, fmt.Errorf("unexpected server response: %w", err)
	}

	sess := Session{
		Domain:   d,
		Token:    ar.Token,
		UserID:   ar.User.ID,
		Username: ar.User.Username,
		Role:     ar.User.Role,
		MeshID:   ar.User.MeshID,
	}
	if sess.Username == "" {
		sess.Username = username
	}
	if err := saveSession(sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

// Register creates a regular user account on an existing instance and logs in.
// Used when onboarding into an instance that already has a Master Admin —
// bootstrap would return 409 for it. If the username is taken it falls back to
// login, matching Connect's behaviour for returning users.
func (a *App) Register(domain, username, password string) (Session, error) {
	d, err := normalizeDomain(domain)
	if err != nil {
		return Session{}, err
	}

	status, body, err := a.apiPost(d, "/api/v1/auth/register", "", map[string]string{
		"username": username, "password": password,
	})
	if err != nil {
		return Session{}, err
	}

	// Username already taken — maybe it is our account; try to log in.
	if status == http.StatusConflict {
		status, body, err = a.apiPost(d, "/api/v1/auth/login", "", map[string]string{
			"username": username, "password": password,
		})
		if err != nil {
			return Session{}, err
		}
	}

	if status < 200 || status >= 300 {
		return Session{}, errorFromBody(body, "Registration failed")
	}

	var ar authResponse
	if err := json.Unmarshal(body, &ar); err != nil {
		return Session{}, fmt.Errorf("unexpected server response: %w", err)
	}

	sess := Session{
		Domain:   d,
		Token:    ar.Token,
		UserID:   ar.User.ID,
		Username: ar.User.Username,
		Role:     ar.User.Role,
		MeshID:   ar.User.MeshID,
	}
	if sess.Username == "" {
		sess.Username = username
	}
	if err := saveSession(sess); err != nil {
		return Session{}, err
	}
	return sess, nil
}

// Discover lists public servers on the connected instance, filtered by an
// optional search query and category ("" or "All" = no category filter).
func (a *App) Discover(query, category string) ([]DiscoveryServer, error) {
	sess := loadSession()
	if sess.Domain == "" || sess.Token == "" {
		return nil, errors.New("Not connected — complete onboarding first")
	}

	q := url.Values{}
	if query != "" {
		q.Set("q", query)
	}
	if category != "" && category != "All" {
		q.Set("category", category)
	}
	path := "/api/v1/discovery"
	if enc := q.Encode(); enc != "" {
		path += "?" + enc
	}

	status, body, err := a.apiGet(sess.Domain, path, sess.Token)
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, errorFromBody(body, "Could not load servers")
	}

	var out struct {
		Servers []DiscoveryServer `json:"servers"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return out.Servers, nil
}

// JoinDiscoveredServer joins a public server by id.
func (a *App) JoinDiscoveredServer(id string) error {
	sess := loadSession()
	if sess.Domain == "" || sess.Token == "" {
		return errors.New("Not connected — complete onboarding first")
	}
	status, body, err := a.apiPost(sess.Domain, "/api/v1/discovery/"+url.PathEscape(id)+"/join", sess.Token, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return errorFromBody(body, "Could not join server")
	}
	return nil
}
