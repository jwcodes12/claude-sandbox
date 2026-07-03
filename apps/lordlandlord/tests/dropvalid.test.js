import { describe, it, expect } from 'vitest';
import { validDropTargetsFor, actionFromDrop } from '../src/js/dropvalid.js';
import { CARD_TYPES } from '../src/js/cards.js';

function makeState(overrides = {}) {
    return {
        players: [
            { id: 0, hand: [], bank: [], properties: {} },
            { id: 1, hand: [], bank: [], properties: {} }
        ],
        localPlayerId: 0,
        turn: 0,
        actionsLeft: 3,
        mustDiscard: 0,
        reactionTargetId: null,
        ...overrides
    };
}

function makeCard(type, extra = {}) {
    return { data: { id: 'c1', type, name: 'X', value: 1, ...extra }, zone: 'hand', owner: 0 };
}

describe('validDropTargetsFor', () => {
    it('money card is valid for bank only', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.MONEY);
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('bank:0')).toBe(true);
        expect(targets.has('discard')).toBe(false);
    });

    it('property card is valid for kingdom only (cannot be banked per rulebook)', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.PROPERTY, { colorKey: 'BROWN' });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('kingdom:0')).toBe(true);
        expect(targets.has('bank:0')).toBe(false);
    });

    it('action card is valid for discard and bank', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.ACTION);
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('discard')).toBe(true);
        expect(targets.has('bank:0')).toBe(true);
    });

    it('no targets when not your turn', () => {
        const state = makeState({ turn: 1 });
        const card = makeCard(CARD_TYPES.MONEY);
        const targets = validDropTargetsFor(card, state);
        expect(targets.size).toBe(0);
    });

    it('no targets when actionsLeft is 0', () => {
        const state = makeState({ actionsLeft: 0 });
        const card = makeCard(CARD_TYPES.MONEY);
        const targets = validDropTargetsFor(card, state);
        expect(targets.size).toBe(0);
    });

    it('only discard target when forced to discard', () => {
        const state = makeState({ mustDiscard: 2 });
        const card = makeCard(CARD_TYPES.MONEY);
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('discard')).toBe(true);
        expect(targets.has('bank:0')).toBe(false);
    });
});

describe('actionFromDrop', () => {
    it('money to bank -> play to bank', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'bank:0', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'bank' });
    });

    it('property to kingdom -> play to board with color from card', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.PROPERTY, { colorKey: 'RED' });
        const action = actionFromDrop(card, 'kingdom:0', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'board', options: { color: 'RED' } });
    });

    it('forced discard -> discard action', () => {
        const state = makeState({ mustDiscard: 1 });
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'discard', state);
        expect(action).toEqual({ type: 'discard', cardId: 'c1' });
    });

    it('invalid drop returns null', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'kingdom:0', state);
        expect(action).toBeNull();
    });
});

describe('drag-to-play sentinels (2026-05-14)', () => {
    it('rent card drops on discard return a tap-via-drop sentinel', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.RENT, { allowedColors: ['BROWN', 'LIGHTBLUE'] });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('discard')).toBe(true);
        const action = actionFromDrop(card, 'discard', state);
        expect(action).toEqual({ type: 'tap-via-drop', cardId: 'c1' });
    });

    it('rent card can also drop on bank for value', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.RENT, { allowedColors: ['BROWN'] });
        const action = actionFromDrop(card, 'bank:0', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'bank' });
    });

    it('propose-effect action card (sly_deal) drops to discard via picker', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.ACTION, { effect: 'sly_deal' });
        const action = actionFromDrop(card, 'discard', state);
        expect(action).toEqual({ type: 'tap-via-drop', cardId: 'c1' });
    });

    it('auto-fire action card (pass_go) drops to discard as direct play', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.ACTION, { effect: 'pass_go' });
        const action = actionFromDrop(card, 'discard', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'discard' });
    });

    it('just_say_no has no play target — bank only', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.ACTION, { effect: 'just_say_no' });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('bank:0')).toBe(true);
        expect(targets.has('discard')).toBe(false);
    });

    it('building drag to kingdom routes through picker', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.BUILDING, { effect: 'house' });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('kingdom:0')).toBe(true);
        expect(targets.has('bank:0')).toBe(true);
        const action = actionFromDrop(card, 'kingdom:0', state);
        expect(action).toEqual({ type: 'tap-via-drop', cardId: 'c1' });
    });

    it('property wildcard cannot be banked', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.JOKER, { allowedColors: ['BROWN', 'LIGHTBLUE'] });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('bank:0')).toBe(false);
        expect(targets.has('kingdom:0')).toBe(true);
    });
});
