/**
 * mp-30-turn-stress.js — 5-Player Automated Multiplayer Stress Test
 *
 * Runs a 30-turn (max) game where bots drive the local machine instances.
 * Verifies synchronization, dialogue box visibility, and state consistency
 * across 5 independent browser processes communicating via WebRTC.
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
const JOIN_TIMEOUT     = 45_000;
const ACTION_TIMEOUT   = 15_000;
const MODAL_TIMEOUT    = 10_000;

// ─── Logging ──────────────────────────────────────────────────────────────────

const LABELS = ['M1-host', 'M2-P1', 'M3-P2', 'M4-P3', 'M5-P4'];
function tag(i) { return `[${LABELS[i] || `M${i+1}`}]`; }
function log(i, msg)  { console.log(`  ${tag(i)} ${msg}`); }
function step(n, msg) { console.log(`\n  ── Step ${n}: ${msg} ──`); }
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
        if (text.includes('[NET-DEBUG]') || text.includes('[ENGINE]') || text.includes('[AUTO-UI]') || text.includes('plays')) {
             log(playerIdx, `[console] ${text}`);
        }
    });
    await page.setViewportSize({ width: 960, height: 960 });
    return { browser, page };
}

async function loadGame(page, playerIdx) {
    await page.goto(`${GAME_URL}?bust=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#btn-create-game', { state: 'visible', timeout: 20_000 });
    
    // Disable internal bots so they don't fight with the test driver
    await page.evaluate(() => {
        window.__game_stress_test = true;
        if (window.__game && window.__game.clearBotStrategies) {
            window.__game.clearBotStrategies();
        }
    });

    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t.length > 4 && t !== 'LOCAL-TEST' && !t.startsWith('Joining');
    }, null, { timeout: 30_000 });
}

// ─── Wait helpers ─────────────────────────────────────────────────────────────

async function waitFor(page, fn, desc, timeout = ACTION_TIMEOUT, arg = null) {
    try {
        await page.waitForFunction(fn, arg, { timeout });
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

async function waitTurnStart(pages, playerIdx, timeout = 20_000) {
    await Promise.all(pages.map((p, i) =>
        waitFor(p, (pid) => window.__game.state().turn === pid && !window.__game.state().pendingAction,
            `${i} turn → ${playerIdx}`, timeout, playerIdx)
    ));
}

async function waitPendingClear(pages) {
    await Promise.all(pages.map((p, i) =>
        waitFor(p, () => window.__game.state().pendingAction === null,
            `${i} pendingAction → null`)
    ));
}

// ─── Sync Checks ──────────────────────────────────────────────────────────────

function sortObject(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortObject);
    const sorted = {};
    Object.keys(obj).sort().forEach(key => {
        sorted[key] = sortObject(obj[key]);
    });
    return sorted;
}

async function verifySync(pages, errors) {
    const states = await Promise.all(pages.map(p =>
        p.evaluate(() => {
            const s = window.__game.state();
            const snap = JSON.parse(JSON.stringify(s));
            delete snap.localPlayerId;
            delete snap._autoEnding;
            delete snap.mustDiscard;
            delete snap.lastResolution;
            delete snap.actionLog;
            return snap;
        })
    ));

    const hostState = JSON.stringify(sortObject(states[0]));
    for (let i = 1; i < states.length; i++) {
        const clientState = JSON.stringify(sortObject(states[i]));
        if (clientState !== hostState) {
            errors.push(`${tag(i)} state desync from host!\nHost: ${hostState}\n${tag(i)}: ${clientState}`);
        }
    }
}

// ─── Bot Interaction ─────────────────────────────────────────────────────────

async function autoResolveReactions(pages, errors) {
    let resolvedAny = false;
    await Promise.all(pages.map(async (page, i) => {
        const modalInfo = await page.evaluate(() => {
            const m = document.getElementById('info-modal');
            if (!m || m.classList.contains('hidden')) return null;
            return { kind: m.dataset.modalKind, title: m.querySelector('h2')?.textContent };
        });

        if (modalInfo) {
            log(i, `Sees ${modalInfo.kind} dialog ("${modalInfo.title}"), auto-resolving...`);
            
            if (modalInfo.kind === 'payment') {
                const paid = await page.evaluate(async () => {
                    const getBtn = () => document.querySelector('[data-pay-submit]');
                    const getSum = () => {
                        const str = document.querySelector('.info-desc')?.textContent || '';
                        const parts = str.split('Selected: ');
                        if (parts.length < 2) return -1;
                        const val = parseInt(parts[1]);
                        return isNaN(val) ? -1 : val;
                    };
                    
                    console.log(`[AUTO-UI] Handling payment picker. Current sum: ${getSum()}g`);
                    let attempts = 0;
                    while (attempts < 15) {
                        const btn = getBtn();
                        if (btn && !btn.disabled) break;
                        const unselected = Array.from(document.querySelectorAll('.picker-btn:not(.selected)'));
                        if (unselected.length === 0) break;
                        const before = getSum();
                        unselected[0].click();
                        let wait = 0;
                        while (wait < 10 && getSum() === before) {
                            await new Promise(r => setTimeout(r, 50));
                            wait++;
                        }
                        attempts++;
                    }
                    const finalBtn = document.querySelector('[data-pay-submit]:not([disabled])');
                    if (finalBtn) {
                        finalBtn.click();
                        return true;
                    }
                    return false;
                });
                if (paid) {
                    log(i, "Submitted payment");
                    resolvedAny = true;
                }
            } else {
                const clicked = await page.evaluate(() => {
                    const btn = document.querySelector('.concede-btn') || document.querySelector('.picker-btn');
                    if (btn) { btn.click(); return true; }
                    return false;
                });
                if (clicked) {
                    log(i, "Clicked concede/accept");
                    resolvedAny = true;
                }
            }
        }
    }));
    return resolvedAny;
}

// ─── Lobby ────────────────────────────────────────────────────────────────────

async function setupLobby(pages) {
    const hostPage = pages[0];
    await hostPage.click('#btn-create-game');
    
    const hostPeerId = await hostPage.evaluate(() => document.getElementById('lobby-id-display').textContent);
    log(0, `Host Peer ID: ${hostPeerId}`);

    for (let i = 1; i < N_PLAYERS; i++) {
        const p = pages[i];
        await p.fill('#join-game-id', hostPeerId);
        await p.fill('#player-name-join', `Lord_P${i}`);
        await p.click('#btn-join-game');
        log(i, 'clicked Join');
    }

    await hostPage.waitForFunction(
        (n) => document.querySelectorAll('.lobby-slot:not(.empty)').length === n,
        N_PLAYERS,
        { timeout: JOIN_TIMEOUT }
    );
    ok(`Lobby full with ${N_PLAYERS} players`);

    await hostPage.click('#btn-start-game');
    ok('Host clicked Start');

    await Promise.all(pages.map((p, i) =>
        waitFor(p, () => document.getElementById('game-container') && !document.getElementById('game-container').classList.contains('hidden'),
            `${i} game visible`, 15_000)
    ));
    
    ok('All machines see game container — waiting for sync...');
    await pages[0].waitForTimeout(2000);
    
    await Promise.all(pages.map(p => p.evaluate(() => {
        if (window.__game) {
            window.__game.state()._isStressTest = true;
            window.__game.state().players.forEach(pp => { pp._isBot = false; });
        }
    })));
}

// ─── Main Stress Loop ────────────────────────────────────────────────────────

(async () => {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Lord Landlord — 5-Player 30-Turn Stress Test                ║');
    console.log('║  WebRTC · Cross-Machine Sync · Auto-Bot Driven               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    const browsers = [];
    const pages    = [];
    const errors   = [];
    let   server   = null;

    try {
        server = await startServer();
        console.log(`  Static server: ${GAME_URL}`);

        for (let i = 0; i < N_PLAYERS; i++) {
            const { browser, page } = await launchBrowser(i);
            browsers.push(browser);
            pages.push(page);
        }

        await Promise.all(pages.map((p, i) => loadGame(p, i)));
        await setupLobby(pages);
        
        let turnCounter = 0;
        const MAX_TURNS = 30;

        while (turnCounter < MAX_TURNS) {
            const state = await pages[0].evaluate(() => window.__game.state());
            if (state._gameOver) {
                ok(`Game ended naturally due to victory!`);
                break;
            }

            const currentTurnPlayer = state.turn;
            step(turnCounter, `Turn ${turnCounter} (Player ${currentTurnPlayer})`);

            await waitFor(pages[currentTurnPlayer], (pid) => window.__game.state().turn === pid,
                `Turn player ${currentTurnPlayer} sees it is their turn`, 10_000, currentTurnPlayer);

            let actionsInTurn = 0;
            while (actionsInTurn < 10) {
                const s = await pages[currentTurnPlayer].evaluate(() => {
                    const st = window.__game.state();
                    const me = st.players[st.localPlayerId];
                    return { turn: st.turn, al: st.actionsLeft, md: st.mustDiscard, hl: me ? me.hand.length : 0, pending: !!st.pendingAction };
                });
                if (s.turn !== currentTurnPlayer || (s.al <= 0 && s.md === 0) || s._gameOver) break;

                const action = await pages[currentTurnPlayer].evaluate(() => window.__game.pickBestAny(window.__game.state().localPlayerId));
                if (!action || action.type === 'end-turn') {
                    log(currentTurnPlayer, "Ending turn.");
                    await pages[currentTurnPlayer].evaluate(() => window.__game.endTurn());
                    break;
                }

                const cardInfo = await pages[currentTurnPlayer].evaluate((aid) => {
                    const st = window.__game.state();
                    const c = st.players[st.localPlayerId].hand.find(cc => cc.data.id === aid);
                    return c ? c.data.name : 'unknown';
                }, action.cardId);

                log(currentTurnPlayer, `Dispatching: ${action.type} ${action.cardId || ''} ("${cardInfo}")`);
                await pages[currentTurnPlayer].evaluate((a) => window.__game.dispatch(a), action);
                
                if (action.type === 'propose') {
                    await pages[0].waitForTimeout(1000);
                    let attempts = 0;
                    while (attempts < 10) {
                        const resolved = await autoResolveReactions(pages, errors);
                        await pages[0].waitForTimeout(1000);
                        const anyPending = await Promise.all(pages.map(p => p.evaluate(() => !!window.__game.state().pendingAction)));
                        if (!anyPending.some(x => x)) break;
                        attempts++;
                    }
                    await waitPendingClear(pages);
                }

                await pages[currentTurnPlayer].waitForFunction((prev) => {
                    const st = window.__game.state();
                    const me = st.players[st.localPlayerId];
                    return st.turn !== prev.turn || st.actionsLeft !== prev.al || !!st.pendingAction !== prev.pending || st.mustDiscard !== prev.md || (me && me.hand.length !== prev.hl);
                }, s, { timeout: 5000 }).catch(() => {
                    throw new Error(`Action ${action.type} ${action.cardId} had no effect on state!`);
                });

                await pages[0].waitForTimeout(600);
                await verifySync(pages, errors);
                if (errors.length) throw new Error("Sync failure: " + errors[0]);
                actionsInTurn++;
            }
            turnCounter++;
            await pages[0].waitForTimeout(800);
        }
        if (turnCounter >= MAX_TURNS) ok("Successfully completed 30 turns of high-intensity play!");
    } catch (e) {
        console.log(`\n  [fatal] ${e.message}`);
        errors.push(e.message);
        for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: `stress-fail-p${i}.png` });
    } finally {
        for (const b of browsers) await b.close().catch(() => {});
        if (server) server.close();
        console.log('\n' + '═'.repeat(66));
        if (errors.length === 0) console.log('  PASS — Stress test completed successfully.');
        else { console.log('  FAIL'); errors.forEach(e => console.log(`    ✗ ${e}`)); }
        console.log('═'.repeat(66) + '\n');
        process.exit(errors.length ? 1 : 0);
    }
})();
