// tests/net/idempotency.test.js
//
// FAILURE-MODE SUITE: "double-tap does something twice".
//
// The classic multiplayer desync: a single user intent reaches the authoritative
// writer twice (the hub duplicated it, or the client resent after a timeout) and
// the action gets *applied twice* — a card leaves a hand twice, money is banked
// twice, the turn counter jumps two. This suite pins the contract that a Request
// carrying the SAME intent id applies EXACTLY ONCE, and that a duplicated /
// replayed Accepted can never double-apply on any client.
//
// It drives the real net layer only (no monkey-patching): submissions are real
// legal actions enumerated from the writer state, and duplicates are introduced
// the two ways they actually happen in production — a transport that duplicates
// on the wire (setConditions duplicateRate), and a verbatim re-send of the same
// Request envelope to the writer (a "resend"/"double-tap"). Determinism comes
// from a fixed seed everywhere; there is no Math.random / Date.now.

import { describe, it, expect } from 'vitest';
import { makeGame } from '../../src/js/net/testing.js';
import { request } from '../../src/js/net/protocol.js';
import { createRng } from '../../src/js/core/rng.js';

// A deterministic bot policy (mirrors tests/local-game.test.js): prefer doing
// something over ending the turn, always concede reactions, discard first when
// forced. Seeded ⇒ a given seed yields a repeatable game.
function makePolicy(seed) {
    const rng = createRng(seed >>> 0);
    return (state, playerId, legal) => {
        if (!legal.length) return null;
        const concede = legal.find(a => a.type === 'concede');
        if (concede || legal.some(a => a.type === 'react-no')) return concede || null;
        const discard = legal.find(a => a.type === 'discard');
        if (state.mustDiscard > 0 && discard) return discard;
        const nonEnd = legal.filter(a => a.type !== 'end-turn');
        const pool = (nonEnd.length && rng.next() < 0.85) ? nonEnd : legal;
        return pool[Math.floor(rng.next() * pool.length)];
    };
}

// Pick a legal opening action for the pending seat that has a visible, countable
// effect: a "play to bank" moves exactly one card hand -> bank, so one vs. two
// applications is directly observable. Falls back to any non-end-turn play.
function pickObservable(legal) {
    return (
        legal.find(a => a.type === 'play' && a.zone === 'bank') ||
        legal.find(a => a.type === 'play') ||
        legal.find(a => a.type !== 'end-turn') ||
        legal[0]
    );
}

// Build a REFERENCE game where the chosen intent is applied exactly once, cleanly
// (single delivery, no duplication). Its post-apply hash/version are the ground
// truth "applied once" fingerprint the duplicate scenarios must match.
function applyOnceReference({ seed, players, seat, id, action }) {
    const g = makeGame({ seed, players });
    const ref = g.hub.connect('ref');
    ref.send(request({ id, playerId: seat, ...action }), 'writer');
    g.hub.flush();
    return g;
}

const SEED = 7;
const PLAYERS = 3;

describe('net idempotency — double-tap applies exactly once (writer)', () => {
    it('two identical Requests (same id) in flight together apply once', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });

        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        const { seat, phase } = actor;
        expect(phase).toBe('turn'); // opening position: seat 0 has a normal turn

        const action = pickObservable(g.legalFor(seat));
        const id = 'intent-double-tap';

        // Ground truth: the exact same intent applied ONCE, cleanly.
        const ref = applyOnceReference({ seed: SEED, players: PLAYERS, seat, id, action });
        expect(ref.writer.getVersion()).toBe(1);
        const refHash = ref.writer.hashOf();

        // Observable pre-state on the real game.
        const before = g.writer.getState();
        const handBefore = before.players[seat].hand.length;
        const bankBefore = before.players[seat].bank.length;

        // Deliver the SAME Request twice (a wire duplicate: both queued, then flushed).
        const env = request({ id, playerId: seat, ...action });
        const inj = g.hub.connect('injector');
        inj.send(env, 'writer');
        inj.send(env, 'writer'); // exact-duplicate copy of the same intent id

        g.hub.flush();

        // Applied EXACTLY once: version advanced by exactly 1, single log entry.
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);

        // Writer state is byte-identical to the clean single-apply reference.
        expect(g.writer.hashOf()).toBe(refHash);

        // And the intent's concrete effect happened once, not twice.
        const after = g.writer.getState();
        if (action.type === 'play' && action.zone === 'bank') {
            expect(after.players[seat].hand.length).toBe(handBefore - 1);
            expect(after.players[seat].bank.length).toBe(bankBefore + 1);
        }

        // Every client mirrored the single application and converged.
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
    });

    it('a verbatim RE-SEND after the intent already applied re-broadcasts but never re-applies', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });
        const { seat } = g.pendingActor();
        const action = pickObservable(g.legalFor(seat));
        const id = 'intent-resend';
        const env = request({ id, playerId: seat, ...action });

        const inj = g.hub.connect('injector');

        // First delivery: applies, version -> 1.
        inj.send(env, 'writer');
        g.hub.flush();
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);
        const hashAfterFirst = g.writer.hashOf();
        const clientVersions = g.clients.map(c => c.getVersion());

        // Resend the identical envelope (the "double-tap" a beat later).
        inj.send(env, 'writer');
        const delivered = g.hub.flush();
        expect(delivered).toBeGreaterThan(0); // the writer DID re-broadcast a stored Accepted

        // No re-apply: version and state unchanged, still one log entry.
        expect(g.writer.getVersion()).toBe(1);
        expect(g.writer.log.length).toBe(1);
        expect(g.writer.hashOf()).toBe(hashAfterFirst);

        // Clients ignored the re-broadcast (seen id / stale version) — no double-apply.
        expect(g.clients.map(c => c.getVersion())).toEqual(clientVersions);
        expect(g.converged()).toBe(true);
    });
});

describe('net idempotency — a client never double-applies a repeated Accepted', () => {
    it('re-delivering the SAME Accepted{version,id} to a client is ignored', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });
        const { seat } = g.pendingActor();
        const action = pickObservable(g.legalFor(seat));

        // One real, clean submission so seat 0's client reaches version 1.
        g.clients[seat].submit(action);
        g.hub.flush();
        expect(g.writer.getVersion()).toBe(1);

        const target = g.clients[0];
        expect(target.getVersion()).toBe(1);
        const hashBefore = target.hashOf();

        // The exact Accepted the writer broadcast for version 1.
        const acc = g.writer.log[0];
        expect(acc.type).toBe('accepted');
        expect(acc.version).toBe(1);

        // Hand-deliver that same Accepted to seat 0's client again, twice.
        const inj = g.hub.connect('injector');
        inj.send(acc, 'c0');
        inj.send(acc, 'c0');
        g.hub.flush();

        // seen.has(id) / version <= appliedVersion guard ⇒ no change at all.
        expect(target.getVersion()).toBe(1);
        expect(target.hashOf()).toBe(hashBefore);
        expect(g.converged()).toBe(true);
    });

    it('a STALE Accepted (version <= appliedVersion) delivered after further progress is ignored', () => {
        const g = makeGame({ seed: SEED, players: PLAYERS });

        // Advance a few real steps so appliedVersion climbs above 1.
        const policy = makePolicy(SEED);
        for (let i = 0; i < 4; i++) {
            const actor = g.pendingActor();
            if (!actor) break;
            const { seat } = actor;
            const legal = g.legalFor(seat);
            let a = policy(g.writer.getState(), seat, legal);
            if (!a) a = legal.find(x => x.type === 'concede')
                || legal.find(x => x.type === 'discard')
                || legal.find(x => x.type === 'end-turn');
            g.clients[seat].submit(a);
            g.hub.flush();
        }
        expect(g.writer.getVersion()).toBeGreaterThanOrEqual(1);

        const target = g.clients[0];
        const vBefore = target.getVersion();
        const hashBefore = target.hashOf();

        // Re-deliver the very first Accepted (version 1) — now stale for everyone.
        const oldAcc = g.writer.log[0];
        expect(oldAcc.version).toBe(1);
        const inj = g.hub.connect('injector');
        inj.send(oldAcc, 'c0');
        inj.send(oldAcc, 'c1');
        inj.send(oldAcc, 'c2');
        g.hub.flush();

        // No snap-back, no re-apply.
        expect(target.getVersion()).toBe(vBefore);
        expect(target.hashOf()).toBe(hashBefore);
        expect(g.converged()).toBe(true);
    });
});

describe('net idempotency — end-to-end duplication cannot desync a whole game', () => {
    it('a transport that duplicates EVERY message still converges with no double application', () => {
        const g = makeGame({ seed: 42, players: 3 });
        // Every Request AND every Accepted is duplicated verbatim on the wire.
        // No drops ⇒ flush still terminates.
        g.hub.setConditions({ duplicateRate: 1, dropRate: 0, reorderWindow: 1 });

        const final = g.playOut({ policy: makePolicy(42) });

        // The game actually completed (not stalled), and everyone agrees.
        expect(final.winner).not.toBeNull();
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);

        // Idempotency invariant: despite doubled Requests, each accepted intent
        // was logged exactly once — log length equals the final version.
        expect(g.writer.log.length).toBe(g.writer.getVersion());

        // Sanity: a duplication-free run of the same seed/policy reaches the same
        // authoritative state (duplication changed nothing observable).
        const clean = makeGame({ seed: 42, players: 3 });
        clean.playOut({ policy: makePolicy(42) });
        expect(g.writer.hashOf()).toBe(clean.writer.hashOf());
        expect(g.writer.getVersion()).toBe(clean.writer.getVersion());
    });
});
