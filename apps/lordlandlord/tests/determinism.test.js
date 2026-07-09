import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createInitialState, clone } from '../src/js/core/state.js';
import { reduce } from '../src/js/core/reducer.js';
import { replay, hashState } from '../src/js/core/replay.js';
import { enumerateLegalActions } from '../src/js/core/legal.js';
import { playerHasPendingReactionS, drawCardFromDeckS } from '../src/js/engine.js';
import { createRng } from '../src/js/core/rng.js';

// --- Seeded self-play harness -------------------------------------------------
// Drives the reducer with reproducible pseudo-random choices, recording every
// action into a log. Because selection is seeded, the same seed always yields
// the same game — which is what lets us assert cross-run determinism.

function activePlayer(state) {
    if (state.winner != null) return null;
    if (state.pendingAction) {
        const reactors = state.players.map(p => p.id)
            .filter(id => playerHasPendingReactionS(state, id));
        return reactors.length ? reactors[0] : null;
    }
    return state.turn;
}

function selfPlay(seed, playerCount = 3, cap = 5000) {
    const initial = createInitialState(seed, playerCount);
    const rng = createRng((seed ^ 0x9e3779b9) >>> 0);
    let cur = initial;
    const log = [];
    let steps = 0;
    while (steps++ < cap && cur.winner == null) {
        const pid = activePlayer(cur);
        if (pid == null) break;
        let acts = enumerateLegalActions(cur, pid);
        if (!acts.length) break;
        if (cur.pendingAction) {
            // Usually concede so pending actions resolve and the game progresses;
            // occasionally take a random reaction (Just Say No) for coverage.
            const concede = acts.find(a => a.type === 'concede');
            acts = rng.next() < 0.25 ? acts : (concede ? [concede] : acts);
        } else {
            // Prefer doing something over ending the turn so games converge.
            const nonEnd = acts.filter(a => a.type !== 'end-turn');
            if (nonEnd.length && rng.next() < 0.85) acts = nonEnd;
        }
        const chosen = acts[Math.floor(rng.next() * acts.length)];
        const action = { ...chosen, playerId: pid };
        cur = reduce(cur, action);
        log.push(action);
    }
    return { initial, final: cur, log };
}

describe('determinism: initial + log = final', () => {
    it('replay(createInitialState(seed), log) equals the live final state', () => {
        for (const seed of [1, 7, 42, 123, 2026]) {
            const { initial, final, log } = selfPlay(seed);
            // initial must be pristine: reduce never mutates its input.
            const replayed = replay(initial, log);
            expect(hashState(replayed)).toBe(hashState(final));
        }
    });

    it('replaying the same log twice yields identical state', () => {
        const { initial, log } = selfPlay(42);
        const a = replay(initial, log);
        const b = replay(initial, log);
        expect(hashState(a)).toBe(hashState(b));
    });

    it('reduce never mutates the input state', () => {
        const { initial, log } = selfPlay(7);
        const before = hashState(initial);
        replay(initial, log);
        expect(hashState(initial)).toBe(before);
    });
});

describe('determinism: forced reshuffle', () => {
    it('two copies reshuffle an emptied deck into the identical order', () => {
        // Build a state whose deck is empty but discard is full, then draw to
        // trigger the seeded reshuffle on two independent clones.
        const base = createInitialState(99, 2);
        base.discard = base.deck.splice(0); // move whole deck into discard
        base.discard.forEach(c => { c.zone = 'discard'; c.owner = null; });
        expect(base.deck.length).toBe(0);
        expect(base.discard.length).toBeGreaterThan(10);

        const a = clone(base);
        const b = clone(base);
        drawCardFromDeckS(a, 0); // triggers reshuffle in a
        drawCardFromDeckS(b, 0); // triggers reshuffle in b
        // Decks (and drawn card, and advanced rngState) must match exactly.
        expect(a.deck.map(c => c.data.id)).toEqual(b.deck.map(c => c.data.id));
        expect(a.players[0].hand.at(-1).data.id).toBe(b.players[0].hand.at(-1).data.id);
        expect(a.rngState).toBe(b.rngState);
    });

    it('a full game that empties the deck still replays identically', () => {
        // Long 2-player games reliably exhaust the 106-card deck at least once.
        const { initial, final, log } = selfPlay(3, 2, 8000);
        expect(hashState(replay(initial, log))).toBe(hashState(final));
    });
});

describe('determinism: fuzz across seeds', () => {
    it('50 seeds each replay identically and produce exactly one winner', () => {
        let winners = 0;
        for (let seed = 1; seed <= 50; seed++) {
            const { initial, final, log } = selfPlay(seed, 3, 6000);
            expect(hashState(replay(initial, log))).toBe(hashState(final));
            // winner is a single seat id (or null); never a list / multiple.
            expect(final.winner === null || typeof final.winner === 'number').toBe(true);
            if (final.winner != null) winners++;
        }
        // The win path must actually be reachable across the fuzz set.
        expect(winners).toBe(50);
    });
});

describe('determinism: core is free of unseeded randomness', () => {
    it('no Math.random in src/js/core (grep-clean)', () => {
        const coreDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'js', 'core');
        const files = readdirSync(coreDir).filter(f => f.endsWith('.js'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const src = readFileSync(join(coreDir, f), 'utf8');
            expect(src.includes('Math.random')).toBe(false);
        }
    });
});
