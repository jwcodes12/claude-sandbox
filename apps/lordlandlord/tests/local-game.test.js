import { describe, it, expect } from 'vitest';
import { createInitialState } from '../src/js/core/state.js';
import { createLocalGame } from '../src/js/app/local-game.js';
import { hashState } from '../src/js/core/replay.js';
import { createRng } from '../src/js/core/rng.js';

// A deterministic, self-contained policy: prefer doing something over ending
// the turn (so games converge), always concede reactions (so pending actions
// resolve), discard the first legal card when forced. Seeded so a given seed
// yields a repeatable game.
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

describe('local-game controller: autoplay', () => {
    it('plays a full solo game (all seats bots) to a single winner', () => {
        const game = createLocalGame({
            state: createInitialState(7, 3),
            humanSeats: [],            // no humans -> the loop runs the whole game
            policy: makePolicy(7)
        });
        game.start();
        expect(game.isOver()).toBe(true);
        expect(typeof game.winner()).toBe('number');
    });

    it('is deterministic: same seed + policy => identical final state', () => {
        const run = () => {
            const g = createLocalGame({
                state: createInitialState(42, 3),
                humanSeats: [],
                policy: makePolicy(42)
            });
            g.start();
            return g;
        };
        const a = run();
        const b = run();
        expect(a.winner()).toBe(b.winner());
        expect(hashState(a.peek())).toBe(hashState(b.peek()));
    });

    it('never lets an external reader mutate the source of truth', () => {
        const game = createLocalGame({
            state: createInitialState(3, 2),
            humanSeats: [],
            policy: makePolicy(3)
        });
        const snap = game.getState();
        const before = hashState(game.peek());
        snap.turn = 999;
        snap.players[0].hand.length = 0;   // mangle the copy
        expect(hashState(game.peek())).toBe(before); // source untouched
    });
});

describe('local-game controller: human seat', () => {
    it('pauses on the human turn and resumes bots after the human acts', () => {
        const policy = makePolicy(11);
        const game = createLocalGame({
            state: createInitialState(11, 3),
            humanSeats: [0],
            policy
        });
        game.start();

        // Seat 0 is human and it is their turn -> the loop is paused on them.
        const who = game.whoseTurn();
        expect(who).toEqual({ seat: 0, phase: 'turn' });

        // A bot seat cannot be submitted for.
        expect(game.submit({ type: 'end-turn', playerId: 2 })).toBe(false);

        // Human ends their turn; bots then play until control returns to seat 0
        // (next human turn) or the game ends.
        game.submit({ type: 'end-turn' });
        const next = game.whoseTurn();
        expect(next === null || next.seat === 0).toBe(true);
    });

    it('drives a human seat via the policy to completion without stalling', () => {
        const policy = makePolicy(23);
        const game = createLocalGame({
            state: createInitialState(23, 3),
            humanSeats: [0],
            policy
        });
        game.start();
        let guard = 0;
        while (!game.isOver() && guard++ < 5000) {
            const who = game.whoseTurn();
            if (!who) break;
            expect(who.seat).toBe(0); // only ever paused on the human
            // Ask the same policy for the human's move.
            const action = policy(game.peek(), 0, enumerateForHuman(game));
            game.submit(action || { type: 'end-turn' });
        }
        expect(game.isOver()).toBe(true);
    });
});

// Small helper so the human-driver test can see its own legal actions without
// importing engine internals into the assertion body above.
import { enumerateLegalActions } from '../src/js/core/legal.js';
function enumerateForHuman(game) {
    return enumerateLegalActions(game.peek(), 0);
}
