import { describe, it, expect, beforeEach } from 'vitest';
// Step 8: the engine's gameState singleton and legacy wrappers are gone.
// This suite owns its own state object and binds the old helper names to the
// state-first API, so the test bodies below stay byte-for-byte identical.
import {
    initGameStateS,
    startTurnS,
    endTurnS,
    calculateRentS,
    drawCardFromDeckS,
    playCardToZoneS,
    executeActionS,
    chargePlayerS,
    proposeActionS,
    reactJustSayNoS,
    resolvePendingActionS,
    playerHasPendingReactionS,
    checkWinnerS,
    swapWildColorS
} from '../src/js/engine.js';
import { enumerateLegalActions as enumerateLegalActionsState } from '../src/js/core/legal.js';

const gameState = {};
const initGameState = (cards, playerCount = 2, seed = 1, rngState = null) =>
    initGameStateS(gameState, cards, playerCount, seed, rngState);
const startTurn = (pid) => startTurnS(gameState, pid);
const endTurn = () => endTurnS(gameState);
const calculateRent = (pid, color) => calculateRentS(gameState, pid, color);
const drawCardFromDeck = (pid) => drawCardFromDeckS(gameState, pid);
const playCardToZone = (card, zone, pid, options = {}) => playCardToZoneS(gameState, card, zone, pid, options);
const executeAction = (card, pid, tid, options = {}) => executeActionS(gameState, card, pid, tid, options);
const enumerateLegalActions = (pid) => enumerateLegalActionsState(gameState, pid);
const chargePlayer = (payer, payee, amount) => chargePlayerS(gameState, payer, payee, amount);
const proposeAction = (card, pid, tid, options = {}) => proposeActionS(gameState, card, pid, tid, options);
const reactJustSayNo = (noCard, pid, against = null) => reactJustSayNoS(gameState, noCard, pid, against);
const resolvePendingAction = (concedingId = null) => resolvePendingActionS(gameState, concedingId);
const playerHasPendingReaction = (pid) => playerHasPendingReactionS(gameState, pid);
const checkWinner = () => checkWinnerS(gameState);
const swapWildColor = (pid, cardId, color) => swapWildColorS(gameState, pid, cardId, color);
void checkWinner; void swapWildColor;
import { CARD_TYPES } from '../src/js/cards.js';
import { createRng } from '../src/js/core/rng.js';

function card(type, extra = {}, id = 'c_' + Math.random().toString(36).slice(2, 8)) {
    return { data: { id, type, name: 'X', value: 1, ...extra }, zone: 'hand', owner: 0 };
}

function placeProperty(playerId, color, count = 1) {
    const p = gameState.players[playerId];
    if (!p.properties[color]) p.properties[color] = [];
    for (let i = 0; i < count; i++) {
        const c = card(CARD_TYPES.PROPERTY, { colorKey: color, value: 1 }, `p_${color}_${playerId}_${i}_${Math.random()}`);
        c.zone = 'board';
        c.owner = playerId;
        c.currentColor = color;
        p.properties[color].push(c);
    }
}

function placeBuilding(playerId, color, effect) {
    const p = gameState.players[playerId];
    if (!p.buildings[color]) p.buildings[color] = [];
    const b = card(CARD_TYPES.BUILDING, { effect, value: effect === 'house' ? 3 : 4 }, `b_${effect}_${color}_${playerId}`);
    b.zone = 'board';
    b.owner = playerId;
    p.buildings[color].push(b);
    return b;
}

function placeMoney(playerId, value) {
    const c = card(CARD_TYPES.MONEY, { value }, `m_${value}_${playerId}_${Math.random()}`);
    c.zone = 'bank';
    c.owner = playerId;
    gameState.players[playerId].bank.push(c);
    return c;
}

describe('enumerateLegalActions multi-opponent', () => {
    beforeEach(() => initGameState([], 3));

    it('enumerates sly_deal targets across all opponents', () => {
        placeProperty(1, 'BROWN', 1);
        placeProperty(2, 'PINK', 1);
        const sly = card(CARD_TYPES.ACTION, { effect: 'sly_deal' }, 'sly1');
        gameState.players[0].hand.push(sly);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const slyActions = actions.filter(a => a.type === 'propose' && a.cardId === 'sly1');
        const targetIds = new Set(slyActions.map(a => a.targetPlayerId));
        expect(targetIds.has(1)).toBe(true);
        expect(targetIds.has(2)).toBe(true);
    });

    it('enumerates multi-rent proposals for each opponent', () => {
        placeProperty(0, 'BROWN', 1);
        const rent = card(CARD_TYPES.RENT, { allowedColors: ['BROWN', 'LIGHTBLUE'], isMulti: true }, 'r1');
        gameState.players[0].hand.push(rent);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const rentActions = actions.filter(a => a.type === 'propose' && a.cardId === 'r1');
        const targets = new Set(rentActions.map(a => a.targetPlayerId));
        expect(targets.has(1)).toBe(true);
        expect(targets.has(2)).toBe(true);
    });

    it('enumerates single-color rent as a single fan-out propose (target null)', () => {
        placeProperty(0, 'BROWN', 1);
        const rent = card(CARD_TYPES.RENT, { allowedColors: ['BROWN'] }, 'r2');
        gameState.players[0].hand.push(rent);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const rentActions = actions.filter(a => a.type === 'propose' && a.cardId === 'r2');
        expect(rentActions.length).toBe(1);
        expect(rentActions[0].targetPlayerId).toBeNull();
    });

    it('enumerates birthday/debt_collector propose for each opponent', () => {
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const proposes = actions.filter(a => a.type === 'propose' && a.cardId === 'b1');
        expect(new Set(proposes.map(a => a.targetPlayerId))).toEqual(new Set([1, 2]));
    });
});

describe('deal_breaker enumeration and execution', () => {
    beforeEach(() => initGameState([], 2));

    it('emits one propose per completed set, not per card', () => {
        placeProperty(1, 'BROWN', 2);
        const db = card(CARD_TYPES.ACTION, { effect: 'deal_breaker' }, 'db1');
        gameState.players[0].hand.push(db);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const dbActions = actions.filter(a => a.type === 'propose' && a.cardId === 'db1');
        expect(dbActions.length).toBe(1);
        expect(dbActions[0].options.color).toBe('BROWN');
    });

    it('moves buildings along with properties to thief', () => {
        placeProperty(1, 'BROWN', 2);
        placeBuilding(1, 'BROWN', 'house');
        placeBuilding(1, 'BROWN', 'hotel');
        const db = card(CARD_TYPES.ACTION, { effect: 'deal_breaker' }, 'db1');
        gameState.players[0].hand.push(db);

        executeAction(db, 0, 1, { color: 'BROWN' });

        expect(gameState.players[0].properties.BROWN.length).toBe(2);
        expect(gameState.players[0].buildings.BROWN.length).toBe(2);
        expect((gameState.players[1].buildings.BROWN || []).length).toBe(0);
        expect((gameState.players[1].properties.BROWN || []).length).toBe(0);
    });
});

describe('reshuffle uses Fisher-Yates', () => {
    it('reshuffled deck contains all discard cards (permutation)', () => {
        initGameState([], 2);
        const cards = [];
        for (let i = 0; i < 30; i++) {
            cards.push(card(CARD_TYPES.MONEY, { value: 1 }, `d_${i}`));
        }
        cards.forEach(c => { c.zone = 'discard'; c.owner = null; });
        gameState.discard = cards.slice();
        gameState.deck = [];

        drawCardFromDeck(0);
        const allCards = [...gameState.deck, ...gameState.players[0].hand];
        const ids = new Set(allCards.map(c => c.data.id));
        expect(ids.size).toBe(30);
        cards.forEach(c => expect(ids.has(c.data.id)).toBe(true));
    });

    it('does not produce a strictly-reversed deck (probabilistic)', () => {
        initGameState([], 2);
        const cards = [];
        for (let i = 0; i < 30; i++) {
            cards.push(card(CARD_TYPES.MONEY, { value: 1 }, `d_${i}`));
        }
        cards.forEach(c => { c.zone = 'discard'; c.owner = null; });
        const original = cards.map(c => c.data.id);
        gameState.discard = cards.slice();
        gameState.deck = [];
        drawCardFromDeck(0);
        const reversed = original.slice().reverse();
        const top = gameState.deck.map(c => c.data.id);
        // Old buggy reshuffle produced exact reverse minus the popped card.
        // Vanishingly unlikely Fisher-Yates would also exactly reverse.
        const isReversedMinusOne = top.length === reversed.length - 1 &&
            top.every((id, i) => id === reversed[i]);
        expect(isReversedMinusOne).toBe(false);
    });
});

describe('doubleRentArmed end-turn cleanup', () => {
    it('clears doubleRentArmed when endTurn advances', () => {
        initGameState([], 2);
        gameState.players[0].hand = [];
        gameState.players[1].hand = [];
        gameState.deck = [];
        for (let i = 0; i < 10; i++) {
            const c = card(CARD_TYPES.MONEY, { value: 1 }, `dk_${i}`);
            c.zone = 'deck';
            gameState.deck.push(c);
        }
        gameState.turn = 0;
        gameState.doubleRentArmed = true;
        const ok = endTurn();
        expect(ok).toBe(true);
        expect(gameState.doubleRentArmed).toBe(false);
    });
});

describe('calculateRent Hotel/House interaction', () => {
    beforeEach(() => initGameState([], 2));

    it('Hotel without House does not add +4', () => {
        placeProperty(0, 'BROWN', 2);
        placeBuilding(0, 'BROWN', 'hotel');
        // BROWN full-set rent is 2 (rent[1]). No house, so hotel must not apply.
        expect(calculateRent(0, 'BROWN')).toBe(2);
    });

    it('Hotel + House adds +3 +4 = +7', () => {
        placeProperty(0, 'BROWN', 2);
        placeBuilding(0, 'BROWN', 'house');
        placeBuilding(0, 'BROWN', 'hotel');
        expect(calculateRent(0, 'BROWN')).toBe(2 + 3 + 4);
    });

    it('House alone adds +3', () => {
        placeProperty(0, 'BROWN', 2);
        placeBuilding(0, 'BROWN', 'house');
        expect(calculateRent(0, 'BROWN')).toBe(2 + 3);
    });
});

describe('Rainbow wild rent restriction (Hasbro rulebook)', () => {
    beforeEach(() => initGameState([], 2));

    function placeRainbow(playerId, color) {
        const p = gameState.players[playerId];
        if (!p.properties[color]) p.properties[color] = [];
        const c = card(CARD_TYPES.JOKER, { isRainbow: true, allowedColors: [], value: 0 }, `rw_${color}_${playerId}_${Math.random()}`);
        c.zone = 'board';
        c.owner = playerId;
        c.currentColor = color;
        p.properties[color].push(c);
    }

    it('charges 0 rent when the set contains only a rainbow wild', () => {
        placeRainbow(0, 'BROWN');
        expect(calculateRent(0, 'BROWN')).toBe(0);
    });

    it('charges 0 rent when the set contains only rainbow wilds (multiple)', () => {
        placeRainbow(0, 'GREEN');
        placeRainbow(0, 'GREEN');
        expect(calculateRent(0, 'GREEN')).toBe(0);
    });

    it('charges rent when at least one real property is present alongside a rainbow', () => {
        placeProperty(0, 'BROWN', 1);
        placeRainbow(0, 'BROWN');
        // Brown 2/2 = rent[1] = 2
        expect(calculateRent(0, 'BROWN')).toBe(2);
    });

    it('rainbow counts toward rent tier when accompanied by a real property', () => {
        placeProperty(0, 'GREEN', 1);
        placeRainbow(0, 'GREEN');
        placeRainbow(0, 'GREEN');
        // Green 3 cards → rent[2] = 7
        expect(calculateRent(0, 'GREEN')).toBe(7);
    });
});

describe('playCardToZone hotel prerequisite', () => {
    it('rejects placing hotel on a set without a house (card returned to hand)', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        const hotel = card(CARD_TYPES.BUILDING, { effect: 'hotel', value: 4 }, 'h1');
        gameState.players[0].hand.push(hotel);
        playCardToZone(hotel, 'board', 0, { color: 'BROWN' });
        expect(gameState.players[0].hand).toContain(hotel);
        expect((gameState.players[0].buildings.BROWN || []).length).toBe(0);
    });
});

describe('swapWildColor (rulebook: wilds move freely on own turn)', () => {
    beforeEach(() => initGameState([], 2));

    function placeWild(playerId, color, allowedColors, opts = {}) {
        const p = gameState.players[playerId];
        if (!p.properties[color]) p.properties[color] = [];
        const c = card(CARD_TYPES.JOKER, { allowedColors, value: opts.value ?? 2, isRainbow: !!opts.isRainbow }, `w_${color}_${Math.random()}`);
        c.zone = 'board';
        c.owner = playerId;
        c.currentColor = color;
        p.properties[color].push(c);
        return c;
    }

    it('swaps a dual-color wild between its allowed colors', async () => {
        const wild = placeWild(0, 'BROWN', ['BROWN', 'LIGHTBLUE']);
        gameState.turn = 0;
        const ok = swapWildColor(0, wild.data.id, 'LIGHTBLUE');
        expect(ok).toBe(true);
        expect(gameState.players[0].properties.BROWN || []).not.toContain(wild);
        expect(gameState.players[0].properties.LIGHTBLUE).toContain(wild);
        expect(wild.currentColor).toBe('LIGHTBLUE');
    });

    it('rejects swapping to a color not in allowedColors (dual wild)', async () => {
        const wild = placeWild(0, 'BROWN', ['BROWN', 'LIGHTBLUE']);
        gameState.turn = 0;
        const ok = swapWildColor(0, wild.data.id, 'GREEN');
        expect(ok).toBe(false);
        expect(gameState.players[0].properties.BROWN).toContain(wild);
    });

    it('allows a rainbow wild to swap to any valid property color', async () => {
        const wild = placeWild(0, 'BROWN', [], { isRainbow: true, value: 0 });
        gameState.turn = 0;
        const ok = swapWildColor(0, wild.data.id, 'GREEN');
        expect(ok).toBe(true);
        expect(gameState.players[0].properties.GREEN).toContain(wild);
    });

    it('rejects swap when it is not your turn', async () => {
        const wild = placeWild(0, 'BROWN', ['BROWN', 'LIGHTBLUE']);
        gameState.turn = 1; // opponent's turn
        const ok = swapWildColor(0, wild.data.id, 'LIGHTBLUE');
        expect(ok).toBe(false);
    });

    it('rejects swap of a wild that belongs to someone else', async () => {
        const wild = placeWild(1, 'BROWN', ['BROWN', 'LIGHTBLUE']);
        gameState.turn = 0;
        const ok = swapWildColor(0, wild.data.id, 'LIGHTBLUE');
        expect(ok).toBe(false);
        // wild is still in player 1's brown
        expect(gameState.players[1].properties.BROWN).toContain(wild);
    });

    it('rejects swap during a pending reaction', async () => {
        const wild = placeWild(0, 'BROWN', ['BROWN', 'LIGHTBLUE']);
        gameState.turn = 0;
        gameState.reactionTargetId = 1;
        const ok = swapWildColor(0, wild.data.id, 'LIGHTBLUE');
        expect(ok).toBe(false);
    });
});

describe('two-pack deck for 6+ players (rulebook)', () => {
    it('single-pack deck has 106 playable cards with unique IDs', async () => {
        const { generateDeck } = await import('../src/js/cards.js');
        const deck = generateDeck(1, createRng(1));
        expect(deck.length).toBe(106);
        const ids = new Set(deck.map(c => c.id));
        expect(ids.size).toBe(deck.length);
    });

    it('two-pack deck has 212 cards with unique IDs across both packs', async () => {
        const { generateDeck } = await import('../src/js/cards.js');
        const deck = generateDeck(2, createRng(1));
        expect(deck.length).toBe(212);
        const ids = new Set(deck.map(c => c.id));
        expect(ids.size).toBe(deck.length);
    });

    it('two-pack deck doubles every card template (e.g. 4 Deal Breakers, 20 Pass Go)', async () => {
        const { generateDeck } = await import('../src/js/cards.js');
        const deck = generateDeck(2, createRng(1));
        const dealBreakers = deck.filter(c => c.effect === 'deal_breaker').length;
        const passGo = deck.filter(c => c.effect === 'pass_go').length;
        const rainbowWilds = deck.filter(c => c.isRainbow).length;
        expect(dealBreakers).toBe(4);   // single pack has 2
        expect(passGo).toBe(20);        // single pack has 10
        expect(rainbowWilds).toBe(4);   // single pack has 2
    });

    it('initializes a 6-player game from a two-pack deck and deals 5 cards each', async () => {
        const { generateDeck } = await import('../src/js/cards.js');
        const rawDeck = generateDeck(2, createRng(1));
        const entities = rawDeck.map(c => ({ data: c, zone: 'deck', owner: null }));
        initGameState([...entities], 6);
        for (let i = 0; i < 6; i++) {
            for (let c = 0; c < 5; c++) drawCardFromDeck(i);
        }
        expect(gameState.players.length).toBe(6);
        gameState.players.forEach(p => expect(p.hand.length).toBe(5));
        // 212 - 30 dealt = 182 remaining in draw pile
        expect(gameState.deck.length).toBe(212 - 30);
    });
});

describe('building placement rulebook restrictions', () => {
    it('rejects placing a house on a Railroad set (rulebook explicit)', () => {
        initGameState([], 2);
        placeProperty(0, 'RAILROAD', 4); // full railroad set
        const house = card(CARD_TYPES.BUILDING, { effect: 'house', value: 3 }, 'h1');
        gameState.players[0].hand.push(house);
        playCardToZone(house, 'board', 0, { color: 'RAILROAD' });
        expect(gameState.players[0].hand).toContain(house);
        expect((gameState.players[0].buildings.RAILROAD || []).length).toBe(0);
    });

    it('rejects placing a house on a Utility set (rulebook explicit)', () => {
        initGameState([], 2);
        placeProperty(0, 'UTILITY', 2);
        const house = card(CARD_TYPES.BUILDING, { effect: 'house', value: 3 }, 'h2');
        gameState.players[0].hand.push(house);
        playCardToZone(house, 'board', 0, { color: 'UTILITY' });
        expect(gameState.players[0].hand).toContain(house);
        expect((gameState.players[0].buildings.UTILITY || []).length).toBe(0);
    });

    it('rejects placing a house on an incomplete set (rulebook: "onto a full set")', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 1); // only 1/2 brown
        const house = card(CARD_TYPES.BUILDING, { effect: 'house', value: 3 }, 'h3');
        gameState.players[0].hand.push(house);
        playCardToZone(house, 'board', 0, { color: 'BROWN' });
        expect(gameState.players[0].hand).toContain(house);
        expect((gameState.players[0].buildings.BROWN || []).length).toBe(0);
    });

    it('accepts placing a house on a complete coloured set', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        const house = card(CARD_TYPES.BUILDING, { effect: 'house', value: 3 }, 'h4');
        gameState.players[0].hand.push(house);
        playCardToZone(house, 'board', 0, { color: 'BROWN' });
        expect(gameState.players[0].hand).not.toContain(house);
        expect((gameState.players[0].buildings.BROWN || []).length).toBe(1);
    });
});

describe('birthday and rent direction (rulebook)', () => {
    it('birthday collects from every opponent', () => {
        initGameState([], 3);
        placeMoney(1, 5);
        placeMoney(2, 5);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        executeAction(bday, 0, 1, {});
        expect(gameState.players[1].bank.length).toBe(0);
        expect(gameState.players[2].bank.length).toBe(0);
        expect(gameState.players[0].bank.length).toBe(2);
    });

    it('single-color rent charges ALL opponents (rulebook fan-out)', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5);
        placeMoney(2, 5);
        const rent = card(CARD_TYPES.RENT, { allowedColors: ['BROWN'] }, 'r1');
        executeAction(rent, 0, null, { color: 'BROWN' });
        expect(gameState.players[1].bank.length).toBe(0);
        expect(gameState.players[2].bank.length).toBe(0);
        expect(gameState.players[0].bank.length).toBe(2);
    });

    it('multi-color rent (isMulti) charges only the chosen target', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5);
        placeMoney(2, 5);
        const rent = card(CARD_TYPES.RENT, { allowedColors: Object.keys({ BROWN: 1, LIGHTBLUE: 1 }), isMulti: true }, 'r1');
        executeAction(rent, 0, 1, { color: 'BROWN' });
        expect(gameState.players[1].bank.length).toBe(0);
        expect(gameState.players[2].bank.length).toBe(1);
        expect(gameState.players[0].bank.length).toBe(1);
    });

    it('rent on nonexistent color collects 0', () => {
        initGameState([], 3);
        placeMoney(1, 5);
        placeMoney(2, 5);
        const rent = card(CARD_TYPES.RENT, { allowedColors: ['PINK'] }, 'r1');
        executeAction(rent, 0, null, { color: 'PINK' });
        expect(gameState.players[1].bank.length).toBe(1);
        expect(gameState.players[2].bank.length).toBe(1);
        expect(gameState.players[0].bank.length).toBe(0);
    });
});

describe('Just Say No reach for fan-out', () => {
    it('birthday: one opponent JSN blocks only their portion', () => {
        initGameState([], 3);
        placeMoney(1, 1); placeMoney(1, 1);
        placeMoney(2, 1); placeMoney(2, 1);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        const jsn = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        gameState.players[1].hand.push(jsn);

        proposeAction(bday, 0, 1, {});
        expect(gameState.reactionTargetId).toBe(1);
        reactJustSayNo(jsn, 1);
        resolvePendingAction();
        expect(gameState.reactionTargetId).toBe(2);
        resolvePendingAction();

        expect(gameState.players[1].bank.length).toBe(2);
        expect(gameState.players[2].bank.length).toBe(0);
        expect(gameState.players[0].bank.length).toBe(2);
    });

    it('birthday: both opponents JSN -> action fully canceled', () => {
        initGameState([], 3);
        placeMoney(1, 1); placeMoney(1, 1);
        placeMoney(2, 1); placeMoney(2, 1);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        const jsn2 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn2');
        gameState.players[1].hand.push(jsn1);
        gameState.players[2].hand.push(jsn2);
        gameState.actionsLeft = 3;

        proposeAction(bday, 0, 1, {});
        reactJustSayNo(jsn1, 1);
        resolvePendingAction();
        expect(gameState.reactionTargetId).toBe(2);
        reactJustSayNo(jsn2, 2);
        resolvePendingAction();

        expect(gameState.players[1].bank.length).toBe(2);
        expect(gameState.players[2].bank.length).toBe(2);
        expect(gameState.players[0].bank.length).toBe(0);
    });

    it('proposer JSN-chains against a single-target JSN', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 1);
        const sly = card(CARD_TYPES.ACTION, { effect: 'sly_deal' }, 's1');
        gameState.players[0].hand.push(sly);
        const jsnTarget = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsnT');
        const jsnAttacker = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsnA');
        gameState.players[1].hand.push(jsnTarget);
        gameState.players[0].hand.push(jsnAttacker);

        const stolen = gameState.players[1].properties.BROWN[0];
        proposeAction(sly, 0, 1, { targetCard: stolen });
        expect(gameState.reactionTargetId).toBe(1);
        reactJustSayNo(jsnTarget, 1);
        expect(gameState.reactionTargetId).toBe(0);
        reactJustSayNo(jsnAttacker, 0);
        expect(gameState.reactionTargetId).toBe(1);
        resolvePendingAction(); // target has no more JSN, concedes; chain count = 2 (even) -> action fires

        expect(gameState.players[0].properties.BROWN.length).toBe(1);
        expect((gameState.players[1].properties.BROWN || []).length).toBe(0);
    });
});

describe('Just Say No parallel chains', () => {
    it('birthday 3-player: Lord 1 JSN, Lord 2 accepts -> only Lord 2 charged', () => {
        initGameState([], 3);
        placeMoney(1, 1); placeMoney(1, 1);
        placeMoney(2, 1); placeMoney(2, 1);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        gameState.players[1].hand.push(jsn1);

        proposeAction(bday, 0, 1, {});
        expect(gameState.pendingReactors.sort()).toEqual([1, 2]);

        reactJustSayNo(jsn1, 1);
        // Now chain for 1 is at count 1, attacker (0) is on the hook for chain 1.
        resolvePendingAction(0); // attacker lets it stand -> chain 1 cancelled
        // Chain for 2 still unsettled with count 0 -> reactor 2's turn
        resolvePendingAction(2); // 2 concedes

        expect(gameState.players[1].bank.length).toBe(2); // not charged
        expect(gameState.players[2].bank.length).toBe(0); // charged
        expect(gameState.players[0].bank.length).toBe(2);
    });

    it('birthday: Lord 1 JSN, proposer JSN-backs Lord 1, Lord 2 accepts -> both charged', () => {
        initGameState([], 3);
        placeMoney(1, 1); placeMoney(1, 1);
        placeMoney(2, 1); placeMoney(2, 1);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        const jsnA = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsnA');
        gameState.players[1].hand.push(jsn1);
        gameState.players[0].hand.push(jsnA);

        proposeAction(bday, 0, 1, {});
        reactJustSayNo(jsn1, 1);
        reactJustSayNo(jsnA, 0, 1); // proposer chains back vs reactor 1
        // chain 1 now at count 2 (even) -> reactor 1's turn again; they concede
        resolvePendingAction(1);
        // chain 2 still unsettled
        resolvePendingAction(2);

        expect(gameState.players[1].bank.length).toBe(0);
        expect(gameState.players[2].bank.length).toBe(0);
        expect(gameState.players[0].bank.length).toBe(4);
    });

    it('4-player single-color rent: 2 of 3 JSN, proposer chains back one -> that one charged, other cancelled, third accepts', () => {
        initGameState([], 4);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5);
        placeMoney(2, 5);
        placeMoney(3, 5);
        const rent = card(CARD_TYPES.RENT, { allowedColors: ['BROWN'] }, 'r1');
        gameState.players[0].hand.push(rent);
        const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        const jsn2 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn2');
        const jsnA = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsnA');
        gameState.players[1].hand.push(jsn1);
        gameState.players[2].hand.push(jsn2);
        gameState.players[0].hand.push(jsnA);

        proposeAction(rent, 0, null, { color: 'BROWN' });
        expect(gameState.pendingReactors.sort()).toEqual([1, 2, 3]);

        reactJustSayNo(jsn1, 1);
        reactJustSayNo(jsn2, 2);
        // Proposer chains back vs reactor 2
        reactJustSayNo(jsnA, 0, 2);
        // Now: chain 1 count=1 (attacker's move), chain 2 count=2 (reactor 2's move), chain 3 count=0 (reactor 3's move).
        resolvePendingAction(0); // attacker lets chain 1 stand -> cancelled
        resolvePendingAction(2); // reactor 2 has no more JSN, concedes -> charged
        resolvePendingAction(3); // reactor 3 concedes -> charged

        const sum = (pid) => gameState.players[pid].bank.reduce((s, c) => s + (c.data.value || 0), 0);
        expect(sum(1)).toBe(5); // cancelled, keeps their 5g
        expect(sum(2)).toBe(0); // charged 2g (forfeits the 5)
        expect(sum(3)).toBe(0); // charged 2g (forfeits the 5)
        expect(sum(0)).toBe(10); // collected both 5g
    });

    it('chain resolution order is independent: A-then-B equals B-then-A', () => {
        function run(orderFirst) {
            initGameState([], 3);
            placeMoney(1, 1); placeMoney(1, 1);
            placeMoney(2, 1); placeMoney(2, 1);
            const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
            gameState.players[0].hand.push(bday);
            const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
            gameState.players[1].hand.push(jsn1);

            proposeAction(bday, 0, 1, {});
            reactJustSayNo(jsn1, 1);
            if (orderFirst === 'reactor2-first') {
                resolvePendingAction(2);
                resolvePendingAction(0);
            } else {
                resolvePendingAction(0);
                resolvePendingAction(2);
            }
            return {
                p0: gameState.players[0].bank.length,
                p1: gameState.players[1].bank.length,
                p2: gameState.players[2].bank.length
            };
        }
        const a = run('reactor2-first');
        const b = run('attacker-first');
        expect(a).toEqual(b);
    });

    it('playerHasPendingReaction tracks per-chain state', () => {
        initGameState([], 3);
        placeMoney(1, 1); placeMoney(2, 1);
        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday' }, 'b1');
        gameState.players[0].hand.push(bday);
        const jsn1 = card(CARD_TYPES.ACTION, { effect: 'just_say_no' }, 'jsn1');
        gameState.players[1].hand.push(jsn1);

        proposeAction(bday, 0, 1, {});
        expect(playerHasPendingReaction(1)).toBe(true);
        expect(playerHasPendingReaction(2)).toBe(true);
        expect(playerHasPendingReaction(0)).toBe(false);

        reactJustSayNo(jsn1, 1);
        // Now attacker (0) has a chain waiting; reactor 1 does not.
        expect(playerHasPendingReaction(0)).toBe(true);
        expect(playerHasPendingReaction(1)).toBe(false);
        expect(playerHasPendingReaction(2)).toBe(true);
    });
});

describe('chargePlayer edge cases', () => {
    it('payer with empty bank and no properties = no-op, no error', () => {
        initGameState([], 2);
        expect(() => chargePlayer(0, 1, 5)).not.toThrow();
        expect(gameState.players[0].bank.length).toBe(0);
        expect(gameState.players[1].bank.length).toBe(0);
    });

    it('skips rainbow wild (value 0) when paying', () => {
        initGameState([], 2);
        const rw = card(CARD_TYPES.JOKER, { value: 0, isRainbow: true, allowedColors: ['BROWN'] }, 'rw1');
        rw.zone = 'bank'; rw.owner = 0;
        gameState.players[0].bank.push(rw);
        placeMoney(0, 2);
        chargePlayer(0, 1, 1);
        expect(gameState.players[1].bank.length).toBe(1);
        expect(gameState.players[1].bank[0].data.value).toBe(2);
        expect(gameState.players[0].bank).toContain(rw);
    });
});

describe('forced_deal with IDs in options', () => {
    it('executes forced_deal happy path using myCardId/targetCardId', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 1);
        placeProperty(1, 'PINK', 1);
        const mine = gameState.players[0].properties.BROWN[0];
        const theirs = gameState.players[1].properties.PINK[0];
        const fd = card(CARD_TYPES.ACTION, { effect: 'forced_deal' }, 'fd1');
        executeAction(fd, 0, 1, { myCardId: mine.data.id, targetCardId: theirs.data.id });

        expect((gameState.players[0].properties.BROWN || []).length).toBe(0);
        expect(gameState.players[0].properties.PINK.length).toBe(1);
        expect((gameState.players[1].properties.PINK || []).length).toBe(0);
        expect(gameState.players[1].properties.BROWN.length).toBe(1);
    });

    it('enumerates forced_deal proposals with myCardId and targetCardId populated', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 1);
        placeProperty(1, 'PINK', 1);
        const fd = card(CARD_TYPES.ACTION, { effect: 'forced_deal' }, 'fd1');
        gameState.players[0].hand.push(fd);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        const actions = enumerateLegalActions(0);
        const fdActions = actions.filter(a => a.type === 'propose' && a.cardId === 'fd1');
        expect(fdActions.length).toBeGreaterThan(0);
        expect(fdActions[0].options.myCardId).toBeDefined();
        expect(fdActions[0].options.targetCardId).toBeDefined();
    });
});

/**
 * Simulates the MP payment-picker stash trick: caller manually moves cards,
 * then stashes the remaining bank to zero, calls resolvePendingAction (which
 * runs chargePlayer but finds nothing to take), then restores the bank.
 * This mirrors what main.js showPaymentPicker does on the paying player's
 * machine and what applyRemoteAction does when paidCardIds are provided.
 */
describe('debt_collector propose → manual-pay stash trick', () => {
    it('payer manually transfers card then stash prevents double-charge', () => {
        initGameState([], 2);
        placeMoney(0, 2); // attacker bank
        const m5 = placeMoney(1, 5); // payer bank — will be manually moved

        const dc = card(CARD_TYPES.ACTION, { effect: 'debt_collector', value: 3, name: 'Tax Collector' }, 'dc_stash');
        gameState.players[0].hand.push(dc);
        gameState.turn = 0;
        gameState.actionsLeft = 3;

        proposeAction(dc, 0, 1, {});
        expect(gameState.pendingAction).not.toBeNull();

        // Simulate manual payment: move the 5M card from P1 to P0 (what the picker does)
        const payer  = gameState.players[1];
        const payee  = gameState.players[0];
        payer.bank = payer.bank.filter(c => c !== m5);
        m5.owner = 0;
        payee.bank.push(m5);

        // Stash trick: empty payer bank so chargePlayer is a no-op
        const stash = payer.bank.slice();
        payer.bank = [];
        resolvePendingAction(1);
        payer.bank.push(...stash);

        // P0 should have: original 2M + the 5M just paid = 2 cards
        expect(payee.bank.length).toBe(2);
        expect(payee.bank.some(c => c.data.id === 'dc_stash_nope' || c === m5)).toBe(true);
        // P1 should have nothing (empty after stash restore since stash was [])
        expect(payer.bank.length).toBe(0);
        // Action resolved
        expect(gameState.pendingAction).toBeNull();
    });

    it('payer with partial assets uses stash trick and payee still gets only manually transferred cards', () => {
        initGameState([], 2);
        const m2 = placeMoney(1, 2);
        const m3 = placeMoney(1, 3); // total 5g = exactly owed

        const dc = card(CARD_TYPES.ACTION, { effect: 'debt_collector', value: 3 }, 'dc_exact');
        gameState.players[0].hand.push(dc);
        gameState.turn = 0; gameState.actionsLeft = 3;
        proposeAction(dc, 0, 1, {});

        const payer = gameState.players[1];
        const payee = gameState.players[0];

        // Manually transfer both cards (simulating picker selecting 2+3=5g)
        [m2, m3].forEach(c => {
            payer.bank = payer.bank.filter(x => x !== c);
            c.owner = 0;
            payee.bank.push(c);
        });

        const stash = payer.bank.slice(); // []
        payer.bank = [];
        resolvePendingAction(1);
        payer.bank.push(...stash);

        expect(payee.bank.length).toBe(2);
        expect(payee.bank).toContain(m2);
        expect(payee.bank).toContain(m3);
        expect(payer.bank.length).toBe(0);
        expect(gameState.pendingAction).toBeNull();
    });

    it('birthday stash trick: all opponents pay manually, chargePlayer no-ops', () => {
        initGameState([], 3);
        const m2a = placeMoney(1, 2);
        const m2b = placeMoney(2, 2);
        placeMoney(0, 1); // attacker has some cash

        const bday = card(CARD_TYPES.ACTION, { effect: 'birthday', value: 2 }, 'bday_stash');
        gameState.players[0].hand.push(bday);
        gameState.turn = 0; gameState.actionsLeft = 3;
        proposeAction(bday, 0, null, {});

        const payee = gameState.players[0];

        // Simulate each opponent manually paying then stashing
        [1, 2].forEach(pid => {
            const payer = gameState.players[pid];
            const card2 = pid === 1 ? m2a : m2b;
            payer.bank = payer.bank.filter(c => c !== card2);
            card2.owner = 0;
            payee.bank.push(card2);

            const stash = payer.bank.slice();
            payer.bank = [];
            resolvePendingAction(pid);
            payer.bank.push(...stash);
        });

        expect(payee.bank.length).toBe(3); // 1M original + 2M + 2M
        expect(gameState.pendingAction).toBeNull();
    });
});

describe('chargePlayer minimum-change payment', () => {
    it('pays using smallest-first cards to limit overpayment', () => {
        initGameState([], 2);
        placeMoney(0, 1);
        placeMoney(0, 1);
        placeMoney(0, 5);
        chargePlayer(0, 1, 2);
        // Should pay with two 1s, not the 5.
        const paid = gameState.players[1].bank.reduce((s, c) => s + c.data.value, 0);
        expect(paid).toBe(2);
        expect(gameState.players[0].bank.length).toBe(1);
        expect(gameState.players[0].bank[0].data.value).toBe(5);
    });
});
