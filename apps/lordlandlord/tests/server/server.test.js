// tests/server/server.test.js — the real WebSocket server over real sockets.
//
// vitest runs in jsdom, so we explicitly use the node "ws" package client
// (NOT a browser/global WebSocket). Each test boots the server on port:0 with
// shrunk limits where the test needs them, and closes it afterwards.

import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createGameServer } from '../../server/index.js';
import { createClient, makeIdSource } from '../../src/js/net/client.js';
import { createInitialState } from '../../src/js/core/state.js';
import { enumerateLegalActions } from '../../src/js/core/legal.js';

const servers = [];
afterEach(async () => {
    while (servers.length) await servers.pop().close();
});

async function boot(opts = {}) {
    const server = await createGameServer({ port: 0, ...opts });
    servers.push(server);
    return server;
}

// A raw socket wrapper: control frames (key "t") land in a queue we can await;
// game frames (key "type") are handed to whatever channel is attached.
function connect(port) {
    return new Promise((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${port}`);
        const node = {
            sock,
            control: [],
            gameCb: null,
            closed: new Promise((res) => sock.on('close', (code) => res(code))),
            send: (obj) => sock.send(JSON.stringify(obj)),
            async next(t, timeout = 2000) {
                const until = Date.now() + timeout;
                while (Date.now() < until) {
                    const i = node.control.findIndex((m) => m.t === t);
                    if (i >= 0) return node.control.splice(i, 1)[0];
                    await sleep(5);
                }
                throw new Error(`timed out waiting for control frame '${t}'`);
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

// Channel adapter for net/client.js over a node ws socket. The underlying
// socket is swappable (attach) so a client survives a reconnect to a new one.
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 4000, what = 'condition') {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
        if (fn()) return;
        await sleep(5);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// Boot a room with two connected humans and started game + net clients wired
// over the real sockets. Returns everything the game tests need.
async function startTwoHumanGame(server) {
    const a = await connect(server.port);
    a.send({ t: 'create', name: 'Alice' });
    const ja = await a.next('joined');

    const b = await connect(server.port);
    b.send({ t: 'join', roomId: ja.roomId, name: 'Bob' });
    const jb = await b.next('joined');

    a.send({ t: 'start' });
    const sa = await a.next('started');
    const sb = await b.next('started');
    expect(sb.seed).toBe(sa.seed);
    expect(sb.players).toEqual(sa.players);

    const shells = [makeShell(), makeShell()];
    shells[0].attach(a);
    shells[1].attach(b);
    const clients = [0, 1].map((seat) => createClient({
        seat,
        channel: shells[seat],
        state: createInitialState(sa.seed, sa.players),
        clientId: 'c' + seat,
        idSource: makeIdSource('c' + seat)
    }));

    const writer = server.getRoom(ja.roomId).writer;
    return { a, b, ja, jb, shells, clients, writer, roomId: ja.roomId };
}

// Play one step through the pending seat's client: bank a card when legal,
// else discard/end-turn. (Bank plays never open a reaction window, so the
// pending actor is always state.turn here.)
function stepAction(writer) {
    const s = writer.getState();
    if (s.winner != null) return null;
    const seat = s.turn;
    const legal = enumerateLegalActions(s, seat);
    const action = (s.mustDiscard > 0)
        ? legal.find((x) => x.type === 'discard')
        : (legal.find((x) => x.type === 'play' && x.zone === 'bank')
            || legal.find((x) => x.type === 'end-turn'));
    return action ? { seat, action } : null;
}

// Wait until the writer has applied up to `version` and every client mirrors
// it. (Waiting on a TARGET version matters: right after submit() the frame is
// still in flight, and "clients equal writer" is trivially true at the old
// version.)
async function converge(writer, clients, version) {
    await waitFor(
        () => writer.getVersion() >= version
            && clients.every((c) => c.getVersion() === writer.getVersion()),
        4000,
        `everyone to reach version ${version}`
    );
}

describe('room lifecycle', () => {
    it('create/join/rejoin happy path with seat-token auth', async () => {
        const server = await boot();
        const a = await connect(server.port);
        a.send({ t: 'create', name: 'Alice' });
        const ja = await a.next('joined');
        expect(ja.seat).toBe(0);
        expect(ja.started).toBe(false);
        expect(ja.roomId.length).toBeGreaterThanOrEqual(12);
        expect(ja.seatToken).toMatch(/^[0-9a-f]{32}$/);

        const b = await connect(server.port);
        b.send({ t: 'join', roomId: ja.roomId, name: 'Bob' });
        const jb = await b.next('joined');
        expect(jb.seat).toBe(1);

        const roomFrame = await a.next('room');
        expect(server.getRoom(ja.roomId).started).toBe(false);
        expect(roomFrame.players.length).toBeGreaterThanOrEqual(1);

        // Rejoin with the right token displaces the old socket on that seat.
        const b2 = await connect(server.port);
        b2.send({ t: 'rejoin', roomId: ja.roomId, seat: 1, seatToken: jb.seatToken });
        const jb2 = await b2.next('joined');
        expect(jb2.seat).toBe(1);
        expect(jb2.seatToken).toBe(jb.seatToken);
        await b.closed;   // displaced

        // Unknown room id is rejected.
        const c = await connect(server.port);
        c.send({ t: 'join', roomId: 'nope-nope-nope', name: 'Eve' });
        expect((await c.next('err')).code).toBe('bad-room');
    });

    it('rejoin with a wrong token is rejected with bad-token', async () => {
        const server = await boot();
        const a = await connect(server.port);
        a.send({ t: 'create', name: 'Alice' });
        const ja = await a.next('joined');

        const evil = await connect(server.port);
        evil.send({ t: 'rejoin', roomId: ja.roomId, seat: 0, seatToken: 'deadbeef' });
        expect((await evil.next('err')).code).toBe('bad-token');
    });

    it('respects maxRooms with server-full', async () => {
        const server = await boot({ maxRooms: 1 });
        const a = await connect(server.port);
        a.send({ t: 'create', name: 'A' });
        await a.next('joined');

        const b = await connect(server.port);
        b.send({ t: 'create', name: 'B' });
        expect((await b.next('err')).code).toBe('server-full');
    });
});

describe('hardening', () => {
    it('rejects game frames that spoof another seat', async () => {
        const server = await boot();
        const { a, writer } = await startTwoHumanGame(server);

        a.send({ type: 'end-turn', id: 'spoof#0', playerId: 1 });   // a is seat 0
        expect((await a.next('err')).code).toBe('bad-frame');

        a.send({ type: 'resume', clientId: 'c1', seat: 1 });        // spoofed resume
        expect((await a.next('err')).code).toBe('bad-frame');

        await sleep(50);
        expect(writer.getVersion()).toBe(0);   // nothing reached the writer
    });

    it('drops a connection that sends an oversized frame', async () => {
        const server = await boot();
        const a = await connect(server.port);
        a.send({ t: 'create', name: 'A', pad: 'x'.repeat(20000) });   // > 16KB maxPayload
        const code = await a.closed;
        expect(code).toBe(1009);   // ws: message too big
    });

    it('closes an abuser that exceeds the rate limit', async () => {
        const server = await boot({ rateLimit: { points: 5, windowMs: 60000 } });
        const a = await connect(server.port);
        for (let i = 0; i < 10; i++) a.send({ t: 'leave' });   // harmless no-ops
        const code = await a.closed;
        expect(code).toBe(1008);
    });
});

describe('gameplay over real sockets', () => {
    it('two humans play turns and every mirror converges with the writer', async () => {
        const server = await boot();
        const { clients, writer } = await startTwoHumanGame(server);

        expect(clients[0].hashOf()).toBe(writer.hashOf());   // byte-identical v0

        for (let i = 0; i < 12; i++) {
            const step = stepAction(writer);
            if (!step) break;
            const target = writer.getVersion() + 1;
            clients[step.seat].submit(step.action);
            await converge(writer, clients, target);
        }

        expect(writer.getVersion()).toBeGreaterThan(0);
        expect(clients[0].hashOf()).toBe(writer.hashOf());
        expect(clients[1].hashOf()).toBe(writer.hashOf());
    });

    it('rejoin after socket destroy + reconnect() adopts a snapshot and converges', async () => {
        const server = await boot();
        const { b, jb, shells, clients, writer, roomId } = await startTwoHumanGame(server);

        // Seat 1's socket dies without a clean leave.
        b.sock.terminate();
        await b.closed;

        // Seat 0 keeps playing; seat 1 falls behind.
        for (let i = 0; i < 4; i++) {
            const step = stepAction(writer);
            if (!step || step.seat !== 0) break;
            const target = writer.getVersion() + 1;
            clients[0].submit(step.action);
            await waitFor(
                () => writer.getVersion() >= target && clients[0].getVersion() === writer.getVersion(),
                4000, 'seat 0 catch-up'
            );
        }
        expect(writer.getVersion()).toBeGreaterThan(0);
        expect(clients[1].getVersion()).toBeLessThan(writer.getVersion());

        // Rejoin the seat over a fresh socket, then resume → snapshot adoption.
        const b2 = await connect(server.port);
        b2.send({ t: 'rejoin', roomId, seat: 1, seatToken: jb.seatToken });
        const j = await b2.next('joined');
        expect(j.started).toBe(true);
        shells[1].attach(b2);
        clients[1].reconnect();

        await converge(writer, clients, writer.getVersion());
        expect(clients[1].hashOf()).toBe(writer.hashOf());
        expect(clients[0].hashOf()).toBe(writer.hashOf());
    });

    it('drives bot seats: a bot takes its whole turn unattended', async () => {
        const server = await boot();
        const a = await connect(server.port);
        a.send({ t: 'create', name: 'Alice' });
        const ja = await a.next('joined');
        a.send({ t: 'add-bot' });
        await waitFor(() => a.control.some((m) => m.t === 'room' && m.players.some((p) => p.isBot)),
            2000, 'bot in roster');
        a.send({ t: 'start' });
        const started = await a.next('started');
        expect(started.players[1]._isBot).toBe(true);

        const writer = server.getRoom(ja.roomId).writer;
        a.send({ type: 'end-turn', id: 'h#0', playerId: 0 });   // hand the turn to the bot

        // The server plays the bot's turn (bank plays + end-turn) and hands
        // the turn back to seat 0 without any further input.
        await waitFor(() => {
            const s = writer.getState();
            return s.turn === 0 && s.version >= 2;
        }, 5000, 'bot to finish its turn');
    });
});
