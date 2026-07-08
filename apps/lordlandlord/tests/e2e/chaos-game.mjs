// tests/e2e/chaos-game.mjs — multi-network chaos soak for the WebSocket stack.
//
// Three human players, each connected through their OWN TCP latency proxy
// (distinct delay + jitter = genuinely different networks), play a full game
// to a winner while seeded random disruptions fire:
//   - reload:    a player refreshes mid-game (localStorage seat resume)
//   - blip:      a player's proxy sockets are destroyed (NAT reset)
//   - blackhole: a player's proxy pauses both directions for a few seconds
//                (stalled network → server heartbeat terminate → auto-rejoin)
//   - spike:     a player's latency temporarily triples
//
// After every step and after every disruption recovery, two oracles run:
//   1. Convergence — all clients at equal version have equal state hashes.
//   2. UI-vs-state — the rendered DOM matches the authoritative state on every
//      page (own hand card count, opponents' H:n counters, actions counter,
//      gold total, reconnect/presence banners) — this catches the "played
//      card snaps back / stale counter / stuck banner" class of UI bugs.
//
// Config via env: CHAOS_SEED (default 1), CHAOS_LAT="25,120,300" (ms one-way),
// CHAOS_JITTER=0.4, CHAOS_MAX_STEPS=500, CHAOS_DISRUPT_EVERY=9.
// Exit 0 = winner reached, zero oracle violations, zero page/console errors.

import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from 'playwright';
import { createGameServer } from '../../server/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

const SEED = Number(process.env.CHAOS_SEED || 1);
const LATENCIES = (process.env.CHAOS_LAT || '25,120,300').split(',').map(Number);
const JITTER = Number(process.env.CHAOS_JITTER || 0.4);
const MAX_STEPS = Number(process.env.CHAOS_MAX_STEPS || 500);
const DISRUPT_EVERY = Number(process.env.CHAOS_DISRUPT_EVERY || 9);
const DEADLINE_MS = Number(process.env.CHAOS_DEADLINE_MS || 480000);
const N = LATENCIES.length;

// Deterministic disruption schedule (mulberry32, same as the app core).
function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED >>> 0);

function fail(msg) {
    console.error(`\nCHAOS FAIL: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
}

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        let v = null;
        try { v = await fn(); } catch { /* page mid-reload etc. */ }
        if (v) return v;
        if (Date.now() > end) {
            if (what) fail(`timed out waiting for ${what}`);
            return null;
        }
        await new Promise(r => setTimeout(r, 60));
    }
}

// ---- per-player TCP latency proxy -------------------------------------------
// Forwards client<->server bytes with a one-way delay (+jitter). Supports:
// blip() (destroy live sockets), blackhole()/restore() (pause both directions),
// setFactor() (latency spike multiplier).
function createLatencyProxy(upstreamPort, baseDelayMs, jitterFrac) {
    const pairs = new Set();
    let factor = 1;
    let holed = false;

    const delay = () => {
        const j = baseDelayMs * jitterFrac;
        return Math.max(0, (baseDelayMs + (rand() * 2 - 1) * j) * factor);
    };

    const server = net.createServer((client) => {
        const upstream = net.connect(upstreamPort, '127.0.0.1');
        const pair = { client, upstream };
        pairs.add(pair);
        // Per-direction FIFO clock: each chunk is delayed by delay() but never
        // delivered before an earlier chunk — TCP payload must stay ordered,
        // only the pacing varies.
        const forward = (from, to) => {
            let lastAt = 0;
            from.on('data', (chunk) => {
                const at = Math.max(Date.now() + delay(), lastAt);
                lastAt = at;
                setTimeout(() => {
                    if (!to.destroyed) to.write(chunk);
                }, Math.max(0, at - Date.now()));
            });
        };
        forward(client, upstream);
        forward(upstream, client);
        const drop = () => { client.destroy(); upstream.destroy(); pairs.delete(pair); };
        client.on('close', drop); upstream.on('close', drop);
        client.on('error', () => {}); upstream.on('error', () => {});
        if (holed) { client.pause(); upstream.pause(); }
    });

    return {
        listen: () => new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
        blip() { for (const p of [...pairs]) { p.client.destroy(); p.upstream.destroy(); } },
        blackhole() { holed = true; for (const p of pairs) { p.client.pause(); p.upstream.pause(); } },
        restore() { holed = false; for (const p of pairs) { p.client.resume(); p.upstream.resume(); } },
        setFactor(f) { factor = f; },
        close: () => new Promise((res) => { for (const p of [...pairs]) { p.client.destroy(); p.upstream.destroy(); } server.close(res); }),
    };
}

// ---- oracles -----------------------------------------------------------------

// UI-vs-state: poll (render is rAF-batched) until the DOM agrees with the
// client's authoritative state; return null on agreement or a mismatch report.
async function uiMismatch(page) {
    const check = () => page.evaluate(() => {
        if (!window.__llNet) return 'no __llNet hook';
        const st = window.__llNet.getState();
        const me = window.__llNet.seat;
        const probs = [];

        const handDom = document.querySelectorAll('.your-hand .hand-card').length;
        const handSt = st.players[me].hand.length;
        if (handDom !== handSt) probs.push(`own hand DOM=${handDom} state=${handSt}`);

        for (const p of st.players) {
            if (p.id === me) continue;
            const el = document.querySelector(`.opponent[data-player-id="${p.id}"] [data-field="opp-hand"]`);
            if (!el) { probs.push(`opponent ${p.id} card missing`); continue; }
            if (el.textContent !== `H:${p.hand.length}`) {
                probs.push(`opp ${p.id} hand DOM=${el.textContent} state=H:${p.hand.length}`);
            }
        }

        const actEl = document.querySelector('[data-field="actions"]');
        if (!actEl) probs.push('actions counter missing');
        else if (actEl.textContent !== `Actions: ${st.actionsLeft}`) {
            probs.push(`actions DOM="${actEl.textContent}" state=${st.actionsLeft}`);
        }

        const goldEl = document.querySelector('[data-field="your-gold"]');
        const gold = st.players[me].bank.reduce((s, c) => s + (c.data.value || 0), 0);
        if (goldEl && goldEl.textContent !== `${gold}g`) {
            probs.push(`gold DOM="${goldEl.textContent}" state=${gold}g`);
        }

        // Steady-state banner hygiene (checked only when everyone is connected).
        const statusB = document.getElementById('net-status-banner');
        if (statusB && !statusB.classList.contains('hidden')) probs.push('status banner stuck visible');

        return probs.length ? probs.join('; ') : null;
    });
    // rAF settle: give the renderer up to 2s to catch up before calling it a bug.
    const end = Date.now() + 2000;
    let last = await check();
    while (last && Date.now() < end) {
        await new Promise(r => setTimeout(r, 100));
        last = await check();
    }
    return last;
}

async function main() {
    // ---- servers ---------------------------------------------------------------
    const app = express();
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
    app.use(express.static(path.join(APP_ROOT, 'src')));
    const httpServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const httpPort = httpServer.address().port;
    // heartbeat 3s: fast enough that a blackholed seat is reaped within the
    // test's patience, but comfortably above the worst spiked RTT (3×300ms×2 =
    // 1.8s) — mirroring production proportions (30s heartbeat vs ~1s RTT), so
    // a latency spike is latency, not a disconnect.
    const gameServer = await createGameServer({ port: 0, heartbeatMs: 3000 });

    const proxies = [];
    const proxyPorts = [];
    for (const lat of LATENCIES) {
        const p = createLatencyProxy(gameServer.port, lat, JITTER);
        proxies.push(p);
        proxyPorts.push(await p.listen());
    }
    console.log(`static :${httpPort}  ws :${gameServer.port}  proxies ${proxyPorts.map((p, i) => `${p}(${LATENCIES[i]}ms)`).join(' ')}`);

    // ---- browsers ----------------------------------------------------------------
    const browser = await chromium.launch();
    const errors = Array.from({ length: N }, () => []);
    const pages = [];

    for (let i = 0; i < N; i++) {
        const context = await browser.newContext();
        await context.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
        await context.route('https://fonts.gstatic.com/**', r => r.fulfill({ contentType: 'font/woff2', body: '' }));
        const page = await context.newPage();
        page.on('pageerror', e => errors[i].push(`pageerror: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') errors[i].push(`console.error: ${m.text()}`); });
        await page.goto(`http://127.0.0.1:${httpPort}/?ws=${encodeURIComponent(`ws://127.0.0.1:${proxyPorts[i]}`)}`,
            { waitUntil: 'domcontentloaded' });
        pages.push(page);
    }

    // ---- lobby -------------------------------------------------------------------
    await pages[0].fill('#player-name-create', 'P0');
    await pages[0].click('#btn-create-game');
    await pages[0].waitForFunction(() => {
        const el = document.getElementById('lobby-id-display');
        const lobby = document.getElementById('lobby-container');
        return el && lobby && !lobby.classList.contains('hidden') && el.textContent.trim().length >= 8;
    }, null, { timeout: 20000 });
    const roomId = (await pages[0].textContent('#lobby-id-display')).trim();

    for (let i = 1; i < N; i++) {
        await pages[i].fill('#player-name-join', `P${i}`);
        await pages[i].fill('#join-game-id', roomId);
        await pages[i].click('#btn-join-game');
    }
    await pages[0].waitForFunction((n) => {
        const btn = document.getElementById('btn-start-game');
        return btn && !btn.disabled && btn.textContent.includes(`(${n})`);
    }, N, { timeout: 20000 });
    await pages[0].click('#btn-start-game');
    for (const page of pages) {
        await page.waitForFunction(() => !!window.__llNet, null, { timeout: 20000 });
    }
    const seats = await Promise.all(pages.map(p => p.evaluate(() => window.__llNet.seat)));
    console.log(`realm ${roomId} started — seats ${seats.join(',')} latencies ${LATENCIES.join('/')}ms`);
    const pageBySeat = {};
    seats.forEach((s, i) => { pageBySeat[s] = pages[i]; });

    const version = (page) => page.evaluate(() => window.__llNet.version());

    // (version, hash) must be read atomically per page — auto end-turn means
    // versions can advance between two separate reads. Retry until every page
    // reports the same (v, h) pair; a persistent mismatch is a real desync.
    const snapAll = () => Promise.all(pages.map(p =>
        p.evaluate(() => ({ v: window.__llNet.version(), h: window.__llNet.hash() }))));

    async function allConverged(timeoutMs, label) {
        const ok = await waitFor(async () => {
            const s = await snapAll();
            return s.every(x => x.v === s[0].v && x.h === s[0].h) ? s : null;
        }, timeoutMs, null);
        if (!ok) {
            const s = await snapAll();
            console.error(`${label}: pairs ${s.map((x, i) => `P${i}=v${x.v}:${x.h}`).join(' ')}`);
            const sameV = s.every(x => x.v === s[0].v);
            if (sameV) {
                // genuine same-version divergence — dump states for diffing
                const dumps = await Promise.all(pages.map(p =>
                    p.evaluate(() => JSON.stringify(window.__llNet.getState()))));
                for (let i = 1; i < dumps.length; i++) {
                    if (dumps[i] !== dumps[0]) console.error(`P0 vs P${i} state lengths: ${dumps[0].length} vs ${dumps[i].length}`);
                }
            }
            fail(`${label}: ${sameV ? 'SAME-VERSION STATE DIVERGENCE' : 'versions never converged'}`);
        }
    }

    async function fullOracle(label) {
        await allConverged(30000, label);
        for (let i = 0; i < N; i++) {
            const bad = await uiMismatch(pages[i]);
            if (bad) fail(`${label}: UI/state mismatch on P${i}: ${bad}`);
        }
    }

    // ---- disruptions ---------------------------------------------------------------
    const bannerVisible = (page, id) => page.evaluate((bid) => {
        const el = document.getElementById(bid);
        return !!el && !el.classList.contains('hidden');
    }, id);

    const disruptions = { reload: 0, blip: 0, blackhole: 0, spike: 0 };

    async function disrupt(step) {
        const victim = Math.floor(rand() * N);
        const kind = ['reload', 'blip', 'blackhole', 'spike'][Math.floor(rand() * 4)];
        const page = pages[victim];
        disruptions[kind]++;
        console.log(`  step ${step}: ${kind} → P${victim}`);

        if (kind === 'reload') {
            const vBefore = await version(page);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !!window.__llNet, null, { timeout: 30000 });
            const seatAfter = await page.evaluate(() => window.__llNet.seat);
            if (seatAfter !== seats[victim]) fail(`reload: P${victim} seat changed ${seats[victim]}→${seatAfter}`);
            await waitFor(async () => (await version(page)) >= vBefore, 20000, 'reloaded page catch-up');
        } else if (kind === 'blip') {
            proxies[victim].blip();
            // other players should see the presence banner, then it must clear
            const other = pages[(victim + 1) % N];
            await waitFor(() => bannerVisible(other, 'net-peers-banner'), 15000,
                `peers banner on another page after P${victim} blip`);
            await waitFor(async () => !(await bannerVisible(other, 'net-peers-banner')), 30000,
                `peers banner to clear after P${victim} rejoins`);
        } else if (kind === 'blackhole') {
            // A stalled network looks OPEN to the victim's browser (even the
            // server's FIN is stalled), so the victim shows no banner during
            // the hole. The meaningful observable is on the OTHERS: the server
            // heartbeat terminates the stalled seat and broadcasts presence.
            proxies[victim].blackhole();
            const other = pages[(victim + 1) % N];
            await waitFor(() => bannerVisible(other, 'net-peers-banner'), 25000,
                `peers banner on another page during P${victim} blackhole`);
            await new Promise(r => setTimeout(r, 500));
            proxies[victim].restore();
            await waitFor(async () => !(await bannerVisible(other, 'net-peers-banner')), 30000,
                `peers banner to clear after P${victim} recovers from blackhole`);
        } else {
            proxies[victim].setFactor(3);
            await new Promise(r => setTimeout(r, 2500));
            proxies[victim].setFactor(1);
        }
        await fullOracle(`post-${kind}(P${victim})`);
    }

    // ---- drive the game --------------------------------------------------------------
    let steps = 0;
    let stagnant = 0;
    let winner = null;
    const deadline = Date.now() + DEADLINE_MS;

    while (steps < MAX_STEPS) {
        if (Date.now() > deadline) fail(`deadline exceeded after ${steps} steps`);
        steps++;

        await allConverged(30000, `step ${steps}`);
        const st = await pages[0].evaluate(() => {
            const s = window.__llNet.getState();
            return { winner: s.winner, turn: s.turn, version: s.version, pending: !!s.pendingAction };
        });
        if (st.winner != null) { winner = st.winner; break; }

        // periodic full oracle (every step is convergence-checked; DOM every 3rd)
        if (steps % 3 === 0) {
            for (const page of pages) {
                const bad = await uiMismatch(page);
                if (bad) fail(`step ${steps}: UI/state mismatch: ${bad}`);
            }
        }

        if (steps > 6 && steps % DISRUPT_EVERY === 0) await disrupt(steps);

        // choose the acting page: any pending reactor first, else the turn seat
        let actingPage = null;
        if (st.pending) {
            for (const page of pages) {
                const canReact = await page.evaluate(() =>
                    window.__llNet.legal().some(a => a.type === 'concede' || a.type === 'react-no'));
                if (canReact) { actingPage = page; break; }
            }
        }
        if (!actingPage) actingPage = pageBySeat[st.turn] || pages[0];

        await actingPage.evaluate((desperate) => {
            const legal = window.__llNet.legal();
            const a = desperate
                ? (legal.find(x => x.type === 'concede') || legal.find(x => x.type === 'discard')
                    || legal.find(x => x.type === 'end-turn') || legal[0] || null)
                : window.__llNet.chooseAuto();
            if (a) window.__llNet.submit(a);
        }, stagnant >= 2);

        const bumped = await waitFor(async () => (await version(pages[0])) > st.version, 6000, null);
        stagnant = bumped ? 0 : stagnant + 1;
        if (stagnant >= 8) fail(`stalled at version ${st.version} (turn ${st.turn} pending=${st.pending})`);
    }

    if (winner == null) fail(`no winner after ${steps} steps`);
    await fullOracle('final');
    const finalHash = await pages[0].evaluate(() => window.__llNet.hash());

    for (let i = 0; i < N; i++) {
        if (errors[i].length) {
            for (const e of errors[i]) console.error(`P${i}: ${e}`);
            fail(`P${i} logged ${errors[i].length} page error(s)`);
        }
    }

    console.log(JSON.stringify({
        result: 'PASS', seed: SEED, latencies: LATENCIES, steps, winner,
        finalHash, disruptions
    }));

    await browser.close();
    await gameServer.close();
    for (const p of proxies) await p.close();
    await new Promise(r => httpServer.close(r));
    console.log(`\nCHAOS PASS: ${N}-player multi-network game to winner (seat ${winner}) in ${steps} steps — ${Object.entries(disruptions).map(([k, v]) => `${v} ${k}`).join(', ')} — all oracles green.`);
}

main().then(
    () => process.exit(0),
    (err) => { console.error(err.stack || err.message); process.exit(1); }
);
