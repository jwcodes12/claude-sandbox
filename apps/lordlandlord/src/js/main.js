import { generateDeck, CARD_TYPES, PROPERTIES } from './cards.js';
import { createRng } from './core/rng.js';
import { createInitialState, clone } from './core/state.js';
import { enumerateLegalActions as enumerateLegalActionsForState } from './core/legal.js';
import { createLocalGame } from './app/local-game.js';
import { createClient } from './net/client.js';
import { createWsSession } from './net/ws-transport.js';
import {
    gameState,
    initGameState,
    drawCardFromDeck,
    playCardToZone,
    endTurn as engineEndTurn,
    startTurn,
    enumerateLegalActions,
    executeAction,
    checkWinner,
    proposeAction,
    reactJustSayNo,
    resolvePendingAction,
    playerHasPendingReaction,
    swapWildColor
} from './engine.js';
import { render } from './render.js';
import { attachInput } from './input.js';
import { Multiplayer } from './multiplayer.js';
import { infoForCard, CARD_LIBRARY } from './card-info.js';

// In MP host mode, lobbyPeers tracks joined client peer IDs so we can
// assign playerIds at game-start and re-broadcast lobby UI.
let lobbyPeers = [];
let lobbyBots = []; // Stores { id: string, difficulty: string }
let inputAttached = false;
// Map peerId -> playerId, populated by host on start. Used by host to know
// which player slot an incoming action envelope from a peer belongs to.
let peerToPlayer = new Map();
let playerToPeer = new Map(); // Reverse map for migration
// peerId -> chosen Lord name, populated by host from inbound hello messages.
let peerNames = new Map();
let hostName = '';
let activeLocalGame = null;
// Third authority path (Step 6b): a WebSocket game against the real server
// writer. When set, ALL intents flow through client.submit and the local
// gameState is only ever a mirror of accepted state.
let activeNetGame = null;     // { session, client, seat } | null
let netSession = null;        // lazy singleton createWsSession
let netResuming = false;      // a stored session is being re-established (Step 7)
let netInfo = null;           // { roomId, seat, seatToken } from the last 'joined'
let viewMeta = {
    localPlayerId: 0,
    logOpen: false,
    isStressTest: false,
    actionLog: [],
};
let lastShownResolutionKey = null;
let lastShownWinnerId = null;

function isSoloControllerActive() {
    return activeLocalGame !== null && !Multiplayer.isHost && !Multiplayer.isClient;
}

function withViewMeta(state) {
    const view = clone(state);
    view.localPlayerId = viewMeta.localPlayerId;
    view._logOpen = viewMeta.logOpen;
    view._isStressTest = viewMeta.isStressTest;
    view.actionLog = viewMeta.actionLog;
    view._gameOver = view.winner != null;
    return view;
}

function syncGameStateFromController() {
    if (!activeLocalGame) return gameState;
    const view = withViewMeta(activeLocalGame.peek());
    for (const key of Object.keys(gameState)) delete gameState[key];
    Object.assign(gameState, view);
    return gameState;
}

// Net mirror: overwrite the legacy global gameState with the net client's
// authoritative state + view metadata, exactly like syncGameStateFromController
// does for solo, so the render/input/engine-global paths keep working.
function syncGameStateFromNet() {
    if (!activeNetGame) return gameState;
    const view = withViewMeta(activeNetGame.client.getState());
    for (const key of Object.keys(gameState)) delete gameState[key];
    Object.assign(gameState, view);
    return gameState;
}

function currentState() {
    if (activeNetGame) return syncGameStateFromNet();
    return activeLocalGame ? syncGameStateFromController() : gameState;
}

function publicState() {
    if (activeNetGame) return withViewMeta(activeNetGame.client.getState());
    return activeLocalGame ? withViewMeta(activeLocalGame.getState()) : gameState;
}

function legalActionsFor(playerId, state = null) {
    if (activeNetGame) return enumerateLegalActionsForState(state || activeNetGame.client.getState(), playerId);
    if (activeLocalGame) return enumerateLegalActionsForState(state || activeLocalGame.peek(), playerId);
    return enumerateLegalActions(playerId);
}

function init() {
    // Multiplayer (PeerJS) is no longer wired up here — the lobby now runs on
    // the WebSocket game server (net/ws-transport.js). multiplayer.js itself
    // is removed in Step 8.

    injectSoloButton();

    document.getElementById('btn-copy-id').onclick = () => {
        if (netInfo) navigator.clipboard.writeText(netShareLink(netInfo.roomId));
    };

    document.getElementById('btn-create-game').onclick = onCreateRealm;
    document.getElementById('btn-join-game').onclick = onJoinRealm;
    document.getElementById('btn-leave-lobby').onclick = leaveLobby;
    document.getElementById('btn-start-game').onclick = () => {
        if (netSession && netInfo && netInfo.seat === 0) netSession.start();
    };
    document.getElementById('btn-close-modal').onclick = closeModal;

    const addBotBtn = document.getElementById('btn-add-bot');
    if (addBotBtn) {
        addBotBtn.style.display = '';
        addBotBtn.onclick = () => { if (netSession) netSession.addBot(); };
    }

    // Share-link entry: ?room=<id> prefills the join form so the invitee only
    // types a name and marches forth.
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam) {
        const joinInput = document.getElementById('join-game-id');
        if (joinInput) joinInput.value = roomParam;
        const nameInput = document.getElementById('player-name-join');
        if (nameInput) nameInput.focus();
    }

    // Step 7: refresh mid-session? Rebind the stored seat straight away.
    tryResumeStoredSession();
}

// ---- WebSocket lobby / game wiring (Step 6b) -------------------------------

// Step 7: the current room/seat/token survives page refresh in localStorage so
// a reload lands straight back in the same seat via {t:'rejoin'} + Resume.
const NET_SESSION_KEY = 'll-session';

function saveNetSession() {
    if (!netInfo) return;
    try {
        localStorage.setItem(NET_SESSION_KEY, JSON.stringify({
            roomId: netInfo.roomId,
            seat: netInfo.seat,
            seatToken: netInfo.seatToken,
            ws: wsUrl()
        }));
    } catch (_e) { /* private mode etc. — refresh-resume just won't work */ }
}

function loadNetSession() {
    try {
        const raw = localStorage.getItem(NET_SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return (s && s.roomId && s.seatToken != null && s.seat != null) ? s : null;
    } catch (_e) { return null; }
}

function clearNetSession() {
    try { localStorage.removeItem(NET_SESSION_KEY); } catch (_e) { /* ignore */ }
}

function wsUrl() {
    const qs = new URLSearchParams(location.search);
    const stored = loadNetSession();
    return qs.get('ws')
        || (typeof window !== 'undefined' && window.LL_WS_URL)
        || (stored && stored.ws)
        || `ws://${location.hostname}:18181`;
}

function netShareLink(roomId) {
    return `${location.origin}${location.pathname}?room=${encodeURIComponent(roomId)}`;
}

// Step 7 UX: two lightweight banners layered over the game.
//   #net-status-banner — THIS client is offline / re-establishing its seat.
//   #net-peers-banner  — another human seat dropped; the writer plays on.
function netBanner(id) {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = `net-banner ${id === 'net-status-banner' ? 'net-banner-self' : 'net-banner-peers'} hidden`;
        document.body.appendChild(el);
    }
    return el;
}

function showNetBanner(id, text) {
    const el = netBanner(id);
    el.textContent = text;
    el.classList.remove('hidden');
}

function hideNetBanner(id) {
    netBanner(id).classList.add('hidden');
}

// Other seats' presence, from {t:'room'} broadcasts during a started game.
function updatePeerPresence(players) {
    if (!activeNetGame) return;
    const away = players.filter(p =>
        !p.isBot && p.connected === false && p.seat !== activeNetGame.seat);
    if (away.length) {
        const names = away.map(p => p.name).join(', ');
        showNetBanner('net-peers-banner', `⚠ ${names} disconnected — the realm awaits their return…`);
    } else {
        hideNetBanner('net-peers-banner');
    }
}

function ensureNetSession() {
    if (netSession) return netSession;
    netSession = createWsSession({ url: wsUrl() });
    netSession.onJoined(handleNetJoined);
    netSession.onRoom((players) => {
        renderNetLobby(players);
        updatePeerPresence(players);
    });
    netSession.onStarted(handleNetStarted);
    netSession.onRejoined(() => {
        // Post-start rebind: ask the writer for a catch-up snapshot.
        if (activeNetGame) activeNetGame.client.reconnect();
        hideNetBanner('net-status-banner');
    });
    netSession.onError((err) => {
        // A dead stored session (room reaped, token stale) must not wedge the
        // splash behind a "reconnecting" banner forever.
        if (netResuming && (err.code === 'bad-room' || err.code === 'bad-token')) {
            netResuming = false;
            clearNetSession();
            hideNetBanner('net-status-banner');
            flashHint('Your previous realm has ended.');
            return;
        }
        flashHint(err.message || err.code || 'Realm error.');
    });
    netSession.onStatus((s) => {
        if (s === 'reconnecting') {
            if (activeNetGame || netResuming) {
                showNetBanner('net-status-banner', '⚠ Connection lost — reconnecting…');
            }
        } else if (s === 'open' && activeNetGame) {
            flashHint('Reconnected to the realm.');
        } else if (s === 'closed') {
            hideNetBanner('net-status-banner');
        }
    });
    return netSession;
}

// Step 7: page refresh mid-session → rebind the stored seat automatically.
// The server answers with 'joined' (+ a re-sent 'started' when the game is
// live), handleNetStarted rebuilds v0 and pulls a catch-up snapshot.
function tryResumeStoredSession() {
    const stored = loadNetSession();
    if (!stored) return false;
    // An explicit ?room= link to a DIFFERENT room wins over the stored session.
    const roomParam = new URLSearchParams(location.search).get('room');
    if (roomParam && roomParam !== stored.roomId) return false;
    netResuming = true;
    showNetBanner('net-status-banner', '⚔ Rejoining your realm…');
    ensureNetSession().rejoin(stored.roomId, stored.seat, stored.seatToken);
    return true;
}

function onCreateRealm() {
    activeLocalGame = null;
    const name = (document.getElementById('player-name-create')?.value || '').trim() || 'Host';
    ensureNetSession().create(name);
}

function onJoinRealm() {
    activeLocalGame = null;
    const code = (document.getElementById('join-game-id')?.value || '').trim();
    if (!code) {
        flashHint('Enter the Realm ID to join.');
        return;
    }
    const name = (document.getElementById('player-name-join')?.value || '').trim() || `Lord ${Date.now() % 100}`;
    ensureNetSession().join(code, name);
}

function handleNetJoined(msg) {
    netInfo = { roomId: msg.roomId, seat: msg.seat, seatToken: msg.seatToken };
    saveNetSession();
    if (activeNetGame) {
        // Mid-game rejoin confirmation; onRejoined handles the snapshot pull.
        activeNetGame.seat = msg.seat;
        return;
    }
    if (msg.started) {
        // Refresh-resume into a live game: skip the lobby — the server re-sends
        // {t:'started'} right after this frame and handleNetStarted takes over.
        return;
    }
    if (netResuming) {
        // Resumed into a room still in its lobby phase.
        netResuming = false;
        hideNetBanner('net-status-banner');
    }
    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('lobby-container').classList.remove('hidden');
    document.getElementById('lobby-id-display').textContent = msg.roomId;
    const passLine = document.getElementById('lobby-pass-display');
    if (passLine) passLine.textContent = netShareLink(msg.roomId);
    const startBtn = document.getElementById('btn-start-game');
    if (msg.seat === 0) {
        startBtn.textContent = 'START REIGN';
        startBtn.disabled = true;   // enabled once a second seat appears
    } else {
        startBtn.textContent = 'Awaiting host…';
        startBtn.disabled = true;
    }
    const addBotBtn = document.getElementById('btn-add-bot');
    if (addBotBtn) addBotBtn.style.display = msg.seat === 0 ? '' : 'none';
    renderNetLobby(msg.players || []);
}

// Lobby roster from {t:'room'} broadcasts (replaces the PeerJS updateLobbyUI).
function renderNetLobby(players) {
    const slots = document.getElementById('lobby-slots');
    if (!slots || activeNetGame) return;
    const mySeat = netInfo ? netInfo.seat : null;
    slots.innerHTML = '';
    const maxSlots = Math.max(5, players.length);
    for (let i = 0; i < maxSlots; i++) {
        const slot = document.createElement('div');
        const p = players.find(pl => pl.seat === i);
        if (p) {
            slot.className = 'lobby-slot';
            const nameEl = document.createElement('span');
            nameEl.textContent = p.isBot
                ? `🤖 ${p.name}`
                : (p.seat === mySeat ? `${p.name} (You)` : p.name);
            const statusEl = document.createElement('span');
            statusEl.className = 'status';
            statusEl.textContent = p.isBot ? 'Ready' : (p.connected ? 'Joined' : 'Away');
            slot.append(nameEl, statusEl);
        } else {
            slot.className = 'lobby-slot empty';
            slot.innerHTML = '<span>Empty Slot</span>';
        }
        slots.appendChild(slot);
    }
    if (mySeat === 0) {
        const startBtn = document.getElementById('btn-start-game');
        startBtn.disabled = players.length < 2;
        startBtn.textContent = `START REIGN (${players.length})`;
    }
}

function handleNetStarted(msg) {
    if (!netInfo || activeNetGame) return;
    if (activeLocalGame) return;   // a solo game is running; ignore stray net frames
    const seat = netInfo.seat;

    // Byte-identical v0 state from the exact descriptors the server used.
    const initial = createInitialState(msg.seed, msg.players);
    const channel = netSession.channel();
    const client = createClient({ seat, channel, state: initial });
    channel.afterMessage(() => {
        if (!activeNetGame) return;
        syncGameStateFromNet();
        update();
        scheduleReactionHandling();
    });

    viewMeta = {
        localPlayerId: seat,
        logOpen: false,
        isStressTest: !!window.__game_stress_test,
        actionLog: [],
    };
    lastShownResolutionKey = null;
    lastShownWinnerId = null;
    activeNetGame = { session: netSession, client, seat };

    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');

    ensureInputAttached();
    exposeNetTestHook();

    if (netResuming) {
        // Refresh-resume: v0 was rebuilt from the re-sent seed/players; now
        // pull the catch-up snapshot from the writer.
        netResuming = false;
        hideNetBanner('net-status-banner');
        client.reconnect();
    }

    syncGameStateFromNet();
    update();
}

function submitNetAction(action) {
    if (!activeNetGame || !action) return false;
    syncGameStateFromNet();

    // Concede with a real debt and enough assets → interactive payment picker
    // (same flow as solo; the picked cards travel in paidCardIds).
    if (action.type === 'concede' && !Array.isArray(action.paidCardIds)) {
        const owed = debtOwedByLocal();
        if (owed > 0) {
            const local = gameState.players[gameState.localPlayerId];
            if (totalPayableAssets(local) >= owed) {
                showPaymentPicker(owed);
                return false;
            }
        }
    }

    activeNetGame.client.submit(action);
    if (action.type === 'react-no' || action.type === 'concede') hideModal();
    return true;
}

// One auto end-turn per accepted version, so an update() storm can't spam the
// writer while the previous end-turn is still in flight.
let _netAutoEndVersion = -1;
function maybeAutoEndNetTurn() {
    if (!activeNetGame) return;
    if (gameState._gameOver || gameState.winner != null) return;
    if (gameState.turn !== gameState.localPlayerId) return;
    if (gameState.actionsLeft > 0 || gameState.pendingAction !== null || gameState.mustDiscard > 0) return;
    const v = gameState.version || 0;
    if (v === _netAutoEndVersion) return;
    _netAutoEndVersion = v;
    activeNetGame.client.submit({ type: 'end-turn' });
}

// E2E driver hook: read-only clones + submit for THIS page's seat only.
function exposeNetTestHook() {
    if (typeof window === 'undefined' || !activeNetGame) return;
    const g = activeNetGame;
    window.__llNet = {
        seat: g.seat,
        getState: () => g.client.getState(),                       // already a clone
        submit: (a) => g.client.submit(a),
        legal: () => enumerateLegalActionsForState(g.client.getState(), g.seat),
        version: () => g.client.getVersion(),
        hash: () => g.client.hashOf(),
        // Same brain the solo bots use, run against the net client's state:
        // returns this seat's preferred action (or null → caller falls back).
        chooseAuto: () => {
            const st = g.client.getState();
            const legal = enumerateLegalActionsForState(st, g.seat);
            let a = null;
            try { a = browserBotPolicy(st, g.seat, legal); } catch (_e) { a = null; }
            if (!a) {
                if (st.pendingAction) a = legal.find(x => x.type === 'concede') || null;
                else if (st.mustDiscard > 0) a = legal.find(x => x.type === 'discard') || null;
                else a = legal.find(x => x.type === 'end-turn') || null;
            }
            return a || null;
        }
    };
}

function injectSoloButton() {
    const splash = document.querySelector('#splash-container .splash-panels');
    if (!splash || document.getElementById('btn-solo-game')) return;
    const panel = document.createElement('div');
    panel.className = 'splash-panel solo-panel';
    panel.innerHTML = `
        <h3>⚔️ SOLO QUEST</h3>
        <p style="font-size:13px;opacity:0.8;margin:6px 0 12px;">Play vs 2 AI rivals</p>
        <button id="btn-solo-game" class="badge btn" style="background:#5a3a27;font-size:18px;padding:12px 24px;">Begin Quest</button>
    `;
    splash.insertBefore(panel, splash.firstChild);
    document.getElementById('btn-solo-game').onclick = onSoloGame;
}

function onSoloGame() {
    activeNetGame = null;
    // Abandon any in-flight stored-session resume; solo owns the screen now.
    if (netResuming) {
        netResuming = false;
        hideNetBanner('net-status-banner');
        if (netSession) { netSession.close(); netSession = null; }
        netInfo = null;
    }
    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    startLocalGame(3);
}

function onHostGame() {
    activeLocalGame = null;
    const pass = (document.getElementById('room-pass-create')?.value || '').trim();
    hostName = (document.getElementById('player-name-create')?.value || '').trim() || 'Host';
    Multiplayer.becomeHost(pass);
    lobbyPeers = [];
    lobbyBots = [];
    peerNames = new Map();
    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('lobby-container').classList.remove('hidden');
    document.getElementById('btn-start-game').textContent = 'START REIGN';
    const passLine = document.getElementById('lobby-pass-display');
    if (passLine) passLine.textContent = pass ? `Pass: ${pass}` : '';
    updateLobbyUI();
}

function onJoinGame() {
    activeLocalGame = null;
    const raw = (document.getElementById('join-game-id').value || '').trim();
    // Accept "Green Duck Pond", "green_duck_pond", "GREEN-DUCK-POND" etc.
    const hostId = raw.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
    const pass = (document.getElementById('room-pass-join')?.value || '').trim();
    if (!hostId) {
        flashHint('Enter the Realm ID to join.');
        return;
    }
    const joinName = (document.getElementById('player-name-join')?.value || '').trim() || `Lord ${Date.now() % 100}`;
    Multiplayer.joinHost(hostId, pass, joinName);
    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('lobby-container').classList.remove('hidden');
    document.getElementById('lobby-id-display').textContent = `Joining ${hostId}…`;
    document.getElementById('btn-start-game').textContent = 'Awaiting host…';
    document.getElementById('btn-start-game').disabled = true;
    const slots = document.getElementById('lobby-slots');
    slots.innerHTML = '<div class="lobby-slot empty"><span>Waiting for host to start…</span></div>';
}

function handlePeerJoined(peerId, name = '') {
    if (!lobbyPeers.includes(peerId)) {
        lobbyPeers.push(peerId);
        lobbyPeers.sort(); // Consistent order for migration candidacy
    }
    if (name) peerNames.set(peerId, name);
}

function handlePeerLeft(peerId) {
    lobbyPeers = lobbyPeers.filter(p => p !== peerId);
    // If game in progress, mark that seat disconnected.
    const playerId = peerToPlayer.get(peerId);
    if (typeof playerId === 'number' && gameState.players[playerId]) {
        gameState.players[playerId]._disconnected = true;
        peerToPlayer.delete(peerId);
        playerToPeer.delete(playerId);
        // If it was their turn, auto-end so play doesn't stall.
        if (gameState.turn === playerId && !gameState._gameOver) {
            onEndTurn();
        }
    }
}

async function handleHostLost(reason) {
    // If we never made it into a game, the user is stuck in the lobby. Send
    // them back to the splash so they can try again instead of staring at
    // "Joining…" forever.
    const inGame = gameState && gameState.players && gameState.players.length;
    if (!inGame) {
        const lobby = document.getElementById('lobby-container');
        const splash = document.getElementById('splash-container');
        if (lobby) lobby.classList.add('hidden');
        if (splash) splash.classList.remove('hidden');
        const startBtn = document.getElementById('btn-start-game');
        if (startBtn) {
            startBtn.disabled = false;
            startBtn.textContent = 'START REIGN';
        }
        if (reason) flashHint(reason);
        return;
    }

    // Host Migration Logic
    const myId = Multiplayer.peerId;
    const humanPeers = lobbyPeers.filter(pid => pid !== myId);
    const allHumans = [myId, ...humanPeers].sort();
    const nextHostId = allHumans[0];

    if (nextHostId === myId) {
        showBanner('HOST DISCONNECTED. TAKING OVER...');
        console.log(`[MIGRATION] I am the new host candidate.`);
        
        // Upgrade to host
        Multiplayer.takeOverHost();
        
        // Re-bind players to peers based on our last known map
        peerToPlayer.clear();
        playerToPeer.forEach((pid, playerIdx) => {
            if (pid !== myId) peerToPlayer.set(pid, playerIdx);
        });

        // Resume game
        setTimeout(() => {
            broadcastSnapshot();
            update();
            scheduleBotIfNeeded();
            flashHint('Realm successfully migrated.');
        }, 2000);
    } else {
        showBanner('HOST DISCONNECTED. MIGRATING...');
        console.log(`[MIGRATION] Waiting for ${nextHostId} to take over.`);
        
        // Wait for the new host to set up and then try to rejoin
        let attempts = 0;
        const reJoin = () => {
            if (attempts > 10 || gameState._gameOver) return;
            Multiplayer.joinHost(nextHostId, '', gameState.players[gameState.localPlayerId]?.name);
            attempts++;
            setTimeout(reJoin, 5000);
        };
        setTimeout(reJoin, 4000);
    }
}

function updateLobbyUI() {
    if (!Multiplayer.isHost) return;
    const slots = document.getElementById('lobby-slots');
    slots.innerHTML = '';
    const total = 1 + lobbyPeers.length + lobbyBots.length;
    for (let i = 0; i < 5; i++) {
        const slot = document.createElement('div');
        if (i === 0) {
            slot.className = 'lobby-slot';
            slot.innerHTML = `<span>You (Host)</span><span class="status">Ready</span>`;
        } else if (i <= lobbyPeers.length) {
            slot.className = 'lobby-slot';
            const pid = lobbyPeers[i - 1];
            const label = peerNames.get(pid) || `Lord ${pid.slice(0, 6)}`;
            slot.innerHTML = `<span>${label}</span><span class="status">Joined</span>`;
        } else if (i <= lobbyPeers.length + lobbyBots.length) {
            slot.className = 'lobby-slot';
            const botIdx = i - 1 - lobbyPeers.length;
            const bot = lobbyBots[botIdx];
            slot.innerHTML = `
                <span>🤖 AI Rival</span>
                <select class="bot-difficulty-select" data-bot-idx="${botIdx}" style="background:#222; color:#fff; border:1px solid #444; padding:2px; border-radius:4px;">
                    <option value="easy" ${bot.difficulty === 'easy' ? 'selected' : ''}>Easy</option>
                    <option value="normal" ${bot.difficulty === 'normal' ? 'selected' : ''}>Normal</option>
                    <option value="hard" ${bot.difficulty === 'hard' ? 'selected' : ''}>Hard</option>
                </select>
                <button class="btn-remove-bot" data-bot-idx="${botIdx}" style="background:transparent; border:none; color:#d4af37; cursor:pointer; font-size:16px;">×</button>
            `;
        } else {
            slot.className = 'lobby-slot empty';
            slot.innerHTML = `<span>Empty Slot</span>`;
        }
        slots.appendChild(slot);
    }
    
    // Wire up bot controls
    slots.querySelectorAll('.bot-difficulty-select').forEach(sel => {
        sel.onchange = (e) => {
            const idx = Number(e.target.dataset.botIdx);
            if (lobbyBots[idx]) lobbyBots[idx].difficulty = e.target.value;
        };
    });
    slots.querySelectorAll('.btn-remove-bot').forEach(btn => {
        btn.onclick = (e) => {
            const idx = Number(e.target.dataset.botIdx);
            lobbyBots.splice(idx, 1);
            updateLobbyUI();
        };
    });

    const startBtn = document.getElementById('btn-start-game');
    startBtn.disabled = (lobbyPeers.length + lobbyBots.length) < 1;
    startBtn.textContent = `START REIGN (${total})`;
}

function leaveLobby() {
    if (netSession) netSession.leave();
    clearNetSession();   // deliberate exit: never auto-resume this seat again
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('splash-container').classList.remove('hidden');
    lobbyPeers = [];
    // Hard reset: easiest way to drop session state is a reload.
    setTimeout(() => location.reload(), 50);
}

function closeModal() {
    document.getElementById('picker-modal').classList.add('hidden');
}

function startGameFromLobby() {
    if (!Multiplayer.isHost) return;
    activeLocalGame = null;
    const playerCount = 1 + lobbyPeers.length + lobbyBots.length;
    if (playerCount < 2) return;
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');

    // Pick a per-game seed (app layer may use Math.random; the engine core
    // never does). Thread it through the initial shuffle, then hand the
    // advanced rng cursor to initGameState so mid-game reshuffles continue
    // the same reproducible stream.
    const seed = (Math.random() * 0x100000000) >>> 0;
    const rng = createRng(seed);
    const rawDeck = generateDeck(playerCount >= 6 ? 2 : 1, rng);
    const entities = rawDeck.map(card => ({ data: card, zone: 'deck', owner: null }));
    initGameState([...entities], playerCount, seed, rng.state);
    for (let i = 0; i < playerCount; i++) {
        for (let c = 0; c < 5; c++) drawCardFromDeck(i);
    }
    gameState.turn = 0;
    gameState.actionsLeft = 3;
    gameState.localPlayerId = 0;
    
    // Ensure stress test flag propagates
    if (window.__game_stress_test) gameState._isStressTest = true;

    gameState.players[0].name = hostName || 'Host';
    peerToPlayer = new Map();
    
    // Assign human peers
    playerToPeer = new Map();
    playerToPeer.set(0, Multiplayer.peerId); // Host is player 0
    gameState.players[0]._peerId = Multiplayer.peerId;

    lobbyPeers.forEach((peerId, idx) => {
        const pid = idx + 1;
        peerToPlayer.set(peerId, pid);
        playerToPeer.set(pid, peerId);
        gameState.players[pid].name = peerNames.get(peerId) || `Lord ${peerId.slice(0, 6)}`;
        gameState.players[pid]._peerId = peerId;
    });
    
    // Assign bots
    const botNames = ['AI Lord Botly', 'AI Lady Robo', 'AI Baron Cogs', 'AI Sir Automata'];
    lobbyBots.forEach((bot, idx) => {
        const pid = 1 + lobbyPeers.length + idx;
        gameState.players[pid].name = botNames[idx % botNames.length];
        gameState.players[pid]._isBot = true;
        gameState.players[pid]._difficulty = bot.difficulty;
    });

    ensureInputAttached();

    // Snapshot is the JSON-serialisable shape of gameState. Each client
    // overwrites their gameState with this and sets their localPlayerId
    // from the per-peer assignment.
    const stateSnapshot = JSON.parse(JSON.stringify(gameState));
    for (const [peerId, pid] of peerToPlayer) {
        Multiplayer.sendSnapshot({ playerId: pid, state: stateSnapshot }, peerId);
    }

    // Give snapshots a moment to propagate before starting the turn-0 bot
    setTimeout(() => {
        update();
        scheduleBotIfNeeded();
    }, 1500);
}

function handleSnapshot(msg) {
    if (!msg.state) return;
    activeLocalGame = null;
    console.log(`[NET-DEBUG] Received snapshot from host. Local ID was ${gameState.localPlayerId}, will be ${msg.playerId}`);

    // Adopt host's authoritative state.
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    const fresh = JSON.parse(JSON.stringify(msg.state));
    Object.assign(gameState, fresh);
    gameState.localPlayerId = msg.playerId;

    // Sync lobby metadata for migration potential
    lobbyPeers = [];
    playerToPeer.clear();
    gameState.players.forEach((p, i) => {
        if (p._peerId && p._peerId !== Multiplayer.peerId) {
            lobbyPeers.push(p._peerId);
            playerToPeer.set(i, p._peerId);
        }
    });
    lobbyPeers.sort();

    console.log(`[NET-DEBUG] State adopted. Deck size: ${gameState.deck.length}`);

    ensureInputAttached();
    update();
}
function ensureInputAttached() {
    if (inputAttached) return;
    const root = document.getElementById('game-root');
    attachInput(root, () => currentState(), dispatchAction, showCardInfo, handleCardTap);
    root.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="end-turn"]')) onEndTurn();
        if (e.target.closest('[data-action="menu"]')) showGlossary();
        if (e.target.closest('[data-action="toggle-log"]')) {
            if (isSoloControllerActive() || activeNetGame) {
                viewMeta.logOpen = !viewMeta.logOpen;
                if (activeNetGame) syncGameStateFromNet();
                else syncGameStateFromController();
            } else {
                gameState._logOpen = !gameState._logOpen;
            }
            update();
        }
        const kingdomEl = e.target.closest('.your-kingdom [data-card-id]');
        if (kingdomEl) {
            handleKingdomCardTap(kingdomEl.dataset.cardId);
        }
    });
    inputAttached = true;
}

function startLocalGame(playerCount = 2) {
    const seed = (Math.random() * 0x100000000) >>> 0;
    const localName = (document.getElementById('player-name-create')?.value || '').trim() || 'You';
    const botNames = [
        'Lord Pemberton', 'Lady Ashcroft', 'Baron Greycastle', 'Duchess Marlow',
        'Sir Hawthorne', 'Countess Wexley', 'Earl Brackenridge', 'Viscount Thornton',
        'Margrave Halloway'
    ];
    const descriptors = Array.from({ length: playerCount }, (_, i) => ({
        name: i === 0 ? localName : botNames[(i - 1) % botNames.length],
    }));
    const initial = createInitialState(seed, descriptors);
    initial.players.forEach((p, i) => {
        if (i !== 0) {
            p._isBot = true;
            p._difficulty = 'normal';
        }
    });
    viewMeta = {
        localPlayerId: 0,
        logOpen: false,
        isStressTest: !!window.__game_stress_test,
        actionLog: [],
    };
    lastShownResolutionKey = null;
    lastShownWinnerId = null;
    activeLocalGame = createLocalGame({
        state: initial,
        humanSeats: [0],
        policy: browserBotPolicy,
        onChange: () => {
            syncGameStateFromController();
            update();
        },
    });

    ensureInputAttached();

    activeLocalGame.start();
    syncGameStateFromController();
    update();
}

let _renderPending = false;
function scheduleRender() {
    if (_renderPending) return;
    _renderPending = true;
    requestAnimationFrame(() => {
        _renderPending = false;
        const root = document.getElementById('game-root');
        render(root, currentState());
    });
}

function appendLog(text) {
    const log = activeLocalGame
        ? viewMeta.actionLog
        : (gameState.actionLog || (gameState.actionLog = []));
    log.push({
        text,
        turn: (gameState.turnNumber || 0),
        t: Date.now()
    });
    if (log.length > 100) {
        log.splice(0, log.length - 100);
    }
    if (activeLocalGame) syncGameStateFromController();
}

function update() {
    if (activeNetGame) syncGameStateFromNet();
    else if (activeLocalGame) syncGameStateFromController();
    scheduleRender();

    if (gameState.lastResolution) {
        const key = `${gameState.version || 0}:${JSON.stringify(gameState.lastResolution)}`;
        const msg = key !== lastShownResolutionKey ? describeResolution(gameState.lastResolution) : '';
        if (msg) {
            flashHint(msg);
            appendLog(msg);
        }
        lastShownResolutionKey = key;
        if (!activeLocalGame && !activeNetGame) gameState.lastResolution = null;
    }

    const winnerId = activeNetGame
        ? (gameState.winner ?? null)
        : activeLocalGame ? activeLocalGame.winner() : checkWinner();
    if (winnerId !== null && winnerId !== lastShownWinnerId) {
        lastShownWinnerId = winnerId;
        gameState._gameOver = true;
        if (activeNetGame) {
            clearNetSession();   // finished realm: a refresh should not rejoin it
            hideNetBanner('net-peers-banner');
        }
        showBanner(winnerId === gameState.localPlayerId ? 'THE CROWN IS YOURS!' : 'YOUR KINGDOM HAS FALLEN');
    }

    if (activeNetGame) {
        maybeAutoEndNetTurn();
        return;
    }
    if (activeLocalGame) return;

    if (
        !gameState._gameOver &&
        gameState.turn === gameState.localPlayerId &&
        gameState.actionsLeft <= 0 &&
        gameState.pendingAction === null &&
        gameState.mustDiscard === 0 &&
        !gameState._autoEnding
    ) {
        // Auto-end turn when all 3 actions are spent. If hand>7, engineEndTurn
        // sets mustDiscard and returns false; the turn indicator then enters the
        // discard phase until the player drags enough cards away.
        gameState._autoEnding = true;
        const ok = engineEndTurn();
        gameState._autoEnding = false;
        Multiplayer.broadcastAction({ type: 'end-turn' }, gameState.localPlayerId);
        if (Multiplayer.isHost) broadcastSnapshot();
        update();
        if (ok) scheduleBotIfNeeded();
    }
}


function findHandCard(playerId, cardId) {
    return gameState.players[playerId].hand.find(c => c.data.id === cardId);
}

function totalPayableAssets(player) {
    const bankTotal = player.bank.reduce((s, c) => s + (c.data.value || 0), 0);
    const propTotal = payablePropertyCards(player).reduce((s, it) => s + (it.card.data.value || 0), 0);
    const buildingTotal = Object.values(player.buildings || {})
        .flat()
        .filter(c => (c.data.value || 0) > 0)
        .reduce((s, c) => s + (c.data.value || 0), 0);
    return bankTotal + propTotal + buildingTotal;
}

function submitSoloAction(action) {
    if (!activeLocalGame || !action) return false;
    syncGameStateFromController();

    if (action.type === 'concede' && !Array.isArray(action.paidCardIds)) {
        const owed = debtOwedByLocal();
        if (owed > 0) {
            const local = gameState.players[gameState.localPlayerId];
            if (totalPayableAssets(local) >= owed) {
                showPaymentPicker(owed);
                return false;
            }
        }
    }

    const changed = activeLocalGame.submit(action);
    syncGameStateFromController();
    if (action.type === 'react-no' || action.type === 'concede') hideModal();
    update();
    scheduleReactionHandling();
    return changed;
}

function dispatchAction(action) {
    if (!action) return;
    if (action.type === 'tap-via-drop') {
        handleCardTap(action.cardId);
        return;
    }
    if (activeNetGame) {
        submitNetAction(action);
        return;
    }
    if (isSoloControllerActive()) {
        submitSoloAction(action);
        return;
    }

    // Reaction actions can fire when it's not the local player's main turn.
    const isReactionAction = action.type === 'react-no' || action.type === 'concede';
    if (!isReactionAction && gameState.turn !== gameState.localPlayerId) return;

    // Drag-to-play sentinel for cards that need a color/target picker
    // (rent, buildings, propose-effect actions). Route through the same
    // picker the tap path uses.
    if (action.type === 'swap-wild') {
        const ok = swapWildColor(gameState.localPlayerId, action.cardId, action.color);
        if (ok) {
            Multiplayer.broadcastAction(action, gameState.localPlayerId);
            update();
        }
        return;
    }

    if (action.type === 'react-no') {
        const reactingId = gameState.localPlayerId;
        const card = gameState.players[reactingId].hand.find(c => c.data.id === action.cardId);
        if (!card) return;
        const againstReactorId = (action.againstReactorId !== undefined) ? action.againstReactorId : null;
        reactJustSayNo(card, reactingId, againstReactorId);
        Multiplayer.broadcastAction({ ...action, againstReactorId }, reactingId);
        hideModal();
        update();
        scheduleReactionHandling();
        return;
    }
    if (action.type === 'concede') {
        const owed = debtOwedByLocal();
        console.log(`[NET-DEBUG] dispatchAction(concede) localPlayerId=${gameState.localPlayerId}, owed=${owed}`);
        if (owed > 0) {
            const local = gameState.players[gameState.localPlayerId];
            const bankTotal = local.bank.reduce((s, c) => s + (c.data.value || 0), 0);
            const payableProps = Object.values(local.properties || {})
                .flat()
                .filter(c => (c.data.value || 0) > 0);
            const propTotal = payableProps.reduce((s, c) => s + (c.data.value || 0), 0);
            const payableBuildings = Object.values(local.buildings || {})
                .flat()
                .filter(c => (c.data.value || 0) > 0);
            const buildingTotal = payableBuildings.reduce((s, c) => s + (c.data.value || 0), 0);
            const totalAssets = bankTotal + propTotal + buildingTotal;
            
            console.log(`[NET-DEBUG] Assets: bank=${bankTotal}, props=${propTotal}, buildings=${buildingTotal}, total=${totalAssets}`);

            if (totalAssets < owed && totalAssets > 0) {
                console.log(`[NET-DEBUG] Shortfall detected! surrendering all assets.`);
                const pa = gameState.pendingAction;
                const attackerId = pa.attackerId;
                const attacker = gameState.players[attackerId];
                local.bank.slice().forEach(c => {
                    local.bank = local.bank.filter(x => x !== c);
                    c.owner = attackerId;
                    attacker.bank.push(c);
                });
                payableProps.forEach(c => {
                    const colorKey = Object.keys(local.properties).find(k => (local.properties[k] || []).includes(c));
                    if (!colorKey) return;
                    local.properties[colorKey] = local.properties[colorKey].filter(x => x !== c);
                    c.owner = attackerId;
                    const color = c.currentColor || colorKey;
                    if (!attacker.properties[color]) attacker.properties[color] = [];
                    attacker.properties[color].push(c);
                });
                payableBuildings.forEach(c => {
                    const colorKey = Object.keys(local.buildings).find(k => (local.buildings[k] || []).includes(c));
                    if (!colorKey) return;
                    local.buildings[colorKey] = local.buildings[colorKey].filter(x => x !== c);
                    c.owner = attackerId;
                    c.zone = 'bank';
                    attacker.bank.push(c);
                });
                
                if (!pa.options) pa.options = {};
                if (!pa.options.alreadyPaidIds) pa.options.alreadyPaidIds = [];
                if (!pa.options.alreadyPaidIds.includes(gameState.localPlayerId)) pa.options.alreadyPaidIds.push(gameState.localPlayerId);

                resolvePendingAction(gameState.localPlayerId);
                Multiplayer.broadcastAction(action, gameState.localPlayerId);
                hideModal();
                update();
                scheduleReactionHandling();
                return;
            }

            if (totalAssets >= owed) {
                console.log(`[NET-DEBUG] Assets sufficient, showing payment picker.`);
                showPaymentPicker(owed);
                return;
            }
            console.log(`[NET-DEBUG] No assets to pay (shortfall to 0), resolving...`);
        }
        resolvePendingAction(gameState.localPlayerId);
        Multiplayer.broadcastAction(action, gameState.localPlayerId);
        hideModal();
        update();
        scheduleReactionHandling();
        return;
    }

    const card = findHandCard(gameState.localPlayerId, action.cardId);
    if (!card) return;

    if (action.type === 'propose') {
        const opts = resolveProposeOptions(action);
        proposeAction(card, gameState.localPlayerId, action.targetPlayerId, opts);
        Multiplayer.broadcastAction(action, gameState.localPlayerId);
        update();
        scheduleReactionHandling();
        return;
    }

    if (action.type === 'discard') {
        // End-of-turn discard goes to the BOTTOM of the draw pile per rules,
        // not the discard pile.
        const local = gameState.players[gameState.localPlayerId];
        local.hand = local.hand.filter(c => c !== card);
        card.zone = 'deck';
        card.owner = null;
        gameState.deck.unshift(card);
        Multiplayer.broadcastAction(action, gameState.localPlayerId);
        if (gameState.mustDiscard > 0) {
            gameState.mustDiscard--;
            if (gameState.mustDiscard === 0) {
                const ok = engineEndTurn();
                if (ok) Multiplayer.broadcastAction({ type: 'end-turn' }, gameState.localPlayerId);
                update();
                if (ok) scheduleBotIfNeeded();
                return;
            }
        }
        update();
        return;
    }

    if (action.type === 'play') {
        if (
            action.zone === 'board' &&
            card.data.type === CARD_TYPES.JOKER &&
            Array.isArray(card.data.allowedColors) &&
            card.data.allowedColors.length > 1 &&
            !(action.options && (action.options._colorPicked || action.options.color))
        ) {
            showWildColorPicker(card, card.data.allowedColors, (color) => {
                dispatchAction({
                    ...action,
                    options: { ...(action.options || {}), color, _colorPicked: true },
                });
            });
            return;
        }
        if (action.zone === 'discard') {
            const effect = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
            const isCharge = effect === 'collect_rent' || effect === 'birthday' || effect === 'debt_collector';
            if (isCharge) {
                // Charging actions go through proposeAction so targets can choose
                // what to pay, play Just Say No, or surrender all assets.
                // actionsLeft is decremented inside resolvePendingAction once settled.
                proposeAction(card, gameState.localPlayerId, action.targetPlayerId, action.options || {});
                Multiplayer.broadcastAction(action, gameState.localPlayerId);
                update();
                scheduleReactionHandling();
                return;
            }
            executeAction(card, gameState.localPlayerId, action.targetPlayerId, action.options || {});
        } else {
            playCardToZone(card, action.zone, gameState.localPlayerId, action.options || {});
            gameState.actionsLeft--;
        }
        Multiplayer.broadcastAction(action, gameState.localPlayerId);
        update();
    }
}

function findKingdomCard(player, cardId) {
    for (const colorKey of Object.keys(player.properties || {})) {
        const arr = player.properties[colorKey] || [];
        const c = arr.find(cc => cc.data.id === cardId);
        if (c) return { card: c, colorKey };
    }
    return null;
}

function handleKingdomCardTap(cardId) {
    if (gameState.turn !== gameState.localPlayerId) return;
    if (gameState.reactionTargetId !== null) return;
    const local = gameState.players[gameState.localPlayerId];
    const entry = findKingdomCard(local, cardId);
    if (!entry) return;
    const card = entry.card;
    if (card.data.type !== CARD_TYPES.JOKER) return;
    const allowed = card.data.allowedColors || [];
    if (allowed.length <= 1) return;
    showPickerModal(card, `Flip ${card.data.name} to…`, allowed.map(color => ({
        label: PROPERTIES[color]?.name || color,
        swatch: PROPERTIES[color]?.hex,
        onPick: () => {
            dispatchAction({ type: 'swap-wild', cardId: card.data.id, color });
        },
    })));
}

function debtOwedByLocal() {
    const pa = gameState.pendingAction;
    if (!pa) return 0;
    if (!pa.isFanOut && pa.targetPlayerId !== gameState.localPlayerId) return 0;
    const effect = pa.card.data.effect;
    if (effect === 'birthday') return 2;
    if (effect === 'debt_collector') return 5;
    if (pa.card.data.type === CARD_TYPES.RENT) {
        const color = (pa.options || {}).color;
        let amount = 0;
        const props = gameState.players[pa.attackerId].properties[color] || [];
        if (props.length > 0) {
            const def = PROPERTIES[color];
            amount = def.rent[Math.min(props.length - 1, def.rent.length - 1)];
            const buildings = gameState.players[pa.attackerId].buildings[color] || [];
            const hasHouse = buildings.some(b => b.data.effect === 'house');
            buildings.forEach(b => {
                if (b.data.effect === 'house') amount += 3;
                if (b.data.effect === 'hotel' && hasHouse) amount += 4;
            });
        }
        if (gameState.doubleRentArmed) amount *= 2;
        return amount;
    }
    return 0;
}

function showPaymentPicker(owed) {
    const local = gameState.players[gameState.localPlayerId];
    const pa = gameState.pendingAction;
    const attackerId = pa.attackerId;

    const bankItems = local.bank
        .filter(c => (c.data.value || 0) > 0)
        .map(c => ({
            kind: 'bank',
            card: c,
            value: c.data.value || 0,
            label: `Treasury: ${c.data.value || 0}g`,
        }));

    const propItems = payablePropertyCards(local).map(it => ({
        ...it,
        kind: 'property',
        label: propertyLabel(it),
        value: it.card.data.value,
        swatch: PROPERTIES[it.colorKey]?.hex
    }));

    const buildingItems = [];
    for (const colorKey of Object.keys(local.buildings || {})) {
        for (const b of (local.buildings[colorKey] || [])) {
            if ((b.data.value || 0) > 0) {
                const glyph = b.data.effect === 'hotel' ? '🏰' : '🏠';
                buildingItems.push({
                    kind: 'building',
                    card: b,
                    colorKey,
                    value: b.data.value || 0,
                    label: `${glyph} ${b.data.name} (${b.data.value || 0}g) — surrender as money`,
                });
            }
        }
    }
    const items = [...bankItems, ...propItems, ...buildingItems];
    const total = items.reduce((s, it) => s + it.value, 0);
    const target = owed;
    const selected = new Set();

    const modal = ensureModal();
    modal.dataset.modalKind = 'payment';

    function rerender() {
        const sum = items.reduce((s, it, i) => s + (selected.has(i) ? it.value : 0), 0);
        const enough = sum >= target;
        const rows = items.map((it, i) => {
            const checked = selected.has(i);
            const sw = it.swatch ? `<span class="swatch" style="background:${it.swatch}"></span>` : '';
            return `<button class="picker-btn ${checked ? 'selected' : ''}" data-pay-idx="${i}">${sw}${checked ? '✓ ' : ''}${it.label}</button>`;
        }).join('');
        const desc = `Pick which cards to hand over. No change is given. Selected: <strong>${sum}g</strong> / ${owed}g.`;
        const btnLabel = 'Pay';
        modal.innerHTML = `
            <div class="info-modal-body">
                <h2>Pay ${owed}g to ${labelOpponent(attackerId)}</h2>
                <p class="info-desc">${desc}</p>
                <div class="picker-options">${rows}</div>
                <div class="reaction-buttons">
                    <button class="reaction-btn ${enough ? 'no-btn' : ''}" data-pay-submit ${enough ? '' : 'disabled'}>${btnLabel}</button>
                </div>
            </div>
        `;
    }

    modal.onclick = (e) => {
        const row = e.target.closest('[data-pay-idx]');
        if (row) {
            const idx = Number(row.dataset.payIdx);
            if (selected.has(idx)) selected.delete(idx);
            else selected.add(idx);
            rerender();
            return;
        }
        if (e.target.closest('[data-pay-submit]')) {
            try {
                const sum = items.reduce((s, it, i) => s + (selected.has(i) ? it.value : 0), 0);
                if (sum < target) return;
                console.log(`[NET-DEBUG] Payment submit: total=${sum}, target=${target}`);
                const paidCardIds = Array.from(selected).map(i => items[i].card.data.id);
                if (isSoloControllerActive() || activeNetGame) {
                    modal.classList.add('hidden');
                    modal.onclick = null;
                    modal.removeAttribute('data-modal-kind');
                    if (activeNetGame) submitNetAction({ type: 'concede', paidCardIds });
                    else submitSoloAction({ type: 'concede', paidCardIds });
                    return;
                }
                const attacker = gameState.players[attackerId];
                for (const i of selected) {
                    const it = items[i];
                    if (it.kind === 'bank') {
                        local.bank = local.bank.filter(c => c !== it.card);
                        it.card.owner = attackerId;
                        attacker.bank.push(it.card);
                    } else if (it.kind === 'building') {
                        local.buildings[it.colorKey] = (local.buildings[it.colorKey] || []).filter(c => c !== it.card);
                        it.card.owner = attackerId;
                        it.card.zone = 'bank';
                        attacker.bank.push(it.card);
                    } else {
                        local.properties[it.colorKey] = (local.properties[it.colorKey] || []).filter(c => c !== it.card);
                        it.card.owner = attackerId;
                        const color = it.card.currentColor || it.colorKey;
                        if (!attacker.properties[color]) attacker.properties[color] = [];
                        attacker.properties[color].push(it.card);
                    }
                }
                modal.classList.add('hidden');
                modal.onclick = null;
                modal.removeAttribute('data-modal-kind');
                
                if (!pa.options) pa.options = {};
                if (!pa.options.alreadyPaidIds) pa.options.alreadyPaidIds = [];
                if (!pa.options.alreadyPaidIds.includes(gameState.localPlayerId)) pa.options.alreadyPaidIds.push(gameState.localPlayerId);

                console.log(`[NET-DEBUG] Resolving local concede with alreadyPaidIds=${pa.options.alreadyPaidIds}`);
                resolvePendingAction(gameState.localPlayerId);
                console.log(`[NET-DEBUG] Broadcasting concede to peers...`);
                Multiplayer.broadcastAction({ type: 'concede', paidCardIds }, gameState.localPlayerId);
                update();
                scheduleReactionHandling();
            } catch (err) {
                console.error(`[NET-DEBUG] CRASH in payment submit:`, err);
            }
        }
    };
    rerender();
    modal.classList.remove('hidden');
}

function showWildColorPicker(card, allowedColors, onPick) {
    showPickerModal(card, `Choose a color for ${card.data.name}`, allowedColors.map(color => ({
        label: PROPERTIES[color]?.name || color,
        swatch: PROPERTIES[color]?.hex,
        onPick: () => onPick(color),
    })));
}

function onEndTurn() {
    if (activeNetGame) {
        submitNetAction({ type: 'end-turn' });
        return;
    }
    if (isSoloControllerActive()) {
        submitSoloAction({ type: 'end-turn' });
        return;
    }
    if (gameState.turn !== gameState.localPlayerId) return;
    const ok = engineEndTurn();
    Multiplayer.broadcastAction({ type: 'end-turn' }, gameState.localPlayerId);
    if (Multiplayer.isHost) broadcastSnapshot();
    update();
    if (ok) scheduleBotIfNeeded();
}

function scheduleBotIfNeeded() {
    if (activeNetGame) return;    // the server drives bots in net games
    if (isSoloControllerActive()) {
        activeLocalGame.advance();
        syncGameStateFromController();
        update();
        scheduleReactionHandling();
        return;
    }
    if (gameState._gameOver || gameState._isStressTest) return;
    if (gameState.pendingAction !== null) {
        scheduleReactionHandling();
        return;
    }
    if (gameState.turn === gameState.localPlayerId) return;
    if (Multiplayer.isClient) return;
    if (Multiplayer.isHost) {
        const turnPlayer = gameState.players[gameState.turn];
        if (turnPlayer && !turnPlayer._disconnected && !turnPlayer._isBot) return;
    }
    setTimeout(playBotTurn, 600);
}

function broadcastSnapshot() {
    if (!Multiplayer.isHost) return;
    const snap = JSON.parse(JSON.stringify(gameState));
    for (const [peerId, pid] of peerToPlayer) {
        Multiplayer.sendSnapshot({ playerId: pid, state: snap }, peerId);
    }
}

function scheduleReactionHandling() {
    if (activeNetGame) {
        syncGameStateFromNet();
        if (gameState._gameOver) return;
        if (gameState.pendingAction === null) {
            // A remote resolution can settle the chain while our reaction
            // prompt is still up — drop it.
            const openModal = document.getElementById('info-modal');
            if (openModal && !openModal.classList.contains('hidden') &&
                openModal.dataset.modalKind === 'reaction') {
                hideModal();
            }
            return;
        }
        const payModal = document.getElementById('info-modal');
        if (payModal && !payModal.classList.contains('hidden') &&
            payModal.dataset.modalKind === 'payment') {
            return;
        }
        if (playerHasPendingReaction(gameState.localPlayerId)) showReactionPrompt();
        return;
    }
    if (isSoloControllerActive()) {
        syncGameStateFromController();
        if (gameState._gameOver) return;
        if (gameState.pendingAction === null) return;
        const modal = document.getElementById('info-modal');
        if (modal && !modal.classList.contains('hidden') && modal.dataset.modalKind === 'payment') {
            return;
        }
        if (playerHasPendingReaction(gameState.localPlayerId)) {
            showReactionPrompt();
            return;
        }
        activeLocalGame.advance();
        syncGameStateFromController();
        if (gameState.pendingAction !== null && playerHasPendingReaction(gameState.localPlayerId)) {
            showReactionPrompt();
        }
        update();
        return;
    }
    if (gameState._gameOver) return;
    if (gameState.pendingAction === null) {
        scheduleBotIfNeeded();
        return;
    }
    
    const modal = document.getElementById('info-modal');
    if (modal && !modal.classList.contains('hidden') && modal.dataset.modalKind === 'payment') {
        return;
    }

    if (playerHasPendingReaction(gameState.localPlayerId)) {
        showReactionPrompt();
        return;
    }
    const pa = gameState.pendingAction;
    const actors = new Set();
    Object.keys(pa.chains).forEach(rid => {
        const c = pa.chains[rid];
        if (c.settled) return;
        const actorId = (c.chainCount % 2 === 0) ? Number(rid) : pa.attackerId;
        if (actorId !== gameState.localPlayerId) actors.add(actorId);
    });
    if (actors.size === 0) return;
    actors.forEach(actorId => {
        setTimeout(() => botReactFor(actorId), 500);
    });
}

function showBotBanner(playerId, text) {
    const p = gameState.players[playerId];
    const banner = document.getElementById('turn-banner');
    if (!banner) return;
    banner.textContent = `${p.name}: "${text}"`;
    banner.style.opacity = 1;
    setTimeout(() => {
        if (banner.textContent.startsWith(p.name)) banner.style.opacity = 0;
    }, 2000);
}

function botReactFor(actorId) {
    if (isSoloControllerActive()) {
        activeLocalGame.advance();
        syncGameStateFromController();
        update();
        scheduleReactionHandling();
        return;
    }
    if (gameState._gameOver) return;
    if (Multiplayer.isClient) return;
    if (!gameState.pendingAction) return;
    if (actorId === gameState.localPlayerId) return;
    const p = gameState.players[actorId];
    if (Multiplayer.isHost) {
        if (p && !p._disconnected && !p._isBot) return;
    }
    if (!playerHasPendingReaction(actorId)) return;
    
    const difficulty = p._difficulty || 'normal';
    const pa = gameState.pendingAction;
    const isAttacker = actorId === pa.attackerId;
    const bigDeal = pa.card.data.effect === 'deal_breaker' || pa.card.data.effect === 'sly_deal' || pa.card.data.effect === 'forced_deal';
    const noCard = p.hand.find(c => c.data.effect === 'just_say_no');

    let shouldJSN = false;
    if (noCard) {
        if (difficulty === 'easy') {
            shouldJSN = Math.random() < 0.2;
        } else if (difficulty === 'normal') {
            shouldJSN = bigDeal;
        } else if (difficulty === 'hard') {
            // Hard: JSN big deals, or anything if we're close to winning/losing
            shouldJSN = bigDeal;
            if (!shouldJSN) {
                const mySets = Object.values(p.properties).filter(arr => {
                    const color = arr[0]?.currentColor || arr[0]?.data.colorKey;
                    return color && arr.length >= (PROPERTIES[color]?.count || 3);
                }).length;
                if (mySets >= 2) shouldJSN = true; // Protect our almost-win
            }
        }
    }

    if (isAttacker) {
        // Attacker JSN-back: only chain back if strategic
        if (shouldJSN) {
            const chainKey = Object.keys(pa.chains)
                .map(k => Number(k))
                .find(rid => !pa.chains[rid].settled && pa.chains[rid].chainCount % 2 === 1);
            if (chainKey !== undefined) {
                reactJustSayNo(noCard, actorId, chainKey);
                update();
                scheduleReactionHandling();
                return;
            }
        }
        resolvePendingAction(actorId);
        update();
        scheduleReactionHandling();
        return;
    }

    if (shouldJSN) {
        const lines = difficulty === 'hard' ? 
            ['Not in my kingdom!', 'I think not.', 'Nice try, but no.', 'Denied!'] :
            ['Just Say No!', 'Not today.', 'I decline.'];
        showBotBanner(actorId, lines[Math.floor(Math.random()*lines.length)]);
        
        reactJustSayNo(noCard, actorId);
        update();
        scheduleReactionHandling();
        return;
    }
    resolvePendingAction(actorId);
    update();
    scheduleReactionHandling();
}

// Back-compat shim for the window.__game.botReact handle.
function botReact() {
    scheduleReactionHandling();
}

/**
 * Score a play action higher when it makes progress toward winning.
 * Building/finishing a set ranks above banking; banking money beats
 * dumping properties into the bank as filler.
 */
function scoreAction(action, playerId, difficulty = 'normal', state = gameState) {
    const player = state.players[playerId];
    if (!player) return -1;
    const card = player.hand.find(c => c.data.id === action.cardId);
    if (!card) return -1;
    const d = card.data;

    if (action.type !== 'play') return -1;

    if (action.zone === 'board') {
        if (d.type === CARD_TYPES.PROPERTY || d.type === CARD_TYPES.JOKER) {
            const color = (action.options && action.options.color) || d.colorKey;
            const setSize = (PROPERTIES[color] && PROPERTIES[color].count) || 3;
            const have = (player.properties[color] || []).length;
            const positionInSet = have % setSize;
            const wouldComplete = positionInSet + 1 === setSize;
            
            let score = 0;
            if (wouldComplete) {
                score = 16;
            } else {
                // Progress score: higher for colors with more cards already held
                score = 10 + (setSize - 1 - positionInSet);
                if (d.type === CARD_TYPES.PROPERTY) score += 1;
            }

            if (difficulty === 'hard') {
                // Hard AI: Prioritize sets that opponents are also building to block them
                const othersHave = state.players
                    .filter(p => p.id !== playerId)
                    .some(p => (p.properties[color] || []).length > 0);
                if (othersHave) score += 2;

                // Penalty for playing a Joker on an empty color if we have other options
                if (d.type === CARD_TYPES.JOKER && have === 0) score -= 4;
            }

            return score;
        }
        if (d.type === CARD_TYPES.BUILDING) {
            const color = action.options?.color;
            const hasFullSet = color && (player.properties[color] || []).length >= (PROPERTIES[color]?.count || 3);
            if (!hasFullSet) return 0; // Can't play building without set
            return 14;
        }
    }

    if (action.zone === 'bank') {
        if (d.type === CARD_TYPES.MONEY) return 6;
        if (d.type === CARD_TYPES.ACTION) return 4;
        if (d.type === CARD_TYPES.RENT) return 3;
        // Banking a property or wild is a last resort — wastes set-building potential.
        return difficulty === 'hard' ? -5 : 1;
    }

    if (action.zone === 'discard') {
        if (d.effect === 'pass_go') return 9;
    }

    return 0;
}

export function pickBestPlayAction(actions, playerId, difficulty = 'normal', state = gameState) {
    const plays = actions.filter(a => a.type === 'play' && (a.zone === 'bank' || a.zone === 'board' || a.zone === 'discard'));
    if (!plays.length) return null;
    let best = plays[0];
    let bestScore = scoreAction(best, playerId, difficulty, state);
    for (let i = 1; i < plays.length; i++) {
        const s = scoreAction(plays[i], playerId, difficulty, state);
        if (s > bestScore) {
            best = plays[i];
            bestScore = s;
        }
    }
    return bestScore > 0 ? best : null;
}

function scorePropose(action, playerId, difficulty = 'normal', state = gameState) {
    const player = state.players[playerId];
    const card = player.hand.find(c => c.data.id === action.cardId);
    if (!card) return -1;
    const effect = card.data.effect;

    if (difficulty === 'easy') {
        return 5; // Flat score for all actions
    }

    if (effect === 'deal_breaker') return 22;
    if (effect === 'sly_deal') {
        let score = 11;
        if (difficulty === 'hard' && action.options?.targetCardId) {
            const target = state.players[action.targetPlayerId];
            let cardObj = null;
            for (const cKey of Object.keys(target.properties)) {
                cardObj = target.properties[cKey].find(c => c.data.id === action.options.targetCardId);
                if (cardObj) break;
            }
            if (cardObj) {
                const color = cardObj.currentColor || cardObj.data.colorKey;
                const setSize = PROPERTIES[color]?.count || 3;
                const have = (player.properties[color] || []).length;
                if (have + 1 === setSize) score += 10; // Would complete our set
                
                const oppHave = (target.properties[color] || []).length;
                if (oppHave === setSize) score += 12; // Would break opponent's set
            }
        }
        return score;
    }
    if (effect === 'debt_collector') return 8;
    if (effect === 'birthday') return 7;
    if (effect === 'pass_go') return 9;
    if (card.data.type === CARD_TYPES.RENT) {
        let score = 6;
        if (difficulty === 'hard') {
            const color = action.options?.color;
            if (color) {
                const props = player.properties[color] || [];
                const rentBase = PROPERTIES[color]?.rent[Math.min(props.length - 1, PROPERTIES[color].rent.length - 1)] || 0;
                score += Math.floor(rentBase / 2); // Scale with rent value
            }
        }
        return score;
    }
    return 3;
}

/**
 * The enumerator sets options.targetCardId (string); executeAction reads
 * options.targetCard (object). Resolve before calling proposeAction.
 */
function resolveProposeOptions(action) {
    const opts = { ...(action.options || {}) };
    if (opts.targetCardId && action.targetPlayerId != null) {
        const target = gameState.players[action.targetPlayerId];
        for (const colorKey of Object.keys(target.properties || {})) {
            const c = (target.properties[colorKey] || []).find(cc => cc.data.id === opts.targetCardId);
            if (c) { opts.targetCard = c; break; }
        }
    }
    return opts;
}

const botStrategies = new Map();

function pickStrategyAction(playerId) {
    const fn = botStrategies.get(playerId);
    if (!fn) return null;
    try {
        const actions = legalActionsFor(playerId);
        return fn(actions, gameState, playerId) || null;
    } catch (_e) {
        return null;
    }
}

function pickBestAction(playerId, state = gameState, actions = null) {
    const player = state.players[playerId];
    const difficulty = player._difficulty || 'normal';
    
    if (state.mustDiscard > 0) {
        // Find the lowest value card to discard
        let worstCard = player.hand[0];
        let worstScore = 100;
        player.hand.forEach(c => {
            let s = c.data.value || 0;
            if (c.data.type === CARD_TYPES.PROPERTY) s += 10;
            if (c.data.type === CARD_TYPES.JOKER) s += 15;
            if (c.data.effect === 'just_say_no') s += 20;
            if (s < worstScore) {
                worstScore = s;
                worstCard = c;
            }
        });
        return { type: 'discard', cardId: worstCard.data.id };
    }

    const legal = actions || legalActionsFor(playerId, state);
    if (!legal || legal.length === 0) return null;

    if (difficulty === 'easy') {
        if (Math.random() < 0.4) {
            return legal[Math.floor(Math.random() * legal.length)];
        }
    }

    const play = pickBestPlayAction(legal, playerId, difficulty, state);
    const playScore = play ? scoreAction(play, playerId, difficulty, state) : -1;
    let propose = null;
    let proposeScore = -1;
    for (const a of legal) {
        if (a.type !== 'propose') continue;
        const s = scorePropose(a, playerId, difficulty, state);
        if (s > proposeScore) { propose = a; proposeScore = s; }
    }
    
    if (difficulty === 'hard') {
        const bestScore = Math.max(playScore, proposeScore);
        if (bestScore < 5 && Math.random() < 0.4) {
            return null; // hold weak cards
        }
    }

    return proposeScore > playScore ? propose : play;
}

function browserBotPolicy(state, playerId, legalActions) {
    if (!legalActions || legalActions.length === 0) return null;

    const player = state.players[playerId];
    const difficulty = player?._difficulty || 'normal';

    if (state.pendingAction) {
        const concede = legalActions.find(a => a.type === 'concede') || null;
        const noActions = legalActions.filter(a => a.type === 'react-no');
        if (!noActions.length) return concede;

        const pa = state.pendingAction;
        const bigDeal = ['deal_breaker', 'sly_deal', 'forced_deal'].includes(pa.card.data.effect);
        let shouldJSN = false;
        if (difficulty === 'easy') {
            shouldJSN = Math.random() < 0.2;
        } else if (difficulty === 'normal') {
            shouldJSN = bigDeal;
        } else if (difficulty === 'hard') {
            shouldJSN = bigDeal;
            if (!shouldJSN) {
                const mySets = Object.values(player.properties || {}).filter(arr => {
                    const color = arr[0]?.currentColor || arr[0]?.data.colorKey;
                    return color && arr.length >= (PROPERTIES[color]?.count || 3);
                }).length;
                shouldJSN = mySets >= 2;
            }
        }
        return shouldJSN ? noActions[0] : concede;
    }

    if (state.mustDiscard > 0) {
        return pickBestAction(playerId, state, legalActions);
    }

    const strategy = botStrategies.get(playerId);
    if (strategy) {
        try {
            const chosen = strategy(legalActions, state, playerId);
            if (chosen) return chosen;
        } catch (_e) {
            // Ignore custom strategy failures and fall back to built-in scoring.
        }
    }

    return pickBestAction(playerId, state, legalActions);
}

function playBotTurn() {
    if (activeNetGame) return;    // the server drives bots in net games
    if (isSoloControllerActive()) {
        activeLocalGame.advance();
        syncGameStateFromController();
        update();
        scheduleReactionHandling();
        return;
    }
    if (gameState._gameOver || gameState._isStressTest) return;
    if (Multiplayer.isClient) return;
    if (gameState.pendingAction !== null) {
        scheduleReactionHandling();
        return;
    }
    const botId = gameState.turn;
    if (botId === gameState.localPlayerId) return;
    // In MP: host only auto-plays disconnected seats; live peers self-drive.
    if (Multiplayer.isHost) {
        const turnPlayer = gameState.players[botId];
        if (turnPlayer && !turnPlayer._disconnected && !turnPlayer._isBot) return;
        // Disconnected human seat: just auto-end the turn (no actions).
        if (turnPlayer && turnPlayer._disconnected && !turnPlayer._isBot) {
            engineEndTurn();
            Multiplayer.broadcastAction({ type: 'end-turn' }, botId);
            broadcastSnapshot();
            update();
            scheduleBotIfNeeded();
            return;
        }
    }

    if (gameState.actionsLeft > 0) {
        const pick = botStrategies.has(botId) ? pickStrategyAction(botId) : pickBestAction(botId);
        if (pick) {
            const card = findHandCard(botId, pick.cardId);
            if (card) {
                const effect = card.data.effect;
                const difficulty = gameState.players[botId]._difficulty || 'normal';
                if (effect === 'deal_breaker') showBotBanner(botId, difficulty === 'hard' ? 'I claim this land as my own!' : 'That set looks better in my kingdom.');
                else if (effect === 'sly_deal') showBotBanner(botId, 'I will take that, thank you.');
                else if (effect === 'debt_collector') showBotBanner(botId, 'Treasury is looking low. Pay up!');
            }

            if (pick.type === 'play') {
                const card = findHandCard(botId, pick.cardId);
                if (card) {
                    if (pick.zone === 'discard') {
                        const effect = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
                        const isCharge = effect === 'collect_rent' || effect === 'birthday' || effect === 'debt_collector';
                        if (isCharge) {
                            // Route charging effects through proposeAction so human players
                            // get the interactive picker. actionsLeft decrements on resolve.
                            proposeAction(card, botId, pick.targetPlayerId, pick.options || {});
                            Multiplayer.broadcastAction(pick, botId);
                            update();
                            scheduleReactionHandling();
                            return;
                        }
                        executeAction(card, botId, pick.targetPlayerId, pick.options || {});
                    } else {
                        playCardToZone(card, pick.zone, botId, pick.options || {});
                        gameState.actionsLeft--;
                    }
                    console.log(`[NET-DEBUG] Bot actionsLeft after: ${gameState.actionsLeft}`);
                    Multiplayer.broadcastAction(pick, botId);
                }
            } else if (pick.type === 'propose') {
                const card = findHandCard(botId, pick.cardId);
                if (card) {
                    const opts = resolveProposeOptions(pick);
                    proposeAction(card, botId, pick.targetPlayerId, opts);
                    Multiplayer.broadcastAction(pick, botId);
                }
            }
            update();
            setTimeout(playBotTurn, 800);
            return;
        }
    }

    engineEndTurn();
    Multiplayer.broadcastAction({ type: 'end-turn' }, botId);
    broadcastSnapshot();
    update();
    scheduleBotIfNeeded();
}

function applyRemoteAction(action, playerId) {
    if (typeof playerId !== 'number') return;

    const postActionSync = () => {
        if (Multiplayer.isHost) broadcastSnapshot();
        update();
        scheduleReactionHandling();
    };

    if (action.type === 'react-no') {
        const card = gameState.players[playerId].hand.find(c => c.data.id === action.cardId);
        if (!card) return;
        const againstReactorId = (action.againstReactorId !== undefined) ? action.againstReactorId : null;
        reactJustSayNo(card, playerId, againstReactorId);
        postActionSync();
        return;
    }
    if (action.type === 'concede') {
        console.log(`[HOST-DEBUG] applyRemoteAction(concede) for playerId=${playerId}`);
        try {
            const pa = gameState.pendingAction;
            if (pa) {
                if (!pa.options) pa.options = {};
                if (!pa.options.alreadyPaidIds) pa.options.alreadyPaidIds = [];
                if (!pa.options.alreadyPaidIds.includes(playerId)) pa.options.alreadyPaidIds.push(playerId);

                if (action.paidCardIds && action.paidCardIds.length > 0) {
                    const payer = gameState.players[playerId];
                    const payee = gameState.players[pa.attackerId];
                    const paidIds = new Set(action.paidCardIds);
                    payer.bank.filter(c => paidIds.has(c.data.id)).forEach(c => {
                        payer.bank = payer.bank.filter(x => x !== c);
                        c.owner = pa.attackerId;
                        payee.bank.push(c);
                    });
                    for (const colorKey of Object.keys(payer.properties || {})) {
                        (payer.properties[colorKey] || []).filter(c => paidIds.has(c.data.id)).forEach(c => {
                            payer.properties[colorKey] = payer.properties[colorKey].filter(x => x !== c);
                            c.owner = pa.attackerId;
                            const color = c.currentColor || colorKey;
                            if (!payee.properties[color]) payee.properties[color] = [];
                            payee.properties[color].push(c);
                        });
                    }
                    for (const colorKey of Object.keys(payer.buildings || {})) {
                        (payer.buildings[colorKey] || []).filter(c => paidIds.has(c.data.id)).forEach(c => {
                            payer.buildings[colorKey] = payer.buildings[colorKey].filter(x => x !== c);
                            c.owner = pa.attackerId;
                            c.zone = 'bank';
                            payee.bank.push(c);
                        });
                    }
                }
                resolvePendingAction(playerId);
            }
            postActionSync();
        } catch (err) {
            console.error(`[HOST-DEBUG] Error in concede processing:`, err);
        }
        return;
    }
    if (action.type === 'end-turn') {
        engineEndTurn();
        postActionSync();
        scheduleBotIfNeeded();
        return;
    }
    if (action.type === 'swap-wild') {
        swapWildColor(playerId, action.cardId, action.color);
        postActionSync();
        return;
    }

    const card = findHandCard(playerId, action.cardId);
    if (!card) return;

    if (action.type === 'discard') {
        const p = gameState.players[playerId];
        p.hand = p.hand.filter(c => c !== card);
        card.zone = 'deck';
        card.owner = null;
        gameState.deck.unshift(card);
        if (gameState.mustDiscard > 0) gameState.mustDiscard--;
        postActionSync();
        return;
    }
    if (action.type === 'propose') {
        proposeAction(card, playerId, action.targetPlayerId, action.options || {});
        postActionSync();
        return;
    }
    if (action.type === 'play') {
        if (action.zone === 'discard') {
            const effect = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
            const isCharge = effect === 'collect_rent' || effect === 'birthday' || effect === 'debt_collector';
            if (isCharge) {
                proposeAction(card, playerId, action.targetPlayerId, action.options || {});
            } else {
                executeAction(card, playerId, action.targetPlayerId, action.options || {});
            }
        } else {
            playCardToZone(card, action.zone, playerId, action.options || {});
            gameState.actionsLeft--;
        }
        postActionSync();
    }
}

function showBanner(text) {
    const b = document.getElementById('turn-banner');
    b.textContent = text;
    b.style.opacity = 1;
    setTimeout(() => (b.style.opacity = 0), 1500);
}

function findCardAnywhere(cardId) {
    for (const p of gameState.players) {
        for (const list of [p.hand, p.bank, ...(Object.values(p.properties || {}))]) {
            const c = list.find(x => x.data.id === cardId);
            if (c) return c;
        }
    }
    return gameState.discard.find(c => c.data.id === cardId) || null;
}

function ensureModal() {
    let modal = document.getElementById('info-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'info-modal';
    modal.className = 'info-modal hidden';
    modal.addEventListener('click', (e) => {
        if (modal.dataset.modalKind === 'reaction') {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const act = btn.dataset.action;
            if (act === 'reaction-no') {
                const cardId = btn.dataset.cardId;
                const a = { type: 'react-no', cardId };
                if (btn.dataset.against !== undefined && btn.dataset.against !== '') {
                    a.againstReactorId = Number(btn.dataset.against);
                }
                dispatchAction(a);
            } else if (act === 'reaction-concede') {
                dispatchAction({ type: 'concede' });
            }
            return;
        }
        if (e.target === modal || e.target.dataset.action === 'close-modal') {
            modal.classList.add('hidden');
        }
    });
    document.body.appendChild(modal);
    return modal;
}

function hideModal() {
    const modal = document.getElementById('info-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.removeAttribute('data-modal-kind');
    }
}

/**
 * Tap-to-fire flow: when the local player taps an ACTION or RENT card in
 * hand, show a picker so they can fire its effect (vs. drag-to-bank to
 * just keep the value). Returns true when handled.
 */
function handleCardTap(cardId) {
    if (gameState.turn !== gameState.localPlayerId) return false;
    if (gameState.reactionTargetId !== null) return false;
    if (gameState.actionsLeft <= 0) return false;
    const card = findHandCard(gameState.localPlayerId, cardId);
    if (!card) return false;
    const t = card.data.type;
    if (t !== CARD_TYPES.ACTION && t !== CARD_TYPES.RENT && t !== CARD_TYPES.BUILDING) return false;
    if (card.data.effect === 'just_say_no') {
        flashHint('NOT TODAY! can only be played to cancel an action against you. Drag to bank if you want to bank it.');
        return true;
    }
    if (card.data.effect === 'forced_deal') {
        showForcedTradePicker(card);
        return true;
    }
    if (t === CARD_TYPES.BUILDING) {
        showBuildingPicker(card);
        return true;
    }
    showActionPicker(card);
    return true;
}

function showBuildingPicker(card) {
    const allActions = legalActionsFor(gameState.localPlayerId);
    const buildPlays = allActions.filter(a => a.cardId === card.data.id && a.type === 'play' && a.zone === 'board');
    if (buildPlays.length === 0) {
        flashHint(`${card.data.name} needs a completed set on your board first. Drag to bank if you want value.`);
        return;
    }
    showPickerModal(card, `Place ${card.data.name} on a completed set`, buildPlays.map(a => ({
        label: PROPERTIES[a.options.color]?.name || a.options.color,
        swatch: PROPERTIES[a.options.color]?.hex,
        onPick: () => dispatchAction(a),
    })));
}

function labelOpponent(id, isPossessive = false) {
    if (id === null || id === undefined) return isPossessive ? "everyone's" : 'everyone';
    if (id === gameState.localPlayerId) return isPossessive ? 'your' : 'you';
    const p = gameState.players[id];
    if (!p) return `Lord ${id}${isPossessive ? "'s" : ''}`;
    
    const name = p.name || `Lord ${p.id}`;
    const hasTitle = ['Lord', 'Lady', 'Sir', 'Baron', 'Duchess', 'Countess'].some(t => name.includes(t));
    const finalName = hasTitle ? name : `Lord ${name}`;
    
    return isPossessive ? `${finalName}'s` : finalName;
}

function labelProposeAction(card, action) {
    const opp = labelOpponent(action.targetPlayerId);
    const opts = action.options || {};
    const effect = card.data.effect;

    const oppPossessive = action.targetPlayerId === gameState.localPlayerId ? 'your' : `${opp}'s`;

    if (card.data.type === CARD_TYPES.RENT) {
        return `Charge ${opp} rent on ${PROPERTIES[opts.color]?.name || opts.color}`;
    }
    if (effect === 'sly_deal' || effect === 'deal_breaker') {
        const target = gameState.players[action.targetPlayerId];
        let targetCard = null;
        if (target) {
            for (const cards of Object.values(target.properties || {})) {
                const c = (cards || []).find(cc => cc.data.id === opts.targetCardId);
                if (c) { targetCard = c; break; }
            }
        }
        const propName = targetCard ? (targetCard.data.name || opts.color) : opts.color;
        return effect === 'deal_breaker'
            ? `Steal ${oppPossessive} complete ${propName} set`
            : `Steal ${propName} from ${opp}`;
    }
    if (effect === 'debt_collector') return `Demand 5g from ${opp}`;
    if (effect === 'birthday') return 'Every opponent pays you 2g';
    if (effect === 'pass_go') return 'Draw 2 cards';
    return `Target ${opp}`;
}

function showConfirmModal(card, title, prompt, onConfirm) {
    showPickerModal(card, title, [
        { label: prompt, onPick: onConfirm },
        { label: 'Cancel', onPick: () => {} },
    ]);
}

function payablePropertyCards(player) {
    const out = [];
    for (const colorKey of Object.keys(player.properties || {})) {
        const cards = player.properties[colorKey] || [];
        for (const c of cards) {
            if ((c.data.value || 0) > 0) out.push({ card: c, colorKey });
        }
    }
    return out;
}

function propertyLabel(entry) {
    const def = PROPERTIES[entry.colorKey] || {};
    const name = entry.card.data.name || def.name || entry.colorKey;
    return `${def.name || entry.colorKey} — ${name}`;
}

function showForcedTradePicker(card) {
    const me = gameState.players[gameState.localPlayerId];
    const tradeActions = legalActionsFor(gameState.localPlayerId)
        .filter(a => a.cardId === card.data.id && a.type === 'propose' && a.options?.myCardId && a.options?.targetCardId);
    const byMine = new Map();
    tradeActions.forEach(a => {
        if (!byMine.has(a.options.myCardId)) byMine.set(a.options.myCardId, []);
        byMine.get(a.options.myCardId).push(a);
    });
    const myChoices = Array.from(byMine.entries())
        .map(([myCardId, actions]) => ({ entry: findKingdomCard(me, myCardId), actions }))
        .filter(choice => choice.entry);
    if (myChoices.length === 0) {
        flashHint('FORCED TRADE needs an unfinished property of your own to swap.');
        return;
    }
    if (tradeActions.length === 0) {
        flashHint('No legal opponent property to trade for.');
        return;
    }

    showPickerModal(card, 'FORCED TRADE — pick one of YOUR properties', myChoices.map(myChoice => ({
        label: propertyLabel(myChoice.entry),
        swatch: PROPERTIES[myChoice.entry.colorKey]?.hex,
        onPick: () => {
            showPickerModal(card, `Trade your ${myChoice.entry.card.data.name} for…`, myChoice.actions.map(action => {
                const opp = gameState.players[action.targetPlayerId];
                const oppEntry = opp ? findKingdomCard(opp, action.options.targetCardId) : null;
                return {
                    label: oppEntry ? `${labelOpponent(action.targetPlayerId)}: ${propertyLabel(oppEntry)}` : labelOpponent(action.targetPlayerId),
                    swatch: oppEntry ? PROPERTIES[oppEntry.colorKey]?.hex : undefined,
                    onPick: () => dispatchAction(action),
                };
            }));
        },
    })));
}

function showActionPicker(card) {
    const allActions = legalActionsFor(gameState.localPlayerId);
    const effect = card.data.effect;

    if (effect === 'pass_go') {
        const playAction = allActions.find(a => a.cardId === card.data.id && a.type === 'play' && a.zone === 'discard');
        if (!playAction) {
            flashHint(`Cannot play ${card.data.name} right now.`);
            return;
        }
        showConfirmModal(card, 'Royal Charter', 'Draw 2 cards from the deck?', () => dispatchAction(playAction));
        return;
    }

    const cardActions = allActions.filter(a => a.cardId === card.data.id && a.type === 'propose');
    if (cardActions.length === 0) {
        flashHint(`No legal target for ${card.data.name}. Drag it to your bank to keep it for value.`);
        return;
    }
    if (effect === 'birthday') {
        showConfirmModal(card, 'Feast Day', 'Demand 2g from every rival?', () => dispatchAction(cardActions[0]));
        return;
    }
    if (effect === 'debt_collector') {
        showPickerModal(card, 'Demand 5g from which rival?', cardActions.map(a => ({
            label: labelOpponent(a.targetPlayerId),
            onPick: () => dispatchAction(a),
        })));
        return;
    }

    // Group rent actions by color and ask color first
    if (card.data.type === CARD_TYPES.RENT) {
        const colors = [...new Set(cardActions.map(a => a.options && a.options.color).filter(Boolean))];
        const isMulti = !!card.data.isMulti;
        showPickerModal(card, 'Choose color to charge', colors.map(c => ({
            label: PROPERTIES[c]?.name || c,
            swatch: PROPERTIES[c]?.hex,
            onPick: () => {
                const next = cardActions.filter(a => a.options.color === c);
                if (!isMulti) {
                    // Single/dual-color rent fans out to every opponent — no
                    // target-picking step. Fire the single null-target action.
                    dispatchAction(next[0]);
                    return;
                }
                showPickerModal(card, 'Choose opponent to charge', next.map(a => ({
                    label: labelOpponent(a.targetPlayerId),
                    onPick: () => dispatchAction(a),
                })));
            },
        })));
        return;
    }

    // Generic single-step picker
    showPickerModal(card, `Play ${card.data.name}`, cardActions.map(a => ({
        label: labelProposeAction(card, a),
        onPick: () => dispatchAction(a),
    })));
}

function showPickerModal(card, title, options) {
    const modal = ensureModal();
    modal.dataset.modalKind = 'picker';
    const optionsHtml = options.map((o, i) =>
        `<button class="picker-btn" data-picker-idx="${i}">` +
        (o.swatch ? `<span class="swatch" style="background:${o.swatch}"></span>` : '') +
        `${o.label}</button>`
    ).join('');
    modal.innerHTML = `
        <div class="info-modal-body">
            <button class="info-close" data-action="close-modal" aria-label="Close">×</button>
            <h2>${title}</h2>
            <p class="info-md">${card.data.name}</p>
            <div class="picker-options">${optionsHtml}</div>
        </div>
    `;
    modal.classList.remove('hidden');
    modal.onclick = (e) => {
        const btn = e.target.closest('[data-picker-idx]');
        if (btn) {
            const idx = Number(btn.dataset.pickerIdx);
            modal.classList.add('hidden');
            modal.onclick = null;
            options[idx].onPick();
            return;
        }
        if (e.target === modal || (e.target.dataset && e.target.dataset.action === 'close-modal')) {
            modal.classList.add('hidden');
            modal.onclick = null;
        }
    };
}

function describeResolution(r) {
    if (!r) return '';
    const me = gameState.localPlayerId;
    
    // Internal helpers for specific grammar cases
    const who = (id) => {
        if (id === null || id === undefined) return 'everyone';
        return id === me ? 'you' : labelOpponent(id);
    };
    const Who = (id) => {
        if (id === null || id === undefined) return 'Everyone';
        return id === me ? 'You' : labelOpponent(id);
    };
    const whose = (id) => {
        if (id === null || id === undefined) return "everyone's";
        return id === me ? 'your' : `${labelOpponent(id)}'s`;
    };
    
    if (r.effect === 'pass_go') {
        return r.playerId === me ? 'You drew 2 cards.' : `${Who(r.playerId)} drew 2 cards.`;
    }
    if (r.effect === 'debt_collector') {
        if (r.dryPayers > 0 && r.totalPaid === 0) {
            return `${Who(r.targetPlayerId)} had nothing to pay.`;
        }
        return `${Who(r.targetPlayerId)} paid ${who(r.playerId)} ${r.totalPaid}g.`;
    }
    if (r.effect === 'birthday') {
        if (r.totalPaid === 0) return `Nobody had coin to give to ${who(r.playerId)}!`;
        return `${Who(r.playerId)} collected ${r.totalPaid}g in tribute.`;
    }
    if (r.effect === 'collect_rent') {
        const colorName = r.color ? (PROPERTIES[r.color]?.name || r.color) : '';
        if (r.totalPaid === 0) return `No rent paid on ${colorName}.`;
        if (r.targetPlayerId !== null && r.targetPlayerId !== undefined) {
            return `${Who(r.targetPlayerId)} paid ${who(r.playerId)} ${r.totalPaid}g rent.`;
        }
        return `${Who(r.playerId)} collected ${r.totalPaid}g rent on ${colorName}.`;
    }
    if (r.effect === 'sly_deal') {
        return `${Who(r.playerId)} stole ${r.stolenCardName} from ${who(r.targetPlayerId)}.`;
    }
    if (r.effect === 'forced_deal') {
        return `${Who(r.playerId)} swapped ${r.gaveCardName} for ${whose(r.targetPlayerId)} ${r.gotCardName}.`;
    }
    if (r.effect === 'deal_breaker') {
        const colorName = r.color ? (PROPERTIES[r.color]?.name || r.color) : '';
        return `${Who(r.playerId)} stole ${whose(r.targetPlayerId)} ${colorName} set.`;
    }
    return '';
}

let _flashHintTimer = null;
function flashHint(text) {
    // Write directly to #hint-banner. If it hasn't been split out yet (game
    // hasn't rendered), fall back to #turn-banner.
    const hint = document.getElementById('hint-banner') || document.getElementById('turn-banner');
    if (!hint) return;
    hint.textContent = text;
    hint.style.opacity = 1;
    if (_flashHintTimer) clearTimeout(_flashHintTimer);
    _flashHintTimer = setTimeout(() => {
        hint.style.opacity = 0;
        // After the fade completes, clear text so a stale string doesn't
        // re-appear if something else flips opacity.
        setTimeout(() => {
            if (hint.style.opacity === '0' || Number(hint.style.opacity) === 0) {
                hint.textContent = '';
            }
        }, 400);
        _flashHintTimer = null;
    }, 2400);
}

function describePendingAction(pa) {
    const effect = pa.card.data.effect;
    const opts = pa.options || {};
    const isFanOut = pa.targetPlayerId === null || pa.targetPlayerId === undefined;
    
    // Logic for possessive and target names
    const targetIsLocal = pa.targetPlayerId === gameState.localPlayerId;
    const targetName = isFanOut ? 'everyone' : (targetIsLocal ? 'you' : labelOpponent(pa.targetPlayerId));
    const targetPossessive = isFanOut ? "everyone's" : (targetIsLocal ? 'your' : `${labelOpponent(pa.targetPlayerId)}'s`);

    const colorName = (c) => PROPERTIES[c]?.name || c;
    
    if (pa.card.data.type === CARD_TYPES.RENT) {
        return `to collect ${colorName(opts.color)} tribute from ${targetName}.`;
    }
    if (effect === 'deal_breaker') {
        return `to steal ${targetPossessive} complete ${colorName(opts.color)} set.`;
    }
    if (effect === 'sly_deal') {
        const targ = gameState.players[pa.targetPlayerId];
        let cardName = colorName(opts.color);
        if (targ) {
            for (const arr of Object.values(targ.properties || {})) {
                const c = (arr || []).find(cc => cc.data.id === opts.targetCardId);
                if (c) { cardName = `${colorName(opts.color)} (${c.data.name})`; break; }
            }
        }
        return `to steal ${targetPossessive} ${cardName}.`;
    }
    if (effect === 'forced_deal') {
        const myCard = opts.myCard || (opts.myCardId ? findCardAnywhere(opts.myCardId) : null);
        const targetCard = opts.targetCard || (opts.targetCardId ? findCardAnywhere(opts.targetCardId) : null);
        const myName = myCard?.data?.name || 'a property';
        const theirName = targetCard?.data?.name || 'one of your properties';
        return `to swap their ${myName} for ${targetPossessive} ${theirName}.`;
    }
    const attackerLabel = pa.attackerId === gameState.localPlayerId ? 'you' : labelOpponent(pa.attackerId);
    if (effect === 'debt_collector') return `to demand 5g from ${targetName}.`;
    if (effect === 'birthday') return `— every rival owes ${attackerLabel} 2g.`;
    if (effect === 'pass_go') return `so ${attackerLabel} can draw 2 cards.`;
    return '.';
}

function showReactionPrompt() {
    const pa = gameState.pendingAction;
    if (!pa) return;
    const localId = gameState.localPlayerId;
    const isAttacker = localId === pa.attackerId;
    const attackerName = pa.attackerId === localId ? 'You' : labelOpponent(pa.attackerId);
    const actionName = pa.card.data.name;
    const desc = (CARD_LIBRARY[actionName] && CARD_LIBRARY[actionName].desc) || '';
    const context = describePendingAction(pa);
    const local = gameState.players[localId];
    const noCard = local.hand.find(c => c.data.effect === 'just_say_no');
    const otherWaiting = gameState.pendingReactors.filter(r => r !== localId && r !== pa.attackerId).length;
    const subline = otherWaiting > 0
        ? `<p class="info-md" style="opacity:0.7;">${otherWaiting} other rival${otherWaiting === 1 ? '' : 's'} also considering their response.</p>`
        : '';

    const buttons = [];
    if (isAttacker) {
        const chainableRids = Object.keys(pa.chains)
            .map(k => Number(k))
            .filter(rid => !pa.chains[rid].settled && pa.chains[rid].chainCount % 2 === 1);
        if (noCard) {
            chainableRids.forEach(rid => {
                buttons.push(`<button class="reaction-btn no-btn" data-action="reaction-no" data-card-id="${noCard.data.id}" data-against="${rid}">NOT TODAY! vs ${labelOpponent(rid)}</button>`);
            });
        }
        buttons.push(`<button class="reaction-btn concede-btn" data-action="reaction-concede">Let it stand</button>`);
    } else {
        if (noCard) {
            buttons.push(`<button class="reaction-btn no-btn" data-action="reaction-no" data-card-id="${noCard.data.id}">NOT TODAY! (cancel)</button>`);
        }
        buttons.push(`<button class="reaction-btn concede-btn" data-action="reaction-concede">Accept</button>`);
    }
    const modal = ensureModal();
    modal.dataset.modalKind = 'reaction';
    modal.innerHTML = `
        <div class="info-modal-body reaction">
            <h2>${attackerName} plays ${actionName}!</h2>
            <p class="info-desc">Intent: ${context}</p>
            <p class="info-md">${desc}</p>
            ${subline}
            <div class="reaction-buttons">${buttons.join('')}</div>
        </div>
    `;
    modal.classList.remove('hidden');
}

let _infoFadeTimer = null;
function showCardInfo(cardId) {
    const card = findCardAnywhere(cardId);
    if (!card) return;
    const info = infoForCard(card);
    const modal = ensureModal();
    modal.dataset.modalKind = 'info';
    const value = info.value != null ? `<span class="info-value">${info.value}g</span>` : '';
    modal.innerHTML = `
        <div class="info-modal-body">
            <button class="info-close" data-action="close-modal" aria-label="Close">×</button>
            <h2 class="info-name">${info.name} ${value}</h2>
            ${info.md ? `<p class="info-md">aka <em>${info.md}</em></p>` : ''}
            <p class="info-desc">${info.desc || ''}</p>
        </div>
    `;
    modal.classList.remove('hidden');
    if (_infoFadeTimer) clearTimeout(_infoFadeTimer);
    _infoFadeTimer = setTimeout(() => {
        if (modal.dataset.modalKind === 'info' && !modal.classList.contains('hidden')) {
            modal.classList.add('hidden');
            modal.removeAttribute('data-modal-kind');
        }
        _infoFadeTimer = null;
    }, 3000);
}

function showGlossary() {
    const modal = ensureModal();
    const propRows = Object.entries(PROPERTIES).map(([k, p]) =>
        `<tr><td><span class="swatch" style="background:${p.hex}"></span>${p.name}</td><td>${p.count} for a set</td><td>${p.value}g each</td></tr>`
    ).join('');
    const actionRows = Object.entries(CARD_LIBRARY).map(([name, info]) =>
        `<tr><td>${name}</td><td><em>${info.md}</em></td><td>${info.desc}</td></tr>`
    ).join('');
    modal.innerHTML = `
        <div class="info-modal-body glossary">
            <button class="info-close" data-action="close-modal" aria-label="Close">×</button>
            <h2>Realm Guide</h2>
            <p class="info-hint">Long-press any card in the game for details.</p>
            <h3>Properties</h3>
            <table><tbody>${propRows}</tbody></table>
            <h3>Action / Rent / Building Cards</h3>
            <table><thead><tr><th>Realm Name</th><th>Monopoly Deal</th><th>Effect</th></tr></thead><tbody>${actionRows}</tbody></table>
        </div>
    `;
    modal.classList.remove('hidden');
}

init();

if (typeof window !== 'undefined') {
    window.__game = {
        state: () => publicState(),
        dispatch: dispatchAction,
        endTurn: onEndTurn,
        playBotTurn,
        enumerate: (pid) => legalActionsFor(pid),
        pickBest: (pid) => {
            const state = activeLocalGame ? activeLocalGame.peek() : gameState;
            return pickBestPlayAction(legalActionsFor(pid, state), pid, state.players[pid]?._difficulty || 'normal', state);
        },
        pickBestAny: (pid) => {
            const state = activeLocalGame ? activeLocalGame.peek() : gameState;
            return pickBestAction(pid, state, legalActionsFor(pid, state));
        },
        botReact,
        update,
        checkWinner: () => activeLocalGame ? activeLocalGame.winner() : checkWinner(),
        propose: (card, pid, tid, opts) => {
            if (isSoloControllerActive()) {
                if (pid === gameState.localPlayerId) {
                    submitSoloAction({ type: 'propose', cardId: card.data.id, targetPlayerId: tid, options: opts || {} });
                }
                return;
            }
            proposeAction(card, pid, tid, opts);
            update();
            scheduleReactionHandling();
        },
        setBotStrategy: (pid, fn) => {
            if (typeof fn === 'function') botStrategies.set(pid, fn);
            else botStrategies.delete(pid);
        },
        clearBotStrategies: () => botStrategies.clear(),
    };
}
