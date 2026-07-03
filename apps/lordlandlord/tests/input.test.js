import { describe, it, expect, beforeEach, vi } from 'vitest';
import { attachInput } from '../src/js/input.js';

function makeCard(id) {
    return { data: { id, name: 'X', value: 1, type: 'MONEY' }, zone: 'hand', owner: 0 };
}

function pointerEvent(type, x, y, target) {
    const e = new Event(type, { bubbles: true });
    e.clientX = x;
    e.clientY = y;
    e.pointerId = 1;
    if (target) Object.defineProperty(e, 'target', { value: target });
    return e;
}

describe('attachInput - tap', () => {
    let root, state, onAction;

    beforeEach(() => {
        document.body.innerHTML = `
            <main id="game-root">
                <div class="your-hand">
                    <div class="card hand-card" data-card-id="c1" data-draggable="true"></div>
                </div>
                <div class="your-bank" data-drop-target="bank:0"></div>
            </main>`;
        root = document.getElementById('game-root');
        state = {
            players: [{ id: 0, hand: [makeCard('c1')], bank: [], properties: {} }, { id: 1, hand: [], bank: [], properties: {} }],
            localPlayerId: 0, turn: 0, actionsLeft: 3, mustDiscard: 0, reactionTargetId: null, deck: [], discard: []
        };
        onAction = vi.fn();
        attachInput(root, () => state, onAction);
    });

    it('tap on hand card selects it', () => {
        const card = root.querySelector('.hand-card');
        card.dispatchEvent(pointerEvent('pointerdown', 100, 100, card));
        window.dispatchEvent(pointerEvent('pointerup', 100, 100, card));
        expect(card.classList.contains('selected')).toBe(true);
    });

    it('tap on selected card then valid drop target dispatches action', () => {
        const card = root.querySelector('.hand-card');
        const bank = root.querySelector('.your-bank');
        card.dispatchEvent(pointerEvent('pointerdown', 100, 100, card));
        window.dispatchEvent(pointerEvent('pointerup', 100, 100, card));
        bank.dispatchEvent(pointerEvent('pointerdown', 200, 200, bank));
        window.dispatchEvent(pointerEvent('pointerup', 200, 200, bank));
        expect(onAction).toHaveBeenCalledWith({ type: 'play', cardId: 'c1', zone: 'bank' });
    });
});

describe('attachInput - drag distinction', () => {
    it('movement > threshold fires action on pointerup over target', () => {
        document.body.innerHTML = `
            <main id="game-root">
                <div class="your-hand">
                    <div class="card hand-card" data-card-id="c1" data-draggable="true"></div>
                </div>
                <div class="your-bank" data-drop-target="bank:0"></div>
            </main>`;
        const root = document.getElementById('game-root');
        const state = {
            players: [{ id: 0, hand: [makeCard('c1')], bank: [], properties: {} }, { id: 1, hand: [], bank: [], properties: {} }],
            localPlayerId: 0, turn: 0, actionsLeft: 3, mustDiscard: 0, reactionTargetId: null, deck: [], discard: []
        };
        const onAction = vi.fn();
        attachInput(root, () => state, onAction);

        const card = root.querySelector('.hand-card');
        const bank = root.querySelector('.your-bank');

        document.elementFromPoint = (x, y) => (x >= 150 && x < 250 && y >= 150 && y < 250 ? bank : null);

        card.dispatchEvent(pointerEvent('pointerdown', 100, 100, card));
        window.dispatchEvent(pointerEvent('pointermove', 200, 200));
        window.dispatchEvent(pointerEvent('pointerup', 200, 200));
        expect(onAction).toHaveBeenCalledWith({ type: 'play', cardId: 'c1', zone: 'bank' });
    });
});
