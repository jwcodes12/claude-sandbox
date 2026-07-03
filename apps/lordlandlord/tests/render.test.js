import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '../src/js/render.js';

function makeState(overrides = {}) {
    return {
        players: [
            { id: 0, hand: [], bank: [], properties: {} },
            { id: 1, hand: [], bank: [], properties: {} },
            { id: 2, hand: [], bank: [], properties: {} }
        ],
        localPlayerId: 0,
        turn: 0,
        actionsLeft: 3,
        mustDiscard: 0,
        reactionTargetId: null,
        deck: [],
        discard: [],
        ...overrides
    };
}

describe('render skeleton', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders the five regions', () => {
        render(root, makeState());
        expect(root.querySelector('.top-bar')).toBeTruthy();
        expect(root.querySelector('.opponents')).toBeTruthy();
        expect(root.querySelector('.zone-strip')).toBeTruthy();
        expect(root.querySelector('.your-area')).toBeTruthy();
        expect(root.querySelector('.your-hand')).toBeTruthy();
    });

    it('renders one opponent section per non-local player', () => {
        render(root, makeState());
        const opps = root.querySelectorAll('.opponent');
        expect(opps.length).toBe(2);
        expect(opps[0].dataset.playerId).toBe('1');
        expect(opps[1].dataset.playerId).toBe('2');
    });

    it('is idempotent - calling twice produces same node count', () => {
        render(root, makeState());
        const first = root.innerHTML;
        render(root, makeState());
        const second = root.innerHTML;
        expect(second).toBe(first);
    });
});

describe('top bar', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('displays your gold from bank total', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [{ data: { value: 3 } }, { data: { value: 2 } }], properties: {} },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        expect(root.querySelector('[data-field="your-gold"]').textContent).toBe('5g');
    });

    it('displays actions remaining', () => {
        const state = makeState({ actionsLeft: 2 });
        render(root, state);
        expect(root.querySelector('[data-field="actions"]').textContent).toBe('Actions: 2');
    });

    it('displays kingdom progress (completed sets / 3)', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [], properties: { BROWN: [{}, {}], RED: [{}, {}, {}] } },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        expect(root.querySelector('[data-field="kingdom"]').textContent).toBe('2/3');
    });

    it('end turn button enabled on your turn with no pending state', () => {
        render(root, makeState());
        const btn = root.querySelector('[data-action="end-turn"]');
        expect(btn.disabled).toBe(false);
    });

    it('end turn button disabled when not your turn', () => {
        render(root, makeState({ turn: 1 }));
        const btn = root.querySelector('[data-action="end-turn"]');
        expect(btn.disabled).toBe(true);
    });

    it('end turn button disabled when forced to discard', () => {
        render(root, makeState({ mustDiscard: 1 }));
        const btn = root.querySelector('[data-action="end-turn"]');
        expect(btn.disabled).toBe(true);
    });
});

describe('opponent rows', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders header line with gold, sets, hand count', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [], properties: {} },
                { id: 1, hand: [{}, {}, {}], bank: [{ data: { value: 4 } }], properties: { BROWN: [{}] } }
            ]
        });
        render(root, state);
        const opp = root.querySelector('.opponent[data-player-id="1"]');
        expect(opp.querySelector('[data-field="opp-gold"]').textContent).toBe('4g');
        expect(opp.querySelector('[data-field="opp-hand"]').textContent).toBe('H:3');
        expect(opp.querySelector('[data-field="opp-sets"]').textContent).toBe('0/3');
    });

    it('renders one color-stack div per color group in opponent properties', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [], properties: {} },
                {
                    id: 1, hand: [], bank: [],
                    properties: {
                        BROWN: [{ data: { id: 'b1', colorKey: 'BROWN', hex: '#8B4513' } }],
                        BLUE: [{ data: { id: 'l1', colorKey: 'BLUE', hex: '#ADD8E6' } }, { data: { id: 'l2', colorKey: 'BLUE', hex: '#ADD8E6' } }]
                    }
                }
            ]
        });
        render(root, state);
        const opp = root.querySelector('.opponent[data-player-id="1"]');
        const stacks = opp.querySelectorAll('.color-stack');
        expect(stacks.length).toBe(2);
    });

    it('renders one .card per card in each color stack', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [], properties: {} },
                {
                    id: 1, hand: [], bank: [],
                    properties: { BLUE: [{ data: { id: 'l1' } }, { data: { id: 'l2' } }, { data: { id: 'l3' } }] }
                }
            ]
        });
        render(root, state);
        const opp = root.querySelector('.opponent[data-player-id="1"]');
        expect(opp.querySelectorAll('.color-stack .card').length).toBe(3);
    });

    it('opponent with empty kingdom has no .color-stack elements', () => {
        const state = makeState();
        render(root, state);
        const opp = root.querySelector('.opponent[data-player-id="1"]');
        expect(opp.querySelectorAll('.color-stack').length).toBe(0);
    });
});

describe('your area', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders treasury as a single coin showing total gold', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [{ data: { id: 'm1', value: 3 } }, { data: { id: 'm2', value: 5 } }], properties: {} },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const bank = root.querySelector('.your-bank');
        const coins = bank.querySelectorAll('.money-chip');
        expect(coins.length).toBe(1);
        expect(coins[0].textContent).toBe('8g');
        expect(bank.querySelector('[data-field="bank-total"]').textContent).toBe('2 cards');
    });

    it('bank is a drop target', () => {
        render(root, makeState());
        const bank = root.querySelector('.your-bank');
        expect(bank.dataset.dropTarget).toBe('bank:0');
    });

    it('your kingdom is a single drop zone with one stack per held color', () => {
        const state = makeState({
            players: [
                {
                    id: 0, hand: [], bank: [],
                    properties: { GREEN: [{ data: { id: 'g1', colorKey: 'GREEN', value: 4 } }] }
                },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const kingdom = root.querySelector('.your-kingdom');
        expect(kingdom.dataset.dropTarget).toBe('kingdom:0');
        const stacks = kingdom.querySelectorAll('.color-stack');
        expect(stacks.length).toBe(1);
        expect(stacks[0].dataset.colorKey).toBe('GREEN');
        expect(kingdom.querySelector('.kingdom-hint')).toBeNull();
    });

    it('empty kingdom shows a hint', () => {
        const state = makeState();
        render(root, state);
        const kingdom = root.querySelector('.your-kingdom');
        expect(kingdom.dataset.dropTarget).toBe('kingdom:0');
        expect(kingdom.querySelectorAll('.color-stack').length).toBe(0);
        expect(kingdom.querySelector('.kingdom-hint')).not.toBeNull();
    });

    it('kingdom splits a color into sub-stacks when count exceeds set size', () => {
        const state = makeState({
            players: [
                {
                    id: 0, hand: [], bank: [],
                    properties: {
                        BROWN: [
                            { data: { id: 'b1', colorKey: 'BROWN', value: 1 } },
                            { data: { id: 'b2', colorKey: 'BROWN', value: 1 } },
                            { data: { id: 'b3', colorKey: 'BROWN', value: 1 } }
                        ]
                    }
                },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const kingdom = root.querySelector('.your-kingdom');
        const brownStacks = kingdom.querySelectorAll('.color-stack[data-color-key="BROWN"]');
        expect(brownStacks.length).toBe(2);
    });
});

describe('hand', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders one .card per card in hand', () => {
        const state = makeState({
            players: [
                {
                    id: 0,
                    hand: [
                        { data: { id: 'h1', name: 'A', value: 1, hex: '#aaa' } },
                        { data: { id: 'h2', name: 'B', value: 2, hex: '#bbb' } }
                    ],
                    bank: [], properties: {}
                },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const cards = root.querySelectorAll('.your-hand .card');
        expect(cards.length).toBe(2);
        expect(cards[0].dataset.cardId).toBe('h1');
    });

    it('hand cards are draggable', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [{ data: { id: 'h1', name: 'A', value: 1, hex: '#aaa' } }], bank: [], properties: {} },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const card = root.querySelector('.your-hand .card');
        expect(card.dataset.draggable).toBe('true');
    });
});

describe('zone strip', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders deck count', () => {
        const state = makeState({ deck: [{}, {}, {}, {}, {}] });
        render(root, state);
        expect(root.querySelector('[data-field="deck-count"]').textContent).toBe('5');
    });

    it('discard pile renders a visible growing stack with most-recent on top', () => {
        const state = makeState({ discard: [{ data: { id: 'd1', name: 'Old' } }, { data: { id: 'd2', name: 'Top' } }] });
        render(root, state);
        const cards = root.querySelectorAll('.zone-discard .card');
        expect(cards.length).toBe(2);
        // Last DOM card is the most recent (top of pile via stacking).
        expect(cards[cards.length - 1].dataset.cardId).toBe('d2');
        expect(root.querySelector('[data-field="discard-count"]').textContent).toBe('2');
    });

    it('discard pile shows +N overflow indicator past 6 cards', () => {
        const big = [];
        for (let i = 0; i < 10; i++) big.push({ data: { id: `d${i}`, name: `c${i}` } });
        const state = makeState({ discard: big });
        render(root, state);
        const cards = root.querySelectorAll('.zone-discard .card');
        expect(cards.length).toBe(6);
        expect(root.querySelector('.zone-discard .discard-more').textContent).toBe('+4');
    });

    it('renders buildings (house/hotel) on the completed kingdom set', () => {
        const state = makeState({
            players: [
                {
                    id: 0,
                    hand: [],
                    bank: [],
                    properties: { BROWN: [{ data: { id: 'p1', colorKey: 'BROWN', value: 1, type: 'PROPERTY' } }, { data: { id: 'p2', colorKey: 'BROWN', value: 1, type: 'PROPERTY' } }] },
                    buildings: { BROWN: [{ data: { id: 'h1', effect: 'house', value: 3 } }] }
                },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const chips = root.querySelectorAll('.your-kingdom .building-chip');
        expect(chips.length).toBe(1);
        expect(chips[0].classList.contains('house')).toBe(true);
    });

    it('discard is a drop target', () => {
        render(root, makeState());
        const discard = root.querySelector('.zone-discard');
        expect(discard.dataset.dropTarget).toBe('discard');
    });
});
