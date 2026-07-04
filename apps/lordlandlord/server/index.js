// server/index.js — the real WebSocket game server (Step 6b).
//
// One process hosts many rooms. Each room, once started, owns exactly one
// net/writer.js createWriter — the same authoritative writer the fake-hub
// tests proved out — behind a server-side channel that broadcasts Accepted
// frames to every seat socket and unicasts Snapshots to 'c'+seat.
//
// Frame routing: CONTROL frames carry key "t" (create/join/rejoin/add-bot/
// start/leave), GAME frames carry key "type" and are forwarded verbatim to the
// room writer — but ONLY when the sending connection is bound to the seat the
// frame claims (playerId for requests, seat for resume). Everything else is
// dropped with {t:'err'}.
//
// Hardening: unguessable room ids + seat tokens (node:crypto), JSON parse
// guard, ws maxPayload, per-connection token-bucket rate limit, room/conn
// caps, heartbeat ping/pong, empty-room reaping. All timers are configurable
// and unref()'d so embedding the server in tests never hangs the process.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { createWriter } from '../src/js/net/writer.js';
import { makeIdSource } from '../src/js/net/client.js';
import { enumerateLegalActions } from '../src/js/core/legal.js';
import { playerHasPendingReactionS } from '../src/js/engine.js';

const BOT_NAMES = [
    'Lord Pemberton', 'Lady Ashcroft', 'Baron Greycastle', 'Duchess Marlow',
    'Sir Hawthorne', 'Countess Wexley', 'Earl Brackenridge', 'Viscount Thornton',
    'Margrave Halloway'
];

const DEFAULTS = {
    port: Number(process.env.LL_WS_PORT) || 18181,
    maxRooms: 50,
    maxConns: 200,
    maxSeats: 6,
    maxPayload: 16384,
    rateLimit: { points: 30, windowMs: 1000 },
    heartbeatMs: 30000,
    emptyRoomTtlMs: 30 * 60 * 1000,
    reapIntervalMs: 60000,
    botStepCap: 500                   // max bot submissions between human actions
};

const newRoomId = () => randomBytes(9).toString('base64url');   // 12 url-safe chars
const newSeatToken = () => randomBytes(16).toString('hex');
const seatFromClientId = (clientId) => Number(String(clientId).slice(1));
const isOpen = (ws) => !!ws && ws.readyState === ws.OPEN;
const cleanName = (name, fallback) =>
    (typeof name === 'string' ? name.trim().slice(0, 32) : '') || fallback;

// Whose move it is, read from the writer's state — mirrors net/testing.js.
function pendingActor(s) {
    if (s.winner != null) return null;
    if (s.pendingAction) {
        const reactors = s.players.map(p => p.id)
            .filter(id => playerHasPendingReactionS(s, id));
        if (reactors.length === 0) return null;
        const seat = reactors.includes(s.reactionTargetId)
            ? s.reactionTargetId
            : reactors[0];
        return { seat, phase: 'react' };
    }
    if (s.mustDiscard > 0) return { seat: s.turn, phase: 'discard' };
    return { seat: s.turn, phase: 'turn' };
}

// Lowest-friction bot policy (ported from net/testing.js playOut's fallback,
// plus banking a card so bot turns aren't pure passes).
function pickBotAction(phase, legal) {
    if (phase === 'react') return legal.find(a => a.type === 'concede') || null;
    if (phase === 'discard') return legal.find(a => a.type === 'discard') || null;
    return legal.find(a => a.type === 'play' && a.zone === 'bank')
        || legal.find(a => a.type === 'end-turn')
        || null;
}

export async function createGameServer(opts = {}) {
    const cfg = {
        ...DEFAULTS,
        ...opts,
        rateLimit: { ...DEFAULTS.rateLimit, ...(opts.rateLimit || {}) }
    };

    const rooms = new Map();          // roomId -> room
    const wss = new WebSocketServer({ port: cfg.port, maxPayload: cfg.maxPayload });
    await new Promise((resolve, reject) => {
        wss.once('listening', resolve);
        wss.once('error', reject);
    });
    const port = wss.address().port;

    // ---- framing helpers ----------------------------------------------------

    function sendTo(ws, obj) {
        if (isOpen(ws)) ws.send(JSON.stringify(obj));
    }
    function sendErr(ws, code, message) {
        sendTo(ws, { t: 'err', code, message });
    }

    function roster(room) {
        const players = [];
        room.seats.forEach((s, seat) => {
            if (!s) return;
            players.push({
                seat,
                name: s.name,
                connected: s.isBot ? true : isOpen(s.ws),
                isBot: !!s.isBot
            });
        });
        return players;
    }

    function broadcastRoom(room) {
        const frame = { t: 'room', players: roster(room) };
        for (const s of room.seats) if (s && !s.isBot) sendTo(s.ws, frame);
    }

    // Track when a room last had any connected human, for reaping.
    function updatePresence(room) {
        const humans = room.seats.filter(s => s && !s.isBot);
        const anyConnected = humans.some(s => isOpen(s.ws));
        room.emptySince = (humans.length === 0 || !anyConnected)
            ? (room.emptySince ?? Date.now())
            : null;
    }

    function destroyRoom(room) {
        room.closed = true;
        if (room.channel) room.channel.close();
        for (const s of room.seats) {
            if (s && s.ws) {
                const conn = s.ws._conn;
                if (conn) { conn.room = null; conn.seat = null; }
                s.ws.close(4000, 'room-closed');
            }
        }
        rooms.delete(room.id);
    }

    // ---- writer channel (server side of the net-layer contract) -------------

    function makeWriterChannel(room) {
        let cb = null;
        return {
            // Broadcast (no target) → every connected seat socket; unicast
            // ('c'+seat) → that seat's CURRENT socket. Nothing is queued for a
            // disconnected seat: the resume path recovers it with a snapshot.
            send(msg, to) {
                if (to != null) {
                    const entry = room.seats[seatFromClientId(to)];
                    if (entry && isOpen(entry.ws)) entry.ws.send(JSON.stringify(msg));
                    return;
                }
                const text = JSON.stringify(msg);
                for (const entry of room.seats) {
                    if (entry && isOpen(entry.ws)) entry.ws.send(text);
                }
                scheduleBotStep(room);    // the game advanced: a bot may act next
            },
            onMessage(fn) { cb = fn; },
            close() { cb = null; },
            // Server-internal: hand a validated frame to the writer.
            deliver(msg) { if (cb) cb(msg); }
        };
    }

    // ---- bots ----------------------------------------------------------------

    function scheduleBotStep(room) {
        if (room.botScheduled || room.closed) return;
        room.botScheduled = true;
        const t = setImmediate(() => {
            room.botScheduled = false;
            stepBot(room);
        });
        if (typeof t.unref === 'function') t.unref();
    }

    function stepBot(room) {
        if (room.closed || !room.started || !room.writer) return;
        const s = room.writer.getState();
        const actor = pendingActor(s);
        if (!actor) { room.botSteps = 0; return; }
        const entry = room.seats[actor.seat];
        if (!entry || !entry.isBot) { room.botSteps = 0; return; }
        if (++room.botSteps > cfg.botStepCap) return;   // hard stop: a bug can't spin
        const action = pickBotAction(actor.phase, enumerateLegalActions(s, actor.seat));
        if (!action) return;
        room.channel.deliver({ ...action, id: entry.idSource(), playerId: actor.seat });
        scheduleBotStep(room);        // retry path if the reducer dropped it (capped)
    }

    // ---- control frames -------------------------------------------------------

    function handleCreate(ws, conn, msg) {
        if (conn.room) return sendErr(ws, 'bad-frame', 'already in a room');
        if (rooms.size >= cfg.maxRooms) return sendErr(ws, 'server-full', 'room limit reached');
        let id = newRoomId();
        while (rooms.has(id)) id = newRoomId();
        const room = {
            id,
            seats: [],
            started: false,
            writer: null,
            channel: null,
            emptySince: null,
            botScheduled: false,
            botSteps: 0,
            closed: false
        };
        rooms.set(id, room);
        bindSeat(ws, conn, room, 0, {
            name: cleanName(msg.name, 'Player 1'),
            token: newSeatToken(),
            isBot: false,
            ws: null
        });
    }

    function handleJoin(ws, conn, msg) {
        if (conn.room) return sendErr(ws, 'bad-frame', 'already in a room');
        const room = rooms.get(msg.roomId);
        if (!room) return sendErr(ws, 'bad-room', 'no such room');
        if (room.started) return sendErr(ws, 'already-started', 'game already started');
        const seat = freeSeat(room);
        if (seat == null) return sendErr(ws, 'room-full', 'no free seats');
        bindSeat(ws, conn, room, seat, {
            name: cleanName(msg.name, `Player ${seat + 1}`),
            token: newSeatToken(),
            isBot: false,
            ws: null
        });
    }

    function handleRejoin(ws, conn, msg) {
        if (conn.room) return sendErr(ws, 'bad-frame', 'already in a room');
        const room = rooms.get(msg.roomId);
        if (!room) return sendErr(ws, 'bad-room', 'no such room');
        const entry = room.seats[msg.seat];
        if (!entry || entry.isBot || !msg.seatToken || entry.token !== msg.seatToken) {
            return sendErr(ws, 'bad-token', 'seat token mismatch');
        }
        // Displace any previous socket on this seat (refresh / zombie tab).
        if (entry.ws && entry.ws !== ws) {
            const old = entry.ws._conn;
            if (old) { old.room = null; old.seat = null; }
            entry.ws.close(4001, 'displaced');
        }
        bindSeat(ws, conn, room, msg.seat, entry);
    }

    function freeSeat(room) {
        for (let i = 0; i < room.seats.length; i++) if (!room.seats[i]) return i;
        return room.seats.length < cfg.maxSeats ? room.seats.length : null;
    }

    function bindSeat(ws, conn, room, seat, entry) {
        entry.ws = ws;
        room.seats[seat] = entry;
        conn.room = room;
        conn.seat = seat;
        sendTo(ws, {
            t: 'joined',
            roomId: room.id,
            seat,
            seatToken: entry.token,
            started: room.started,
            players: roster(room)
        });
        // Post-start rejoin (page refresh): re-send the start frame so the
        // browser can rebuild the byte-identical v0 state before it asks the
        // writer for a catch-up snapshot. Without this a refreshed page has no
        // seed/players — and pure snapshot adoption breaks when the writer is
        // still at version 0 (v0 snapshot <= client's v0 is ignored).
        if (room.started) {
            sendTo(ws, { t: 'started', seed: room.seed, players: room.playersDesc });
        }
        updatePresence(room);
        broadcastRoom(room);
    }

    function handleAddBot(ws, conn) {
        const room = conn.room;
        if (!room) return sendErr(ws, 'bad-room', 'not in a room');
        if (conn.seat !== 0) return sendErr(ws, 'not-host', 'host only');
        if (room.started) return sendErr(ws, 'already-started', 'game already started');
        const seat = freeSeat(room);
        if (seat == null) return sendErr(ws, 'room-full', 'no free seats');
        const bots = room.seats.filter(s => s && s.isBot).length;
        room.seats[seat] = {
            name: BOT_NAMES[bots % BOT_NAMES.length],
            token: null,
            isBot: true,
            ws: null,
            idSource: null
        };
        broadcastRoom(room);
    }

    function handleStart(ws, conn) {
        const room = conn.room;
        if (!room) return sendErr(ws, 'bad-room', 'not in a room');
        if (conn.seat !== 0) return sendErr(ws, 'not-host', 'host only');
        if (room.started) return sendErr(ws, 'already-started', 'game already started');

        // Compact any pre-start leave holes so seats are contiguous 0..n-1.
        // Seats that move get a fresh 'joined' frame before 'started'.
        const compacted = room.seats.filter(Boolean);
        if (compacted.length !== room.seats.length) {
            room.seats = compacted;
            room.seats.forEach((entry, seat) => {
                if (entry.isBot || !entry.ws) return;
                const c = entry.ws._conn;
                if (c) c.seat = seat;
                sendTo(entry.ws, {
                    t: 'joined',
                    roomId: room.id,
                    seat,
                    seatToken: entry.token,
                    started: false,
                    players: roster(room)
                });
            });
        }
        if (room.seats.length < 2) return sendErr(ws, 'bad-frame', 'need at least 2 seats');

        const seed = randomBytes(4).readUInt32BE(0);
        const players = room.seats.map(s =>
            s.isBot ? { name: s.name, _isBot: true } : { name: s.name });
        room.seats.forEach((s, i) => {
            if (s.isBot) s.idSource = makeIdSource(`bot${i}`);
        });
        room.channel = makeWriterChannel(room);
        room.writer = createWriter({ seed, players, channel: room.channel });
        room.started = true;
        room.seed = seed;
        room.playersDesc = players;   // kept so post-start rejoins can rebuild v0

        const frame = { t: 'started', seed, players };
        for (const s of room.seats) if (s && !s.isBot) sendTo(s.ws, frame);
        scheduleBotStep(room);        // in case a bot ever holds the opening move
    }

    function handleLeave(ws, conn) {
        const room = conn.room;
        if (!room) return;            // leaving nothing is a no-op
        const entry = room.seats[conn.seat];
        if (entry && entry.ws === ws) {
            entry.ws = null;
            if (!room.started) room.seats[conn.seat] = null;   // free the seat pre-start
        }
        conn.room = null;
        conn.seat = null;
        updatePresence(room);
        broadcastRoom(room);
    }

    function handleControl(ws, conn, msg) {
        switch (msg.t) {
            case 'create': return handleCreate(ws, conn, msg);
            case 'join': return handleJoin(ws, conn, msg);
            case 'rejoin': return handleRejoin(ws, conn, msg);
            case 'add-bot': return handleAddBot(ws, conn);
            case 'start': return handleStart(ws, conn);
            case 'leave': return handleLeave(ws, conn);
            default: return sendErr(ws, 'bad-frame', `unknown control type '${msg.t}'`);
        }
    }

    // ---- game frames ------------------------------------------------------------

    function handleGame(ws, conn, msg) {
        const room = conn.room;
        if (!room || conn.seat == null) return sendErr(ws, 'bad-frame', 'not seated');
        if (!room.started) return sendErr(ws, 'not-started', 'game not started');
        if (msg.type === 'resume') {
            if (msg.seat !== conn.seat) {
                return sendErr(ws, 'bad-frame', 'resume seat does not match bound seat');
            }
            msg.clientId = 'c' + conn.seat;    // normalise to the wire convention
        } else if (msg.playerId !== conn.seat) {
            return sendErr(ws, 'bad-frame', 'playerId does not match bound seat');
        } else {
            room.botSteps = 0;                 // a human acted: reset the bot budget
        }
        room.channel.deliver(msg);
    }

    // ---- per-connection plumbing ----------------------------------------------

    function allowFrame(conn) {
        const { points, windowMs } = cfg.rateLimit;
        const now = Date.now();
        conn.tokens = Math.min(points, conn.tokens + ((now - conn.lastRefill) * points) / windowMs);
        conn.lastRefill = now;
        if (conn.tokens < 1) return false;
        conn.tokens -= 1;
        return true;
    }

    wss.on('connection', (ws) => {
        if (wss.clients.size > cfg.maxConns) {
            sendErr(ws, 'server-full', 'connection limit reached');
            ws.close(1013, 'server-full');
            return;
        }
        const conn = {
            room: null,
            seat: null,
            badFrames: 0,
            tokens: cfg.rateLimit.points,
            lastRefill: Date.now()
        };
        ws._conn = conn;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', () => { /* maxPayload overflow etc.; 'close' follows */ });

        ws.on('message', (data) => {
            if (!allowFrame(conn)) {
                sendErr(ws, 'rate-limited', 'too many frames');
                ws.close(1008, 'rate-limited');
                return;
            }
            let msg;
            try {
                msg = JSON.parse(data.toString());
                if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('not an object');
            } catch {
                conn.badFrames++;
                sendErr(ws, 'bad-frame', 'invalid JSON frame');
                if (conn.badFrames > 1) ws.close(1008, 'bad-frame');
                return;
            }
            if (typeof msg.t === 'string') handleControl(ws, conn, msg);
            else handleGame(ws, conn, msg);
        });

        ws.on('close', () => {
            const room = conn.room;
            if (!room) return;
            const entry = room.seats[conn.seat];
            if (entry && entry.ws === ws) entry.ws = null;   // seat survives for rejoin
            conn.room = null;
            conn.seat = null;
            if (!room.closed) {
                updatePresence(room);
                broadcastRoom(room);
            }
        });
    });

    // ---- timers -------------------------------------------------------------------

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (ws.isAlive === false) { ws.terminate(); continue; }
            ws.isAlive = false;
            ws.ping();
        }
    }, cfg.heartbeatMs);
    heartbeat.unref();

    const reaper = setInterval(() => {
        const now = Date.now();
        for (const room of [...rooms.values()]) {
            if (room.emptySince != null && now - room.emptySince >= cfg.emptyRoomTtlMs) {
                destroyRoom(room);
            }
        }
    }, cfg.reapIntervalMs);
    reaper.unref();

    // ---- public surface -------------------------------------------------------------

    return {
        port,
        getRoom(roomId) {
            const room = rooms.get(roomId);
            if (!room) return null;
            return { writer: room.writer, seats: room.seats, started: room.started };
        },
        close() {
            clearInterval(heartbeat);
            clearInterval(reaper);
            for (const room of [...rooms.values()]) destroyRoom(room);
            for (const ws of wss.clients) ws.terminate();
            return new Promise((resolve) => wss.close(() => resolve()));
        }
    };
}

// Run directly: `node server/index.js` (or npm run serve:ws).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    createGameServer().then(
        (s) => console.log(`lordlandlord ws server listening on :${s.port}`),
        (err) => { console.error('failed to start:', err.message); process.exit(1); }
    );
}
