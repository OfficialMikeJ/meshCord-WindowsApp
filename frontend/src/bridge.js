// ─────────────────────────────────────────────────────────────────────────────
//  Platform bridge
//
//  Under Wails (desktop), window.go.main.App is injected by the Wails runtime
//  and this file does nothing. Everywhere else — the Android app's WebView, or
//  a plain browser tab — we polyfill the exact same surface in pure JS:
//
//    window.go.main.App.*    — REST calls via fetch, session in localStorage,
//                              realtime over the page's own WebSocket
//    window.runtime.*        — the subset of Wails runtime events the UI uses
//                              (EventsOn for realtime:event / realtime:status)
//
//  Kept identical to desktop/*.go behaviour: https:// enforcement, bootstrap →
//  login fallback, reconnect with exponential backoff, voice signalling frames
//  passed through untouched.
// ─────────────────────────────────────────────────────────────────────────────

const IS_WAILS = !!(window.go && window.go.main && window.go.main.App);
const IS_ANDROID = !!window.MeshCordAndroid;

export const isWails   = IS_WAILS;
export const isAndroid = IS_ANDROID;
export const isWeb     = !IS_WAILS;

// ── Event emitter (window.runtime + internal realtime fan-out) ───────────────

const eventHandlers = new Map();   // name → Set<fn>

function eventsOn(name, cb) {
    if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
    eventHandlers.get(name).add(cb);
    return () => eventsOff(name, cb);
}
function eventsOnce(name, cb) {
    const off = eventsOn(name, (...a) => { off(); cb(...a); });
    return off;
}
function eventsOff(name, ...extra) {
    [name, ...extra].forEach((n) => eventHandlers.delete(n));
}
function emitLocal(name, ...args) {
    (eventHandlers.get(name) || []).forEach((cb) => {
        try { cb(...args); } catch (err) { console.error('[bridge] event handler failed:', err); }
    });
}

// ── Session / state persistence ──────────────────────────────────────────────

const LS_SESSION = 'meshcord.session';
const LS_STATE   = 'meshcord.state';

function loadSession() {
    try { return JSON.parse(localStorage.getItem(LS_SESSION) || '{}'); }
    catch { return {}; }
}
function saveSession(s) { localStorage.setItem(LS_SESSION, JSON.stringify(s)); }

function requireSession() {
    const s = loadSession();
    if (!s.domain || !s.token) throw new Error('Not connected — complete onboarding first');
    return s;
}

// ── HTTP helpers (mirrors net.go) ────────────────────────────────────────────

function normalizeDomain(domain) {
    const d = String(domain || '').trim();
    if (!d) throw new Error('Please enter your server domain');
    if (/^http:\/\//i.test(d)) throw new Error('Insecure http:// is not allowed — use https://');
    if (!/^https:\/\//i.test(d)) throw new Error('Domain must start with https://');
    return d.replace(/\/+$/, '');
}

async function api(domain, method, path, token, body) {
    let res;
    try {
        res = await fetch(domain + path, {
            method,
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        throw new Error(`could not reach server: ${err.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status < 200 || res.status >= 300) {
        throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    }
    return data;
}

function sessionFromAuth(domain, ar, fallbackName) {
    const sess = {
        domain,
        token:    ar.token,
        userId:   ar.user?.id       || '',
        username: ar.user?.username || fallbackName,
        role:     ar.user?.role     || 'user',
        meshId:   ar.user?.meshId   || '',
    };
    saveSession(sess);
    return sess;
}

async function apiPostMaybe(domain, path, body) {
    const res = await fetch(domain + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).catch((err) => { throw new Error(`could not reach server: ${err.message}`); });
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Realtime socket (port of ws.go) ──────────────────────────────────────────

const realtime = {
    ws: null,
    desired: new Set(),      // server ids to (re)subscribe to on every connect
    running: false,
    backoff: 1000,
    timer: null,
};

function wsUrl(domain) {
    return 'wss://' + domain.replace(/^https:\/\//i, '') + '/ws';
}

function realtimeConnect() {
    const sess = loadSession();
    if (!sess.domain || !sess.token) {
        emitLocal('realtime:status', 'auth-failed');
        realtime.running = false;
        return;
    }
    emitLocal('realtime:status', 'connecting');

    let ws;
    try {
        ws = new WebSocket(wsUrl(sess.domain));
    } catch {
        return realtimeScheduleRetry();
    }
    realtime.ws = ws;

    ws.onopen = async () => {
        ws.send(JSON.stringify({ type: 'auth', data: {
            token: sess.token, username: sess.username, userId: sess.meshId,
        }}));

        // (Re)subscribe: everything the instance lists plus explicit requests.
        try {
            const data = await api(sess.domain, 'GET', '/api/v1/servers', sess.token);
            (data.servers || []).forEach((s) => realtime.desired.add(s.id));
        } catch { /* list failed — still subscribe to known ids */ }
        realtime.desired.forEach((id) => {
            if (ws.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({ type: 'subscribe', data: { serverId: id } }));
        });

        emitLocal('realtime:status', 'connected');
        realtime.backoff = 1000;
    };

    ws.onmessage = (ev) => {
        let frame = null;
        try { frame = JSON.parse(ev.data); } catch { return; }
        if (frame.type === 'auth.fail') {
            emitLocal('realtime:status', 'auth-failed');
            realtime.running = false;
            try { ws.close(); } catch { /* already closed */ }
            return;
        }
        emitLocal('realtime:event', ev.data);
    };

    ws.onclose = () => {
        if (realtime.ws === ws) realtime.ws = null;
        if (!realtime.running) return;
        emitLocal('realtime:status', 'disconnected');
        realtimeScheduleRetry();
    };

    ws.onerror = () => { /* onclose follows */ };
}

function realtimeScheduleRetry() {
    if (!realtime.running) return;
    clearTimeout(realtime.timer);
    realtime.timer = setTimeout(realtimeConnect, realtime.backoff);
    realtime.backoff = Math.min(realtime.backoff * 2, 30000);
}

// ── TOTP (RFC 6238, SHA1, 6 digits, 30 s — mirrors totp.go) ──────────────────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) out += B32_ALPHABET[(value >>> (bits - 5)) & 31], bits -= 5;
    }
    if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(str) {
    const s = String(str).toUpperCase().trim().replace(/=+$/, '');
    let bits = 0, value = 0;
    const out = [];
    for (const c of s) {
        const idx = B32_ALPHABET.indexOf(c);
        if (idx === -1) throw new Error('invalid base32 secret');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) out.push((value >>> (bits - 8)) & 0xff), bits -= 8;
    }
    return new Uint8Array(out);
}

async function hmacSha1(keyBytes, msgBytes) {
    const key = await crypto.subtle.importKey(
        'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

async function totpCode(rawSecret, timeStep) {
    const msg = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) { msg[i] = timeStep & 0xff; timeStep = Math.floor(timeStep / 256); }
    const sum = await hmacSha1(rawSecret, msg);
    const offset = sum[19] & 0x0f;
    const code = ((sum[offset] & 0x7f) << 24) | ((sum[offset + 1] & 0xff) << 16) |
                 ((sum[offset + 2] & 0xff) << 8) | (sum[offset + 3] & 0xff);
    return code % 1000000;
}

async function qrSvgDataURI(text) {
    const { default: qrcode } = await import('./qrcode-vendor.js');
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const svg = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

function otpauthURI(account, secret, issuer) {
    const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
    return `otpauth://totp/${enc(issuer)}:${enc(account)}?secret=${secret}` +
           `&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ── The App surface ──────────────────────────────────────────────────────────

const appBridge = {

    // ── Persistence ──
    async LoadData() { return localStorage.getItem(LS_STATE) || '{}'; },
    async SaveData(data) { localStorage.setItem(LS_STATE, String(data)); },

    // ── Activity (no process visibility off-desktop) ──
    async DetectActivity() { return { type: '', name: '' }; },

    // ── Session ──
    async GetSession() {
        const s = loadSession();
        return { domain: '', token: '', userId: '', username: '', role: '', meshId: '', ...s };
    },
    async Logout() {
        localStorage.removeItem(LS_SESSION);
        if (realtime.ws) { realtime.running = false; try { realtime.ws.close(); } catch {} realtime.ws = null; }
        clearTimeout(realtime.timer);
    },

    async Connect(domain, username, password) {
        const d = normalizeDomain(domain);
        let res = await apiPostMaybe(d, '/api/v1/auth/bootstrap', { username, password });
        if (res.status === 409)
            res = await apiPostMaybe(d, '/api/v1/auth/login', { username, password });
        if (res.status < 200 || res.status >= 300)
            throw new Error(res.data.error || 'Sign-in failed');
        return sessionFromAuth(d, res.data, username);
    },

    async Register(domain, username, password) {
        const d = normalizeDomain(domain);
        let res = await apiPostMaybe(d, '/api/v1/auth/register', { username, password });
        if (res.status === 409)
            res = await apiPostMaybe(d, '/api/v1/auth/login', { username, password });
        if (res.status < 200 || res.status >= 300)
            throw new Error(res.data.error || 'Registration failed');
        return sessionFromAuth(d, res.data, username);
    },

    // ── Discovery ──
    async Discover(query, category) {
        const s = requireSession();
        const q = new URLSearchParams();
        if (query) q.set('q', query);
        if (category && category !== 'All') q.set('category', category);
        const path = '/api/v1/discovery' + (q.toString() ? `?${q}` : '');
        const data = await api(s.domain, 'GET', path, s.token);
        return data.servers || [];
    },
    async JoinDiscoveredServer(id) {
        const s = requireSession();
        await api(s.domain, 'POST', `/api/v1/discovery/${encodeURIComponent(id)}/join`, s.token);
    },

    // ── Servers / channels / messages ──
    async ListServers() {
        const s = requireSession();
        return (await api(s.domain, 'GET', '/api/v1/servers', s.token)).servers || [];
    },
    async ListChannels(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/servers/${encodeURIComponent(serverID)}/channels`, s.token)).channels || [];
    },
    async FetchMessages(channelID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages?limit=100`, s.token)).messages || [];
    },
    async ReplyChatMessage(channelID, replyToID, content, authorName, authorColor) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages`, s.token,
            { content, authorName, authorColor, replyToId: replyToID })).message;
    },
    async ToggleReaction(channelID, msgID, emoji) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(msgID)}/reactions`,
            s.token, { emoji });
    },
    async EditChatMessage(channelID, msgID, content) {
        const s = requireSession();
        await api(s.domain, 'PATCH',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(msgID)}`,
            s.token, { content });
    },
    async DeleteChatMessage(channelID, msgID) {
        const s = requireSession();
        await api(s.domain, 'DELETE',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(msgID)}`,
            s.token);
    },
    async SendChatMessage(channelID, content, authorName, authorColor) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages`, s.token,
            { content, authorName: authorName || s.username, authorColor })).message;
    },
    async CreateServer(name, description, category, template, isPublic) {
        const s = requireSession();
        const server = (await api(s.domain, 'POST', '/api/v1/servers', s.token,
            { name, description, category, template, isPublic })).server;
        realtime.desired.add(server.id);
        if (realtime.ws?.readyState === WebSocket.OPEN)
            realtime.ws.send(JSON.stringify({ type: 'subscribe', data: { serverId: server.id } }));
        return server;
    },
    async CreateChannel(serverID, name) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/channels`, s.token,
            { name, type: 'text' })).channel;
    },
    async UpdateServer(serverID, name, description) {
        const s = requireSession();
        return (await api(s.domain, 'PATCH',
            `/api/v1/servers/${encodeURIComponent(serverID)}`, s.token,
            { name, description })).server;
    },
    async DeleteServer(serverID) {
        const s = requireSession();
        await api(s.domain, 'DELETE', `/api/v1/servers/${encodeURIComponent(serverID)}`, s.token);
        realtime.desired.delete(serverID);
    },
    async LeaveServer(serverID) {
        const s = requireSession();
        if (!s.userId)
            throw new Error('This session predates member tracking — sign in again to leave servers');
        await api(s.domain, 'DELETE',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members/${encodeURIComponent(s.userId)}`, s.token);
        realtime.desired.delete(serverID);
    },
    async PingServer() {
        const s = requireSession();
        const t0 = performance.now();
        await api(s.domain, 'GET', '/health', '');
        return Math.round(performance.now() - t0);
    },

    // ── Roles / members ──
    async ListRoles(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/servers/${encodeURIComponent(serverID)}/roles`, s.token)).roles || [];
    },
    async CreateRole(serverID, name, color) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/roles`, s.token,
            { name, color })).role;
    },
    async UpdateRole(serverID, roleID, name, color, permissions) {
        const s = requireSession();
        const body = { name, color };
        if (permissions != null) body.permissions = permissions;
        return (await api(s.domain, 'PATCH',
            `/api/v1/servers/${encodeURIComponent(serverID)}/roles/${encodeURIComponent(roleID)}`,
            s.token, body)).role;
    },
    async DeleteRole(serverID, roleID) {
        const s = requireSession();
        await api(s.domain, 'DELETE',
            `/api/v1/servers/${encodeURIComponent(serverID)}/roles/${encodeURIComponent(roleID)}`, s.token);
    },
    async ListMembers(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members`, s.token)).members || [];
    },

    // ── Node info / profile / bots ──
    async GetNodeInfo() {
        const s = requireSession();
        return api(s.domain, 'GET', '/api/v1/node', s.token);
    },
    async SetNodeDiscovery(enabled) {
        const s = requireSession();
        await api(s.domain, 'PATCH', '/api/v1/node', s.token, { discoveryEnabled: !!enabled });
    },
    async GetMyProfile() {
        const s = requireSession();
        return (await api(s.domain, 'GET', '/api/v1/auth/me', s.token)).profile;
    },
    async UpdateMyProfile(customStatus, avatarColor, pronouns, decoration, about) {
        const s = requireSession();
        return (await api(s.domain, 'PATCH', '/api/v1/auth/me', s.token,
            { customStatus, avatarColor, pronouns, decoration, about })).user;
    },
    async SetMyStatus(status) {
        const s = requireSession();
        await api(s.domain, 'PATCH', '/api/v1/users/@me/status', s.token, { status });
    },
    async UploadAvatar(dataUrl) {
        const s = requireSession();
        if (!dataUrl) {
            await api(s.domain, 'DELETE', '/api/v1/users/@me/avatar', s.token);
            return '';
        }
        return (await api(s.domain, 'POST', '/api/v1/users/@me/avatar', s.token,
            { avatar: dataUrl })).avatarUrl;
    },
    // Updates ship through the desktop installer — web/Android builds never
    // offer one, so these resolve to "no update" / no-op.
    async CheckForUpdate() { return { updateAvailable: false, currentVersion: 'web' }; },
    async DownloadUpdate() { return ''; },
    async SetServerPublic(serverID, isPublic) {
        const s = requireSession();
        await api(s.domain, 'PATCH',
            `/api/v1/servers/${encodeURIComponent(serverID)}`, s.token, { isPublic: !!isPublic });
    },
    // ── Support tickets / invites ──
    async GetSupport(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/servers/${encodeURIComponent(serverID)}/support`, s.token)).support;
    },
    async OpenTicket(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/support/tickets`, s.token)).channel;
    },
    async UpdateServerSupport(serverID, open, hours, timezone) {
        const s = requireSession();
        return (await api(s.domain, 'PATCH',
            `/api/v1/servers/${encodeURIComponent(serverID)}`, s.token,
            { support: { open, hours, timezone } })).server;
    },
    async ListInvites(serverID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/servers/${encodeURIComponent(serverID)}/invites`, s.token)).invites || [];
    },
    async CreateCustomInvite(serverID, slug) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/invites`, s.token,
            { customSlug: slug, expiresInHours: 0, maxUses: 0 })).invite;
    },

    // ── Member moderation + context-menu actions ──
    async OpenDm(username) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/users/${encodeURIComponent(username)}/dm`, s.token)).dm;
    },
    async TimeoutMember(serverID, userID, durationMs) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members/${encodeURIComponent(userID)}/mute`,
            s.token, { durationMs });
    },
    async KickMember(serverID, userID) {
        const s = requireSession();
        await api(s.domain, 'DELETE',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members/${encodeURIComponent(userID)}`,
            s.token);
    },
    async BanMember(serverID, userID, reason) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members/${encodeURIComponent(userID)}/ban`,
            s.token, { reason });
    },
    async SetMemberRoles(serverID, userID, roleIds) {
        const s = requireSession();
        await api(s.domain, 'PATCH',
            `/api/v1/servers/${encodeURIComponent(serverID)}/members/${encodeURIComponent(userID)}/roles`,
            s.token, { roleIds });
    },
    async AddAdminNote(username, serverID, note) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/users/${encodeURIComponent(username)}/admin-notes`, s.token,
            { note, serverId: serverID });
    },
    async ReportMessage(serverID, channelID, messageID, reason) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/servers/${encodeURIComponent(serverID)}/reports`, s.token,
            { channelId: channelID, messageId: messageID, reason });
    },

    async ListBots() {
        const s = requireSession();
        return (await api(s.domain, 'GET', '/api/v1/bots', s.token)).bots || [];
    },
    async AddBotToServer(botID, serverID) {
        const s = requireSession();
        await api(s.domain, 'POST',
            `/api/v1/bots/${encodeURIComponent(botID)}/servers/${encodeURIComponent(serverID)}`,
            s.token);
    },

    // ── Pins / threads / DMs / search ──
    async ListPins(channelID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/channels/${encodeURIComponent(channelID)}/pins`, s.token)).pins || [];
    },
    async PinMessage(channelID, msgID) {
        const s = requireSession();
        await api(s.domain, 'PUT',
            `/api/v1/channels/${encodeURIComponent(channelID)}/pins/${encodeURIComponent(msgID)}`,
            s.token);
    },
    async UnpinMessage(channelID, msgID) {
        const s = requireSession();
        await api(s.domain, 'DELETE',
            `/api/v1/channels/${encodeURIComponent(channelID)}/pins/${encodeURIComponent(msgID)}`,
            s.token);
    },
    async ListThreads(channelID) {
        const s = requireSession();
        return (await api(s.domain, 'GET',
            `/api/v1/channels/${encodeURIComponent(channelID)}/threads`, s.token)).threads || [];
    },
    async CreateThread(channelID, msgID, name) {
        const s = requireSession();
        return (await api(s.domain, 'POST',
            `/api/v1/channels/${encodeURIComponent(channelID)}/messages/${encodeURIComponent(msgID)}/thread`,
            s.token, { name })).thread;
    },
    async ListDMs() {
        const s = requireSession();
        return (await api(s.domain, 'GET', '/api/v1/users/@me/dms', s.token)).dms || [];
    },
    async SearchChannel(channelID, query) {
        const s = requireSession();
        if ((query || '').length < 2) throw new Error('Search needs at least 2 characters');
        return (await api(s.domain, 'GET',
            `/api/v1/search?q=${encodeURIComponent(query)}&channelId=${encodeURIComponent(channelID)}`,
            s.token)).results || [];
    },

    // ── Realtime ──
    async StartRealtime() {
        requireSession();
        if (realtime.running) return;
        realtime.running = true;
        realtime.backoff = 1000;
        realtimeConnect();
    },
    async StopRealtime() {
        realtime.running = false;
        clearTimeout(realtime.timer);
        if (realtime.ws) { try { realtime.ws.close(); } catch {} realtime.ws = null; }
    },
    async SubscribeServer(serverID) {
        if (!serverID) return;
        realtime.desired.add(serverID);
        if (realtime.ws?.readyState === WebSocket.OPEN)
            realtime.ws.send(JSON.stringify({ type: 'subscribe', data: { serverId: serverID } }));
    },
    async SendRealtime(payload) {
        if (!realtime.ws || realtime.ws.readyState !== WebSocket.OPEN)
            throw new Error('realtime connection is not open');
        realtime.ws.send(String(payload));
    },

    // ── 2FA ──
    async GenerateTOTP(account) {
        const raw = crypto.getRandomValues(new Uint8Array(20));
        const secret = base32Encode(raw);
        const uri = otpauthURI(account || 'user', secret, 'MeshCord');
        const qr = await qrSvgDataURI(uri);
        return { secret, uri, qr };
    },
    async VerifyTOTP(base32Secret, code) {
        let raw;
        try { raw = base32Decode(base32Secret); } catch { return false; }
        const icode = parseInt(String(code).trim(), 10);
        if (Number.isNaN(icode)) return false;
        const step = Math.floor(Date.now() / 1000 / 30);
        for (let d = -1; d <= 1; d++) {
            if (await totpCode(raw, step + d) === icode) return true;
        }
        return false;
    },
};

// ── window.runtime surface used by the UI ────────────────────────────────────

const runtimeBridge = {
    EventsOn:           eventsOn,
    EventsOnce:         eventsOnce,
    EventsOff:          eventsOff,
    EventsOffAll:       () => eventHandlers.clear(),
    EventsEmit:         (name, ...args) => emitLocal(name, ...args),
    EventsOnMultiple:   (name, cb, max) => eventsOn(name, cb),
    LogPrint:           (...a) => console.log(...a),
    LogTrace:           (...a) => console.trace(...a),
    LogDebug:           (...a) => console.debug(...a),
    LogInfo:            (...a) => console.info(...a),
    LogWarning:         (...a) => console.warn(...a),
    LogError:           (...a) => console.error(...a),
    LogFatal:           (...a) => console.error(...a),
    Quit:               () => {
        if (window.MeshCordAndroid?.quit) return window.MeshCordAndroid.quit();
        window.close();
    },
    WindowIsMaximised:  async () => false,
    WindowMinimise:     () => {},
    WindowToggleMaximise: () => {},
    BrowserOpenURL:     (url) => window.open(url, '_blank'),
};

// ─────────────────────────────────────────────────────────────────────────────

function installBridge() {
    window.go = window.go || {};
    window.go.main = window.go.main || {};
    window.go.main.App = appBridge;
    window.runtime = Object.assign(window.runtime || {}, runtimeBridge);
    console.log('[bridge] non-Wails environment — JS bridge installed');
}

if (!IS_WAILS) {
    document.documentElement.classList.add('platform-web');
    if (IS_ANDROID) document.documentElement.classList.add('platform-android');
    installBridge();
}
