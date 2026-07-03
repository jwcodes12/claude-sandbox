import { describe, it, expect } from 'vitest';
import { createInitialState } from '../src/js/core/state.js';
import { reduce } from '../src/js/core/reducer.js';
import { hashState } from '../src/js/core/replay.js';
import { enumerateLegalActions } from '../src/js/core/legal.js';
import { proposeActionS } from '../src/js/engine.js';

// The reducer must reject anything enumerateLegalActions would not offer,
// returning the input state unchanged. These guards are what remove the
// skipped-turn / over-budget / double-apply desync bugs.

describe('reducer guards', () => {
    it('rejects an out-of-turn action (returns state unchanged)', () => {
        const state = createInitialState(1, 3); // turn === 0
        const p1card = state.players[1].hand[0].data.id;
        const illegal = { type: 'play', zone: 'bank', cardId: p1card, playerId: 1 };

        const before = hashState(state);
        const next = reduce(state, illegal);

        expect(next).toBe(state);           // same object: pure no-op
        expect(hashState(next)).toBe(before);
        expect(next.version).toBe(0);
    });

    it('rejects a 4th action and never drives actionsLeft negative', () => {
        let state = createInitialState(4, 3);
        // Spend all 3 actions with plays that don't open a pending reaction
        // (play-to-board / play-to-bank each cost exactly one action).
        for (let i = 0; i < 3; i++) {
            const play = enumerateLegalActions(state, 0)
                .find(a => a.type === 'play' && (a.zone === 'bank' || a.zone === 'board'));
            expect(play).toBeTruthy();
            state = reduce(state, { ...play, playerId: 0 });
        }
        expect(state.actionsLeft).toBe(0);
        expect(enumerateLegalActions(state, 0).some(a => a.type === 'play')).toBe(false);

        // Attempt a 4th play with a card still in hand -> rejected.
        const leftover = state.players[0].hand[0];
        const before = hashState(state);
        const next = reduce(state, { type: 'play', zone: 'bank', cardId: leftover.data.id, playerId: 0 });

        expect(next).toBe(state);
        expect(next.actionsLeft).toBe(0);
        expect(next.actionsLeft).toBeGreaterThanOrEqual(0);
        expect(hashState(next)).toBe(before);
    });

    it('advances the turn exactly once for two same-seat end-turns', () => {
        const state = createInitialState(5, 3);
        expect(state.turn).toBe(0);

        const afterFirst = reduce(state, { type: 'end-turn', playerId: 0 });
        expect(afterFirst.turn).toBe(1);
        expect(afterFirst.version).toBe(1);

        // Seat 0 tries to end the turn again — it's no longer their turn.
        const afterSecond = reduce(afterFirst, { type: 'end-turn', playerId: 0 });
        expect(afterSecond).toBe(afterFirst); // no-op
        expect(afterSecond.turn).toBe(1);     // advanced exactly once
        expect(afterSecond.version).toBe(1);
    });

    it('rejects any action once the game has a winner', () => {
        const state = createInitialState(6, 3);
        state.winner = 2; // simulate a decided game
        const endTurn = { type: 'end-turn', playerId: state.turn };
        expect(reduce(state, endTurn)).toBe(state);
    });

    it('ignores a malformed action (missing playerId / type)', () => {
        const state = createInitialState(7, 3);
        expect(reduce(state, { type: 'end-turn' })).toBe(state);       // no playerId
        expect(reduce(state, { playerId: 0 })).toBe(state);            // no type
        expect(reduce(state, null)).toBe(state);
    });

    it('moves a played wild through reducer-owned swap-wild without spending an action', () => {
        const state = createInitialState(8, 2);
        const wild = {
            data: { id: 'wild1', type: 'JOKER', name: 'Wild', allowedColors: ['BROWN', 'LIGHTBLUE'], value: 2 },
            zone: 'board',
            owner: 0,
            currentColor: 'BROWN'
        };
        state.players[0].properties.BROWN = [wild];

        const action = enumerateLegalActions(state, 0)
            .find(a => a.type === 'swap-wild' && a.cardId === 'wild1' && a.color === 'LIGHTBLUE');
        expect(action).toBeTruthy();

        const next = reduce(state, { ...action, playerId: 0 });

        expect(next).not.toBe(state);
        expect(next.version).toBe(1);
        expect(next.actionsLeft).toBe(3);
        expect(next.players[0].properties.BROWN).not.toContain(wild);
        expect(next.players[0].properties.LIGHTBLUE[0].data.id).toBe('wild1');
        expect(next.players[0].properties.LIGHTBLUE[0].currentColor).toBe('LIGHTBLUE');
    });
});

describe('reducer concede: explicit payment (folded-in payment picker)', () => {
    it('hands over exactly the chosen cards and settles the debt', () => {
        const state = createInitialState(1, 2);
        // Seat 0 taxes seat 1 for 5g. Give seat 0 the card and seat 1 known money.
        const tax = { data: { id: 'dc1', type: 'ACTION', name: 'TAX', effect: 'debt_collector', value: 3 }, zone: 'hand', owner: 0 };
        state.players[0].hand.push(tax);
        const m5 = { data: { id: 'm5', type: 'MONEY', name: '5g', value: 5 }, zone: 'bank', owner: 1 };
        const m1 = { data: { id: 'm1', type: 'MONEY', name: '1g', value: 1 }, zone: 'bank', owner: 1 };
        state.players[1].bank.push(m5, m1);
        // Open the pending action directly (test scaffolding for the reaction phase).
        proposeActionS(state, tax, 0, 1);

        // Seat 1 concedes, choosing to pay with the 5g and keep the 1g.
        const next = reduce(state, { type: 'concede', playerId: 1, paidCardIds: ['m5'] });

        const p0BankIds = next.players[0].bank.map(c => c.data.id);
        const p1BankIds = next.players[1].bank.map(c => c.data.id);
        expect(p0BankIds).toContain('m5');       // chosen card moved to attacker
        expect(p1BankIds).toContain('m1');       // unchosen card kept
        expect(p1BankIds).not.toContain('m5');
        expect(next.pendingAction).toBe(null);   // debt settled
        expect(next.actionsLeft).toBe(2);        // the tax spent one action
    });
});
