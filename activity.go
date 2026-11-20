package main

import (
	"strings"

	ps "github.com/mitchellh/go-ps"
)

// Port of src/detection/ActivityDetector.cpp. Scans running processes and maps
// known executables to a human-readable activity (Discord "playing X" style).

type appEntry struct {
	exe  string
	typ  string
	name string
}

var knownApps = []appEntry{
	{"reforger.exe", "Playing", "Arma Reforger"},
	{"arma3.exe", "Playing", "Arma 3"},
	{"ace7game.exe", "Playing", "Ace Combat 7"},
	{"dcs.exe", "Playing", "DCS World"},
	{"spotify.exe", "Listening to", "Spotify"},
	{"chrome.exe", "Browsing", "Google Chrome"},
	{"firefox.exe", "Browsing", "Firefox"},
	{"msedge.exe", "Browsing", "Microsoft Edge"},
	{"code.exe", "Working on", "Visual Studio Code"},
	{"devenv.exe", "Working on", "Visual Studio"},
	{"rider64.exe", "Working on", "Rider"},
	{"slack.exe", "Chatting on", "Slack"},
	{"teams.exe", "In a call on", "Microsoft Teams"},
}

// DetectActivity returns the first matching known app among running processes,
// or an empty Activity if none are running. The frontend polls this.
func (a *App) DetectActivity() Activity {
	procs, err := ps.Processes()
	if err != nil {
		return Activity{}
	}
	for _, p := range procs {
		exe := strings.ToLower(p.Executable())
		for _, app := range knownApps {
			if exe == app.exe {
				return Activity{Type: app.typ, Name: app.name}
			}
		}
	}
	return Activity{}
}
