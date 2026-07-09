// tests/net-ws/stale-version.ws.test.js
//
// FAILURE MODE PINNED (over the REAL WebSocket server): "a played card snaps
// back / a behind client jumps ahead".
//
// Over TCP the transport never reorders, so the fake-hub reorder scenarios
// stay fake-hub-only. What CAN still happen in production: a client rebinds
// its seat ({t:'rejoin'}) after a blip but has not yet resumed — its socket is
// live while its local mirror is BEHIND. This suite pins:
//   1. New broadcasts reaching that behind client are BUFFERED (contiguity
//      guard: version > appliedVersion+1) — it neither jumps ahead nor
//      misapplies them out of order.
//   2. A stale raw Request minted against the old state (out-of-turn by now)
//      is dropped by the writer with no version bump and no divergence; a
//      duplicate of an ALREADY-APPLIED Request id is re-broadcast, never
//      re-applied.
//   3. reconnect() then recovers everything via Resume -> Snapshot, the stale
//      buffer is discarded, and the seat plays on — full convergence.

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame, connectSocket } from '../../src/js/net/ws-testing.js';
import { request } from '../../src/js/net/protocol.js';
import { pickApplying, stepSeat } from './helpers.js';

const games = [];
afterEach(async () => {
    while (games.length) await games.pop().close();
});

describe('ws stale-version — a behind client buffers, never misapplies, and recovers via resume', () => {
    it('rejoin WITHOUT reconnect: broadcasts buffer, stale/duplicate requests are ignored, reconnect() recovers', async () => {
        const g = await makeWsGame({ players: 3 });
        games.push(g);

        // Seat 2 blips out at v0 and misses the first move entirely.
        const dead = g.sockets[2];
        g.partition(2);
        await dead.closed;

        // Seat 0 ends its turn while seat 2 is gone → v1, turn 1.
        const endTurn0 = g.legalFor(0).find(a => a.type === 'end-turn');
        expect(endTurn0).toBeTruthy();
        const appliedId = await stepSeat(g, 0, endTurn0);
        expect(g.writer.getVersion()).toBe(1);

        // Seat 2 rebinds its seat over a fresh socket but does NOT resume yet —
        // a live socket in front of a stale (v0) mirror that missed v1.
        const fresh = await connectSocket(g.port);
        fresh.send({ t: 'rejoin', roomId: g.roomId, seat: 2, seatToken: g.seatTokens[2] });
        const j = await fresh.next('joined');
        expect(j.seat).toBe(2);
        g.sockets[2] = fresh;
        g.shells[2].attach(fresh);           // client is wired up, still at v0
        expect(g.clients[2].getVersion()).toBe(0);

        // Seat 1 ends its turn → the v2 Accepted is broadcast to EVERYONE,
        // including the stale seat 2. Contiguity guard: 2 > 0+1, so seat 2
        // must BUFFER it — no jump-ahead, no out-of-order apply.
        const endTurn1 = g.legalFor(1).find(a => a.type === 'end-turn');
        expect(endTurn1).toBeTruthy();
        await stepSeat(g, 1, endTurn1);
        await g.settle();
        expect(g.writer.getVersion()).toBe(2);
        expect(g.clients[0].getVersion()).toBe(2);
        expect(g.clients[1].getVersion()).toBe(2);
        expect(g.clients[2].getVersion()).toBe(0);       // held back, not misapplied

        const writerHash = g.writer.hashOf();
        const writerVer = g.writer.getVersion();

        // A STALE raw Request minted against the pre-blip state (seat 0 trying
        // to end a turn it no longer holds) is a reduce() no-op → dropped:
        // nothing is broadcast, so the behind client stays exactly where it was.
        g.sendRaw(0, request({ id: 'stale-replay#1', playerId: 0, type: 'end-turn' }));
        await g.settle();
        expect(g.writer.getVersion()).toBe(writerVer);
        expect(g.writer.hashOf()).toBe(writerHash);
        expect(g.writer.log.length).toBe(writerVer);     // still one Accepted per version
        expect(g.clients[2].getVersion()).toBe(0);       // no phantom broadcast reached it

        // NOW the behind client resumes: Resume → Snapshot at the writer's
        // current version → adopt in one jump (buffer discarded) → converged.
        g.clients[2].reconnect();
        await g.waitUntil(() => g.clients[2].getVersion() === g.writer.getVersion(),
            { what: 'stale client to adopt the snapshot' });
        await g.settle();
        expect(g.clients[2].getVersion()).toBe(writerVer);
        expect(g.clients[2].hashOf()).toBe(g.writer.hashOf());
        expect(g.converged()).toBe(true);

        // A DUPLICATE of the already-applied v1 Request id is answered with the
        // stored Accepted (re-broadcast) — never re-applied, no version bump —
        // and every up-to-date client ignores the replayed Accepted (seen-id /
        // stale-version guards): nobody moves, nobody snaps back.
        g.sendRaw(0, request({ id: appliedId, playerId: 0, type: 'end-turn' }));
        await g.settle();
        expect(g.writer.getVersion()).toBe(writerVer);
        expect(g.writer.hashOf()).toBe(writerHash);
        expect(g.writer.log.length).toBe(writerVer);
        expect(g.clients.every(c => c.getVersion() === writerVer)).toBe(true);
        expect(g.converged()).toBe(true);

        // Fully playable: it is seat 2's turn (two end-turns from a 3-seat
        // table); its move is accepted and everyone advances together.
        const actor = g.pendingActor();
        expect(actor).toEqual({ seat: 2, phase: 'turn' });
        const action = pickApplying(g, 2);
        expect(action).not.toBeNull();
        await stepSeat(g, 2, action);
        await g.settle();
        expect(g.writer.getVersion()).toBe(writerVer + 1);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
        expect(g.converged()).toBe(true);
    });
});
