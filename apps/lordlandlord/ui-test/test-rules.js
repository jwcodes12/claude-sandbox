/**
 * test-rules.js — Targeted rules verification across 3 players
 *
 * Scenarios:
 *   Scenario 1: Over-7 discard — P0 has 9 cards, verify new discard-phase UI,
 *               dispatch 2 discards, confirm turn advances
 *   Scenario 2: Rent — P0 (host) collects rent from P1 and P2, verifies payment
 *   Scenario 3: Sly Steal + Just Say No — P0 steals, P1 counters with JSN
 *
 * Run: node ui-test/test-rules.js
 *      HEADED=1 node ui-test/test-rules.js
 */

'use strict';
const { chromium } = require('playwright');
const express      = require('express');
const path         = require('path');
const http         = require('http');
const fs           = require('fs');

const HEADED   = process.env.HEADED === '1';
const PORT     = 18_181;
const GAME_URL = `http://localhost:${PORT}/`;
const OUT_DIR  = path.join(__dirname, '..', 'test-rules-out');

fs.mkdirSync(OUT_DIR, { recursive: true });

function startServer() {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.static(path.join(__dirname, '..', 'src')));
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => resolve(server));
    });
}

const N_PLAYERS      = 3;
const JOIN_TIMEOUT   = 35_000;
const ACTION_TIMEOUT = 12_000;
const LABELS = ['M1-host', 'M2-P1', 'M3-P2'];

function tag(i)       { return `[${LABELS[i] || `M${i+1}`}]`; }
function log(i, msg)  { console.log(`  ${tag(i)} ${msg}`); }
function step(n, msg) { console.log(`\n  ── ${n} ──\n     ${msg}`); }
function ok(msg)      { console.log(`  ✓ ${msg}`); }
function fail(msg)    { console.log(`  ✗ ${msg}`); }

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser(idx) {
    const browser = await chromium.launch({
        headless: !HEADED,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => log(idx, `[err] ${e.message.slice(0, 120)}`));
    page.on('console', msg => {
        const t = msg.text();
        if (/NET-DEBUG|HOST-DEBUG/.test(t)) log(idx, `[js] ${t.slice(0, 120)}`);
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    return { browser, page };
}

async function loadPage(page, idx) {
    await page.goto(`${GAME_URL}?bust=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-create-game', { state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t.length > 4 && t !== 'LOCAL-TEST';
    }, null, { timeout: 30_000 });
    log(idx, 'loaded');
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function waitFor(page, fn, desc, timeout = ACTION_TIMEOUT) {
    try {
        await page.waitForFunction(fn, null, { timeout });
    } catch (_) {
        const s = await page.evaluate(() => {
            const g = window.__game && window.__game.state();
            if (!g) return 'no __game';
            return JSON.stringify({
                turn: g.turn, al: g.actionsLeft, md: g.mustDiscard,
                pending: !!g.pendingAction, reactor: g.reactionTargetId,
            });
        }).catch(() => 'eval failed');
        throw new Error(`Timeout waiting for: ${desc}\n    state: ${s}`);
    }
}

async function waitTurnStart(pages, pid, timeout = 15_000) {
    await Promise.all(pages.map((p, i) =>
        p.waitForFunction(pid => {
            const s = window.__game.state();
            return s.turn === pid && s.actionsLeft === 3 && s.pendingAction === null && s.mustDiscard === 0;
        }, pid, { timeout }).catch(e => { throw new Error(`${tag(i)} waitTurnStart(${pid}): ${e.message}`); })
    ));
}

async function screenshot(page, name) {
    const p = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    return p;
}

function assert(cond, msg, errors) {
    if (!cond) { errors.push(msg); fail(msg); return false; }
    ok(msg); return true;
}

async function allAgree(pages, fn, desc, errors) {
    const vals = await Promise.all(pages.map(p => p.evaluate(fn)));
    const ref = JSON.stringify(vals[0]);
    let agreed = true;
    for (let i = 1; i < pages.length; i++) {
        if (JSON.stringify(vals[i]) !== ref) {
            errors.push(`${desc}: ${tag(0)}=${ref} vs ${tag(i)}=${JSON.stringify(vals[i])}`);
            agreed = false;
        }
    }
    if (agreed) ok(`${desc} — all agree: ${ref}`);
    return vals[0];
}

// ─── Payment / reaction resolution ───────────────────────────────────────────

async function autoResolveReaction(page, idx, errors) {
    const modalKind = await page.evaluate(() => {
        const m = document.getElementById('info-modal');
        if (!m || m.classList.contains('hidden')) return null;
        return m.dataset.modalKind || null;
    });

    if (modalKind === 'payment') {
        log(idx, 'payment picker — auto-paying...');
        const itemCount = await page.evaluate(() => document.querySelectorAll('[data-pay-idx]').length);
        for (let i = 0; i < itemCount; i++) {
            const enabled = await page.evaluate(() => {
                const btn = document.querySelector('[data-pay-submit]');
                return btn && !btn.disabled;
            });
            if (enabled) break;
            await page.evaluate(ii => {
                const el = document.querySelector(`[data-pay-idx="${ii}"]`);
                if (el) el.click();
            }, i);
            await page.waitForTimeout(50);
        }
        const paid = await page.evaluate(() => {
            const btn = document.querySelector('[data-pay-submit]:not([disabled])');
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (!paid) errors.push(`${tag(idx)}: Pay button never enabled`);
        else log(idx, 'paid');
        return;
    }

    if (modalKind === 'reaction') {
        await page.click('[data-action="reaction-concede"]');
        log(idx, 'accepted reaction');
        await page.waitForTimeout(150);
        await autoResolveReaction(page, idx, errors);
        return;
    }

    const needsReact = await page.evaluate(() => {
        const s = window.__game.state();
        return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
    });
    if (needsReact) {
        log(idx, 'dispatching concede (engine-only, no modal)');
        await page.evaluate(() => window.__game.dispatch({ type: 'concede' }));
        await page.waitForTimeout(150);
        await autoResolveReaction(page, idx, errors);
    }
}

/** Wait for pendingAction on each non-attacker page, then resolve it. */
async function resolveAllOpponents(pages, attackerIdx, errors) {
    await Promise.all(pages.map(async (page, i) => {
        if (i === attackerIdx) return;
        try {
            // Nudge reaction handling (mirrors mp-full-game.js pattern)
            await pages[attackerIdx].waitForTimeout(600);
            await page.evaluate(() => window.__game.botReact && window.__game.botReact());

            await waitFor(page, () => {
                const s = window.__game.state();
                return s.pendingAction !== null || s._gameOver;
            }, `${tag(i)} sees pendingAction`, 10_000);
            log(i, 'sees pending — resolving...');
            await autoResolveReaction(page, i, errors);
        } catch (e) {
            errors.push(`${tag(i)} reaction: ${e.message.slice(0, 120)}`);
        }
    }));
}

// ─── State builders ───────────────────────────────────────────────────────────

function money(id, val, owner) {
    return { data: { id, type: 'MONEY', name: `${val}G`, value: val }, zone: 'bank', owner };
}
function prop(id, color, owner) {
    return { data: { id, type: 'PROPERTY', colorKey: color, name: id, value: 1 }, zone: 'board', owner, currentColor: color };
}
function mkAction(id, effect, name, extra = {}) {
    return { data: { id, type: 'ACTION', effect, name, value: extra.value ?? 1, ...extra }, zone: 'hand', owner: null };
}
function mkRent(id, allowedColors) {
    return { data: { id, type: 'RENT', name: 'COLLECT TRIBUTE', allowedColors, isMulti: false, value: 1 }, zone: 'hand', owner: null };
}

function buildBaseState(nPlayers) {
    const players = Array.from({ length: nPlayers }, (_, i) => ({
        id: i, name: LABELS[i], _disconnected: false,
        hand: [], bank: [], properties: {}, buildings: {},
    }));

    // P0: BROWN×2 complete, ORANGE×3 complete — 2 sets, plenty of bank
    players[0].properties = {
        BROWN:  [prop('p0_br1','BROWN', 0), prop('p0_br2','BROWN', 0)],
        ORANGE: [prop('p0_or1','ORANGE',0), prop('p0_or2','ORANGE',0), prop('p0_or3','ORANGE',0)],
    };
    players[0].bank = [money('p0_m5',5,0), money('p0_m3',3,0), money('p0_m2',2,0)];

    // P1: PINK×3 complete — 1 set. Has a spare ORANGE prop and JSN in hand (injected per scenario)
    players[1].properties = {
        PINK: [prop('p1_pk1','PINK',1), prop('p1_pk2','PINK',1), prop('p1_pk3','PINK',1)],
    };
    players[1].bank = [money('p1_m4a',4,1), money('p1_m4b',4,1), money('p1_m4c',4,1)];
    players[1].hand = [
        prop ('p1_or_spare', 'ORANGE', 1),
        mkAction('p1_jsn', 'just_say_no', 'NOT TODAY!', { value: 4 }),
    ];

    // P2: LIGHTBLUE×1 partial. Has bank to pay rent.
    players[2].properties = {
        LIGHTBLUE: [prop('p2_lb1','LIGHTBLUE',2)],
    };
    players[2].bank = [money('p2_m3a',3,2), money('p2_m3b',3,2)];
    players[2].hand = [];

    const deck = Array.from({ length: 30 }, (_, i) => money(`dk_${i}`, 1, null));

    return {
        deck, discard: [], players,
        turn: 0, actionsLeft: 3, turnNumber: 1,
        pendingAction: null, pendingReactors: [], reactionTargetId: null,
        doubleRentArmed: false, mustDiscard: 0,
        localPlayerId: 0, lastResolution: null, actionLog: [],
        _gameOver: false, _autoEnding: false,
    };
}

async function injectState(pages, stateMutator) {
    const base = buildBaseState(pages.length);
    if (stateMutator) stateMutator(base);
    const json = JSON.stringify(base);
    await Promise.all(pages.map((page, i) =>
        page.evaluate(({ json, pid }) => {
            const s = JSON.parse(json);
            s.localPlayerId = pid;
            Object.assign(window.__game.state(), s);
            if (window.__game.update) window.__game.update();
        }, { json, pid: i })
    ));
    ok('state injected on all machines');
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

async function setupLobby(pages) {
    const host = pages[0];
    await host.click('#btn-create-game');
    await host.waitForSelector('#lobby-container:not(.hidden)', { timeout: 5_000 });
    const realmId = await host.evaluate(() => document.getElementById('lobby-id-display').textContent.trim());
    log(0, `Realm: ${realmId}`);

    for (let i = 1; i < pages.length; i++) {
        await pages[i].fill('#join-game-id', realmId);
        await pages[i].click('#btn-join-game');
        await pages[i].waitForSelector('#lobby-container:not(.hidden)', { timeout: 10_000 });
        log(i, 'joined');
        await new Promise(r => setTimeout(r, 500));
    }

    await waitFor(host, () =>
        document.querySelectorAll('#lobby-slots .lobby-slot:not(.empty)').length >= 3,
        'host sees 3 players', JOIN_TIMEOUT
    );

    await host.click('#btn-start-game');
    await Promise.all(pages.map(p =>
        p.waitForSelector('#game-container:not(.hidden)', { timeout: 15_000 })
    ));
    ok('all players in game');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const errors = [];
    let server;
    const browsers = [];

    try {
        server = await startServer();
        console.log(`\n  Server on :${PORT}`);

        for (let i = 0; i < N_PLAYERS; i++) browsers.push(await launchBrowser(i));
        const pages = browsers.map(b => b.page);

        await Promise.all(pages.map((p, i) => loadPage(p, i)));
        await setupLobby(pages);

        // ═════════════════════════════════════════════════════════════════════
        // SCENARIO 1: Over-7 discard
        // P0 starts with 9 cards and actionsLeft=0 so update() fires endTurn,
        // detects hand>7, sets mustDiscard=2.
        // ═════════════════════════════════════════════════════════════════════
        step('Scenario 1', 'Over-7 discard — P0 has 9-card hand, must discard 2');

        await injectState(pages, s => {
            s.actionsLeft = 0;
            s.players[0].hand = [
                mkAction('pg1','pass_go','ROYAL CHARTER'),
                mkAction('pg2','pass_go','ROYAL CHARTER'),
                mkAction('pg3','pass_go','ROYAL CHARTER'),
                money('hm1',1,null), money('hm2',1,null), money('hm3',1,null),
                money('hm4',2,null), money('hm5',2,null), money('hm6',2,null),
            ];
        });

        // Force update so endTurn fires and mustDiscard is set
        await pages[0].evaluate(() => window.__game.update());
        await pages[0].waitForTimeout(500);

        // 1a: mustDiscard=2 on all machines
        const mdVal = await allAgree(pages, () => window.__game.state().mustDiscard, 'mustDiscard', errors);
        assert(mdVal === 2, `mustDiscard === 2 (got ${mdVal})`, errors);

        // 1b: Turn did NOT advance
        const turnDuring = await pages[0].evaluate(() => window.__game.state().turn);
        assert(turnDuring === 0, `turn still 0 during discard phase (got ${turnDuring})`, errors);

        // 1c: New in-UI discard phase — turn indicator, not modal
        const p0ui = await pages[0].evaluate(() => {
            const ind  = document.querySelector('.turn-indicator');
            const urg  = document.querySelector('.discard-urgency');
            const zone = document.querySelector('.zone-discard');
            const modal = document.getElementById('info-modal');
            return {
                indicatorHasMustDiscard: !!(ind && ind.classList.contains('must-discard')),
                urgencyText: urg ? urg.textContent.trim() : '',
                zoneActive:  !!(zone && zone.classList.contains('discard-active')),
                noModal: !modal || modal.classList.contains('hidden') || modal.dataset.modalKind !== 'must-discard',
            };
        });
        assert(p0ui.indicatorHasMustDiscard, 'turn-indicator has .must-discard class (P0)', errors);
        assert(p0ui.urgencyText.startsWith('Discard 2'), `urgency label = "${p0ui.urgencyText}"`, errors);
        assert(p0ui.zoneActive, 'discard zone has .discard-active (pulsing)', errors);
        assert(p0ui.noModal, 'no must-discard modal — replaced by inline UI', errors);

        // 1d: Other players see "Waiting…" in the turn indicator
        const p1ui = await pages[1].evaluate(() => {
            const ind   = document.querySelector('.turn-indicator');
            const label = document.querySelector('.turn-indicator-label');
            return {
                hasMustDiscard: !!(ind && ind.classList.contains('must-discard')),
                labelText: label ? label.textContent.trim() : '',
            };
        });
        assert(p1ui.hasMustDiscard, 'P1 turn-indicator has .must-discard class', errors);
        assert(p1ui.labelText.includes('Waiting'), `P1 sees waiting label: "${p1ui.labelText}"`, errors);

        await screenshot(pages[0], '1a-p0-discard-phase');
        await screenshot(pages[1], '1b-p1-waiting');

        // 1e: Dispatch 2 discards from P0
        const hand0 = await pages[0].evaluate(() => window.__game.state().players[0].hand.map(c => c.data.id));
        log(0, `hand (${hand0.length} cards): ${hand0.join(', ')}`);
        assert(hand0.length === 9, `hand has 9 cards before discard (got ${hand0.length})`, errors);

        await pages[0].evaluate(id => window.__game.dispatch({ type: 'discard', cardId: id }), hand0[0]);
        await pages[0].waitForTimeout(300);
        await pages[0].evaluate(id => window.__game.dispatch({ type: 'discard', cardId: id }), hand0[1]);
        await pages[0].waitForTimeout(500);

        // 1f: Turn advances to P1, mustDiscard=0
        await waitTurnStart(pages, 1, 12_000);
        ok('Turn advanced to P1 after discards');

        const afterDiscard = await allAgree(pages,
            () => ({ turn: window.__game.state().turn, md: window.__game.state().mustDiscard }),
            'post-discard state', errors
        );
        assert(afterDiscard.turn === 1, `turn is now 1 (got ${afterDiscard.turn})`, errors);
        assert(afterDiscard.md === 0, `mustDiscard is 0 (got ${afterDiscard.md})`, errors);

        const handLen = await pages[0].evaluate(() => window.__game.state().players[0].hand.length);
        assert(handLen === 7, `P0 hand trimmed to 7 (got ${handLen})`, errors);

        await screenshot(pages[0], '1c-after-discard-p1-turn');

        // ═════════════════════════════════════════════════════════════════════
        // SCENARIO 2: Rent — P0 (host) plays ORANGE rent, P1 and P2 pay
        // Re-inject state with P0 on turn, actionsLeft=3
        // ═════════════════════════════════════════════════════════════════════
        step('Scenario 2', 'P0 collects ORANGE rent — P1 and P2 must pay');

        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [
                mkRent('rent1', ['ORANGE']),
                money('hm7',1,null), money('hm8',1,null),
            ];
        });

        const p0BankBefore = await pages[0].evaluate(() => window.__game.state().players[0].bank.length);
        const p1BankBefore = await pages[1].evaluate(() => window.__game.state().players[1].bank.length);
        const p2BankBefore = await pages[2].evaluate(() => window.__game.state().players[2].bank.length);
        log(0, `banks before rent — P0:${p0BankBefore} P1:${p1BankBefore} P2:${p2BankBefore}`);

        // P0 plays the rent card (host dispatches directly).
        // COLLECT TRIBUTE uses executeAction → chargePlayer (automatic, no picker).
        await pages[0].evaluate(() => window.__game.dispatch({
            type: 'play', cardId: 'rent1', zone: 'discard', options: { color: 'ORANGE' },
        }));
        await pages[0].waitForTimeout(800);

        const p0BankAfter = await pages[0].evaluate(() => window.__game.state().players[0].bank.length);
        log(0, `P0 bank after rent: ${p0BankAfter} cards (was ${p0BankBefore})`);
        assert(p0BankAfter > p0BankBefore, `P0 received rent payments (${p0BankBefore} → ${p0BankAfter} bank cards)`, errors);

        const p1BankAfter = await pages[0].evaluate(() => window.__game.state().players[1].bank.length);
        const p2BankAfter = await pages[0].evaluate(() => window.__game.state().players[2].bank.length);
        log(0, `P1 bank: ${p1BankBefore} → ${p1BankAfter}, P2 bank: ${p2BankBefore} → ${p2BankAfter}`);
        assert(p1BankAfter < p1BankBefore || p2BankAfter < p2BankBefore,
            `at least one opponent lost bank cards to rent`, errors);

        await allAgree(pages,
            () => ({ p0b: window.__game.state().players[0].bank.length, turn: window.__game.state().turn }),
            'post-rent sync', errors
        );

        await screenshot(pages[0], '2-after-rent');

        // ═════════════════════════════════════════════════════════════════════
        // SCENARIO 3: Sly Steal + Just Say No
        // P0 steals P1's spare ORANGE prop; P1 counters with JSN.
        // P1 owns the prop after the chain resolves.
        // ═════════════════════════════════════════════════════════════════════
        step('Scenario 3', "P0 Sly Steals P1's ORANGE prop — P1 plays NOT TODAY!");

        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            // P0 has a Sly Steal
            s.players[0].hand = [
                mkAction('sly1','sly_deal','SLY STEAL', { value: 3 }),
                money('hm9',1,null), money('hm10',1,null),
            ];
            // P1 has a spare ORANGE prop on their board + JSN in hand
            s.players[1].properties.ORANGE = [
                prop('p1_or_spare','ORANGE',1),
            ];
            s.players[1].hand = [
                mkAction('p1_jsn','just_say_no','NOT TODAY!', { value: 4 }),
            ];
        });

        const p1OrBefore = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );
        log(0, `P1 ORANGE props before steal: ${p1OrBefore}`);

        // P0 proposes Sly Steal targeting P1's ORANGE prop
        const targetId = await pages[0].evaluate(() => {
            const props = window.__game.state().players[1].properties.ORANGE || [];
            return props[0] ? props[0].data.id : null;
        });
        assert(targetId !== null, `target prop found: ${targetId}`, errors);

        await pages[0].evaluate(({ cardId, propId }) => {
            window.__game.dispatch({ type: 'propose', cardId, targetPlayerId: 1, options: { targetCardId: propId } });
        }, { cardId: 'sly1', propId: targetId });

        await pages[0].waitForTimeout(700);

        // Nudge P1 to process the pending action
        await pages[1].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[1].waitForTimeout(400);

        // Wait for P1 to see the reaction modal
        await waitFor(pages[1], () => {
            const s = window.__game.state();
            const m = document.getElementById('info-modal');
            return (s.reactionTargetId === s.localPlayerId) ||
                   (m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction');
        }, 'P1 sees steal reaction', 8_000);

        // P1 plays JSN
        const jsnId = await pages[1].evaluate(() => {
            const s = window.__game.state();
            const j = s.players[1].hand.find(c => c.data.effect === 'just_say_no');
            return j ? j.data.id : null;
        });
        assert(jsnId !== null, `P1 JSN card found: ${jsnId}`, errors);

        await pages[1].evaluate(id => window.__game.dispatch({ type: 'react-no', cardId: id }), jsnId);
        await pages[1].waitForTimeout(600);

        // P0 must now concede the JSN (can't counter-JSN in this test)
        await pages[0].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[0].waitForTimeout(400);

        const p0NeedsReact = await pages[0].evaluate(() => {
            const s = window.__game.state();
            const m = document.getElementById('info-modal');
            return (s.pendingAction && s.reactionTargetId === s.localPlayerId) ||
                   (m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction');
        });
        if (p0NeedsReact) {
            const hasModal = await pages[0].evaluate(() => {
                const m = document.getElementById('info-modal');
                return m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction';
            });
            if (hasModal) {
                await pages[0].click('[data-action="reaction-concede"]');
                log(0, 'conceded JSN via modal');
            } else {
                await pages[0].evaluate(() => window.__game.dispatch({ type: 'concede' }));
                log(0, 'conceded JSN via dispatch');
            }
        }

        await pages[0].waitForTimeout(600);

        await waitFor(pages[0], () => window.__game.state().pendingAction === null, 'JSN chain resolved', 10_000);

        const p1OrAfter = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );
        assert(p1OrAfter === p1OrBefore, `P1 kept all ORANGE props after JSN: ${p1OrBefore} → ${p1OrAfter}`, errors);
        assert(p1OrAfter > 0, `P1 still has ORANGE props on board`, errors);

        await screenshot(pages[0], '3-jsn-blocked-steal');
        await screenshot(pages[1], '3-p1-after-jsn');

        // ═════════════════════════════════════════════════════════════════════
        // SYNC CHECK
        // ═════════════════════════════════════════════════════════════════════
        step('Sync Check', 'All 3 machines agree on state');

        const snaps = await Promise.all(pages.map(p => p.evaluate(() => {
            const s = window.__game.state();
            return {
                turn: s.turn, md: s.mustDiscard,
                pending: !!s.pendingAction,
                p0hand: s.players[0].hand.length,
                p1hand: s.players[1].hand.length,
                p0bank: s.players[0].bank.length,
                p1bank: s.players[1].bank.length,
                p0props: Object.values(s.players[0].properties).flat().length,
                p1props: Object.values(s.players[1].properties).flat().length,
            };
        })));

        const refSnap = JSON.stringify(snaps[0]);
        let synced = true;
        for (let i = 1; i < snaps.length; i++) {
            if (JSON.stringify(snaps[i]) !== refSnap) {
                errors.push(`sync: ${tag(i)} disagrees — ${JSON.stringify(snaps[i])} vs ref ${refSnap}`);
                synced = false;
            }
        }
        if (synced) ok('All 3 machines fully in sync');
        console.log('  Final state:', JSON.stringify(snaps[0]));

    } catch (e) {
        errors.push(`FATAL: ${e.message}`);
        console.error('\n  FATAL:', e.message, e.stack ? '\n' + e.stack.split('\n').slice(0,5).join('\n') : '');
        if (browsers[0]) await browsers[0].page.screenshot({ path: path.join(OUT_DIR, 'fatal.png') }).catch(() => {});
    } finally {
        await Promise.all(browsers.map(b => b.browser.close().catch(() => {})));
        if (server) server.close();
    }

    // ─── Report ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    if (errors.length === 0) {
        console.log('  PASS — all scenarios passed');
    } else {
        console.log(`  FAIL — ${errors.length} error(s):`);
        errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
    }
    console.log('═'.repeat(60) + '\n');
    process.exit(errors.length === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
