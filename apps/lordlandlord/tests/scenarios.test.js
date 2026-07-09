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
import { CARD_TYPES, PROPERTIES } from '../src/js/cards.js';

let __idc = 0;
function nid(prefix='c') { return `${prefix}_${++__idc}`; }

function mkCard(type, data = {}, id) {
    return { data: { id: id || nid('c'), type, name: data.name || 'X', value: data.value ?? 1, ...data }, zone: 'hand', owner: 0 };
}
function mkProperty(color, id) {
    const c = mkCard(CARD_TYPES.PROPERTY, { colorKey: color, value: PROPERTIES[color].value, name: PROPERTIES[color].name }, id);
    return c;
}
function mkMoney(value, id) { return mkCard(CARD_TYPES.MONEY, { value, name: `${value}g` }, id); }
function mkAction(effect, value=1, id) { return mkCard(CARD_TYPES.ACTION, { effect, value, name: effect.toUpperCase() }, id); }
function mkRent(allowedColors, opts={}, id) {
    return mkCard(CARD_TYPES.RENT, { allowedColors, isMulti: !!opts.isMulti, value: opts.value || 1, name: 'RENT' }, id);
}
function mkBuilding(effect, id) { return mkCard(CARD_TYPES.BUILDING, { effect, value: effect === 'house' ? 3 : 4, name: effect }, id); }
function mkWild(colors, value=2, isRainbow=false, id) {
    return mkCard(CARD_TYPES.JOKER, { allowedColors: colors, value, isRainbow, name: 'WILD' }, id);
}

function placeProperty(playerId, color, count = 1, mkFn = null) {
    const p = gameState.players[playerId];
    if (!p.properties[color]) p.properties[color] = [];
    for (let i = 0; i < count; i++) {
        const c = mkFn ? mkFn() : mkProperty(color);
        c.zone = 'board';
        c.owner = playerId;
        c.currentColor = color;
        p.properties[color].push(c);
    }
}
function placeBuilding(playerId, color, effect) {
    const p = gameState.players[playerId];
    if (!p.buildings[color]) p.buildings[color] = [];
    const b = mkBuilding(effect);
    b.zone = 'board'; b.owner = playerId;
    p.buildings[color].push(b);
    return b;
}
function placeMoney(playerId, value) {
    const c = mkMoney(value);
    c.zone = 'bank'; c.owner = playerId;
    gameState.players[playerId].bank.push(c);
    return c;
}
function bankTotal(pid) {
    return gameState.players[pid].bank.reduce((s,c)=>s+(c.data.value||0), 0);
}

// ============================================================================
// DEBT COLLECTOR (Tax Collector)
// ============================================================================
describe('debt_collector card effect across states', () => {
    beforeEach(() => initGameState([], 2));

    it('target with bank > 5g pays exactly 5g (smallest-first)', () => {
        placeMoney(1, 1); placeMoney(1, 2); placeMoney(1, 3); placeMoney(1, 5);
        const tc = mkAction('debt_collector', 3);
        executeAction(tc, 0, 1, {});
        expect(gameState.lastResolution.totalPaid).toBe(5);
        expect(gameState.lastResolution.dryPayers).toBe(0);
        expect(bankTotal(0)).toBe(5);
        expect(bankTotal(1)).toBe(6);
    });

    it('target with exactly 3g pays 3g, surplus owed forfeited', () => {
        placeMoney(1, 1); placeMoney(1, 2);
        const tc = mkAction('debt_collector', 3);
        executeAction(tc, 0, 1, {});
        expect(gameState.lastResolution.totalPaid).toBe(3);
        expect(gameState.lastResolution.dryPayers).toBe(0);
        expect(bankTotal(1)).toBe(0);
        expect(bankTotal(0)).toBe(3);
    });

    it('target with no bank pays a property (rulebook: bank or properties)', () => {
        // Mediterranean (Brown) is value 1g. Demand is 5g. Payer pays the
        // property (only thing they have); change is not given so the rest
        // of the debt is forfeit.
        placeProperty(1, 'BROWN', 1);
        const tc = mkAction('debt_collector', 3);
        executeAction(tc, 0, 1, {});
        expect(gameState.lastResolution.totalPaid).toBe(1);
        // Property moved from payer to payee's property collection.
        expect((gameState.players[0].properties.BROWN || []).length).toBe(1);
        expect((gameState.players[1].properties.BROWN || []).length).toBe(0);
    });

    it('target with absolutely nothing: dryPayers=1', () => {
        const tc = mkAction('debt_collector', 3);
        executeAction(tc, 0, 1, {});
        expect(gameState.lastResolution.totalPaid).toBe(0);
        expect(gameState.lastResolution.dryPayers).toBe(1);
    });

    it('target plays JSN: action canceled, both cards discarded, no transfer', () => {
        placeMoney(1, 5);
        const tc = mkAction('debt_collector', 3, 'tc1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(tc);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(tc, 0, 1, {});
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0); // attacker concedes chain
        expect(gameState.pendingAction).toBeNull();
        expect(bankTotal(1)).toBe(5);
        expect(bankTotal(0)).toBe(0);
        expect(gameState.discard).toContain(tc);
        expect(gameState.discard).toContain(jsn);
    });

    it('target JSNs, proposer JSN-backs: action goes through', () => {
        placeMoney(1, 5);
        const tc = mkAction('debt_collector', 3, 'tc1');
        const jsnT = mkAction('just_say_no', 4, 'jsnT');
        const jsnA = mkAction('just_say_no', 4, 'jsnA');
        gameState.players[0].hand.push(tc, jsnA);
        gameState.players[1].hand.push(jsnT);
        gameState.actionsLeft = 3;
        proposeAction(tc, 0, 1, {});
        reactJustSayNo(jsnT, 1);
        reactJustSayNo(jsnA, 0, 1);
        resolvePendingAction(1); // reactor 1 has no more JSN
        expect(bankTotal(0)).toBe(5);
        expect(bankTotal(1)).toBe(0);
    });
});

// ============================================================================
// BIRTHDAY / FEAST DAY
// ============================================================================
describe('birthday card effect across states', () => {
    it('3 players: each non-proposer pays 2g (no change given on 5g card)', () => {
        // Each opponent holds only a 5g card; debt is 2g; per rules no change
        // is given, so each forfeits the whole 5g.
        initGameState([], 3);
        placeMoney(1, 5); placeMoney(2, 5);
        const bd = mkAction('birthday', 2);
        executeAction(bd, 0, null, {});
        expect(gameState.lastResolution.totalPaid).toBe(10);
        expect(gameState.lastResolution.payers).toBe(2);
    });

    it('3 players: each non-proposer pays exactly 2g when they have a 2g card', () => {
        initGameState([], 3);
        placeMoney(1, 2); placeMoney(1, 5);
        placeMoney(2, 2); placeMoney(2, 5);
        const bd = mkAction('birthday', 2);
        executeAction(bd, 0, null, {});
        expect(gameState.lastResolution.totalPaid).toBe(4);
        expect(gameState.lastResolution.payers).toBe(2);
        expect(bankTotal(1)).toBe(5);
        expect(bankTotal(2)).toBe(5);
    });

    it('4 players, one JSN: that one canceled, others pay', () => {
        initGameState([], 4);
        placeMoney(1, 5); placeMoney(2, 5); placeMoney(3, 5);
        const bd = mkAction('birthday', 2, 'bd1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(bd);
        gameState.players[2].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(bd, 0, 1, {});
        reactJustSayNo(jsn, 2);
        resolvePendingAction(0); // attacker concedes chain 2
        resolvePendingAction(1); // reactor 1 accepts
        resolvePendingAction(3); // reactor 3 accepts
        // Opp 2 JSN-canceled (keeps 5g). Opp 1 and 3 each pay 5g forfeiting
        // 3g overage. Attacker collects 10g.
        expect(bankTotal(2)).toBe(5);
        expect(bankTotal(1)).toBe(0);
        expect(bankTotal(3)).toBe(0);
        expect(bankTotal(0)).toBe(10);
    });

    it('4 players all broke: totalPaid=0, dryPayers=3', () => {
        initGameState([], 4);
        const bd = mkAction('birthday', 2);
        executeAction(bd, 0, null, {});
        expect(gameState.lastResolution.totalPaid).toBe(0);
        expect(gameState.lastResolution.dryPayers).toBe(3);
        expect(gameState.lastResolution.payers).toBe(3);
    });

    it('mixed: 5g, 1g, 0 -> 5g card forfeit + 1g, totalPaid=6, dryPayers=1', () => {
        // Per rulebook: no change. 5g card surrendered for 2g debt (forfeit 3g).
        // 1g card is all the second player has -> partial pay 1g.
        // Third player has nothing -> dry.
        initGameState([], 4);
        placeMoney(1, 5); placeMoney(2, 1);
        const bd = mkAction('birthday', 2);
        executeAction(bd, 0, null, {});
        expect(gameState.lastResolution.totalPaid).toBe(6);
        expect(gameState.lastResolution.dryPayers).toBe(1);
    });
});

// ============================================================================
// PASS GO / ROYAL CHARTER
// ============================================================================
describe('pass_go card effect', () => {
    beforeEach(() => initGameState([], 2));

    it('draws 2 cards from deck', () => {
        const pg = mkAction('pass_go', 1);
        gameState.players[0].hand.push(pg);
        for (let i = 0; i < 5; i++) {
            const c = mkMoney(1); c.zone = 'deck';
            gameState.deck.push(c);
        }
        const before = gameState.players[0].hand.length;
        executeAction(pg, 0, null, {});
        // hand went from 1 to 0 (played pg), +2 draws = 2
        expect(gameState.players[0].hand.length).toBe(before - 1 + 2);
        expect(gameState.discard).toContain(pg);
    });

    it('deck has 1 card: draws 1 then no shuffle target -> just 1', () => {
        const pg = mkAction('pass_go', 1);
        gameState.players[0].hand.push(pg);
        const onlyCard = mkMoney(1); onlyCard.zone = 'deck';
        gameState.deck.push(onlyCard);
        executeAction(pg, 0, null, {});
        // After executing pg, draws 1 (the only deck card), then tries 2nd: deck empty,
        // discard has pg, so reshuffle of [pg] -> draws pg back. So +2 either way.
        // Let's verify behaviour: 2 attempts, both eventually draw something.
        expect(gameState.players[0].hand.length).toBeGreaterThanOrEqual(1);
    });

    it('deck empty + discard non-empty: reshuffle fires, draws 2', () => {
        const pg = mkAction('pass_go', 1, 'pg1');
        gameState.players[0].hand.push(pg);
        for (let i = 0; i < 5; i++) {
            const c = mkMoney(1, `d${i}`); c.zone = 'discard'; c.owner = null;
            gameState.discard.push(c);
        }
        executeAction(pg, 0, null, {});
        expect(gameState.players[0].hand.length).toBe(2);
    });
});

// ============================================================================
// RENT (single-color fan-out)
// ============================================================================
describe('rent single-color fan-out', () => {
    it('3 players, complete BROWN set: all opponents pay full set rent (no change)', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5); placeMoney(2, 5);
        const r = mkRent(['BROWN']);
        executeAction(r, 0, null, { color: 'BROWN' });
        expect(gameState.lastResolution.amount).toBe(2);
        expect(gameState.lastResolution.payers).toBe(2);
        // Each opponent only has 5g card; forfeits whole thing (no change).
        expect(bankTotal(0)).toBe(10);
    });

    it('one opponent JSNs: only their portion canceled', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5); placeMoney(2, 5);
        const r = mkRent(['BROWN'], {}, 'r1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(r);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(r, 0, null, { color: 'BROWN' });
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0);
        resolvePendingAction(2);
        // Opp 1 JSN-canceled (keeps 5g). Opp 2 has only 5g, no change given.
        expect(bankTotal(1)).toBe(5);
        expect(bankTotal(2)).toBe(0);
    });

    it('proposer has none of that color: amount=0, still fires', () => {
        initGameState([], 3);
        placeMoney(1, 5); placeMoney(2, 5);
        const r = mkRent(['BROWN']);
        executeAction(r, 0, null, { color: 'BROWN' });
        expect(gameState.lastResolution.amount).toBe(0);
        expect(bankTotal(0)).toBe(0);
    });
});

// ============================================================================
// RENT (multi-color isMulti)
// ============================================================================
describe('rent multi-color (isMulti) targets only one', () => {
    it('only chosen opponent charged', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5); placeMoney(2, 5);
        const r = mkRent(['BROWN','LIGHTBLUE'], { isMulti: true });
        executeAction(r, 0, 1, { color: 'BROWN' });
        // Opp 1 owes 2g, has only 5g card -> forfeits whole thing.
        expect(bankTotal(1)).toBe(0);
        expect(bankTotal(2)).toBe(5);
    });

    it('chosen opponent JSNs: full cancel (single-target path)', () => {
        initGameState([], 3);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 5); placeMoney(2, 5);
        const r = mkRent(['BROWN','LIGHTBLUE'], { isMulti: true }, 'r1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(r);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(r, 0, 1, { color: 'BROWN' });
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0);
        expect(gameState.pendingAction).toBeNull();
        expect(bankTotal(1)).toBe(5);
        expect(bankTotal(2)).toBe(5);
    });
});

// ============================================================================
// DOUBLE RENT
// ============================================================================
describe('double_rent effect', () => {
    it('sets armed flag and next rent doubles, then clears', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        placeMoney(1, 10);
        const dr = mkAction('double_rent', 1);
        executeAction(dr, 0, null, {});
        expect(gameState.doubleRentArmed).toBe(true);

        const r = mkRent(['BROWN']);
        executeAction(r, 0, null, { color: 'BROWN' });
        expect(gameState.lastResolution.amount).toBe(4); // 2 * 2
        expect(gameState.doubleRentArmed).toBe(false);
    });

    it('armed flag cleared on endTurn if unused', () => {
        initGameState([], 2);
        gameState.players[0].hand = []; gameState.players[1].hand = [];
        for (let i = 0; i < 10; i++) {
            const c = mkMoney(1); c.zone='deck';
            gameState.deck.push(c);
        }
        gameState.doubleRentArmed = true;
        gameState.turn = 0;
        endTurn();
        expect(gameState.doubleRentArmed).toBe(false);
    });
});

// ============================================================================
// SLY DEAL
// ============================================================================
describe('sly_deal effect', () => {
    it('steals a single property', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 1);
        const stolen = gameState.players[1].properties.BROWN[0];
        const sd = mkAction('sly_deal', 3);
        executeAction(sd, 0, 1, { targetCard: stolen });
        expect(gameState.players[0].properties.BROWN).toHaveLength(1);
        expect((gameState.players[1].properties.BROWN || [])).toHaveLength(0);
    });

    it('enumeration excludes completed sets', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 2); // complete (count=2)
        placeProperty(1, 'PINK', 1); // incomplete
        const sd = mkAction('sly_deal', 3, 'sd1');
        gameState.players[0].hand.push(sd);
        gameState.turn = 0; gameState.actionsLeft = 3;
        const actions = enumerateLegalActions(0).filter(a => a.cardId === 'sd1' && a.type === 'propose');
        const colors = new Set(actions.map(a => a.options.color));
        expect(colors.has('PINK')).toBe(true);
        expect(colors.has('BROWN')).toBe(false);
    });

    it('target JSN cancels: property stays', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 1);
        const stolen = gameState.players[1].properties.BROWN[0];
        const sd = mkAction('sly_deal', 3, 'sd1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(sd);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(sd, 0, 1, { targetCard: stolen });
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0);
        expect((gameState.players[1].properties.BROWN || [])).toHaveLength(1);
        expect((gameState.players[0].properties.BROWN || [])).toHaveLength(0);
    });
});

// ============================================================================
// FORCED DEAL
// ============================================================================
describe('forced_deal effect', () => {
    it('swaps properties between players', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 1);
        placeProperty(1, 'PINK', 1);
        const mine = gameState.players[0].properties.BROWN[0];
        const theirs = gameState.players[1].properties.PINK[0];
        const fd = mkAction('forced_deal', 3);
        executeAction(fd, 0, 1, { targetCard: theirs, myCard: mine });
        expect(gameState.players[0].properties.BROWN).toHaveLength(0);
        expect(gameState.players[0].properties.PINK[0]).toBe(theirs);
        expect(gameState.players[1].properties.BROWN[0]).toBe(mine);
        expect(gameState.players[1].properties.PINK).toHaveLength(0);
    });

    it('enumeration: both sides must be from incomplete sets', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2); // complete
        placeProperty(0, 'PINK', 1);  // incomplete
        placeProperty(1, 'RED', 3);   // complete
        placeProperty(1, 'YELLOW', 1); // incomplete
        const fd = mkAction('forced_deal', 3, 'fd1');
        gameState.players[0].hand.push(fd);
        gameState.turn = 0; gameState.actionsLeft = 3;
        const actions = enumerateLegalActions(0).filter(a => a.cardId === 'fd1' && a.type === 'propose');
        // every action must use PINK (mine) and YELLOW (theirs)
        actions.forEach(a => {
            const myCard = gameState.players[0].properties.PINK.find(c => c.data.id === a.options.myCardId);
            const targetCard = gameState.players[1].properties.YELLOW.find(c => c.data.id === a.options.targetCardId);
            expect(myCard).toBeDefined();
            expect(targetCard).toBeDefined();
        });
        expect(actions.length).toBeGreaterThan(0);
    });
});

// ============================================================================
// DEAL BREAKER
// ============================================================================
describe('deal_breaker effect', () => {
    it('steals complete set with buildings', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 2);
        placeBuilding(1, 'BROWN', 'house');
        placeBuilding(1, 'BROWN', 'hotel');
        const db = mkAction('deal_breaker', 5);
        executeAction(db, 0, 1, { color: 'BROWN' });
        expect(gameState.players[0].properties.BROWN).toHaveLength(2);
        expect(gameState.players[0].buildings.BROWN).toHaveLength(2);
        expect(gameState.players[1].properties.BROWN).toHaveLength(0);
        expect(gameState.players[1].buildings.BROWN).toHaveLength(0);
    });

    it('JSN cancels deal_breaker', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 2);
        const db = mkAction('deal_breaker', 5, 'db1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(db);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(db, 0, 1, { color: 'BROWN' });
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0);
        expect(gameState.players[1].properties.BROWN).toHaveLength(2);
        expect(gameState.players[0].properties.BROWN || []).toHaveLength(0);
    });
});

// ============================================================================
// HOUSE / HOTEL
// ============================================================================
describe('house/hotel placement and rent bonuses', () => {
    beforeEach(() => initGameState([], 2));

    it('house on complete PINK adds 3 to rent', () => {
        placeProperty(0, 'PINK', 3);
        const baseRent = PROPERTIES.PINK.rent[2];
        const h = mkBuilding('house');
        gameState.players[0].hand.push(h);
        playCardToZone(h, 'board', 0, { color: 'PINK' });
        expect(calculateRent(0, 'PINK')).toBe(baseRent + 3);
    });

    it('hotel on complete PINK without house: rejected, returned to hand', () => {
        placeProperty(0, 'PINK', 3);
        const ht = mkBuilding('hotel');
        gameState.players[0].hand.push(ht);
        playCardToZone(ht, 'board', 0, { color: 'PINK' });
        expect(gameState.players[0].hand).toContain(ht);
        expect((gameState.players[0].buildings.PINK || [])).toHaveLength(0);
    });

    it('hotel after house adds +4', () => {
        placeProperty(0, 'PINK', 3);
        placeBuilding(0, 'PINK', 'house');
        const ht = mkBuilding('hotel');
        gameState.players[0].hand.push(ht);
        playCardToZone(ht, 'board', 0, { color: 'PINK' });
        const base = PROPERTIES.PINK.rent[2];
        expect(calculateRent(0, 'PINK')).toBe(base + 3 + 4);
    });

    it('cannot place a second house on same set', () => {
        placeProperty(0, 'PINK', 3);
        placeBuilding(0, 'PINK', 'house');
        const h2 = mkBuilding('house');
        gameState.players[0].hand.push(h2);
        playCardToZone(h2, 'board', 0, { color: 'PINK' });
        expect(gameState.players[0].hand).toContain(h2);
        expect(gameState.players[0].buildings.PINK).toHaveLength(1);
    });

    it('cannot place a second hotel on same set', () => {
        placeProperty(0, 'PINK', 3);
        placeBuilding(0, 'PINK', 'house');
        placeBuilding(0, 'PINK', 'hotel');
        const h2 = mkBuilding('hotel');
        gameState.players[0].hand.push(h2);
        playCardToZone(h2, 'board', 0, { color: 'PINK' });
        expect(gameState.players[0].hand).toContain(h2);
        expect(gameState.players[0].buildings.PINK).toHaveLength(2);
    });

    it('enumeration excludes RAILROAD and UTILITY', () => {
        placeProperty(0, 'RAILROAD', 4);
        placeProperty(0, 'UTILITY', 2);
        const h = mkBuilding('house', 'h1');
        gameState.players[0].hand.push(h);
        gameState.turn = 0; gameState.actionsLeft = 3;
        const actions = enumerateLegalActions(0).filter(a => a.cardId === 'h1' && a.zone === 'board');
        const colors = new Set(actions.map(a => a.options.color));
        expect(colors.has('RAILROAD')).toBe(false);
        expect(colors.has('UTILITY')).toBe(false);
    });
});

// ============================================================================
// JUST SAY NO availability
// ============================================================================
describe('Just Say No availability rules', () => {
    it('JSN never appears in normal-turn enumeration', () => {
        initGameState([], 2);
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(jsn);
        gameState.turn = 0; gameState.actionsLeft = 3;
        const actions = enumerateLegalActions(0);
        const jsnActions = actions.filter(a => a.cardId === 'jsn1' && a.type !== 'play');
        // 'play' to bank is allowed (banking any card), but no propose or react-no without pending action.
        const proposeOrReact = jsnActions.filter(a => a.type === 'propose' || a.type === 'react-no');
        expect(proposeOrReact).toHaveLength(0);
    });

    it('JSN appears as react-no only when player has pending reaction', () => {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 1);
        const stolen = gameState.players[1].properties.BROWN[0];
        const sd = mkAction('sly_deal', 3, 'sd1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(sd, 0, 1, { targetCard: stolen });
        expect(playerHasPendingReaction(1)).toBe(true);
        const reactActions = enumerateLegalActions(1).filter(a => a.type === 'react-no');
        expect(reactActions.length).toBe(1);
    });
});

// ============================================================================
// PROPERTY WILDCARDS
// ============================================================================
describe('property wildcards', () => {
    it('standard wild placed under one of its allowed colors', () => {
        initGameState([], 2);
        const w = mkWild(['BROWN','LIGHTBLUE'], 1);
        gameState.players[0].hand.push(w);
        playCardToZone(w, 'board', 0, { color: 'BROWN' });
        expect(gameState.players[0].properties.BROWN).toContain(w);
        expect(w.currentColor).toBe('BROWN');
    });

    it('rainbow wild value 0 is NOT consumable by chargePlayer', () => {
        initGameState([], 2);
        const rw = mkWild(Object.keys(PROPERTIES), 0, true);
        rw.zone = 'bank'; rw.owner = 0;
        gameState.players[0].bank.push(rw);
        placeMoney(0, 2);
        chargePlayer(0, 1, 5);
        expect(gameState.players[0].bank).toContain(rw);
        expect(gameState.players[1].bank.map(c=>c.data.value)).toEqual([2]);
    });
});

// ============================================================================
// TURN DISCIPLINE
// ============================================================================
describe('turn discipline', () => {
    it('startTurn draws 2 by default, 5 if hand empty', () => {
        initGameState([], 2);
        gameState.players[0].hand = [];
        gameState.players[1].hand = [];
        for (let i = 0; i < 20; i++) { const c = mkMoney(1); c.zone='deck'; gameState.deck.push(c); }
        startTurn(0);
        expect(gameState.players[0].hand).toHaveLength(5);
        expect(gameState.actionsLeft).toBe(3);
        // give p0 some non-empty hand
        startTurn(1);
        // p1 also starts empty -> 5
        expect(gameState.players[1].hand).toHaveLength(5);

        // simulate p0 wrap-around
        startTurn(0);
        expect(gameState.players[0].hand).toHaveLength(7); // had 5, +2
    });

    it('endTurn with hand > 7 returns false and sets mustDiscard', () => {
        initGameState([], 2);
        gameState.players[0].hand = [];
        for (let i = 0; i < 9; i++) {
            const c = mkMoney(1); c.zone='hand'; c.owner=0;
            gameState.players[0].hand.push(c);
        }
        gameState.turn = 0;
        const ok = endTurn();
        expect(ok).toBe(false);
        expect(gameState.mustDiscard).toBe(2);
    });
});

// ============================================================================
// JSN CHAIN PARITY DEPTH
// ============================================================================
describe('JSN chain depth parity', () => {
    function setupSlyDeal(jsnPattern) {
        initGameState([], 2);
        placeProperty(1, 'BROWN', 1);
        const stolen = gameState.players[1].properties.BROWN[0];
        const sd = mkAction('sly_deal', 3, 'sd1');
        gameState.players[0].hand.push(sd);
        gameState.actionsLeft = 3;
        const jsnCards = jsnPattern.map((p, i) => {
            const j = mkAction('just_say_no', 4, `jsn${i}`);
            gameState.players[p].hand.push(j);
            return { player: p, card: j };
        });
        proposeAction(sd, 0, 1, { targetCard: stolen });
        return { stolen, jsnCards };
    }

    it('single JSN: action canceled (chain=1, odd)', () => {
        const { jsnCards } = setupSlyDeal([1]);
        reactJustSayNo(jsnCards[0].card, 1);
        resolvePendingAction(0);
        expect((gameState.players[1].properties.BROWN || []).length).toBe(1);
    });

    it('2-level (target, proposer): action goes through (chain=2, even)', () => {
        const { jsnCards } = setupSlyDeal([1, 0]);
        reactJustSayNo(jsnCards[0].card, 1);
        reactJustSayNo(jsnCards[1].card, 0, 1);
        resolvePendingAction(1);
        expect((gameState.players[0].properties.BROWN || []).length).toBe(1);
    });

    it('3-level (target, proposer, target): canceled (chain=3, odd)', () => {
        const { jsnCards } = setupSlyDeal([1, 0, 1]);
        reactJustSayNo(jsnCards[0].card, 1);
        reactJustSayNo(jsnCards[1].card, 0, 1);
        reactJustSayNo(jsnCards[2].card, 1);
        resolvePendingAction(0);
        expect((gameState.players[1].properties.BROWN || []).length).toBe(1);
        expect((gameState.players[0].properties.BROWN || []).length).toBe(0);
    });

    it('4-level: action goes through (chain=4, even)', () => {
        const { jsnCards } = setupSlyDeal([1, 0, 1, 0]);
        reactJustSayNo(jsnCards[0].card, 1);
        reactJustSayNo(jsnCards[1].card, 0, 1);
        reactJustSayNo(jsnCards[2].card, 1);
        reactJustSayNo(jsnCards[3].card, 0, 1);
        resolvePendingAction(1);
        expect((gameState.players[0].properties.BROWN || []).length).toBe(1);
    });
});

// ============================================================================
// GAME OVER
// ============================================================================
describe('checkWinner', () => {
    it('returns winner id when player owns 3 complete sets', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        placeProperty(0, 'PINK', 3);
        placeProperty(0, 'RED', 3);
        expect(checkWinner()).toBe(0);
    });

    it('returns null with only 2 complete sets', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        placeProperty(0, 'PINK', 3);
        expect(checkWinner()).toBeNull();
    });
});

// ============================================================================
// STOCHASTIC STRESS RUNNER - coverage gate
// ============================================================================
describe('stochastic stress runner (coverage gate)', () => {
    // Mulberry32 deterministic PRNG
    function mulberry32(seed) {
        return function() {
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function seededShuffle(arr, seed) {
        const r = mulberry32(seed);
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(r() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }
    function freshDeck(seed) {
        // Re-implement generateDeck inline for determinism (no random shuffle)
        const deck = [];
        let id = 1;
        const add = (tpl, n) => { for (let i=0;i<n;i++) deck.push({ data: { ...tpl, id: `c_${id++}` }, zone: 'deck', owner: null }); };
        add({ type: CARD_TYPES.MONEY, name: '1g', value: 1 }, 6);
        add({ type: CARD_TYPES.MONEY, name: '2g', value: 2 }, 5);
        add({ type: CARD_TYPES.MONEY, name: '3g', value: 3 }, 3);
        add({ type: CARD_TYPES.MONEY, name: '4g', value: 4 }, 3);
        add({ type: CARD_TYPES.MONEY, name: '5g', value: 5 }, 2);
        add({ type: CARD_TYPES.MONEY, name: '10g', value: 10 }, 1);
        Object.keys(PROPERTIES).forEach(k => {
            const p = PROPERTIES[k];
            add({ type: CARD_TYPES.PROPERTY, name: p.name, colorKey: k, value: p.value }, p.count);
        });
        const wilds = [
            ['DARKBLUE','GREEN',4], ['LIGHTBLUE','BROWN',1],
            ['PINK','ORANGE',2], ['PINK','ORANGE',2],
            ['RED','YELLOW',3], ['RED','YELLOW',3],
            ['GREEN','RAILROAD',4], ['LIGHTBLUE','RAILROAD',4],
            ['UTILITY','RAILROAD',2]
        ];
        wilds.forEach(w => add({ type: CARD_TYPES.JOKER, name: 'WILD', allowedColors: [w[0],w[1]], value: w[2] }, 1));
        add({ type: CARD_TYPES.JOKER, name: 'RAINBOW', allowedColors: Object.keys(PROPERTIES), value: 0, isRainbow: true }, 2);
        const rents = [['DARKBLUE','GREEN'],['BROWN','LIGHTBLUE'],['PINK','ORANGE'],['RED','YELLOW'],['RAILROAD','UTILITY']];
        rents.forEach(r => add({ type: CARD_TYPES.RENT, name: 'RENT', allowedColors: r, value: 1 }, 2));
        add({ type: CARD_TYPES.RENT, name: 'MULTI', allowedColors: Object.keys(PROPERTIES), value: 3, isMulti: true }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'PASS', effect: 'pass_go', value: 1 }, 10);
        add({ type: CARD_TYPES.ACTION, name: 'DB', effect: 'deal_breaker', value: 5 }, 2);
        add({ type: CARD_TYPES.ACTION, name: 'SLY', effect: 'sly_deal', value: 3 }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'FD', effect: 'forced_deal', value: 3 }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'JSN', effect: 'just_say_no', value: 4 }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'TC', effect: 'debt_collector', value: 3 }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'BD', effect: 'birthday', value: 2 }, 3);
        add({ type: CARD_TYPES.ACTION, name: 'DR', effect: 'double_rent', value: 1 }, 2);
        add({ type: CARD_TYPES.BUILDING, name: 'HOUSE', effect: 'house', value: 3 }, 3);
        add({ type: CARD_TYPES.BUILDING, name: 'HOTEL', effect: 'hotel', value: 4 }, 2);
        return seededShuffle(deck, seed);
    }

    function botPick(rnd, playerId) {
        const actions = enumerateLegalActions(playerId);
        if (actions.length === 0) return null;
        const proposes = actions.filter(a => a.type === 'propose');
        const plays = actions.filter(a => a.type === 'play' && a.zone !== 'bank');
        const banks = actions.filter(a => a.type === 'play' && a.zone === 'bank');
        const endT = actions.find(a => a.type === 'end-turn');
        // Bias toward propose for coverage when both available
        if (proposes.length > 0 && plays.length > 0) {
            return rnd() < 0.4 ? proposes[Math.floor(rnd()*proposes.length)]
                               : plays[Math.floor(rnd()*plays.length)];
        }
        if (proposes.length > 0 && rnd() < 0.7) return proposes[Math.floor(rnd()*proposes.length)];
        if (plays.length > 0) return plays[Math.floor(rnd()*plays.length)];
        if (banks.length > 0 && rnd() < 0.6) return banks[Math.floor(rnd()*banks.length)];
        return endT || (banks[0] || null);
    }

    function applyAction(act, playerId) {
        const player = gameState.players[playerId];
        if (act.type === 'end-turn') {
            endTurn();
            return;
        }
        if (act.type === 'concede') {
            resolvePendingAction(playerId);
            return;
        }
        const card = (player.hand || []).find(c => c.data.id === act.cardId);
        if (act.type === 'react-no') {
            if (!card) return;
            reactJustSayNo(card, playerId, act.againstReactorId ?? null);
            return;
        }
        if (act.type === 'discard') {
            if (!card) return;
            player.hand = player.hand.filter(c => c !== card);
            card.zone = 'discard'; card.owner = null;
            gameState.discard.push(card);
            gameState.mustDiscard = Math.max(0, gameState.mustDiscard - 1);
            return;
        }
        if (!card) return;
        if (act.type === 'play') {
            playCardToZone(card, act.zone, playerId, act.options || {});
            if (act.zone !== 'discard' || !card.data.effect) {
                gameState.actionsLeft--;
            } else if (card.data.effect === 'pass_go' || card.data.effect === 'double_rent') {
                // pass_go is play->discard with its own draws, double_rent is play->discard
                gameState.actionsLeft--;
                if (card.data.effect === 'double_rent') gameState.doubleRentArmed = true;
            } else {
                gameState.actionsLeft--;
            }
            return;
        }
        if (act.type === 'propose') {
            proposeAction(card, playerId, act.targetPlayerId, act.options || {});
        }
    }

    function resolvePending(rnd) {
        // Resolve any pending action chains until cleared.
        let guard = 0;
        while (gameState.pendingAction && guard++ < 50) {
            const reactor = gameState.reactionTargetId;
            if (reactor === null) {
                resolvePendingAction();
                break;
            }
            const reactorActions = enumerateLegalActions(reactor);
            const jsnAvail = reactorActions.filter(a => a.type === 'react-no');
            if (jsnAvail.length > 0 && rnd() < 0.3) {
                applyAction(jsnAvail[Math.floor(rnd()*jsnAvail.length)], reactor);
            } else {
                applyAction({ type: 'concede' }, reactor);
            }
        }
    }

    it('runs 50 seeded games without throwing and covers all card effects', () => {
        const effectsExercised = new Set();
        let totalTurns = 0;
        let errors = 0;
        let gamesCompleted = 0;
        for (let seed = 1; seed <= 50; seed++) {
            try {
                const deck = freshDeck(seed);
                initGameState(deck, 4);
                // Deal 5 each
                for (let p = 0; p < 4; p++) for (let i=0;i<5;i++) drawCardFromDeck(p);
                startTurn(0);
                const rnd = mulberry32(seed * 1000 + 17);
                let maxTurns = 200;
                let stuckGuard = 0;
                while (maxTurns-- > 0) {
                    if (checkWinner() !== null) break;
                    if (gameState.pendingAction) {
                        resolvePending(rnd);
                        continue;
                    }
                    const cur = gameState.turn;
                    if (gameState.mustDiscard > 0) {
                        const acts = enumerateLegalActions(cur).filter(a => a.type === 'discard');
                        if (acts.length === 0) break;
                        applyAction(acts[Math.floor(rnd()*acts.length)], cur);
                        continue;
                    }
                    const act = botPick(rnd, cur);
                    if (!act) break;
                    if (act.type === 'propose') {
                        // Track effect
                        const card = gameState.players[cur].hand.find(c => c.data.id === act.cardId);
                        if (card) {
                            const eff = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
                            if (eff) effectsExercised.add(eff);
                        }
                    } else if (act.type === 'play' && act.zone === 'discard') {
                        const card = gameState.players[cur].hand.find(c => c.data.id === act.cardId);
                        if (card?.data.effect) effectsExercised.add(card.data.effect);
                    } else if (act.type === 'play' && act.zone === 'board') {
                        const card = gameState.players[cur].hand.find(c => c.data.id === act.cardId);
                        if (card?.data.type === CARD_TYPES.BUILDING) effectsExercised.add(card.data.effect);
                    }
                    const handBefore = gameState.players[cur].hand.length;
                    applyAction(act, cur);
                    if (act.type === 'propose') resolvePending(rnd);
                    // Detect stuck
                    if (gameState.players[cur].hand.length === handBefore && act.type === 'end-turn') {
                        // moved on
                    }
                    if (++stuckGuard > 500) break;
                }
                gamesCompleted++;
                totalTurns += (200 - maxTurns);
            } catch (e) {
                errors++;
                console.error(`Seed ${seed} threw:`, e.message);
            }
        }
        expect(errors).toBe(0);
        expect(gamesCompleted).toBe(50);

        const required = [
            'pass_go','debt_collector','birthday','sly_deal','forced_deal',
            'deal_breaker','double_rent','collect_rent','house','hotel'
        ];
        const missing = required.filter(e => !effectsExercised.has(e));
        if (missing.length > 0) {
            throw new Error(`Coverage gate: these effects never exercised across 50 seeded games: ${missing.join(', ')}. Exercised: ${[...effectsExercised].join(', ')}`);
        }
    });
});

// ============================================================================
// AUDIT REGRESSIONS (post Claude Opus + Gemini audits 2026-05-14)
// ============================================================================
describe('audit regressions', () => {
    it('properties cannot be banked via enumeration', () => {
        initGameState([], 2);
        const prop = mkProperty('BROWN');
        gameState.players[0].hand.push(prop);
        gameState.actionsLeft = 3;
        const acts = enumerateLegalActions(0);
        const bankActions = acts.filter(a => a.cardId === prop.data.id && a.zone === 'bank');
        expect(bankActions).toEqual([]);
    });

    it('property wildcards cannot be banked via enumeration', () => {
        initGameState([], 2);
        const w = mkWild(['BROWN', 'LIGHTBLUE'], 1);
        gameState.players[0].hand.push(w);
        gameState.actionsLeft = 3;
        const acts = enumerateLegalActions(0);
        const bankActions = acts.filter(a => a.cardId === w.data.id && a.zone === 'bank');
        expect(bankActions).toEqual([]);
    });

    it('playCardToZone bank rejects a property and returns it to hand', () => {
        initGameState([], 2);
        const prop = mkProperty('BROWN');
        gameState.players[0].hand.push(prop);
        playCardToZone(prop, 'bank', 0);
        expect(gameState.players[0].bank).toEqual([]);
        expect(gameState.players[0].hand).toContain(prop);
    });

    it('chargePlayer auto-pays from properties when bank is empty', () => {
        initGameState([], 2);
        // payer has only a 4g property; demand 5g
        const prop = mkProperty('DARKBLUE');
        prop.data.value = 4;
        prop.zone = 'board';
        prop.owner = 1;
        gameState.players[1].properties.DARKBLUE = [prop];
        const r = chargePlayer(1, 0, 5);
        expect(r.paid).toBe(4);
        expect(gameState.players[1].properties.DARKBLUE.length).toBe(0);
        // Property moves to payee's property collection, not bank
        expect(gameState.players[0].properties.DARKBLUE.length).toBe(1);
        expect(gameState.players[0].bank.length).toBe(0);
    });

    it('chargePlayer prefers exact-bank-sum over taking a property', () => {
        initGameState([], 2);
        placeMoney(1, 2); placeMoney(1, 3);
        const prop = mkProperty('BROWN');
        prop.data.value = 1; prop.zone = 'board'; prop.owner = 1;
        gameState.players[1].properties.BROWN = [prop];
        chargePlayer(1, 0, 5);
        // Best subset: 2g + 3g = exact 5g. Property preserved.
        expect(gameState.players[1].properties.BROWN.length).toBe(1);
        expect(bankTotal(1)).toBe(0);
        expect(bankTotal(0)).toBe(5);
    });

    it('doubleRentArmed clears after a fully JSN-cancelled rent', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        gameState.doubleRentArmed = true;
        const r = mkRent(['BROWN', 'LIGHTBLUE'], { isMulti: true }, 'r1');
        const jsn = mkAction('just_say_no', 4, 'jsn1');
        gameState.players[0].hand.push(r);
        gameState.players[1].hand.push(jsn);
        gameState.actionsLeft = 3;
        proposeAction(r, 0, 1, { color: 'BROWN' });
        reactJustSayNo(jsn, 1);
        resolvePendingAction(0);
        expect(gameState.doubleRentArmed).toBe(false);
    });

    it('Deal Breaker discards stolen building if attacker already has same kind on that color', () => {
        initGameState([], 2);
        // Attacker (0) has complete LIGHTBLUE set with a House
        placeProperty(0, 'LIGHTBLUE', 3);
        placeBuilding(0, 'LIGHTBLUE', 'house');
        // Target (1) has complete LIGHTBLUE set with a House too
        placeProperty(1, 'LIGHTBLUE', 3);
        placeBuilding(1, 'LIGHTBLUE', 'house');
        const before = gameState.discard.length;
        const db = mkAction('deal_breaker', 5, 'db1');
        executeAction(db, 0, 1, { color: 'LIGHTBLUE' });
        // Attacker still has only ONE house on lightblue
        expect((gameState.players[0].buildings.LIGHTBLUE || []).length).toBe(1);
        // The stolen duplicate house went to discard
        expect(gameState.discard.length).toBeGreaterThanOrEqual(before + 1);
    });

    it('Hotel without a House on the set is not enumerated', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2); // complete brown set, no house
        const hotel = mkBuilding('hotel');
        gameState.players[0].hand.push(hotel);
        gameState.actionsLeft = 3;
        const acts = enumerateLegalActions(0);
        const hotelPlays = acts.filter(a => a.cardId === hotel.data.id && a.zone === 'board');
        expect(hotelPlays).toEqual([]);
    });

    it('Hotel is enumerated once a House is on the set', () => {
        initGameState([], 2);
        placeProperty(0, 'BROWN', 2);
        placeBuilding(0, 'BROWN', 'house');
        const hotel = mkBuilding('hotel');
        gameState.players[0].hand.push(hotel);
        gameState.actionsLeft = 3;
        const acts = enumerateLegalActions(0);
        const hotelPlays = acts.filter(a => a.cardId === hotel.data.id && a.zone === 'board');
        expect(hotelPlays.length).toBeGreaterThanOrEqual(1);
    });

    it('checkWinner only declares the player whose turn it is', () => {
        initGameState([], 3);
        // Player 1 has 3 sets, but it is Player 0's turn.
        placeProperty(1, 'BROWN', 2);
        placeProperty(1, 'LIGHTBLUE', 3);
        placeProperty(1, 'PINK', 3);
        gameState.turn = 0;
        expect(checkWinner()).toBe(null);
        gameState.turn = 1;
        expect(checkWinner()).toBe(1);
    });
});

// ============================================================================
// READING B: Houses/Hotels are payable currency
// ============================================================================
describe('houses/hotels as payable currency (Reading B)', () => {
    it('chargePlayer can use a House as payment, transfers it to payee bank', () => {
        initGameState([], 2);
        // Payer has no bank/properties, only a 3g House on (now-irrelevant) Brown
        const house = mkBuilding('house');
        house.zone = 'board';
        house.owner = 1;
        gameState.players[1].buildings.BROWN = [house];
        const r = chargePlayer(1, 0, 3);
        expect(r.paid).toBe(3);
        expect((gameState.players[1].buildings.BROWN || []).length).toBe(0);
        // House lands in payee's bank as money (loses building function).
        expect(gameState.players[0].bank.length).toBe(1);
        expect(gameState.players[0].bank[0].data.effect).toBe('house');
    });

    it('chargePlayer prefers exact bank subset over surrendering a Hotel', () => {
        initGameState([], 2);
        placeMoney(1, 2); placeMoney(1, 2);
        const hotel = mkBuilding('hotel');
        hotel.zone = 'board';
        hotel.owner = 1;
        gameState.players[1].buildings.PINK = [hotel];
        chargePlayer(1, 0, 4);
        // Bank had 2+2=4 exact — Hotel kept.
        expect((gameState.players[1].buildings.PINK || []).length).toBe(1);
        expect(bankTotal(1)).toBe(0);
        expect(bankTotal(0)).toBe(4);
    });

    it('Hotel surrendered as payment loses its building function (lands in bank, no rent bonus)', () => {
        initGameState([], 2);
        // Payer: completed Pink set (1+1+2=4g) and Hotel (4g). Total 8g.
        placeProperty(1, 'PINK', 3);
        const hotel = mkBuilding('hotel');
        hotel.zone = 'board'; hotel.owner = 1;
        gameState.players[1].buildings.PINK = [hotel];
        chargePlayer(1, 0, 4);
        // Optimal: surrender the Hotel exactly. Pink set stays intact.
        expect((gameState.players[1].buildings.PINK || []).length).toBe(0);
        expect((gameState.players[1].properties.PINK || []).length).toBe(3);
        expect(gameState.players[0].bank.some(c => c.data.effect === 'hotel')).toBe(true);
    });
});
