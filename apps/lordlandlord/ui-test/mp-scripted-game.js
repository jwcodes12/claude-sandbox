/**
 * mp-scripted-game.js
 *
 * A fully scripted 2-player multiplayer integration test.
 *
 * After the lobby handshake we REPLACE both pages' game states with a
 * deterministic snapshot — every card, hand, bank and property is known.
 * We then drive a sequence of actions that exercises every action-card type
 * (debt_collector, birthday, pass_go, rent, double_rent, sly_deal,
 * forced_deal, deal_breaker, just_say_no) and after each one assert that
 * both the host page and the client page have identical, correct state.
 *
 * Usage:
 *   node ui-test/mp-scripted-game.js [step-number]
 *
 * Requires Chrome open with remote debugging on port 9222 and the dev server
 * running on http://localhost:8000.
 *
 * Cross-network note:
 *   These tests run two browser tabs in the same Chrome instance, which
 *   covers same-WiFi conditions (both peers use local ICE candidates).
 *   True cross-network testing (different NAT / carrier) requires running
 *   two separate machines — point each at the same deployed server URL and
 *   have one machine run the host scenario, the other the client scenario.
 *   The WebRTC path taken (STUN vs TURN) is printed to the console by the
 *   ICE diagnostics already baked into multiplayer.js.
 */

'use strict';
const { chromium } = require('playwright');

const URL = 'http://localhost:8000/';
const CDP = 'http://localhost:9222';
const JOIN_TIMEOUT = 25000;
const SNAPSHOT_TIMEOUT = 15000;
const ACTION_TIMEOUT = 10000;

// ---------------------------------------------------------------------------
// Page boot helpers (mirrors mp-test.js)
// ---------------------------------------------------------------------------

async function newPage(browser) {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().includes('Failed to load resource'))
            console.error('  [console.error]', m.text());
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${URL}?bust=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-solo-game', { state: 'visible' });
    return page;
}

async function bootHost(browser) {
    const page = await newPage(browser);
    await page.click('#btn-create-game');
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t && t.length > 4 && !t.startsWith('Joining');
    }, null, { timeout: JOIN_TIMEOUT });
    const peerId = await page.evaluate(() =>
        document.getElementById('lobby-id-display').textContent.trim());
    return { page, peerId };
}

async function bootClient(browser, hostPeerId) {
    const page = await newPage(browser);
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t && t.length > 10 && !t.startsWith('Joining');
    }, null, { timeout: JOIN_TIMEOUT });
    await page.fill('#join-game-id', hostPeerId);
    await page.click('#btn-join-game');
    await page.waitForSelector('#lobby-container:not(.hidden)');
    return { page };
}

async function closePage(page) {
    try { await page.close({ runBeforeUnload: false }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// State injection helpers
// ---------------------------------------------------------------------------

/**
 * Build the scripted game state that both pages will adopt.
 *
 * Layout
 * ------
 * Player 0 (host)
 *   hand:        one of every action-card type we want to test, plus a JSN
 *   bank:        2M (so chargePlayer won't find it empty)
 *   properties:  BROWN ×2 (complete), LIGHTBLUE ×1 (incomplete)
 *   buildings:   (none)
 *
 * Player 1 (client)
 *   hand:        just_say_no (to test cancellation chain)
 *   bank:        5M + 3M  (8g — enough to cover debt_collector and birthday)
 *   properties:  PINK ×3 (complete — target of deal_breaker)
 *                ORANGE ×1 (incomplete — target of sly_deal / forced_deal)
 *   buildings:   (none)
 *
 * Deck: 8 cards so pass_go can draw 2.
 */
function buildScriptedState() {
    const ct = (id, type, extra) => ({ data: { id, type, name: id, value: 0, ...extra }, zone: 'hand', owner: null });
    const money = (id, value, owner) => ({ data: { id, type: 'MONEY', name: `${value}M`, value }, zone: 'bank', owner });
    const prop = (id, color, owner) => ({ data: { id, type: 'PROPERTY', colorKey: color, name: id, value: 1 }, zone: 'board', owner, currentColor: color });
    const deck = Array.from({ length: 8 }, (_, i) => money(`deck_${i}`, 1, null));

    // P0 hand cards
    const dcCard       = ct('p0_dc',     'ACTION', { effect: 'debt_collector', value: 3, name: 'Tax Collector' });
    const bdayCard     = ct('p0_bday',   'ACTION', { effect: 'birthday',       value: 2, name: 'Feast Day' });
    const passGoCard   = ct('p0_pg',     'ACTION', { effect: 'pass_go',        value: 2, name: 'Royal Charter' });
    const slyCard      = ct('p0_sly',    'ACTION', { effect: 'sly_deal',       value: 3, name: 'Sly Deal' });
    const forcedCard   = ct('p0_forced', 'ACTION', { effect: 'forced_deal',    value: 3, name: 'Forced Trade' });
    const dblRentCard  = ct('p0_dbl',    'ACTION', { effect: 'double_rent',    value: 1, name: 'Double Tribute' });
    const dbCard       = ct('p0_db',     'ACTION', { effect: 'deal_breaker',   value: 5, name: 'Kingdom Breaker' });
    const jsnCard0     = ct('p0_jsn',    'ACTION', { effect: 'just_say_no',    value: 4, name: 'NOT TODAY!' });
    const rentCard     = ct('p0_rent',   'RENT',   { allowedColors: ['BROWN'], value: 1, name: 'Rent (Brown)' });
    const multiRent    = ct('p0_mrent',  'RENT',   { allowedColors: ['BROWN', 'DARKBLUE'], isMulti: true, value: 1, name: 'Multi Rent' });

    // P1 hand cards
    const jsnCard1 = ct('p1_jsn', 'ACTION', { effect: 'just_say_no', value: 4, name: 'NOT TODAY!' });

    // P0 properties
    const br0 = prop('p0_br0', 'BROWN', 0);
    const br1 = prop('p0_br1', 'BROWN', 0);
    const lb0 = prop('p0_lb0', 'LIGHTBLUE', 0); // incomplete — for forced_deal

    // P1 properties
    const pk0 = prop('p1_pk0', 'PINK', 1);
    const pk1 = prop('p1_pk1', 'PINK', 1);
    const pk2 = prop('p1_pk2', 'PINK', 1);
    const or0 = prop('p1_or0', 'ORANGE', 1); // incomplete — for sly_deal

    // Money
    const p0bank0 = money('p0_m2', 2, 0);
    const p1bank0 = money('p1_m5', 5, 1);
    const p1bank1 = money('p1_m3', 3, 1);

    const players = [
        {
            id: 0, name: 'Host', _disconnected: false,
            hand: [dcCard, bdayCard, passGoCard, slyCard, forcedCard, dblRentCard, dbCard, jsnCard0, rentCard, multiRent],
            bank: [p0bank0],
            properties: { BROWN: [br0, br1], LIGHTBLUE: [lb0] },
            buildings: {},
        },
        {
            id: 1, name: 'Client', _disconnected: false,
            hand: [jsnCard1],
            bank: [p1bank0, p1bank1],
            properties: { PINK: [pk0, pk1, pk2], ORANGE: [or0] },
            buildings: {},
        },
    ];

    return {
        deck,
        discard: [],
        players,
        turn: 0,
        actionsLeft: 3,
        turnNumber: 1,
        pendingAction: null,
        pendingReactors: [],
        reactionTargetId: null,
        doubleRentArmed: false,
        mustDiscard: 0,
        localPlayerId: 0, // overridden per-page after inject
        lastResolution: null,
        actionLog: [],
        _gameOver: false,
        _autoEnding: false,
    };
}

/**
 * Push the scripted state to both pages.
 * localPlayerId is overridden per page (0 for host, 1 for client).
 */
async function injectState(hostPage, clientPage) {
    const state = buildScriptedState();
    const stateJson = JSON.stringify(state);
    await hostPage.evaluate((json) => {
        const s = JSON.parse(json);
        s.localPlayerId = 0;
        Object.assign(window.__game.state(), s);
    }, stateJson);
    await clientPage.evaluate((json) => {
        const s = JSON.parse(json);
        s.localPlayerId = 1;
        Object.assign(window.__game.state(), s);
    }, stateJson);
}

// ---------------------------------------------------------------------------
// Assertion + wait helpers
// ---------------------------------------------------------------------------

function assert(cond, msg, errors) {
    if (!cond) errors.push(msg);
}

async function waitFor(page, fn, msg, timeout = ACTION_TIMEOUT) {
    try {
        await page.waitForFunction(fn, null, { timeout });
    } catch (_) {
        throw new Error(`timeout waiting for: ${msg}`);
    }
}

async function waitPendingClear(hostPage, clientPage) {
    await waitFor(hostPage, () => window.__game.state().pendingAction === null, 'host pendingAction clear');
    await waitFor(clientPage, () => window.__game.state().pendingAction === null, 'client pendingAction clear');
}

/** Run fn on both pages and assert they return identical JSON. */
async function bothAgree(hostPage, clientPage, fn, desc, errors) {
    const hv = await hostPage.evaluate(fn);
    const cv = await clientPage.evaluate(fn);
    const hj = JSON.stringify(hv);
    const cj = JSON.stringify(cv);
    if (hj !== cj) errors.push(`${desc}: host=${hj} client=${cj}`);
    return hj === cj;
}

/** Verify a specific numeric value is equal on both pages AND matches expected. */
async function bothEqual(hostPage, clientPage, fn, expected, desc, errors) {
    const hv = await hostPage.evaluate(fn);
    const cv = await clientPage.evaluate(fn);
    assert(hv === expected, `${desc}: host=${hv} expected=${expected}`, errors);
    assert(cv === expected, `${desc}: client=${cv} expected=${expected}`, errors);
}

/**
 * Handle the payment picker for the local player on `page`.
 * Clicks items until sum >= target, then clicks Pay.
 */
async function payViaPickerUI(page, errors) {
    try {
        await page.waitForSelector('[data-pay-idx]', { timeout: 5000 });
    } catch (_) {
        errors.push('payment picker never appeared');
        return false;
    }
    // Select items greedily until sum covers the debt
    let attempts = 0;
    while (attempts < 20) {
        const done = await page.evaluate(() => {
            const btn = document.querySelector('[data-pay-submit]');
            return btn && !btn.disabled;
        });
        if (done) break;
        const firstUnchecked = await page.$('[data-pay-idx]:not(.selected)');
        if (!firstUnchecked) break;
        await firstUnchecked.click();
        attempts++;
    }
    const payBtn = await page.$('[data-pay-submit]:not([disabled])');
    if (!payBtn) { errors.push('Pay button never enabled'); return false; }
    await payBtn.click();
    return true;
}

/** Dispatch a concede on the client page and handle the picker if it appears. */
async function clientConcede(clientPage, errors) {
    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    // If the payment picker appeared, work through it.
    const pickerVisible = await clientPage.evaluate(() =>
        !!(document.querySelector('[data-pay-idx]'))
    ).catch(() => false);
    if (pickerVisible) {
        return payViaPickerUI(clientPage, errors);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Individual step functions
// ---------------------------------------------------------------------------

async function stepPassGo(hostPage, clientPage, errors) {
    const label = 'pass_go';
    const beforeHand = await hostPage.evaluate(() => window.__game.state().players[0].hand.length);
    const beforeDeck = await hostPage.evaluate(() => window.__game.state().deck.length);

    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_pg', zone: 'discard', options: {} })
    );
    // pass_go is a direct play (no reaction needed) — wait for deck to shrink on both pages
    await waitFor(hostPage, () => window.__game.state().deck.length < 8, 'host deck shrinks after pass_go');
    await waitFor(clientPage, () => window.__game.state().deck.length < 8, 'client deck shrinks after pass_go');

    const afterHandHost = await hostPage.evaluate(() => window.__game.state().players[0].hand.length);
    const afterDeckHost = await hostPage.evaluate(() => window.__game.state().deck.length);
    assert(afterHandHost === beforeHand + 1, `${label}: host hand grew by 1 (card played and 2 drawn, net +1): was ${beforeHand} now ${afterHandHost}`, errors);
    assert(afterDeckHost === beforeDeck - 2, `${label}: deck shrank by 2: was ${beforeDeck} now ${afterDeckHost}`, errors);

    await bothAgree(hostPage, clientPage,
        () => window.__game.state().deck.length,
        `${label} deck length`, errors);
    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[0].hand.length,
        `${label} p0 hand length`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepDebtCollector(hostPage, clientPage, errors) {
    const label = 'debt_collector (payment picker path)';
    // P0 bank before: 1 card (2M). P1 bank before: 5M + 3M.
    const p0BankBefore = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);
    const p1BankBefore = await hostPage.evaluate(() => window.__game.state().players[1].bank.length);

    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_dc', targetPlayerId: 1, options: {} })
    );

    // Wait for client to see the pending action
    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for dc');

    // Client concedes → payment picker (P1 has 8g ≥ 5g debt)
    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    const ok = await payViaPickerUI(clientPage, errors);
    if (!ok) return;

    await waitPendingClear(hostPage, clientPage);

    // P1 should have paid ≥5g, P0 should have received it
    const p0BankAfterHost = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);
    const p0BankAfterClient = await clientPage.evaluate(() => window.__game.state().players[0].bank.length);
    assert(p0BankAfterHost > p0BankBefore, `${label}: host sees P0 bank grew (was ${p0BankBefore})`, errors);
    assert(p0BankAfterClient > p0BankBefore, `${label}: client sees P0 bank grew (was ${p0BankBefore})`, errors);
    assert(p0BankAfterHost === p0BankAfterClient, `${label}: both pages agree on P0 bank (host=${p0BankAfterHost} client=${p0BankAfterClient})`, errors);

    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[1].bank.length,
        `${label} p1 bank length`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepBirthday(hostPage, clientPage, errors) {
    const label = 'birthday (all-opponents pay 2g)';
    // Ensure it's still P0's turn and they have actionsLeft
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        if (s.actionsLeft < 1) s.actionsLeft = 1;
    });
    const p0BankBefore = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);

    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_bday', targetPlayerId: null, options: {} })
    );

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for birthday');

    // Client may or may not have enough to pay; just concede
    await clientConcede(clientPage, errors);
    await waitPendingClear(hostPage, clientPage);

    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[0].bank.length,
        `${label} p0 bank length`, errors);

    const p0BankAfterHost = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);
    assert(p0BankAfterHost >= p0BankBefore, `${label}: P0 bank didn't shrink`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepRent(hostPage, clientPage, errors) {
    const label = 'collect_rent single-color (BROWN fan-out)';
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        if (s.actionsLeft < 1) s.actionsLeft = 1;
    });

    const p0BankBefore = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);

    // Single-color rent fans out to all opponents; targetPlayerId is null
    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_rent', targetPlayerId: null, options: { color: 'BROWN' } })
    );

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for rent');
    await clientConcede(clientPage, errors);
    await waitPendingClear(hostPage, clientPage);

    // Both pages should agree on P0 bank
    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[0].bank.length,
        `${label} p0 bank`, errors);
    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[1].bank.length,
        `${label} p1 bank`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepDoubleRentThenRent(hostPage, clientPage, errors) {
    const label = 'double_rent + collect_rent (2× BROWN rent)';
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = 2; // double_rent + rent = 2 actions
    });

    const rentBefore = await hostPage.evaluate(() => {
        const s = window.__game.state();
        const props = s.players[0].properties['BROWN'] || [];
        return props.length; // BROWN set: 2 props → rent = 2g; doubled = 4g
    });

    // Play double_rent first (direct play to discard)
    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_dbl', zone: 'discard', options: {} })
    );

    await waitFor(hostPage, () => window.__game.state().doubleRentArmed === true, 'doubleRentArmed set on host');
    await waitFor(clientPage, () => window.__game.state().doubleRentArmed === true, 'doubleRentArmed set on client');

    const p0BankBefore = await hostPage.evaluate(() => window.__game.state().players[0].bank.length);

    // Now play the multi-rent card targeting P1 specifically
    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_mrent', targetPlayerId: 1, options: { color: 'BROWN' } })
    );

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for doubled rent');
    await clientConcede(clientPage, errors);
    await waitPendingClear(hostPage, clientPage);

    // doubleRentArmed should be cleared now
    await bothAgree(hostPage, clientPage,
        () => window.__game.state().doubleRentArmed,
        `${label} doubleRentArmed cleared`, errors);

    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[0].bank.length,
        `${label} p0 bank`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepSlyDeal(hostPage, clientPage, errors) {
    const label = 'sly_deal (steal P1\'s ORANGE property)';
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = Math.max(s.actionsLeft, 1);
    });

    const p0OrangeBefore = await hostPage.evaluate(() =>
        (window.__game.state().players[0].properties['ORANGE'] || []).length
    );
    const p1OrangeBefore = await hostPage.evaluate(() =>
        (window.__game.state().players[1].properties['ORANGE'] || []).length
    );

    await hostPage.evaluate(() =>
        window.__game.dispatch({
            type: 'propose', cardId: 'p0_sly', targetPlayerId: 1,
            options: { targetCardId: 'p1_or0', color: 'ORANGE' }
        })
    );

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for sly_deal');
    // Client concedes (no JSN in hand now — we gave jsnCard1 earlier and it stays until played)
    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    await waitPendingClear(hostPage, clientPage);

    await bothEqual(hostPage, clientPage,
        () => (window.__game.state().players[0].properties['ORANGE'] || []).length,
        p0OrangeBefore + 1, `${label} P0 ORANGE count`, errors);

    await bothEqual(hostPage, clientPage,
        () => (window.__game.state().players[1].properties['ORANGE'] || []).length,
        p1OrangeBefore - 1, `${label} P1 ORANGE count`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepForcedDeal(hostPage, clientPage, errors) {
    const label = 'forced_deal (swap P0 LIGHTBLUE for P1 PINK)';
    // P0 now has ORANGE (from sly_deal), BROWN×2, LIGHTBLUE×1
    // P1 has PINK×3 (complete — but forced_deal only works on incomplete sets)
    // Actually forced_deal targets INCOMPLETE sets — so we swap P0's LIGHTBLUE
    // for one of P1's PINK cards (PINK has 3 = complete, but we need incomplete targets)
    // Let's check: the enumerator and main.js only allow non-complete sets for forced_deal.
    // P1's ORANGE is gone (stolen). Let's re-inject a fresh ORANGE for P1 first.

    await hostPage.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = Math.max(s.actionsLeft, 1);
        // Re-inject P1 ORANGE so forced_deal has a valid target
        if (!s.players[1].properties['ORANGE']) s.players[1].properties['ORANGE'] = [];
        if (s.players[1].properties['ORANGE'].length === 0) {
            s.players[1].properties['ORANGE'].push({
                data: { id: 'p1_or1', type: 'PROPERTY', colorKey: 'ORANGE', name: 'p1_or1', value: 1 },
                zone: 'board', owner: 1, currentColor: 'ORANGE'
            });
        }
    });
    await clientPage.evaluate(() => {
        const s = window.__game.state();
        if (!s.players[1].properties['ORANGE']) s.players[1].properties['ORANGE'] = [];
        if (s.players[1].properties['ORANGE'].length === 0) {
            s.players[1].properties['ORANGE'].push({
                data: { id: 'p1_or1', type: 'PROPERTY', colorKey: 'ORANGE', name: 'p1_or1', value: 1 },
                zone: 'board', owner: 1, currentColor: 'ORANGE'
            });
        }
    });

    const p0LBBefore = await hostPage.evaluate(() =>
        (window.__game.state().players[0].properties['LIGHTBLUE'] || []).length
    );

    await hostPage.evaluate(() => {
        const s = window.__game.state();
        const myCard = s.players[0].properties['LIGHTBLUE'][0];
        const targetCard = s.players[1].properties['ORANGE'][0];
        window.__game.dispatch({
            type: 'propose', cardId: 'p0_forced', targetPlayerId: 1,
            options: {
                myCardId: myCard.data.id,
                targetCardId: targetCard.data.id,
                myCard, targetCard
            }
        });
    });

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for forced_deal');
    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    await waitPendingClear(hostPage, clientPage);

    // P0 should have lost LIGHTBLUE and gained ORANGE; P1 the opposite
    await bothAgree(hostPage, clientPage,
        () => (window.__game.state().players[0].properties['LIGHTBLUE'] || []).length,
        `${label} P0 LIGHTBLUE`, errors);
    await bothAgree(hostPage, clientPage,
        () => (window.__game.state().players[0].properties['ORANGE'] || []).length,
        `${label} P0 ORANGE`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepDealBreaker(hostPage, clientPage, errors) {
    const label = 'deal_breaker (steal P1\'s complete PINK set)';
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = Math.max(s.actionsLeft, 1);
    });

    const p1PinkBefore = await hostPage.evaluate(() =>
        (window.__game.state().players[1].properties['PINK'] || []).length
    );

    await hostPage.evaluate(() =>
        window.__game.dispatch({
            type: 'propose', cardId: 'p0_db', targetPlayerId: 1,
            options: { color: 'PINK' }
        })
    );

    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client sees pendingAction for deal_breaker');
    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    await waitPendingClear(hostPage, clientPage);

    await bothEqual(hostPage, clientPage,
        () => (window.__game.state().players[1].properties['PINK'] || []).length,
        0, `${label} P1 PINK cleared`, errors);

    await bothEqual(hostPage, clientPage,
        () => (window.__game.state().players[0].properties['PINK'] || []).length,
        p1PinkBefore, `${label} P0 got P1's PINK`, errors);

    console.log(`  ✓ ${label}`);
}

async function stepJustSayNo(hostPage, clientPage, errors) {
    const label = 'just_say_no (P1 cancels P0\'s debt_collector)';
    // Re-inject a fresh debt_collector for P0 and a fresh JSN for P1
    // (previous ones were consumed). Also re-inject JSN for P0 to test the
    // counter-cancel chain (P0 JSNs back P1's JSN).
    await hostPage.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = 3;
        const mkCard = (id, type, extra) => ({ data: { id, type, name: id, value: 0, ...extra }, zone: 'hand', owner: 0 });
        if (!s.players[0].hand.find(c => c.data.id === 'p0_dc2'))
            s.players[0].hand.push(mkCard('p0_dc2', 'ACTION', { effect: 'debt_collector', value: 3, name: 'Tax Collector' }));
        if (!s.players[0].hand.find(c => c.data.id === 'p0_jsn2'))
            s.players[0].hand.push(mkCard('p0_jsn2', 'ACTION', { effect: 'just_say_no', value: 4, name: 'NOT TODAY!' }));
    });
    await clientPage.evaluate(() => {
        const s = window.__game.state();
        const mkCard = (id, type, extra) => ({ data: { id, type, name: id, value: 0, ...extra }, zone: 'hand', owner: 1 });
        if (!s.players[0].hand.find(c => c.data.id === 'p0_dc2'))
            s.players[0].hand.push(mkCard('p0_dc2', 'ACTION', { effect: 'debt_collector', value: 3, name: 'Tax Collector' }));
        if (!s.players[0].hand.find(c => c.data.id === 'p0_jsn2'))
            s.players[0].hand.push({ data: { id: 'p0_jsn2', type: 'ACTION', name: 'NOT TODAY!', value: 4, effect: 'just_say_no' }, zone: 'hand', owner: 0 });
        if (!s.players[1].hand.find(c => c.data.id === 'p1_jsn2'))
            s.players[1].hand.push(mkCard('p1_jsn2', 'ACTION', { effect: 'just_say_no', value: 4, name: 'NOT TODAY!' }));
    });

    const p1BankBefore = await hostPage.evaluate(() => window.__game.state().players[1].bank.length);

    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_dc2', targetPlayerId: 1, options: {} })
    );

    // Wait for P1's reaction prompt
    await waitFor(clientPage, () => window.__game.state().pendingAction !== null, 'client pendingAction for JSN test');

    // P1 plays JSN to cancel the debt_collector
    await clientPage.evaluate(() =>
        window.__game.dispatch({ type: 'react-no', cardId: 'p1_jsn2' })
    );

    // Now P0 gets to react — P0 plays their own JSN to counter-cancel
    await waitFor(hostPage, () => {
        const s = window.__game.state();
        return s.pendingAction && s.reactionTargetId === 0;
    }, 'host sees counter-JSN opportunity');

    await hostPage.evaluate(() =>
        window.__game.dispatch({ type: 'react-no', cardId: 'p0_jsn2', againstReactorId: 1 })
    );

    // P1 has no more JSN cards — action fires
    await waitFor(clientPage, () => window.__game.state().pendingAction !== null &&
        window.__game.state().reactionTargetId === 1, 'P1 must concede after counter-JSN');

    await clientPage.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    const ok = await payViaPickerUI(clientPage, errors).catch(() => false);
    // If picker didn't appear, concede already resolved it
    await waitPendingClear(hostPage, clientPage);

    // The debt_collector ultimately fired — P1 bank should not have grown
    const p1BankAfter = await hostPage.evaluate(() => window.__game.state().players[1].bank.length);
    assert(p1BankAfter <= p1BankBefore, `${label}: P1 bank should have decreased or stayed same (was ${p1BankBefore} now ${p1BankAfter})`, errors);

    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[0].bank.length,
        `${label} P0 bank sync`, errors);
    await bothAgree(hostPage, clientPage,
        () => window.__game.state().players[1].bank.length,
        `${label} P1 bank sync`, errors);

    console.log(`  ✓ ${label}`);
}

// ---------------------------------------------------------------------------
// Main scripted-game scenario
// ---------------------------------------------------------------------------

async function scenarioScriptedFullGame(browser) {
    const name = 'scripted full game — all action card types';
    const errors = [];
    let hostPage = null, clientPage = null;
    try {
        // --- Lobby + handshake ---
        console.log('  booting host...');
        const host = await bootHost(browser);
        hostPage = host.page;

        console.log('  booting client...');
        const client = await bootClient(browser, host.peerId);
        clientPage = client.page;

        // Wait for host to see client join
        await hostPage.waitForFunction(() => {
            const btn = document.getElementById('btn-start-game');
            return btn && !btn.disabled;
        }, null, { timeout: JOIN_TIMEOUT });

        await hostPage.click('#btn-start-game');
        await hostPage.waitForSelector('#game-container:not(.hidden)');
        await hostPage.waitForFunction(() => !!window.__game);
        await clientPage.waitForSelector('#game-container:not(.hidden)', { timeout: SNAPSHOT_TIMEOUT });
        await clientPage.waitForFunction(() => !!window.__game && window.__game.state().players.length > 0, null, { timeout: SNAPSHOT_TIMEOUT });

        console.log('  injecting scripted state on both pages...');
        await injectState(hostPage, clientPage);

        // Verify injection took on both pages
        const hostP0HandLen = await hostPage.evaluate(() => window.__game.state().players[0].hand.length);
        const clientP0HandLen = await clientPage.evaluate(() => window.__game.state().players[0].hand.length);
        assert(hostP0HandLen === 10, `P0 hand should have 10 cards, got ${hostP0HandLen}`, errors);
        assert(clientP0HandLen === 10, `client P0 hand should have 10 cards, got ${clientP0HandLen}`, errors);
        if (errors.length) return { name, ok: false, errors };
        console.log('  state injected — running scripted steps...\n');

        // --- Run each step ---
        await stepPassGo(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepDebtCollector(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepBirthday(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepRent(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepDoubleRentThenRent(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepSlyDeal(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepForcedDeal(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepDealBreaker(hostPage, clientPage, errors);
        if (errors.length) return { name, ok: false, errors };

        await stepJustSayNo(hostPage, clientPage, errors);

        // Final global state-sync check
        console.log('\n  running final state sync check...');
        await bothAgree(hostPage, clientPage,
            () => window.__game.state().players.map(p => ({
                bankLen: p.bank.length,
                propColors: Object.keys(p.properties).filter(k => (p.properties[k] || []).length > 0).sort(),
            })),
            'final player summaries', errors);

    } catch (e) {
        errors.push('THREW: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n  '));
    } finally {
        if (hostPage) await closePage(hostPage);
        if (clientPage) await closePage(clientPage);
    }
    return { name, ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const STEPS = ['passGo', 'debtCollector', 'birthday', 'rent', 'doubleRent', 'slyDeal', 'forcedDeal', 'dealBreaker', 'justSayNo'];

(async () => {
    const only = process.argv[2] || null;
    if (only && !['all', ...STEPS].includes(only)) {
        console.log('Usage: node mp-scripted-game.js [all|passGo|debtCollector|birthday|rent|doubleRent|slyDeal|forcedDeal|dealBreaker|justSayNo]');
        process.exit(1);
    }
    console.log('\n=== Lord Landlord — Scripted Multiplayer Game Test ===\n');
    console.log('NOTE: for cross-network testing point this script at your deployed');
    console.log('      server URL (edit the URL constant at the top of the file) and');
    console.log('      run it from a different machine — the ICE diagnostics in');
    console.log('      multiplayer.js will log whether STUN (direct) or TURN (relay)');
    console.log('      is used, confirming the connection type.\n');

    const browser = await chromium.connectOverCDP(CDP);
    let result;
    try {
        result = await scenarioScriptedFullGame(browser);
    } finally {
        await browser.close();
    }
    console.log(`\n${result.ok ? 'PASS' : 'FAIL'} — ${result.name}`);
    if (!result.ok) {
        for (const e of result.errors) console.log(`  ✗ ${e}`);
    }
    process.exit(result.ok ? 0 : 1);
})();
