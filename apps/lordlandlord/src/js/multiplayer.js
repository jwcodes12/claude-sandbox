export const SYNCED_ACTION_TYPES = ['play', 'propose', 'react-no', 'concede', 'discard', 'end-turn', 'swap-wild'];

// ICE servers — STUN finds your public IP, TURN relays traffic when peers
// can't hole-punch (symmetric NAT, CGNAT mobile, UDP-blocked firewalls).
//
// The bundled default uses Google/Cloudflare STUN plus a best-effort
// shared TURN endpoint. The shared TURN can be flaky or rate-limited;
// for reliable cross-network play deploy with your own TURN by setting
// `window.LL_RTC_CONFIG = { iceServers: [...] }` in index.html before
// this module loads. Cheap options: free tier of Metered.ca (50 GB/mo),
// Cloudflare Calls TURN (1 TB/mo), Twilio NTS ($0.40/GB), self-hosted
// coturn. Data-channel traffic for this game is kilobytes per match —
// any of those will be effectively free.
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

function getRtcConfig() {
    const override = (typeof window !== 'undefined' && window.LL_RTC_CONFIG) || null;
    if (override && Array.isArray(override.iceServers) && override.iceServers.length) {
        return override;
    }
    return { iceServers: DEFAULT_ICE_SERVERS };
}

// Friendly-phrase wordlists. Three categories give us ~adj*noun*place combos
// (≈ 32k+) so collisions on the public broker are rare — and we retry on
// `unavailable-id` anyway. Words kept short and unambiguous over voice/text.
const PHRASE_ADJ = [
    'amber','azure','brave','bright','copper','crimson','dusty','eager','emerald',
    'fierce','frosty','gentle','gilded','golden','grumpy','happy','humble','iron',
    'jade','jolly','lazy','lively','lucky','merry','mighty','misty','noble','quiet',
    'rapid','rosy','royal','rusty','sable','silent','silver','sleepy','snowy',
    'stormy','swift','tame','velvet','wild','wise','wooly','young','zesty'
];
const PHRASE_NOUN = [
    'badger','bear','beaver','bison','boar','bull','crow','deer','dove','dragon',
    'duck','eagle','elk','falcon','ferret','fox','goose','hare','hawk','heron',
    'horse','hound','lion','lynx','mole','moose','newt','otter','owl','panther',
    'phoenix','quail','rabbit','raven','seal','shark','sparrow','stag','swan',
    'tiger','toad','trout','wolf','wren'
];
const PHRASE_PLACE = [
    'abbey','arch','bay','bluff','bog','bridge','brook','castle','cave','cliff',
    'cove','creek','crest','dale','dell','den','field','fjord','glade','glen',
    'grove','hall','harbor','heath','hill','hollow','isle','keep','lake','manor',
    'marsh','meadow','mill','moor','peak','pier','plain','pond','port','reach',
    'ridge','river','road','shore','spire','stone','tower','vale','well','wood'
];
function randomPhrase() {
    const pick = (a) => a[Math.floor(Math.random() * a.length)];
    return `${pick(PHRASE_ADJ)}-${pick(PHRASE_NOUN)}-${pick(PHRASE_PLACE)}`;
}
export function generateRealmId() { return randomPhrase(); }

export const Multiplayer = {
    peer: null,
    conns: new Map(),
    isHost: false,
    isClient: false,
    peerId: null,
    hostConn: null,

    onRemoteAction: null,
    onSnapshot: null,
    onPeerJoined: null,
    onPeerLeft: null,
    onLobbyUpdate: null,
    onHostLost: null,

    _outSeq: 0,
    // Per-origin highest seq seen; drop anything <= last to suppress dup/replay.
    _seenSeq: Object.create(null),

    init(onOpenCallback) {
        this._openCallback = onOpenCallback;
        this._claimAttempts = 0;
        
        // Try to resume existing session ID
        const savedId = localStorage.getItem('LL_PEER_ID');
        if (savedId) {
            console.log(`[MP] Attempting to resume session: ${savedId}`);
            this._claimPeer(savedId);
        } else {
            this._claimPeer(randomPhrase());
        }
    },

    _claimPeer(desiredId) {
        if (this.peer) {
            try { this.peer.destroy(); } catch (e) {}
        }
        this.peer = new Peer(desiredId, { config: getRtcConfig() });
        this.peerId = null;
        this.peer.on('open', (id) => {
            this.peerId = id;
            localStorage.setItem('LL_PEER_ID', id);
            if (this._openCallback) this._openCallback(id);
        });
        this.peer.on('error', (err) => {
            console.error('Peer error:', err);
            const type = err && err.type;
            
            // If saved ID is taken or invalid, fallback to random
            if (type === 'unavailable-id' || type === 'invalid-id') {
                localStorage.removeItem('LL_PEER_ID');
                this._claimAttempts = (this._claimAttempts || 0) + 1;
                if (this._claimAttempts < 8) {
                    this._claimPeer(randomPhrase());
                    return;
                }
            }
            const msg =
                type === 'peer-unavailable' ? 'Realm ID not found. Double-check the words and that the host is still online.' :
                type === 'network' ? 'Broker unreachable. Check your internet connection and try again.' :
                type === 'server-error' ? 'Signaling broker rejected the connection. Try again in a moment.' :
                type === 'browser-incompatible' ? 'Your browser blocks WebRTC connections.' :
                type === 'disconnected' ? 'Disconnected from the signaling broker. Reload to retry.' :
                type === 'unavailable-id' ? 'Could not claim a Realm ID after several attempts.' :
                null;
            if (msg && this.onPeerError) this.onPeerError(msg);
            if (type === 'peer-unavailable' && this.isClient) {
                this.isClient = false;
                this.hostConn = null;
                if (this.onHostLost) this.onHostLost(msg);
            }
        });
    },

    becomeHost(roomPass = '') {
        this.isHost = true;
        this.isClient = false;
        this.hostConn = null;
        this.roomPass = roomPass || '';
        this._setupHostListeners();
    },

    takeOverHost(newPass = '') {
        console.log(`[MP] TAKING OVER AS HOST. New Realm ID: ${this.peerId}`);
        this.isHost = true;
        this.isClient = false;
        this.hostConn = null;
        this.roomPass = newPass;
        this._setupHostListeners();
    },

    _setupHostListeners() {
        this.peer.on('connection', (conn) => {
            this._attachIceDiagnostics(conn, 'host');
            conn.on('open', () => {
                this._setupConn(conn);
            });
        });
    },

    joinHost(hostPeerId, roomPass = '', name = '') {
        this.isClient = true;
        this.isHost = false;

        const attempt = () => {
            const conn = this.peer.connect(hostPeerId, { reliable: true });
            this.hostConn = conn;
            this._attachIceDiagnostics(conn, 'join');
            // TURN allocation + ICE can take 10-20s on cross-network. Give it
            // 30s before declaring the join dead.
            const timeout = setTimeout(() => {
                if (conn.open) return;
                try { conn.close(); } catch (_) {}
                if (this.onPeerError) this.onPeerError('Join timed out. Host may be offline, ID is wrong, or NAT traversal failed (check console for ICE state).');
                if (this.onHostLost) this.onHostLost('Join timed out.');
            }, 30000);

            conn.on('open', () => {
                clearTimeout(timeout);
                this._setupConn(conn);
                conn.send({ type: 'hello', pass: roomPass || '', name: name || '' });
            });
            conn.on('error', (err) => {
                clearTimeout(timeout);
                console.error('Join error:', err);
                if (this.onPeerError) this.onPeerError('Could not reach the host.');
                if (this.onHostLost) this.onHostLost();
            });
        };

        // If the broker hasn't assigned us a peerId yet, calling
        // peer.connect() may silently no-op. Wait for 'open' first.
        if (this.peerId) {
            attempt();
        } else {
            this.peer.once('open', attempt);
        }
    },

    _setupConn(conn) {
        conn.on('data', (data) => this._handleData(data, conn));
        this._logIceCandidatePair(conn);
        conn.on('close', () => {
            this.conns.delete(conn.peer);
            if (this.isClient && conn === this.hostConn) {
                if (this.onHostLost) this.onHostLost();
            } else if (this.isHost) {
                if (this.onPeerLeft) this.onPeerLeft(conn.peer);
                if (this.onLobbyUpdate) this.onLobbyUpdate();
            }
        });
        conn.on('error', (err) => {
            console.error('Conn error:', err);
        });
    },

    _handleData(data, fromConn) {
        if (!data || !data.type) return;
        if (data.type === 'hello') {
            if (!this.isHost) return;
            const given = data.pass || '';
            if ((this.roomPass || '') !== given) {
                try { fromConn.send({ type: 'rejected', reason: 'Wrong Realm pass.' }); } catch (e) {}
                setTimeout(() => { try { fromConn.close(); } catch (e) {} }, 50);
                return;
            }
            this.conns.set(fromConn.peer, fromConn);
            fromConn.send({ type: 'admitted' });
            if (this.onPeerJoined) this.onPeerJoined(fromConn.peer, data.name || '');
            if (this.onLobbyUpdate) this.onLobbyUpdate();
            return;
        }
        if (data.type === 'rejected') {
            if (this.onRejected) this.onRejected(data.reason || 'Rejected.');
            return;
        }
        if (data.type === 'admitted') {
            if (this.isClient) this.conns.set(fromConn.peer, fromConn);
            return;
        }
        if (data.type === 'action-envelope') {
            this._handleEnvelope(data, fromConn);
            return;
        }
        if (data.type === 'snapshot') {
            if (this.onSnapshot) this.onSnapshot(data);
            return;
        }
    },

    _handleEnvelope(env, fromConn) {
        // Drop our own echo
        if (env.origin && env.origin === this.peerId) return;
        const key = env.origin || `pid:${env.playerId}`;
        const last = this._seenSeq[key] || 0;
        if (typeof env.seq === 'number' && env.seq <= last) return;
        if (typeof env.seq === 'number') this._seenSeq[key] = env.seq;

        // Host re-broadcasts to other clients
        if (this.isHost && fromConn) {
            for (const [pid, c] of this.conns) {
                if (c === fromConn) continue;
                if (c.open) c.send(env);
            }
        }

        if (this.onRemoteAction) this.onRemoteAction(env.action, env.playerId);
    },

    broadcast(payload) {
        if (this.isHost) {
            for (const c of this.conns.values()) {
                if (c.open) c.send(payload);
            }
        } else if (this.isClient && this.hostConn && this.hostConn.open) {
            this.hostConn.send(payload);
        }
    },

    broadcastAction(action, playerId) {
        console.log(`[NET-DEBUG] broadcastAction called by peer ${this.peerId} (player ${playerId}) for action:`, action.type);
        if (!action || !SYNCED_ACTION_TYPES.includes(action.type)) return;
        if (!this.isHost && !this.isClient) return;
        const envelope = {
            type: 'action-envelope',
            origin: this.peerId,
            playerId,
            seq: ++this._outSeq,
            ts: Date.now(),
            action
        };
        console.log(`[NET-DEBUG] Actually broadcasting envelope: seq=${envelope.seq}`);
        this.broadcast(envelope);
    },

    sendSnapshot(snapshot, toPeerId) {
        if (!this.isHost) return;
        const conn = this.conns.get(toPeerId);
        if (conn && conn.open) {
            conn.send({ type: 'snapshot', ...snapshot });
        }
    },

    isMultiplayer() {
        return this.isHost || this.isClient;
    },

    _attachIceDiagnostics(conn, label) {
        // peerConnection may not be wired up the instant peer.connect() returns;
        // poll briefly until it appears, then attach state listeners.
        let tries = 0;
        const wire = () => {
            const pc = conn && conn.peerConnection;
            if (!pc) {
                if (++tries < 40) setTimeout(wire, 50);
                return;
            }
            console.log(`[MP:${label}] pc ready, ice=${pc.iceConnectionState} gather=${pc.iceGatheringState}`);
            pc.addEventListener('icegatheringstatechange', () => {
                console.log(`[MP:${label}] gather -> ${pc.iceGatheringState}`);
            });
            pc.addEventListener('iceconnectionstatechange', () => {
                console.log(`[MP:${label}] ice -> ${pc.iceConnectionState}`);
            });
            pc.addEventListener('icecandidate', (e) => {
                if (!e.candidate) {
                    console.log(`[MP:${label}] candidate gathering complete`);
                    return;
                }
                const c = e.candidate;
                // candidate string: "candidate:foundation comp proto prio ip port typ TYPE ..."
                const typ = (c.candidate.match(/ typ (\w+)/) || [])[1] || '?';
                console.log(`[MP:${label}] candidate ${typ}/${c.protocol || '?'} ${c.address || ''}:${c.port || ''}`);
            });
        };
        wire();
    },

    async _logIceCandidatePair(conn) {
        const pc = conn && conn.peerConnection;
        if (!pc || typeof pc.getStats !== 'function') return;
        try {
            const stats = await pc.getStats();
            let pair = null, local = null, remote = null;
            stats.forEach((r) => {
                if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r;
            });
            if (!pair) return;
            stats.forEach((r) => {
                if (r.id === pair.localCandidateId) local = r;
                if (r.id === pair.remoteCandidateId) remote = r;
            });
            const fmt = (c) => c ? `${c.candidateType}/${c.protocol}` : '?';
            const usingTurn = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
            console.log(`[MP] ICE: local=${fmt(local)} remote=${fmt(remote)} ${usingTurn ? '(TURN relay)' : '(direct)'}`);
        } catch (e) {
            console.warn('[MP] getStats failed', e);
        }
    }
};
