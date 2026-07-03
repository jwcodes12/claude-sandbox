# Mobile DOM Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canvas renderer with a DOM/CSS UI that works mobile-first and adapts responsively to desktop. Cards become real DOM elements; layout is handled by CSS flex/grid; input is one Pointer-Events path for both mouse and touch.

**Architecture:**
- `engine.js`, `cards.js`, `multiplayer.js` unchanged — game logic is fully decoupled.
- New `src/js/render.js` is a pure function that takes `gameState` + a root element and produces idempotent DOM updates.
- New `src/js/dropvalid.js` derives valid drop targets and the action to dispatch.
- New `src/js/input.js` attaches Pointer Events for drag-and-drop with tap-to-select fallback.
- `main.js` orchestrates: wires `render` + `input` to engine, removes Auto-Duel.
- `src/js/ui.js` (canvas) is deleted.

**Tech Stack:** Vanilla JS (ES modules), CSS, Vitest + jsdom for unit tests, PeerJS (unchanged).

**Spec reference:** `junk/mobile-redesign/design.md`
**Tracking:** `bd stealr-7`

---

## File Structure

**New:**
- `src/js/render.js` — `render(rootEl, state)` idempotent DOM render
- `src/js/dropvalid.js` — `validDropTargetsFor(card, state) → Set<string>`, `actionFromDrop(card, targetId, state) → action`
- `src/js/input.js` — `attachInput(rootEl, getState, onAction)` Pointer Events
- `tests/dropvalid.test.js`
- `tests/render.test.js`
- `tests/input.test.js`
- `vitest.config.js`

**Modified:**
- `src/index.html` — remove `<canvas>` and `<div id="ui-layer">`, add `<main id="game-root">`
- `src/css/styles.css` — replace canvas-overlay styles with DOM layout
- `src/js/main.js` — wire DOM UI, drop Auto-Duel
- `src/js/cards.js` — add `cssColor` mapping (only if needed; verify in Task 4)
- `package.json` — add `vitest`, `jsdom`, npm scripts

**Removed:**
- `src/js/ui.js`
- `ui-test/test-mobile.js`, `test-mobile-improved.js`, `test-overlap-debug.js`, `test-multiplayer-mobile.js`, `test-bank.js`, `test-icons.js`, `test-layout-validation.js`, `test-scale.js`, `test-toast.js`, `test-ui-showcase.js` (all canvas-layout tests)
- `ui-test/screenshots/`, `ui-test/*.png`, `ui-test/*.json` (stale artifacts)

**Kept in `ui-test/`:** `test-full-game.js`, `test-comprehensive.js`, `test-5-players.js`, `test-unit-cards.js` (game-logic, not canvas-layout) — these may need touch-ups in Task 11 but stay.

---

## Task 1: Set up Vitest + jsdom

**Files:**
- Modify: `package.json`
- Create: `vitest.config.js`
- Create: `tests/smoke.test.js`

- [ ] **Step 1.1: Update `package.json`**

Replace entire file with:

```json
{
  "name": "lord-landlord",
  "version": "1.0.0",
  "type": "module",
  "description": "Medieval Monopoly Deal Engine",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {},
  "devDependencies": {
    "vitest": "^1.6.0",
    "jsdom": "^24.0.0"
  }
}
```

- [ ] **Step 1.2: Install**

```bash
cd /Users/john.watkins/Downloads/stealr && npm install
```

Expected: `added 50+ packages` (no errors). If npm is offline, the build still runs since nothing in the runtime depends on these packages — only the test scripts do.

- [ ] **Step 1.3: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: false,
        include: ['tests/**/*.test.js']
    }
});
```

- [ ] **Step 1.4: Create `tests/smoke.test.js`**

```js
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
    it('jsdom provides document', () => {
        expect(document).toBeDefined();
        expect(document.createElement('div').tagName).toBe('DIV');
    });
});
```

- [ ] **Step 1.5: Run smoke test**

```bash
cd /Users/john.watkins/Downloads/stealr && npm test
```

Expected: `1 passed`.

---

## Task 2: dropvalid — pure drop-target logic

This module is the source of truth for "what can this card be dropped onto, and what action does that fire?" Both drag-and-drop and tap-to-select use it.

**Files:**
- Create: `src/js/dropvalid.js`
- Create: `tests/dropvalid.test.js`

### Drop target ID format

A drop-target ID is a string namespaced by purpose:
- `bank:<playerId>` — a player's bank
- `kingdom:<playerId>:<colorKey>` — a player's kingdom, specific color slot
- `kingdom:<playerId>:NEW` — a new color slot in a player's kingdom (for wilds/uncommitted)
- `discard` — discard pile
- `opp-card:<playerId>:<cardId>` — a specific opponent card (for forced-trade / steal targeting)

Only `bank:<localId>`, `kingdom:<localId>:*`, and `discard` are drop targets for property/money plays. Action-card targeting (opponent picks) is handled via the existing picker modal after the card lands on `discard`.

- [ ] **Step 2.1: Write failing test**

`tests/dropvalid.test.js`:

```js
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

    it('property card is valid for matching kingdom slot and bank', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.PROPERTY, { colorKey: 'BROWN' });
        const targets = validDropTargetsFor(card, state);
        expect(targets.has('kingdom:0:BROWN')).toBe(true);
        expect(targets.has('bank:0')).toBe(true);
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
    it('money to bank → play to bank', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'bank:0', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'bank' });
    });

    it('property to kingdom → play to board with color', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.PROPERTY, { colorKey: 'RED' });
        const action = actionFromDrop(card, 'kingdom:0:RED', state);
        expect(action).toEqual({ type: 'play', cardId: 'c1', zone: 'board', options: { color: 'RED' } });
    });

    it('forced discard → discard action', () => {
        const state = makeState({ mustDiscard: 1 });
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'discard', state);
        expect(action).toEqual({ type: 'discard', cardId: 'c1' });
    });

    it('invalid drop returns null', () => {
        const state = makeState();
        const card = makeCard(CARD_TYPES.MONEY);
        const action = actionFromDrop(card, 'kingdom:0:RED', state);
        expect(action).toBeNull();
    });
});
```

- [ ] **Step 2.2: Run test, verify fails**

```bash
npm test -- tests/dropvalid.test.js
```

Expected: FAIL with "Failed to resolve import".

- [ ] **Step 2.3: Implement `src/js/dropvalid.js`**

```js
import { CARD_TYPES } from './cards.js';

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

    if (type === CARD_TYPES.PROPERTY) {
        targets.add(`bank:${localId}`);
        if (card.data.colorKey) {
            targets.add(`kingdom:${localId}:${card.data.colorKey}`);
        }
        return targets;
    }

    if (type === CARD_TYPES.ACTION) {
        targets.add(`bank:${localId}`);
        targets.add('discard');
        return targets;
    }

    return targets;
}

export function actionFromDrop(card, targetId, state) {
    if (!validDropTargetsFor(card, state).has(targetId)) return null;

    if (state.mustDiscard > 0 && targetId === 'discard') {
        return { type: 'discard', cardId: card.data.id };
    }

    if (targetId === 'discard') {
        return { type: 'play', cardId: card.data.id, zone: 'discard' };
    }

    if (targetId.startsWith('bank:')) {
        return { type: 'play', cardId: card.data.id, zone: 'bank' };
    }

    if (targetId.startsWith('kingdom:')) {
        const [, , color] = targetId.split(':');
        return { type: 'play', cardId: card.data.id, zone: 'board', options: { color } };
    }

    return null;
}
```

- [ ] **Step 2.4: Run test, verify pass**

```bash
npm test -- tests/dropvalid.test.js
```

Expected: `8 passed`.

---

## Task 3: render.js skeleton — top-level structure

Build the renderer that lays out the five regions (top bar, opponents container, zone strip, your area, hand) and is idempotent: calling `render` twice with the same state produces the same DOM.

**Files:**
- Create: `src/js/render.js`
- Create: `tests/render.test.js`

- [ ] **Step 3.1: Write failing test**

`tests/render.test.js`:

```js
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

    it('is idempotent — calling twice produces same node count', () => {
        render(root, makeState());
        const first = root.innerHTML;
        render(root, makeState());
        const second = root.innerHTML;
        expect(second).toBe(first);
    });
});
```

- [ ] **Step 3.2: Run test, verify fails**

```bash
npm test -- tests/render.test.js
```

Expected: FAIL with "Failed to resolve import".

- [ ] **Step 3.3: Implement skeleton in `src/js/render.js`**

```js
export function render(root, state) {
    root.innerHTML = '';
    root.appendChild(renderTopBar(state));
    root.appendChild(renderOpponents(state));
    root.appendChild(renderZoneStrip(state));
    root.appendChild(renderYourArea(state));
    root.appendChild(renderYourHand(state));
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function renderTopBar(state) {
    return el('header', 'top-bar');
}

function renderOpponents(state) {
    const container = el('section', 'opponents');
    state.players.forEach(p => {
        if (p.id === state.localPlayerId) return;
        const oppEl = el('div', 'opponent');
        oppEl.dataset.playerId = String(p.id);
        container.appendChild(oppEl);
    });
    return container;
}

function renderZoneStrip(state) {
    return el('section', 'zone-strip');
}

function renderYourArea(state) {
    return el('section', 'your-area');
}

function renderYourHand(state) {
    return el('section', 'your-hand');
}
```

- [ ] **Step 3.4: Run test, verify pass**

```bash
npm test -- tests/render.test.js
```

Expected: `3 passed`.

---

## Task 4: Render top bar contents

The top bar shows: round/turn indicator, your gold, your kingdom progress, actions remaining, End Turn button, hamburger menu button.

**Files:**
- Modify: `src/js/render.js` — flesh out `renderTopBar`
- Modify: `tests/render.test.js` — add tests

- [ ] **Step 4.1: Add failing tests**

Append to `tests/render.test.js`:

```js
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
```

- [ ] **Step 4.2: Run test, verify new tests fail**

```bash
npm test -- tests/render.test.js
```

Expected: top-bar tests FAIL (textContent doesn't match).

- [ ] **Step 4.3: Implement top bar + helper functions**

Replace `renderTopBar` and add helpers in `src/js/render.js`:

```js
import { PROPERTIES } from './cards.js';

function bankTotal(player) {
    return player.bank.reduce((s, c) => s + (c.data.value || 0), 0);
}

function completedSets(player) {
    let n = 0;
    for (const colorKey of Object.keys(player.properties || {})) {
        const def = PROPERTIES[colorKey];
        if (!def) continue;
        if (player.properties[colorKey].length >= def.count) n++;
    }
    return n;
}

function renderTopBar(state) {
    const bar = el('header', 'top-bar');
    const local = state.players[state.localPlayerId];

    const gold = el('span', 'top-stat', `${bankTotal(local)}g`);
    gold.dataset.field = 'your-gold';

    const kingdom = el('span', 'top-stat', `${completedSets(local)}/3`);
    kingdom.dataset.field = 'kingdom';

    const actions = el('span', 'top-stat top-actions', `Actions: ${state.actionsLeft}`);
    actions.dataset.field = 'actions';

    const endTurnBtn = el('button', 'btn-end-turn', 'End Turn');
    endTurnBtn.dataset.action = 'end-turn';
    endTurnBtn.disabled =
        state.turn !== state.localPlayerId ||
        state.mustDiscard > 0 ||
        state.reactionTargetId !== null;

    const menuBtn = el('button', 'btn-menu', '☰');
    menuBtn.dataset.action = 'menu';

    bar.append(gold, kingdom, actions, endTurnBtn, menuBtn);
    return bar;
}
```

Add `import { PROPERTIES } from './cards.js';` at the top of `render.js` if it's not there yet.

- [ ] **Step 4.4: Run test, verify pass**

```bash
npm test -- tests/render.test.js
```

Expected: all top-bar tests pass.

---

## Task 5: Render opponent rows

Each opponent renders: header line (name, gold, sets, hand count) and a kingdom body with color-grouped fanned stacks. Empty kingdom = no body, just the header.

**Files:**
- Modify: `src/js/render.js` — flesh out `renderOpponents`
- Modify: `tests/render.test.js`

- [ ] **Step 5.1: Add failing tests**

Append to `tests/render.test.js`:

```js
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
```

- [ ] **Step 5.2: Run test, verify fails**

```bash
npm test -- tests/render.test.js
```

Expected: opponent-rows tests FAIL.

- [ ] **Step 5.3: Implement `renderOpponents`**

Replace `renderOpponents` and add helpers in `src/js/render.js`:

```js
function renderOpponents(state) {
    const container = el('section', 'opponents');
    state.players.forEach(p => {
        if (p.id === state.localPlayerId) return;
        container.appendChild(renderOpponent(p));
    });
    return container;
}

function renderOpponent(p) {
    const oppEl = el('div', 'opponent');
    oppEl.dataset.playerId = String(p.id);

    const header = el('div', 'opp-header');
    const name = el('span', 'opp-name', `Lord ${p.id}`);
    const gold = el('span', 'opp-stat');
    gold.dataset.field = 'opp-gold';
    gold.textContent = `${bankTotal(p)}g`;
    const sets = el('span', 'opp-stat');
    sets.dataset.field = 'opp-sets';
    sets.textContent = `${completedSets(p)}/3`;
    const hand = el('span', 'opp-stat');
    hand.dataset.field = 'opp-hand';
    hand.textContent = `H:${p.hand.length}`;
    header.append(name, gold, sets, hand);
    oppEl.appendChild(header);

    const colorKeys = Object.keys(p.properties || {}).filter(k => (p.properties[k] || []).length > 0);
    if (colorKeys.length > 0) {
        const kingdom = el('div', 'opp-kingdom');
        for (const colorKey of colorKeys) {
            kingdom.appendChild(renderColorStack(colorKey, p.properties[colorKey]));
        }
        oppEl.appendChild(kingdom);
    }
    return oppEl;
}

function renderColorStack(colorKey, cards) {
    const stack = el('div', 'color-stack');
    stack.dataset.colorKey = colorKey;
    const hex = (PROPERTIES[colorKey] && PROPERTIES[colorKey].hex) || '#888';
    stack.style.setProperty('--stack-color', hex);
    cards.forEach(c => {
        const cardEl = el('div', 'card mini');
        cardEl.dataset.cardId = c.data && c.data.id;
        cardEl.style.setProperty('--card-color', hex);
        stack.appendChild(cardEl);
    });
    return stack;
}
```

- [ ] **Step 5.4: Run test, verify pass**

```bash
npm test -- tests/render.test.js
```

Expected: all tests pass so far.

---

## Task 6: Render your area (bank + kingdom)

Your bank is a horizontal money-chip row with running total. Your kingdom uses the same color-stack layout as opponents but with larger cards.

**Files:**
- Modify: `src/js/render.js` — flesh out `renderYourArea`
- Modify: `tests/render.test.js`

- [ ] **Step 6.1: Add failing tests**

Append to `tests/render.test.js`:

```js
describe('your area', () => {
    let root;
    beforeEach(() => {
        document.body.innerHTML = '<main id="game-root"></main>';
        root = document.getElementById('game-root');
    });

    it('renders bank chips and total', () => {
        const state = makeState({
            players: [
                { id: 0, hand: [], bank: [{ data: { id: 'm1', value: 3 } }, { data: { id: 'm2', value: 5 } }], properties: {} },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const bank = root.querySelector('.your-bank');
        expect(bank.querySelectorAll('.money-chip').length).toBe(2);
        expect(bank.querySelector('[data-field="bank-total"]').textContent).toBe('= 8g');
    });

    it('bank is a drop target', () => {
        render(root, makeState());
        const bank = root.querySelector('.your-bank');
        expect(bank.dataset.dropTarget).toBe('bank:0');
    });

    it('your kingdom renders color stacks like opponents', () => {
        const state = makeState({
            players: [
                {
                    id: 0, hand: [], bank: [],
                    properties: { GREEN: [{ data: { id: 'g1', colorKey: 'GREEN' } }] }
                },
                { id: 1, hand: [], bank: [], properties: {} }
            ]
        });
        render(root, state);
        const kingdom = root.querySelector('.your-kingdom');
        expect(kingdom.querySelectorAll('.color-stack').length).toBe(1);
        expect(kingdom.querySelector('.color-stack').dataset.dropTarget).toBe('kingdom:0:GREEN');
    });
});
```

- [ ] **Step 6.2: Run test, verify fails**

```bash
npm test -- tests/render.test.js
```

Expected: your-area tests FAIL.

- [ ] **Step 6.3: Implement `renderYourArea`**

Replace `renderYourArea` in `src/js/render.js`:

```js
function renderYourArea(state) {
    const wrap = el('section', 'your-area');
    const local = state.players[state.localPlayerId];

    const bank = el('div', 'your-bank');
    bank.dataset.dropTarget = `bank:${state.localPlayerId}`;
    const bankLabel = el('span', 'bank-label', 'Your Bank');
    bank.appendChild(bankLabel);
    local.bank.forEach(c => {
        const chip = el('div', 'money-chip', `${c.data.value}g`);
        chip.dataset.cardId = c.data.id;
        bank.appendChild(chip);
    });
    const total = el('span', 'bank-total');
    total.dataset.field = 'bank-total';
    total.textContent = `= ${bankTotal(local)}g`;
    bank.appendChild(total);

    const kingdom = el('div', 'your-kingdom');
    const colorKeys = Object.keys(local.properties || {}).filter(k => (local.properties[k] || []).length > 0);
    for (const colorKey of colorKeys) {
        const stack = renderColorStack(colorKey, local.properties[colorKey]);
        stack.dataset.dropTarget = `kingdom:${state.localPlayerId}:${colorKey}`;
        stack.classList.add('large');
        kingdom.appendChild(stack);
    }

    wrap.append(bank, kingdom);
    return wrap;
}
```

- [ ] **Step 6.4: Run test, verify pass**

```bash
npm test -- tests/render.test.js
```

Expected: all tests pass.

---

## Task 7: Render hand + zone strip

Your hand is a horizontally scrollable strip of full-size cards. The zone strip shows the deck (with count badge), discard pile (top card), and decrees / active-play area.

**Files:**
- Modify: `src/js/render.js`
- Modify: `tests/render.test.js`

- [ ] **Step 7.1: Add failing tests**

Append to `tests/render.test.js`:

```js
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

    it('renders discard top card when present', () => {
        const state = makeState({ discard: [{ data: { id: 'd1', name: 'Old' } }, { data: { id: 'd2', name: 'Top' } }] });
        render(root, state);
        const discard = root.querySelector('.zone-discard .card');
        expect(discard.dataset.cardId).toBe('d2');
    });

    it('discard is a drop target', () => {
        render(root, makeState());
        const discard = root.querySelector('.zone-discard');
        expect(discard.dataset.dropTarget).toBe('discard');
    });
});
```

- [ ] **Step 7.2: Run test, verify fails**

```bash
npm test -- tests/render.test.js
```

Expected: hand and zone-strip tests FAIL.

- [ ] **Step 7.3: Implement `renderYourHand` and `renderZoneStrip`**

Replace those two functions in `src/js/render.js`:

```js
function renderYourHand(state) {
    const wrap = el('section', 'your-hand');
    const local = state.players[state.localPlayerId];

    local.hand.forEach(c => {
        const cardEl = el('div', 'card hand-card');
        cardEl.dataset.cardId = c.data.id;
        cardEl.dataset.draggable = 'true';
        cardEl.style.setProperty('--card-color', c.data.hex || c.data.color || '#444');
        const name = el('div', 'card-name', c.data.name || '');
        const value = el('div', 'card-value', c.data.value != null ? `${c.data.value}g` : '');
        cardEl.append(name, value);
        wrap.appendChild(cardEl);
    });
    return wrap;
}

function renderZoneStrip(state) {
    const strip = el('section', 'zone-strip');

    const deck = el('div', 'zone-deck');
    const deckCard = el('div', 'card deck-card');
    const count = el('span', 'badge-count');
    count.dataset.field = 'deck-count';
    count.textContent = String(state.deck.length);
    deck.append(deckCard, count);
    strip.appendChild(deck);

    const discard = el('div', 'zone-discard');
    discard.dataset.dropTarget = 'discard';
    if (state.discard.length > 0) {
        const top = state.discard[state.discard.length - 1];
        const cardEl = el('div', 'card discard-top');
        cardEl.dataset.cardId = top.data.id;
        cardEl.style.setProperty('--card-color', top.data.hex || top.data.color || '#444');
        cardEl.appendChild(el('div', 'card-name', top.data.name || ''));
        discard.appendChild(cardEl);
    }
    strip.appendChild(discard);

    const decrees = el('div', 'zone-decrees');
    decrees.dataset.field = 'decrees';
    strip.appendChild(decrees);

    return strip;
}
```

- [ ] **Step 7.4: Run test, verify pass**

```bash
npm test -- tests/render.test.js
```

Expected: all render tests pass.

---

## Task 8: CSS layout — top to bottom

Replace the canvas-overlay styles with a stacked DOM layout. Mobile-first; desktop bumps card sizes via breakpoint.

**Files:**
- Modify: `src/css/styles.css`

- [ ] **Step 8.1: Append new layout block**

Append to the end of `src/css/styles.css` (so existing splash/lobby/modal styles still work):

```css
/* ============ DOM Game UI ============ */

:root {
    --card-w-base: 60px;
    --card-h-base: 90px;
    --card-w-hand: 72px;
    --card-h-hand: 108px;
    --card-w-mini: 40px;
    --card-h-mini: 60px;
    --bar-h: 44px;
    --hand-h: 170px;
}

#game-root {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: #2c1810;
    color: #f4e4bc;
    font-family: 'Cinzel', serif;
    padding-bottom: var(--hand-h);
}

.top-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    height: var(--bar-h);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    background: #1a1108;
    border-bottom: 2px solid #d4af37;
}

.top-stat {
    font-size: 13px;
    padding: 4px 8px;
    background: #2c1810;
    border: 1px solid #d4af37;
    border-radius: 4px;
    white-space: nowrap;
}

.top-actions {
    background: #4a3018;
    font-weight: bold;
}

.btn-end-turn,
.btn-menu {
    margin-left: auto;
    height: 32px;
    padding: 0 12px;
    background: #d4af37;
    color: #1a1108;
    border: none;
    border-radius: 4px;
    font-weight: bold;
    cursor: pointer;
}

.btn-end-turn:disabled {
    background: #555;
    color: #999;
    cursor: not-allowed;
}

.btn-menu {
    margin-left: 0;
    padding: 0 10px;
    background: transparent;
    color: #d4af37;
    font-size: 20px;
    line-height: 1;
}

.opponents {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
}

.opponent {
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(212, 175, 55, 0.3);
    border-radius: 6px;
    padding: 6px 8px;
}

.opp-header {
    display: flex;
    gap: 10px;
    font-size: 13px;
    align-items: center;
}

.opp-name {
    font-weight: bold;
    color: #d4af37;
}

.opp-stat {
    color: #f4e4bc;
    opacity: 0.9;
}

.opp-kingdom,
.your-kingdom {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 6px;
}

.your-kingdom {
    padding: 8px;
}

.color-stack {
    position: relative;
    display: flex;
    flex-direction: column;
    border-bottom: 3px solid var(--stack-color, #888);
    padding-bottom: 3px;
}

.color-stack .card {
    width: var(--card-w-mini);
    height: var(--card-h-mini);
    margin-top: -45px;
}

.color-stack .card:first-child {
    margin-top: 0;
}

.color-stack.large .card {
    width: var(--card-w-base);
    height: var(--card-h-base);
    margin-top: -65px;
}

.color-stack.large .card:first-child {
    margin-top: 0;
}

.card {
    box-sizing: border-box;
    width: var(--card-w-base);
    height: var(--card-h-base);
    background: linear-gradient(135deg, #fff, #ddd);
    border: 2px solid var(--card-color, #444);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 4px;
    color: #1a1108;
    font-size: 10px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
}

.card.mini {
    font-size: 8px;
    padding: 2px;
}

.card.hand-card {
    width: var(--card-w-hand);
    height: var(--card-h-hand);
    flex-shrink: 0;
    cursor: grab;
    touch-action: none;
}

.card.hand-card.selected {
    outline: 3px solid #d4af37;
    transform: translateY(-8px);
}

.card-name {
    font-weight: bold;
}

.card-value {
    text-align: right;
    opacity: 0.7;
}

.zone-strip {
    display: flex;
    gap: 12px;
    justify-content: space-around;
    padding: 10px;
    border-top: 1px solid rgba(212, 175, 55, 0.3);
    border-bottom: 1px solid rgba(212, 175, 55, 0.3);
}

.zone-deck,
.zone-discard,
.zone-decrees {
    position: relative;
    width: var(--card-w-base);
    height: var(--card-h-base);
    border: 2px dashed rgba(212, 175, 55, 0.5);
    border-radius: 6px;
}

.deck-card {
    width: 100%;
    height: 100%;
    background: repeating-linear-gradient(45deg, #4a3018, #4a3018 4px, #3a2410 4px, #3a2410 8px);
    border-color: #d4af37;
}

.badge-count {
    position: absolute;
    bottom: -4px;
    right: -4px;
    background: #d4af37;
    color: #1a1108;
    border-radius: 12px;
    padding: 2px 6px;
    font-size: 11px;
    font-weight: bold;
}

.your-area {
    padding: 8px;
}

.your-bank {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    padding: 6px 8px;
    background: rgba(45, 90, 39, 0.2);
    border: 1px dashed #2d5a27;
    border-radius: 6px;
    min-height: 48px;
}

.bank-label {
    font-size: 11px;
    color: #d4af37;
    font-weight: bold;
}

.money-chip {
    background: #d4af37;
    color: #1a1108;
    border-radius: 4px;
    padding: 4px 8px;
    font-weight: bold;
    font-size: 12px;
}

.bank-total {
    margin-left: auto;
    font-weight: bold;
    color: #d4af37;
}

.your-hand {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: var(--hand-h);
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px;
    overflow-x: auto;
    overflow-y: visible;
    background: rgba(26, 17, 8, 0.95);
    border-top: 2px solid #d4af37;
    scroll-snap-type: x mandatory;
}

.your-hand .card {
    scroll-snap-align: start;
}

/* drop-target hover highlight (applied by input.js) */
[data-drop-target].drop-hover {
    outline: 3px solid #2d5a27;
    box-shadow: 0 0 12px rgba(45, 90, 39, 0.8);
}

/* drag overlay */
.drag-overlay {
    position: fixed;
    pointer-events: none;
    z-index: 1000;
    transform: scale(1.1);
    transition: none;
}

/* Desktop bump */
@media (min-width: 768px) {
    :root {
        --card-w-base: 80px;
        --card-h-base: 120px;
        --card-w-hand: 96px;
        --card-h-hand: 144px;
        --card-w-mini: 54px;
        --card-h-mini: 80px;
    }
    .opponents {
        flex-direction: row;
        flex-wrap: wrap;
    }
    .opponent {
        flex: 1 1 45%;
    }
}
```

- [ ] **Step 8.2: Hide the legacy `#ui-layer` and `#gameCanvas`**

Append to `src/css/styles.css`:

```css
#ui-layer,
#gameCanvas {
    display: none !important;
}
```

(Temporary safety net; both elements are removed from HTML in Task 10.)

- [ ] **Step 8.3: Manual verification**

Run the dev server (or open `src/index.html` in a browser via `python3 -m http.server` from the project root). Start a 3-bot game from the lobby and check the layout visually. Expected: the new DOM tree appears, no canvas, no double UI. Layout may be incomplete since `main.js` is not wired yet — that's Task 10.

```bash
cd /Users/john.watkins/Downloads/stealr && python3 -m http.server 8000 --directory src
```

Then open `http://localhost:8000/` on the desktop and on a phone (or Chrome mobile emulation). Expected: splash screen still works; gameplay screen will be empty until Task 10. Kill the server when done.

---

## Task 9: Pointer Events input — drag-and-drop + tap

One module attaches global Pointer Events to the root and handles both drag and tap. The discrimination is based on movement distance during the gesture.

**Files:**
- Create: `src/js/input.js`
- Create: `tests/input.test.js`

### Tap vs. drag threshold

- If `pointermove` total distance < 5px before `pointerup` → tap
- Otherwise → drag

- [ ] **Step 9.1: Write failing test**

`tests/input.test.js`:

```js
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
        card.dispatchEvent(pointerEvent('pointerup', 100, 100, card));
        expect(card.classList.contains('selected')).toBe(true);
    });

    it('tap on selected card then valid drop target dispatches action', () => {
        const card = root.querySelector('.hand-card');
        const bank = root.querySelector('.your-bank');
        card.dispatchEvent(pointerEvent('pointerdown', 100, 100, card));
        card.dispatchEvent(pointerEvent('pointerup', 100, 100, card));
        bank.dispatchEvent(pointerEvent('pointerdown', 200, 200, bank));
        bank.dispatchEvent(pointerEvent('pointerup', 200, 200, bank));
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
        bank.getBoundingClientRect = () => ({ left: 150, top: 150, right: 250, bottom: 250, width: 100, height: 100 });

        // Mock elementFromPoint to return bank during drag
        document.elementFromPoint = (x, y) => (x >= 150 && x < 250 && y >= 150 && y < 250 ? bank : null);

        card.dispatchEvent(pointerEvent('pointerdown', 100, 100, card));
        window.dispatchEvent(pointerEvent('pointermove', 200, 200));
        window.dispatchEvent(pointerEvent('pointerup', 200, 200));
        expect(onAction).toHaveBeenCalledWith({ type: 'play', cardId: 'c1', zone: 'bank' });
    });
});
```

- [ ] **Step 9.2: Run test, verify fails**

```bash
npm test -- tests/input.test.js
```

Expected: FAIL (module not found).

- [ ] **Step 9.3: Implement `src/js/input.js`**

```js
import { validDropTargetsFor, actionFromDrop } from './dropvalid.js';

const TAP_THRESHOLD_PX = 5;

export function attachInput(rootEl, getState, onAction) {
    let activeCardEl = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let overlay = null;
    let lastHover = null;

    rootEl.addEventListener('pointerdown', (e) => {
        const cardEl = e.target.closest('[data-draggable="true"]');
        const targetEl = e.target.closest('[data-drop-target]');

        if (cardEl) {
            activeCardEl = cardEl;
            startX = e.clientX;
            startY = e.clientY;
            moved = false;
            return;
        }

        if (targetEl) {
            handleTargetTap(targetEl, getState, onAction, rootEl);
            return;
        }
    });

    window.addEventListener('pointermove', (e) => {
        if (!activeCardEl) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) >= TAP_THRESHOLD_PX) {
            moved = true;
            overlay = makeOverlay(activeCardEl);
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
        if (!activeCardEl) return;

        if (!moved) {
            // Tap on a card
            handleCardTap(activeCardEl, rootEl);
        } else {
            // Drag completed
            const under = document.elementFromPoint(e.clientX, e.clientY);
            const target = under && under.closest && under.closest('[data-drop-target]');
            cleanupOverlay();
            if (target) {
                fireDrop(activeCardEl, target, getState, onAction);
            }
            if (lastHover) lastHover.classList.remove('drop-hover');
            lastHover = null;
        }

        activeCardEl = null;
        moved = false;
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

function handleCardTap(cardEl, rootEl) {
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
```

- [ ] **Step 9.4: Run test, verify pass**

```bash
npm test -- tests/input.test.js
```

Expected: all 3 tests pass.

---

## Task 10: Wire `main.js` to the new UI

Replace canvas UI initialization with DOM render + input wiring. Remove Auto-Duel. Move Royal ID display out of the gameplay HUD (the lobby already shows it via `lobby-id-display`, so no replacement needed in-game).

**Files:**
- Modify: `src/index.html`
- Modify: `src/js/main.js`
- Modify: `src/js/engine.js` (only to expose a dispatcher helper, see Step 10.3)

- [ ] **Step 10.1: Update `src/index.html`**

Replace the `<div id="game-container" class="hidden">…</div>` block. Find:

```html
    <!-- Game UI -->
    <div id="game-container" class="hidden">
        <div id="turn-banner">CLAIM YOUR LAND</div>

        <div id="ui-layer">
            <div class="left-ui">
                <div class="badge" style="background: #2a4a7f;">Vassal Treasury: <span id="opp-bank-total">0</span> Gold</div>
                <div class="badge" style="background: #8b2020;">Vassal Kingdoms: <span id="opp-sets">0</span>/3</div>
            </div>
            <div class="right-ui">
                <div class="badge" id="peer-id-display">Royal ID: ...</div>
                <div class="badge" id="action-tracker">Royal Decrees: 3</div>
                <div class="badge" style="background: #2d5a27;">My Treasury: <span id="my-bank-total">0</span> Gold</div>
                <div class="badge" style="background: #8b6914;">My Kingdom: <span id="my-sets">0</span>/3</div>
                <button id="btn-end-turn" class="badge btn" style="background: #1a1a1a; margin-top: 12px;">End Reign</button>
                <button id="btn-auto-play" class="badge btn" style="background: #d4af37; color: #000; margin-top: 4px;">Royal Auto-Duel</button>
            </div>
        </div>

        <canvas id="gameCanvas"></canvas>
    </div>
```

Replace with:

```html
    <!-- Game UI -->
    <div id="game-container" class="hidden">
        <div id="turn-banner">CLAIM YOUR LAND</div>
        <main id="game-root"></main>
    </div>
```

- [ ] **Step 10.2: Rewrite `src/js/main.js`**

Replace the entire file with:

```js
import { generateDeck } from './cards.js';
import {
    gameState,
    initGameState,
    drawCardFromDeck,
    executeAction,
    enumerateLegalActions,
    checkWinner,
    endTurn as engineEndTurn
} from './engine.js';
import { render } from './render.js';
import { attachInput } from './input.js';
import { Multiplayer } from './multiplayer.js';

let lobbyPlayers = [];
let inputAttached = false;

function init() {
    document.getElementById('lobby-id-display').textContent = 'Connecting...';

    Multiplayer.init((id) => {
        document.getElementById('lobby-id-display').textContent = id;
    });
    Multiplayer.onDataReceived = handlePeerData;

    document.getElementById('btn-copy-id').onclick = () => {
        navigator.clipboard.writeText(Multiplayer.peerId);
    };

    document.getElementById('btn-create-game').onclick = () => openLobby(true);
    document.getElementById('btn-join-game').onclick = () => openLobby(false);
    document.getElementById('btn-add-bot').onclick = addBotToLobby;
    document.getElementById('btn-leave-lobby').onclick = leaveLobby;
    document.getElementById('btn-start-game').onclick = startGameFromLobby;
}

function openLobby(isHost) {
    document.getElementById('splash-container').classList.add('hidden');
    document.getElementById('lobby-container').classList.remove('hidden');
    const name = document.getElementById(isHost ? 'player-name-create' : 'player-name-join').value || 'Lord Local';
    lobbyPlayers = [{ id: 0, name, isBot: false }];
    updateLobbyUI();
}

function updateLobbyUI() {
    const slots = document.getElementById('lobby-slots');
    slots.innerHTML = '';
    for (let i = 0; i < 5; i++) {
        const p = lobbyPlayers[i];
        const slot = document.createElement('div');
        slot.className = 'lobby-slot' + (p ? '' : ' empty');
        slot.innerHTML = p ? `<span>${p.name}</span> <span class="status">Ready</span>` : `<span>Empty Slot</span>`;
        slots.appendChild(slot);
    }
    document.getElementById('btn-start-game').disabled = lobbyPlayers.length < 2;
    document.getElementById('btn-add-bot').disabled = lobbyPlayers.length >= 5;
}

function addBotToLobby() {
    if (lobbyPlayers.length >= 5) return;
    lobbyPlayers.push({ id: lobbyPlayers.length, name: `Bot ${lobbyPlayers.length}`, isBot: true });
    updateLobbyUI();
}

function leaveLobby() {
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('splash-container').classList.remove('hidden');
    lobbyPlayers = [];
}

function startGameFromLobby() {
    document.getElementById('lobby-container').classList.add('hidden');
    document.getElementById('game-container').classList.remove('hidden');
    startLocalGame(lobbyPlayers.length);
}

function startLocalGame(playerCount = 2) {
    const rawDeck = generateDeck();
    const entities = rawDeck.map(card => ({ data: card, zone: 'deck', owner: null }));
    initGameState([...entities], playerCount);

    for (let i = 0; i < playerCount; i++) {
        for (let c = 0; c < 5; c++) drawCardFromDeck(i);
    }
    gameState.turn = 0;
    gameState.actionsLeft = 3;

    const root = document.getElementById('game-root');
    if (!inputAttached) {
        attachInput(root, () => gameState, handleLocalAction);
        root.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="end-turn"]')) onEndTurn();
        });
        inputAttached = true;
    }

    update();
}

function update() {
    const root = document.getElementById('game-root');
    render(root, gameState);

    const winnerId = checkWinner();
    if (winnerId !== null && !gameState._gameOver) {
        gameState._gameOver = true;
        showBanner(winnerId === gameState.localPlayerId ? 'THE CROWN IS YOURS!' : 'YOUR KINGDOM HAS FALLEN');
    }
}

function handleLocalAction(action) {
    if (gameState.turn !== gameState.localPlayerId) return;
    executeAction(action, gameState.localPlayerId);
    if (Multiplayer.conn) Multiplayer.sendData({ type: 'action', action });
    update();
}

function onEndTurn() {
    const ok = engineEndTurn();
    if (ok) update();
    else update(); // Render the forced-discard prompt
    if (gameState.turn === 1 && !Multiplayer.conn) setTimeout(playBotTurn, 800);
}

function playBotTurn() {
    const botId = gameState.turn;
    if (botId === gameState.localPlayerId) return;
    const actions = enumerateLegalActions(botId);
    const nonEnd = actions.filter(a => a.type !== 'end-turn');
    if (nonEnd.length > 0) {
        executeAction(nonEnd[Math.floor(Math.random() * nonEnd.length)], botId);
        update();
        setTimeout(playBotTurn, 600);
    } else {
        engineEndTurn();
        update();
    }
}

function handlePeerData(data) {
    if (data.type === 'action') {
        executeAction(data.action, data.playerId ?? 1);
        update();
    }
}

function showBanner(text) {
    const b = document.getElementById('turn-banner');
    b.textContent = text;
    b.style.opacity = 1;
    setTimeout(() => (b.style.opacity = 0), 1500);
}

init();
```

> **Note:** This rewrite assumes `executeAction(action, playerId)` exists in `engine.js`. Verify in Step 10.3.

- [ ] **Step 10.3: Verify `executeAction` signature in `engine.js`**

```bash
grep -n "export function executeAction" /Users/john.watkins/Downloads/stealr/src/js/engine.js
```

Expected: a line like `export function executeAction(action, playerId)`. If the signature differs, adapt the calls in `main.js` (Step 10.2) and document the actual signature here before continuing.

- [ ] **Step 10.4: Smoke check unit tests still pass**

```bash
cd /Users/john.watkins/Downloads/stealr && npm test
```

Expected: all tests pass (render, input, dropvalid, smoke). `main.js` is not unit-tested.

- [ ] **Step 10.5: Manual launch**

```bash
cd /Users/john.watkins/Downloads/stealr && python3 -m http.server 8000 --directory src
```

Open `http://localhost:8000/` in a phone-sized viewport (Chrome DevTools → iPhone 12 Pro). Steps to verify:
1. Splash → "Forge Realm" → lobby
2. Add 2 bots → "Start Reign"
3. Top bar shows `0g 0/3 Actions: 3 [End Turn] [☰]`
4. Two opponent rows render with `Lord 1` and `Lord 2` headers
5. Hand shows 5 cards in a horizontally-scrolling strip at the bottom
6. Tap a money card in your hand → highlight ring
7. Tap your bank → action fires, card moves to bank, total updates
8. Drag a property card to your kingdom → drop highlight appears, releasing in target plays the card
9. Tap End Turn → bot plays automatically

Kill the server when done:

```bash
# Ctrl-C the python process; or:
pkill -f "python3 -m http.server"
```

---

## Task 11: Remove legacy canvas code and stale tests

**Files:**
- Delete: `src/js/ui.js`
- Delete: stale Playwright canvas tests in `ui-test/`
- Modify: `src/css/styles.css` — remove the `#ui-layer, #gameCanvas { display: none }` safety net (no longer referenced)

- [ ] **Step 11.1: Delete canvas renderer**

```bash
rm /Users/john.watkins/Downloads/stealr/src/js/ui.js
```

- [ ] **Step 11.2: Delete stale Playwright canvas tests**

```bash
cd /Users/john.watkins/Downloads/stealr/ui-test && rm -f \
    test-mobile.js test-mobile-improved.js test-overlap-debug.js test-multiplayer-mobile.js \
    test-bank.js test-icons.js test-layout-validation.js test-scale.js test-toast.js \
    test-ui-showcase.js layout-test-results.json test-results.json
rm -rf /Users/john.watkins/Downloads/stealr/ui-test/screenshots
```

- [ ] **Step 11.3: Remove the safety-net CSS rule**

In `src/css/styles.css`, delete:

```css
#ui-layer,
#gameCanvas {
    display: none !important;
}
```

- [ ] **Step 11.4: Verify everything still runs**

```bash
cd /Users/john.watkins/Downloads/stealr && npm test
```

Expected: all unit tests pass.

```bash
cd /Users/john.watkins/Downloads/stealr && python3 -m http.server 8000 --directory src
```

Open in a phone viewport and replay the smoke flow from Task 10 Step 10.5. Kill the server.

---

## Task 12: Multi-opponent rendering smoke test

Verify the layout holds with 2, 3, and 4 opponents (5 total players including the local).

- [ ] **Step 12.1: 2-player game**

Lobby → 1 bot → Start. Expected: 1 opponent row. Layout fits in portrait without scroll except in the hand.

- [ ] **Step 12.2: 3-player game**

Lobby → 2 bots → Start. Expected: 2 opponent rows.

- [ ] **Step 12.3: 4-player game**

Lobby → 3 bots → Start. Expected: 3 opponent rows. Vertical scroll may begin if many properties land.

- [ ] **Step 12.4: 5-player game**

Lobby → 4 bots → Start. Expected: 4 opponent rows. Page scrolls vertically; sticky top bar stays visible.

- [ ] **Step 12.5: Forced discard flow**

Trigger a forced discard (end turn with 8+ cards in hand): the End Turn button must disable, the actions readout should switch to a discard prompt, and only `discard` should be a valid drop target. Verify by attempting to drop on bank/kingdom — no drop highlight should appear.

---

## Task 13: Close out bd issue

- [ ] **Step 13.1:** Mark `stealr-7` closed with a final summary:

```bash
bd close stealr-7 --comment "Mobile DOM redesign shipped. ui.js (canvas) removed; render.js + input.js + dropvalid.js take over. Layout works across 2-5 players in portrait and landscape. See docs/superpowers/plans/2026-05-13-mobile-dom-redesign.md for the task breakdown."
```

If the `--comment` flag doesn't exist on this `bd` version, use:

```bash
bd close stealr-7
```

---

## Spec-coverage self-review

- Top bar with Actions: N — Task 4 ✓
- Royal ID UUID removed from HUD — Task 10 (HTML replacement drops `#peer-id-display`) ✓
- Auto-Duel removed — Task 10 (button + handler gone in rewrite) ✓
- Opponent rows with flex-wrap color stacks — Task 5 + Task 8 CSS ✓
- Opponent bank folded into header chip — Task 5 ✓
- Shared zone strip (deck/discard/decrees) — Task 7 ✓
- Your bank as separate compact drop zone — Task 6 ✓
- Your kingdom with per-color drop zones — Task 6 ✓
- Hand h-scroll with End Turn bottom-right — Task 7 + Task 8 CSS ✓
- Drag-and-drop via Pointer Events — Task 9 ✓
- Tap-to-select fallback — Task 9 ✓
- Shared drop-validation predicate — Task 2 ✓
- `touch-action: none` on draggables — Task 8 CSS ✓
- `elementFromPoint` for drop detection — Task 9 ✓
- Desktop breakpoint (1.3x sizes) — Task 8 CSS ✓
- Canvas removal — Task 11 ✓
- 2-5 player verification — Task 12 ✓
- bd tracking — Task 13 ✓
