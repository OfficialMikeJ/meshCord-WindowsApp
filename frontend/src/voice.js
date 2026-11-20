// ─────────────────────────────────────────────────────────────────────────────
//  Voice — full peer-to-peer mesh over WebRTC.
//
//  The node only relays signalling (see server/src/websocket/handler.js); audio
//  flows directly between clients, which is the point of a mesh network. Each
//  participant holds one RTCPeerConnection per other participant, so a room of
//  N people costs N-1 connections each — fine for the small rooms this is for,
//  and the reason there is no SFU here.
//
//  Offer/answer roles are unambiguous by construction: whoever joins last
//  offers to everyone already in the room, and sitting members only ever
//  answer. That removes glare without a tie-break rule.
//
//  Signalling frames are written straight onto the Go realtime socket via
//  SendRealtime(); inbound frames arrive through main.js and are handed to
//  handleFrame() below.
// ─────────────────────────────────────────────────────────────────────────────

import { SendRealtime } from '../wailsjs/go/main/App';

// Public STUN only. Peers behind symmetric NAT will fail to connect without a
// TURN relay — add one here if that becomes a problem.
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];

const AUDIO_CONSTRAINTS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
};

const state = {
    myClientId: null,
    channelId:  null,   // voice channel we are in, null when disconnected
    stream:     null,   // local mic stream
    peers:      new Map(), // clientId → { pc, audio, user }
    muted:      false,
    deafened:   false,
    connecting: false,
};

const listeners = new Set();

// Fired whenever anything the UI renders has changed.
function emitChange() {
    listeners.forEach((fn) => {
        try { fn(); } catch (err) { console.error('[voice] listener failed:', err); }
    });
}

export function onChange(fn) { listeners.add(fn); }

export function setClientId(id) { state.myClientId = id; }
export function myClientId()    { return state.myClientId; }
export function currentChannel() { return state.channelId; }
export function isConnected()    { return state.channelId !== null; }
export function isMuted()        { return state.muted; }
export function isDeafened()     { return state.deafened; }
export function peerCount()      { return state.peers.size; }

function sendFrame(type, data) {
    try {
        return SendRealtime(JSON.stringify({ type, data: data || {} }));
    } catch (err) {
        console.error('[voice] could not send %s:', type, err);
        return Promise.resolve();
    }
}

// ── Peer connections ─────────────────────────────────────────────────────────

function createPeer(clientId, user, initiator) {
    if (state.peers.has(clientId)) return state.peers.get(clientId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // One hidden <audio> per peer; remote tracks are attached to it.
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = state.deafened;
    document.body.appendChild(audio);

    const entry = { pc, audio, user: user || { clientId, username: 'Unknown' } };
    state.peers.set(clientId, entry);

    if (state.stream) {
        state.stream.getTracks().forEach((track) => pc.addTrack(track, state.stream));
    }

    pc.ontrack = (ev) => {
        audio.srcObject = ev.streams[0];
        emitChange();
    };

    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            sendFrame('voice.signal', {
                toClientId: clientId,
                signal: { type: 'candidate', candidate: ev.candidate.toJSON() },
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            destroyPeer(clientId);
        }
        emitChange();
    };

    if (initiator) {
        // Negotiation is one-shot: the joiner offers once per sitting peer.
        pc.createOffer()
            .then((offer) => pc.setLocalDescription(offer).then(() => offer))
            .then((offer) => sendFrame('voice.signal', {
                toClientId: clientId,
                signal: { type: 'offer', sdp: offer.sdp },
            }))
            .catch((err) => console.error('[voice] offer failed:', err));
    }

    emitChange();
    return entry;
}

function destroyPeer(clientId) {
    const entry = state.peers.get(clientId);
    if (!entry) return;
    try { entry.pc.close(); } catch { /* already closed */ }
    entry.audio.srcObject = null;
    entry.audio.remove();
    state.peers.delete(clientId);
    emitChange();
}

function destroyAllPeers() {
    [...state.peers.keys()].forEach(destroyPeer);
}

// ── Join / leave ─────────────────────────────────────────────────────────────

export async function join(channelId) {
    if (state.channelId === channelId || state.connecting) return;
    state.connecting = true;
    emitChange();

    try {
        if (!state.stream) {
            state.stream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
            applyMicState();
        }
    } catch (err) {
        state.connecting = false;
        emitChange();
        throw new Error(
            'Microphone unavailable — grant microphone access to use voice. ' +
            `(${err && err.name ? err.name : err})`,
        );
    }

    // Switching rooms: tear the old mesh down first.
    if (state.channelId) {
        destroyAllPeers();
        await sendFrame('voice.leave', {});
    }

    state.channelId = channelId;
    state.connecting = false;
    await sendFrame('voice.join', { channelId });
    emitChange();
}

export async function leave() {
    if (!state.channelId) return;
    state.channelId = null;
    destroyAllPeers();

    if (state.stream) {
        state.stream.getTracks().forEach((t) => t.stop());
        state.stream = null;
    }
    await sendFrame('voice.leave', {});
    emitChange();
}

// ── Mute / deafen ────────────────────────────────────────────────────────────

function applyMicState() {
    if (!state.stream) return;
    // Deafening implies muting, as in Discord.
    const live = !state.muted && !state.deafened;
    state.stream.getAudioTracks().forEach((t) => { t.enabled = live; });
}

export function toggleMute() {
    state.muted = !state.muted;
    if (!state.muted) state.deafened = false;
    applyMicState();
    applyDeafenState();
    emitChange();
}

function applyDeafenState() {
    state.peers.forEach((p) => { p.audio.muted = state.deafened; });
}

export function toggleDeafen() {
    state.deafened = !state.deafened;
    applyMicState();
    applyDeafenState();
    emitChange();
}

// ── Inbound signalling ───────────────────────────────────────────────────────
// Returns true when the frame was a voice frame (so main.js can stop there).

export function handleFrame(frame) {
    const data = frame.data || {};

    switch (frame.type) {
        // Sent only to the joiner: everyone already sitting in the room.
        case 'voice.peers':
            if (data.channelId !== state.channelId) return true;
            (data.peers || []).forEach((peer) => {
                if (peer.clientId !== state.myClientId) createPeer(peer.clientId, peer, true);
            });
            return true;

        // Broadcast to the whole server — used for sidebar occupancy. The new
        // arrival offers to us, so there is nothing to negotiate here.
        case 'voice.joined':
            return true;

        case 'voice.left':
            destroyPeer(data.clientId);
            return true;

        case 'voice.signal':
            handleSignal(data).catch((err) => console.error('[voice] signal failed:', err));
            return true;

        case 'voice.state':
            return true;

        default:
            return false;
    }
}

async function handleSignal({ fromClientId, signal }) {
    if (!fromClientId || !signal || !state.channelId) return;

    if (signal.type === 'offer') {
        const entry = createPeer(fromClientId, null, false);
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        await sendFrame('voice.signal', {
            toClientId: fromClientId,
            signal: { type: 'answer', sdp: answer.sdp },
        });
        return;
    }

    const entry = state.peers.get(fromClientId);
    if (!entry) return;

    if (signal.type === 'answer') {
        await entry.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    } else if (signal.type === 'candidate' && signal.candidate) {
        try {
            await entry.pc.addIceCandidate(signal.candidate);
        } catch (err) {
            // Candidates can arrive before the remote description is set.
            console.debug('[voice] ICE candidate dropped:', err.message);
        }
    }
}
