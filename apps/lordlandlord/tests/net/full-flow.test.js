// tests/net/full-flow.test.js
//
// FAILURE MODE PINNED: "true convergence + one winner".
//
// The end-to-end desync nightmare: a whole game is played through the net layer
// under a lossy-ish wire (duplicates + reordering), and at the final buzzer the
// clients quietly disagree with the authoritative writer — a phantom second
// winner on one screen, a card that never left a hand on another. This suite
// drives a COMPLETE game to a natural winner for 2, 3 and 4 players, flushing the
// hub between every step with light perturbation (occasional reorder + duplicate,
// plus an occasional verbatim double-tap of the same intent) enabled, and pins
// the two invariants that must hold at the end:
//
//   1. EXACTLY ONE winner — the authoritative state names a single seat and the
//      game is genuinely over (nobody is still to move).
//   2. TRUE convergence — every client's hashState equals the writer's, at the
//      same version. No client is a hash apart.
//
// It exercises the real net layer only (no monkey-patching): every submission is
// a REAL legal action enumerated from the writer state; the only "hand-crafted"
// message is a verbatim re-send of an already-minted Request id (a double-tap),
// which is exactly how duplication happens in production. All randomness is
// seeded (there is no Math.random / Date.now), so each parameterisation is a
// fixed, reproducible game.

import { describe, it, expect } from 'vitest';

import { makeGame } from '../../src/js/net/testing.js';
import { request } from '../../src/js/net/protocol.js';
import { createRng } from '../../src/js/core/rng.js';

// A deterministic bot policy (mirrors tests/local-game.test.js): prefer doing
// something over ending the turn (so games actually progress to a winner),
// always concede reactions (so pending actions resolve), discard first when
// forced. Seeded => a given seed yields a repeatable game.
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

// Phase-appropriate fallback when the policy declines (matches testing.playOut).
function defaultFor(phase, legal) {
    if (phase === 'react') return legal.find(a => a.type === 'concede') || null;
    if (phase === 'discard') return legal.find(a => a.type === 'discard') || null;
    return legal.find(a => a.type === 'end-turn') || null;
}

// Drive a full game to completion through the net layer, flushing between steps
// WITH light perturbation. Each step:
//   - the WRITER (source of truth) says whose move it is and what is legal,
//   - that seat's client submits a real legal action,
//   - the wire is toggled (seeded) between strict FIFO and a perturbed profile
//     (reorder window + duplication), and occasionally the same intent id is
//     re-sent verbatim to the writer (a double-tap),
//   - the hub is flushed fully so the writer applies it and every client catches
//     up before the next step.
// No drops are ever configured, so every flush terminates.
function drivePerturbedToEnd(g, policy, pRng, maxSteps) {
    const injector = g.hub.connect('perturb-injector');
    let steps = 0;
    while (steps++ < maxSteps) {
        const actor = g.pendingActor();
        if (!actor) break;                       // winner reached (or wedged)
        const { seat, phase } = actor;
        const legal = g.legalFor(seat);
        let action = policy(g.writer.getState(), seat, legal);
        if (!action) action = defaultFor(phase, legal);
        if (!action) break;                      // defensive; shouldn't happen

        // Occasionally turn the wire hostile (reorder + duplicate); otherwise
        // strict FIFO. Never any drop, so the flush always drains.
        if (pRng.next() < 0.5) {
            g.hub.setConditions({ reorderWindow: 4, duplicateRate: 0.5, dropRate: 0 });
        } else {
            g.hub.setConditions({ reorderWindow: 1, duplicateRate: 0, dropRate: 0 });
        }

        const id = g.clients[seat].submit(action);

        // Occasional verbatim double-tap: the SAME intent id re-sent straight to
        // the writer (a resend after a perceived timeout). Must be absorbed
        // idempotently — re-broadcast, never re-applied.
        if (pRng.next() < 0.25) {
            injector.send(request({ id, playerId: seat, ...action }), 'writer');
        }

        g.hub.flush();
    }
    return steps;
}

// Seeds chosen (probed offline) so each player count reaches a NATURAL winner
// under this exact perturbed driver, well within maxSteps.
const CASES = [
    { players: 2, seed: 20602 },
    { players: 3, seed: 30603 },
    { players: 4, seed: 40604 }
];

describe('net/full-flow — a full perturbed game ends with exactly one winner and every client converged', () => {
    for (const { players, seed } of CASES) {
        it(`${players} players: drives to a natural winner; all clients equal the writer hash`, () => {
            const g = makeGame({ seed, players });

            // Sanity: byte-identical start — every client mirrors the writer at v0.
            expect(g.writer.getVersion()).toBe(0);
            expect(g.converged()).toBe(true);

            const pRng = createRng((seed ^ 0x9e3779b9) >>> 0); // independent perturb stream
            const stepsRun = drivePerturbedToEnd(g, makePolicy(seed), pRng, 20000);

            // The game actually terminated by a winner, not by exhausting maxSteps.
            expect(stepsRun).toBeLessThan(20000);

            const finalWriter = g.writer.getState();

            // (1) EXACTLY ONE winner: the authoritative state names a single, valid
            //     seat, and the game is genuinely over (no one is still to move).
            expect(finalWriter.winner).not.toBeNull();
            expect(typeof finalWriter.winner).toBe('number');
            expect(Number.isInteger(finalWriter.winner)).toBe(true);
            expect(finalWriter.winner).toBeGreaterThanOrEqual(0);
            expect(finalWriter.winner).toBeLessThan(players);
            expect(g.pendingActor()).toBeNull(); // nobody left to act => truly finished

            // The writer logged exactly one Accepted per version bump — no phantom
            // or double-applied intents leaked into the authoritative history.
            expect(g.writer.log.length).toBe(g.writer.getVersion());
            expect(g.writer.getVersion()).toBeGreaterThan(0);

            // (2) TRUE convergence: EVERY client's hashState equals the writer's,
            //     at the same version. This is the whole-game desync guard.
            const writerHash = g.writer.hashOf();
            const hashes = g.hashes();
            expect(hashes[0]).toBe(writerHash);                 // writer first
            expect(hashes.every(h => h === writerHash)).toBe(true);
            expect(g.converged()).toBe(true);

            const writerVer = g.writer.getVersion();
            expect(g.clients.every(c => c.getVersion() === writerVer)).toBe(true);

            // Every client independently agrees on the SAME single winner — no
            // second winner hiding on any one screen.
            for (const c of g.clients) {
                expect(c.getState().winner).toBe(finalWriter.winner);
            }

            // Nothing left stranded on the wire.
            expect(g.hub.pending()).toBe(0);
        });
    }
});
