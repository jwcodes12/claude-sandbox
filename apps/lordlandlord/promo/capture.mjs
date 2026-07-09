// promo/capture.mjs — record real gameplay footage for the promo video.
//
// Boots the local stack, plays a scripted two-phone game, and records each
// player's screen continuously (Playwright recordVideo). Emits marker
// timestamps so the assembler can cut lobby / play / refresh / heal segments
// out of the two continuous takes.
//
// Outputs: /tmp/ll-promo/clips/A.webm, B.webm, markers.json

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { createGameServer } from '../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..');
const OUT = '/tmp/ll-promo/clips';
fs.mkdirSync(OUT, { recursive: true });

const VP = { width: 390, height: 780 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        let v = null;
        try { v = await fn(); } catch { /* transient */ }
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await sleep(60);
    }
}

async function main() {
    const app = express();
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
    app.use(express.static(path.join(APP_ROOT, 'src')));
    const httpServer = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const gameServer = await createGameServer({ port: 0 });
    const pageUrl = `http://127.0.0.1:${httpServer.address().port}/?ws=${encodeURIComponent(`ws://127.0.0.1:${gameServer.port}`)}`;

    const browser = await chromium.launch();
    const markers = {};          // name -> seconds since recording start
    let t0 = null;
    const mark = (name) => { markers[name] = Number(((Date.now() - t0) / 1000).toFixed(2)); console.log(`mark ${name} @ ${markers[name]}s`); };

    async function newRecordedPage() {
        const context = await browser.newContext({
            viewport: VP,
            recordVideo: { dir: OUT, size: VP },
        });
        await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
        await context.route('https://fonts.gstatic.com/**', r => r.fulfill({ contentType: 'font/woff2', body: '' }));
        const page = await context.newPage();
        page.on('pageerror', e => console.error('pageerror:', e.message));
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
        return { context, page };
    }

    const A = await newRecordedPage();
    t0 = Date.now();                      // both recordings start ~here
    const B = await newRecordedPage();
    await sleep(1500);                    // splash on screen

    // ---- lobby -----------------------------------------------------------------
    mark('lobby_start');
    await A.page.fill('#player-name-create', 'The Landlord');
    await sleep(400);
    await A.page.click('#btn-create-game');
    await A.page.waitForFunction(() => {
        const el = document.getElementById('lobby-id-display');
        const lobby = document.getElementById('lobby-container');
        return el && lobby && !lobby.classList.contains('hidden') && el.textContent.trim().length >= 8;
    }, null, { timeout: 20000 });
    const roomId = (await A.page.textContent('#lobby-id-display')).trim();
    await sleep(1800);                    // let the realm id sit on screen

    await B.page.fill('#player-name-join', 'Eddie (probably)');
    await sleep(400);
    await B.page.fill('#join-game-id', roomId);
    await sleep(400);
    await B.page.click('#btn-join-game');
    await A.page.waitForFunction(() => !document.getElementById('btn-start-game').disabled, null, { timeout: 20000 });
    await sleep(2000);                    // both names visible in the lobby
    await A.page.click('#btn-start-game');
    for (const p of [A.page, B.page]) {
        await p.waitForFunction(() => !!window.__llNet, null, { timeout: 20000 });
    }
    mark('game_start');

    const pages = [A.page, B.page];
    const version = (p) => p.evaluate(() => window.__llNet.version());
    const converge = () => waitFor(async () => {
        const [a, b] = await Promise.all(pages.map(version));
        return a === b;
    }, 15000, 'converge');

    async function playSteps(n, paceMs = 850) {
        let done = 0, stagnant = 0;
        while (done < n) {
            await converge();
            const st = await A.page.evaluate(() => {
                const s = window.__llNet.getState();
                return { winner: s.winner, turn: s.turn, version: s.version, pending: !!s.pendingAction };
            });
            if (st.winner != null) return;
            let acting = null;
            if (st.pending) {
                for (const p of pages) {
                    const can = await p.evaluate(() => window.__llNet.legal().some(a => a.type === 'concede' || a.type === 'react-no'));
                    if (can) { acting = p; break; }
                }
            }
            if (!acting) acting = pages[st.turn] || A.page;
            await acting.evaluate((desperate) => {
                const legal = window.__llNet.legal();
                const a = desperate
                    ? (legal.find(x => x.type === 'concede') || legal.find(x => x.type === 'discard')
                        || legal.find(x => x.type === 'end-turn') || legal[0] || null)
                    : window.__llNet.chooseAuto();
                if (a) window.__llNet.submit(a);
            }, stagnant >= 2);
            const bumped = await (async () => {
                const end = Date.now() + 5000;
                while (Date.now() < end) {
                    if ((await version(A.page)) > st.version) return true;
                    await sleep(80);
                }
                return false;
            })();
            if (bumped) { done++; stagnant = 0; await sleep(paceMs); }
            else if (++stagnant >= 6) throw new Error(`stalled at v${st.version}`);
        }
    }

    // ---- live play -----------------------------------------------------------------
    mark('play_start');
    await playSteps(10);
    mark('play_end');

    // ---- mid-game refresh on B --------------------------------------------------
    await sleep(600);
    mark('refresh_start');
    await B.page.reload({ waitUntil: 'domcontentloaded' });
    await B.page.waitForFunction(() => !!window.__llNet, null, { timeout: 25000 });
    await converge();
    await sleep(1200);                    // board back on screen
    await playSteps(3);
    mark('refresh_end');

    // ---- connection kill → self-heal ---------------------------------------------
    await sleep(600);
    mark('heal_start');
    const room = gameServer.getRoom(roomId);
    room.seats[1].ws.terminate();
    const bannerVisible = (p, id) => p.evaluate((bid) => {
        const el = document.getElementById(bid);
        return !!el && !el.classList.contains('hidden');
    }, id);
    await waitFor(() => bannerVisible(B.page, 'net-status-banner'), 15000, 'B reconnecting banner');
    await waitFor(() => bannerVisible(A.page, 'net-peers-banner'), 15000, 'A peers banner');
    await sleep(1500);                    // banners on screen
    await waitFor(async () => !(await bannerVisible(B.page, 'net-status-banner')), 30000, 'B banner clear');
    await waitFor(async () => !(await bannerVisible(A.page, 'net-peers-banner')), 30000, 'A banner clear');
    await playSteps(2);
    await sleep(1500);
    mark('end');

    // ---- collect recordings --------------------------------------------------------
    const vidA = A.page.video();
    const vidB = B.page.video();
    await A.context.close();
    await B.context.close();
    fs.copyFileSync(await vidA.path(), path.join(OUT, 'A.webm'));
    fs.copyFileSync(await vidB.path(), path.join(OUT, 'B.webm'));
    fs.writeFileSync(path.join(OUT, 'markers.json'), JSON.stringify(markers, null, 2));
    console.log('markers:', JSON.stringify(markers));

    await browser.close();
    await gameServer.close();
    await new Promise(r => httpServer.close(r));
    console.log('CAPTURE DONE');
}

main().then(() => process.exit(0), (e) => { console.error(e.stack || e.message); process.exit(1); });
