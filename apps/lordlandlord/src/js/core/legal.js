// core/legal.js — the single source of truth for what a player may do.
//
// enumerateLegalActions(state, playerId) is pure: it reads state and returns
// the list of allowed actions, enforcing turn ownership, the 3-action limit,
// the discard phase, and the reaction phase all in one place. The reducer
// rejects any action that isn't in this list, so legality lives here and
// nowhere else. (Body absorbed from engine.js in the Step 8 cleanup.)

import { CARD_TYPES, PROPERTIES } from '../cards.js';
import { checkWinnerS, playerHasPendingReactionS } from '../engine.js';

export function enumerateLegalActions(state, playerId) {
    const player = state.players[playerId];
    const actions = [];

    // If game over, no actions
    if (checkWinnerS(state) !== null) return [];

    // If must discard
    if (state.mustDiscard > 0) {
        if (state.turn === playerId) {
            player.hand.forEach(card => {
                actions.push({ type: 'discard', cardId: card.data.id });
            });
        }
        return actions;
    }

    if (state.pendingAction !== null) {
        if (playerHasPendingReactionS(state, playerId)) {
            const pa = state.pendingAction;
            const isAttacker = playerId === pa.attackerId;
            const targetChainIds = isAttacker
                ? Object.keys(pa.chains).map(k => Number(k))
                    .filter(rid => !pa.chains[rid].settled && pa.chains[rid].chainCount % 2 === 1)
                : [playerId];
            player.hand.forEach(card => {
                if (card.data.effect === 'just_say_no') {
                    if (isAttacker) {
                        targetChainIds.forEach(rid => {
                            actions.push({ type: 'react-no', cardId: card.data.id, againstReactorId: rid });
                        });
                    } else {
                        actions.push({ type: 'react-no', cardId: card.data.id });
                    }
                }
            });
            actions.push({ type: 'concede' });
        }
        return actions;
    }

    // Normal turn
    if (state.turn !== playerId) return [];

    // Free actions: property wildcards can move between legal colors on your
    // turn without spending one of the three actions.
    Object.keys(player.properties || {}).forEach(color => {
        (player.properties[color] || []).forEach(card => {
            if (card.data.type !== CARD_TYPES.JOKER) return;
            const targetColors = card.data.isRainbow
                ? Object.keys(PROPERTIES)
                : (card.data.allowedColors || []);
            targetColors.forEach(targetColor => {
                if (targetColor !== color && PROPERTIES[targetColor]) {
                    actions.push({ type: 'swap-wild', cardId: card.data.id, color: targetColor });
                }
            });
        });
    });

    // 3 action limit
    if (state.actionsLeft > 0) {
        player.hand.forEach(card => {
            // Bank: only Money / Rent / Action / Building per rulebook
            // ("PUT MONEY/ACTION CARDS INTO YOUR OWN BANK").
            // Property cards and Property Wildcards stay in the property collection.
            if (card.data.type !== CARD_TYPES.PROPERTY && card.data.type !== CARD_TYPES.JOKER) {
                actions.push({ type: 'play', cardId: card.data.id, zone: 'bank' });
            }

            // Play Property
            if (card.data.type === CARD_TYPES.PROPERTY) {
                actions.push({ type: 'play', cardId: card.data.id, zone: 'board', options: { color: card.data.colorKey } });
            }

            // Play Wild
            if (card.data.type === CARD_TYPES.JOKER) {
                card.data.allowedColors.forEach(color => {
                    actions.push({ type: 'play', cardId: card.data.id, zone: 'board', options: { color } });
                });
            }

            // Play Building
            if (card.data.type === CARD_TYPES.BUILDING) {
                Object.keys(player.properties).forEach(color => {
                    if (player.properties[color].length >= PROPERTIES[color].count && color !== 'UTILITY' && color !== 'RAILROAD') {
                        const existing = player.buildings[color] || [];
                        if (existing.some(b => b.data.effect === card.data.effect)) return;
                        // Hotel requires a House already on the set.
                        if (card.data.effect === 'hotel' && !existing.some(b => b.data.effect === 'house')) return;
                        actions.push({ type: 'play', cardId: card.data.id, zone: 'board', options: { color } });
                    }
                });
            }

            // Play Action
            if (card.data.type === CARD_TYPES.ACTION) {
                const opponentIds = state.players
                    .filter(p => p.id !== playerId)
                    .map(p => p.id);

                if (card.data.effect === 'sly_deal' || card.data.effect === 'deal_breaker' || card.data.effect === 'forced_deal') {
                    opponentIds.forEach(oppId => {
                        const opp = state.players[oppId];
                        Object.keys(opp.properties).forEach(color => {
                            const isComplete = opp.properties[color].length >= PROPERTIES[color].count;
                            if (card.data.effect === 'sly_deal' && !isComplete) {
                                opp.properties[color].forEach(targetCard => {
                                    actions.push({ type: 'propose', cardId: card.data.id, targetPlayerId: oppId, options: { targetCardId: targetCard.data.id, color } });
                                });
                            }
                            if (card.data.effect === 'deal_breaker' && isComplete) {
                                actions.push({ type: 'propose', cardId: card.data.id, targetPlayerId: oppId, options: { color } });
                            }
                            if (card.data.effect === 'forced_deal' && !isComplete) {
                                opp.properties[color].forEach(targetCard => {
                                    Object.keys(player.properties).forEach(myColor => {
                                        const myComplete = player.properties[myColor].length >= PROPERTIES[myColor].count;
                                        if (myComplete) return;
                                        player.properties[myColor].forEach(myCard => {
                                            actions.push({
                                                type: 'propose',
                                                cardId: card.data.id,
                                                targetPlayerId: oppId,
                                                options: {
                                                    myCardId: myCard.data.id,
                                                    targetCardId: targetCard.data.id,
                                                    color
                                                }
                                            });
                                        });
                                    });
                                });
                            }
                        });
                    });
                } else if (card.data.effect === 'double_rent') {
                    if (state.actionsLeft >= 2 && player.hand.some(c => c.data.type === CARD_TYPES.RENT)) {
                        actions.push({ type: 'play', cardId: card.data.id, zone: 'discard' });
                    }
                } else if (card.data.effect === 'pass_go') {
                    // Pass Go targets nobody; no JSN possible. Auto-fire on play.
                    actions.push({ type: 'play', cardId: card.data.id, zone: 'discard' });
                } else if (card.data.effect === 'just_say_no') {
                    // JSN is reactive-only; never offered during normal action selection.
                } else {
                    opponentIds.forEach(oppId => {
                        actions.push({ type: 'propose', cardId: card.data.id, targetPlayerId: oppId });
                    });
                }
            }

            // Rent: single-color = fan-out (targetPlayerId null); multi = per-opponent (player picks one).
            if (card.data.type === CARD_TYPES.RENT) {
                const opponentIds = state.players
                    .filter(p => p.id !== playerId)
                    .map(p => p.id);
                card.data.allowedColors.forEach(color => {
                    if (player.properties[color] && player.properties[color].length > 0) {
                        if (card.data.isMulti) {
                            opponentIds.forEach(oppId => {
                                actions.push({ type: 'propose', cardId: card.data.id, targetPlayerId: oppId, options: { color } });
                            });
                        } else {
                            actions.push({ type: 'propose', cardId: card.data.id, targetPlayerId: null, options: { color } });
                        }
                    }
                });
            }
        });
    }

    // End Turn
    actions.push({ type: 'end-turn' });

    return actions;
}
