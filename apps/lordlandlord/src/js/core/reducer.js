// core/reducer.js — the single authoritative writer (Step 4).
//
// reduce(state, action) -> newState is a PURE function: it never mutates the
// input state. It clones, checks the action against enumerateLegalActions
// (turn ownership, the 3-action budget, discard/reaction phase — all enforced
// in one place), dispatches to the state-first rulebook, stamps the winner,
// and bumps a monotonic version. An illegal or out-of-phase action returns the
// input state unchanged (same object, same version) — this is what removes the
// skipped-turn / double-apply class of desync bugs.
//
// Rules that used to live in the UI are folded in here so the engine, not the
// render loop, owns them: actionsLeft on a normal play, end-of-turn discard to
// the bottom of the draw pile, concede/auto-surrender payment, and the winner
// (formerly the UI's _gameOver flag).

import {
    playCardToZoneS,
    swapWildColorS,
    executeActionS,
    proposeActionS,
    reactJustSayNoS,
    resolvePendingActionS,
    endTurnS,
    checkWinnerS
} from '../engine.js';
import { clone, findHandCard } from './state.js';
import { enumerateLegalActions } from './legal.js';

// Canonical signature of an action for legality matching. Compares only the
// fields enumerateLegalActions produces; ignores transport fields (playerId,
// id) that the writer/clients attach.
function signature(a) {
    const o = a.options || {};
    return JSON.stringify([
        a.type,
        a.cardId ?? null,
        a.zone ?? null,
        a.targetPlayerId ?? null,
        o.color ?? null,
        o.targetCardId ?? null,
        o.myCardId ?? null,
        a.againstReactorId ?? null,
        a.color ?? null
    ]);
}

function isLegal(action, legalActions) {
    const sig = signature(action);
    return legalActions.some(la => signature(la) === sig);
}

// Apply a validated action to a (cloned) state, mutating it in place.
function applyAction(state, action) {
    const pid = action.playerId;

    switch (action.type) {
        case 'play': {
            const card = findHandCard(state, pid, action.cardId);
            if (!card) return;
            if (action.zone === 'discard') {
                // Only non-charge actions (pass_go, double_rent) are enumerated
                // as play->discard; they fire immediately and executeActionS
                // decrements actionsLeft itself.
                executeActionS(state, card, pid, action.targetPlayerId ?? null, action.options || {});
            } else {
                playCardToZoneS(state, card, action.zone, pid, action.options || {});
                state.actionsLeft--;
            }
            return;
        }
        case 'propose': {
            // Rent / birthday / debt collector / sly deal / forced deal /
            // deal breaker. Opens a pending action; actionsLeft is spent later,
            // inside resolvePendingActionS once all reaction chains settle.
            const card = findHandCard(state, pid, action.cardId);
            if (!card) return;
            proposeActionS(state, card, pid, action.targetPlayerId ?? null, action.options || {});
            return;
        }
        case 'react-no': {
            const card = findHandCard(state, pid, action.cardId);
            if (!card) return;
            const against = action.againstReactorId ?? null;
            reactJustSayNoS(state, card, pid, against);
            return;
        }
        case 'concede': {
            // Stop reacting on this chain and let it resolve.
            //
            // If the action carries an explicit payment (paidCardIds — the cards
            // a human chose in the payment picker), hand exactly those to the
            // attacker and mark this player as already paid, so the choice is
            // captured in the action and replays identically on every device.
            // Otherwise resolvePendingActionS -> executeActionS -> chargePlayerS
            // auto-pays, and chargePlayer already surrenders every asset when the
            // debt exceeds what the player can cover (the shortfall case).
            if (Array.isArray(action.paidCardIds) && action.paidCardIds.length) {
                applyExplicitPayment(state, pid, action.paidCardIds);
            }
            resolvePendingActionS(state, pid);
            return;
        }
        case 'swap-wild': {
            swapWildColorS(state, pid, action.cardId, action.color);
            return;
        }
        case 'discard': {
            // End-of-turn discard goes to the BOTTOM of the draw pile per rules,
            // not the discard pile. When the required count is met the turn ends.
            const card = findHandCard(state, pid, action.cardId);
            if (!card) return;
            const p = state.players[pid];
            p.hand = p.hand.filter(c => c !== card);
            card.zone = 'deck';
            card.owner = null;
            state.deck.unshift(card);
            if (state.mustDiscard > 0) {
                state.mustDiscard--;
                if (state.mustDiscard === 0) endTurnS(state);
            }
            return;
        }
        case 'end-turn': {
            endTurnS(state);
            return;
        }
    }
}

// Move a specific set of the payer's cards to the pending attacker as payment
// (the folded-in payment picker: main.js showPaymentPicker submit). Bank cards
// and surrendered buildings become the attacker's money; properties move across
// keeping their played color. Marks the payer in pendingAction.options
// .alreadyPaidIds so executeActionS records the debt as settled rather than
// charging again.
function applyExplicitPayment(state, payerId, cardIds) {
    const pa = state.pendingAction;
    if (!pa) return;
    const attackerId = pa.attackerId;
    const payer = state.players[payerId];
    const attacker = state.players[attackerId];
    const ids = new Set(cardIds);

    // Bank.
    payer.bank.filter(c => ids.has(c.data.id)).forEach(c => {
        payer.bank = payer.bank.filter(x => x !== c);
        c.owner = attackerId;
        attacker.bank.push(c);
    });
    // Buildings -> attacker bank (surrendered as money).
    for (const colorKey of Object.keys(payer.buildings || {})) {
        (payer.buildings[colorKey] || []).filter(c => ids.has(c.data.id)).forEach(c => {
            payer.buildings[colorKey] = payer.buildings[colorKey].filter(x => x !== c);
            c.owner = attackerId;
            c.zone = 'bank';
            attacker.bank.push(c);
        });
    }
    // Properties -> attacker properties, keeping the played color.
    for (const colorKey of Object.keys(payer.properties || {})) {
        (payer.properties[colorKey] || []).filter(c => ids.has(c.data.id)).forEach(c => {
            payer.properties[colorKey] = payer.properties[colorKey].filter(x => x !== c);
            c.owner = attackerId;
            const color = c.currentColor || colorKey;
            if (!attacker.properties[color]) attacker.properties[color] = [];
            attacker.properties[color].push(c);
        });
    }

    pa.options = pa.options || {};
    if (!pa.options.alreadyPaidIds) pa.options.alreadyPaidIds = [];
    if (!pa.options.alreadyPaidIds.includes(payerId)) pa.options.alreadyPaidIds.push(payerId);
}

export function reduce(state, action) {
    if (!action || action.type == null || action.playerId == null) return state;
    // Game over: nothing is legal, so every further action is a no-op.
    if (state.winner != null) return state;

    const legal = enumerateLegalActions(state, action.playerId);
    if (!isLegal(action, legal)) return state; // reject: state unchanged

    const next = clone(state);
    applyAction(next, action);
    next.winner = checkWinnerS(next);
    next.version = (state.version || 0) + 1;
    return next;
}
