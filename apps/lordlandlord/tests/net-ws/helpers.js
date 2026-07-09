// tests/net-ws/helpers.js — shared bits for the real-WebSocket net suites.
//
// The server mints its own seed at 'start' (no override), so unlike the
// fake-hub suites nothing here may depend on fixed deck contents — only on
// convergence / idempotency / exactly-once invariants. The policy is still
// seeded (from the seed the server ANNOUNCED) so a failing run is replayable
// against the same seed via the fake hub.

import { createRng } from '../../src/js/core/rng.js';
import { wireApplies } from '../../src/js/net/ws-testing.js';

// The same deterministic bot policy the fake-hub suites use: prefer doing
// something over ending the turn, always concede reactions, discard when forced.
export function makePolicy(seed) {
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

// Does `action` actually apply for `seat` on the writer's current state, as
// the wire will deliver it? The writer silently drops no-ops, so tests that
// wait on a version bump must only submit applying actions.
export function appliesFor(g, seat, action) {
    return wireApplies(g.writer.getState(), seat, action);
}

// First legal action for `seat` that reduce() accepts, preferring non-targeting
// moves (bank plays / discard / concede / end-turn) that can never open a
// reaction window on some OTHER (possibly partitioned) seat.
export function pickApplying(g, seat) {
    const legal = g.legalFor(seat);
    const prefer = [
        legal.find(a => a.type === 'play' && a.zone === 'bank'),
        legal.find(a => a.type === 'discard'),
        legal.find(a => a.type === 'concede'),
        legal.find(a => a.type === 'end-turn'),
        ...legal
    ];
    return prefer.find(a => appliesFor(g, seat, a)) || null;
}

// Submit ONE applying action through `seat`'s client and wait for the writer to
// apply it. Returns the minted request id.
export async function stepSeat(g, seat, action) {
    const target = g.writer.getVersion() + 1;
    const id = g.clients[seat].submit(action);
    await g.waitUntil(() => g.writer.getVersion() >= target,
        { timeoutMs: 4000, what: `writer to reach v${target}` });
    return id;
}

// Advance the game ONLY through seats other than `avoidSeat`, using safe
// non-targeting actions, stopping the instant it would be `avoidSeat`'s move.
// (Port of tests/net/reconnect.test.js advanceAvoiding, async over the wire.)
export async function advanceAvoiding(g, avoidSeat, maxSteps) {
    for (let n = 0; n < maxSteps; n++) {
        const actor = g.pendingActor();
        if (!actor || actor.seat === avoidSeat) break;
        const action = pickApplying(g, actor.seat);
        if (!action) break;
        await stepSeat(g, actor.seat, action);
    }
}
