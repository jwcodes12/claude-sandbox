// tests/net-ws/reconnect.ws.test.js
//
// FAILURE MODE PINNED (over the REAL WebSocket server): "refresh or wifi blip
// -> stuck / game hangs".
//
// Port of tests/net/reconnect.test.js intent onto real sockets. A seat's
// socket is DESTROYED mid-game (no clean leave), the table keeps moving
// through the other seats, then the seat comes back over a brand-new socket
// with {t:'rejoin'} + its seat token and calls client.reconnect(). It must
// catch up via the writer's Resume -> Snapshot (over the real transport the
// missed broadcasts are GONE — the server queues nothing for a dead socket),
// converge to the authoritative hash, and be able to submit an action the
// writer ACCEPTS. Additionally: a rejoin DISPLACES a zombie socket still bound
// to the seat (refresh with the old tab half-alive).

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame, connectSocket } from '../../src/js/net/ws-testing.js';
import { pickApplying, stepSeat, advanceAvoiding } from './helpers.js';

const games = [];
afterEach(async () => {
    while (games.length) await games.pop().close();
});

describe('ws reconnect — a partitioned seat rejoins, adopts a snapshot, and keeps playing', () => {
    it('partition mid-game, others advance, rejoin -> resume -> convergence -> accepted move', async () => {
        const g = await makeWsGame({ players: 3 });
        games.push(g);
        const PART = 2;   // the seat that "refreshes / drops wifi"

        // The blip: seat 2's socket dies hard (terminate, no leave frame).
        const dead = g.sockets[PART];
        g.partition(PART);
        await dead.closed;

        // The table keeps moving through seats 0 and 1 only (non-targeting
        // actions, so the offline seat is never required to react), stopping
        // the instant it would be seat 2's move.
        await advanceAvoiding(g, PART, 40);
        await g.settle();   // let the online mirrors drain the broadcasts

        const writerVer = g.writer.getVersion();
        expect(writerVer).toBeGreaterThan(0);            // the world moved on
        expect(g.writer.getState().winner).toBeNull();   // ...but isn't over

        // The offline seat learned NOTHING (the server queues nothing for a
        // dead socket — recovery is resume/snapshot, not replay).
        expect(g.clients[PART].getVersion()).toBe(0);

        // The seats that stayed online are fully caught up.
        expect(g.clients[0].getVersion()).toBe(writerVer);
        expect(g.clients[1].getVersion()).toBe(writerVer);

        // Wifi returns: fresh socket, {t:'rejoin'} with the seat token, then
        // client.reconnect() -> resume -> snapshot adoption.
        await g.rejoin(PART);
        await g.waitUntil(() => g.clients[PART].getVersion() === g.writer.getVersion(),
            { what: 'rejoined seat to adopt the snapshot' });
        await g.settle();

        expect(g.clients[PART].getVersion()).toBe(writerVer);
        expect(g.clients[PART].hashOf()).toBe(g.writer.hashOf());
        expect(g.converged()).toBe(true);

        // Genuinely playable again: it is seat 2's move (advanceAvoiding
        // stopped exactly there); its submission is ACCEPTED and everyone
        // converges one version higher — no hang.
        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        expect(actor.seat).toBe(PART);

        const action = pickApplying(g, PART);
        expect(action).not.toBeNull();
        await stepSeat(g, PART, action);
        await g.settle();

        expect(g.writer.getVersion()).toBe(writerVer + 1);
        expect(g.clients[PART].getVersion()).toBe(writerVer + 1);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
        expect(g.converged()).toBe(true);
    });

    it('rejoin DISPLACES a zombie socket: the old socket is closed and stops receiving', async () => {
        const g = await makeWsGame({ players: 2 });
        games.push(g);

        // Make some progress so displacement happens mid-game.
        const first = pickApplying(g, 0);
        expect(first).not.toBeNull();
        await stepSeat(g, 0, first);
        await g.settle();
        const verBefore = g.writer.getVersion();

        // The "old tab": seat 1's current socket stays OPEN (a zombie). A new
        // socket rejoins the same seat with the token — the server must bind
        // the seat to the NEW socket and close the zombie (code 4001).
        const zombie = g.sockets[1];
        let zombieFramesAfter = 0;
        let displaced = false;
        zombie.sock.on('message', () => { if (displaced) zombieFramesAfter++; });

        const fresh = await connectSocket(g.port);
        fresh.send({ t: 'rejoin', roomId: g.roomId, seat: 1, seatToken: g.seatTokens[1] });
        const j = await fresh.next('joined');
        expect(j.seat).toBe(1);
        expect(j.started).toBe(true);

        const closeCode = await zombie.closed;           // the zombie was kicked
        expect(closeCode).toBe(4001);
        displaced = true;

        // Rewire seat 1's client onto the fresh socket and resync.
        g.sockets[1] = fresh;
        g.shells[1].attach(fresh);
        g.clients[1].reconnect();
        await g.waitUntil(() => g.clients[1].getVersion() === g.writer.getVersion(),
            { what: 'displacing socket to sync' });

        // Play on: broadcasts reach the NEW socket (convergence proves it) and
        // the closed zombie receives nothing further.
        const next = pickApplying(g, g.pendingActor().seat);
        expect(next).not.toBeNull();
        await stepSeat(g, g.pendingActor().seat, next);
        await g.settle();

        expect(g.writer.getVersion()).toBe(verBefore + 1);
        expect(g.clients[1].getVersion()).toBe(g.writer.getVersion());
        expect(g.converged()).toBe(true);
        expect(zombieFramesAfter).toBe(0);
    });
});
