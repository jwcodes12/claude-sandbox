// tests/e2e/refresh-resume.mjs — Step 7 reconnect/resume UX over the real stack.
//
// Scenario 1 (refresh): mid-game page.reload() on B → localStorage session
// auto-rejoins the same room+seat, the server re-sends {t:'started'}, the page
// rebuilds v0 and snapshot-catches-up, and play continues to convergence.
//
// Scenario 2 (blip): B's socket is terminated server-side → B shows the
// reconnecting banner and A shows the disconnected-seat banner; B's transport
// backs off, rejoins with its seat token, resumes, both banners clear, play
// continues to convergence.
//
// Pass criteria: seats survive, hashes converge after each disruption, banners
// appear and clear, and neither page logs a pageerror or console.error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { createGameServer } from '../../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

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
    console.log(`static :${httpPort}  ws :${gameServer.port}`);
    const pageUrl = `http://127.0.0.1:${httpPort}/?ws=${encodeURIComponent(`ws://127.0.0.1:${gameServer.port}`)}`;

    // ---- browsers ------------------------------------------------------------
    const browser = await chromium.launch();
    const errors = { A: [], B: [] };

    async function newPage(tag) {
        const context = await browser.newContext();
        await context.route('https://unpkg.com/**', route =>
            route.fulfill({ contentType: 'application/javascript', body: 'window.Peer = window.Peer || function(){};' }));
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

    // ---- lobby → started game -------------------------------------------------
    await pageA.fill('#player-name-create', 'Alice');
    await pageA.click('#btn-create-game');
    await pageA.waitForFunction(() => {
        const el = document.getElementById('lobby-id-display');
        const lobby = document.getElementById('lobby-container');
        return el && lobby && !lobby.classList.contains('hidden') && el.textContent.trim().length >= 8;
    }, null, { timeout: 15000 });
    const roomId = (await pageA.textContent('#lobby-id-display')).trim();

    await pageB.fill('#player-name-join', 'Bob');
    await pageB.fill('#join-game-id', roomId);
    await pageB.click('#btn-join-game');
    await pageA.waitForFunction(() => !document.getElementById('btn-start-game').disabled,
        null, { timeout: 15000 });
    await pageA.click('#btn-start-game');
    for (const page of [pageA, pageB]) {
        await page.waitForFunction(() => !!window.__llNet, null, { timeout: 15000 });
    }
    console.log(`realm ${roomId} started`);

    const version = (page) => page.evaluate(() => window.__llNet.version());
    const pageBySeat = { 0: pageA, 1: pageB };

    // Drive n productive steps (writer version must advance for each).
    async function playSteps(n) {
        let done = 0;
        let stagnant = 0;
        while (done < n) {
            await waitFor(async () => (await version(pageA)) === (await version(pageB)),
                10000, 'client versions to converge');
            const st = await pageA.evaluate(() => {
                const s = window.__llNet.getState();
                return { winner: s.winner, turn: s.turn, version: s.version, pending: !!s.pendingAction };
            });
            if (st.winner != null) return { winner: st.winner, steps: done };

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
                    ? (legal.find(x => x.type === 'concede') || legal.find(x => x.type === 'discard')
                        || legal.find(x => x.type === 'end-turn') || legal[0] || null)
                    : window.__llNet.chooseAuto();
                if (a) window.__llNet.submit(a);
            }, stagnant >= 2);

            const bumped = await waitFor(async () => (await version(pageA)) > st.version, 3000, null);
            if (bumped) { done++; stagnant = 0; }
            else if (++stagnant >= 6) fail(`stalled at version ${st.version}`);
        }
        return { winner: null, steps: done };
    }

    async function assertConverged(label) {
        await waitFor(async () => (await version(pageA)) === (await version(pageB)),
            10000, `${label}: versions to converge`);
        const [hashA, hashB] = await Promise.all([
            pageA.evaluate(() => window.__llNet.hash()),
            pageB.evaluate(() => window.__llNet.hash())
        ]);
        if (hashA !== hashB) fail(`${label}: hashes diverged A=${hashA} B=${hashB}`);
        console.log(`${label}: converged at hash ${hashA}`);
    }

    const bannerVisible = (page, id) => page.evaluate((bid) => {
        const el = document.getElementById(bid);
        return !!el && !el.classList.contains('hidden');
    }, id);

    // ---- scenario 1: page refresh ---------------------------------------------
    await playSteps(6);
    const versionBefore = await version(pageB);
    console.log(`scenario 1: refreshing page B at version ${versionBefore}`);
    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => !!window.__llNet, null, { timeout: 20000 });

    const seatAfter = await pageB.evaluate(() => window.__llNet.seat);
    if (seatAfter !== 1) fail(`scenario 1: seat changed after refresh (${seatAfter})`);
    await waitFor(async () => (await version(pageB)) >= versionBefore, 10000,
        'refreshed page to catch up past its pre-refresh version');
    await assertConverged('scenario 1 (refresh)');
    const gameVisible = await pageB.evaluate(() =>
        !document.getElementById('game-container').classList.contains('hidden'));
    if (!gameVisible) fail('scenario 1: game screen not restored after refresh');
    await playSteps(3);
    await assertConverged('scenario 1 (post-refresh play)');

    // ---- scenario 2: network blip (socket killed server-side) ------------------
    console.log('scenario 2: terminating B\'s socket server-side');
    const room = gameServer.getRoom(roomId);
    if (!room) fail('scenario 2: room not found on server');
    const entry = room.seats[1];
    if (!entry || !entry.ws) fail('scenario 2: seat 1 has no live socket');
    entry.ws.terminate();

    // B notices and shows its own reconnecting banner…
    await waitFor(() => bannerVisible(pageB, 'net-status-banner'), 10000,
        'B to show the reconnecting banner');
    // …and A sees B's seat drop via the presence broadcast.
    await waitFor(() => bannerVisible(pageA, 'net-peers-banner'), 10000,
        'A to show the disconnected-seat banner');
    console.log('scenario 2: both banners visible');

    // Transport backs off, rejoins with the seat token, resumes; banners clear.
    await waitFor(async () => !(await bannerVisible(pageB, 'net-status-banner')), 20000,
        'B\'s reconnecting banner to clear after auto-rejoin');
    await waitFor(async () => !(await bannerVisible(pageA, 'net-peers-banner')), 20000,
        'A\'s disconnected-seat banner to clear after B returns');
    await assertConverged('scenario 2 (blip)');
    await playSteps(3);
    await assertConverged('scenario 2 (post-blip play)');

    // ---- hygiene ----------------------------------------------------------------
    for (const tag of ['A', 'B']) {
        if (errors[tag].length) {
            for (const e of errors[tag]) console.error(`page ${tag}: ${e}`);
            fail(`page ${tag} logged ${errors[tag].length} error(s)`);
        }
    }

    await browser.close();
    await gameServer.close();
    await new Promise(r => httpServer.close(r));
    console.log('\nE2E PASS: refresh-resume and blip-resume both converged with banner UX.');
}

main().then(
    () => process.exit(0),
    (err) => { console.error(err.stack || err.message); process.exit(1); }
);
