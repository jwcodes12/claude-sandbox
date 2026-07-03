// tests/net/lost-jsn.test.js
//
// FAILURE-MODE SUITE: "a Just Say No is lost on simultaneous reactions".
//
// A fan-out charge (birthday / single-color rent) opens ONE reaction chain per
// charged opponent, and those chains resolve in parallel: at the instant the
// charge lands, EVERY charged opponent may react at once (each chain starts at
// chainCount 0). The classic desync here: two opponents fire their reactions
// "simultaneously" — one plays Just Say No, the other concedes — and because
// both Requests were minted against the SAME pre-reaction state, the writer,
// while serializing them, drops or mis-attributes the second one. A JSN then
// silently vanishes (chain never flips), or a concede is double-counted, and
// clients diverge from the writer.
//
// This suite pins the contract that the writer serializes concurrently-queued
// reaction Requests via reduce() in strict version order, and that the outcome
// is EXACTLY the single deterministic serialization of those same reactions
// applied one-at-a-time — no reaction lost, none double-counted — with every
// client converging to the writer hash.
//
// It drives the REAL net layer only (no monkey-patching): the scenario is
// reached by submitting real legal actions enumerated from writer state, and
// the "simultaneity" is produced the way it actually happens on the wire — both
// reaction Requests are queued at the hub BEFORE a single flush, so the writer
// sees them back-to-back with neither client having observed the other's
// Accepted yet. Determinism comes from fixed seeds; no Math.random / Date.now.

import { describe, it, expect } from 'vitest';
import { makeGame } from '../../src/js/net/testing.js';
import { reduce } from '../../src/js/core/reducer.js';
import { hashState } from '../../src/js/core/replay.js';
import { createRng } from '../../src/js/core/rng.js';

// Deterministic bot policy (mirrors tests/local-game.test.js): prefer doing
// something over ending the turn, ALWAYS concede reactions (so the drive never
// itself plays a Just Say No), discard first when forced. Seeded ⇒ repeatable.
function makePolicy(seed) {
    const rng = createRng(seed >>> 0);
    return (state, playerId, legal) => {
        if (!legal.length) return null;
        const concede = legal.find(a => a.type === 'concede');
        if (concede || legal.some(a => a.type === 'react-no')) return concede || null;
        const discard = legal.find(a => a.type === 'discard');
        if (state.mustDiscard > 0 && discard) return discard;
        const nonEnd = legal.filter(a => a.type !== 'end-turn' && a.type !== 'swap-wild');
        const pool = (nonEnd.length && rng.next() < 0.85) ? nonEnd : legal;
        return pool[Math.floor(rng.next() * pool.length)];
    };
}

// Drive a real net game (client submit -> hub flush) with the concede-always
// policy until the WRITER state is parked on a FAN-OUT charge with >= 2 unsettled
// reactors AND at least one of those reactors is holding a Just Say No (a legal
// 'react-no'). Returns the live game paused at that instant — nothing has been
// submitted for the reaction phase yet, both chains are still at chainCount 0.
//
// Condition-driven (not a hardcoded step index) so it stays valid even if the
// engine's deal changes; seed 8 reaches it in-bounds today (an early birthday).
function driveToSimultaneousReaction(seed, maxSteps = 400) {
    const g = makeGame({ seed, players: 3 });
    const policy = makePolicy(seed);
    let steps = 0;
    while (steps++ < maxSteps) {
        const s = g.writer.getState();
        if (s.winner != null) return null;

        if (s.pendingAction && s.pendingAction.isFanOut && s.pendingReactors.length >= 2) {
            const unsettled = s.pendingReactors.slice();
            const info = unsettled.map(rid => ({ rid, legal: g.legalFor(rid) }));
            // A charge is "simultaneous" here only if every listed reactor is
            // genuinely able to act right now (fresh chain, chainCount 0).
            const allCanReactNow = info.every(i => i.legal.length > 0);
            const noReactor = info.find(i => i.legal.some(a => a.type === 'react-no'));
            if (allCanReactNow && noReactor) {
                return { g, state: s, unsettled, info, noReactor };
            }
        }

        const actor = g.pendingActor();
        if (!actor) return null;
        const { seat } = actor;
        const legal = g.legalFor(seat);
        let a = policy(s, seat, legal);
        if (!a) {
            a = legal.find(x => x.type === 'concede')
                || legal.find(x => x.type === 'discard')
                || legal.find(x => x.type === 'end-turn');
        }
        if (!a) return null;
        g.clients[seat].submit(a);
        g.hub.flush();
    }
    return null;
}

const legalFor = (info, rid) => info.find(i => i.rid === rid).legal;

const SEED = 8;

describe('net lost-JSN — simultaneous reactions serialize with no reaction lost', () => {
    it('JSN + concede queued together apply as one deterministic serialization (JSN survives)', () => {
        const scn = driveToSimultaneousReaction(SEED);
        expect(scn).not.toBeNull();
        const { g, unsettled, info, noReactor } = scn;

        // Sanity: this really is a parallel fan-out with two distinct unsettled
        // reactors, both currently converged with the writer.
        expect(unsettled.length).toBeGreaterThanOrEqual(2);
        expect(g.converged()).toBe(true);

        // Reactor rNo plays Just Say No; the OTHER reactor concedes. Both are
        // enumerated against the SAME pre-reaction writer state (true simultaneity).
        const rNo = noReactor.rid;
        const rCon = unsettled.find(x => x !== rNo);
        const noAction = legalFor(info, rNo).find(a => a.type === 'react-no');
        const conAction = legalFor(info, rCon).find(a => a.type === 'concede');
        expect(noAction).toBeTruthy();
        expect(conAction).toBeTruthy();

        // GROUND TRUTH: the single deterministic serialization of these exact two
        // reactions, applied one-at-a-time in submission order (react-no, then
        // concede) through the pure reducer. This is what "no reaction lost or
        // double-counted" MUST reduce to.
        const pre = g.writer.getState();
        const V0 = pre.version;
        const s1 = reduce(pre, { ...noAction, playerId: rNo });
        const s2 = reduce(s1, { ...conAction, playerId: rCon });
        // Both reactions are independent chains ⇒ both apply ⇒ version climbs by 2.
        expect(s1.version).toBe(V0 + 1);
        expect(s2.version).toBe(V0 + 2);
        const refHash = hashState(s2);
        // In the reference: the JSN flipped rNo's chain to odd (NOT lost), and
        // the concede settled rCon's chain.
        expect(s2.pendingAction).not.toBeNull();
        expect(s2.pendingAction.chains[rNo].chainCount).toBe(1);
        expect(s2.pendingAction.chains[rNo].settled).toBe(false);
        expect(s2.pendingAction.chains[rCon].settled).toBe(true);
        expect(s2.pendingAction.chains[rCon].canceled).toBe(false);

        const logBefore = g.writer.log.length;

        // SIMULTANEOUS DELIVERY: queue BOTH reaction Requests at the hub, THEN
        // flush once. The writer serializes them back-to-back (reorderWindow:1,
        // strict FIFO) before either client has seen the other's Accepted.
        g.clients[rNo].submit(noAction);   // enqueued first ⇒ processed first
        g.clients[rCon].submit(conAction);
        expect(g.hub.pending()).toBeGreaterThanOrEqual(2); // both really are in flight
        g.hub.flush();

        // Exactly TWO intents applied — neither reaction lost, neither doubled.
        expect(g.writer.getVersion()).toBe(V0 + 2);
        expect(g.writer.log.length).toBe(logBefore + 2);

        // The writer's authoritative state is byte-identical to the single
        // deterministic serialization: the JSN survived, the concede settled.
        expect(g.writer.hashOf()).toBe(refHash);
        const post = g.writer.getState();
        expect(post.pendingAction.chains[rNo].chainCount).toBe(1); // JSN NOT lost
        expect(post.pendingAction.chains[rCon].settled).toBe(true);

        // Every client mirrored the same serialization and converged to the writer.
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
    });

    it('reversed submission order (concede first, then JSN) also loses no reaction', () => {
        const scn = driveToSimultaneousReaction(SEED);
        expect(scn).not.toBeNull();
        const { g, unsettled, info, noReactor } = scn;

        const rNo = noReactor.rid;
        const rCon = unsettled.find(x => x !== rNo);
        const noAction = legalFor(info, rNo).find(a => a.type === 'react-no');
        const conAction = legalFor(info, rCon).find(a => a.type === 'concede');

        // Reference for THIS order: concede first, then react-no.
        const pre = g.writer.getState();
        const V0 = pre.version;
        const s1 = reduce(pre, { ...conAction, playerId: rCon });
        const s2 = reduce(s1, { ...noAction, playerId: rNo });
        expect(s2.version).toBe(V0 + 2);
        const refHash = hashState(s2);

        // Queue concede first, JSN second, then flush.
        g.clients[rCon].submit(conAction);
        g.clients[rNo].submit(noAction);
        g.hub.flush();

        // Still exactly two applied; the JSN still flipped rNo's chain.
        expect(g.writer.getVersion()).toBe(V0 + 2);
        expect(g.writer.hashOf()).toBe(refHash);
        const post = g.writer.getState();
        expect(post.pendingAction.chains[rNo].chainCount).toBe(1); // JSN NOT lost
        expect(post.pendingAction.chains[rCon].settled).toBe(true);
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
    });

    it('both opponents conceding simultaneously resolves the fan-out exactly once', () => {
        const scn = driveToSimultaneousReaction(SEED);
        expect(scn).not.toBeNull();
        const { g, unsettled, info } = scn;

        const [rA, rB] = unsettled;
        const conA = legalFor(info, rA).find(a => a.type === 'concede');
        const conB = legalFor(info, rB).find(a => a.type === 'concede');
        expect(conA && conB).toBeTruthy();

        // Reference: both concedes serialized one-at-a-time. With every reactor
        // settled the fan-out resolves fully (pendingAction cleared).
        const pre = g.writer.getState();
        const V0 = pre.version;
        const s1 = reduce(pre, { ...conA, playerId: rA });
        const s2 = reduce(s1, { ...conB, playerId: rB });
        expect(s2.version).toBe(V0 + 2);
        expect(s2.pendingAction).toBeNull(); // charge fully settled
        const refHash = hashState(s2);
        const logBefore = g.writer.log.length;

        // Queue BOTH concedes, then a single flush.
        g.clients[rA].submit(conA);
        g.clients[rB].submit(conB);
        g.hub.flush();

        // Neither concede lost (both settle) nor double-counted (version +2, not
        // +3/+4): the fan-out resolves exactly once and everyone converges.
        expect(g.writer.getVersion()).toBe(V0 + 2);
        expect(g.writer.log.length).toBe(logBefore + 2);
        expect(g.writer.getState().pendingAction).toBeNull();
        expect(g.writer.hashOf()).toBe(refHash);
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
    });
});
