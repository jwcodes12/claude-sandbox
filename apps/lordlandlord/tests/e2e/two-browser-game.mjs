// tests/e2e/two-browser-game.mjs — full two-browser game over the real stack.
//
// Boots the static site (express, like serve.js) and the real WebSocket game
// server (server/index.js) on ephemeral ports, opens TWO Chromium pages,
// creates + joins a realm through the actual lobby DOM, starts the game, then
// drives both pages via the window.__llNet hook until someone wins.
//
// Pass criteria: a winner is reached, both clients' state hashes converge, and
// neither page logged a pageerror or console.error. Exit code 0/1.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { createGameServer } from '../../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

const MAX_STEPS = 400;
const OVERALL_DEADLINE_MS = 180000;

function fail(msg) {
    console.error(`\nE2E FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
}

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) {
            if (what) fail(`timed out waiting for ${what}`);
            return null;                      // soft wait
        }
        await new Promise(r => setTimeout(r, 50));
    }
}

async function main() {
    // ---- servers -------------------------------------------------------------
    const app = express();
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
    app.use(express.static(path.join(APP_ROOT, 'src')));
    const httpServer = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const httpPort = httpServer.address().port;

    const gameServer = await createGameServer({ port: 0 });
    const wsPort = gameServer.port;
    console.log(`static :${httpPort}  ws :${wsPort}`);

    const pageUrl = `http://127.0.0.1:${httpPort}/?ws=${encodeURIComponent(`ws://127.0.0.1:${wsPort}`)}`;

    // ---- browsers ------------------------------------------------------------
    const browser = await chromium.launch();
    const errors = { A: [], B: [] };

    async function newPage(tag) {
        const context = await browser.newContext();
        // Hermetic run: stub Google Fonts so an offline box can't produce
        // resource errors.
        await context.route('https://fonts.googleapis.com/**', route =>
            route.fulfill({ contentType: 'text/css', body: '' }));
        await context.route('https://fonts.gstatic.com/**', route =>
            route.fulfill({ contentType: 'font/woff2', body: '' }));
        const page = await context.newPage();
        page.on('pageerror', e => errors[tag].push(`pageerror: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') errors[tag].push(`console.error: ${m.text()}`); });
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
        return page;
    }

    const pageA = await newPage('A');
    const pageB = await newPage('B');

    // ---- lobby flow ------------------------------------------------------------
    await pageA.fill('#player-name-create', 'Alice');
    await pageA.click('#btn-create-game');
    await pageA.waitForFunction(() => {
        const el = document.getElementById('lobby-id-display');
        const lobby = document.getElementById('lobby-container');
        return el && lobby && !lobby.classList.contains('hidden') &&
            el.textContent.trim().length >= 8 && el.textContent.trim() !== 'LOCAL-TEST';
    }, null, { timeout: 15000 });
    const roomId = (await pageA.textContent('#lobby-id-display')).trim();
    console.log(`realm ${roomId} forged by page A`);

    await pageB.fill('#player-name-join', 'Bob');
    await pageB.fill('#join-game-id', roomId);
    await pageB.click('#btn-join-game');
    await pageB.waitForFunction(() => {
        const lobby = document.getElementById('lobby-container');
        return lobby && !lobby.classList.contains('hidden');
    }, null, { timeout: 15000 });

    await pageA.waitForFunction(() => !document.getElementById('btn-start-game').disabled,
        null, { timeout: 15000 });
    await pageA.click('#btn-start-game');

    for (const page of [pageA, pageB]) {
        await page.waitForFunction(() => !!window.__llNet, null, { timeout: 15000 });
    }

    const seatA = await pageA.evaluate(() => window.__llNet.seat);
    const seatB = await pageB.evaluate(() => window.__llNet.seat);
    if (seatA !== 0 || seatB !== 1) fail(`unexpected seats A=${seatA} B=${seatB}`);
    const pageBySeat = { [seatA]: pageA, [seatB]: pageB };
    console.log(`game started — A seat ${seatA}, B seat ${seatB}`);

    // ---- drive the game ---------------------------------------------------------
    const version = (page) => page.evaluate(() => window.__llNet.version());
    let steps = 0;
    let stagnant = 0;
    let winner = null;
    const deadline = Date.now() + OVERALL_DEADLINE_MS;

    while (steps < MAX_STEPS) {
        if (Date.now() > deadline) fail(`deadline exceeded after ${steps} steps`);
        steps++;

        // Both mirrors caught up to the same version before we read the board.
        await waitFor(async () => (await version(pageA)) === (await version(pageB)),
            10000, 'client versions to converge');

        const st = await pageA.evaluate(() => {
            const s = window.__llNet.getState();
            return {
                winner: s.winner, turn: s.turn, version: s.version,
                pending: !!s.pendingAction, mustDiscard: s.mustDiscard
            };
        });
        if (st.winner != null) { winner = st.winner; break; }

        // Whose move: a pending action belongs to whoever holds a reaction;
        // otherwise it is the turn seat's move.
        let actingPage = null;
        if (st.pending) {
            for (const page of [pageA, pageB]) {
                const canReact = await page.evaluate(() =>
                    window.__llNet.legal().some(a => a.type === 'concede' || a.type === 'react-no'));
                if (canReact) { actingPage = page; break; }
            }
        }
        if (!actingPage) actingPage = pageBySeat[st.turn] || pageA;

        await actingPage.evaluate((desperate) => {
            const legal = window.__llNet.legal();
            const a = desperate
                ? (legal.find(x => x.type === 'concede')
                    || legal.find(x => x.type === 'discard')
                    || legal.find(x => x.type === 'end-turn')
                    || legal[0] || null)
                : window.__llNet.chooseAuto();
            if (a) window.__llNet.submit(a);
        }, stagnant >= 2);

        // Soft wait for the writer to accept + broadcast; a dropped no-op just
        // counts as stagnation and the next lap falls back to blunter moves.
        const bumped = await waitFor(async () => (await version(pageA)) > st.version, 3000, null);
        stagnant = bumped ? 0 : stagnant + 1;
        if (stagnant >= 6) {
            fail(`game stalled at version ${st.version} (turn ${st.turn}, pending=${st.pending})`);
        }
    }

    if (winner == null) fail(`no winner after ${steps} steps`);
    console.log(`winner: seat ${winner} after ${steps} driver steps`);

    // ---- convergence + hygiene assertions ------------------------------------
    await waitFor(async () => {
        const [wA, wB, vA, vB] = await Promise.all([
            pageA.evaluate(() => window.__llNet.getState().winner),
            pageB.evaluate(() => window.__llNet.getState().winner),
            version(pageA), version(pageB)
        ]);
        return wA != null && wB != null && vA === vB;
    }, 10000, 'both pages to see the winner at the same version');

    const [hashA, hashB] = await Promise.all([
        pageA.evaluate(() => window.__llNet.hash()),
        pageB.evaluate(() => window.__llNet.hash())
    ]);
    if (hashA !== hashB) {
        const [jsonA, jsonB] = await Promise.all([
            pageA.evaluate(() => JSON.stringify(window.__llNet.getState())),
            pageB.evaluate(() => JSON.stringify(window.__llNet.getState()))
        ]);
        console.error(`state A length ${jsonA.length}, state B length ${jsonB.length}, identical=${jsonA === jsonB}`);
        fail(`state hashes diverged: A=${hashA} B=${hashB}`);
    }
    console.log(`states converged: hash ${hashA}`);

    for (const tag of ['A', 'B']) {
        if (errors[tag].length) {
            for (const e of errors[tag]) console.error(`page ${tag}: ${e}`);
            fail(`page ${tag} logged ${errors[tag].length} error(s)`);
        }
    }

    // ---- teardown -----------------------------------------------------------
    await browser.close();
    await gameServer.close();
    await new Promise(r => httpServer.close(r));
    console.log('\nE2E PASS: two-browser game completed and converged.');
}

main().then(
    () => process.exit(0),
    (err) => { console.error(err.stack || err.message); process.exit(1); }
);
