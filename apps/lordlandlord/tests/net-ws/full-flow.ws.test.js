// tests/net-ws/full-flow.ws.test.js
//
// FAILURE MODE PINNED (over the REAL WebSocket server): "true convergence +
// one winner" — the end-to-end desync nightmare, on real loopback sockets.
//
// Port of tests/net/full-flow.test.js intent. A complete 3-seat game is driven
// through three real ws connections (every submission a real legal action the
// writer will accept; every mirror update a real broadcast over TCP), and at
// the buzzer the two invariants must hold:
//   1. EXACTLY ONE winner — the authoritative state names a single valid seat
//      and nobody is left to move.
//   2. TRUE convergence — every client hash equals the writer hash at the same
//      version, and the writer logged exactly one Accepted per version bump.
//
// The server mints the seed at 'start' (no override), so the deck differs per
// run; the policy is seeded from the ANNOUNCED seed so a failure is
// replayable. Because a random deal has no termination guarantee inside a
// bounded step budget, the driver retries on a fresh room (fresh seed) up to
// three times — the invariants are asserted on whichever game completed.

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame } from '../../src/js/net/ws-testing.js';
import { makePolicy } from './helpers.js';

const games = [];
afterEach(async () => {
    while (games.length) await games.pop().close();
});

const PLAYERS = 3;
const MAX_STEPS = 1500;
const ATTEMPTS = 3;

describe('ws full-flow — a complete real-socket game ends with one winner and all mirrors converged', () => {
    it(`${PLAYERS} players: plays to a natural winner; every client equals the writer hash`, async () => {
        let g = null;
        let final = null;
        const seedsTried = [];

        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            g = await makeWsGame({ players: PLAYERS });
            games.push(g);
            seedsTried.push(g.seed);

            // Sanity: byte-identical start — every client mirrors the writer at
            // v0 from nothing but the {t:'started'} frame's seed + descriptors.
            expect(g.writer.getVersion()).toBe(0);
            expect(g.converged()).toBe(true);

            final = await g.playOut({ policy: makePolicy(g.seed), maxSteps: MAX_STEPS });
            if (final.winner != null) break;

            // Extremely long deal (no winner inside the budget): even so, the
            // transport invariants must hold before we retry on a fresh seed.
            expect(g.converged()).toBe(true);
            expect(g.writer.log.length).toBe(g.writer.getVersion());
            await games.pop().close();
            g = null;
        }

        expect(g, `no seed reached a winner in ${ATTEMPTS} attempts (${seedsTried.join(', ')})`).not.toBeNull();

        // (1) EXACTLY ONE winner: a single valid seat, game genuinely over.
        expect(final.winner).not.toBeNull();
        expect(typeof final.winner).toBe('number');
        expect(Number.isInteger(final.winner)).toBe(true);
        expect(final.winner).toBeGreaterThanOrEqual(0);
        expect(final.winner).toBeLessThan(PLAYERS);
        expect(g.pendingActor()).toBeNull();            // nobody left to act

        // One Accepted per version bump — no phantom or double-applied intents
        // in the authoritative history.
        expect(g.writer.log.length).toBe(g.writer.getVersion());
        expect(g.writer.getVersion()).toBeGreaterThan(0);
        g.writer.log.forEach((acc, i) => expect(acc.version).toBe(i + 1));

        // (2) TRUE convergence over the real transport: every client hash
        // equals the writer's, at the same version.
        const writerHash = g.writer.hashOf();
        expect(g.hashes().every(h => h === writerHash)).toBe(true);
        expect(g.converged()).toBe(true);
        const writerVer = g.writer.getVersion();
        expect(g.clients.every(c => c.getVersion() === writerVer)).toBe(true);

        // Every client independently names the SAME single winner.
        for (const c of g.clients) {
            expect(c.getState().winner).toBe(final.winner);
        }
    }, 120000);
});
