// net/ws-transport.js — browser-side WebSocket session for the game server.
//
// One createWsSession manages ONE WebSocket to server/index.js and splits its
// frames into two worlds:
//   CONTROL frames (key "t")   → session events (onJoined/onRoom/onStarted/
//                                 onError), lobby management.
//   GAME frames   (key "type") → the channel() adapter, which implements the
//                                 exact { send, onMessage, close } interface
//                                 net/client.js expects, plus an afterMessage
//                                 hook the app uses to re-render after every
//                                 applied frame.
//
// Reconnect: on an unexpected close the session backs off exponentially
// (0.5s → 8s cap), reopens, and re-sends {t:'rejoin'} with the stored
// {roomId, seat, seatToken}. When the server confirms the rejoin (a fresh
// 'joined' frame), onRejoined fires — post-start the app must then call
// netClient.reconnect() so the writer unicasts a catch-up snapshot.
//
// All control sends are fire-and-forget; frames sent while the socket is not
// yet open are queued and flushed on open (after the rejoin, so the seat
// binding exists before any queued game frame arrives at the server).

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8000;

export function createWsSession({ url }) {
    if (!url) throw new Error('createWsSession: url is required');

    let ws = null;
    let status = 'connecting';          // 'connecting' | 'open' | 'reconnecting' | 'closed'
    let creds = null;                   // { roomId, seat, seatToken } once joined
    let expectRejoin = false;           // the next 'joined' frame answers a rejoin
    let manualClose = false;            // leave()/close(): do not auto-reconnect
    let backoffMs = BACKOFF_MIN_MS;
    let reconnectTimer = null;
    const outbox = [];                  // frames queued while the socket is not open

    const listeners = {
        joined: [], room: [], started: [], error: [], status: [], rejoined: []
    };
    let gameCb = null;                  // channel onMessage (net/client.js)
    const afterCbs = [];                // channel afterMessage hooks

    function emit(kind, ...args) {
        for (const fn of listeners[kind]) {
            try { fn(...args); } catch (e) { console.error(`[ws-session] ${kind} listener failed`, e); }
        }
    }

    function setStatus(next) {
        if (status === next) return;
        status = next;
        emit('status', next);
    }

    function rawSend(frame) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(frame));
        } else if (!manualClose) {
            outbox.push(frame);
        }
    }

    function flushOutbox() {
        while (outbox.length && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(outbox.shift()));
        }
    }

    function handleFrame(raw) {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (typeof msg.t === 'string') {                 // CONTROL frame
            switch (msg.t) {
                case 'joined': {
                    creds = { roomId: msg.roomId, seat: msg.seat, seatToken: msg.seatToken };
                    backoffMs = BACKOFF_MIN_MS;          // successful (re)bind resets backoff
                    const wasRejoin = expectRejoin;
                    expectRejoin = false;
                    emit('joined', msg);
                    if (wasRejoin) emit('rejoined', msg);
                    return;
                }
                case 'room': return emit('room', msg.players || [], msg);
                case 'started': return emit('started', msg);
                case 'err': return emit('error', msg);
                default: return;                          // unknown control: ignore
            }
        }

        if (typeof msg.type === 'string') {              // GAME frame
            if (gameCb) gameCb(msg);
            for (const fn of afterCbs) {
                try { fn(msg); } catch (e) { console.error('[ws-session] afterMessage failed', e); }
            }
        }
    }

    function open() {
        ws = new WebSocket(url);
        ws.onopen = () => {
            setStatus('open');
            if (creds) {                                 // rebind our seat before anything else
                expectRejoin = true;
                ws.send(JSON.stringify({
                    t: 'rejoin',
                    roomId: creds.roomId,
                    seat: creds.seat,
                    seatToken: creds.seatToken
                }));
            }
            flushOutbox();
        };
        ws.onmessage = (ev) => handleFrame(ev.data);
        ws.onerror = () => { /* 'close' always follows; reconnect handles it */ };
        ws.onclose = () => {
            ws = null;
            if (manualClose) { setStatus('closed'); return; }
            setStatus('reconnecting');
            const delay = backoffMs;
            backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
            reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, delay);
        };
    }

    open();

    const on = (kind) => (cb) => { if (typeof cb === 'function') listeners[kind].push(cb); };

    // The channel net/client.js plugs into. Client → writer only ever
    // broadcasts (no unicast target from the browser side).
    const channelObj = {
        send(msg) { rawSend(msg); },
        onMessage(cb) { gameCb = cb; },
        afterMessage(cb) { if (typeof cb === 'function') afterCbs.push(cb); },
        close() { gameCb = null; afterCbs.length = 0; }
    };

    return {
        // ---- control API (fire-and-forget; responses arrive as events) ----
        create(name) { rawSend({ t: 'create', name }); },
        join(roomId, name) { rawSend({ t: 'join', roomId, name }); },
        rejoin(roomId, seat, seatToken) {
            creds = { roomId, seat, seatToken };
            expectRejoin = true;
            // Only send on an open socket — open() already sends a rejoin from
            // creds, so queueing here would double-bind (server: 'bad-frame').
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ t: 'rejoin', roomId, seat, seatToken }));
            }
        },
        addBot() { rawSend({ t: 'add-bot' }); },
        start() { rawSend({ t: 'start' }); },
        leave() {
            rawSend({ t: 'leave' });
            creds = null;
        },

        // ---- events ----
        onJoined: on('joined'),
        onRoom: on('room'),
        onStarted: on('started'),
        onError: on('error'),
        onStatus: on('status'),
        onRejoined: on('rejoined'),

        // ---- game channel + introspection ----
        channel() { return channelObj; },
        getStatus() { return status; },
        getCreds() { return creds ? { ...creds } : null; },

        // Tear the session down for good (no auto-reconnect afterwards).
        close() {
            manualClose = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            if (ws) ws.close();
            else setStatus('closed');
        }
    };
}
