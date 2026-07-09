import { actionFromDrop } from './dropvalid.js';

const TAP_THRESHOLD_PX = 5;
const LONG_PRESS_MS = 500;

export function attachInput(rootEl, getState, onAction, onCardInfo, onCardTap) {
    let activeCardEl = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let overlay = null;
    let lastHover = null;
    let longPressTimer = null;
    let longPressFired = false;

    function clearLongPress() {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    rootEl.addEventListener('pointerdown', (e) => {
        const cardEl = e.target.closest && e.target.closest('[data-card-id]');
        const draggable = cardEl && cardEl.dataset.draggable === 'true';
        const targetEl = e.target.closest && e.target.closest('[data-drop-target]');

        if (cardEl) {
            activeCardEl = draggable ? cardEl : null;
            startX = e.clientX;
            startY = e.clientY;
            moved = false;
            longPressFired = false;
            clearLongPress();
            if (onCardInfo) {
                const infoCardEl = cardEl;
                longPressTimer = setTimeout(() => {
                    longPressFired = true;
                    activeCardEl = null;
                    onCardInfo(infoCardEl.dataset.cardId);
                }, LONG_PRESS_MS);
            }
            if (draggable) return;
        }

        if (targetEl && !longPressFired) {
            handleTargetTap(targetEl, getState, onAction, rootEl);
            return;
        }
    });

    window.addEventListener('pointermove', (e) => {
        // Cancel pending long-press if the pointer moves past the tap threshold,
        // even when no draggable card is active (e.g. swiping over the discard pile).
        if (longPressTimer) {
            const moveDx = e.clientX - startX;
            const moveDy = e.clientY - startY;
            if (Math.hypot(moveDx, moveDy) >= TAP_THRESHOLD_PX) clearLongPress();
        }
        if (!activeCardEl) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) >= TAP_THRESHOLD_PX) {
            moved = true;
            clearLongPress();
            overlay = makeOverlay(activeCardEl);
            activeCardEl.classList.add('dragging-source');
        }
        if (moved && overlay) {
            overlay.style.left = `${e.clientX - 36}px`;
            overlay.style.top = `${e.clientY - 54}px`;
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const target = under && under.closest && under.closest('[data-drop-target]');
            if (target !== lastHover) {
                if (lastHover) lastHover.classList.remove('drop-hover');
                if (target) target.classList.add('drop-hover');
                lastHover = target;
            }
        }
    });

    window.addEventListener('pointerup', (e) => {
        clearLongPress();
        if (!activeCardEl) {
            longPressFired = false;
            return;
        }

        if (longPressFired) {
            // Long-press already fired the info modal — don't treat as tap or drop.
        } else if (!moved) {
            handleCardTap(activeCardEl, rootEl, onCardTap);
        } else {
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const target = under && under.closest && under.closest('[data-drop-target]');
            cleanupOverlay();
            if (target) {
                fireDrop(activeCardEl, target, getState, onAction);
            }
            if (lastHover) lastHover.classList.remove('drop-hover');
            lastHover = null;
        }

        if (activeCardEl) activeCardEl.classList.remove('dragging-source');
        activeCardEl = null;
        moved = false;
        overlay = null;
        longPressFired = false;
    });
}

function makeOverlay(srcEl) {
    const overlay = srcEl.cloneNode(true);
    overlay.classList.add('drag-overlay');
    document.body.appendChild(overlay);
    return overlay;
}

function cleanupOverlay() {
    document.querySelectorAll('.drag-overlay').forEach(o => o.remove());
}

function handleCardTap(cardEl, rootEl, onCardTap) {
    if (onCardTap && cardEl.dataset.draggable === 'true') {
        const handled = onCardTap(cardEl.dataset.cardId);
        if (handled) return;
    }
    const wasSelected = cardEl.classList.contains('selected');
    rootEl.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
    if (!wasSelected) cardEl.classList.add('selected');
}

function handleTargetTap(targetEl, getState, onAction, rootEl) {
    const selected = rootEl.querySelector('.card.selected');
    if (!selected) return;
    fireDrop(selected, targetEl, getState, onAction);
    selected.classList.remove('selected');
}

function fireDrop(cardEl, targetEl, getState, onAction) {
    const state = getState();
    const cardId = cardEl.dataset.cardId;
    const targetId = targetEl.dataset.dropTarget;
    const local = state.players[state.localPlayerId];
    const card = local.hand.find(c => c.data.id === cardId);
    if (!card) return;
    const action = actionFromDrop(card, targetId, state);
    if (action) onAction(action);
}
