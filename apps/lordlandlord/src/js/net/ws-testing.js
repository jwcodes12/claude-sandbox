// net/ws-testing.js — the makeGame() harness rebuilt over the REAL WebSocket
// server (server/index.js) instead of the fake in-process hub.
//
// makeWsGame boots createGameServer on port:0, creates a room and claims every
// human seat through the real wire contract (create/join/add-bot/start), wires
// one net/client.js createClient per human seat over a real "ws" socket, and
// exposes the same surface the fake-hub suites use — plus the async pieces a
// real transport needs (settle() instead of flush(), partition()/rejoin()).
//
// IMPORTANT: the server mints its OWN seed at 'start' (createGameServer has no
// seed override), so the harness reads the authoritative seed + player
// descriptors from the {t:'started'} frame and builds every client's v0 state
// from those. Tests must therefore assert transport invariants (convergence,
// idempotency, exactly-once) — never fixed-deck contents.
//
// vitest runs in jsdom, so this file uses the node "ws" package client
// explicitly (never a global browser WebSocket).

import WebSocket from 'ws';
import { createGameServer } from '../../../server/index.js';
import { createClient, makeIdSource } from './client.js';
import { request, actionFromRequest } from './protocol.js';
import { createInitialState } from '../core/state.js';
import { enumerateLegalActions } from '../core/legal.js';
import { reduce } from '../core/reducer.js';
import { playerHasPendingReactionS } from '../engine.js';

// Would `action`, submitted by `seat`, actually apply on `state`? Validated on
// the action AS THE WIRE DELIVERS IT (request → actionFromRequest strips any
// field outside the protocol whitelist — e.g. a swap-wild's `color` — exactly
// as the real writer will see it), because the writer silently drops reducer
// no-ops and a test awaiting a version bump for one would wedge.
export function wireApplies(state, seat, action) {
    if (!action) return false;
    const wired = actionFromRequest(request({ id: '__probe__', playerId: seat, ...action }));
    return reduce(state, wired) !== state;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll `fn` until truthy; throws on timeout so a wedged test fails loudly
// instead of hanging into vitest's own timeout.
export async function waitUntil(fn, { timeoutMs = 5000, intervalMs = 2, what = 'condition' } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() >= until) throw new Error(`waitUntil: timed out waiting for ${what}`);
        await sleep(intervalMs);
    }
}

// A raw socket wrapper over the node "ws" client. Control frames (key "t")
// land in a queue awaitable via next(); game frames (key "type") are handed to
// whatever channel shell is attached via `gameCb`.
export function connectSocket(port) {
    return new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const node = {
            sock,
            control: [],
            gameCb: null,
            closed: new Promise((res) => sock.on('close', (code) => res(code))),
            send: (obj) => sock.send(JSON.stringify(obj)),
            async next(t, timeoutMs = 3000) {
                await waitUntil(
                    () => node.control.some((m) => m.t === t),
                    { timeoutMs, what: `control frame '${t}'` }
                );
                const i = node.control.findIndex((m) => m.t === t);
                return node.control.splice(i, 1)[0];
            }
        };
        sock.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (typeof msg.t === 'string') node.control.push(msg);
            else if (node.gameCb) node.gameCb(msg);
        });
        sock.on('open', () => {
            sock.on('error', () => {});   // post-open errors surface as 'close'
            resolve(node);
        });
        sock.on('error', reject);
    });
}

// Channel adapter for net/client.js over a swappable socket, so one client
// object survives partition + rejoin onto a fresh socket.
function makeShell() {
    let cb = null;
    let node = null;
    return {
        attach(n) { node = n; n.gameCb = (m) => { if (cb) cb(m); }; },
        send(msg) { if (node && node.sock.readyState === WebSocket.OPEN) node.send(msg); },
        onMessage(fn) { cb = fn; },
        close() { if (node) node.sock.close(); }
    };
}

// Phase-appropriate fallback action (identical to net/testing.js playOut).
function defaultFor(phase, legal) {
    if (phase === 'react') return legal.find(a => a.type === 'concede') || null;
    if (phase === 'discard') return legal.find(a => a.type === 'discard') || null;
    return legal.find(a => a.type === 'end-turn') || null;
}

// makeWsGame — the real-transport analogue of net/testing.js makeGame.
//
//   seed        accepted for surface parity but ONLY used as a hint: the server
//               mints its own seed; the game handle's `.seed` is the real one.
//   players     a count or an array of descriptors with .name.
//   humanSeats  array of seat indices to claim with real sockets (default: all).
//               Seat 0 must be human (the host creates the room); every other
//               seat not listed is filled with a server bot via {t:'add-bot'}.
//   serverOpts  extra createGameServer options (deep-merged over the shrunk
//               test defaults below).
export async function makeWsGame({ seed, players = 3, humanSeats = null, serverOpts = {} } = {}) {
    void seed; // surface parity with makeGame; the server mints the real seed
    const playerCount = typeof players === 'number' ? players : (players || []).length;
    const names = [];
    for (let i = 0; i < playerCount; i++) {
        const d = Array.isArray(players) ? players[i] : null;
        names[i] = (d && d.name) || `P${i}`;
    }
    const humans = new Set(humanSeats == null
        ? Array.from({ length: playerCount }, (_, i) => i)
        : humanSeats);
    if (!humans.has(0)) throw new Error('makeWsGame: seat 0 must be human (the host creates the room)');

    const server = await createGameServer({
        port: 0,
        // shrunk/loosened for tests: generous rate limit (playOut drives fast),
        // quick reaping never fires inside a test, heartbeat stays unref'd.
        rateLimit: { points: 5000, windowMs: 1000 },
        heartbeatMs: 10000,
        emptyRoomTtlMs: 60000,
        reapIntervalMs: 60000,
        ...serverOpts
    });
    const port = server.port;

    const sockets = [];     // per-seat node wrapper (null for bot seats)
    const shells = [];      // per-seat swappable channel (null for bot seats)
    const seatTokens = [];  // per-seat token (null for bot seats)

    try {
        // Host creates → seat 0. Then claim seats 1..n-1 in order; the server's
        // freeSeat() is strictly sequential pre-start, so seat numbers line up.
        const host = await connectSocket(port);
        host.send({ t: 'create', name: names[0] });
        const j0 = await host.next('joined');
        const roomId = j0.roomId;
        sockets[0] = host;
        seatTokens[0] = j0.seatToken;

        for (let s = 1; s < playerCount; s++) {
            if (humans.has(s)) {
                const node = await connectSocket(port);
                node.send({ t: 'join', roomId, name: names[s] });
                const j = await node.next('joined');
                if (j.seat !== s) throw new Error(`makeWsGame: expected seat ${s}, got ${j.seat}`);
                sockets[s] = node;
                seatTokens[s] = j.seatToken;
            } else {
                host.send({ t: 'add-bot' });
                await waitUntil(
                    () => server.getRoom(roomId)?.seats[s]?.isBot,
                    { what: `bot in seat ${s}` }
                );
                sockets[s] = null;
                seatTokens[s] = null;
            }
        }

        // Start. The server mints the seed and broadcasts the EXACT descriptor
        // array it passed to createInitialState — that pair is our v0 truth.
        host.send({ t: 'start' });
        const started = await host.next('started');
        for (let s = 1; s < playerCount; s++) {
            if (sockets[s]) {
                const other = await sockets[s].next('started');
                if (other.seed !== started.seed) throw new Error('makeWsGame: seed mismatch across started frames');
            }
        }

        const clients = [];
        for (let s = 0; s < playerCount; s++) {
            if (!sockets[s]) { shells[s] = null; clients[s] = null; continue; }
            shells[s] = makeShell();
            shells[s].attach(sockets[s]);
            clients[s] = createClient({
                seat: s,
                channel: shells[s],
                state: createInitialState(started.seed, started.players),
                clientId: 'c' + s,
                idSource: makeIdSource('c' + s)
            });
        }

        const writer = server.getRoom(roomId).writer;
        const humanClients = () => clients.filter(Boolean);

        const hashes = () => [writer.hashOf(), ...humanClients().map(c => c.hashOf())];
        const converged = () => {
            const [w, ...cs] = hashes();
            return cs.every(h => h === w);
        };

        // Whose move it is, read from the WRITER's state (source of truth) —
        // identical logic to net/testing.js.
        function pendingActor() {
            const s = writer.getState();
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

        const legalFor = (seat) => enumerateLegalActions(writer.getState(), seat);

        // flush() analogue: poll until the writer + every human client hash is
        // stable across two consecutive `intervalMs` checks. Stability — NOT
        // convergence — is the exit condition, so a deliberately-partitioned
        // client (frozen hash) never blocks settle().
        async function settle({ timeoutMs = 5000, intervalMs = 25 } = {}) {
            const fingerprint = () => JSON.stringify([
                writer.getVersion(), writer.hashOf(),
                ...humanClients().map(c => [c.getVersion(), c.hashOf()])
            ]);
            const until = Date.now() + timeoutMs;
            let prev = fingerprint();
            for (;;) {
                await sleep(intervalMs);
                const cur = fingerprint();
                if (cur === prev) return;
                if (Date.now() >= until) throw new Error('settle: state never stabilised');
                prev = cur;
            }
        }

        // Drive the game to completion (or maxSteps) via a policy, exactly like
        // testing.js playOut but async over the real wire. Two real-transport
        // adaptations:
        //   - Bot seats are the SERVER's to play: we just wait for it to move.
        //   - The writer silently drops reducer no-ops, and enumerateLegalActions
        //     can offer actions reduce() rejects. On the fake hub a dropped step
        //     just re-runs the (stateful) policy; over real sockets waiting on a
        //     version bump that never comes would wedge. So each candidate is
        //     pre-validated against the authoritative state via reduce(), and a
        //     rejected pick RE-ASKS the policy (advancing its rng exactly like a
        //     dropped fake-hub step) rather than substituting a fixed action —
        //     substitution was measured to livelock some seeds.
        async function playOut({ policy = null, maxSteps = 2000 } = {}) {
            let steps = 0;
            while (steps++ < maxSteps) {
                const actor = pendingActor();
                if (!actor) break;
                const { seat, phase } = actor;

                if (!clients[seat]) {
                    // Server-driven bot seat: wait for the server to advance it.
                    const v = writer.getVersion();
                    try {
                        await waitUntil(() => {
                            const a = pendingActor();
                            return writer.getVersion() > v || !a || a.seat !== seat;
                        }, { timeoutMs: 3000, what: `bot seat ${seat} to act` });
                    } catch {
                        break;  // bot wedged (defensive); let the test assert
                    }
                    continue;
                }

                const st = writer.getState();
                const legal = legalFor(seat);
                const applies = (a) => wireApplies(st, seat, a);
                let action = null;
                for (let tries = 0; tries < 40 && !action; tries++) {
                    const cand = (policy ? policy(st, seat, legal) : null) || defaultFor(phase, legal);
                    if (applies(cand)) action = cand;
                    if (!policy) break;   // no rng to advance; retrying is pointless
                }
                if (!action) {
                    const d = defaultFor(phase, legal);
                    action = applies(d) ? d : (legal.find(applies) || null);
                }
                if (!action) break; // nothing applicable (defensive; shouldn't happen)

                const target = writer.getVersion() + 1;
                clients[seat].submit(action);
                await waitUntil(() => writer.getVersion() >= target,
                    { timeoutMs: 4000, what: `writer to reach v${target}` });
            }
            // Let every (connected) mirror catch up before returning.
            await settle();
            return writer.getState();
        }

        // Kill a seat's socket without a clean leave (wifi blip / crashed tab).
        function partition(seat) {
            if (!sockets[seat]) throw new Error(`partition: seat ${seat} has no socket`);
            sockets[seat].sock.terminate();
        }

        // Fresh socket + {t:'rejoin'} with the seat token, swap it into the
        // seat's shell, then client.reconnect() → resume → snapshot adoption.
        async function rejoin(seat) {
            const node = await connectSocket(port);
            node.send({ t: 'rejoin', roomId, seat, seatToken: seatTokens[seat] });
            const j = await node.next('joined');
            if (j.seat !== seat) throw new Error(`rejoin: expected seat ${seat}, got ${j.seat}`);
            sockets[seat] = node;
            shells[seat].attach(node);
            clients[seat].reconnect();
            return node;
        }

        // Fire a raw frame (game or control object) down a seat's CURRENT socket.
        const sendRaw = (seat, frame) => sockets[seat].send(frame);

        async function close() {
            for (const n of sockets) if (n) n.sock.terminate();
            await server.close();
        }

        return {
            server, port, roomId,
            seed: started.seed,
            players: started.players,
            seatTokens, sockets, shells, clients, writer,
            hashes, converged, pendingActor, legalFor,
            settle, waitUntil, playOut, partition, rejoin, sendRaw, close
        };
    } catch (err) {
        for (const n of sockets) if (n) n.sock.terminate();
        await server.close();
        throw err;
    }
}
