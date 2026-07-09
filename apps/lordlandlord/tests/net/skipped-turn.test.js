// tests/net/skipped-turn.test.js
//
// Failure mode pinned: "a turn gets skipped".
//
// The classic desync: seat 0 double-taps "end turn" (or the same intent arrives
// twice concurrently). Two Requests to end seat 0's turn both reach the writer.
// If BOTH advanced the turn, seat 1's turn would be silently skipped and the
// game would jump straight to seat 2. The contract is that the turn must advance
// EXACTLY ONCE:
//   - The first end-turn applies: reduce bumps version 0 -> 1, turn 0 -> 1, and
//     the writer broadcasts one Accepted.
//   - The second end-turn is now out-of-turn for seat 0 (turn === 1), so
//     reduce() returns the SAME state object -> the writer drops it: no version
//     bump, no Accepted broadcast.
// Every client therefore applies exactly one accepted action and all agree
// turn === 1 at version 1.
//
// Imports only from src/js/net/* and src/js/core/*. Deterministic (seeded).

import { describe, it, expect } from 'vitest';
import { makeGame } from '../../src/js/net/testing.js';

const SEED = 7;
const PLAYERS = 3;

describe('skipped-turn: concurrent duplicate end-turn advances the turn exactly once', () => {
    it('drops the second end-turn as a reduce no-op (distinct ids) — turn 0 -> 1, once', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });

        // Preconditions: it is seat 0's turn at version 0, and end-turn is legal.
        expect(g.writer.getVersion()).toBe(0);
        expect(g.writer.getState().turn).toBe(0);
        expect(g.pendingActor()).toEqual({ seat: 0, phase: 'turn' });

        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');
        expect(endTurn).toBeTruthy();

        // Two CONCURRENT end-turn Requests for seat 0, minted as distinct intent
        // ids (a genuine double-tap: two envelopes, not a re-broadcast). Both are
        // queued at the writer before any delivery happens.
        const id1 = g.clients[0].submit({ ...endTurn });
        const id2 = g.clients[0].submit({ ...endTurn });
        expect(id1).not.toBe(id2);           // truly distinct intents
        expect(g.hub.pending()).toBe(2);     // both in flight, none delivered yet

        g.hub.flush();

        // The turn advanced EXACTLY once.
        expect(g.writer.getState().turn).toBe(1);
        expect(g.writer.getVersion()).toBe(1);

        // Exactly one Accepted was broadcast; the second Request was a no-op drop
        // (out-of-turn) — NOT accepted, NOT broadcast. If it had been re-applied
        // the log would have two entries and the turn would read 2 (seat 1 skipped).
        expect(g.writer.log.length).toBe(1);
        expect(g.writer.log[0].version).toBe(1);
        expect(g.writer.log[0].id).toBe(id1);
        expect(g.writer.log[0].action.type).toBe('end-turn');

        // Whose turn it is now must be seat 1 — seat 1 was NOT skipped.
        expect(g.pendingActor()).toEqual({ seat: 1, phase: 'turn' });

        // Every client agrees: turn === 1, version === 1, all converged.
        expect(g.clients.map(c => c.getState().turn)).toEqual([1, 1, 1]);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
        const wh = g.writer.hashOf();
        expect(g.hashes().every(h => h === wh)).toBe(true);
        expect(g.converged()).toBe(true);
    });

    it('idempotent path: the SAME-id end-turn duplicated on the wire is re-broadcast, never re-applied', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });
        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');
        expect(endTurn).toBeTruthy();

        // Force every send to be duplicated verbatim on the transport: the writer
        // receives the SAME intent id twice. First apply bumps to v1; the second
        // hits `applied.has(id)` and is answered with the STORED Accepted — no
        // re-apply, no extra log entry, no second version bump.
        g.hub.setConditions({ duplicateRate: 1 });
        g.clients[0].submit({ ...endTurn });
        g.hub.flush();

        expect(g.writer.getState().turn).toBe(1);
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);           // applied once only
        expect(g.pendingActor()).toEqual({ seat: 1, phase: 'turn' });

        // Clients dedupe the duplicated Accepted (seen / version guard); all agree.
        expect(g.clients.map(c => c.getState().turn)).toEqual([1, 1, 1]);
        expect(g.clients.every(c => c.getVersion() === 1)).toBe(true);
        expect(g.converged()).toBe(true);
    });

    it('sanity: a single clean end-turn also advances exactly once (baseline, no skip)', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });
        const endTurn = g.legalFor(0).find(a => a.type === 'end-turn');
        g.clients[0].submit({ ...endTurn });
        g.hub.flush();

        expect(g.writer.getState().turn).toBe(1);
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);
        expect(g.converged()).toBe(true);
    });
});
