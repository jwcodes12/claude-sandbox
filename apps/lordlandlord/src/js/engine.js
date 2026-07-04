
const ENGINE_DEBUG = typeof globalThis !== 'undefined' && globalThis.__LL_ENGINE_DEBUG === true;
const engineLog = (...args) => {
    if (ENGINE_DEBUG) console.log(...args);
};

import { CARD_TYPES, PROPERTIES } from './cards.js';
import { createRng } from './core/rng.js';
import { shuffleInPlace } from './core/deck.js';

// ---------------------------------------------------------------------------
// State-parametric engine (Step 2).
//
// The canonical rulebook lives in the `*S(state, ...)` functions below: each
// takes the game state as its first argument and mutates only that object, so
// the same function can drive any state copy — the solo controller, the net
// writer/client mirrors, or a cloned state inside the pure reducer (Step 4).
// The pre-Step-8 gameState singleton and its legacy wrapper functions are
// gone; every caller passes state explicitly. Legality enumeration lives in
// core/legal.js.
// ---------------------------------------------------------------------------

// Reaction model: pendingAction.chains maps each charged opponent id to
// { chainCount, settled, canceled, nextActorId }. Fan-out actions open one
// chain per charged opponent and they resolve in parallel. pendingReactors is
// the list of unsettled reactor ids. reactionTargetId is a derived convenience
// for single-target paths and UIs that pick one chain at a time: it points to
// whichever player must act next on the FIRST unsettled chain (the reactor on
// even chainCount, the attacker on odd).

export function initGameStateS(state, cards, playerCount = 2, seed = null, rngState = null) {
    // Step 8: the seed is required. Every deal and mid-game reshuffle draws
    // from this stream; an implicit fallback here would silently produce
    // states that replay/convergence checks cannot reproduce.
    if (seed == null || !Number.isFinite(seed)) {
        throw new Error('initGameStateS: an explicit numeric seed is required');
    }
    state.seed = seed >>> 0;
    // rngState is where the live rng cursor picks up — after the initial deal
    // shuffle the caller passes the advanced state so reshuffles continue the
    // same stream; otherwise we start the stream at the seed.
    state.rngState = (rngState == null ? state.seed : rngState) >>> 0;
    state.deck = cards;
    state.discard = [];
    state.players = [];
    for (let i = 0; i < playerCount; i++) {
        state.players.push({
            id: i,
            hand: [],
            bank: [],
            properties: {},
            buildings: {}
        });
    }
    state.turn = 0;
    state.actionsLeft = 3;
    state.mustDiscard = 0;
    state.reactionTargetId = null;
    state.pendingReactors = [];
    state.pendingAction = null;
    state.doubleRentArmed = false;
}

export function startTurnS(state, playerId) {
    state.turn = playerId;
    state.actionsLeft = 3;
    state.doubleRentArmed = false;

    const handSize = state.players[playerId].hand.length;
    const drawCount = handSize === 0 ? 5 : 2;
    for (let i = 0; i < drawCount; i++) drawCardFromDeckS(state, playerId);
}

export function endTurnS(state) {
    const p = state.players[state.turn];
    if (p.hand.length > 7) {
        state.mustDiscard = p.hand.length - 7;
        return false; // Did not successfully end turn yet
    }

    state.mustDiscard = 0;
    state.doubleRentArmed = false;
    state.turn = (state.turn + 1) % state.players.length;
    startTurnS(state, state.turn);
    return true;
}

export function calculateRentS(state, playerId, color) {
    const p = state.players[playerId];
    const props = p.properties[color] || [];
    if (props.length === 0) return 0;

    // Per rulebook: the Multicolor (Rainbow) Property Wild "can be laid down
    // at any time, but you can only charge rent against it if it is played
    // with another property card." So a set containing only rainbow wilds
    // charges no rent; otherwise the rainbow counts toward the rent tier.
    const realCount = props.filter(c => !c.data.isRainbow).length;
    if (realCount === 0) return 0;

    const baseRent = PROPERTIES[color].rent[Math.min(props.length - 1, PROPERTIES[color].rent.length - 1)];
    let bonus = 0;

    // Building rent only applies when the set is currently complete.
    // If the set has been broken (someone stole a property), the house/hotel
    // is dormant until the set is whole again.
    const setSize = PROPERTIES[color].count;
    const isComplete = props.length >= setSize;
    if (isComplete && p.buildings[color]) {
        const hasHouse = p.buildings[color].some(b => b.data.effect === 'house');
        p.buildings[color].forEach(b => {
            if (b.data.effect === 'house') bonus += 3;
            if (b.data.effect === 'hotel' && hasHouse) bonus += 4;
        });
    }

    return baseRent + bonus;
}

export function drawCardFromDeckS(state, playerId) {
    if (state.deck.length === 0) {
        if (state.discard.length === 0) return null;
        engineLog(`[ENGINE] Deck empty, shuffling discard into deck. Discard size: ${state.discard.length}`);
        // Seeded reshuffle: draw from the game's rng stream and advance the
        // stored cursor so replay reproduces the exact same reshuffle.
        const rng = createRng(state.rngState);
        state.deck = shuffleInPlace(state.discard.slice(), rng);
        state.rngState = rng.state;
        state.deck.forEach(c => { c.zone = 'deck'; c.owner = null; });
        state.discard = [];
    }

    const card = state.deck.pop();
    card.zone = 'hand';
    card.owner = playerId;
    state.players[playerId].hand.push(card);
    return card;
}

export function getCompletedSetsS(state, playerId) {
    let sets = 0;
    const props = state.players[playerId].properties;
    Object.keys(props).forEach(color => {
        const count = PROPERTIES[color].count;
        if (props[color].length >= count) sets++;
    });
    return sets;
}

export function checkWinnerS(state) {
    // Per rulebook: "If you realize you've won during someone else's turn,
    // you must wait until it's your turn to say it!" — only declare on the
    // current player's turn.
    const p = state.players[state.turn];
    if (p && getCompletedSetsS(state, p.id) >= 3) return p.id;
    return null;
}

export function playCardToZoneS(state, card, targetZoneStr, playerId, options = {}) {
    engineLog(`[ENGINE] playCardToZone: ${card.data.name} (${card.data.id}) to ${targetZoneStr} for P${playerId}`);
    const player = state.players[playerId];
    player.hand = player.hand.filter(c => c !== card);

    if (targetZoneStr === 'bank') {
        // Property and Property Wildcards cannot be banked per rulebook.
        if (card.data.type === CARD_TYPES.PROPERTY || card.data.type === CARD_TYPES.JOKER) {
            player.hand.push(card);
            return;
        }
        card.zone = 'bank';
        player.bank.push(card);
    }
    else if (targetZoneStr === 'board') {
        if (card.data.type === CARD_TYPES.BUILDING) {
            const color = options.color;
            // Per rulebook: houses/hotels can only be added onto a COMPLETE
            // set, and Railroads/Utilities are explicitly excluded.
            if (color === 'UTILITY' || color === 'RAILROAD' || !PROPERTIES[color]) {
                player.hand.push(card);
                return;
            }
            const setSize = PROPERTIES[color].count;
            const propCount = (player.properties[color] || []).length;
            if (propCount < setSize) {
                player.hand.push(card);
                return;
            }
            if (!player.buildings[color]) player.buildings[color] = [];
            if (player.buildings[color].some(b => b.data.effect === card.data.effect)) {
                player.hand.push(card);
                return;
            }
            if (card.data.effect === 'hotel') {
                const hasHouse = player.buildings[color].some(b => b.data.effect === 'house');
                if (!hasHouse) {
                    player.hand.push(card);
                    return;
                }
            }
            card.zone = 'board';
            player.buildings[color].push(card);
        } else {
            card.zone = 'board';
            const color = options.color || card.data.colorKey || "BROWN";
            card.currentColor = color; // For wilds
            if (!player.properties[color]) player.properties[color] = [];
            player.properties[color].push(card);
        }
    }
    else if (targetZoneStr === 'discard') {
        card.zone = 'discard';
        card.owner = null;
        state.discard.push(card);
    }
}

// Per rulebook: property wildcards "can be swapped around amongst different
// sets on your turn" — free, does not consume an action. Validates that the
// card is a wild owned by this player, currently on the board, and that the
// target color is allowed.
export function swapWildColorS(state, playerId, cardId, newColor) {
    if (state.turn !== playerId) return false;
    if (state.reactionTargetId !== null) return false;
    const player = state.players[playerId];
    if (!player) return false;
    let entry = null;
    for (const colorKey of Object.keys(player.properties || {})) {
        const c = (player.properties[colorKey] || []).find(c => c.data.id === cardId);
        if (c) { entry = { card: c, fromColor: colorKey }; break; }
    }
    if (!entry) return false;
    const card = entry.card;
    if (card.data.type !== CARD_TYPES.JOKER) return false;
    if (entry.fromColor === newColor) return false;
    const allowed = card.data.allowedColors || [];
    if (!card.data.isRainbow && !allowed.includes(newColor)) return false;
    if (card.data.isRainbow && !PROPERTIES[newColor]) return false;
    player.properties[entry.fromColor] = player.properties[entry.fromColor].filter(c => c !== card);
    if (!player.properties[newColor]) player.properties[newColor] = [];
    player.properties[newColor].push(card);
    card.currentColor = newColor;
    return true;
}

export function proposeActionS(state, card, playerId, targetPlayerId, options = {}) {
    const p = state.players[playerId];
    p.hand = p.hand.filter(c => c !== card);

    const effect = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
    const isFanOut = effect === 'birthday' ||
        (effect === 'collect_rent' && !card.data.isMulti);

    let reactorIds;
    if (isFanOut) {
        reactorIds = state.players
            .filter(pl => pl.id !== playerId)
            .map(pl => pl.id);
    } else if (targetPlayerId !== null && targetPlayerId !== undefined) {
        reactorIds = [targetPlayerId];
    } else {
        reactorIds = [];
    }

    const chains = {};
    reactorIds.forEach(rid => {
        chains[rid] = { chainCount: 0, settled: false, canceled: false };
    });

    state.pendingAction = {
        card, playerId, targetPlayerId, options,
        attackerId: playerId,
        chains,
        isFanOut
    };
    refreshReactionTargetsS(state);
}

function refreshReactionTargetsS(state) {
    const pa = state.pendingAction;
    if (!pa) {
        state.pendingReactors = [];
        state.reactionTargetId = null;
        return;
    }
    const unsettled = Object.keys(pa.chains)
        .map(k => Number(k))
        .filter(rid => !pa.chains[rid].settled)
        .sort((a, b) => a - b);
    state.pendingReactors = unsettled;
    if (unsettled.length === 0) {
        state.reactionTargetId = null;
        return;
    }
    const firstRid = unsettled[0];
    const chain = pa.chains[firstRid];
    state.reactionTargetId = (chain.chainCount % 2 === 0) ? firstRid : pa.attackerId;
}

export function playerHasPendingReactionS(state, playerId) {
    const pa = state.pendingAction;
    if (!pa) return false;
    if (playerId === pa.attackerId) {
        return Object.keys(pa.chains).some(rid => {
            const c = pa.chains[rid];
            return !c.settled && c.chainCount % 2 === 1;
        });
    }
    const c = pa.chains[playerId];
    return !!c && !c.settled && c.chainCount % 2 === 0;
}

export function reactJustSayNoS(state, noCard, reactingPlayerId, againstReactorId = null) {
    const pa = state.pendingAction;
    if (!pa) return false;

    let chainKey;
    if (reactingPlayerId === pa.attackerId) {
        if (againstReactorId !== null && pa.chains[againstReactorId] && !pa.chains[againstReactorId].settled
            && pa.chains[againstReactorId].chainCount % 2 === 1) {
            chainKey = againstReactorId;
        } else {
            chainKey = Object.keys(pa.chains)
                .map(k => Number(k))
                .find(rid => !pa.chains[rid].settled && pa.chains[rid].chainCount % 2 === 1);
            if (chainKey === undefined) return false;
        }
    } else {
        const c = pa.chains[reactingPlayerId];
        if (!c || c.settled || c.chainCount % 2 !== 0) return false;
        chainKey = reactingPlayerId;
    }

    noCard.zone = 'discard'; noCard.owner = null;
    state.players[reactingPlayerId].hand =
        state.players[reactingPlayerId].hand.filter(c => c !== noCard);
    state.discard.push(noCard);

    pa.chains[chainKey].chainCount++;
    refreshReactionTargetsS(state);
    return true;
}

export function resolvePendingActionS(state, concedingPlayerId = null) {
    const pa = state.pendingAction;
    if (!pa) return;

    let actorId = concedingPlayerId;
    if (actorId === null) {
        actorId = state.reactionTargetId;
    }

    if (state.pendingReactors.length > 0 && actorId !== null) {
        let chainKey = null;
        if (actorId === pa.attackerId) {
            chainKey = state.pendingReactors.find(rid => pa.chains[rid].chainCount % 2 === 1);
        } else if (pa.chains[actorId] && !pa.chains[actorId].settled) {
            chainKey = actorId;
        }
        if (chainKey !== null && chainKey !== undefined) {
            const chain = pa.chains[chainKey];
            chain.settled = true;
            chain.canceled = chain.chainCount % 2 === 1;
            engineLog(`[ENGINE] Player ${chainKey} chain settled. canceled=${chain.canceled}`);
            refreshReactionTargetsS(state);
            if (state.pendingReactors.length > 0) {
                engineLog(`[ENGINE] Action still pending. Waiting for [${state.pendingReactors.join(',')}]`);
                return;
            }
        }
    }

    engineLog(`[ENGINE] All reactors settled. resolving pending action.`);
    const jsnCanceled = [];
    Object.keys(pa.chains).forEach(rid => {
        if (pa.chains[rid].canceled) jsnCanceled.push(Number(rid));
    });

    state.pendingAction = null;
    state.reactionTargetId = null;
    state.pendingReactors = [];

    const effect = pa.card.data.effect || (pa.card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
    const isSingleTarget = !pa.isFanOut && effect !== 'pass_go' && effect !== 'double_rent';

    engineLog(`[ENGINE] Executing final action: ${effect}. canceled by: [${jsnCanceled.join(',')}]`);

    // Any rent attempt (canceled or not) consumes the Double the Rent buff —
    // otherwise a fully-JSN'd rent leaves the flag armed for the next rent.
    if (effect === 'collect_rent') state.doubleRentArmed = false;

    if (isSingleTarget && jsnCanceled.includes(pa.targetPlayerId)) {
        pa.card.zone = 'discard'; pa.card.owner = null;
        state.discard.push(pa.card);
        state.actionsLeft--;
        return;
    }

    if (pa.isFanOut && jsnCanceled.length === state.players.length - 1) {
        pa.card.zone = 'discard'; pa.card.owner = null;
        state.discard.push(pa.card);
        state.actionsLeft--;
        return;
    }

    executeActionS(state, pa.card, pa.playerId, pa.targetPlayerId, { ...pa.options, jsnCanceled });
}

export function executeActionS(state, card, playerId, targetPlayerId, options = {}) {
    engineLog(`[ENGINE] executeAction: ${card.data.name} (${card.data.id}) by P${playerId} target P${targetPlayerId}`);
    const player = state.players[playerId];
    const target = state.players[targetPlayerId];

    // Remove from hand
    player.hand = player.hand.filter(c => c !== card);

    if (card.zone !== 'discard') {
        card.zone = 'discard';
        card.owner = null;
        state.discard.push(card);
    }

    const effect = card.data.effect || (card.data.type === CARD_TYPES.RENT ? 'collect_rent' : null);
    engineLog(`[ENGINE] action effect: ${effect}`);

    if (effect === 'pass_go') {
        drawCardFromDeckS(state, playerId);
        drawCardFromDeckS(state, playerId);
        state.lastResolution = { effect, playerId };
    }
    else if (effect === 'birthday' || effect === 'debt_collector') {
        const amount = effect === 'birthday' ? 2 : 5;
        const canceled = options.jsnCanceled || [];
        let totalPaid = 0;
        let payers = 0;
        let dryPayers = 0;
        const collect = (pid) => {
            payers++;
            let r;
            if (options.alreadyPaidIds && options.alreadyPaidIds.includes(pid)) {
                r = { paid: amount, empty: false };
            } else {
                r = chargePlayerS(state, pid, playerId, amount) || { paid: 0, empty: false };
            }
            totalPaid += r.paid;
            if (r.empty) dryPayers++;
        };
        if (effect === 'birthday') {
            state.players.forEach(p => {
                if (p.id !== playerId && !canceled.includes(p.id)) collect(p.id);
            });
        } else if (!canceled.includes(targetPlayerId)) {
            collect(targetPlayerId);
        }
        state.lastResolution = {
            effect, playerId, amount, totalPaid, payers, dryPayers,
            targetPlayerId: effect === 'birthday' ? null : targetPlayerId
        };
    }
    else if (effect === 'sly_deal') {
        const targetCard = options.targetCard || findCardById(target, options.targetCardId);
        if (!targetCard) { state.actionsLeft--; return; }
        const color = targetCard.currentColor || targetCard.data.colorKey;
        target.properties[color] = target.properties[color].filter(c => c !== targetCard);
        if (!player.properties[color]) player.properties[color] = [];
        targetCard.owner = playerId;
        player.properties[color].push(targetCard);
        state.lastResolution = { effect, playerId, targetPlayerId, stolenCardName: targetCard.data.name };
    }
    else if (effect === 'forced_deal') {
        const targetCard = options.targetCard || findCardById(target, options.targetCardId);
        const myCard = options.myCard || findCardById(player, options.myCardId);
        if (!targetCard || !myCard) { state.actionsLeft--; return; }
        const targetColor = targetCard.currentColor || targetCard.data.colorKey;
        const myColor = myCard.currentColor || myCard.data.colorKey;

        target.properties[targetColor] = target.properties[targetColor].filter(c => c !== targetCard);
        player.properties[myColor] = player.properties[myColor].filter(c => c !== myCard);

        if (!player.properties[targetColor]) player.properties[targetColor] = [];
        targetCard.owner = playerId;
        player.properties[targetColor].push(targetCard);

        if (!target.properties[myColor]) target.properties[myColor] = [];
        myCard.owner = targetPlayerId;
        target.properties[myColor].push(myCard);
        state.lastResolution = { effect, playerId, targetPlayerId, gaveCardName: myCard.data.name, gotCardName: targetCard.data.name };
    }
    else if (effect === 'deal_breaker') {
        const color = options.color;
        const setCards = target.properties[color] || [];
        target.properties[color] = [];
        if (!player.properties[color]) player.properties[color] = [];
        setCards.forEach(c => {
            c.owner = playerId;
            player.properties[color].push(c);
        });
        const buildings = target.buildings[color] || [];
        if (buildings.length > 0) {
            if (!player.buildings[color]) player.buildings[color] = [];
            buildings.forEach(b => {
                // Rule: max one House and one Hotel per set. If attacker already
                // has the same effect, the stolen one is discarded.
                if (player.buildings[color].some(x => x.data.effect === b.data.effect)) {
                    b.zone = 'discard';
                    b.owner = null;
                    state.discard.push(b);
                    return;
                }
                b.owner = playerId;
                player.buildings[color].push(b);
            });
            target.buildings[color] = [];
        }
        state.lastResolution = { effect, playerId, targetPlayerId, color };
    }
    else if (effect === 'double_rent') {
        state.doubleRentArmed = true;
    }
    else if (effect === 'collect_rent') {
        const color = options.color;
        let amount = calculateRentS(state, playerId, color);
        if (state.doubleRentArmed) {
            amount *= 2;
            state.doubleRentArmed = false;
        }
        let totalPaid = 0;
        let payers = 0;
        let dryPayers = 0;
        const collect = (pid) => {
            payers++;
            let r;
            if (options.alreadyPaidIds && options.alreadyPaidIds.includes(pid)) {
                r = { paid: amount, empty: false };
            } else {
                r = chargePlayerS(state, pid, playerId, amount) || { paid: 0, empty: false };
            }
            totalPaid += r.paid;
            if (r.empty) dryPayers++;
        };
        if (card.data.isMulti) {
            collect(targetPlayerId);
        } else {
            const canceled = options.jsnCanceled || [];
            state.players.forEach(p => {
                if (p.id !== playerId && !canceled.includes(p.id)) collect(p.id);
            });
        }
        state.lastResolution = {
            effect, playerId, amount, totalPaid, payers, dryPayers, color,
            targetPlayerId: card.data.isMulti ? targetPlayerId : null
        };
    }

    state.actionsLeft--;
}

// Pure helper: locate a card by id within a player's property collection.
// Operates only on the passed player object, so it needs no game state.
function findCardById(playerObj, cardId) {
    if (!cardId) return null;
    for (const color of Object.keys(playerObj.properties || {})) {
        const found = playerObj.properties[color].find(c => c.data.id === cardId);
        if (found) return found;
    }
    return null;
}

export function chargePlayerS(state, payerId, payeeId, amount) {
    const payer = state.players[payerId];
    const payee = state.players[payeeId];
    if (!payer || !payee) return { paid: 0, empty: true };
    if (amount <= 0) return { paid: 0, empty: false };
    const hasAnything = payer.bank.length > 0 ||
        Object.values(payer.properties || {}).some(arr => (arr || []).length > 0) ||
        Object.values(payer.buildings || {}).some(arr => (arr || []).length > 0);
    if (!hasAnything) return { paid: 0, empty: true };

    // Per rulebook: "You can pay with cards from your bank, properties or a
    // combination of both." Houses/Hotels show a face value in the red ring
    // and can also be surrendered — they lose their building function and
    // land in the payee's bank as money.
    const propertyEntries = []; // {card, colorKey}
    for (const colorKey of Object.keys(payer.properties || {})) {
        for (const c of (payer.properties[colorKey] || [])) {
            propertyEntries.push({ card: c, colorKey });
        }
    }
    const buildingEntries = []; // {card, colorKey}
    for (const colorKey of Object.keys(payer.buildings || {})) {
        for (const b of (payer.buildings[colorKey] || [])) {
            buildingEntries.push({ card: b, colorKey });
        }
    }
    const bankCards = payer.bank.filter(c => !(c.data.isRainbow || c.data.value === 0));
    const propCards = propertyEntries.map(e => e.card).filter(c => !(c.data.isRainbow || c.data.value === 0));
    const bldCards = buildingEntries.map(e => e.card).filter(c => (c.data.value || 0) > 0);
    // Auto-pay preference (least strategic first): bank, then buildings
    // (losing a Hotel only forfeits its rent bonus), then properties (which
    // breaks the set and loses both rent base and win progress).
    const chosen = pickPaymentByPreference([bankCards, bldCards, propCards], amount);
    const paid = chosen.reduce((s, c) => s + (c.data.value || 0), 0);
    const bankSet = new Set(payer.bank);
    const propSet = new Set(propertyEntries.map(e => e.card));
    chosen.forEach(c => {
        if (bankSet.has(c)) {
            payer.bank = payer.bank.filter(x => x !== c);
            c.owner = payeeId;
            payee.bank.push(c);
            return;
        }
        if (propSet.has(c)) {
            const entry = propertyEntries.find(e => e.card === c);
            payer.properties[entry.colorKey] = (payer.properties[entry.colorKey] || []).filter(x => x !== c);
            c.owner = payeeId;
            const targetColor = c.currentColor || c.data.colorKey || entry.colorKey;
            if (!payee.properties[targetColor]) payee.properties[targetColor] = [];
            payee.properties[targetColor].push(c);
            return;
        }
        // Building surrendered as currency -> payee's bank.
        const bentry = buildingEntries.find(e => e.card === c);
        if (!bentry) return;
        payer.buildings[bentry.colorKey] = (payer.buildings[bentry.colorKey] || []).filter(x => x !== c);
        c.owner = payeeId;
        c.zone = 'bank';
        payee.bank.push(c);
    });
    return { paid, empty: false };
}

// Layered preference: pick from earlier tiers first. Only reach into the
// next tier when the running pool can't cover the amount. Tie-break within
// the pool picks the min-overage subset. Pure — no game state.
function pickPaymentByPreference(tiers, amount) {
    let pool = [];
    for (const tier of tiers) {
        pool = pool.concat(tier);
        const total = pool.reduce((s, c) => s + (c.data.value || 0), 0);
        if (total >= amount) return pickPaymentSubset(pool, amount);
    }
    return pool.slice();
}

// Pick the minimal-overage subset of cards summing to >= amount (no change
// given in MD). If total < amount, pays all. Brute-force over <=20 cards is
// fine; banks are small. Tie-break favours fewest cards. Pure — no game state.
function pickPaymentSubset(cards, amount) {
    if (cards.length === 0) return [];
    const total = cards.reduce((s, c) => s + (c.data.value || 0), 0);
    if (total <= amount) return cards.slice();
    const n = Math.min(cards.length, 20);
    let bestMask = (1 << n) - 1;
    let bestOverage = total - amount;
    let bestCount = n;
    for (let mask = 1; mask < (1 << n); mask++) {
        let sum = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
            if (mask & (1 << i)) { sum += cards[i].data.value || 0; count++; }
        }
        if (sum < amount) continue;
        const overage = sum - amount;
        if (overage < bestOverage || (overage === bestOverage && count < bestCount)) {
            bestOverage = overage;
            bestCount = count;
            bestMask = mask;
        }
    }
    const out = [];
    for (let i = 0; i < n; i++) {
        if (bestMask & (1 << i)) out.push(cards[i]);
    }
    return out;
}
