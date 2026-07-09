// UI scenario tests. Drives the browser via CDP to verify UI flows that
// the engine unit tests can't reach (modals, mustDiscard prompt, auto-end,
// flashHint banner).
//
// Usage: node ui-test/scenarios.js [scenario-number]
// Requires Chrome listening on :9222 and dev server on :8000.

const { chromium } = require('playwright');

const URL = 'http://localhost:8000/';
const ARG = process.argv[2];

async function newPage(browser) {
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${URL}?bust=${Date.now()}`, { waitUntil: 'networkidle' });
    return page;
}

async function bootSolo(page) {
    await page.waitForSelector('#btn-solo-game', { state: 'attached' });
    await page.evaluate(() => document.getElementById('btn-solo-game').click());
    await page.waitForSelector('#game-container:not(.hidden)');
    await page.waitForFunction(() => !!window.__game);
}

// Inject a deterministic state. Returns a getter for the live state shape.
async function setGameState(page, mutator) {
    await page.evaluate((mutator) => {
        const fn = new Function('s', mutator);
        fn(window.__game.state());
    }, mutator.toString().replace(/^[^{]*{/, '').replace(/}[^}]*$/, ''));
}

async function getState(page) {
    return page.evaluate(() => {
        const s = window.__game.state();
        return {
            turn: s.turn,
            actionsLeft: s.actionsLeft,
            mustDiscard: s.mustDiscard,
            localPlayerId: s.localPlayerId,
            pendingAction: s.pendingAction ? {
                attackerId: s.pendingAction.attackerId,
                effect: s.pendingAction.card.data.effect,
            } : null,
            players: s.players.map(p => ({
                id: p.id,
                handLen: p.hand.length,
                bankLen: p.bank.length,
                bankTotal: p.bank.reduce((sum, c) => sum + (c.data.value || 0), 0),
                propTotal: Object.values(p.properties || {})
                    .flat().filter(c => !(c.data.isRainbow || c.data.value === 0))
                    .reduce((sum, c) => sum + (c.data.value || 0), 0),
            })),
            deckLen: s.deck.length,
            discardLen: s.discard.length,
        };
    });
}

// --- scenarios -----------------------------------------------------------

async function scenario1_brokeDebtorNoPicker(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    // Strip local of all assets. Have bot 1 propose Tax Collector against local.
    await page.evaluate(() => {
        const s = window.__game.state();
        s.players[0].bank = [];
        s.players[0].properties = {};
        // Build a Tax Collector and have bot 1 propose against local.
        const tc = { data: { id: 'tc-test', name: 'TAX COLLECTOR', type: 'ACTION', effect: 'debt_collector', value: 3 }, zone: 'hand', owner: 1 };
        s.players[1].hand.push(tc);
        window.__game.propose(tc, 1, 0, {});
    });
    // Local concedes
    await page.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    await page.waitForTimeout(150);
    const modalKind = await page.evaluate(() => {
        const m = document.getElementById('info-modal');
        return m ? m.dataset.modalKind : null;
    });
    const state = await getState(page);
    await page.close();
    return {
        ok: modalKind !== 'payment' && state.pendingAction === null,
        details: `modalKind=${modalKind} pendingAction=${state.pendingAction}`,
    };
}

async function scenario2_paymentPickerShortfall(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    // Local: 2g bank, 1g property. Owes 5g. No picker — auto-surrender all.
    await page.evaluate(() => {
        const s = window.__game.state();
        s.players[0].bank = [{ data: { id: 'm2', name: '2g', type: 'MONEY', value: 2 }, zone: 'bank', owner: 0 }];
        s.players[0].properties = {
            BROWN: [{ data: { id: 'pb', name: 'Mediterranean', type: 'PROPERTY', value: 1, colorKey: 'BROWN' }, zone: 'board', owner: 0, currentColor: 'BROWN' }],
        };
        const tc = { data: { id: 'tc-2', name: 'TAX COLLECTOR', type: 'ACTION', effect: 'debt_collector', value: 3 }, zone: 'hand', owner: 1 };
        s.players[1].hand.push(tc);
        window.__game.propose(tc, 1, 0, {});
    });
    await page.evaluate(() => window.__game.dispatch({ type: 'concede' }));
    await page.waitForTimeout(250);
    const modalOpen = await page.evaluate(() => {
        const m = document.getElementById('info-modal');
        return m && !m.classList.contains('hidden') && m.dataset.modalKind === 'payment';
    });
    const state = await getState(page);
    await page.close();
    // Picker must NOT open. All assets transferred. Attacker received 2g (bank
    // bill goes to bank; property card lands in attacker's properties).
    const ok = !modalOpen &&
        state.players[0].bankTotal === 0 &&
        state.players[0].propTotal === 0 &&
        state.players[1].bankTotal === 2;
    return { ok, details: `pickerOpen=${modalOpen} localBank=${state.players[0].bankTotal} localProp=${state.players[0].propTotal} attackerBank=${state.players[1].bankTotal}` };
}

async function scenario3_mustDiscardToDeck(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    // Stuff local hand to 9 cards then end-turn. Expect mustDiscard prompt.
    await page.evaluate(() => {
        const s = window.__game.state();
        // Pad hand to 9 with junk money cards.
        const need = 9 - s.players[0].hand.length;
        for (let i = 0; i < need; i++) {
            s.players[0].hand.push({ data: { id: `pad-${i}`, name: '1g', type: 'MONEY', value: 1 }, zone: 'hand', owner: 0 });
        }
        s.actionsLeft = 0;
        // Reset auto-end guard so update() can fire end-turn for us
        delete s._autoEnding;
    });
    // Trigger update() which will auto-end -> mustDiscard.
    await page.evaluate(() => window.__game.update());
    await page.waitForFunction(() => {
        const m = document.getElementById('info-modal');
        return m && m.dataset.modalKind === 'must-discard';
    }, null, { timeout: 1500 });
    const before = await getState(page);
    // Discard 2 cards via dispatch.
    await page.evaluate(() => {
        const s = window.__game.state();
        const c1 = s.players[0].hand[0];
        window.__game.dispatch({ type: 'discard', cardId: c1.data.id });
    });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
        const s = window.__game.state();
        const c2 = s.players[0].hand[0];
        window.__game.dispatch({ type: 'discard', cardId: c2.data.id });
    });
    await page.waitForTimeout(200);
    const after = await getState(page);
    await page.close();
    // 2 cards unshift onto deck (bottom), then turn advances and next player
    // pops 2 off the top. Net deck size unchanged. Critical assertion: discard
    // pile is NOT used for end-turn discards.
    const ok = after.mustDiscard === 0 &&
        after.players[0].handLen === before.players[0].handLen - 2 &&
        after.discardLen === before.discardLen;
    return { ok, details: `mustDiscard=${after.mustDiscard} hand=${after.players[0].handLen} deck=${after.deckLen}(was ${before.deckLen}) discard=${after.discardLen}(was ${before.discardLen})` };
}

async function scenario4_autoEndOnZeroActions(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    // Force actionsLeft to 1 and a clean state. Bank a card -> actionsLeft=0 -> auto-end.
    await page.evaluate(() => {
        const s = window.__game.state();
        s.actionsLeft = 1;
        // Make sure hand has at least one card to bank.
        if (s.players[0].hand.length === 0) {
            s.players[0].hand.push({ data: { id: 'late', name: '1g', type: 'MONEY', value: 1 }, zone: 'hand', owner: 0 });
        }
    });
    const turnBefore = await page.evaluate(() => window.__game.state().turn);
    await page.evaluate(() => {
        const s = window.__game.state();
        const c = s.players[0].hand[0];
        window.__game.dispatch({ type: 'play', cardId: c.data.id, zone: 'bank' });
    });
    // Wait for auto-end to fire turn over to bot.
    await page.waitForFunction((t) => window.__game.state().turn !== t, turnBefore, { timeout: 2000 });
    const after = await getState(page);
    await page.close();
    const ok = after.turn !== turnBefore;
    return { ok, details: `turn went ${turnBefore} -> ${after.turn}` };
}

async function scenario5_actionFeedbackBanner(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    // Have local play Tax Collector vs bot 1 who has 3g exactly. After resolution,
    // the flashHint banner should mention "paid you 3g".
    await page.evaluate(() => {
        const s = window.__game.state();
        s.players[1].bank = [{ data: { id: 'tg', name: '3g', type: 'MONEY', value: 3 }, zone: 'bank', owner: 1 }];
        const tc = { data: { id: 'tc-fb', name: 'TAX COLLECTOR', type: 'ACTION', effect: 'debt_collector', value: 3 }, zone: 'hand', owner: 0 };
        s.players[0].hand.push(tc);
        window.__game.propose(tc, 0, 1, {});
    });
    // Bot reaction will fire automatically. Wait for hint text.
    let bannerText = '';
    try {
        await page.waitForFunction(() => {
            const a = document.getElementById('turn-banner');
            const b = document.getElementById('hint-banner');
            const txt = ((a && a.textContent) || '') + ' ' + ((b && b.textContent) || '');
            return /paid you 3g/i.test(txt);
        }, null, { timeout: 3500 });
        bannerText = await page.evaluate(() => {
            const a = document.getElementById('turn-banner');
            const b = document.getElementById('hint-banner');
            return ((a && a.textContent) || '') + ' ' + ((b && b.textContent) || '');
        });
    } catch (e) {
        bannerText = await page.evaluate(() => {
            const a = document.getElementById('turn-banner');
            const b = document.getElementById('hint-banner');
            return ((a && a.textContent) || '') + ' ' + ((b && b.textContent) || '');
        });
    }
    await page.close();
    const ok = /paid you 3g/i.test(bannerText);
    return { ok, details: `banner=${JSON.stringify(bannerText)}` };
}

async function scenario6_brokeOpponentBanner(browser) {
    const page = await newPage(browser);
    await bootSolo(page);
    await page.evaluate(() => {
        const s = window.__game.state();
        s.players[1].bank = [];
        s.players[1].properties = {};
        const tc = { data: { id: 'tc-broke', name: 'TAX COLLECTOR', type: 'ACTION', effect: 'debt_collector', value: 3 }, zone: 'hand', owner: 0 };
        s.players[0].hand.push(tc);
        window.__game.propose(tc, 0, 1, {});
    });
    let bannerText = '';
    const readBoth = () => page.evaluate(() => {
        const a = document.getElementById('turn-banner');
        const b = document.getElementById('hint-banner');
        return ((a && a.textContent) || '') + ' ' + ((b && b.textContent) || '');
    });
    try {
        await page.waitForFunction(() => {
            const a = document.getElementById('turn-banner');
            const b = document.getElementById('hint-banner');
            const txt = ((a && a.textContent) || '') + ' ' + ((b && b.textContent) || '');
            return /nothing to pay/i.test(txt);
        }, null, { timeout: 3500 });
        bannerText = await readBoth();
    } catch (e) {
        bannerText = await readBoth();
    }
    await page.close();
    const ok = /nothing to pay/i.test(bannerText);
    return { ok, details: `banner=${JSON.stringify(bannerText)}` };
}

// --- runner --------------------------------------------------------------

const ALL = [
    { name: 'broke debtor: no payment picker, resolves silently', fn: scenario1_brokeDebtorNoPicker },
    { name: 'shortfall auto-pay: no picker, all assets transferred', fn: scenario2_paymentPickerShortfall },
    { name: 'mustDiscard: cards go to BOTTOM of draw pile, not discard', fn: scenario3_mustDiscardToDeck },
    { name: 'auto-end turn when actions hit zero', fn: scenario4_autoEndOnZeroActions },
    { name: 'flashHint shows "paid you Xg" after Tax Collector', fn: scenario5_actionFeedbackBanner },
    { name: 'flashHint shows "nothing to pay" against broke opponent', fn: scenario6_brokeOpponentBanner },
];

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const results = [];
    const targets = ARG ? [ALL[Number(ARG) - 1]] : ALL;
    for (const t of targets) {
        const start = Date.now();
        let r;
        try {
            r = await t.fn(browser);
        } catch (e) {
            r = { ok: false, details: `THREW: ${e.message}` };
        }
        const dur = Date.now() - start;
        results.push({ name: t.name, ok: r.ok, details: r.details, dur });
        console.log(`${r.ok ? 'PASS' : 'FAIL'} (${dur}ms) ${t.name}`);
        if (!r.ok) console.log(`        ${r.details}`);
    }
    console.log('');
    console.log('=== summary ===');
    let pass = 0;
    results.forEach((r, i) => {
        if (r.ok) pass++;
        console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${r.name} (${r.dur}ms)`);
    });
    console.log(`${pass}/${results.length} scenarios passing`);
    process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
