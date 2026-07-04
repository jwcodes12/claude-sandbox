// tests/net-ws/skipped-turn.ws.test.js
//
// FAILURE MODE PINNED (over the REAL WebSocket server): "a turn gets skipped".
//
// Port of tests/net/skipped-turn.test.js semantics onto real loopback sockets.
// Seat 0 double-taps end-turn (two distinct intents, back-to-back on the wire);
// the turn must advance EXACTLY once — the second Request is out-of-turn by the
// time the writer serializes it and is dropped as a reduce() no-op: no version
// bump, no Accepted broadcast, seat 1 is NOT skipped. A slow/late re-submit
// after the state moved on is likewise dropped with no divergence.
//
// The server mints the seed, so assertions are deck-independent: end-turn at
// the opening position is always legal and always applies, and turn/version
// counters are deterministic regardless of the deal.

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame } from '../../src/js/net/ws-testing.js';
import { request } from '../../src/js/net/protocol.js';

const games = [];
afterEach(async () => {
    while (games.length) await games.pop().close();
});

async function boot() {
    const g = await makeWsGame({ players: 3 });
    games.push(g);
    return g;
}

describe('ws skipped-turn — duplicate end-turn advances the turn exactly once', () => {
    it('drops the second of two concurrent distinct-id end-turns (turn 0 -> 1, once)', async () => {
        const g = await boot();

        // Preconditions: opening position, seat 0 to move, end-turn legal.
        expect(g.writer.getVersion()).toBe(0);
        expect(g.writer.getState().turn).toBe(0);
        expect(g.pendingActor()).toEqual({ seat: 0, phase: 'turn' });
        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');
        expect(endTurn).toBeTruthy();

        // A genuine double-tap: two distinct intents fired back-to-back from the
        // OWNING seat's socket, no waiting in between. TCP keeps them ordered;
        // the writer applies the first and must no-op-drop the second.
        const id1 = g.clients[0].submit({ ...endTurn });
        const id2 = g.clients[0].submit({ ...endTurn });
        expect(id1).not.toBe(id2);

        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'first end-turn to apply' });
        await g.settle();

        // The turn advanced EXACTLY once.
        expect(g.writer.getState().turn).toBe(1);
        expect(g.writer.getVersion()).toBe(1);

        // Exactly one Accepted in the authoritative log, and it is the FIRST id.
        expect(g.writer.log.length).toBe(1);
        expect(g.writer.log[0].version).toBe(1);
        expect(g.writer.log[0].id).toBe(id1);
        expect(g.writer.log[0].action.type).toBe('end-turn');

        // Seat 1 was NOT skipped.
        expect(g.pendingActor()).toEqual({ seat: 1, phase: 'turn' });

        // Every client agrees and converged on the writer hash.
        expect(g.clients.map(c => c.getState().turn)).toEqual([1, 1, 1]);
        expect(g.clients.every(c => c.getVersion() === 1)).toBe(true);
        expect(g.converged()).toBe(true);
    });

    it('idempotent path: the SAME-id end-turn raw frame sent twice applies once', async () => {
        const g = await boot();
        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');
        expect(endTurn).toBeTruthy();

        // The same envelope (same intent id) hits the wire twice — a resend
        // after a perceived timeout. First applies; second is answered from the
        // writer's stored-Accepted table, never re-applied.
        const env = request({ id: 'dup-end#1', playerId: 0, ...endTurn });
        g.sendRaw(0, env);
        g.sendRaw(0, env);

        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'end-turn to apply' });
        await g.settle();

        expect(g.writer.getState().turn).toBe(1);
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);
        expect(g.pendingActor()).toEqual({ seat: 1, phase: 'turn' });
        expect(g.clients.map(c => c.getState().turn)).toEqual([1, 1, 1]);
        expect(g.converged()).toBe(true);
    });

    it('a slow/late-delivered submit for an already-passed turn is dropped with no divergence', async () => {
        const g = await boot();
        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');

        // Seat 0 cleanly ends its turn; everyone reaches v1, turn 1.
        g.clients[0].submit({ ...endTurn });
        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'end-turn to apply' });
        await g.settle();
        expect(g.writer.getState().turn).toBe(1);

        const hashBefore = g.writer.hashOf();

        // The "late packet": a fresh-id end-turn for seat 0, minted against the
        // OLD state, finally arrives after the turn has passed. Out-of-turn ⇒
        // reduce() no-op ⇒ the writer drops it silently.
        g.sendRaw(0, request({ id: 'late-end#1', playerId: 0, type: 'end-turn' }));
        await g.settle();

        expect(g.writer.getVersion()).toBe(1);          // no phantom version
        expect(g.writer.getState().turn).toBe(1);       // turn did not jump to 2
        expect(g.writer.log.length).toBe(1);
        expect(g.writer.hashOf()).toBe(hashBefore);
        expect(g.pendingActor()).toEqual({ seat: 1, phase: 'turn' });   // seat 1 still to move
        expect(g.converged()).toBe(true);
    });
});
