import { CARD_TYPES } from './cards.js';

const PROPOSE_EFFECTS = new Set([
    'sly_deal', 'forced_deal', 'deal_breaker',
    'debt_collector', 'birthday',
]);

export function validDropTargetsFor(card, state) {
    const targets = new Set();
    const localId = state.localPlayerId;

    if (state.turn !== localId) return targets;
    if (state.reactionTargetId !== null) return targets;

    if (state.mustDiscard > 0) {
        targets.add('discard');
        return targets;
    }

    if (state.actionsLeft <= 0) return targets;

    const type = card.data.type;

    if (type === CARD_TYPES.MONEY) {
        targets.add(`bank:${localId}`);
        return targets;
    }

    // Properties and Property Wildcards cannot be banked per rulebook.
    if (type === CARD_TYPES.PROPERTY || type === CARD_TYPES.JOKER) {
        targets.add(`kingdom:${localId}`);
        return targets;
    }

    if (type === CARD_TYPES.RENT) {
        targets.add(`bank:${localId}`);
        targets.add('discard');
        return targets;
    }

    if (type === CARD_TYPES.ACTION) {
        targets.add(`bank:${localId}`);
        // NOT TODAY! is reactive-only — no normal play target.
        if (card.data.effect !== 'just_say_no') targets.add('discard');
        return targets;
    }

    if (type === CARD_TYPES.BUILDING) {
        targets.add(`bank:${localId}`);
        targets.add(`kingdom:${localId}`);
        return targets;
    }

    return targets;
}

export function actionFromDrop(card, targetId, state) {
    if (!validDropTargetsFor(card, state).has(targetId)) return null;

    if (state.mustDiscard > 0 && targetId === 'discard') {
        return { type: 'discard', cardId: card.data.id };
    }

    if (targetId.startsWith('bank:')) {
        return { type: 'play', cardId: card.data.id, zone: 'bank' };
    }

    const type = card.data.type;

    // RENT, BUILDING, and propose-effect ACTIONs need a picker (color and/or
    // target). Drop dispatches a sentinel that main.js routes to handleCardTap
    // so dragging behaves the same as tapping for these cards.
    const needsPicker =
        type === CARD_TYPES.RENT ||
        type === CARD_TYPES.BUILDING ||
        (type === CARD_TYPES.ACTION && PROPOSE_EFFECTS.has(card.data.effect));

    if (targetId === 'discard') {
        if (needsPicker) return { type: 'tap-via-drop', cardId: card.data.id };
        return { type: 'play', cardId: card.data.id, zone: 'discard' };
    }

    if (targetId.startsWith('kingdom:')) {
        if (type === CARD_TYPES.BUILDING) {
            return { type: 'tap-via-drop', cardId: card.data.id };
        }
        const parts = targetId.split(':');
        const explicitColor = parts[2];
        const cardColor = card.data.colorKey
            || (card.data.allowedColors && card.data.allowedColors[0]);
        const color = explicitColor || cardColor;
        return { type: 'play', cardId: card.data.id, zone: 'board', options: { color } };
    }

    return null;
}
