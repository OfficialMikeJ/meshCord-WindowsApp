import './bridge.js';   // must be first — installs window.go / window.runtime off-Wails
import './style.css';
import {
    LoadData,
    SaveData,
    DetectActivity,
    GenerateTOTP,
    VerifyTOTP,
    GetSession,
    Connect,
    Register,
    Logout,
    Discover,
    JoinDiscoveredServer,
    ListServers,
    ListChannels,
    FetchMessages,
    SendChatMessage,
    ReplyChatMessage,
    ToggleReaction,
    EditChatMessage,
    DeleteChatMessage,
    CreateServer,
    CreateChannel,
    UpdateServer,
    SetServerPublic,
    DeleteServer,
    LeaveServer,
    ListRoles,
    CreateRole,
    UpdateRole,
    DeleteRole,
    ListMembers,
    GetNodeInfo,
    SetNodeDiscovery,
    GetMyProfile,
    SetMyStatus,
    UpdateMyProfile,
    UploadAvatar,
    CheckForUpdate,
    DownloadUpdate,
    ListBots,
    AddBotToServer,
    GetSupport,
    OpenTicket,
    UpdateServerSupport,
    ListInvites,
    CreateCustomInvite,
    OpenDm,
    TimeoutMember,
    KickMember,
    BanMember,
    SetMemberRoles,
    AddAdminNote,
    ReportMessage,
    ListPins,
    PinMessage,
    UnpinMessage,
    ListThreads,
    CreateThread,
    ListDMs,
    SearchChannel,
    PingServer,
    StartRealtime,
    SubscribeServer,
    SendRealtime,
} from '../wailsjs/go/main/App';
import {
    EventsOn,
    Quit,
    WindowIsMaximised,
    WindowMinimise,
    WindowToggleMaximise,
} from '../wailsjs/runtime/runtime';
import { icon, winIcon } from './icons';
import * as Voice from './voice';

const $ = (id) => document.getElementById(id);

// ── DOM ──────────────────────────────────────────────────────────────────────
const serverListContainer  = $('server-list');
const serverDropdown       = $('server-dropdown');
const serverHeaderBtn      = $('current-server-name');
const channelListContainer = $('channel-list');
const messageList          = $('message-list');
const memberListEl         = $('member-list');
const chatInput            = $('chat-input');
const currentChannelName   = $('current-channel-name');
const channelTopic         = $('channel-topic');
const topicSep             = $('topic-sep');
const pingDisplay          = $('ping-display');
const composerHint         = $('composer-hint');
const tooltipEl            = $('tooltip');
const settingsModal        = $('settings-modal');
const userSettingsModal    = $('user-settings-modal');
const discoveryModal       = $('discovery-modal');
const onboardingModal      = $('onboarding-modal');
const voicePanel           = $('voice-panel');

// ── State ────────────────────────────────────────────────────────────────────
let myProfile = {
    username: 'MeshCord',
    status: 'online',
    customStatus: '',
    avatarColor: '#5865f2',
    meshId: '',
    about: '',
    privacy: { dms: true, status: true, filter: true },
    muted:   { channels: [], servers: [] },
};

let nodeInfo = null;   // /api/v1/node — domain, version, discoveryEnabled, me.role

let session = { domain: '', token: '', username: '', role: '' };

let servers          = [];
let channels         = [];
let members          = [];
let roles            = [];
let currentServerId  = null;
let currentChannelId = null;
let selectedRoleId   = null;
let realtimeStatus   = 'connecting';
// Member list starts hidden on narrow screens — it is an overlay there.
let memberListVisible = !window.matchMedia('(max-width: 900px)').matches;

// Who is sitting in each voice channel: channelId → [VoiceUser]
const voiceOccupants = new Map();
// Collapsed channel categories, by label.
const collapsedCategories = new Set();

// Rendered message ids, so the realtime echo of a message we just POSTed does
// not render twice. Cleared on every channel switch.
const renderedMessageIds = new Set();
// Author/time of the last rendered message, for Discord-style grouping.
let lastRendered = null;

const GROUP_WINDOW_MS = 7 * 60 * 1000;

const PERMISSIONS = [
    { key: 'canReadMessages',  label: 'View Channels',   desc: 'Allows members to view channels in this server.' },
    { key: 'canSendMessages',  label: 'Send Messages',   desc: 'Allows members to send messages in text channels.' },
    { key: 'canManageChannels',label: 'Manage Channels', desc: 'Allows members to create, edit and delete channels.' },
    { key: 'canManageRoles',   label: 'Manage Roles',    desc: 'Allows members to create and edit roles below their own.' },
    { key: 'canKickMembers',   label: 'Kick Members',    desc: 'Allows members to remove other members from this server.' },
    { key: 'canBanMembers',    label: 'Ban Members',     desc: 'Allows members to permanently ban other members.' },
    { key: 'administrator',    label: 'Administrator',   desc: 'Grants every permission. This is a dangerous permission.' },
];

const CATEGORIES = ['Gaming', 'Game Server Hosting', 'Community', 'Technology',
                    'Education', 'Art & Design', 'Music', 'Friends', 'Other'];

// ── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str == null ? '' : String(str);
    return div.innerHTML;
}

function initialsOf(name) {
    return String(name || '?')
        .split(' ').filter(Boolean).map((n) => n[0]).join('')
        .substring(0, 2).toUpperCase() || '?';
}

function formatTime(ts) {
    const d = new Date(ts || Date.now());
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `Today at ${time}`;
    const yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: 'numeric' }) + ` ${time}`;
}

function shortTime(ts) {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// "/avatars/…" paths are node-relative — make them absolute against the
// connected node so WebView/img tags resolve them.
function avatarUrlFull(url) {
    if (!url) return '';
    if (/^https?:/.test(url) || url.startsWith('data:')) return url;
    return (session && session.domain ? session.domain : '') + url;
}

// opts: { avatarUrl, decoration } — avatarUrl renders an <img> instead of
// initials; decoration adds the glowing avatar ring (like Discord's).
function avatarEl(name, color, size = 32, status, opts = {}) {
    const el = document.createElement('div');
    el.className = `avatar avatar-${size}`;
    el.style.backgroundColor = color || '#5865f2';
    if (opts.decoration && opts.decoration !== 'none') {
        el.classList.add(`deco-${opts.decoration}`);
    }
    if (opts.avatarUrl) {
        el.classList.add('has-img');
        const img = document.createElement('img');
        img.className = 'avatar-img';
        img.src = avatarUrlFull(opts.avatarUrl);
        img.alt = '';
        el.appendChild(img);
    } else {
        const span = document.createElement('span');
        span.className = 'avatar-initials';
        span.innerText = initialsOf(name);
        el.appendChild(span);
    }
    if (status) {
        const dot = document.createElement('i');
        dot.className = `status-dot ${status}`;
        el.appendChild(dot);
    }
    return el;
}

// Fills every <span data-icon="..."> in the document with its SVG.
function paintIcons(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
        if (el.dataset.painted) return;
        el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 20);
        el.dataset.painted = '1';
    });
}

function hint(text, isError = false) {
    if (!composerHint) return;
    composerHint.innerText = text || '';
    composerHint.style.color = isError ? 'var(--red)' : 'var(--text-muted)';
    if (text) {
        clearTimeout(hint._t);
        hint._t = setTimeout(() => { composerHint.innerText = ''; }, 4000);
    }
}

// ── Tooltips ─────────────────────────────────────────────────────────────────
function showTooltip(target) {
    const text = target.dataset.tooltip;
    if (!text || !tooltipEl) return;
    tooltipEl.innerText = text;
    tooltipEl.hidden = false;

    const r = target.getBoundingClientRect();
    const t = tooltipEl.getBoundingClientRect();
    const inRail = !!target.closest('.server-rail');

    if (inRail) {
        tooltipEl.style.left = `${r.right + 12}px`;
        tooltipEl.style.top  = `${r.top + r.height / 2 - t.height / 2}px`;
    } else {
        tooltipEl.style.left = `${Math.max(8, r.left + r.width / 2 - t.width / 2)}px`;
        tooltipEl.style.top  = `${r.top - t.height - 8}px`;
    }
}

function hideTooltip() { if (tooltipEl) tooltipEl.hidden = true; }

document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (target) showTooltip(target); else hideTooltip();
});
document.addEventListener('mouseout', (e) => {
    if (e.target.closest('[data-tooltip]')) hideTooltip();
});

// ── Prompt / confirm / notice modal ──────────────────────────────────────────
function openDialog({ title, label, value = '', okLabel = 'Done', input = true, danger = false }) {
    return new Promise((resolve) => {
        const modal   = $('prompt-modal');
        const titleEl = $('prompt-title');
        const labelEl = $('prompt-label');
        const inputEl = $('prompt-input');
        const okBtn   = $('prompt-ok');
        const cancel  = $('prompt-cancel');

        titleEl.innerText = title;
        labelEl.innerText = label || '';
        labelEl.parentElement.hidden = !input;
        inputEl.value = value;
        okBtn.innerText = okLabel;
        okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
        cancel.hidden = false;
        modal.hidden = false;
        if (input) { inputEl.focus(); inputEl.select(); }

        const done = (result) => {
            modal.hidden = true;
            okBtn.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            inputEl.removeEventListener('keydown', onKey);
            resolve(result);
        };
        const onOk     = () => done(input ? inputEl.value.trim() : true);
        const onCancel = () => done(null);
        const onKey    = (e) => {
            if (e.key === 'Enter')  { e.preventDefault(); onOk(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        };

        okBtn.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        inputEl.addEventListener('keydown', onKey);
    });
}

const askText    = (title, label, value) => openDialog({ title, label, value, okLabel: 'Create' });
const askConfirm = (title, okLabel = 'Confirm') =>
    openDialog({ title, input: false, okLabel, danger: true });

async function notify(title) {
    $('prompt-cancel').hidden = true;
    await openDialog({ title, input: false, okLabel: 'Okay' });
    $('prompt-cancel').hidden = false;
}

// ── Persistence (profile only; servers live on the instance) ────────────────
async function persist() {
    try {
        await SaveData(JSON.stringify({ profile: myProfile }));
    } catch (err) {
        console.error('Error saving state:', err);
    }
}

async function loadState() {
    try {
        const data = JSON.parse((await LoadData()) || '{}');
        if (data.profile) myProfile = { ...myProfile, ...data.profile };
    } catch (err) {
        console.error('Error loading state:', err);
    }
    applyProfileToUI();
}

function applyProfileToUI() {
    document.querySelectorAll('.username').forEach((el) => { el.innerText = myProfile.username; });

    [['self-avatar', 32], ['account-avatar', 80]].forEach(([id, size]) => {
        const host = $(id);
        if (!host) return;
        host.style.backgroundColor = myProfile.avatarColor;
        const initials = host.querySelector('.avatar-initials');
        if (initials) initials.innerText = initialsOf(myProfile.username);
        host.className = `avatar avatar-${size}`;
    });

    const meshEl = $('display-mesh-id');
    if (meshEl) meshEl.innerText = myProfile.meshId || 'not connected';

    const statusEl = $('edit-custom-status');
    if (statusEl) statusEl.value = myProfile.customStatus;

    const colorEl = $('edit-avatar-color');
    if (colorEl) colorEl.value = myProfile.avatarColor;
    const colorVal = $('edit-avatar-color-value');
    if (colorVal) colorVal.innerText = myProfile.avatarColor.toUpperCase();

    const activity = $('current-activity');
    if (activity && !activity.dataset.live) activity.innerText = myProfile.customStatus || 'Online';

    applySelfAvatar($('self-avatar'), 32);
    applySelfAvatar($('account-avatar'), 80);

    const statusKey = (myProfile.status || 'online').toLowerCase();
    ['#self-avatar .status-dot', '#account-avatar .status-dot'].forEach((sel) => {
        const dot = document.querySelector(sel);
        if (dot) dot.className = `status-dot ${statusKey}`;
    });
}

// Swaps initials for the uploaded picture + applies the glow decoration on
// the two self-avatar spots (user panel + My Account preview).
function applySelfAvatar(host, size) {
    if (!host) return;
    host.className = `avatar avatar-${size}` +
        (myProfile.avatarUrl ? ' has-img' : '') +
        (myProfile.decoration && myProfile.decoration !== 'none' ? ` deco-${myProfile.decoration}` : '');
    host.style.backgroundColor = myProfile.avatarColor;
    let img = host.querySelector('.avatar-img');
    if (myProfile.avatarUrl) {
        if (!img) {
            img = document.createElement('img');
            img.className = 'avatar-img';
            img.alt = '';
            host.prepend(img);
        }
        img.src = avatarUrlFull(myProfile.avatarUrl);
        const init = host.querySelector('.avatar-initials');
        if (init) init.remove();
    } else {
        if (img) img.remove();
        if (!host.querySelector('.avatar-initials')) {
            const s = document.createElement('span');
            s.className = 'avatar-initials';
            host.prepend(s);
        }
        host.querySelector('.avatar-initials').innerText = initialsOf(myProfile.username);
    }
}

// ── Servers ──────────────────────────────────────────────────────────────────
async function loadServers() {
    try {
        servers = (await ListServers()) || [];
    } catch (err) {
        console.error('Could not load servers:', err);
        servers = [];
    }
    renderServers();

    if (servers.length > 0 && !servers.some((s) => s.id === currentServerId)) {
        await selectServer(servers[0].id);
    }
}

function renderServers() {
    if (!serverListContainer) return;
    serverListContainer.innerHTML = '';

    servers.forEach((server) => {
        const wrap = document.createElement('div');
        wrap.className = 'rail-item-wrap' + (server.id === currentServerId ? ' active' : '');

        const pill = document.createElement('div');
        pill.className = 'rail-pill';

        const item = document.createElement('div');
        item.className = 'rail-item';
        item.innerText = initialsOf(server.name);
        item.dataset.tooltip = server.name;
        if (server.iconColor && server.id !== currentServerId) {
            item.style.backgroundColor = server.iconColor;
        }
        item.addEventListener('click', () => selectServer(server.id));

        wrap.appendChild(pill);
        wrap.appendChild(item);
        serverListContainer.appendChild(wrap);
    });

    const home = $('btn-home');
    if (home) home.parentElement.classList.toggle('active', currentServerId === null);
    syncServerHeader();
}

// The server dropdown only makes sense once a real server is selected —
// with none, the header shows a plain "Direct Messages" label.
function syncServerHeader() {
    if (!serverHeaderBtn) return;
    const chevron = serverHeaderBtn.querySelector('.server-header-chevron');
    const nameEl  = serverHeaderBtn.querySelector('.server-header-name');
    const server  = servers.find((s) => s.id === currentServerId);
    if (server) {
        nameEl.innerText = server.name;
        chevron.hidden = false;
        serverHeaderBtn.classList.remove('disabled');
    } else {
        nameEl.innerText = 'Direct Messages';
        chevron.hidden = true;
        serverHeaderBtn.classList.add('disabled');
        if (serverDropdown) serverDropdown.hidden = true;
    }
}

// ── Mobile drawer (channel sidebar) ─────────────────────────────────────────
const channelSidebarEl = document.querySelector('.channel-sidebar');
const drawerScrimEl    = $('drawer-scrim');

function openDrawer() {
    if (!channelSidebarEl || !drawerScrimEl) return;
    channelSidebarEl.classList.add('open');
    drawerScrimEl.hidden = false;
    requestAnimationFrame(() => drawerScrimEl.classList.add('visible'));
}
function closeDrawer() {
    if (!channelSidebarEl || !drawerScrimEl) return;
    channelSidebarEl.classList.remove('open');
    drawerScrimEl.classList.remove('visible');
    setTimeout(() => { if (!channelSidebarEl.classList.contains('open')) drawerScrimEl.hidden = true; }, 200);
}

async function selectServer(serverId) {
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    closeDrawer();

    currentServerId = serverId;
    renderServers();

    const nameEl = serverHeaderBtn && serverHeaderBtn.querySelector('.server-header-name');
    if (nameEl) nameEl.innerText = server.name;
    syncServerHeader();

    try {
        await SubscribeServer(serverId);
    } catch (err) {
        console.error('Subscribe failed:', err);
    }

    await Promise.all([loadChannels(serverId), loadMembers(serverId), loadRoles(serverId)]);
    requestVoiceState(serverId);
}

// ── Channels ─────────────────────────────────────────────────────────────────
async function loadChannels(serverId) {
    try {
        channels = (await ListChannels(serverId)) || [];
    } catch (err) {
        console.error('Could not load channels:', err);
        channels = [];
    }
    renderChannels();

    const firstText = channels.find((c) => c.type !== 'voice');
    if (firstText) {
        await selectChannel(firstText.id);
    } else {
        currentChannelId = null;
        clearMessages();
        setChannelHeader(null);
    }
}

function renderChannels() {
    if (!channelListContainer) return;
    channelListContainer.innerHTML = '';

    const section = (label, list, isVoice) => {
        if (list.length === 0) return;
        const collapsed = collapsedCategories.has(label);

        const head = document.createElement('div');
        head.className = 'channel-category' + (collapsed ? ' collapsed' : '');
        head.innerHTML = icon('chevron', 12) + `<span>${escapeHtml(label)}</span>`;
        head.addEventListener('click', () => {
            if (collapsed) collapsedCategories.delete(label);
            else collapsedCategories.add(label);
            renderChannels();
        });
        channelListContainer.appendChild(head);

        if (collapsed) return;

        list.forEach((ch) => {
            const item = document.createElement('div');
            item.className = 'channel-item' + (ch.id === currentChannelId ? ' active' : '');
            const glyph = isVoice ? 'speaker'
                : ch.type === 'ticket'  ? 'inbox'
                : ch.type === 'support' ? 'help'
                : 'hash';
            item.innerHTML =
                icon(glyph, 20) +
                `<span class="channel-name">${escapeHtml(ch.name)}</span>`;
            if ((myProfile.muted?.channels || []).includes(ch.id)
                    || (myProfile.muted?.servers || []).includes(currentServerId)) {
                item.innerHTML += `<span class="channel-muted">${icon('bellOff', 16)}</span>`;
            }
            item.title = ch.topic || ch.name;
            if (unreadChannels.has(ch.id)) item.classList.add('unread');

            const occupants = voiceOccupants.get(ch.id) || [];
            if (isVoice && occupants.length > 0) {
                const count = document.createElement('span');
                count.className = 'channel-count';
                count.innerText = String(occupants.length);
                item.appendChild(count);
            }

            item.addEventListener('click', () => {
                if (isVoice) joinVoice(ch);
                else selectChannel(ch.id);
            });
            channelListContainer.appendChild(item);

            if (isVoice && occupants.length > 0) {
                const box = document.createElement('div');
                box.className = 'voice-members';
                occupants.forEach((u) => {
                    const row = document.createElement('div');
                    row.className = 'voice-member';
                    row.appendChild(avatarEl(u.username, u.color, 20));
                    const nm = document.createElement('span');
                    nm.innerText = u.username;
                    row.appendChild(nm);
                    box.appendChild(row);
                });
                channelListContainer.appendChild(box);
            }
        });
    };

    section('Text Channels',    channels.filter((c) => c.type !== 'voice' && c.type !== 'ticket'), false);
    section('Voice Channels',   channels.filter((c) => c.type === 'voice'), true);
    // Ticket channels already arrive filtered by the node — owner sees their
    // own, staff see all.
    section('Support Tickets',  channels.filter((c) => c.type === 'ticket'), false);
}

function setChannelHeader(channel) {
    if (currentChannelName) currentChannelName.innerText = channel ? channel.name : 'no channel';
    if (channelTopic) {
        channelTopic.innerText = channel && channel.topic ? channel.topic : '';
        if (topicSep) topicSep.hidden = !(channel && channel.topic);
    }
    if (chatInput) {
        chatInput.placeholder = channel ? `Message #${channel.name}` : 'No channel selected';
        chatInput.disabled = !channel;
    }
    syncChatEmpty(channel);
}

// When nothing is open — no channel, home view, fresh node — show the empty
// splash instead of a dead DM pane. Admins on an empty node also get a
// straight path into the server-setup wizard.
function syncChatEmpty(channel) {
    const empty = $('chat-empty');
    if (!empty) return;
    const show = !channel;
    empty.hidden = !show;
    $('message-list').style.display = show ? 'none' : '';
    document.querySelector('.composer-wrap').style.display = show ? 'none' : '';
    if (show) {
        hideSupportBarrier();
        const isAdmin = session && (session.role === 'admin' || session.role === 'owner');
        $('chat-empty-setup').hidden = !(isAdmin && servers.length === 0);
    }
}

async function selectChannel(channelId) {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) return;
    closeDrawer();

    currentChannelId = channelId;
    unreadChannels.delete(channelId);
    renderChannels();
    setChannelHeader(channel);
    navPush(channelId);
    if (channel.type === 'support') {
        await showSupportBarrier(channel);
    } else {
        hideSupportBarrier();
        await loadMessages(channel);
    }
}

// ── Support barrier ──────────────────────────────────────────────────────────
// A 'support' channel is not a chat channel — it is the ticket barrier. Users
// see the automated message + the Open Ticket button; the composer stays
// hidden because the node refuses posts to barrier channels anyway.
async function showSupportBarrier(channel) {
    clearMessages();
    const barrier  = $('support-barrier');
    const list     = $('message-list');
    const composer = document.querySelector('.composer-wrap');
    const empty    = $('chat-empty');
    if (empty)    empty.hidden = true;
    if (list)     list.style.display = 'none';
    if (composer) composer.style.display = 'none';
    barrier.hidden = false;

    const hours = $('support-barrier-hours');
    try {
        const s = await GetSupport(channel.serverId);
        if (s && !s.open) {
            hours.hidden = false;
            hours.innerText = `Currently closed — ${s.hours} ${s.timezone}`;
        } else {
            hours.hidden = true;
        }
    } catch { hours.hidden = true; }
}

function hideSupportBarrier() {
    const barrier  = $('support-barrier');
    const list     = $('message-list');
    const composer = document.querySelector('.composer-wrap');
    if (barrier)  barrier.hidden = true;
    if (list)     list.style.display = '';
    if (composer) composer.style.display = '';
}

$('btn-open-ticket').addEventListener('click', async () => {
    const btn = $('btn-open-ticket');
    btn.disabled = true;
    try {
        const ch = await OpenTicket(currentServerId);
        await loadChannels(currentServerId);
        await selectChannel(ch.id);
    } catch (err) {
        await notify(errText(err));
    } finally {
        btn.disabled = false;
    }
});

async function createMeshChannel() {
    if (!currentServerId) { await notify('Select a server first.'); return; }
    const name = await askText('Create Channel', 'Channel Name');
    if (!name) return;
    try {
        await CreateChannel(currentServerId, name);
        await loadChannels(currentServerId);
    } catch (err) {
        await notify(`Could not create channel: ${errText(err)}`);
    }
}

async function createMeshServer() {
    const name = await askText('Create a Server', 'Server Name');
    if (!name) return;
    try {
        const server = await CreateServer(name, '', 'Community', 'community', false);
        await loadServers();
        await selectServer(server.id);
    } catch (err) {
        await notify(`Could not create server: ${errText(err)}`);
    }
}

const errText = (err) => (err && err.message) ? err.message : String(err);

// ── Messages ─────────────────────────────────────────────────────────────────
function clearMessages() {
    if (messageList) messageList.innerHTML = '';
    renderedMessageIds.clear();
    msgIndex.clear();
    lastRendered = null;
}

function renderChannelIntro(channel) {
    if (!messageList || !channel) return;
    const intro = document.createElement('div');
    intro.className = 'channel-intro';
    intro.innerHTML =
        `<div class="channel-intro-icon">${icon('hash', 40)}</div>` +
        `<h3>Welcome to #${escapeHtml(channel.name)}!</h3>` +
        `<p>This is the start of the #${escapeHtml(channel.name)} channel.</p>`;
    messageList.appendChild(intro);
}

// Index of rendered messages — needed for reply headers + context-menu edits.
const msgIndex = new Map();

// Users can locally block/ignore accounts — their messages collapse behind a
// click-to-reveal row instead of rendering normally.
function isBlockedAuthor(name) {
    return (myProfile.blocked || []).includes(name);
}
function isIgnoredAuthor(name) {
    return (myProfile.ignored || []).includes(name);
}

// Render message content with @mentions highlighted. Mentioning yourself
// gets the strong "pinged" style.
function renderMentionedContent(text) {
    const me = (session?.username || myProfile.username || '').toLowerCase();
    let html = escapeHtml(text || '');
    const names = ['everyone', 'here', me, ...members.map((m) => (m.username || '').toLowerCase())]
        .filter((n, i, a) => n && a.indexOf(n) === i)
        .sort((a, b) => b.length - a.length);
    for (const n of names) {
        const re = new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\b|[^a-z0-9_.-]|$)`, 'gi');
        const cls = n === me ? 'mention mention-self' : 'mention';
        html = html.replace(re, `<span class="${cls}">@${escapeHtml(n)}</span>`);
    }
    return html;
}

function appendMessage(msg) {
    if (!messageList || !msg) return;
    if (msg.id && renderedMessageIds.has(msg.id)) return;
    if (msg.id) { renderedMessageIds.add(msg.id); msgIndex.set(msg.id, msg); }

    // Blocked / ignored users collapse into a reveal row.
    if (isBlockedAuthor(msg.authorName) || isIgnoredAuthor(msg.authorName)) {
        const hiddenRow = document.createElement('div');
        hiddenRow.className = 'message hidden-msg';
        const label = isBlockedAuthor(msg.authorName) ? 'Blocked' : 'Ignored';
        hiddenRow.innerHTML =
            `<span class="hidden-msg-label">${label} user — ` +
            `<button class="hidden-msg-show">click to show message</button></span>`;
        hiddenRow.querySelector('.hidden-msg-show').addEventListener('click', () => {
            hiddenRow.remove();
            renderedMessageIds.delete(msg.id);
            appendMessage({ ...msg, _reveal: true });
        });
        messageList.appendChild(hiddenRow);
        return;
    }

    const color = msg.authorColor || '#5865f2';
    const ts    = msg.timestamp || Date.now();

    // Discord groups consecutive messages from one author inside a short window.
    const grouped = lastRendered
        && lastRendered.author === msg.authorName
        && ts - lastRendered.ts < GROUP_WINDOW_MS;

    const row = document.createElement('div');
    row.className = 'message' + (grouped ? ' grouped' : '');
    row.dataset.content = (msg.content || '').toLowerCase();
    row.dataset.msgId   = msg.id || '';

    if (grouped) {
        const gutter = document.createElement('span');
        gutter.className = 'message-gutter-time';
        gutter.innerText = shortTime(ts);
        row.appendChild(gutter);
    } else {
        const senderM = members.find((m) => m.username === msg.authorName);
        const av = avatarEl(msg.authorName, color, 40, undefined,
            { avatarUrl: senderM?.avatarUrl, decoration: senderM?.decoration });
        av.classList.add('message-avatar');
        row.appendChild(av);

        const heading = document.createElement('div');
        heading.className = 'message-heading';

        const author = document.createElement('span');
        author.className = 'message-author';
        author.style.color = color;
        author.innerText = msg.authorName || 'Anonymous';
        author.dataset.author = msg.authorName || '';

        const time = document.createElement('span');
        time.className = 'message-timestamp';
        time.innerText = formatTime(ts);

        heading.appendChild(author);

        const sender = senderM;
        if (sender && (sender.role === 'admin' || sender.owner)) {
            const badge = document.createElement('span');
            badge.className = 'admin-crown';
            badge.innerHTML = icon('crown', 14) + '<em>ADMIN</em>';
            badge.title = 'Node Administrator';
            heading.appendChild(badge);
        } else if (sender && sender.isBot) {
            const badge = document.createElement('span');
            badge.className = 'bot-tag';
            badge.innerText = 'BOT';
            heading.appendChild(badge);
        }
        heading.appendChild(time);
        row.appendChild(heading);
    }

    // "Replying to …" line above the content when this answers another message.
    const parent = msg.replyToId && msgIndex.get(msg.replyToId);
    if (parent) {
        const rep = document.createElement('div');
        rep.className = 'message-reply';
        rep.innerHTML =
            `<span class="reply-arrow">↩</span>` +
            `<span class="reply-author">@${escapeHtml(parent.authorName || '')}</span>` +
            `<span class="reply-snippet">${escapeHtml((parent.content || '').slice(0, 80))}</span>`;
        row.appendChild(rep);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = renderMentionedContent(msg.content || '');
    if (msg.edited) {
        const ed = document.createElement('span');
        ed.className = 'message-edited';
        ed.innerText = '(edited)';
        content.appendChild(ed);
    }
    row.appendChild(content);
    renderMessageReactions(row, msg);

    const atBottom =
        messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 140;
    messageList.appendChild(row);
    lastRendered = { author: msg.authorName, ts };
    if (atBottom) messageList.scrollTop = messageList.scrollHeight;
}

function renderMessageReactions(row, msg) {
    if (!row || !msg) return;
    let bar = row.querySelector('.message-reactions');
    const entries = Object.entries(msg.reactions || {}).filter(([, users]) => users && users.length > 0);
    if (entries.length === 0) {
        if (bar) bar.remove();
        return;
    }
    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'message-reactions';
        row.appendChild(bar);
    }
    bar.innerHTML = '';
    const meId = session?.userId || '';
    for (const [emoji, users] of entries) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'reaction-pill' + (meId && users.includes(meId) ? ' reacted' : '');
        pill.innerHTML = `<span>${escapeHtml(emoji)}</span><span class="reaction-count">${users.length}</span>`;
        pill.addEventListener('click', async () => {
            try { await reactTo(msg.id, emoji); } catch (err) { toast('Error', errText(err)); }
        });
        bar.appendChild(pill);
    }
}

async function loadMessages(channel) {
    if (!messageList) return;
    clearMessages();
    renderChannelIntro(channel);
    try {
        const msgs = (await FetchMessages(channel.id)) || [];
        msgs.forEach(appendMessage);
        messageList.scrollTop = messageList.scrollHeight;
    } catch (err) {
        const box = document.createElement('div');
        box.className = 'messages-error';
        box.innerText = errText(err);
        messageList.appendChild(box);
    }
}

let replyToMsg = null;

function startReply(msg) {
    replyToMsg = msg;
    const el = $('composer-hint');
    if (el) {
        el.innerHTML =
            `Replying to <strong>@${escapeHtml(msg.authorName || '')}</strong> ` +
            `<button class="hint-cancel" id="hint-cancel-reply">✕</button>`;
        $('hint-cancel-reply')?.addEventListener('click', cancelReply);
    }
    chatInput?.focus();
}
function cancelReply() {
    replyToMsg = null;
    const el = $('composer-hint');
    if (el) el.innerHTML = '';
}

async function sendMessage() {
    if (!chatInput || !currentChannelId) return;
    const text = chatInput.value.trim();
    if (text === '') return;

    const reply = replyToMsg;
    cancelReply();
    chatInput.value = '';
    try {
        const msg = reply
            ? await ReplyChatMessage(
                currentChannelId, reply.id, text,
                myProfile.username, myProfile.avatarColor)
            : await SendChatMessage(
                currentChannelId, text, myProfile.username, myProfile.avatarColor);
        appendMessage(msg);
    } catch (err) {
        chatInput.value = text; // put it back so nothing is lost
        hint(`Could not send: ${errText(err)}`, true);
    }
}

// ── Members ──────────────────────────────────────────────────────────────────
async function loadMembers(serverId) {
    try {
        members = (await ListMembers(serverId)) || [];
    } catch (err) {
        console.error('Could not load members:', err);
        members = [];
    }
    renderMembers();
}

// Discord shows no member list outside a server, and remembers the toggle.
function syncMemberList() {
    if (!memberListEl) return;
    memberListEl.hidden = !memberListVisible || !currentServerId;

    const btn = $('btn-toggle-members');
    if (!btn) return;
    btn.classList.toggle('active', memberListVisible);
    btn.dataset.tooltip = memberListVisible ? 'Hide Member List' : 'Show Member List';
}

function renderMembers() {
    if (!memberListEl) return;
    syncMemberList();
    memberListEl.innerHTML = '';

    const online  = members.filter((m) => m.status && m.status !== 'offline');
    const offline = members.filter((m) => !m.status || m.status === 'offline');

    const group = (label, list, isOffline) => {
        if (list.length === 0) return;
        const head = document.createElement('div');
        head.className = 'member-group';
        head.innerText = `${label} — ${list.length}`;
        memberListEl.appendChild(head);

        list.forEach((m) => {
            const row = document.createElement('div');
            row.className = 'member-row' + (isOffline ? ' offline' : '');
            row.dataset.userId = m.id || '';
            row.appendChild(avatarEl(m.username, m.avatarColor, 32, m.status || 'offline',
                { avatarUrl: m.avatarUrl, decoration: m.decoration }));
            const nm = document.createElement('span');
            nm.className = 'member-name';
            nm.innerText = m.username;
            row.appendChild(nm);
            if (m.role === 'admin' || m.owner) {
                const badge = document.createElement('span');
                badge.className = 'admin-crown';
                badge.innerHTML = icon('crown', 14) + '<em>ADMIN</em>';
                badge.title = 'Node Administrator';
                row.appendChild(badge);
            } else if (m.isBot) {
                const badge = document.createElement('span');
                badge.className = 'bot-tag';
                badge.innerText = 'BOT';
                row.appendChild(badge);
            }
            row.addEventListener('click', () => openMemberCard(m));
            memberListEl.appendChild(row);
        });
    };

    group('Online', online, false);
    group('Offline', offline, true);

    if (members.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'member-group';
        empty.innerText = 'No members';
        memberListEl.appendChild(empty);
    }
}

// ── Member profile card ─────────────────────────────────────────────────────
// Click a member → profile popup. Admin accounts show their Admin details
// here — the bottom-left panel only ever shows YOUR own profile.
function openMemberCard(m) {
    if (!m) return;
    const card = $('member-card');
    $('member-card-banner').style.backgroundColor = m.avatarColor || '#5865f2';
    const av = $('member-card-avatar');
    av.innerHTML = '';
    av.appendChild(avatarEl(m.username, m.avatarColor, 80, m.status || 'offline',
        { avatarUrl: m.avatarUrl, decoration: m.decoration }));

    $('member-card-name').innerText = m.username;
    $('member-card-pronouns').innerText = m.pronouns || '';

    const isAdmin = m.role === 'admin' || m.owner;
    $('member-card-badge').hidden = !isAdmin && !m.isBot;
    if (m.isBot) {
        $('member-card-badge').innerHTML = '<span class="bot-tag">BOT</span><span>MeshCord Bot</span>';
    } else if (isAdmin) {
        $('member-card-badge').innerHTML =
            `<span class="admin-crown">${icon('crown', 14)}<em>ADMIN</em></span>` +
            '<span>Node Administrator</span>';
    }

    const roleSec = $('member-card-role');
    roleSec.hidden = !isAdmin;
    if (isAdmin) {
        roleSec.innerHTML =
            '<h4>Admin</h4><p>Master Admin of this node — manages servers, ' +
            'members, bots and node settings via the admin dashboard.</p>';
    }
    card.hidden = false;
    paintIcons(card);
}
$('member-card').addEventListener('click', (e) => {
    if (e.target === $('member-card')) $('member-card').hidden = true;
});

// ── Channel navigation history (← → in the header) ───────────────────────────
const navStack = [];
let navIdx = -1;
let navApplying = false;

function navPush(channelId) {
    if (navApplying) return;
    if (navStack[navIdx] === channelId) return;
    navStack.length = navIdx + 1;      // drop the forward trail
    navStack.push(channelId);
    navIdx = navStack.length - 1;
    syncNavButtons();
}
function syncNavButtons() {
    $('btn-nav-back').disabled    = navIdx <= 0;
    $('btn-nav-forward').disabled = navIdx >= navStack.length - 1;
}
$('btn-nav-back').addEventListener('click', async () => {
    if (navIdx <= 0) return;
    navApplying = true;
    try { await selectChannel(navStack[--navIdx]); } finally { navApplying = false; }
    syncNavButtons();
});
$('btn-nav-forward').addEventListener('click', async () => {
    if (navIdx >= navStack.length - 1) return;
    navApplying = true;
    try { await selectChannel(navStack[++navIdx]); } finally { navApplying = false; }
    syncNavButtons();
});

// ── Voice ────────────────────────────────────────────────────────────────────
function requestVoiceState(serverId) {
    try {
        SendRealtime(JSON.stringify({ type: 'voice.state', data: { serverId } }));
    } catch (err) {
        console.debug('[voice] state request skipped:', err);
    }
}

async function joinVoice(channel) {
    try {
        closeDrawer();
        await Voice.join(channel.id);
        hint(`Joined voice: ${channel.name}`);
    } catch (err) {
        await notify(errText(err));
    }
}

// Keeps sidebar occupancy in step with the server's broadcasts.
function applyVoiceFrame(frame) {
    const data = frame.data || {};

    switch (frame.type) {
        case 'voice.state':
            Object.entries(data.channels || {}).forEach(([id, users]) => {
                voiceOccupants.set(id, users || []);
            });
            break;

        case 'voice.peers':
            voiceOccupants.set(data.channelId, [
                ...(data.peers || []),
                { clientId: Voice.myClientId(), username: myProfile.username, color: myProfile.avatarColor },
            ]);
            break;

        case 'voice.joined': {
            const list = voiceOccupants.get(data.channelId) || [];
            if (!list.some((u) => u.clientId === data.user.clientId)) list.push(data.user);
            voiceOccupants.set(data.channelId, list);
            break;
        }

        case 'voice.left':
            voiceOccupants.forEach((list, id) => {
                voiceOccupants.set(id, list.filter((u) => u.clientId !== data.clientId));
            });
            break;

        default:
            return;
    }
    renderChannels();
}

function renderVoiceUI() {
    const connected = Voice.isConnected();
    if (voicePanel) voicePanel.hidden = !connected;

    if (connected) {
        const ch = channels.find((c) => c.id === Voice.currentChannel());
        const statusText = $('voice-status-text');
        const chanText   = $('voice-status-channel');
        if (statusText) statusText.innerText = `Voice Connected · ${Voice.peerCount() + 1}`;
        if (chanText)   chanText.innerText = ch ? ch.name : '';
    }

    const muteBtn   = $('btn-mute');
    const deafenBtn = $('btn-deafen');
    if (muteBtn) {
        muteBtn.classList.toggle('on', Voice.isMuted());
        muteBtn.dataset.tooltip = Voice.isMuted() ? 'Unmute' : 'Mute';
        muteBtn.querySelector('.icon-slot').innerHTML = icon(Voice.isMuted() ? 'micOff' : 'mic', 20);
    }
    if (deafenBtn) {
        deafenBtn.classList.toggle('on', Voice.isDeafened());
        deafenBtn.dataset.tooltip = Voice.isDeafened() ? 'Undeafen' : 'Deafen';
        deafenBtn.querySelector('.icon-slot').innerHTML =
            icon(Voice.isDeafened() ? 'headphonesOff' : 'headphones', 20);
    }
    renderChannels();
}

Voice.onChange(renderVoiceUI);

// ── Realtime ─────────────────────────────────────────────────────────────────
function handleRealtimeFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    const data = frame.data || {};

    if (frame.type === 'auth.ok') {
        Voice.setClientId(data.clientId);
        return;
    }

    if (frame.type.startsWith('voice.')) {
        applyVoiceFrame(frame);
        Voice.handleFrame(frame);
        return;
    }

    switch (frame.type) {
        case 'message.new':
            if (data.channelId === currentChannelId) appendMessage(data.message);
            else {
                unreadChannels.add(data.channelId);
                renderChannels();
            }
            maybeToastMention(data);
            break;

        case 'message.edit': {
            const edited = data.message;
            if (data.channelId === currentChannelId && edited?.id) {
                const stored = msgIndex.get(edited.id);
                if (stored) {
                    stored.content = edited.content;
                    stored.edited = true;
                }
                const contentEl = messageList?.querySelector(`[data-msg-id="${edited.id}"] .message-content`);
                if (contentEl) {
                    contentEl.innerHTML = renderMentionedContent(edited.content || '');
                    const ed = document.createElement('span');
                    ed.className = 'message-edited';
                    ed.innerText = '(edited)';
                    contentEl.appendChild(ed);
                }
            }
            break;
        }

        case 'message.delete':
            if (data.channelId === currentChannelId && data.msgId) {
                msgIndex.delete(data.msgId);
                renderedMessageIds.delete(data.msgId);
                messageList?.querySelector(`[data-msg-id="${data.msgId}"]`)?.remove();
            }
            break;

        case 'reaction.update':
            if (data.channelId === currentChannelId && data.msgId) {
                const stored = msgIndex.get(data.msgId);
                if (stored) stored.reactions = data.reactions || {};
                const row = messageList?.querySelector(`[data-msg-id="${data.msgId}"]`);
                if (row && stored) renderMessageReactions(row, stored);
            }
            break;

        case 'member_join':
        case 'member_left':
        case 'member_ban':
            if (data.serverId === currentServerId) loadMembers(currentServerId);
            break;

        case 'user.status': {
            const m = members.find((x) => x.id === data.userId);
            if (m) { m.status = data.status; renderMembers(); }
            break;
        }

        case 'automod.action': {
            const msgs = {
                warn:    data.message || `⚠ Your message was removed by node moderation: ${data.term || 'rule violation'}. Further violations will mute or ban you.`,
                warning: data.message || `⚠ Your message was removed by node moderation: ${data.reason || 'rule violation'}. Further violations will mute or ban you.`,
                timeout: data.message || `🔇 You were timed out until ${new Date(data.until || 0).toLocaleString()} by node moderation.`,
                mute:    data.message || `🔇 You were timed out until ${new Date(data.until || 0).toLocaleString()} by node moderation.`,
                banned:  data.message || '⛔ You have been permanently banned from this node by node moderation.',
                ban:     data.message || '⛔ You have been permanently banned from this node by node moderation.',
            };
            if (msgs[data.action]) notify(msgs[data.action]);
            break;
        }

        case 'pin.update':
            if (data.channelId === currentChannelId) renderPinsPanel();
            break;

        case 'ticket.opened':
            // A ticket was filed on a server we can see — staff get the new
            // channel in their list instantly.
            if (data.serverId === currentServerId && data.channel) {
                channels.push(data.channel);
                renderChannels();
            }
            break;

        case 'error':
            console.warn('[realtime]', data.error);
            break;

        default:
            break;
    }
}

EventsOn('realtime:event', handleRealtimeFrame);

EventsOn('realtime:status', (status) => {
    realtimeStatus = status;
    if (!pingDisplay) return;
    if (status === 'auth-failed') {
        pingDisplay.innerText = 'signed out';
        pingDisplay.style.color = 'var(--red)';
    } else if (status !== 'connected') {
        pingDisplay.innerText = status === 'connecting' ? 'connecting…' : 'offline';
        pingDisplay.style.color = status === 'connecting' ? 'var(--yellow)' : 'var(--red)';
    }
});

// ── Roles ────────────────────────────────────────────────────────────────────
async function loadRoles(serverId) {
    try {
        roles = (await ListRoles(serverId)) || [];
    } catch (err) {
        console.error('Could not load roles:', err);
        roles = [];
    }
    renderRoles();
}

function renderRoles() {
    const list = $('roles-list');
    if (!list) return;
    list.innerHTML = '';

    if (roles.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'roles-empty';
        empty.innerText = 'No roles yet.';
        list.appendChild(empty);
    }

    roles.forEach((role) => {
        const row = document.createElement('div');
        row.className = 'role-row' + (role.id === selectedRoleId ? ' active' : '');

        const dot = document.createElement('span');
        dot.className = 'role-dot';
        dot.style.backgroundColor = role.color || '#99aab5';

        const nm = document.createElement('span');
        nm.className = 'role-name-text';
        nm.innerText = role.name;

        row.appendChild(dot);
        row.appendChild(nm);
        row.addEventListener('click', () => selectRole(role.id));
        list.appendChild(row);
    });

    const editor = $('role-editor');
    const empty  = $('role-editor-empty');
    const role   = roles.find((r) => r.id === selectedRoleId);
    if (editor) editor.hidden = !role;
    if (empty)  empty.hidden  = !!role;
    if (role)   fillRoleEditor(role);
}

function selectRole(roleId) {
    selectedRoleId = roleId;
    renderRoles();
}

function fillRoleEditor(role) {
    $('edit-role-name').value  = role.name || '';
    const color = role.color || '#99aab5';
    $('edit-role-color').value = color;
    $('edit-role-color-value').innerText = color.toUpperCase();

    const box = $('role-permissions');
    box.innerHTML = '';
    const perms = role.permissions || {};

    PERMISSIONS.forEach((perm) => {
        const row = document.createElement('div');
        row.className = 'permission-row';
        row.innerHTML =
            `<div><div class="permission-label">${escapeHtml(perm.label)}</div>` +
            `<div class="permission-desc">${escapeHtml(perm.desc)}</div></div>`;

        const sw = document.createElement('div');
        sw.className = 'switch' + (perms[perm.key] ? ' on' : '');
        sw.dataset.perm = perm.key;
        sw.addEventListener('click', () => sw.classList.toggle('on'));

        row.appendChild(sw);
        box.appendChild(row);
    });
}

function collectPermissions() {
    const out = {};
    document.querySelectorAll('#role-permissions .switch').forEach((sw) => {
        out[sw.dataset.perm] = sw.classList.contains('on');
    });
    return out;
}

function roleNote(text, ok = true) {
    const note = $('role-save-note');
    if (!note) return;
    note.innerText = text;
    note.className = `inline-note ${ok ? 'ok' : 'bad'}`;
    clearTimeout(roleNote._t);
    roleNote._t = setTimeout(() => { note.innerText = ''; }, 3000);
}

// ── Server settings ──────────────────────────────────────────────────────────
function openServerSettings() {
    if (!currentServerId) return;
    const server = servers.find((s) => s.id === currentServerId);
    if (!server) return;

    if (serverDropdown) serverDropdown.hidden = true;
    $('settings-server-title').innerText = server.name;
    $('settings-server-name').value = server.name || '';
    $('settings-server-desc').value = server.description || '';
    selectedRoleId = null;

    // Support tab — only exists on Community servers, admin-only to edit.
    const isAdmin = session && (session.role === 'admin' || session.role === 'owner');
    const showSupport = server.category === 'Community' && isAdmin;
    $('tab-support').hidden = !showSupport;
    if (showSupport) loadSupportSettings(server);

    loadInviteList(server);
    settingsModal.hidden = false;
    showSettingsTab('overview');
    loadRoles(currentServerId);
}

async function loadSupportSettings(server) {
    try {
        const s = await GetSupport(server.id);
        $('support-open-switch').classList.toggle('on', !s || s.open !== false);
        $('support-hours').value     = s?.hours    || 'Mon-Fri 9AM - 5PM';
        $('support-timezone').value  = s?.timezone || 'EST';
    } catch { /* no support config yet — defaults stay */ }
}

$('btn-save-support').addEventListener('click', async () => {
    const note = $('support-save-note');
    try {
        await UpdateServerSupport(currentServerId,
            $('support-open-switch').classList.contains('on'),
            $('support-hours').value.trim(),
            $('support-timezone').value);
        note.innerText = 'Saved';
        setTimeout(() => { note.innerText = ''; }, 3000);
    } catch (err) {
        note.innerText = errText(err);
    }
});

$('support-open-switch').addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('on');
});

async function loadInviteList(server) {
    const list = $('invite-list');
    if (!list) return;
    list.innerHTML = '';
    try {
        const invites = await ListInvites(server.id);
        const domain  = (session?.domain || '').replace(/^https?:\/\//, '');
        for (const inv of invites) {
            const row = document.createElement('div');
            row.className = 'invite-row';
            row.innerHTML =
                `<code>https://${escapeHtml(domain)}/invite/${escapeHtml(inv.code)}</code>` +
                `<button class="btn btn-secondary invite-copy" data-code="${escapeHtml(inv.code)}">Copy</button>`;
            list.appendChild(row);
        }
        list.querySelectorAll('.invite-copy').forEach((b) => b.addEventListener('click', async () => {
            await navigator.clipboard?.writeText(
                `https://${domain}/invite/${b.dataset.code}`);
            b.innerText = 'Copied';
            setTimeout(() => { b.innerText = 'Copy'; }, 2000);
        }));
    } catch { list.innerHTML = ''; }
}

$('btn-create-invite').addEventListener('click', async () => {
    const note = $('invite-note');
    const slug = $('invite-slug').value.trim();
    if (!slug) { note.innerText = 'Enter a slug first'; return; }
    try {
        await CreateCustomInvite(currentServerId, slug);
        note.innerText = 'Invite created';
        $('invite-slug').value = '';
        const server = servers.find((s) => s.id === currentServerId);
        if (server) await loadInviteList(server);
        setTimeout(() => { note.innerText = ''; }, 3000);
    } catch (err) {
        note.innerText = errText(err);
    }
});

function showSettingsTab(tab) {
    document.querySelectorAll('#settings-modal .settings-tab[data-tab]').forEach((el) => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('#settings-modal .settings-section').forEach((el) => {
        el.hidden = el.dataset.section !== tab;
    });
}

// ── Window chrome ────────────────────────────────────────────────────────────
// The window is frameless (see main.go), so minimise/maximise/close are ours to
// draw and drive. The maximise glyph flips to the "restore" pair while the
// window is maximised, exactly as Windows and Discord do.
async function paintWindowButtons() {
    let maximised = false;
    try {
        maximised = await WindowIsMaximised();
    } catch { /* runtime not ready during first paint */ }

    const maxBtn = $('btn-win-maximize');
    $('btn-win-minimize').innerHTML = winIcon('minimize');
    maxBtn.innerHTML = winIcon(maximised ? 'restore' : 'maximize');
    maxBtn.setAttribute('aria-label', maximised ? 'Restore' : 'Maximize');
    $('btn-win-close').innerHTML = winIcon('close');
}

async function toggleMaximise() {
    await WindowToggleMaximise();
    paintWindowButtons();
}

$('btn-win-minimize').addEventListener('click', () => WindowMinimise());
$('btn-win-maximize').addEventListener('click', toggleMaximise);
$('btn-win-close').addEventListener('click', () => Quit());
$('titlebar-drag').addEventListener('dblclick', toggleMaximise);
window.addEventListener('resize', paintWindowButtons);

// ── Event wiring ─────────────────────────────────────────────────────────────
paintIcons();
paintWindowButtons();

if (serverHeaderBtn) {
    serverHeaderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!currentServerId) { hint('Select a server first.'); return; }
        if (serverDropdown) serverDropdown.hidden = !serverDropdown.hidden;
    });
}
document.addEventListener('click', () => {
    if (serverDropdown && !serverDropdown.hidden) serverDropdown.hidden = true;
});
if (serverDropdown) serverDropdown.addEventListener('click', (e) => e.stopPropagation());

$('btn-dropdown-settings').addEventListener('click', openServerSettings);
$('btn-create-channel').addEventListener('click', () => {
    if (serverDropdown) serverDropdown.hidden = true;
    createMeshChannel();
});

$('btn-leave-server').addEventListener('click', async () => {
    if (serverDropdown) serverDropdown.hidden = true;
    const server = servers.find((s) => s.id === currentServerId);
    if (!server) return;
    const ok = await askConfirm(`Leave “${server.name}”?`, 'Leave Server');
    if (!ok) return;
    try {
        await LeaveServer(server.id);
        currentServerId = null;
        await loadServers();
    } catch (err) {
        await notify(`Could not leave: ${errText(err)}`);
    }
});

$('btn-add-server').addEventListener('click', createMeshServer);

$('btn-home').addEventListener('click', () => {
    closeDrawer();
    currentServerId = null;
    currentChannelId = null;
    channels = [];
    members = [];
    renderServers();
    renderChannels();
    renderMembers();
    clearMessages();
    setChannelHeader(null);
    syncServerHeader();
});

if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });
}

// Mobile: hamburger opens the channel drawer; scrim closes it.
const menuBtn = $('btn-menu');
if (menuBtn) menuBtn.addEventListener('click', openDrawer);
if (drawerScrimEl) drawerScrimEl.addEventListener('click', closeDrawer);

// Header controls
$('btn-toggle-members').addEventListener('click', () => {
    memberListVisible = !memberListVisible;
    syncMemberList();
});

// Client-side filter over the messages already loaded for this channel.
const searchInput = $('message-search');
if (searchInput) {
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        messageList.querySelectorAll('.message').forEach((el) => {
            el.hidden = q !== '' && !(el.dataset.content || '').includes(q);
        });
    });
}

// Composer controls with no upload/picker UI behind them yet — say so rather
// than clicking into nothing.
[['btn-attach', 'File uploads'], ['btn-emoji', 'The emoji picker']]
    .forEach(([id, label]) => {
        const el = $(id);
        if (el) el.addEventListener('click', () => hint(`${label} isn't implemented yet.`));
    });

// Voice controls
$('btn-mute').addEventListener('click', () => Voice.toggleMute());
$('btn-deafen').addEventListener('click', () => Voice.toggleDeafen());
$('btn-voice-disconnect').addEventListener('click', () => Voice.leave());

// Server settings
document.querySelectorAll('#settings-modal .settings-tab[data-tab]').forEach((el) => {
    el.addEventListener('click', () => showSettingsTab(el.dataset.tab));
});
$('btn-close-server-settings').addEventListener('click', () => { settingsModal.hidden = true; });

$('btn-save-server').addEventListener('click', async () => {
    const note = $('server-save-note');
    try {
        await UpdateServer(currentServerId, $('settings-server-name').value.trim(),
                           $('settings-server-desc').value.trim());
        await loadServers();
        note.innerText = 'Saved';
        note.className = 'inline-note ok';
    } catch (err) {
        note.innerText = errText(err);
        note.className = 'inline-note bad';
    }
    clearTimeout($('btn-save-server')._t);
    $('btn-save-server')._t = setTimeout(() => { note.innerText = ''; }, 3000);
});

$('btn-delete-server').addEventListener('click', async () => {
    const server = servers.find((s) => s.id === currentServerId);
    if (!server) return;
    const ok = await askConfirm(
        `Delete “${server.name}”? This cannot be undone.`, 'Delete Server');
    if (!ok) return;
    try {
        await DeleteServer(server.id);
        settingsModal.hidden = true;
        currentServerId = null;
        await loadServers();
    } catch (err) {
        await notify(`Could not delete: ${errText(err)}`);
    }
});

// Roles
$('btn-create-role').addEventListener('click', async () => {
    const name = await askText('Create Role', 'Role Name', 'new role');
    if (!name) return;
    try {
        const role = await CreateRole(currentServerId, name, '#99aab5');
        await loadRoles(currentServerId);
        selectRole(role.id);
    } catch (err) {
        await notify(`Could not create role: ${errText(err)}`);
    }
});

$('edit-role-color').addEventListener('input', (e) => {
    $('edit-role-color-value').innerText = e.target.value.toUpperCase();
});

$('btn-save-role').addEventListener('click', async () => {
    if (!selectedRoleId) return;
    try {
        await UpdateRole(currentServerId, selectedRoleId,
                         $('edit-role-name').value.trim(),
                         $('edit-role-color').value,
                         collectPermissions());
        await loadRoles(currentServerId);
        roleNote('Saved');
    } catch (err) {
        roleNote(errText(err), false);
    }
});

$('btn-delete-role').addEventListener('click', async () => {
    if (!selectedRoleId) return;
    const role = roles.find((r) => r.id === selectedRoleId);
    const ok = await askConfirm(`Delete the “${role ? role.name : ''}” role?`, 'Delete Role');
    if (!ok) return;
    try {
        await DeleteRole(currentServerId, selectedRoleId);
        selectedRoleId = null;
        await loadRoles(currentServerId);
    } catch (err) {
        roleNote(errText(err), false);
    }
});

// User settings
$('btn-user-settings').addEventListener('click', () => {
    userSettingsModal.hidden = false;
    showUserTab('account');
});
// ── Self profile popout ────────────────────────────────────────────────────
// Clicking the user panel opens a Discord-style profile card anchored above
// it: banner, big avatar, status bubble, badges, about, actions.
const STATUS_LABELS = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Invisible' };

function closeUserPopout() { $('user-popout').hidden = true; }

function renderUserPopout() {
    const p = myProfile;
    $('popout-banner').style.backgroundColor = p.avatarColor || '#5865f2';

    const av = $('popout-avatar');
    av.innerHTML = '';
    av.appendChild(avatarEl(p.username, p.avatarColor, 80, p.status || 'online',
        { avatarUrl: p.avatarUrl, decoration: p.decoration }));

    $('popout-name').innerText = p.username;
    $('popout-handle').innerText =
        (p.pronouns ? `${p.pronouns} · ` : '') + (p.meshId ? `@${p.meshId.slice(0, 12)}…` : '');

    const bubble = $('popout-status-bubble');
    bubble.hidden = !p.customStatus;
    bubble.innerText = p.customStatus || '';

    const badges = $('popout-badges');
    badges.innerHTML = '';
    if (session && (session.role === 'admin' || session.role === 'owner')) {
        const b = document.createElement('span');
        b.className = 'admin-crown';
        b.innerHTML = icon('crown', 14) + '<em>ADMIN</em>';
        badges.appendChild(b);
    }

    const aboutSec = $('popout-about-sec');
    aboutSec.hidden = !p.about;
    $('popout-about').innerText = p.about || '';

    const dot = $('popout-status-dot');
    dot.className = `status-dot ${p.status || 'online'}`;
    $('popout-status-label').innerText = STATUS_LABELS[p.status || 'online'];
    paintIcons($('user-popout'));
}

$('btn-user-card').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('user-popout');
    if (pop.hidden) {
        renderUserPopout();
        $('popout-status-menu').hidden = true;
        pop.hidden = false;
    } else {
        closeUserPopout();
    }
});
$('user-popout').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeUserPopout);

$('popout-status-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('popout-status-menu');
    menu.hidden = !menu.hidden;
});
document.querySelectorAll('#popout-status-menu [data-status]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const status = btn.dataset.status;
        try {
            await SetMyStatus(status);
            myProfile.status = status;
            $('popout-status-dot').className = `status-dot ${status}`;
            $('popout-status-label').innerText = STATUS_LABELS[status];
            const dot = document.querySelector('#self-avatar .status-dot');
            if (dot) dot.className = `status-dot ${status}`;
            const activity = $('current-activity');
            if (activity && !activity.dataset.live) {
                activity.innerText = myProfile.customStatus || STATUS_LABELS[status];
            }
        } catch (err) {
            console.error('Status update failed:', err);
        }
        $('popout-status-menu').hidden = true;
    });
});
$('popout-edit-profile').addEventListener('click', () => {
    closeUserPopout();
    userSettingsModal.hidden = false;
    showUserTab('profiles');
});
$('popout-copy-id').addEventListener('click', async () => {
    const id = (session && session.userId) || myProfile.meshId || '';
    try {
        await navigator.clipboard.writeText(id);
        const btn = $('popout-copy-id');
        btn.classList.add('copied');
        setTimeout(() => btn.classList.remove('copied'), 1200);
    } catch { /* clipboard unavailable */ }
});
$('popout-logout').addEventListener('click', () => {
    closeUserPopout();
    $('btn-logout').click();
});

$('btn-close-user-settings').addEventListener('click', () => { userSettingsModal.hidden = true; });

function showUserTab(tab) {
    document.querySelectorAll('#user-settings-modal .settings-tab[data-utab]').forEach((el) => {
        el.classList.toggle('active', el.dataset.utab === tab);
    });
    document.querySelectorAll('#user-settings-modal [data-usection]').forEach((el) => {
        el.hidden = el.dataset.usection !== tab;
    });
    if (tab === 'profiles') loadProfilesSection();
    if (tab === 'privacy')  loadPrivacySection();
}

document.querySelectorAll('#user-settings-modal .settings-tab[data-utab]').forEach((el) => {
    el.addEventListener('click', () => showUserTab(el.dataset.utab));
});

/* ── Profiles ──────────────────────────────────────────────────────────── */
// Paints an avatar element from current profile state (img or initials +
// glow decoration). Used by the preview + the upload-preview thumbnail.
function paintProfileAvatar(el, name, color) {
    el.className = el.className.replace(/\bdeco-\S+/g, '');
    if (myProfile.decoration && myProfile.decoration !== 'none') {
        el.classList.add(`deco-${myProfile.decoration}`);
    }
    el.style.backgroundColor = color;
    if (myProfile.avatarUrl) {
        el.classList.add('has-img');
        let img = el.querySelector('.avatar-img');
        if (!img) {
            img = document.createElement('img');
            img.className = 'avatar-img';
            el.prepend(img);
        }
        img.src = avatarUrlFull(myProfile.avatarUrl);
        const i = el.querySelector('.avatar-initials');
        if (i) i.remove();
    } else {
        el.classList.remove('has-img');
        const img = el.querySelector('.avatar-img');
        if (img) img.remove();
        let i = el.querySelector('.avatar-initials');
        if (!i) {
            i = document.createElement('span');
            i.className = 'avatar-initials';
            el.prepend(i);
        }
        i.innerText = initialsOf(name);
    }
}

const DECORATIONS = [
    { id: 'none',    name: 'None' },
    { id: 'purple',  name: 'Nebula' },
    { id: 'gold',    name: 'Solar' },
    { id: 'cyan',    name: 'Arc' },
    { id: 'emerald', name: 'Verdant' },
    { id: 'rose',    name: 'Ember' },
];

function renderDecorationGrid() {
    const grid = $('decoration-grid');
    if (!grid || grid.childElementCount) return;
    DECORATIONS.forEach((d) => {
        const cell = document.createElement('button');
        cell.className = 'decoration-cell';
        cell.dataset.deco = d.id;
        const av = document.createElement('div');
        av.className = 'avatar avatar-40' + (d.id !== 'none' ? ` deco-${d.id}` : '');
        av.style.backgroundColor = '#5865f2';
        av.innerHTML = `<span class="avatar-initials">${initialsOf(myProfile.username)}</span>`;
        cell.appendChild(av);
        const label = document.createElement('span');
        label.className = 'decoration-name';
        label.innerText = d.name;
        cell.appendChild(label);
        if (d.id === 'none') cell.classList.add('deco-none');
        cell.addEventListener('click', () => {
            myProfile.decoration = d.id;
            grid.querySelectorAll('.decoration-cell').forEach((c) =>
                c.classList.toggle('selected', c.dataset.deco === d.id));
            refreshProfilePreview();
            paintProfileAvatar($('profile-avatar-preview'), myProfile.username, myProfile.avatarColor);
        });
        grid.appendChild(cell);
    });
}

function refreshProfilePreview() {
    const name  = $('profile-display-name').value.trim() || 'MeshCord';
    const color = $('profile-avatar-color').value || '#5865f2';
    $('profile-preview-name').innerText = name;
    $('profile-preview-status').innerText = $('profile-status').value.trim();
    paintProfileAvatar($('profile-preview-avatar'), name, color);
    const val = $('profile-avatar-color-value');
    if (val) val.innerText = color.toUpperCase();
}

async function loadProfilesSection() {
    try {
        const server = await GetMyProfile();
        if (server) {
            myProfile.customStatus = server.customStatus ?? myProfile.customStatus;
            myProfile.avatarColor  = server.avatarColor  ?? myProfile.avatarColor;
            myProfile.pronouns     = server.pronouns     ?? myProfile.pronouns;
            myProfile.decoration   = server.decoration   ?? myProfile.decoration;
            myProfile.avatarUrl    = server.avatarUrl    ?? myProfile.avatarUrl;
            myProfile.about        = server.about        ?? myProfile.about;
        }
    } catch (err) {
        console.error('Profile fetch failed:', err);
    }
    $('profile-display-name').value = myProfile.username;
    $('profile-status').value       = myProfile.customStatus || '';
    $('profile-about').value        = myProfile.about || '';
    $('profile-pronouns').value     = myProfile.pronouns || '';
    $('profile-avatar-color').value = myProfile.avatarColor || '#5865f2';
    renderDecorationGrid();
    $('decoration-grid').querySelectorAll('.decoration-cell').forEach((c) =>
        c.classList.toggle('selected', c.dataset.deco === (myProfile.decoration || 'none')));
    paintProfileAvatar($('profile-avatar-preview'), myProfile.username, myProfile.avatarColor);
    refreshProfilePreview();
    applyProfileToUI();
}

['profile-display-name', 'profile-status', 'profile-avatar-color'].forEach((id) => {
    $(id).addEventListener('input', refreshProfilePreview);
});

/* Avatar upload: file → downscale to ≤256px → POST to the node. */
$('btn-upload-avatar').addEventListener('click', () => $('avatar-file').click());
$('avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { await notify('Image must be under 8 MB.'); return; }
    const note = $('profile-save-note');
    try {
        const dataUrl = await downscaleImage(file);
        note.innerText = 'Uploading…';
        note.className = 'inline-note';
        myProfile.avatarUrl = await UploadAvatar(dataUrl);
        note.innerText = 'Avatar updated.';
        note.className = 'inline-note ok';
    } catch (err) {
        note.innerText = `⚠ ${errText(err)}`;
        note.className = 'inline-note bad';
    }
    paintProfileAvatar($('profile-avatar-preview'), myProfile.username, myProfile.avatarColor);
    refreshProfilePreview();
    applyProfileToUI();
    clearTimeout(note._t);
    note._t = setTimeout(() => { note.innerText = ''; }, 3000);
});
$('btn-remove-avatar').addEventListener('click', async () => {
    const note = $('profile-save-note');
    try {
        myProfile.avatarUrl = await UploadAvatar('');
        note.innerText = 'Avatar removed.';
        note.className = 'inline-note ok';
    } catch (err) {
        note.innerText = `⚠ ${errText(err)}`;
        note.className = 'inline-note bad';
    }
    paintProfileAvatar($('profile-avatar-preview'), myProfile.username, myProfile.avatarColor);
    refreshProfilePreview();
    applyProfileToUI();
    clearTimeout(note._t);
    note._t = setTimeout(() => { note.innerText = ''; }, 3000);
});

// Reads an image file, downscales to ≤256px on a canvas (GIFs pass through so
// animation survives), returns a data URL.
function downscaleImage(file) {
    return new Promise((resolve, reject) => {
        if (file.type === 'image/gif') {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.readAsDataURL(file);
            return;
        }
        const img = new Image();
        img.onload = () => {
            const max = 256;
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(img.src);
            resolve(c.toDataURL('image/png'));
        };
        img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Could not read that image.')); };
        img.src = URL.createObjectURL(file);
    });
}

$('btn-save-profile').addEventListener('click', async () => {
    const note = $('profile-save-note');
    const name = $('profile-display-name').value.trim();
    if (name) myProfile.username = name;
    myProfile.customStatus = $('profile-status').value.trim();
    myProfile.avatarColor  = $('profile-avatar-color').value;
    myProfile.about        = $('profile-about').value.trim();
    myProfile.pronouns     = $('profile-pronouns').value.trim();

    try {
        await UpdateMyProfile(myProfile.customStatus, myProfile.avatarColor,
            myProfile.pronouns, myProfile.decoration || 'none', myProfile.about);
        note.innerText = 'Saved.';
        note.className = 'inline-note ok';
    } catch (err) {
        note.innerText = `⚠ ${errText(err)}`;
        note.className = 'inline-note bad';
    }
    applyProfileToUI();
    refreshProfilePreview();
    await persist();
    clearTimeout(note._t);
    note._t = setTimeout(() => { note.innerText = ''; }, 3000);
});

/* ── Privacy & Safety ──────────────────────────────────────────────────── */
function loadPrivacySection() {
    ['dms', 'status', 'filter'].forEach((k) => {
        $(`priv-${k}`).classList.toggle('on', !!myProfile.privacy?.[k]);
    });
}

['dms', 'status', 'filter'].forEach((k) => {
    $(`priv-${k}`).addEventListener('click', async (e) => {
        myProfile.privacy = myProfile.privacy || {};
        myProfile.privacy[k] = !myProfile.privacy[k];
        e.currentTarget.classList.toggle('on', myProfile.privacy[k]);
        applyProfileToUI();
        await persist();
    });
});

$('btn-clear-local').addEventListener('click', async () => {
    const ok = await askConfirm(
        'Sign out and wipe all locally stored preferences on this device?',
        'Clear Local Data');
    if (!ok) return;
    try { await Logout(); } catch (err) { console.error(err); }
    try { await SaveData(JSON.stringify({})); } catch (err) { console.error(err); }
    window.location.reload();
});

$('link-privacy-policy').addEventListener('click', (e) => {
    e.preventDefault();
    const url = 'https://meshcordapp.xyz/privacy.html';
    try { window.runtime?.BrowserOpenURL(url); }
    catch { window.open(url, '_blank', 'noopener'); }
});

$('btn-logout').addEventListener('click', async () => {
    const ok = await askConfirm('Log out of this instance?', 'Log Out');
    if (!ok) return;
    try { await Logout(); } catch (err) { console.error(err); }
    window.location.reload();
});

// "Edit User Profile" jumps to the full Profiles tab — the real editor
// with preview — rather than a bare rename prompt.
$('btn-edit-profile').addEventListener('click', () => showUserTab('profiles'));

$('edit-avatar-color').addEventListener('input', async (e) => {
    myProfile.avatarColor = e.target.value;
    applyProfileToUI();
    await persist();
});

$('edit-custom-status').addEventListener('change', async (e) => {
    myProfile.customStatus = e.target.value.trim();
    await persist();
});

// Close full-screen settings with Escape, like Discord.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!settingsModal.hidden)     { settingsModal.hidden = true; return; }
    if (!userSettingsModal.hidden) { userSettingsModal.hidden = true; return; }
    if (!$('bots-modal').hidden)   { $('bots-modal').hidden = true; return; }
    if (!$('help-modal').hidden)   { $('help-modal').hidden = true; return; }
    closeHeaderPanels();
    if (!discoveryModal.hidden)    { discoveryModal.hidden = true; }
});

// ── 2FA ──────────────────────────────────────────────────────────────────────
let pendingTotpSecret = null;

$('btn-setup-2fa').addEventListener('click', async () => {
    try {
        const setup = await GenerateTOTP(myProfile.username);
        pendingTotpSecret = setup.secret;
        $('totp-qr').src = setup.qr;
        $('totp-secret').innerText = setup.secret;
        $('totp-setup').hidden = false;
        $('totp-result').innerText = '';
    } catch (err) {
        console.error('TOTP setup failed:', err);
    }
});

$('btn-verify-2fa').addEventListener('click', async () => {
    const result = $('totp-result');
    if (!pendingTotpSecret) return;
    try {
        const ok = await VerifyTOTP(pendingTotpSecret, $('totp-code').value);
        if (ok) {
            myProfile.totpSecret = pendingTotpSecret;
            await persist();
            result.innerText = '✓ 2FA enabled';
            result.className = 'inline-note ok';
        } else {
            result.innerText = '✗ Invalid code';
            result.className = 'inline-note bad';
        }
    } catch (err) {
        console.error('TOTP verify failed:', err);
    }
});

// ── Onboarding ───────────────────────────────────────────────────────────────
function showOnboarding() {
    onboardingModal.hidden = false;
    $('onboard-step-1').hidden = false;
    $('onboard-step-2').hidden = true;
    $('onboard-step-3').hidden = true;
}

const SERVER_TEMPLATES = [
    { id: 'custom',    label: 'Blank' },
    { id: 'community', label: 'Community' },
    { id: 'gaming',    label: 'Gaming' },
    { id: 'friends',   label: 'Friends' },
    { id: 'study',     label: 'Study Group' },
    { id: 'art',       label: 'Art & Creators' },
];
let selectedTemplate = 'community';
// Stays dismissed for the rest of the session once an admin skips or
// finishes the wizard — it shouldn't re-pop on every refresh.
let setupWizardDismissed = false;

function populateSetupWizard() {
    const grid = $('setup-templates');
    if (!grid.dataset.populated) {
        SERVER_TEMPLATES.forEach((t) => {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'template-card' + (t.id === selectedTemplate ? ' active' : '');
            card.innerText = t.label;
            card.addEventListener('click', () => {
                selectedTemplate = t.id;
                grid.querySelectorAll('.template-card').forEach((c) =>
                    c.classList.toggle('active', c === card));
            });
            grid.appendChild(card);
        });
        const sel = $('setup-server-category');
        CATEGORIES.forEach((c) => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.innerText = c;
            sel.appendChild(opt);
        });
        grid.dataset.populated = '1';
    }
    if (myProfile.username && myProfile.username !== 'MeshCord'
            && !$('setup-server-name').value) {
        $('setup-server-name').value = `${myProfile.username}'s Server`;
    }
}

function showSetupWizard() {
    populateSetupWizard();
    $('onboard-step-2').hidden = true;
    $('onboard-step-3').hidden = false;
    $('setup-server-name').focus();
}

$('btn-setup-skip').addEventListener('click', async () => {
    setupWizardDismissed = true;
    onboardingModal.hidden = true;
    $('onboard-error-3').innerText = '';
    await startSession();
});

// Empty-state "Set Up Your Server" jumps straight into the same wizard.
$('chat-empty-setup').addEventListener('click', () => {
    setupWizardDismissed = false;
    onboardingModal.hidden = false;
    $('onboard-step-1').hidden = true;
    $('onboard-step-2').hidden = true;
    showSetupWizard();
});

$('btn-setup-create').addEventListener('click', async () => {
    const btn  = $('btn-setup-create');
    const err  = $('onboard-error-3');
    const name = $('setup-server-name').value.trim();
    if (!name) { err.innerText = 'Give the server a name, or skip for now.'; return; }
    btn.disabled = true;
    err.innerText = 'Creating…';
    try {
        const server = await CreateServer(
            name,
            $('setup-server-desc').value.trim(),
            $('setup-server-category').value,
            selectedTemplate,
            $('setup-server-public').checked,
        );
        // Optional vanity invite — skip quietly if the slug is taken; the
        // admin can always make one later in Server Settings → Invites.
        const slug = $('setup-invite-slug').value.trim();
        if (slug && server?.id) {
            try { await CreateCustomInvite(server.id, slug); } catch { /* taken */ }
        }
        setupWizardDismissed = true;
        onboardingModal.hidden = true;
        err.innerText = '';
        await startSession();
    } catch (e) {
        err.innerText = errText(e);
    } finally {
        btn.disabled = false;
    }
});

$('btn-onboard-next').addEventListener('click', () => {
    const u   = $('onboard-username').value.trim();
    const p   = $('onboard-password').value;
    const p2  = $('onboard-password2').value;
    const err = $('onboard-error-1');
    if (u.length < 2) { err.innerText = 'Username must be at least 2 characters.'; return; }
    if (p.length < 8) { err.innerText = 'Password must be at least 8 characters.'; return; }
    if (p !== p2)     { err.innerText = 'Passwords do not match.'; return; }
    err.innerText = '';
    $('onboard-step-1').hidden = true;
    $('onboard-step-2').hidden = false;
    $('onboard-domain').focus();
});

$('btn-onboard-back').addEventListener('click', () => {
    $('onboard-step-2').hidden = true;
    $('onboard-step-1').hidden = false;
});

$('btn-onboard-connect').addEventListener('click', async () => {
    const btn = $('btn-onboard-connect');
    const u   = $('onboard-username').value.trim();
    const p   = $('onboard-password').value;
    const err = $('onboard-error-2');
    err.innerText = 'Connecting…';
    btn.disabled = true;
    try {
        const domain = $('onboard-domain').value.trim();
        const reg    = $('onboard-register') && $('onboard-register').checked;
        session = await (reg ? Register(domain, u, p) : Connect(domain, u, p));
        myProfile.username = session.username || u;
        if (session.meshId) myProfile.meshId = session.meshId;
        await persist();
        applyProfileToUI();
        err.innerText = '';
        // Node admins finish onboarding by creating their first server —
        // the step-3 wizard replaces closing the modal outright.
        if (session.role === 'admin' || session.role === 'owner') {
            showSetupWizard();
        } else {
            onboardingModal.hidden = true;
            await startSession();
        }
    } catch (e) {
        err.innerText = errText(e);
    } finally {
        btn.disabled = false;
    }
});

// ── Discovery ────────────────────────────────────────────────────────────────
function populateCategoryFilter() {
    const sel = $('discovery-category');
    if (!sel || sel.dataset.populated) return;
    CATEGORIES.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.innerText = c;
        sel.appendChild(opt);
    });
    sel.dataset.populated = '1';
}

async function loadDiscovery() {
    const results = $('discovery-results');
    if (!results) return;
    results.innerHTML = '<div class="messages-empty">Loading…</div>';
    try {
        const found = await Discover($('discovery-search').value.trim(),
                                     $('discovery-category').value);
        if (!found || found.length === 0) {
            results.innerHTML = '<div class="messages-empty">No public servers found.</div>';
            return;
        }
        results.innerHTML = '';
        found.forEach((s) => {
            const card = document.createElement('div');
            card.className = 'discovery-card';
            card.appendChild(avatarEl(s.name, s.iconColor, 40));

            const body = document.createElement('div');
            body.className = 'discovery-card-body';
            body.innerHTML =
                `<div class="discovery-name">${escapeHtml(s.name)}</div>` +
                `<div class="discovery-desc">${escapeHtml(s.description || 'No description')}</div>` +
                `<div class="discovery-meta">${escapeHtml(s.category)} · ` +
                `${s.memberCount} member${s.memberCount === 1 ? '' : 's'}</div>`;
            card.appendChild(body);

            const joinBtn = document.createElement('button');
            joinBtn.className = 'btn btn-primary';
            joinBtn.innerText = 'Join';
            joinBtn.addEventListener('click', async () => {
                joinBtn.disabled = true;
                joinBtn.innerText = 'Joining…';
                try {
                    await JoinDiscoveredServer(s.id);
                    await SubscribeServer(s.id);
                    await loadServers();
                    joinBtn.innerText = '✓ Joined';
                } catch (e) {
                    joinBtn.innerText = 'Retry';
                    joinBtn.disabled = false;
                    console.error(e);
                }
            });
            card.appendChild(joinBtn);
            results.appendChild(card);
        });
    } catch (e) {
        results.innerHTML = `<div class="messages-error">${escapeHtml(errText(e))}</div>`;
    }
}

$('btn-discover').addEventListener('click', () => {
    if (!session.domain) { hint('Connect to a server first.', true); return; }
    populateCategoryFilter();
    discoveryModal.hidden = false;
    loadDiscovery();
});
$('btn-close-discovery').addEventListener('click', () => { discoveryModal.hidden = true; });

let discoveryTimer = null;
$('discovery-search').addEventListener('input', () => {
    clearTimeout(discoveryTimer);
    discoveryTimer = setTimeout(loadDiscovery, 250);
});
$('discovery-category').addEventListener('change', loadDiscovery);

// ── Server settings: Discovery tab ───────────────────────────────────────────
async function loadDiscoverySection() {
    const server = servers.find((s) => s.id === currentServerId);
    if (!server) return;
    $('discovery-server-switch').classList.toggle('on', !!server.isPublic);

    // The node-level switch only exists for node admins.
    const isAdmin = session && (session.role === 'admin' || session.role === 'owner');
    $('node-discovery-wrap').hidden = !isAdmin;
    if (isAdmin) {
        try {
            nodeInfo = await GetNodeInfo();
            $('discovery-node-switch').classList.toggle('on', nodeInfo.discoveryEnabled !== false);
        } catch (err) {
            $('discovery-note').innerText = `Could not read node settings: ${errText(err)}`;
        }
    }
}

$('discovery-server-switch').addEventListener('click', async (e) => {
    const server = servers.find((s) => s.id === currentServerId);
    if (!server) return;
    const next = !server.isPublic;
    e.currentTarget.classList.toggle('on', next);
    try {
        await SetServerPublic(server.id, next);
        server.isPublic = next;
    } catch (err) {
        e.currentTarget.classList.toggle('on', !next);
        $('discovery-note').innerText = `Server update failed: ${errText(err)}`;
    }
});

$('discovery-node-switch').addEventListener('click', async (e) => {
    const next = !(nodeInfo && nodeInfo.discoveryEnabled !== false);
    e.currentTarget.classList.toggle('on', next);
    try {
        await SetNodeDiscovery(next);
        nodeInfo.discoveryEnabled = next;
        $('discovery-note').innerText = next
            ? 'Node is public — servers can appear in Discover.'
            : 'Node is private — discovery is off for everyone.';
    } catch (err) {
        e.currentTarget.classList.toggle('on', !next);
        $('discovery-note').innerText = `Node update failed: ${errText(err)}`;
    }
});

document.querySelectorAll('#settings-modal .settings-tab[data-tab]').forEach((el) => {
    el.addEventListener('click', () => {
        if (el.dataset.tab === 'discovery') loadDiscoverySection();
    });
});

// ── Header panels (pins / threads / inbox / notifications) ───────────────────
function closeHeaderPanels() {
    document.querySelectorAll('.header-panel').forEach((p) => { p.hidden = true; });
}

function toggleHeaderPanel(id) {
    const panel = $(id);
    const wasHidden = panel.hidden;
    closeHeaderPanels();
    panel.hidden = !wasHidden;
}

['btn-threads', 'btn-notifications', 'btn-pins', 'btn-inbox'].forEach((id) => {
    $(id).closest('.header-btn-wrap, .chat-header-actions').addEventListener('click', (e) => {
        if (e.target.closest('.header-panel')) e.stopPropagation();
    });
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('.chat-header-actions')) closeHeaderPanels();
});

async function renderPinsPanel() {
    const list = $('pins-list');
    if ($('pins-panel').hidden) return;
    if (!currentChannelId) { list.innerHTML = '<div class="panel-empty">No channel selected.</div>'; return; }
    list.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
        const pins = (await ListPins(currentChannelId)) || [];
        list.innerHTML = '';
        if (pins.length === 0) {
            list.innerHTML = '<div class="panel-empty">No pinned messages.</div>';
            return;
        }
        pins.forEach((m) => {
            const row = document.createElement('div');
            row.className = 'panel-item';
            row.innerHTML =
                `<div class="panel-item-head">${escapeHtml(m.authorName || 'Anonymous')}` +
                ` <span>${escapeHtml(formatTime(m.timestamp || 0))}</span></div>` +
                `<div class="panel-item-body">${escapeHtml(m.content || '')}</div>`;
            const unpin = document.createElement('button');
            unpin.className = 'btn btn-link panel-item-btn';
            unpin.innerText = 'Unpin';
            unpin.addEventListener('click', async () => {
                try {
                    await UnpinMessage(currentChannelId, m.id);
                    row.remove();
                    if (!list.children.length) {
                        list.innerHTML = '<div class="panel-empty">No pinned messages.</div>';
                    }
                } catch (err) {
                    hint(`Could not unpin: ${errText(err)}`, true);
                }
            });
            row.appendChild(unpin);
            list.appendChild(row);
        });
    } catch (err) {
        list.innerHTML = `<div class="messages-error">${escapeHtml(errText(err))}</div>`;
    }
}

$('btn-pins').addEventListener('click', () => {
    toggleHeaderPanel('pins-panel');
    renderPinsPanel();
});

$('btn-threads').addEventListener('click', async () => {
    toggleHeaderPanel('threads-panel');
    const list = $('threads-list');
    if ($('threads-panel').hidden) return;
    if (!currentChannelId) { list.innerHTML = '<div class="panel-empty">No channel selected.</div>'; return; }
    list.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
        const threads = (await ListThreads(currentChannelId)) || [];
        list.innerHTML = '';
        if (threads.length === 0) {
            list.innerHTML = '<div class="panel-empty">No threads in this channel.</div>';
            return;
        }
        threads.forEach((t) => {
            const row = document.createElement('div');
            row.className = 'panel-item';
            row.innerHTML =
                `<div class="panel-item-head">${escapeHtml(t.name || 'Thread')}` +
                ` <span>${t.messageCount || 0} msgs</span></div>`;
            list.appendChild(row);
        });
    } catch (err) {
        list.innerHTML = `<div class="messages-error">${escapeHtml(errText(err))}</div>`;
    }
});

$('btn-inbox').addEventListener('click', async () => {
    toggleHeaderPanel('inbox-panel');
    const list = $('inbox-list');
    if ($('inbox-panel').hidden) return;
    list.innerHTML = '<div class="panel-empty">Loading…</div>';
    try {
        const dms = (await ListDMs()) || [];
        list.innerHTML = '';
        if (dms.length === 0) {
            list.innerHTML = '<div class="panel-empty">No direct messages yet.</div>';
            return;
        }
        dms.forEach((d) => {
            const otherId  = (d.participants || []).find((p) => p !== (session && session.userId));
            const otherMem = members.find((m) => m.id === otherId);
            const last     = d.lastMessage;
            const name     = otherMem?.username || last?.authorName || 'Direct Message';
            const row = document.createElement('div');
            row.className = 'panel-item';
            row.innerHTML =
                `<div class="panel-item-head">${escapeHtml(name)}` +
                ` <span>${last ? escapeHtml(shortTime(last.timestamp || 0)) : ''}</span></div>` +
                `<div class="panel-item-body">${escapeHtml(last?.content || 'No messages yet')}</div>`;
            list.appendChild(row);
        });
    } catch (err) {
        list.innerHTML = `<div class="messages-error">${escapeHtml(errText(err))}</div>`;
    }
});

$('btn-notifications').addEventListener('click', () => {
    toggleHeaderPanel('notif-panel');
    if ($('notif-panel').hidden) return;
    myProfile.muted = myProfile.muted || { channels: [], servers: [] };
    $('notif-channel-mute').checked =
        !!currentChannelId && myProfile.muted.channels.includes(currentChannelId);
    $('notif-server-mute').checked =
        !!currentServerId && myProfile.muted.servers.includes(currentServerId);
});

$('notif-channel-mute').addEventListener('change', async (e) => {
    if (!currentChannelId) return;
    myProfile.muted = myProfile.muted || { channels: [], servers: [] };
    const idx = myProfile.muted.channels.indexOf(currentChannelId);
    if (e.target.checked && idx < 0) myProfile.muted.channels.push(currentChannelId);
    if (!e.target.checked && idx >= 0) myProfile.muted.channels.splice(idx, 1);
    renderChannels();
    await persist();
});

$('notif-server-mute').addEventListener('change', async (e) => {
    if (!currentServerId) return;
    myProfile.muted = myProfile.muted || { channels: [], servers: [] };
    const idx = myProfile.muted.servers.indexOf(currentServerId);
    if (e.target.checked && idx < 0) myProfile.muted.servers.push(currentServerId);
    if (!e.target.checked && idx >= 0) myProfile.muted.servers.splice(idx, 1);
    renderChannels();
    await persist();
});

// ── Help modal ───────────────────────────────────────────────────────────────
$('btn-help').addEventListener('click', () => {
    closeHeaderPanels();
    const line = $('help-node-line');
    if (line) {
        line.innerText = session && session.domain
            ? `Connected to ${session.domain}`
            : 'Not connected to a node.';
    }
    $('help-modal').hidden = false;
});
$('btn-close-help').addEventListener('click', () => { $('help-modal').hidden = true; });

// ── Bot discovery ────────────────────────────────────────────────────────────
async function loadBots() {
    const results = $('bots-results');
    results.innerHTML = '<div class="messages-empty">Loading…</div>';
    try {
        const bots = (await ListBots()) || [];
        if (bots.length === 0) {
            results.innerHTML =
                '<div class="messages-empty">No MeshCord Bots are registered on this node yet.</div>';
            return;
        }
        const isAdmin = session && (session.role === 'admin' || session.role === 'owner');
        results.innerHTML = '';
        bots.forEach((b) => {
            const card = document.createElement('div');
            card.className = 'discovery-card';
            card.appendChild(avatarEl(b.name, b.avatarColor || '#5865f2', 40));
            const body = document.createElement('div');
            body.className = 'discovery-card-body';
            body.innerHTML =
                `<div class="discovery-name">${escapeHtml(b.name)}` +
                ` <span class="bot-tag">BOT</span></div>` +
                `<div class="discovery-desc">${escapeHtml(b.description || 'A MeshCord Lua bot')}</div>` +
                `<div class="discovery-meta">` +
                `<span class="bot-status ${b.online ? 'online' : 'offline'}"></span>` +
                `${b.online ? 'Online' : 'Offline'} · Lua bot</div>`;
            card.appendChild(body);

            if (isAdmin && servers.length > 0) {
                const picker = document.createElement('select');
                picker.className = 'field-input field-select bot-picker';
                picker.innerHTML =
                    '<option value="">Add to server…</option>' +
                    servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
                picker.addEventListener('change', async () => {
                    if (!picker.value) return;
                    try {
                        await AddBotToServer(b.id, picker.value);
                        hint(`${b.name} added.`);
                    } catch (err) {
                        hint(`Could not add bot: ${errText(err)}`, true);
                    }
                    picker.value = '';
                });
                card.appendChild(picker);
            }
            results.appendChild(card);
        });
    } catch (err) {
        results.innerHTML = `<div class="messages-error">${escapeHtml(errText(err))}</div>`;
    }
}

$('btn-bots').addEventListener('click', () => {
    if (!session.domain) { hint('Connect to a server first.', true); return; }
    $('bots-modal').hidden = false;
    loadBots();
});
$('btn-close-bots').addEventListener('click', () => { $('bots-modal').hidden = true; });

// ── Message search (server-side on Enter, live filter while typing) ──────────
const searchBox = $('message-search');
if (searchBox) {
    searchBox.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter' || !currentChannelId) return;
        const q = searchBox.value.trim();
        if (!q) { await loadMessages(channels.find((c) => c.id === currentChannelId)); return; }
        clearMessages();
        try {
            const found = (await SearchChannel(currentChannelId, q)) || [];
            const banner = document.createElement('div');
            banner.className = 'search-banner';
            banner.innerHTML = `${found.length} result${found.length === 1 ? '' : 's'} for ` +
                `“${escapeHtml(q)}” — clear the box to go back`;
            messageList.appendChild(banner);
            found.forEach(appendMessage);
        } catch (err) {
            hint(`Search failed: ${errText(err)}`, true);
            await loadMessages(channels.find((c) => c.id === currentChannelId));
        }
    });
}

// ── Activity + ping ──────────────────────────────────────────────────────────
setInterval(async () => {
    try {
        const activity = await DetectActivity();
        const el = $('current-activity');
        if (!el) return;
        if (activity && activity.name) {
            el.innerText = `${activity.type} ${activity.name}`;
            el.dataset.live = '1';
        } else {
            el.innerText = myProfile.customStatus || 'Online';
            delete el.dataset.live;
        }
    } catch {
        /* backend not ready yet */
    }
}, 5000);

setInterval(async () => {
    if (!pingDisplay) return;
    if (realtimeStatus !== 'connected') return; // status handler owns the label
    try {
        const ms = await PingServer();
        pingDisplay.innerText = `${ms}ms`;
        pingDisplay.style.color =
            ms < 100 ? 'var(--green)' : ms < 300 ? 'var(--yellow)' : 'var(--red)';
    } catch {
        pingDisplay.innerText = 'offline';
        pingDisplay.style.color = 'var(--red)';
    }
}, 5000);

// ── Boot ─────────────────────────────────────────────────────────────────────
async function startSession() {
    try {
        await StartRealtime();
    } catch (err) {
        console.error('Realtime did not start:', err);
    }
    try {
        nodeInfo = await GetNodeInfo();
        const nodeRole = nodeInfo?.me?.role || nodeInfo?.role;
        if (nodeRole && session) session.role = nodeRole;
    } catch (err) {
        console.error('Node info unavailable:', err);
        nodeInfo = null;
    }
    try {
        const me = await GetMyProfile();
        if (me) {
            myProfile.username     = me.username     || myProfile.username;
            myProfile.customStatus = me.customStatus ?? myProfile.customStatus;
            myProfile.avatarColor  = me.avatarColor  || myProfile.avatarColor;
            myProfile.avatarUrl    = me.avatarUrl    ?? myProfile.avatarUrl;
            myProfile.pronouns     = me.pronouns     ?? myProfile.pronouns;
            myProfile.decoration   = me.decoration   ?? myProfile.decoration;
            myProfile.about        = me.about        ?? myProfile.about;
            myProfile.status       = me.status       || myProfile.status;
            myProfile.meshId       = me.meshId       || myProfile.meshId;
            applyProfileToUI();
        }
    } catch (err) {
        console.debug('Profile sync skipped:', err);
    }
    applySelfBadge();
    await loadServers();

    // Admins landing on a node with zero servers get the setup wizard — the
    // same step-3 onboarding flow, reachable again until they create or skip.
    if (session && (session.role === 'admin' || session.role === 'owner')
            && servers.length === 0 && !setupWizardDismissed) {
        onboardingModal.hidden = false;
        $('onboard-step-1').hidden = true;
        $('onboard-step-2').hidden = true;
        showSetupWizard();
    }
}

// Admin identity lives on the profile card only — the bottom-left panel
// stays clean (it was squeezing the username). This is now a no-op kept for
// the call site in startSession.
function applySelfBadge() {}

// ── Desktop update check ──────────────────────────────────────────────────────
// Compares the running build against the Gitea release feed and reveals the
// Update button in the titlebar only when a newer version exists.
async function checkForUpdate() {
    try {
        const info = await CheckForUpdate();
        if (info && info.updateAvailable) {
            $('btn-update').hidden = false;
            $('btn-update').dataset.tooltip = `Update to ${info.latestVersion}`;
        }
    } catch (err) {
        console.error('Update check failed:', err);
    }
}

$('btn-update').addEventListener('click', async () => {
    const btn = $('btn-update');
    const tip = btn.dataset.tooltip;
    try {
        btn.disabled = true;
        btn.dataset.tooltip = 'Updating…';
        await DownloadUpdate();
        await notify('Update downloaded — MeshCord will relaunch to finish installing.');
    } catch (err) {
        await notify(`Update failed: ${errText(err)}`);
        btn.disabled = false;
        btn.dataset.tooltip = tip || 'Update Available';
    }
});

async function boot() {
    setChannelHeader(null);
    syncMemberList();
    renderVoiceUI();
    checkForUpdate();
    await loadState();

    try {
        session = await GetSession();
    } catch {
        session = { domain: '' };
    }

    if (!session || !session.domain) {
        showOnboarding();
        return;
    }
    if (session.username) myProfile.username = session.username;
    if (session.meshId)   myProfile.meshId = session.meshId;
    applyProfileToUI();
    await startSession();
}

boot();

// ════════════════════════════════════════════════════════════════════════════
// Toast notifications (bottom-right) + context menus + mention autocomplete
// ════════════════════════════════════════════════════════════════════════════

function toast(title, body, ms = 4500) {
    const wrap = $('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML =
        `<div class="toast-title">${escapeHtml(title)}</div>` +
        (body ? `<div class="toast-body">${escapeHtml(body)}</div>` : '');
    el.addEventListener('click', () => el.remove());
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('toast-out'); setTimeout(() => el.remove(), 200); }, ms);
}

// ── Context menu shell ───────────────────────────────────────────────────────
let ctxSubTimer = null;

function closeCtx() {
    const m = $('ctx-menu'), s = $('ctx-submenu');
    if (m) m.hidden = true;
    if (s) s.hidden = true;
}

function ctxItem(iconName, label, onClick, opts = {}) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (opts.danger ? ' danger' : '') + (opts.sub ? ' has-sub' : '');
    el.innerHTML =
        `<span class="ctx-ico icon-slot" data-icon="${iconName || 'blank'}" data-size="16"></span>` +
        `<span class="ctx-label">${escapeHtml(label)}</span>` +
        (opts.sub ? '<span class="ctx-caret">›</span>' : '');
    if (opts.sub) {
        el.addEventListener('mouseenter', () => showCtxSub(el, opts.sub));
        el.addEventListener('mouseleave', () => {
            ctxSubTimer = setTimeout(() => { const s = $('ctx-submenu'); if (s) s.hidden = true; }, 120);
        });
    } else {
        el.addEventListener('click', async () => {
            closeCtx();
            try { await onClick(); } catch (err) { toast('Error', errText(err)); }
        });
    }
    return el;
}

function ctxDivider() {
    const d = document.createElement('div');
    d.className = 'ctx-divider';
    return d;
}

function ctxSubItem(label, onClick, checked = false) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (checked ? ' checked' : '');
    el.innerHTML = `<span class="ctx-label">${escapeHtml(label)}</span>`;
    el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await onClick(); } catch (err) { toast('Error', errText(err)); }
        closeCtx();
    });
    return el;
}

function showCtxSub(anchor, items) {
    clearTimeout(ctxSubTimer);
    const sub = $('ctx-submenu');
    if (!sub) return;
    if (!sub.dataset.hoverWired) {
        sub.addEventListener('mouseenter', () => clearTimeout(ctxSubTimer));
        sub.addEventListener('mouseleave', () => {
            ctxSubTimer = setTimeout(() => { sub.hidden = true; }, 120);
        });
        sub.dataset.hoverWired = '1';
    }
    sub.innerHTML = '';
    items.forEach((it) => sub.appendChild(it));
    paintIcons(sub);
    sub.hidden = false;
    const r = anchor.getBoundingClientRect();
    const subR = sub.getBoundingClientRect();
    let x = r.right + 2;
    if (x + subR.width > window.innerWidth) x = r.left - subR.width - 2;
    sub.style.left = x + 'px';
    sub.style.top  = Math.min(r.top, window.innerHeight - subR.height - 8) + 'px';
}

function openCtx(x, y, build) {
    const menu = $('ctx-menu');
    if (!menu) return;
    menu.innerHTML = '';
    build(menu);
    paintIcons(menu);
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

['click', 'contextmenu', 'wheel', 'resize'].forEach((ev) =>
    document.addEventListener(ev, (e) => {
        if (e.type === 'contextmenu' && e.target.closest('.ctx-menu')) return;
        closeCtx();
    }, true)
);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });

// ── Message context menu ─────────────────────────────────────────────────────
const QUICK_EMOJI  = ['😀', '👋', '❤️', '👍'];
const MORE_EMOJI   = ['😀','😂','🤣','😊','😍','🤔','👍','👎','❤️','🔥','🎉','👀','😢','😮','🙏','💯'];

const unreadChannels = new Set();

function reactTo(msgId, emoji) {
    return ToggleReaction(currentChannelId, msgId, emoji);
}

function openMessageCtxMenu(e, msg) {
    openCtx(e.clientX, e.clientY, (menu) => {
        // Quick-reaction row, Discord-style
        const row = document.createElement('div');
        row.className = 'ctx-emoji-row';
        QUICK_EMOJI.forEach((em) => {
            const b = document.createElement('button');
            b.className = 'ctx-emoji';
            b.innerText = em;
            b.addEventListener('click', async () => {
                closeCtx();
                try { await reactTo(msg.id, em); } catch (err) { toast('Error', errText(err)); }
            });
            row.appendChild(b);
        });
        menu.appendChild(row);
        menu.appendChild(ctxItem('emoji', 'Add Reaction', null, {
            sub: MORE_EMOJI.map((em) => ctxSubItem(em, () => reactTo(msg.id, em))),
        }));
        menu.appendChild(ctxDivider());

        menu.appendChild(ctxItem('arrowRight', 'Reply', () => startReply(msg)));
        menu.appendChild(ctxItem('arrowRight', 'Forward', null, {
            sub: channels
                .filter((c) => c.type === 'text' && c.id !== currentChannelId)
                .slice(0, 10)
                .map((c) => ctxSubItem(`#${c.name}`, async () => {
                    await SendChatMessage(c.id,
                        `*(Forwarded from @${msg.authorName})* ${msg.content}`,
                        myProfile.username, myProfile.avatarColor);
                    toast('Forwarded', `Sent to #${c.name}`);
                })),
        }));
        menu.appendChild(ctxItem('idCard', 'Copy Text', () =>
            navigator.clipboard?.writeText(msg.content || '')));
        menu.appendChild(ctxItem('pin', 'Pin Message', () =>
            PinMessage(currentChannelId, msg.id)));
        menu.appendChild(ctxItem('bell', 'Mark Unread', () => {
            unreadChannels.add(currentChannelId);
            renderChannels();
        }));
        menu.appendChild(ctxItem('idCard', 'Copy Message Link', () =>
            navigator.clipboard?.writeText(
                `meshcord://${currentServerId}/${currentChannelId}/${msg.id}`)));
        menu.appendChild(ctxItem('speaker', 'Speak Message', () => {
            const u = new SpeechSynthesisUtterance(
                `${msg.authorName || 'Someone'} said ${msg.content || ''}`);
            speechSynthesis.cancel();
            speechSynthesis.speak(u);
        }));
        menu.appendChild(ctxDivider());

        const mine = msg.authorName === (session?.username || myProfile.username);
        const staff = session && (session.role === 'admin' || session.role === 'moderator');
        if (mine) {
            menu.appendChild(ctxItem('edit', 'Edit Message', async () => {
                const text = await askText('Edit Message', 'Message', msg.content || '');
                if (!text || text === msg.content) return;
                await EditChatMessage(currentChannelId, msg.id, text);
                msg.content = text; msg.edited = true;
                const rowEl = messageList.querySelector(`[data-msg-id="${msg.id}"] .message-content`);
                if (rowEl) {
                    rowEl.innerHTML = renderMentionedContent(text);
                    const ed = document.createElement('span');
                    ed.className = 'message-edited'; ed.innerText = '(edited)';
                    rowEl.appendChild(ed);
                }
            }));
        }
        if (mine || staff) {
            menu.appendChild(ctxItem('trash', 'Delete Message', async () => {
                if (!(await askConfirm('Delete this message?', 'Delete Message'))) return;
                await DeleteChatMessage(currentChannelId, msg.id);
                messageList.querySelector(`[data-msg-id="${msg.id}"]`)?.remove();
            }, { danger: true }));
        }
        if (!mine) {
            menu.appendChild(ctxItem('bell', 'Report Message', async () => {
                const reason = await askText('Report Message', 'Why are you reporting this?');
                if (reason === null) return;
                await ReportMessage(currentServerId, currentChannelId, msg.id, reason || 'No reason given');
                toast('Report sent', 'Node staff will review it.');
            }, { danger: true }));
        }
        menu.appendChild(ctxDivider());
        menu.appendChild(ctxItem('idCard', 'Copy Message ID', () =>
            navigator.clipboard?.writeText(msg.id || '')));
    });
}

messageList?.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.message');
    if (!row || !row.dataset.msgId) return;
    const msg = msgIndex.get(row.dataset.msgId);
    if (!msg) return;
    e.preventDefault();
    openMessageCtxMenu(e, msg);
});

// ── User context menu ────────────────────────────────────────────────────────
function openUserCtxMenu(e, m) {
    if (!m) return;
    const me    = session?.username || myProfile.username;
    const isMe  = m.username === me;
    const staff = session && (session.role === 'admin' || session.role === 'moderator');
    const assignableRoles = (roles || []).filter((r) => r.name !== '@everyone');

    openCtx(e.clientX, e.clientY, (menu) => {
        menu.appendChild(ctxItem('idCard', 'Profile', () => openMemberCard(m)));
        if (!isMe) {
            menu.appendChild(ctxItem('hash', 'Mention', () => {
                if (chatInput) { chatInput.value += `@${m.username} `; chatInput.focus(); }
            }));
            menu.appendChild(ctxItem('inbox', 'Message', async () => {
                await OpenDm(m.username);
                const inboxBtn = $('btn-inbox');
                if (inboxBtn && $('inbox-panel')?.hidden) inboxBtn.click();
                toast('Direct Message', `DM with @${m.username} is in your Inbox`);
            }));
            menu.appendChild(ctxItem('speaker', 'Start a Call', () =>
                toast('Private Calls', 'Voice calls with members are coming soon.')));
            menu.appendChild(ctxDivider());
            menu.appendChild(ctxItem('plusCircle', 'Add Friend', async () => {
                myProfile.friends = myProfile.friends || [];
                if (!myProfile.friends.includes(m.username)) {
                    myProfile.friends.push(m.username);
                    await persist();
                }
                toast('Friend added', `@${m.username} is in your friends list`);
            }));
            menu.appendChild(ctxItem('bell', isIgnoredAuthor(m.username) ? 'Unignore' : 'Ignore',
                async () => {
                    myProfile.ignored = myProfile.ignored || [];
                    const i = myProfile.ignored.indexOf(m.username);
                    if (i >= 0) myProfile.ignored.splice(i, 1);
                    else myProfile.ignored.push(m.username);
                    await persist();
                    toast(i >= 0 ? 'Unignored' : 'Ignored', `@${m.username}`);
                }));
            menu.appendChild(ctxItem('close', isBlockedAuthor(m.username) ? 'Unblock' : 'Block',
                async () => {
                    myProfile.blocked = myProfile.blocked || [];
                    const i = myProfile.blocked.indexOf(m.username);
                    if (i >= 0) myProfile.blocked.splice(i, 1);
                    else myProfile.blocked.push(m.username);
                    await persist();
                    toast(i >= 0 ? 'Unblocked' : 'Blocked', `@${m.username}`);
                }, { danger: true }));
        }

        if (staff && !isMe) {
            menu.appendChild(ctxDivider());
            menu.appendChild(ctxItem('edit', 'Add Note', async () => {
                const note = await askText('Add Note', `Note for @${m.username} (staff only)`);
                if (!note) return;
                await AddAdminNote(m.username, currentServerId, note);
                toast('Note saved', `Note added to @${m.username}`);
            }));
            if (assignableRoles.length) {
                menu.appendChild(ctxItem('idCard', 'Role', null, {
                    sub: assignableRoles.map((r) => ctxSubItem(r.name, async () => {
                        m.roleIds = m.roleIds || [];
                        const i = m.roleIds.indexOf(r.id);
                        if (i >= 0) m.roleIds.splice(i, 1); else m.roleIds.push(r.id);
                        await SetMemberRoles(currentServerId, m.id, m.roleIds);
                        toast('Roles updated', `@${m.username}`);
                    }, (m.roleIds || []).includes(r.id))),
                }));
            }
            menu.appendChild(ctxItem('micOff', `Timeout ${m.username}`, null, {
                danger: true,
                sub: [
                    ['60 seconds', 60000], ['5 minutes', 300000], ['10 minutes', 600000],
                    ['1 hour', 3600000], ['1 day', 86400000], ['1 week', 604800000],
                ].map(([label, ms]) => ctxSubItem(label, async () => {
                    await TimeoutMember(currentServerId, m.id, ms);
                    toast('Timed out', `@${m.username} — ${label}`);
                })),
            }));
            menu.appendChild(ctxItem('disconnect', `Kick ${m.username}`, async () => {
                if (!(await askConfirm(`Kick @${m.username} from this server?`, 'Kick Member'))) return;
                await KickMember(currentServerId, m.id);
                await loadMembers(currentServerId);
                toast('Kicked', `@${m.username} was removed`);
            }, { danger: true }));
            menu.appendChild(ctxItem('close', `Ban ${m.username}`, async () => {
                const reason = await askText('Ban Member', `Reason for banning @${m.username}`);
                if (reason === null) return;
                if (!(await askConfirm(`Permanently ban @${m.username}?`, 'Ban Member'))) return;
                await BanMember(currentServerId, m.id, reason || 'Banned');
                await loadMembers(currentServerId);
                toast('Banned', `@${m.username} was banned`);
            }, { danger: true }));
        }

        menu.appendChild(ctxDivider());
        menu.appendChild(ctxItem('idCard', 'Copy User ID', () =>
            navigator.clipboard?.writeText(m.id || '')));
    });
}

memberListEl?.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.member-row');
    if (!row || !row.dataset.userId) return;
    const m = members.find((x) => x.id === row.dataset.userId);
    if (!m) return;
    e.preventDefault();
    openUserCtxMenu(e, m);
});

// Right-clicking an author's name in a message opens the same user menu.
messageList?.addEventListener('contextmenu', (e) => {
    const author = e.target.closest('.message-author');
    if (!author) return;
    const m = members.find((x) => x.username === author.dataset.author);
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    openUserCtxMenu(e, m);
}, true);

// ── Mentions ─────────────────────────────────────────────────────────────────
// Toast when somebody pings you in a channel you can see.
function maybeToastMention(data) {
    const msg = data.message;
    if (!msg || !msg.content) return;
    const me = (session?.username || myProfile.username || '').toLowerCase();
    if (!me || msg.authorName === session?.username) return;
    const text = msg.content.toLowerCase();
    const mentioned = text.includes(`@${me}`) || text.includes('@everyone');
    if (!mentioned) return;
    if (isBlockedAuthor(msg.authorName) || isIgnoredAuthor(msg.authorName)) return;
    if ((myProfile.muted?.channels || []).includes(data.channelId)) return;
    if ((myProfile.muted?.servers || []).includes(msg.serverId)) return;
    const ch = channels.find((c) => c.id === data.channelId);
    toast(`Mentioned in #${ch?.name || 'a channel'}`,
        `${msg.authorName}: ${msg.content.slice(0, 120)}`);
}

// Composer @-autocomplete
let mentionAnchor = -1;
function refreshMentionSuggest() {
    const box = $('mention-suggest');
    if (!box || !chatInput) return;
    const caret = chatInput.selectionStart;
    const before = chatInput.value.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1 || /\s/.test(before.slice(at + 1)) ) { box.hidden = true; mentionAnchor = -1; return; }
    const q = before.slice(at + 1).toLowerCase();
    const hits = members.filter((m) => m.username.toLowerCase().startsWith(q)).slice(0, 8);
    if (!hits.length) { box.hidden = true; return; }
    mentionAnchor = at;
    box.innerHTML = '';
    hits.forEach((m) => {
        const item = document.createElement('div');
        item.className = 'mention-item';
        item.innerHTML =
            `<span class="mention-name">${escapeHtml(m.username)}</span>` +
            (m.isBot ? '<span class="bot-tag">BOT</span>' : '');
        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            chatInput.value = chatInput.value.slice(0, mentionAnchor) +
                `@${m.username} ` + chatInput.value.slice(caret);
            box.hidden = true; mentionAnchor = -1;
            chatInput.focus();
        });
        box.appendChild(item);
    });
    box.hidden = false;
}
chatInput?.addEventListener('input', refreshMentionSuggest);
chatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const b = $('mention-suggest'); if (b) b.hidden = true; }
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('#mention-suggest') && e.target !== chatInput) {
        const b = $('mention-suggest'); if (b) b.hidden = true;
    }
});
