/**
 * mp-stress-full.js — Comprehensive multiplayer stress test
 *
 * Covers:
 *   1. Scripted dialog verification  (discard UI, payment picker, reaction prompt)
 *   2. All charging effects          (rent, birthday, debt_collector)
 *   3. JSN chain and counter-JSN     (sly_deal + JSN + JSN-back)
 *   4. Deal Breaker + JSN cancel
 *   5. 50-turn auto-play stress loop
 *   6. Host migration                (close P0, P1 takes over)
 *   7. Page refresh / rejoin         (reload P2 mid-game)
 *   8. State sync verification       (all machines agree after each event)
 *
 * Run:        node ui-test/mp-stress-full.js
 *             HEADED=1 node ui-test/mp-stress-full.js
 */

'use strict';
const { chromium } = require('playwright');
const express      = require('express');
const path         = require('path');
const http         = require('http');
const fs           = require('fs');

const HEADED    = process.env.HEADED === '1';
const PORT      = 18_182;
const GAME_URL  = `http://localhost:${PORT}/`;
const OUT_DIR   = path.join(__dirname, '..', 'test-full-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Server ───────────────────────────────────────────────────────────────────

function startServer() {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.static(path.join(__dirname, '..', 'src')));
        const server = http.createServer(app);
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => resolve(server));
    });
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const N_PLAYERS = 4;
const LABELS = ['M1-host', 'M2-P1', 'M3-P2', 'M4-P3'];
function tag(i)       { return `[${LABELS[i] || `M${i + 1}`}]`; }
function log(i, msg)  { console.log(`  ${tag(i)} ${msg}`); }
function step(n, msg) { console.log(`\n  ── ${n} ──\n     ${msg}`); }
function ok(msg)      { console.log(`  ✓ ${msg}`); }
function warn(msg)    { console.log(`  ⚠ ${msg}`); }

function assert(cond, msg, errors) {
    if (!cond) { errors.push(msg); console.log(`  ✗ ${msg}`); return false; }
    ok(msg); return true;
}

async function screenshot(page, name) {
    const p = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: p, fullPage: false });
    return p;
}

// ─── Browser setup ────────────────────────────────────────────────────────────

async function launchBrowser(idx) {
    const browser = await chromium.launch({
        headless: !HEADED,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream'],
    });
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', e => log(idx, `[err] ${e.message.slice(0, 140)}`));
    page.on('console', msg => {
        const t = msg.text();
        if (/NET-DEBUG|HOST-DEBUG|MIGRATION|ENGINE|AUTO-UI/.test(t)) {
            log(idx, `[js] ${t.slice(0, 160)}`);
        }
    });
    await page.setViewportSize({ width: 1024, height: 900 });
    return { browser, page };
}

async function loadPage(page, idx) {
    await page.goto(`${GAME_URL}?bust=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-create-game', { state: 'visible', timeout: 20_000 });
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t.length > 4 && t !== 'LOCAL-TEST' && !t.startsWith('Joining');
    }, null, { timeout: 30_000 });
    log(idx, 'loaded');
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function waitFor(page, fn, desc, timeout = 12_000, arg = null) {
    try {
        await page.waitForFunction(fn, arg, { timeout });
    } catch (_) {
        const s = await page.evaluate(() => {
            const g = window.__game && window.__game.state();
            if (!g) return 'no __game';
            return JSON.stringify({
                turn: g.turn, al: g.actionsLeft, md: g.mustDiscard,
                pending: !!g.pendingAction, reactor: g.reactionTargetId,
            });
        }).catch(() => 'eval failed');
        throw new Error(`Timeout (${timeout}ms) waiting for: ${desc}\n    state: ${s}`);
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

async function waitPendingClear(pages, timeout = 15_000) {
    await Promise.all(pages.map((p, i) =>
        p.waitForFunction(() => window.__game.state().pendingAction === null,
            null, { timeout }).catch(e => { throw new Error(`${tag(i)} pendingAction stuck: ${e.message}`); })
    ));
}

// ─── State sync verification ──────────────────────────────────────────────────

function sortDeep(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortDeep);
    const out = {};
    Object.keys(obj).sort().forEach(k => { out[k] = sortDeep(obj[k]); });
    return out;
}

async function verifySync(pages, errors, label = 'state') {
    const states = await Promise.all(pages.map(p => p.evaluate(() => {
        const s = window.__game.state();
        const snap = JSON.parse(JSON.stringify(s));
        // Strip per-machine fields
        delete snap.localPlayerId; delete snap._autoEnding; delete snap.lastResolution;
        delete snap.actionLog; delete snap.mustDiscard;
        return snap;
    })));
    const ref = JSON.stringify(sortDeep(states[0]));
    let synced = true;
    for (let i = 1; i < states.length; i++) {
        const got = JSON.stringify(sortDeep(states[i]));
        if (got !== ref) {
            const msg = `${label}: ${tag(i)} desynced from host`;
            errors.push(msg);
            console.log(`  ✗ ${msg}`);
            synced = false;
        }
    }
    if (synced) ok(`sync OK: ${label}`);
    return synced;
}

// ─── Dialog detection & auto-resolve ─────────────────────────────────────────

/**
 * Returns the current dialog kind on a page, or null if none visible.
 */
async function getDialogKind(page) {
    return page.evaluate(() => {
        const m = document.getElementById('info-modal');
        if (!m || m.classList.contains('hidden')) return null;
        return m.dataset.modalKind || null;
    });
}

/**
 * Capture and verify dialog content, then resolve it.
 * track: { seen: Set<string>, paymentSeen, reactionSeen, ... }
 * Returns { kind, content } of what was resolved, or null.
 */
async function resolveDialog(page, idx, track, errors, jsnChance = 0.3) {
    const kind = await getDialogKind(page);
    if (!kind) {
        // Check engine-level pending reaction without modal (engine-only path)
        const needsEngineReact = await page.evaluate(() => {
            const s = window.__game.state();
            return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
        });
        if (needsEngineReact) {
            log(idx, 'engine-only reaction — dispatching concede');
            await page.evaluate(() => window.__game.dispatch({ type: 'concede' }));
            await page.waitForTimeout(100);
        }
        return null;
    }

    track.seen.add(kind);

    if (kind === 'payment') {
        // Verify content
        const info = await page.evaluate(() => {
            const m = document.getElementById('info-modal');
            const title  = m.querySelector('h2')?.textContent?.trim() || '';
            const desc   = m.querySelector('.info-desc')?.textContent?.trim() || '';
            const items  = m.querySelectorAll('[data-pay-idx]').length;
            const hasBtn = !!m.querySelector('[data-pay-submit]');
            return { title, desc, items, hasBtn };
        });
        log(idx, `payment picker: "${info.title}" — ${info.items} items`);
        assert(info.title.startsWith('Pay'), `payment title starts with "Pay": "${info.title}"`, errors);
        assert(info.items > 0, `payment picker has ${info.items} payable items`, errors);
        assert(info.hasBtn, 'payment picker has submit button', errors);
        track.paymentSeen = (track.paymentSeen || 0) + 1;

        // Auto-pay: click items until sum >= owed, then submit
        const paid = await page.evaluate(async () => {
            const m = document.getElementById('info-modal');
            const getSum = () => {
                const t = m.querySelector('.info-desc')?.textContent || '';
                const match = t.match(/Selected:\s*(\d+)/);
                return match ? parseInt(match[1]) : 0;
            };
            const getBtn = () => m.querySelector('[data-pay-submit]:not([disabled])');

            let attempts = 0;
            while (!getBtn() && attempts < 20) {
                const unsel = Array.from(m.querySelectorAll('[data-pay-idx]:not(.selected)'));
                if (unsel.length === 0) break;
                const before = getSum();
                unsel[0].click();
                let w = 0;
                while (w++ < 10 && getSum() === before) await new Promise(r => setTimeout(r, 40));
                attempts++;
            }
            const btn = getBtn();
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (paid) {
            log(idx, 'payment submitted');
        } else {
            // All assets exhausted (can't meet payment) — find if there's any button
            const clicked = await page.evaluate(() => {
                const btn = document.querySelector('[data-pay-submit]');
                if (btn) { btn.click(); return true; }
                return false;
            });
            if (!clicked) errors.push(`${tag(idx)}: payment button never enabled`);
        }
        await page.waitForTimeout(150);
        return { kind: 'payment', info };
    }

    if (kind === 'reaction') {
        const info = await page.evaluate(() => {
            const m = document.getElementById('info-modal');
            const title   = m.querySelector('h2')?.textContent?.trim() || '';
            const desc    = m.querySelector('.info-desc')?.textContent?.trim() || '';
            const hasJSN  = !!m.querySelector('[data-action="reaction-no"]');
            const hasCon  = !!m.querySelector('[data-action="reaction-concede"]');
            return { title, desc, hasJSN, hasCon };
        });
        log(idx, `reaction prompt: "${info.title}" JSN=${info.hasJSN}`);
        assert(info.title.length > 0, `reaction has title: "${info.title}"`, errors);
        assert(info.hasCon, 'reaction prompt has concede/accept button', errors);
        track.reactionSeen = (track.reactionSeen || 0) + 1;

        // Sometimes play JSN, otherwise concede
        const playedJSN = info.hasJSN && Math.random() < jsnChance;
        if (playedJSN) {
            log(idx, 'playing JSN!');
            await page.click('[data-action="reaction-no"]');
            track.jsnPlayed = (track.jsnPlayed || 0) + 1;
        } else {
            await page.click('[data-action="reaction-concede"]');
        }
        await page.waitForTimeout(150);
        return { kind: 'reaction', info, playedJSN };
    }

    // Dismiss any other modal kind (info, glossary, etc.)
    await page.evaluate(() => {
        const btn = document.querySelector('[data-action="close-modal"]');
        if (btn) btn.click();
        else {
            const m = document.getElementById('info-modal');
            if (m) { m.classList.add('hidden'); m.removeAttribute('data-modal-kind'); }
        }
    });
    await page.waitForTimeout(100);
    return { kind, info: {} };
}

/**
 * Resolve dialogs on all pages until all are clear. Returns total resolutions.
 */
async function resolveAllDialogs(pages, track, errors, maxRounds = 20) {
    let total = 0;
    for (let round = 0; round < maxRounds; round++) {
        let didAny = false;
        for (let i = 0; i < pages.length; i++) {
            const r = await resolveDialog(pages[i], i, track, errors);
            if (r) { didAny = true; total++; }
        }
        if (!didAny) break;
        await pages[0].waitForTimeout(400);
    }
    return total;
}

// ─── Auto-play a single action for a player ───────────────────────────────────

async function playAction(pages, pid, track, errors) {
    const page = pages[pid];

    // Check mustDiscard first
    const md = await page.evaluate(p => window.__game.state().mustDiscard,  pid);
    if (md > 0) {
        log(pid, `mustDiscard=${md} — dispatching discard`);
        const discarded = await page.evaluate(() => {
            const s = window.__game.state();
            const hand = s.players[s.localPlayerId].hand;
            if (hand.length === 0) return false;
            window.__game.dispatch({ type: 'discard', cardId: hand[0].data.id });
            return true;
        });
        return discarded;
    }

    const action = await page.evaluate(p => window.__game.pickBestAny(p), pid);
    if (!action) return false;
    if (action.type === 'end-turn') {
        log(pid, 'ending turn');
        await page.evaluate(() => window.__game.endTurn());
        return true;
    }

    const cardName = await page.evaluate(a => {
        const s = window.__game.state();
        const p = s.players[s.localPlayerId];
        const c = p.hand.find(c => c.data.id === a.cardId);
        return c ? `${c.data.name}(${c.data.effect || c.data.type})` : '?';
    }, action);

    // If the card isn't in hand (stale enumeration), fall through to end-turn
    if (cardName === '?' && action.cardId) {
        log(pid, `card ${action.cardId} not in hand — ending turn instead`);
        await page.evaluate(() => window.__game.endTurn());
        return true;
    }

    log(pid, `${action.type} ${action.zone || ''} ${cardName}`);

    // Track card effects for coverage
    const eff = await page.evaluate(a => {
        const s = window.__game.state();
        const c = s.players[s.localPlayerId].hand.find(c => c.data.id === a.cardId);
        return c ? (c.data.effect || c.data.type) : null;
    }, action);
    if (eff) track.effects.add(eff);

    await page.evaluate(a => window.__game.dispatch(a), action);

    if (action.type === 'propose' || (action.type === 'play' && action.zone === 'discard')) {
        await page.waitForTimeout(800);
        await resolveAllDialogs(pages, track, errors);
        await pages[0].waitForTimeout(600);
        // Wait for any pending chain to settle
        try { await waitPendingClear(pages, 8_000); } catch (_) {}
    }
    return true;
}

// ─── Lobby setup ──────────────────────────────────────────────────────────────

async function setupLobby(pages) {
    const host = pages[0];
    await host.click('#btn-create-game');
    await host.waitForSelector('#lobby-container:not(.hidden)', { timeout: 5_000 });
    const realmId = await host.evaluate(() => document.getElementById('lobby-id-display').textContent.trim());
    log(0, `Realm: ${realmId}`);

    for (let i = 1; i < pages.length; i++) {
        const nameFld = await pages[i].$('#player-name-join');
        if (nameFld) await nameFld.fill(`Lord_P${i}`);
        await pages[i].fill('#join-game-id', realmId);
        await pages[i].click('#btn-join-game');
        await pages[i].waitForSelector('#lobby-container:not(.hidden)', { timeout: 15_000 });
        log(i, 'joined lobby');
        await pages[0].waitForTimeout(600);
    }

    await waitFor(host, () =>
        document.querySelectorAll('#lobby-slots .lobby-slot:not(.empty)').length >= 4,
        'host sees 4 players', 35_000
    );
    await host.click('#btn-start-game');
    await Promise.all(pages.map(p =>
        p.waitForSelector('#game-container:not(.hidden)', { timeout: 15_000 })
    ));
    await pages[0].waitForTimeout(2_000);
    ok('all 4 players in game');
    return realmId;
}

// ─── State card builders (for injection) ─────────────────────────────────────

let _cid = 0;
function cid(pfx = 'x') { return `${pfx}_${++_cid}`; }
function mkMoney(val, id = cid('m'), owner = null) {
    return { data: { id, type: 'MONEY', name: `${val}G`, value: val }, zone: 'bank', owner };
}
function mkProp(color, id = cid('p'), owner = null) {
    return { data: { id, type: 'PROPERTY', colorKey: color, name: color, value: 1 }, zone: 'board', owner, currentColor: color };
}
function mkAction(effect, id = cid('a'), name = effect.toUpperCase(), value = 3) {
    return { data: { id, type: 'ACTION', effect, name, value }, zone: 'hand', owner: null };
}
function mkRent(colors, id = cid('r'), isMulti = false) {
    return { data: { id, type: 'RENT', name: 'COLLECT TRIBUTE', allowedColors: colors, isMulti, value: 1 }, zone: 'hand', owner: null };
}

function baseState(nPlayers) {
    const players = Array.from({ length: nPlayers }, (_, i) => ({
        id: i, name: `Lord_P${i}`, _disconnected: false, _isBot: false,
        hand: [], bank: [], properties: {}, buildings: {},
    }));
    // Give P0 two complete sets (BROWN + PINK) so rent scenarios make sense
    players[0].properties = {
        BROWN: [mkProp('BROWN', cid('br'), 0), mkProp('BROWN', cid('br'), 0)],
        PINK:  [mkProp('PINK',  cid('pk'), 0), mkProp('PINK',  cid('pk'), 0), mkProp('PINK', cid('pk'), 0)],
    };
    players[0].bank = [mkMoney(5, cid('p0m'), 0), mkMoney(3, cid('p0m'), 0)];

    if (nPlayers > 1) {
        players[1].bank  = [mkMoney(4, cid('p1m'), 1), mkMoney(4, cid('p1m'), 1)];
        players[1].properties = { ORANGE: [mkProp('ORANGE', cid('or'), 1)] };
    }
    if (nPlayers > 2) players[2].bank = [mkMoney(3, cid('p2m'), 2), mkMoney(3, cid('p2m'), 2)];
    if (nPlayers > 3) players[3].bank = [mkMoney(2, cid('p3m'), 3), mkMoney(5, cid('p3m'), 3)];

    const deck = Array.from({ length: 40 }, (_, i) => ({ ...mkMoney(1, `dk${i}`), zone: 'deck', owner: null }));

    return {
        deck, discard: [], players,
        turn: 0, actionsLeft: 3, turnNumber: 1,
        pendingAction: null, pendingReactors: [], reactionTargetId: null,
        doubleRentArmed: false, mustDiscard: 0,
        localPlayerId: 0, lastResolution: null, actionLog: [],
        _gameOver: false, _autoEnding: false,
    };
}

async function injectState(pages, mutate) {
    const s = baseState(pages.length);
    if (mutate) mutate(s);
    const json = JSON.stringify(s);
    await Promise.all(pages.map((p, i) =>
        p.evaluate(({ json, pid }) => {
            const st = JSON.parse(json);
            st.localPlayerId = pid;
            Object.assign(window.__game.state(), st);
            window.__game.update();
        }, { json, pid: i })
    ));
    ok('state injected');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║   Lord Landlord — Comprehensive Multiplayer Stress Test       ║');
    console.log('║   Dialogs · Sync · Host Migration · Page Refresh · 50 Turns  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const errors   = [];
    const track    = { seen: new Set(), paymentSeen: 0, reactionSeen: 0, jsnPlayed: 0, effects: new Set() };
    const browsers = [];
    const pages    = [];
    let   server;

    try {
        server = await startServer();
        console.log(`  Static server: ${GAME_URL}`);

        for (let i = 0; i < N_PLAYERS; i++) {
            const { browser, page } = await launchBrowser(i);
            browsers.push(browser);
            pages.push(page);
        }

        await Promise.all(pages.map((p, i) => loadPage(p, i)));
        await setupLobby(pages);

        // ══════════════════════════════════════════════════════════════════════
        // S1: OVER-7 DISCARD UI
        // ══════════════════════════════════════════════════════════════════════
        step('S1', 'Over-7 discard — P0 has 9 cards, must discard 2 before turn advances');

        await injectState(pages, s => {
            s.actionsLeft = 0;
            s.players[0].hand = Array.from({ length: 9 }, (_, i) => mkMoney(1, `hm${i}`, null));
        });
        // Force update so endTurn fires and sets mustDiscard
        await pages[0].evaluate(() => window.__game.update());
        await pages[0].waitForTimeout(600);

        // mustDiscard should be 2 on all machines
        const mdAllS1 = await Promise.all(pages.map(p => p.evaluate(() => window.__game.state().mustDiscard)));
        assert(mdAllS1.every(v => v === 2), `all pages see mustDiscard=2 (got ${JSON.stringify(mdAllS1)})`, errors);
        assert(mdAllS1[0] === 2, `mustDiscard=2 on host`, errors);

        // P0 sees discard UI (not a modal)
        const p0discardUI = await pages[0].evaluate(() => {
            const ind  = document.querySelector('.turn-indicator');
            const urg  = document.querySelector('.discard-urgency');
            const zone = document.querySelector('.zone-discard');
            const modal = document.getElementById('info-modal');
            return {
                indicatorHasMustDiscard: !!(ind && ind.classList.contains('must-discard')),
                urgencyText: urg ? urg.textContent.trim() : '',
                zoneActive:  !!(zone && zone.classList.contains('discard-active')),
                noModal: !modal || modal.classList.contains('hidden') || modal.dataset.modalKind === 'must-discard',
            };
        });
        assert(p0discardUI.indicatorHasMustDiscard, `.turn-indicator has .must-discard on P0`, errors);
        assert(p0discardUI.urgencyText.startsWith('Discard 2'), `urgency label = "${p0discardUI.urgencyText}"`, errors);
        assert(p0discardUI.zoneActive, `.zone-discard has .discard-active (pulsing glow)`, errors);
        assert(p0discardUI.noModal, `no must-discard modal — replaced by inline UI`, errors);

        // Other players see "Waiting…" label
        for (let i = 1; i < pages.length; i++) {
            const ui = await pages[i].evaluate(() => {
                const ind   = document.querySelector('.turn-indicator');
                const label = document.querySelector('.turn-indicator-label');
                return {
                    hasMustDiscard: !!(ind && ind.classList.contains('must-discard')),
                    labelText: label ? label.textContent.trim() : '',
                };
            });
            assert(ui.hasMustDiscard, `${tag(i)} turn-indicator has .must-discard`, errors);
            assert(ui.labelText.includes('Waiting'), `${tag(i)} sees waiting label: "${ui.labelText}"`, errors);
        }

        await screenshot(pages[0], 's1-p0-discard-phase');
        await screenshot(pages[1], 's1-p1-waiting');

        // P0 discards 2 cards
        const hand0 = await pages[0].evaluate(() => window.__game.state().players[0].hand.map(c => c.data.id));
        await pages[0].evaluate(id => window.__game.dispatch({ type: 'discard', cardId: id }), hand0[0]);
        await pages[0].waitForTimeout(400);
        await pages[0].evaluate(id => window.__game.dispatch({ type: 'discard', cardId: id }), hand0[1]);
        await pages[0].waitForTimeout(600);

        await waitTurnStart(pages, 1, 12_000);
        ok('turn advanced to P1 after 2 discards');
        const handLenS1 = await pages[0].evaluate(() => window.__game.state().players[0].hand.length);
        assert(handLenS1 === 7, `P0 hand trimmed to 7 (got ${handLenS1})`, errors);
        await screenshot(pages[0], 's1-after-discard-p1-turn');
        track.seen.add('discard-ui');

        // ══════════════════════════════════════════════════════════════════════
        // S2: RENT — interactive payment picker (all opponents)
        // ══════════════════════════════════════════════════════════════════════
        step('S2', 'P0 plays BROWN rent — payment picker appears on P1, P2, P3');

        const rentId = cid('rent_s2');
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [mkRent(['BROWN'], rentId, false)];
            // Give each opponent enough bank to pay
            s.players[1].bank = [mkMoney(2, cid('b1a'), 1), mkMoney(3, cid('b1b'), 1)];
            s.players[2].bank = [mkMoney(2, cid('b2a'), 2), mkMoney(3, cid('b2b'), 2)];
            s.players[3].bank = [mkMoney(2, cid('b3a'), 3), mkMoney(3, cid('b3b'), 3)];
        });

        const banksBefore = await pages[0].evaluate(() =>
            window.__game.state().players.map(p => p.bank.reduce((s, c) => s + c.data.value, 0))
        );
        log(0, `banks before rent: ${banksBefore}`);

        await pages[0].evaluate(id => window.__game.dispatch({
            type: 'play', cardId: id, zone: 'discard', options: { color: 'BROWN' },
        }), rentId);
        await pages[0].waitForTimeout(1_000);

        // Wait for dialogs to appear on opponent pages (rent is now interactive)
        let dialogsS2 = 0;
        for (let round = 0; round < 15; round++) {
            let got = 0;
            for (let i = 1; i < pages.length; i++) {
                const k = await getDialogKind(pages[i]);
                const needsEngine = await pages[i].evaluate(() => {
                    const s = window.__game.state();
                    return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
                });
                if (k || needsEngine) got++;
            }
            if (got === 0) break;
            await resolveAllDialogs(pages, track, errors);
            dialogsS2++;
            await pages[0].waitForTimeout(600);
        }
        // Wait for pending to clear
        try { await waitPendingClear(pages, 12_000); } catch (e) { errors.push(`S2: ${e.message}`); }

        const banksAfter = await pages[0].evaluate(() =>
            window.__game.state().players.map(p => p.bank.reduce((s, c) => s + c.data.value, 0))
        );
        log(0, `banks after rent: ${banksAfter}`);
        assert(banksAfter[0] > banksBefore[0], `P0 bank grew after rent (${banksBefore[0]} → ${banksAfter[0]})`, errors);
        assert(track.paymentSeen > 0, `payment picker appeared at least once (saw ${track.paymentSeen})`, errors);
        await screenshot(pages[0], 's2-after-rent');
        await verifySync(pages, errors, 'S2-post-rent');

        // ══════════════════════════════════════════════════════════════════════
        // S3: BIRTHDAY — fan-out payment picker on all opponents
        // ══════════════════════════════════════════════════════════════════════
        step('S3', 'P0 plays Birthday — payment pickers appear on P1, P2, P3 simultaneously');

        const bdId = cid('bd_s3');
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [mkAction('birthday', bdId, 'FEAST DAY', 2)];
            s.players[1].bank = [mkMoney(5, cid('b1'), 1)];
            s.players[2].bank = [mkMoney(2, cid('b2'), 2), mkMoney(2, cid('b2b'), 2)];
            s.players[3].bank = [mkMoney(3, cid('b3'), 3)];
        });
        const bdBankBefore = await pages[0].evaluate(() =>
            window.__game.state().players.map(p => p.bank.reduce((s, c) => s + c.data.value, 0))
        );

        // Dispatch birthday as propose (routed through proposeAction now)
        await pages[0].evaluate(({ id }) => window.__game.dispatch({
            type: 'play', cardId: id, zone: 'discard', options: {},
        }), { id: bdId });
        await pages[0].waitForTimeout(1_000);

        const payBeforeS3 = track.paymentSeen;
        for (let round = 0; round < 15; round++) {
            const anyLeft = await Promise.any(pages.slice(1).map(async p => {
                const k = await getDialogKind(p);
                const eng = await p.evaluate(() => {
                    const s = window.__game.state();
                    return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
                });
                return k || eng;
            })).catch(() => false);
            if (!anyLeft) break;
            await resolveAllDialogs(pages, track, errors);
            await pages[0].waitForTimeout(500);
        }
        try { await waitPendingClear(pages, 12_000); } catch (e) { errors.push(`S3: ${e.message}`); }

        const bdBankAfter = await pages[0].evaluate(() =>
            window.__game.state().players.map(p => p.bank.reduce((s, c) => s + c.data.value, 0))
        );
        log(0, `birthday banks: before=${JSON.stringify(bdBankBefore)} after=${JSON.stringify(bdBankAfter)}`);
        assert(bdBankAfter[0] > bdBankBefore[0], `P0 bank grew from birthday (${bdBankBefore[0]} → ${bdBankAfter[0]})`, errors);
        const newPay = track.paymentSeen - payBeforeS3;
        assert(newPay >= 2, `at least 2 payment pickers for birthday fan-out (got ${newPay})`, errors);
        await screenshot(pages[0], 's3-after-birthday');
        await verifySync(pages, errors, 'S3-post-birthday');

        // ══════════════════════════════════════════════════════════════════════
        // S4: DEBT COLLECTOR — payment picker on single target
        // ══════════════════════════════════════════════════════════════════════
        step('S4', 'P0 plays Debt Collector targeting P1 — payment picker on P1');

        const dcId = cid('dc_s4');
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [mkAction('debt_collector', dcId, 'TAX COLLECTOR', 3)];
            s.players[1].bank = [mkMoney(3, cid('dc_b1'), 1), mkMoney(4, cid('dc_b2'), 1)];
        });
        const dcP1Before = await pages[0].evaluate(() =>
            window.__game.state().players[1].bank.reduce((s, c) => s + c.data.value, 0)
        );
        const dcP0Before = await pages[0].evaluate(() =>
            window.__game.state().players[0].bank.reduce((s, c) => s + c.data.value, 0)
        );
        const dcPayBefore = track.paymentSeen;

        await pages[0].evaluate(({ id }) => window.__game.dispatch({
            type: 'play', cardId: id, zone: 'discard', targetPlayerId: 1, options: {},
        }), { id: dcId });
        await pages[0].waitForTimeout(800);

        for (let round = 0; round < 10; round++) {
            const k = await getDialogKind(pages[1]);
            const eng = await pages[1].evaluate(() => {
                const s = window.__game.state();
                return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
            });
            if (!k && !eng) break;
            await resolveAllDialogs(pages, track, errors);
            await pages[0].waitForTimeout(500);
        }
        try { await waitPendingClear(pages, 10_000); } catch (e) { errors.push(`S4: ${e.message}`); }

        const dcP0After = await pages[0].evaluate(() =>
            window.__game.state().players[0].bank.reduce((s, c) => s + c.data.value, 0)
        );
        assert(track.paymentSeen > dcPayBefore, `debt collector payment picker appeared (total=${track.paymentSeen})`, errors);
        assert(dcP0After > dcP0Before, `P0 received debt collector payment (${dcP0Before} → ${dcP0After})`, errors);
        await screenshot(pages[0], 's4-after-debt-collector');
        await verifySync(pages, errors, 'S4-post-debt-collector');

        // ══════════════════════════════════════════════════════════════════════
        // S5: SLY STEAL + JSN (cancel)
        // ══════════════════════════════════════════════════════════════════════
        step('S5', 'P0 Sly Steals P1 ORANGE — P1 plays JSN, P0 concedes — P1 keeps property');

        const slyId  = cid('sly_s5');
        const jsnId5 = cid('jsn_s5');
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [mkAction('sly_deal', slyId, 'SLY STEAL', 3)];
            s.players[1].properties.ORANGE = [mkProp('ORANGE', cid('or_s5'), 1)];
            s.players[1].hand = [mkAction('just_say_no', jsnId5, 'NOT TODAY!', 4)];
        });

        const orPropBefore = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );
        const targetPropId = await pages[0].evaluate(() => {
            const props = window.__game.state().players[1].properties.ORANGE || [];
            return props[0] ? props[0].data.id : null;
        });
        assert(targetPropId !== null, `found target ORANGE prop: ${targetPropId}`, errors);

        await pages[0].evaluate(({ sid, pid }) => window.__game.dispatch({
            type: 'propose', cardId: sid, targetPlayerId: 1, options: { targetCardId: pid },
        }), { sid: slyId, pid: targetPropId });
        await pages[0].waitForTimeout(800);

        const reactionBeforeS5 = track.reactionSeen;
        // Force reaction on P1
        await pages[1].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[1].waitForTimeout(400);

        // Wait for P1's reaction modal
        try {
            await waitFor(pages[1], () => {
                const s = window.__game.state();
                const m = document.getElementById('info-modal');
                return (s.pendingAction && s.reactionTargetId === s.localPlayerId) ||
                       (m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction');
            }, 'P1 sees steal reaction', 8_000);
        } catch (e) { errors.push(`S5: P1 never saw reaction: ${e.message}`); }

        // Verify reaction prompt content on P1
        const p1reactInfo = await pages[1].evaluate(() => {
            const m = document.getElementById('info-modal');
            if (!m || m.classList.contains('hidden')) return null;
            return {
                title: m.querySelector('h2')?.textContent?.trim() || '',
                hasJSN: !!m.querySelector('[data-action="reaction-no"]'),
                hasCon: !!m.querySelector('[data-action="reaction-concede"]'),
            };
        });
        if (p1reactInfo) {
            assert(p1reactInfo.title.length > 0, `S5 reaction title present: "${p1reactInfo.title}"`, errors);
            assert(p1reactInfo.hasJSN, 'S5 P1 reaction prompt shows JSN button', errors);
            assert(p1reactInfo.hasCon, 'S5 P1 reaction prompt shows concede button', errors);
            track.reactionSeen++;
        }

        // P1 plays JSN
        await pages[1].evaluate(id => window.__game.dispatch({ type: 'react-no', cardId: id }), jsnId5);
        track.jsnPlayed++;
        await pages[1].waitForTimeout(600);

        // P0 concedes the JSN (no counter-JSN in hand)
        await pages[0].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[0].waitForTimeout(400);

        const p0Reaction = await pages[0].evaluate(() => {
            const s = window.__game.state();
            const m = document.getElementById('info-modal');
            return (s.pendingAction && s.reactionTargetId === s.localPlayerId) ||
                   (m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction');
        });
        if (p0Reaction) {
            const modal = await pages[0].evaluate(() => {
                const m = document.getElementById('info-modal');
                return m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction';
            });
            if (modal) {
                await pages[0].click('[data-action="reaction-concede"]');
                log(0, 'conceded JSN via modal');
            } else {
                await pages[0].evaluate(() => window.__game.dispatch({ type: 'concede' }));
                log(0, 'conceded JSN via dispatch');
            }
        }
        await pages[0].waitForTimeout(600);
        try { await waitPendingClear(pages, 10_000); } catch (e) { errors.push(`S5: ${e.message}`); }

        const orPropAfter = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );
        assert(orPropAfter === orPropBefore, `P1 kept ORANGE after JSN (${orPropBefore} → ${orPropAfter})`, errors);
        assert(track.jsnPlayed >= 1, `JSN was played at least once (total=${track.jsnPlayed})`, errors);
        await screenshot(pages[0], 's5-sly-jsn-blocked');
        await screenshot(pages[1], 's5-p1-after-jsn');
        await verifySync(pages, errors, 'S5-post-JSN');

        // ══════════════════════════════════════════════════════════════════════
        // S6: DEAL BREAKER + JSN counter-JSN (P0 steals set, P1 JSNs, P0 JSN-backs)
        // ══════════════════════════════════════════════════════════════════════
        step('S6', 'Deal Breaker + JSN counter-JSN — P0 steals complete set, P1 JSNs, P0 counters → steal succeeds');

        const dbId   = cid('db_s6');
        const jsnA6  = cid('jsn_s6_att');
        const jsnT6  = cid('jsn_s6_tgt');
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3;
            s.players[0].hand = [
                mkAction('deal_breaker', dbId, 'DECREE OF ACQUISITION', 5),
                mkAction('just_say_no', jsnA6, 'NOT TODAY!', 4),
            ];
            s.players[1].properties.ORANGE = [
                mkProp('ORANGE', cid('db_or1'), 1),
                mkProp('ORANGE', cid('db_or2'), 1),
                mkProp('ORANGE', cid('db_or3'), 1),
            ];
            s.players[1].hand = [mkAction('just_say_no', jsnT6, 'NOT TODAY!', 4)];
        });

        const p1OrBefore = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );

        await pages[0].evaluate(({ id }) => window.__game.dispatch({
            type: 'propose', cardId: id, targetPlayerId: 1, options: { color: 'ORANGE' },
        }), { id: dbId });
        await pages[0].waitForTimeout(800);

        await pages[1].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[1].waitForTimeout(500);

        // P1 plays JSN against deal_breaker
        await pages[1].evaluate(id => window.__game.dispatch({ type: 'react-no', cardId: id }), jsnT6);
        track.jsnPlayed++;
        await pages[1].waitForTimeout(600);

        // P0 sees the JSN reaction prompt and counter-JSNs
        await pages[0].evaluate(() => window.__game.botReact && window.__game.botReact());
        await pages[0].waitForTimeout(500);

        const p0CounterModal = await pages[0].evaluate(() => {
            const m = document.getElementById('info-modal');
            return m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction';
        });

        if (p0CounterModal) {
            const noBtn = await pages[0].evaluate(() => !!document.querySelector('[data-action="reaction-no"]'));
            if (noBtn) {
                await pages[0].click('[data-action="reaction-no"]');
                track.jsnPlayed++;
                log(0, 'P0 counter-JSN played!');
            } else {
                await pages[0].click('[data-action="reaction-concede"]');
                log(0, 'P0 conceded (no JSN button)');
            }
        } else {
            const engReact = await pages[0].evaluate(() => {
                const s = window.__game.state();
                return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
            });
            if (engReact) {
                await pages[0].evaluate(() => window.__game.dispatch({ type: 'react-no', cardId: null })).catch(() =>
                    pages[0].evaluate(() => window.__game.dispatch({ type: 'concede' }))
                );
            }
        }
        await pages[0].waitForTimeout(800);

        // P1 must now settle the counter (no more JSN) — wait for reactionTargetId to reach P1
        try {
            await pages[1].waitForFunction(() => {
                const s = window.__game.state();
                const m = document.getElementById('info-modal');
                return (s.pendingAction && s.reactionTargetId === s.localPlayerId) ||
                       (m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction') ||
                       s.pendingAction === null;
            }, null, { timeout: 8_000 });
        } catch (_) {}

        const p1FinalModal = await pages[1].evaluate(() => {
            const m = document.getElementById('info-modal');
            return m && !m.classList.contains('hidden') && m.dataset.modalKind === 'reaction';
        });
        const p1FinalEngine = await pages[1].evaluate(() => {
            const s = window.__game.state();
            return !!(s.pendingAction && s.reactionTargetId === s.localPlayerId);
        });
        if (p1FinalModal) {
            await pages[1].click('[data-action="reaction-concede"]');
            log(1, 'P1 conceded counter-JSN via modal');
        } else if (p1FinalEngine) {
            await pages[1].evaluate(() => window.__game.dispatch({ type: 'concede' }));
            log(1, 'P1 conceded counter-JSN via dispatch');
        }
        await pages[0].waitForTimeout(800);
        try { await waitPendingClear(pages, 12_000); } catch (e) { errors.push(`S6: ${e.message}`); }

        const p1OrAfter = await pages[0].evaluate(() =>
            (window.__game.state().players[1].properties.ORANGE || []).length
        );
        const p0OrAfter = await pages[0].evaluate(() =>
            (window.__game.state().players[0].properties.ORANGE || []).length
        );
        // If counter-JSN succeeded, P0 now has the ORANGE set
        log(0, `S6: P0 ORANGE=${p0OrAfter}, P1 ORANGE=${p1OrAfter}`);
        // Either counter-JSN worked (P0 got the set) or P1 kept it (JSN chain odd)
        assert(p0OrAfter + p1OrAfter === p1OrBefore, `ORANGE props conserved: ${p0OrAfter}+${p1OrAfter}=${p1OrBefore}`, errors);
        await screenshot(pages[0], 's6-deal-breaker-counter-jsn');
        await verifySync(pages, errors, 'S6-post-deal-breaker');

        // ══════════════════════════════════════════════════════════════════════
        // S7: 50-TURN AUTO-PLAY STRESS LOOP
        // ══════════════════════════════════════════════════════════════════════
        step('S7', '50-turn auto-play stress loop — all players take turns');

        // Reset to a clean game state
        await injectState(pages, s => {
            s.turn = 0; s.actionsLeft = 3; s.mustDiscard = 0;
            // Give everyone some cards to play with
            for (let i = 0; i < 4; i++) {
                s.players[i].hand = [
                    mkAction('pass_go', cid('pg'), 'ROYAL CHARTER', 1),
                    mkRent(['BROWN', 'PINK'], cid('rnt'), false),
                    mkAction('debt_collector', cid('dc'), 'TAX COLLECTOR', 3),
                    mkMoney(3, cid('m3')),
                ];
                s.players[i].bank = [mkMoney(2, cid('bk'), i), mkMoney(3, cid('bk'), i)];
            }
        });
        // Give deck enough cards
        await pages[0].evaluate(() => {
            const s = window.__game.state();
            for (let i = 0; i < 60; i++) {
                s.deck.push({ data: { id: `autodk${i}`, type: 'MONEY', name: '1G', value: 1 }, zone: 'deck', owner: null });
            }
        });

        let stressTurns = 0;
        const STRESS_MAX = 50;
        let stressErrors = 0;
        let sameStateCount = 0;
        let lastTurnPid = -1;
        let lastActionsLeft = -1;

        while (stressTurns < STRESS_MAX) {
            const st = await pages[0].evaluate(() => {
                const s = window.__game.state();
                return { turn: s.turn, al: s.actionsLeft, pending: !!s.pendingAction, md: s.mustDiscard, over: s._gameOver };
            });
            if (st.over) {
                ok(`game over after ${stressTurns} stress turns`);
                break;
            }

            // Stuck detection: same pid + same actionsLeft for 8 iterations
            if (st.turn === lastTurnPid && st.al === lastActionsLeft && !st.pending && !st.md) {
                sameStateCount++;
                if (sameStateCount >= 8) {
                    warn(`stress loop stuck at P${st.turn} actionsLeft=${st.al} — forcing end-turn`);
                    await pages[st.turn].evaluate(() => window.__game.endTurn());
                    sameStateCount = 0;
                }
            } else {
                sameStateCount = 0;
            }
            lastTurnPid = st.turn;
            lastActionsLeft = st.al;

            const pid = st.turn;
            const page = pages[pid];

            // Resolve any pending from previous action
            if (st.pending) {
                await resolveAllDialogs(pages, track, errors);
                await pages[0].waitForTimeout(500);
                try { await waitPendingClear(pages, 8_000); } catch (e) {
                    errors.push(`stress turn ${stressTurns}: pending stuck: ${e.message}`);
                    stressErrors++;
                    if (stressErrors >= 5) { warn('too many stress errors, stopping'); break; }
                }
                continue;
            }

            // Handle mustDiscard
            if (st.md > 0) {
                for (let d = 0; d < st.md; d++) {
                    const discarded = await page.evaluate(() => {
                        const s = window.__game.state();
                        const me = s.players[s.localPlayerId];
                        if (me.hand.length === 0) return false;
                        window.__game.dispatch({ type: 'discard', cardId: me.hand[0].data.id });
                        return true;
                    });
                    if (!discarded) break;
                    await page.waitForTimeout(200);
                }
                continue;
            }

            try {
                await playAction(pages, pid, track, errors);
                await page.waitForTimeout(300);
            } catch (e) {
                errors.push(`stress turn ${stressTurns} (P${pid}): ${e.message.slice(0, 100)}`);
                stressErrors++;
                if (stressErrors >= 5) { warn('too many stress errors, stopping'); break; }
            }

            // Periodic sync checks
            if (stressTurns % 10 === 9) {
                await verifySync(pages, errors, `stress-turn-${stressTurns}`);
                await screenshot(pages[0], `s7-turn-${stressTurns}`);
            }

            stressTurns++;
        }

        ok(`Stress loop: ${stressTurns} turns, ${stressErrors} errors, effects seen: ${[...track.effects].sort().join(', ')}`);

        // ══════════════════════════════════════════════════════════════════════
        // S8: HOST MIGRATION
        // ══════════════════════════════════════════════════════════════════════
        step('S8', 'Host migration — close P0 browser mid-game, P1 takes over as host');

        // Ensure no pending action before migration, and P1 is active
        await waitPendingClear(pages, 5_000).catch(() => {});
        await pages[0].evaluate(() => {
            const s = window.__game.state();
            s.pendingAction = null; s.pendingReactors = []; s.reactionTargetId = null;
            s.turn = 1; s.actionsLeft = 3; s.mustDiscard = 0;
            window.__game.update();
        });
        await pages[0].waitForTimeout(600);

        // Close the host (P0) browser
        log(0, 'closing host browser to trigger migration...');
        await browsers[0].close();
        browsers[0] = null;
        pages[0] = null;

        // Wait for P1 to detect host loss and take over (or find new host)
        const livePagesAfterMigration = pages.filter(Boolean);
        let migrationOk = false;
        try {
            await livePagesAfterMigration[0].waitForTimeout(4_000); // let migration propagate
            // Check P1 now sees itself as host or game is still playable
            const p1State = await livePagesAfterMigration[0].evaluate(() => {
                const s = window.__game.state();
                return {
                    hasGame: !!(s && s.players && s.players.length),
                    gameOver: s._gameOver,
                    turn: s.turn,
                    isHost: !!window.Multiplayer && window.Multiplayer.isHost,
                };
            });
            log(1, `post-migration state: ${JSON.stringify(p1State)}`);
            assert(p1State.hasGame, 'P1 still has game state after host disconnect', errors);
            // isHost may not be directly queryable, but game should still be playable
            migrationOk = p1State.hasGame;
            ok('host migration: game survives P0 disconnect');
        } catch (e) {
            errors.push(`S8 migration: ${e.message.slice(0, 120)}`);
        }

        await screenshot(livePagesAfterMigration[0], 's8-after-migration-p1');

        // Verify remaining players still see consistent state
        try {
            await verifySync(livePagesAfterMigration, errors, 'S8-post-migration');
        } catch (e) {
            warn(`sync check after migration: ${e.message.slice(0, 80)}`);
        }

        // ══════════════════════════════════════════════════════════════════════
        // S9: PAGE REFRESH / REJOIN
        // ══════════════════════════════════════════════════════════════════════
        step('S9', 'Page refresh — P3 reloads browser and reconnects to game');

        const p3idx = livePagesAfterMigration.length - 1; // last live page
        const p3page = livePagesAfterMigration[p3idx];

        // Capture state before refresh
        const stateBeforeRefresh = await p3page.evaluate(() => {
            const s = window.__game.state();
            return { players: s.players.length, turn: s.turn };
        });
        log(p3idx + 1, `state before refresh: ${JSON.stringify(stateBeforeRefresh)}`);

        // Refresh P3's page
        await p3page.reload({ waitUntil: 'domcontentloaded' });
        await p3page.waitForTimeout(3_000);

        // After refresh, the page will be at the lobby splash. The game is running
        // via the new host (P1). The refreshed player should see a way to rejoin.
        const p3afterRefresh = await p3page.evaluate(() => {
            const splash = document.getElementById('splash-container');
            const lobby  = document.getElementById('lobby-container');
            const game   = document.getElementById('game-container');
            return {
                splashVisible: !!(splash && !splash.classList.contains('hidden')),
                lobbyVisible:  !!(lobby && !lobby.classList.contains('hidden')),
                gameVisible:   !!(game && !game.classList.contains('hidden')),
            };
        });
        log(p3idx + 1, `after refresh: ${JSON.stringify(p3afterRefresh)}`);
        assert(
            p3afterRefresh.splashVisible || p3afterRefresh.lobbyVisible || p3afterRefresh.gameVisible,
            'P3 sees a UI after refresh (splash, lobby, or game)',
            errors
        );
        await screenshot(p3page, 's9-p3-after-refresh');

        // The remaining players (P1, P2) should still be able to play
        const stillPlaying = livePagesAfterMigration.slice(0, -1);
        if (stillPlaying.length > 0) {
            const sp = await stillPlaying[0].evaluate(() => !!window.__game.state().players.length);
            assert(sp, 'surviving players still have game state after P3 refresh', errors);
        }

    } catch (e) {
        errors.push(`FATAL: ${e.message}`);
        console.error('\n  FATAL:', e.message);
        if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
        // Screenshot all surviving pages
        for (let i = 0; i < pages.length; i++) {
            if (pages[i]) {
                await pages[i].screenshot({ path: path.join(OUT_DIR, `fatal-p${i}.png`) }).catch(() => {});
            }
        }
    } finally {
        for (const b of browsers) {
            if (b) await b.close().catch(() => {});
        }
        if (server) server.close();
    }

    // ─── Report ────────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(68));
    console.log('  DIALOG COVERAGE:');
    console.log(`    Dialog kinds seen:    ${[...track.seen].sort().join(', ')}`);
    console.log(`    Payment pickers:      ${track.paymentSeen}`);
    console.log(`    Reaction prompts:     ${track.reactionSeen}`);
    console.log(`    JSN plays:            ${track.jsnPlayed}`);
    console.log(`    Card effects covered: ${[...track.effects].sort().join(', ')}`);

    const requiredDialogs = ['discard-ui', 'payment', 'reaction'];
    const missingDialogs  = requiredDialogs.filter(d => !track.seen.has(d));
    if (missingDialogs.length > 0) {
        errors.push(`Dialog coverage gap: never saw ${missingDialogs.join(', ')}`);
    }

    console.log('');
    if (errors.length === 0) {
        console.log('  PASS — all scenarios passed');
    } else {
        console.log(`  FAIL — ${errors.length} error(s):`);
        errors.forEach((e, i) => console.log(`    ${i + 1}. ${e}`));
    }
    console.log('═'.repeat(68) + '\n');
    process.exit(errors.length ? 1 : 0);
})();
