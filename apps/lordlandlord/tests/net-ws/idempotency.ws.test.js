// tests/net-ws/idempotency.ws.test.js
//
// FAILURE MODE PINNED (over the REAL WebSocket server): "double-tap does
// something twice".
//
// Port of tests/net/idempotency.test.js intent onto real sockets. TCP already
// removes wire duplication/reorder, so the production duplicate here is the
// application-level RESEND: the same Request envelope (same intent id) sent
// twice from the OWNING seat's socket. The contract: it applies EXACTLY once —
// one version bump, one log entry — and the second delivery is answered with a
// RE-BROADCAST of the stored Accepted (observed on the raw socket), which no
// client double-applies.
//
// The server mints the seed, so all assertions are deck-independent invariants
// (version/log counts, hash equality, observable one-time effects).

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame } from '../../src/js/net/ws-testing.js';
import { request } from '../../src/js/net/protocol.js';
import { pickApplying } from './helpers.js';

const games = [];
afterEach(async () => {
    while (games.length) await games.pop().close();
});

async function boot() {
    const g = await makeWsGame({ players: 3 });
    games.push(g);
    return g;
}

// Capture Accepted frames for one intent id arriving on a seat's RAW socket —
// beneath the client's dedupe guards, so re-broadcasts are visible.
function captureAccepted(g, seat, id) {
    const cap = { n: 0, frames: [] };
    g.sockets[seat].sock.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'accepted' && m.id === id) { cap.n++; cap.frames.push(m); }
    });
    return cap;
}

describe('ws idempotency — the same intent id applies exactly once', () => {
    it('same request id sent twice: one version bump, identical re-broadcast, convergence', async () => {
        const g = await boot();

        expect(g.pendingActor()).toEqual({ seat: 0, phase: 'turn' });
        const action = pickApplying(g, 0);
        expect(action).not.toBeNull();

        const id = 'intent-double-tap';
        const env = request({ id, playerId: 0, ...action });

        // Observable pre-state (a bank play moves exactly one card hand→bank).
        const before = g.writer.getState();
        const handBefore = before.players[0].hand.length;
        const bankBefore = before.players[0].bank.length;

        const seen = captureAccepted(g, 0, id);

        // First delivery applies…
        g.sendRaw(0, env);
        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'first apply' });
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);
        const hashAfterFirst = g.writer.hashOf();
        await g.waitUntil(() => seen.n >= 1, { what: 'first Accepted broadcast' });

        // …the verbatim resend is answered with the STORED Accepted, re-broadcast
        // to the room, and NEVER re-applied.
        g.sendRaw(0, env);
        await g.waitUntil(() => seen.n >= 2, { what: 'stored-Accepted re-broadcast' });
        await g.settle();

        expect(g.writer.getVersion()).toBe(1);          // no second apply
        expect(g.writer.log.length).toBe(1);            // one ruling only
        expect(g.writer.hashOf()).toBe(hashAfterFirst); // byte-identical state

        // The re-broadcast is byte-identical to the original ruling.
        expect(seen.n).toBe(2);
        expect(seen.frames[1]).toEqual(seen.frames[0]);
        expect(seen.frames[0].version).toBe(1);
        expect(seen.frames[0].id).toBe(id);

        // The intent's concrete effect happened once, not twice.
        const after = g.writer.getState();
        if (action.type === 'play' && action.zone === 'bank') {
            expect(after.players[0].hand.length).toBe(handBefore - 1);
            expect(after.players[0].bank.length).toBe(bankBefore + 1);
        }

        // No client double-applied the duplicated Accepted; all converged.
        expect(g.clients.every(c => c.getVersion() === 1)).toBe(true);
        expect(g.converged()).toBe(true);
    });

    it('a resend arriving AFTER further progress still re-broadcasts without rewinding anything', async () => {
        const g = await boot();
        const action = pickApplying(g, 0);
        const id = 'intent-resend-late';
        const env = request({ id, playerId: 0, ...action });

        g.sendRaw(0, env);
        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'first apply' });

        // The game moves on (whoever is pending acts) before the resend lands.
        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        const next = pickApplying(g, actor.seat);
        expect(next).not.toBeNull();
        g.clients[actor.seat].submit(next);
        await g.waitUntil(() => g.writer.getVersion() >= 2, { what: 'second apply' });
        await g.settle();

        const ver = g.writer.getVersion();
        const hash = g.writer.hashOf();
        const seen = captureAccepted(g, 1, id);   // watch a DIFFERENT seat's socket

        // The stale resend: re-broadcast of the stored v1 Accepted, no re-apply,
        // no version change, and no client snaps back (stale-version guard).
        g.sendRaw(0, env);
        await g.waitUntil(() => seen.n >= 1, { what: 'stored-Accepted re-broadcast' });
        await g.settle();

        expect(g.writer.getVersion()).toBe(ver);
        expect(g.writer.hashOf()).toBe(hash);
        expect(g.writer.log.length).toBe(ver);          // one Accepted per version
        expect(g.clients.every(c => c.getVersion() === ver)).toBe(true);
        expect(g.converged()).toBe(true);
    });
});
