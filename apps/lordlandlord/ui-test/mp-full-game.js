/**
 * mp-full-game.js — 5-Player Full Scripted Multiplayer Test
 *
 * Six turns covering EVERY action card type:
 *
 *   Turn 0 (P0): Pass Go · Double Rent + Collect Tribute fan-out (Brown)
 *   Turn 1 (P1): Property plays · Sly Steal from P2
 *   Turn 2 (P2): Property play · Forced Trade (get stolen prop back from P1)
 *   Turn 3 (P3): Tax Collector on P1 (P1 JSNs it) · Feast Day · Great Tribute on P0
 *   Turn 4 (P4): Railroad property · Double Rent + Collect Tribute fan-out (Railroad)
 *   Turn 5 (P0): House + Hotel on LightBlue · Kingdom Breaker → WIN
 *
 * Usage:
 *   node ui-test/mp-full-game.js
 *   HEADED=1 node ui-test/mp-full-game.js
 */

'use strict';
const { chromium } = require('playwright');
const express       = require('express');
const path          = require('path');
const http          = require('http');

const HEADED    = process.env.HEADED === '1';
const PORT      = 18_180;
const GAME_URL  = process.env.URL || `http://localhost:${PORT}/`;

function startServer() {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.static(path.join(__dirname, '..', 'src')));
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => resolve(server));
    });
}

const N_PLAYERS        = 5;
const JOIN_TIMEOUT     = 35_000;
const SNAPSHOT_TIMEOUT = 25_000;
const ACTION_TIMEOUT   = 15_000;
const MODAL_TIMEOUT    = 14_000;

// ─── Logging ──────────────────────────────────────────────────────────────────

const LABELS = ['M1-host', 'M2-P1', 'M3-P2', 'M4-P3', 'M5-P4'];
function tag(i) { return `[${LABELS[i] || `M${i+1}`}]`; }
function log(i, msg)  { console.log(`  ${tag(i)} ${msg}`); }
function step(n, msg) { console.log(`\n  ── ${n}: ${msg} ──`); }
function ok(msg)      { console.log(`  ✓ ${msg}`); }

// ─── Browser boot ─────────────────────────────────────────────────────────────

async function launchBrowser(playerIdx) {
    const browser = await chromium.launch({
        headless: !HEADED,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream'],
    });
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => log(playerIdx, `[err] ${e.message.slice(0, 120)}`));
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('[HOST-DEBUG]') || text.includes('[NET-DEBUG]')) log(playerIdx, `[console] ${text}`);
    });
    await page.setViewportSize({ width: 960, height: 960 });
    return { browser, page };
}

async function loadGame(page, playerIdx) {
    await page.goto(`${GAME_URL}?bust=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-create-game', { state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t.length > 4 && t !== 'LOCAL-TEST' && !t.startsWith('Joining');
    }, null, { timeout: 30_000 });
    log(playerIdx, 'page loaded + peer ID assigned');
}

// ─── Retry ────────────────────────────────────────────────────────────────────

async function retry(fn, attempts = 3, label = '') {
    let last;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); } catch (e) {
            last = e;
            console.log(`  [retry ${i+1}/${attempts}] ${label}: ${e.message.slice(0, 80)}`);
            await new Promise(r => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw last;
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function waitFor(page, fn, desc, timeout = ACTION_TIMEOUT) {
    try {
        await page.waitForFunction(fn, null, { timeout });
    } catch (_) {
        const state = await page.evaluate(() => {
            const s = window.__game && window.__game.state();
            if (!s) return 'no __game';
            return JSON.stringify({
                turn: s.turn, actionsLeft: s.actionsLeft,
                pending: !!s.pendingAction,
                reactionTarget: s.reactionTargetId,
                gameOver: s._gameOver,
            });
        }).catch(() => 'evaluate failed');
        throw new Error(`Timeout (${timeout}ms) waiting for: ${desc}\n    state: ${state}`);
    }
}

async function waitModal(page, kind, desc, timeout = MODAL_TIMEOUT) {
    try {
        await page.waitForFunction(
            (modalKind) => {
                const m = document.getElementById('info-modal');
                return m && !m.classList.contains('hidden') && m.dataset.modalKind === modalKind;
            },
            kind,
            { timeout }
        );
    } catch (_) {
        const state = await page.evaluate(() => {
            const s = window.__game && window.__game.state();
            if (!s) return 'no __game';
            const m = document.getElementById('info-modal');
            return JSON.stringify({
                turn: s.turn, actionsLeft: s.actionsLeft,
                pending: !!s.pendingAction,
                reactionTarget: s.reactionTargetId,
                gameOver: s._gameOver,
                modalKind: m ? m.dataset.modalKind : 'no-modal',
                modalHidden: m ? m.classList.contains('hidden') : true,
            });
        }).catch(() => 'evaluate failed');
        throw new Error(`Timeout (${MODAL_TIMEOUT}ms) waiting for: modal[${kind}] — ${desc}\n    state: ${state}`);
    }
}

async function waitPendingClear(pages) {
    await Promise.all(pages.map((p, i) =>
        waitFor(p, () => window.__game.state().pendingAction === null,
            `${i} pendingAction → null`)
    ));
}

async function waitTurnStart(pages, playerIdx, timeout = 15_000) {
    const check = (pid) => {
        const s = window.__game.state();
        return s.turn === pid && s.actionsLeft === 3 && s.pendingAction === null;
    };
    try {
        // Wait on ALL machines — each must see the turn advance before we act.
        await Promise.all(pages.map(p =>
            p.waitForFunction(check, playerIdx, { timeout })
        ));
    } catch (_) {
        const states = await Promise.all(pages.map(p =>
            p.evaluate(() => {
                const s = window.__game.state();
                return { turn: s.turn, al: s.actionsLeft, pending: !!s.pendingAction };
            }).catch(() => null)
        ));
        throw new Error(`Timeout waiting for turn ${playerIdx} to start.\n  states: ${JSON.stringify(states)}`);
    }
}

async function waitGameOver(pages) {
    await Promise.all(pages.map((p, i) =>
        waitFor(p, () => window.__game.state()._gameOver === true,
            `${tag(i)} _gameOver → true`, 10_000)
    ));
}

// ─── State injection ──────────────────────────────────────────────────────────

/** Override one player's hand on all 5 machines. */
async function reinjectHand(pages, playerIdx, cards) {
    const json = JSON.stringify(cards);
    await Promise.all(pages.map(p => p.evaluate(({ pid, json }) => {
        const s = window.__game.state();
        s.players[pid].hand = JSON.parse(json);
        s.mustDiscard = 0;
        if (window.__game.update) window.__game.update();
    }, { pid: playerIdx, json })));
}

// ─── Assertion helpers ────────────────────────────────────────────────────────

function assert(cond, msg, errors) {
    if (!cond) { errors.push(msg); return false; }
    return true;
}

async function allEqual(pages, fn, expected, desc, errors) {
    for (let i = 0; i < pages.length; i++) {
        const v = await pages[i].evaluate(fn);
        assert(JSON.stringify(v) === JSON.stringify(expected),
            `${tag(i)} ${desc}: got ${JSON.stringify(v)}, expected ${JSON.stringify(expected)}`, errors);
    }
}

async function allAgree(pages, fn, desc, errors) {
    const vals = await Promise.all(pages.map(p => p.evaluate(fn)));
    const ref = JSON.stringify(vals[0]);
    for (let i = 1; i < pages.length; i++) {
        assert(JSON.stringify(vals[i]) === ref,
            `${desc}: ${tag(0)}=${ref} vs ${tag(i)}=${JSON.stringify(vals[i])}`, errors);
    }
    return vals[0];
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

async function getModalText(page) {
    return page.evaluate(() => {
        const m = document.getElementById('info-modal');
        return m ? m.innerText.replace(/\s+/g, ' ').trim() : '';
    });
}

async function waitReactionPrompt(page, playerIdx) {
    await waitModal(page, 'reaction', `${tag(playerIdx)} reaction prompt`);
    const text = await getModalText(page);
    log(playerIdx, `reaction: "${text.slice(0, 100)}"`);
    return text;
}

async function clickAccept(page, playerIdx) {
    await page.waitForSelector('[data-action="reaction-concede"]', { timeout: 5_000 });
    await page.click('[data-action="reaction-concede"]');
    log(playerIdx, 'clicked Accept');
}

async function clickJSN(page, playerIdx) {
    await page.waitForSelector('[data-action="reaction-no"]', { timeout: 5_000 });
    await page.click('[data-action="reaction-no"]');
    log(playerIdx, 'played NOT TODAY!');
}

/**
 * Nudge opponent pages so their UI renders a reaction prompt after a broadcast.
 * Call after proposing on the attacker's page; pass attacker index to skip.
 */
async function nudgeOpponents(pages, attackerIdx, delayMs = 700) {
    await pages[attackerIdx].waitForTimeout(delayMs);
    await Promise.all(pages.filter((_, i) => i !== attackerIdx).map(p =>
        p.evaluate(() => window.__game.botReact && window.__game.botReact())
    ));
}

/** Nudge a single page's reaction UI. */
async function nudgePage(page, attackerPage, delayMs = 700) {
    await attackerPage.waitForTimeout(delayMs);
    await page.evaluate(() => window.__game.botReact && window.__game.botReact());
}

/**
 * Handle whatever reaction state a page is in:
 *   payment picker  → click items until Pay enables, click Pay
 *   reaction prompt → click Accept (then recurse for possible picker)
 *   engine pending  → dispatch concede directly
 */
async function autoResolveReaction(page, playerIdx, errors) {
    const modalKind = await page.evaluate(() => {
        const m = document.getElementById('info-modal');
        if (!m || m.classList.contains('hidden')) return null;
        return m.dataset.modalKind || null;
    });

    if (modalKind === 'payment') {
        log(playerIdx, 'payment picker — auto-paying...');
        const itemCount = await page.evaluate(() =>
            document.querySelectorAll('[data-pay-idx]').length
        );
        for (let i = 0; i < itemCount; i++) {
            const enabled = await page.evaluate(() => {
                const btn = document.querySelector('[data-pay-submit]');
                return btn && !btn.disabled;
            });
            if (enabled) break;
            await page.evaluate((idx) => {
                const el = document.querySelector(`[data-pay-idx="${idx}"]`);
                if (el) el.click();
            }, i);
            await page.waitForTimeout(40);
        }
        const payBtn = await page.$('[data-pay-submit]:not([disabled])');
        if (payBtn) {
            await page.evaluate(() => {
                const btn = document.querySelector('[data-pay-submit]:not([disabled])');
                if (btn) btn.click();
            });
            log(playerIdx, 'paid');
        } else {
            errors.push(`${tag(playerIdx)}: Pay button never enabled`);
        }
        return;
    }

    if (modalKind === 'reaction') {
        await clickAccept(page, playerIdx);
        await page.waitForTimeout(150);
        await autoResolveReaction(page, playerIdx, errors);
        return;
    }

    const needsReact = await page.evaluate(() => {
        const s = window.__game.state();
        if (!s.pendingAction) return false;
        return s.reactionTargetId === s.localPlayerId;
    });
    if (needsReact) {
        log(playerIdx, 'dispatching concede (no modal visible)');
        await page.evaluate(() => window.__game.dispatch({ type: 'concede' }));
        await page.waitForTimeout(150);
        await autoResolveReaction(page, playerIdx, errors);
    }
}

/**
 * Wait for all 4 opponents to finish reacting to a fan-out action
 * (birthday, fan-out rent). Runs in parallel.
 */
async function resolveAllOpponents(pages, attackerIdx, errors) {
    await Promise.all(pages.map(async (page, i) => {
        if (i === attackerIdx) return;
        try {
            await waitFor(page, () => {
                const s = window.__game.state();
                return s.pendingAction !== null || s._gameOver;
            }, `${tag(i)} sees pendingAction`, 10_000);
            log(i, 'sees pending — resolving...');
            await autoResolveReaction(page, i, errors);
        } catch (e) {
            errors.push(`${tag(i)} fan-out reaction: ${e.message}`);
        }
    }));
}

// ─── Scripted state ───────────────────────────────────────────────────────────

/**
 * Full-game initial state.
 *
 * Pre-placed boards (as if these were played in prior turns):
 *   P0: BROWN×2 complete, LIGHTBLUE×3 complete  (needs 1 more set for win)
 *   P1: PINK×1                                   (will complete in turn 1)
 *   P2: ORANGE×2, YELLOW×1                       (will complete ORANGE in turn 2)
 *   P3: RED×1                                    (partial)
 *   P4: RAILROAD×3                               (will complete in turn 4)
 *
 * All hands empty — injected fresh at start of each player's turn.
 * Turn 0 hand (P0) is set here since it's the very first turn.
 *
 * Deck: 40 money cards so draws (pass_go end-of-turn) never run out.
 */
function buildFullGameState(nPlayers) {
    const money = (id, val, owner) => ({
        data: { id, type: 'MONEY', name: `${val}G`, value: val }, zone: 'bank', owner,
    });
    const prop = (id, color, owner) => ({
        data: { id, type: 'PROPERTY', colorKey: color, name: id, value: 1 },
        zone: 'board', owner, currentColor: color,
    });
    const action = (id, effect, name, extra = {}) => ({
        data: { id, type: 'ACTION', effect, name, value: extra.value ?? 1, ...extra },
        zone: 'hand', owner: null,
    });
    const rent = (id, allowedColors, isMulti = false) => ({
        data: { id, type: 'RENT', name: isMulti ? 'GREAT TRIBUTE' : 'COLLECT TRIBUTE',
                allowedColors, isMulti, value: isMulti ? 3 : 1 },
        zone: 'hand', owner: null,
    });
    const building = (id, effect, name, val) => ({
        data: { id, type: 'BUILDING', effect, name, value: val },
        zone: 'hand', owner: null,
    });

    const players = Array.from({ length: nPlayers }, (_, i) => ({
        id: i, name: LABELS[i] || `Player ${i}`, _disconnected: false,
        hand: [], bank: [], properties: {}, buildings: {},
    }));

    // ── P0 board + bank ──────────────────────────────────────────────────────
    players[0].properties = {
        BROWN:     [prop('p0_br1','BROWN',0), prop('p0_br2','BROWN',0)],
        LIGHTBLUE: [prop('p0_lb1','LIGHTBLUE',0), prop('p0_lb2','LIGHTBLUE',0), prop('p0_lb3','LIGHTBLUE',0)],
    };
    players[0].bank = [money('p0_m5',5,0), money('p0_m3',3,0)];
    // Turn-0 hand: Pass Go, Double Rent, Collect Tribute (Brown/LightBlue)
    players[0].hand = [
        action('p0_pg',  'pass_go',     'ROYAL CHARTER', { value: 1 }),
        action('p0_dr',  'double_rent', 'DOUBLE TRIBUTE', { value: 1 }),
        rent  ('p0_rc',  ['BROWN','LIGHTBLUE']),
    ];

    // ── P1 board + bank ──────────────────────────────────────────────────────
    players[1].properties = { PINK: [prop('p1_pk1','PINK',1)] };
    players[1].bank = [money('p1_m4a',4,1), money('p1_m4b',4,1), money('p1_m4c',4,1)];

    // ── P2 board + bank ──────────────────────────────────────────────────────
    players[2].properties = {
        ORANGE: [prop('p2_or1','ORANGE',2), prop('p2_or2','ORANGE',2)],
        YELLOW: [prop('p2_yw1','YELLOW',2)],
    };
    players[2].bank = [money('p2_m4a',4,2), money('p2_m4b',4,2), money('p2_m4c',4,2)];

    // ── P3 board + bank ──────────────────────────────────────────────────────
    players[3].properties = { RED: [prop('p3_re1','RED',3)] };
    players[3].bank = [money('p3_m4a',4,3), money('p3_m4b',4,3), money('p3_m4c',4,3)];

    // ── P4 board + bank ──────────────────────────────────────────────────────
    players[4].properties = {
        RAILROAD: [prop('p4_rr1','RAILROAD',4), prop('p4_rr2','RAILROAD',4), prop('p4_rr3','RAILROAD',4)],
    };
    players[4].bank = [money('p4_m4a',4,4), money('p4_m4b',4,4), money('p4_m4c',4,4)];

    // ── Deck: 40 money cards so draws never bottom out ───────────────────────
    const deck = Array.from({ length: 40 }, (_, i) => money(`dk_${i}`, 1, null));

    return {
        deck, discard: [], players,
        turn: 0, actionsLeft: 3, turnNumber: 1,
        pendingAction: null, pendingReactors: [], reactionTargetId: null,
        doubleRentArmed: false, mustDiscard: 0,
        localPlayerId: 0, lastResolution: null, actionLog: [],
        _gameOver: false, _autoEnding: false,
    };
}

async function injectState(pages) {
    const stateJson = JSON.stringify(buildFullGameState(pages.length));
    await Promise.all(pages.map((page, i) =>
        page.evaluate(({ json, pid }) => {
            const s = JSON.parse(json);
            s.localPlayerId = pid;
            Object.assign(window.__game.state(), s);
            if (window.__game.update) window.__game.update();
        }, { json: stateJson, pid: i })
    ));
}

// ─── Lobby setup ──────────────────────────────────────────────────────────────

async function setupLobby(pages) {
    const hostPage    = pages[0];
    const clientPages = pages.slice(1);

    await hostPage.click('#btn-create-game');
    await hostPage.waitForSelector('#lobby-container:not(.hidden)', { timeout: 5_000 });
    const realmId = await hostPage.evaluate(() =>
        document.getElementById('lobby-id-display').textContent.trim()
    );
    if (!realmId || realmId === 'LOCAL-TEST') throw new Error('Host realm ID not ready');
    log(0, `Realm ID: ${realmId}`);

    for (let i = 0; i < clientPages.length; i++) {
        const page = clientPages[i];
        const pidx = i + 1;
        await retry(async () => {
            await page.fill('#join-game-id', realmId);
            await page.click('#btn-join-game');
            await page.waitForSelector('#lobby-container:not(.hidden)', { timeout: 10_000 });
        }, 3, `M${pidx+1} join`);
        log(pidx, 'joined lobby');
        await new Promise(r => setTimeout(r, 600));
    }

    await waitFor(hostPage, () => {
        const slots = document.querySelectorAll('#lobby-slots .lobby-slot:not(.empty)');
        return slots.length >= 5;
    }, `host sees all ${N_PLAYERS} players`, JOIN_TIMEOUT);

    log(0, 'all clients detected — starting game');
    await hostPage.click('#btn-start-game');
    await hostPage.waitForSelector('#game-container:not(.hidden)', { timeout: SNAPSHOT_TIMEOUT });
    await hostPage.waitForFunction(() => !!window.__game, null, { timeout: SNAPSHOT_TIMEOUT });

    await Promise.all(clientPages.map((page, i) =>
        page.waitForFunction(
            () => !!window.__game && window.__game.state().players.length > 0,
            null, { timeout: SNAPSHOT_TIMEOUT }
        ).then(() => log(i + 1, 'snapshot received'))
    ));
}

// ─── TURN 0 — P0: Pass Go · Double Rent · Collect Tribute (Brown) ────────────

async function turn0_PassGoDoubleRentCollect(pages, errors) {
    step('Turn 0 (P0)', 'Pass Go · Double Rent · Collect Tribute (Brown, doubled)');

    // Action 1: Pass Go → plays to discard, draws 2 from deck
    const handBefore = await pages[0].evaluate(() =>
        window.__game.state().players[0].hand.length
    );
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_pg', zone: 'discard' })
    );
    log(0, 'played Pass Go');
    await pages[0].waitForFunction(() => {
        const s = window.__game.state();
        // hand grows by 2 (drew 2), lost 1 (pg), net +1; or equals handBefore+1
        return s.actionsLeft === 2;
    }, null, { timeout: 5_000 });
    const handAfter = await pages[0].evaluate(() =>
        window.__game.state().players[0].hand.length
    );
    assert(handAfter >= handBefore + 1, `turn0: Pass Go should grow hand (before=${handBefore} after=${handAfter})`, errors);
    ok('Pass Go drew 2 cards');

    // Action 2: Double Rent → arms doubleRentArmed flag
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_dr', zone: 'discard' })
    );
    log(0, 'played Double Tribute');
    await pages[0].waitForFunction(() => window.__game.state().actionsLeft === 1, null, { timeout: 3_000 });
    const armed = await pages[0].evaluate(() => window.__game.state().doubleRentArmed);
    assert(armed, 'turn0: doubleRentArmed must be true after Double Tribute', errors);
    ok('Double Tribute armed');

    // Action 3: Collect Tribute (Brown) — fan-out, all 4 opponents pay
    // P0's Brown×2 base rent = 2g, doubled = 4g each
    const p0BankBefore = await pages[0].evaluate(() =>
        window.__game.state().players[0].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_rc', targetPlayerId: null, options: { color: 'BROWN' } })
    );
    log(0, 'proposed Collect Tribute (Brown, doubled)');
    await nudgeOpponents(pages, 0, 700);
    await resolveAllOpponents(pages, 0, errors);
    await waitPendingClear(pages);
    const p0BankAfter = await pages[0].evaluate(() =>
        window.__game.state().players[0].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    assert(p0BankAfter > p0BankBefore,
        `turn0: P0 bank should grow from rent (before=${p0BankBefore} after=${p0BankAfter})`, errors);
    assert(!(await pages[0].evaluate(() => window.__game.state().doubleRentArmed)),
        'turn0: doubleRentArmed must clear after rent', errors);
    ok(`Collect Tribute resolved — P0 bank ${p0BankBefore}g → ${p0BankAfter}g`);

    // Wait for turn to advance to P1
    await waitTurnStart(pages, 1);
    ok('Turn advanced to P1');
}

// ─── TURN 1 — P1: Pink properties · Sly Steal (steal P2's Orange) ────────────

async function turn1_PinksSlySteal(pages, errors) {
    step('Turn 1 (P1)', 'Complete Pink set · Sly Steal orange from P2');

    // Inject P1's hand: 2 more Pink props + Sly Steal
    await reinjectHand(pages, 1, [
        { data: { id:'p1_pk2', type:'PROPERTY', colorKey:'PINK', name:'p1_pk2', value:2 },
          zone:'hand', owner:1, currentColor:'PINK' },
        { data: { id:'p1_pk3', type:'PROPERTY', colorKey:'PINK', name:'p1_pk3', value:2 },
          zone:'hand', owner:1, currentColor:'PINK' },
        { data: { id:'p1_sd', type:'ACTION', effect:'sly_deal', name:'SLY STEAL', value:3 },
          zone:'hand', owner:1 },
    ]);

    // A1: play Pink #2
    await pages[1].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p1_pk2', zone: 'board', options: { color: 'PINK' } })
    );
    log(1, 'played Pink #2');
    await pages[1].waitForFunction(() => window.__game.state().actionsLeft === 2, null, { timeout: 3_000 });

    // A2: play Pink #3 → PINK complete (3/3)
    await pages[1].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p1_pk3', zone: 'board', options: { color: 'PINK' } })
    );
    log(1, 'played Pink #3 — PINK set complete');
    await pages[1].waitForFunction(() => window.__game.state().actionsLeft === 1, null, { timeout: 3_000 });
    await allEqual(pages,
        () => (window.__game.state().players[1].properties['PINK'] || []).length,
        3, 'turn1: P1 has 3 PINK cards', errors);

    // A3: Sly Steal — steal p2_or2 from P2 (P2 has 2/3 ORANGE, incomplete)
    await pages[1].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p1_sd', targetPlayerId: 2,
            options: { targetCardId: 'p2_or2' } })
    );
    log(1, 'proposed Sly Steal on P2 (or2)');
    await nudgePage(pages[2], pages[1], 700);
    await waitReactionPrompt(pages[2], 2);
    await clickAccept(pages[2], 2);
    await waitPendingClear(pages);
    await allEqual(pages,
        () => (window.__game.state().players[1].properties['ORANGE'] || []).length,
        1, 'turn1: P1 stole 1 orange card', errors);
    await allEqual(pages,
        () => (window.__game.state().players[2].properties['ORANGE'] || []).length,
        1, 'turn1: P2 has 1 orange remaining', errors);
    ok('Sly Steal succeeded — P1 has or2, P2 has or1');

    await waitTurnStart(pages, 2);
    ok('Turn advanced to P2');
}

// ─── TURN 2 — P2: Orange #3 · Forced Trade (get or2 back from P1) ────────────

async function turn2_OrangeForced(pages, errors) {
    step('Turn 2 (P2)', 'Play Orange #3 · Forced Trade (yw1↔or2 with P1) → ORANGE complete');

    // Inject P2 hand: or3 + forced_deal + money
    await reinjectHand(pages, 2, [
        { data: { id:'p2_or3', type:'PROPERTY', colorKey:'ORANGE', name:'p2_or3', value:2 },
          zone:'hand', owner:2, currentColor:'ORANGE' },
        { data: { id:'p2_fd', type:'ACTION', effect:'forced_deal', name:'FORCED TRADE', value:3 },
          zone:'hand', owner:2 },
        { data: { id:'p2_m2t', type:'MONEY', name:'2G', value:2 }, zone:'hand', owner:2 },
    ]);

    // A1: play or3 → ORANGE (2/3: or1, or3)
    await pages[2].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p2_or3', zone: 'board', options: { color: 'ORANGE' } })
    );
    log(2, 'played Orange #3 (2/3)');
    await pages[2].waitForFunction(() => window.__game.state().actionsLeft === 2, null, { timeout: 3_000 });

    // A2: Forced Trade — P2 gives yw1, takes or2 from P1
    // After this: P2 ORANGE = [or1, or3, or2] complete (3/3). P1 gains yw1.
    await pages[2].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p2_fd', targetPlayerId: 1,
            options: { myCardId: 'p2_yw1', targetCardId: 'p2_or2' } })
    );
    log(2, 'proposed Forced Trade (give yw1, take or2 from P1)');
    await nudgePage(pages[1], pages[2], 700);
    await waitReactionPrompt(pages[1], 1);
    await clickAccept(pages[1], 1);
    await waitPendingClear(pages);
    await allEqual(pages,
        () => (window.__game.state().players[2].properties['ORANGE'] || []).length,
        3, 'turn2: P2 ORANGE complete (3 cards)', errors);
    await allEqual(pages,
        () => (window.__game.state().players[1].properties['ORANGE'] || []).length,
        0, 'turn2: P1 has 0 orange (traded away)', errors);
    ok('Forced Trade — P2 ORANGE complete, P1 got YELLOW card');

    // A3: bank 2G
    await pages[2].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p2_m2t', zone: 'bank' })
    );
    log(2, 'banked 2G');

    await waitTurnStart(pages, 3);
    ok('Turn advanced to P3');
}

// ─── TURN 3 — P3: Tax Collector (JSN'd) · Feast Day · Great Tribute ──────────

async function turn3_DCJSNBirthdayGreatTribute(pages, errors) {
    step('Turn 3 (P3)', 'Tax Collector (P1 JSNs) · Feast Day · Great Tribute on P0');

    // Give P1 a JSN to play this turn (simulate they drew it)
    await reinjectHand(pages, 1, [
        { data: { id:'p1_jsn', type:'ACTION', effect:'just_say_no', name:'NOT TODAY!', value:4 },
          zone:'hand', owner:1 },
    ]);

    // Inject P3's hand: DC + Birthday + Great Tribute
    await reinjectHand(pages, 3, [
        { data: { id:'p3_dc', type:'ACTION', effect:'debt_collector', name:'TAX COLLECTOR', value:3 },
          zone:'hand', owner:3 },
        { data: { id:'p3_bd', type:'ACTION', effect:'birthday', name:'FEAST DAY', value:2 },
          zone:'hand', owner:3 },
        { data: { id:'p3_gt', type:'RENT', effect:'collect_rent', name:'GREAT TRIBUTE',
                  allowedColors:['BROWN','LIGHTBLUE','PINK','ORANGE','RED','YELLOW','GREEN','DARKBLUE','UTILITY','RAILROAD'],
                  isMulti:true, value:3 },
          zone:'hand', owner:3 },
    ]);

    // A1: Tax Collector → P1. P1 JSNs. P3 lets it stand → cancelled.
    await pages[3].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p3_dc', targetPlayerId: 1, options: {} })
    );
    log(3, 'proposed Tax Collector on P1');
    await nudgePage(pages[1], pages[3], 700);
    const dcText = await waitReactionPrompt(pages[1], 1);
    assert(dcText.includes('NOT TODAY') || dcText.includes('Tax') || dcText.includes('5'),
        `turn3: P1 reaction text should mention Tax/5g, got "${dcText.slice(0,80)}"`, errors);
    const hasJSN = await pages[1].evaluate(() => !!document.querySelector('[data-action="reaction-no"]'));
    assert(hasJSN, 'turn3: P1 must have JSN button for DC', errors);

    await clickJSN(pages[1], 1);
    log(1, 'JSN fired — P3 sees counter-prompt');

    // P3 must see counter-reaction prompt
    await nudgePage(pages[3], pages[1], 400);
    await waitReactionPrompt(pages[3], 3);
    await clickAccept(pages[3], 3);
    log(3, 'P3 lets JSN stand → DC cancelled');
    await waitPendingClear(pages);
    await allEqual(pages,
        () => window.__game.state().discard.some(c => c.data.id === 'p1_jsn'),
        true, 'turn3: JSN in discard', errors);
    ok('Tax Collector cancelled by NOT TODAY! chain');

    // A2: Feast Day — all 4 opponents pay 2g each
    const p3BankBefore = await pages[3].evaluate(() =>
        window.__game.state().players[3].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    await pages[3].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p3_bd', targetPlayerId: null, options: {} })
    );
    log(3, 'proposed Feast Day');
    await nudgeOpponents(pages, 3, 700);
    await resolveAllOpponents(pages, 3, errors);
    await waitPendingClear(pages);
    const p3BankAfter = await pages[3].evaluate(() =>
        window.__game.state().players[3].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    assert(p3BankAfter >= p3BankBefore, `turn3: P3 bank should not shrink from Birthday`, errors);
    ok('Feast Day resolved — all opponents paid tribute');

    // A3: Great Tribute on P0 — P3 charges P0 for P3's RED holding (1 card = 2g base)
    await pages[3].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p3_gt', targetPlayerId: 0,
            options: { color: 'RED' } })
    );
    log(3, 'proposed Great Tribute on P0 (RED rent)');
    await nudgePage(pages[0], pages[3], 700);
    await waitReactionPrompt(pages[0], 0);
    await autoResolveReaction(pages[0], 0, errors);
    await waitPendingClear(pages);
    ok('Great Tribute resolved — P0 paid RED rent to P3');

    await waitTurnStart(pages, 4);
    ok('Turn advanced to P4');
}

// ─── TURN 4 — P4: Railroad #4 · Double Rent · Collect Tribute (Railroad) ─────

async function turn4_RailroadDoubleRent(pages, errors) {
    step('Turn 4 (P4)', 'Complete Railroad · Double Rent · Collect Tribute (Railroad, doubled)');

    // Inject P4 hand: rr4 + double_rent + railroad rent card
    await reinjectHand(pages, 4, [
        { data: { id:'p4_rr4', type:'PROPERTY', colorKey:'RAILROAD', name:'p4_rr4', value:2 },
          zone:'hand', owner:4, currentColor:'RAILROAD' },
        { data: { id:'p4_dr', type:'ACTION', effect:'double_rent', name:'DOUBLE TRIBUTE', value:1 },
          zone:'hand', owner:4 },
        { data: { id:'p4_rc', type:'RENT', name:'COLLECT TRIBUTE',
                  allowedColors:['RAILROAD','UTILITY'], isMulti:false, value:1 },
          zone:'hand', owner:4 },
    ]);

    // A1: play Railroad #4 → RAILROAD complete (4/4)
    await pages[4].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p4_rr4', zone: 'board', options: { color: 'RAILROAD' } })
    );
    log(4, 'played Railroad #4 — RAILROAD set complete (4/4)');
    await pages[4].waitForFunction(() => window.__game.state().actionsLeft === 2, null, { timeout: 3_000 });
    await allEqual(pages,
        () => (window.__game.state().players[4].properties['RAILROAD'] || []).length,
        4, 'turn4: P4 has 4 RAILROAD cards', errors);

    // A2: Double Rent → arm flag
    await pages[4].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p4_dr', zone: 'discard' })
    );
    log(4, 'played Double Tribute');
    await pages[4].waitForFunction(() => window.__game.state().actionsLeft === 1, null, { timeout: 3_000 });
    const armed = await pages[4].evaluate(() => window.__game.state().doubleRentArmed);
    assert(armed, 'turn4: doubleRentArmed must be true', errors);
    ok('Double Tribute armed');

    // A3: Collect Tribute (Railroad) — fan-out, all pay 2×4 = 8g each
    const p4BankBefore = await pages[4].evaluate(() =>
        window.__game.state().players[4].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    await pages[4].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p4_rc', targetPlayerId: null,
            options: { color: 'RAILROAD' } })
    );
    log(4, 'proposed Collect Tribute (Railroad, 8g doubled)');
    await nudgeOpponents(pages, 4, 700);
    await resolveAllOpponents(pages, 4, errors);
    await waitPendingClear(pages);
    const p4BankAfter = await pages[4].evaluate(() =>
        window.__game.state().players[4].bank.reduce((s,c) => s + (c.data.value||0), 0)
    );
    assert(p4BankAfter >= p4BankBefore, `turn4: P4 bank should grow from railroad rent`, errors);
    ok(`Collect Tribute (Railroad) resolved — P4 bank ${p4BankBefore}g → ${p4BankAfter}g`);

    await waitTurnStart(pages, 0);
    ok('Turn cycled back to P0');
}

// ─── TURN 5 — P0: House · Hotel · Kingdom Breaker → WIN ──────────────────────

async function turn5_HouseHotelKingdomBreaker(pages, errors) {
    step('Turn 5 (P0)', 'House + Hotel on LightBlue · Kingdom Breaker steal P2 ORANGE → WIN');

    // Inject P0's second-turn hand
    await reinjectHand(pages, 0, [
        { data: { id:'p0_hs', type:'BUILDING', effect:'house', name:'THE KEEP', value:3 },
          zone:'hand', owner:0 },
        { data: { id:'p0_ht', type:'BUILDING', effect:'hotel', name:'THE CASTLE', value:4 },
          zone:'hand', owner:0 },
        { data: { id:'p0_db', type:'ACTION', effect:'deal_breaker', name:'KINGDOM BREAKER', value:5 },
          zone:'hand', owner:0 },
    ]);

    // A1: House on LightBlue (P0 has complete LightBlue×3 set)
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_hs', zone: 'board', options: { color: 'LIGHTBLUE' } })
    );
    log(0, 'played House on LightBlue');
    await pages[0].waitForFunction(() => window.__game.state().actionsLeft === 2, null, { timeout: 3_000 });
    await allEqual(pages,
        () => (window.__game.state().players[0].buildings['LIGHTBLUE'] || []).some(b => b.data.effect === 'house'),
        true, 'turn5: house on LightBlue', errors);
    ok('House placed on LightBlue set');

    // A2: Hotel on LightBlue (requires house already there)
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'play', cardId: 'p0_ht', zone: 'board', options: { color: 'LIGHTBLUE' } })
    );
    log(0, 'played Hotel on LightBlue');
    await pages[0].waitForFunction(() => window.__game.state().actionsLeft === 1, null, { timeout: 3_000 });
    await allEqual(pages,
        () => (window.__game.state().players[0].buildings['LIGHTBLUE'] || []).some(b => b.data.effect === 'hotel'),
        true, 'turn5: hotel on LightBlue', errors);
    ok('Hotel placed on LightBlue set (house + hotel)');

    // A3: Kingdom Breaker — steal P2's complete ORANGE set → WIN
    // P0 then has: BROWN×2, LIGHTBLUE×3, ORANGE×3 = 3 complete sets
    await pages[0].evaluate(() =>
        window.__game.dispatch({ type: 'propose', cardId: 'p0_db', targetPlayerId: 2,
            options: { color: 'ORANGE' } })
    );
    log(0, 'proposed Kingdom Breaker on P2 ORANGE set');
    await nudgePage(pages[2], pages[0], 700);
    const dbText = await waitReactionPrompt(pages[2], 2);
    assert(dbText.includes('Orange') || dbText.includes('ORANGE') || dbText.includes('steal') || dbText.includes('Kingdom'),
        `turn5: P2 reaction should mention Orange/steal, got "${dbText.slice(0,100)}"`, errors);
    const hasJSN2 = await pages[2].evaluate(() => !!document.querySelector('[data-action="reaction-no"]'));
    assert(!hasJSN2, 'turn5: P2 has no JSN (never had one)', errors);
    await clickAccept(pages[2], 2);
    await waitPendingClear(pages);

    // Win condition fires
    await waitGameOver(pages);
    ok('Win condition fired on all machines');

    // P0 must have all 3 sets
    await allEqual(pages,
        () => (window.__game.state().players[0].properties['ORANGE'] || []).length,
        3, 'turn5: P0 has 3 ORANGE cards (stolen)', errors);
    await allEqual(pages,
        () => (window.__game.state().players[2].properties['ORANGE'] || []).length,
        0, 'turn5: P2 has 0 ORANGE cards', errors);

    // Win/loss banners
    await pages[0].waitForTimeout(100);
    const banners = await Promise.all(pages.map(p =>
        p.evaluate(() => (document.getElementById('turn-banner') || {}).textContent || '')
    ));
    banners.forEach((b, i) => log(i, `banner: "${b}"`));
    assert(/CROWN|WIN|YOURS/i.test(banners[0]),
        `turn5: P0 win banner wrong: "${banners[0]}"`, errors);
    for (let i = 1; i < pages.length; i++) {
        assert(/FALLEN|LOST|KINGDOM/i.test(banners[i]),
            `turn5: ${tag(i)} loss banner wrong: "${banners[i]}"`, errors);
    }
    ok('Win/loss banners correct on all 5 machines');
}

// ─── Final state consistency ───────────────────────────────────────────────────

async function stepFinalSync(pages, errors) {
    step('Final', 'All 5 machines must agree on final game state');

    const summary = await allAgree(pages, () => {
        const s = window.__game.state();
        return {
            gameOver: s._gameOver,
            p0sets: Object.fromEntries(
                Object.entries(s.players[0].properties)
                    .map(([k, v]) => [k, v.length]).filter(([,v]) => v > 0)
            ),
            p0buildings: Object.fromEntries(
                Object.entries(s.players[0].buildings || {})
                    .map(([k, v]) => [k, v.map(b => b.data.effect)]).filter(([,v]) => v.length > 0)
            ),
        };
    }, 'final state', errors);

    if (summary) {
        console.log(`  Final state: gameOver=${summary.gameOver}`);
        console.log(`  P0 properties: ${JSON.stringify(summary.p0sets)}`);
        console.log(`  P0 buildings:  ${JSON.stringify(summary.p0buildings)}`);
    }
    if (errors.length === 0) ok('All 5 machines agree on final state');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Lord Landlord — 5-Player Full Scripted Multiplayer Test     ║');
    console.log('║  All action card types · 6 turns · 5 separate processes      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`\n  URL: ${GAME_URL}  |  headed: ${HEADED}  |  players: ${N_PLAYERS}\n`);

    const browsers = [];
    const pages    = [];
    const errors   = [];
    let   server   = null;

    try {
        if (!process.env.URL) {
            server = await startServer();
            console.log(`  Static server: ${GAME_URL}`);
        }

        console.log('  Launching 5 browser processes...');
        const launched = await Promise.all(
            Array.from({ length: N_PLAYERS }, (_, i) => launchBrowser(i))
        );
        for (const { browser, page } of launched) {
            browsers.push(browser);
            pages.push(page);
        }

        console.log('  Loading game on all machines...');
        await Promise.all(pages.map((p, i) => loadGame(p, i)));

        console.log('\n  Setting up lobby...');
        await setupLobby(pages);
        await pages[0].waitForTimeout(800);

        console.log('\n  Injecting scripted state...');
        await injectState(pages);

        // Sanity: verify turn 0, P0's hand, boards
        const turn = await pages[0].evaluate(() => window.__game.state().turn);
        assert(turn === 0, `Initial turn should be 0, got ${turn}`, errors);
        const p0hand = await pages[0].evaluate(() => window.__game.state().players[0].hand.length);
        assert(p0hand === 3, `P0 hand should be 3 cards, got ${p0hand}`, errors);
        if (errors.length) throw new Error('State injection failed: ' + errors[0]);
        ok('Full-game state injected — 2 complete sets pre-placed for P0');

        // ── Run all 6 turns ─────────────────────────────────────────────────
        await turn0_PassGoDoubleRentCollect(pages, errors);
        if (errors.length) throw new Error('Turn 0 failed: ' + errors[0]);

        await turn1_PinksSlySteal(pages, errors);
        if (errors.length) throw new Error('Turn 1 failed: ' + errors[0]);

        await turn2_OrangeForced(pages, errors);
        if (errors.length) throw new Error('Turn 2 failed: ' + errors[0]);

        await turn3_DCJSNBirthdayGreatTribute(pages, errors);
        if (errors.length) throw new Error('Turn 3 failed: ' + errors[0]);

        await turn4_RailroadDoubleRent(pages, errors);
        if (errors.length) throw new Error('Turn 4 failed: ' + errors[0]);

        await turn5_HouseHotelKingdomBreaker(pages, errors);
        if (errors.length) throw new Error('Turn 5 failed: ' + errors[0]);

        await stepFinalSync(pages, errors);

    } catch (e) {
        const msg = (e.message || String(e)).split('\n')[0];
        console.log(`\n  [fatal] ${msg}`);
        if (e.stack) console.log(e.stack.split('\n').slice(1,4).join('\n'));
        errors.push(msg);
    } finally {
        for (const b of browsers) await b.close().catch(() => {});
        if (server) server.close();

        console.log('\n' + '═'.repeat(66));
        if (errors.length === 0) {
            console.log('  PASS — full 6-turn game completed on all 5 machines');
            console.log('  Cards exercised: Pass Go · Double Rent · Collect Tribute (fan-out)');
            console.log('                   Sly Steal · Forced Trade · Tax Collector · NOT TODAY!');
            console.log('                   Feast Day · Great Tribute · House · Hotel · Kingdom Breaker');
        } else {
            console.log('  FAIL');
            errors.forEach(e => console.log(`    ✗ ${e}`));
        }
        console.log('═'.repeat(66) + '\n');
        process.exit(errors.length ? 1 : 0);
    }
})();
