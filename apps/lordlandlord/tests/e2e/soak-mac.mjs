// tests/e2e/soak-mac.mjs — real-device multiplayer soak tester.
//
// Drives N real headless browser clients on THIS machine (desktop Chromium by
// default; WebKit + an iPhone descriptor with LL_MOBILE=1) against a running
// lordlandlord stack (static site + WS server) and scripts the disruption
// scenarios that only a multi-client harness can exercise:
//
//   join            — create realm, join seats, start
//   reconnect       — a seat goes offline (real socket drop) and auto-rejoins
//   duplicate-tab   — a second tab in the same profile steals the seat; the
//                     old tab must yield without ping-ponging
//   simultaneous    — the turn-holder and an off-turn seat submit in the same
//                     tick; the authoritative server must not diverge
//
// Unlike refresh-resume.mjs (which spins up an in-process server so it can
// terminate sockets from the server side), this one points at an EXTERNAL
// stack over the real network — e.g. the OCI box over Tailscale — so the
// reconnect path runs through real latency/backoff. Disruptions are therefore
// driven from the client side (context offline, reload, second tab).
//
// It prints a readable, timestamped per-seat frame/state timeline to the
// terminal and a convergence (hash) oracle after every scenario.
//
// Usage:
//   node tests/e2e/soak-mac.mjs
//   LL_TARGET=http://100.82.110.116:18180 PLAYERS=3 ROUNDS=3 node tests/e2e/soak-mac.mjs
//   LL_WS=ws://100.82.110.116:18181 HEADED=1 node tests/e2e/soak-mac.mjs
//
// Env:
//   LL_TARGET   static-site base URL         (default http://100.82.110.116:18180)
//   LL_WS       ws url override              (default derived from LL_TARGET host :18181)
//   PLAYERS     number of seats 2..5         (default 3)
//   ROUNDS      disruption rounds            (default 2)
//   STEP_TURNS  productive steps per round   (default 6)
//   HEADED=1    show the browsers
//   VERBOSE=1   print a state row after every applied action (else once/turn)
//   LL_MOBILE=1 WebKit + iPhone descriptor (mobile viewport/touch/iOS Safari UA)
//   LL_DEVICE   playwright device name       (default 'iPhone 14', with LL_MOBILE)
//   LL_ENGINE   'chromium' | 'webkit'        (override engine without mobile profile)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, devices } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');

// ── config ────────────────────────────────────────────────────────────────────
// Target resolution:
//   LL_TARGET set  → drive an EXTERNAL stack (e.g. the box over Tailscale).
//   LL_TARGET unset → spin up a LOCAL stack in-process (self-contained; this is
//                     what CI uses — no box required).
const EXTERNAL = !!process.env.LL_TARGET;
let TARGET  = process.env.LL_TARGET || null;         // resolved in main() when local
let WS      = process.env.LL_WS || null;
let PAGE_URL = null;
const PLAYERS = Math.min(5, Math.max(2, Number(process.env.PLAYERS || 3)));
const ROUNDS  = Number(process.env.ROUNDS || 2);
const STEP    = Number(process.env.STEP_TURNS || 6);
const HEADED  = process.env.HEADED === '1';
const VERBOSE = process.env.VERBOSE === '1';
// Mobile approximation: LL_MOBILE=1 drives the WebKit engine (Safari's family)
// with an iPhone device descriptor — mobile viewport, isMobile, hasTouch, iOS
// Safari UA. Closest a headless run gets to an iPhone; it still submits actions
// programmatically, so touch-drag *gestures* remain human-only.
const MOBILE  = process.env.LL_MOBILE === '1';
const DEVICE  = process.env.LL_DEVICE || 'iPhone 14';
const ENGINE  = (process.env.LL_ENGINE === 'webkit' || MOBILE) ? webkit
              : (process.env.LL_ENGINE === 'chromium' ? chromium : chromium);
const CTX_OPTS = MOBILE ? { ...devices[DEVICE] } : {};

// ── tiny timeline logger ───────────────────────────────────────────────────────
const T0 = Date.now();
const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
const SEAT_TAG = ['P0', 'P1', 'P2', 'P3', 'P4'];
function stamp() {
    const ms = Date.now() - T0;
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    return `+${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function line(tag, msg)  { console.log(`[${stamp()}] ${tag.padEnd(8)} ${msg}`); }
function banner(msg)     { console.log(`\n══ ${msg} ${'═'.repeat(Math.max(0, 62 - msg.length))}`); }
let FAILS = 0;
function check(cond, msg) {
    if (cond) { line('ORACLE', `✓ ${msg}`); return true; }
    FAILS++;   line('ORACLE', `✗ ${msg}`); return false;
}

// ── per-client state helpers (all via the __llNet e2e hook) ─────────────────────
const netReady   = (p) => p.waitForFunction(() => !!window.__llNet, null, { timeout: 20000 });
const version    = (p) => p.evaluate(() => window.__llNet.version());
const seatOf     = (p) => p.evaluate(() => window.__llNet.seat);
const hashOf     = (p) => p.evaluate(() => window.__llNet.hash());
const snapshot   = (p) => p.evaluate(() => {
    const s = window.__llNet.getState();
    const seats = (s.players || []).map(pl => ({
        h: (pl.hand || []).length,
        g: (pl.bank || []).reduce((a, c) => a + (c && c.value ? c.value : 0), 0),
        sets: (pl.board || []).filter(set => set && set.complete).length,
    }));
    return { turn: s.turn, actionsLeft: s.actionsLeft, mustDiscard: s.mustDiscard,
             pending: !!s.pendingAction, winner: s.winner, version: s.version, seats };
});

async function stateRow(p, why) {
    const [snap, h] = await Promise.all([snapshot(p), hashOf(p)]);
    const seatStr = snap.seats.map((s, i) =>
        `${SEAT_TAG[i]}(H:${s.h} G:${s.g} S:${s.sets})`).join(' ');
    const flags = [snap.pending ? 'PENDING' : '', snap.mustDiscard ? `DISCARD:${snap.mustDiscard}` : '']
        .filter(Boolean).join(' ');
    line('FRAME', `v${String(snap.version).padStart(3)} turn=${snap.turn} act=${snap.actionsLeft} ${flags}  ${seatStr}  #${String(h).slice(0, 8)}  ${why}`);
    return snap;
}

const bannerVisible = (p, id) => p.evaluate((bid) => {
    const el = document.getElementById(bid);
    return !!el && !el.classList.contains('hidden');
}, id);
const bannerText = (p, id) => p.evaluate((bid) => {
    const el = document.getElementById(bid);
    return el && !el.classList.contains('hidden') ? (el.textContent || '') : '';
}, id);

async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        let v; try { v = await fn(); } catch { v = false; }
        if (v) return v;
        if (Date.now() > end) { if (what) { FAILS++; line('ORACLE', `✗ timeout: ${what}`); } return null; }
        await new Promise(r => setTimeout(r, 60));
    }
}

// Spin up the app's own static server + WS game server in-process, so the soak
// is fully self-contained (CI, or the Mac without the box). Mirrors the setup
// refresh-resume.mjs uses. Returns a close() that tears both down.
async function startLocalStack() {
    const express = (await import('express')).default;
    const { createGameServer } = await import('../../server/index.js');
    const app = express();
    app.get('/favicon.ico', (_req, res) => res.status(204).end());
    app.use(express.static(path.join(APP_ROOT, 'src')));
    const httpServer = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const httpPort = httpServer.address().port;
    const gameServer = await createGameServer({ port: 0 });
    return {
        target: `http://127.0.0.1:${httpPort}`,
        ws: `ws://127.0.0.1:${gameServer.port}`,
        close: async () => {
            await gameServer.close().catch(() => {});
            await new Promise(r => httpServer.close(r));
        },
    };
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
    // Resolve the target: external (box) or a fresh in-process local stack.
    let localStack = null;
    if (EXTERNAL) {
        WS = WS || `ws://${new URL(TARGET).hostname}:18181`;
    } else {
        localStack = await startLocalStack();
        TARGET = localStack.target;
        WS = localStack.ws;
    }
    PAGE_URL = `${TARGET}/?ws=${encodeURIComponent(WS)}`;

    banner(`SOAK: ${PLAYERS} clients → ${TARGET}  (ws ${WS})`);
    line('SETUP', `engine=${MOBILE ? `webkit/${DEVICE} (mobile)` : ENGINE.name()}  mode=${EXTERNAL ? 'external' : 'local'}  page ${PAGE_URL}`);

    // reachability preflight so we fail fast with a clear message
    try {
        const res = await fetch(TARGET, { method: 'GET' });
        line('SETUP', `static site reachable: HTTP ${res.status}`);
    } catch (e) {
        console.error(`\nCannot reach ${TARGET}${EXTERNAL ? ' — is the box stack up?' : ''} (${e.message})`);
        if (localStack) await localStack.close();
        process.exit(2);
    }

    const browser = await ENGINE.launch({ headless: !HEADED });
    const errors = {};                                  // tag -> [msgs]
    const clients = [];                                 // {tag, seat, page, ctx}

    async function newClient(tag, ctx) {
        const context = ctx || await browser.newContext(CTX_OPTS);
        const page = await context.newPage();
        // Record every WebSocket the page opens so a scenario can force a real
        // close(). context.setOffline() only silences the socket — it never
        // fires onclose — so the app can't detect the drop from that alone.
        await page.addInitScript(() => {
            const Native = window.WebSocket;
            window.__llSockets = [];
            window.WebSocket = function (...args) {
                const ws = new Native(...args);
                window.__llSockets.push(ws);
                return ws;
            };
            window.WebSocket.prototype = Native.prototype;
            Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
        });
        errors[tag] = errors[tag] || [];
        page.on('pageerror', e => errors[tag].push(`pageerror: ${e.message}`));
        page.on('console', m => {
            if (m.type() !== 'error') return;
            const t = m.text();
            // The RECONNECT scenario deliberately takes the client offline, so the
            // browser logs failed WS-connect attempts. That noise is the expected
            // artifact of the test, not a defect — don't count it as a violation.
            if (/ERR_INTERNET_DISCONNECTED/.test(t) ||
                (/WebSocket connection to/.test(t) && /failed/.test(t))) return;
            // Static-asset load failures (e.g. a missing card image) are out of
            // scope for a sync/reconnect soak — a dedicated asset test owns those.
            if (/Failed to load resource/.test(t)) return;
            errors[tag].push(`console.error: ${t.slice(0, 200)}`);
        });
        await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
        // index.html boots main.js via an async dynamic import(), so init()
        // wires the lobby buttons AFTER domcontentloaded. Interacting before the
        // handlers exist silently no-ops (the earlier flaky "LOCAL-TEST" races).
        await page.waitForFunction(() => {
            const c = document.getElementById('btn-create-game');
            const j = document.getElementById('btn-join-game');
            return typeof c?.onclick === 'function' && typeof j?.onclick === 'function';
        }, null, { timeout: 20000 });
        return { page, context };
    }

    // ── scenario: JOIN ──────────────────────────────────────────────────────────
    banner('scenario JOIN — create realm, seat everyone, start');
    const host = await newClient('P0');
    clients.push({ tag: 'P0', page: host.page, ctx: host.context });
    await host.page.fill('#player-name-create', NAMES[0]);
    await host.page.click('#btn-create-game');
    // The server round-trips a real room id via a 'joined' frame; until then
    // #lobby-id-display holds the static 'LOCAL-TEST' placeholder. Waiting only
    // on length would accept that placeholder before the WS even connected.
    await host.page.waitForFunction(() => {
        const el = document.getElementById('lobby-id-display');
        const lobby = document.getElementById('lobby-container');
        const t = el ? el.textContent.trim() : '';
        return el && lobby && !lobby.classList.contains('hidden')
            && t.length >= 6 && t !== 'LOCAL-TEST' && !t.startsWith('Joining');
    }, null, { timeout: 25000 });
    const roomId = (await host.page.textContent('#lobby-id-display')).trim();
    line('P0', `created realm ${roomId} (server-assigned)`);

    for (let i = 1; i < PLAYERS; i++) {
        const tag = SEAT_TAG[i];
        const c = await newClient(tag);
        clients.push({ tag, page: c.page, ctx: c.context });
        await c.page.fill('#player-name-join', NAMES[i]);
        await c.page.fill('#join-game-id', roomId);
        await c.page.click('#btn-join-game');
        // Confirm THIS joiner actually reached the room (its own display flips to
        // the real id) and the host now counts it, before moving on.
        await c.page.waitForFunction(
            id => (document.getElementById('lobby-id-display')?.textContent.trim() === id),
            roomId, { timeout: 20000 });
        await host.page.waitForFunction(
            n => /\((\d+)\)/.test(document.getElementById('btn-start-game')?.textContent || '')
                 && Number(RegExp.$1) >= n,
            i + 1, { timeout: 20000 });
        line(tag, `${NAMES[i]} seated in ${roomId} (host sees ${i + 1})`);
    }
    await host.page.waitForFunction(() => !document.getElementById('btn-start-game').disabled, null, { timeout: 20000 });
    await host.page.click('#btn-start-game');
    for (const c of clients) await netReady(c.page);
    for (const c of clients) c.seat = await seatOf(c.page);
    check(new Set(clients.map(c => c.seat)).size === clients.length, `all ${PLAYERS} seats distinct: [${clients.map(c => `${c.tag}=${c.seat}`).join(', ')}]`);
    line('JOIN', `realm ${roomId} started with ${PLAYERS} seats`);
    await assertConverged(clients, 'post-join');

    const pageForSeat = (seat) => clients.find(c => c.seat === seat)?.page;

    // one productive step: the right actor submits chooseAuto and everyone advances
    async function playStep() {
        await waitFor(async () => await allConverged(clients), 12000, 'clients to converge before step');
        const base = await snapshot(clients[0].page);
        if (base.winner != null) return 'winner';

        // find who should act: a reactor if pending, else the turn holder
        let acting = null;
        if (base.pending) {
            for (const c of clients) {
                const canReact = await c.page.evaluate(() =>
                    window.__llNet.legal().some(a => a.type === 'concede' || a.type === 'react-no'));
                if (canReact) { acting = c; break; }
            }
        }
        if (!acting) acting = clients.find(c => c.seat === base.turn) || clients[0];

        await acting.page.evaluate(() => {
            const a = window.__llNet.chooseAuto()
                || window.__llNet.legal().find(x => x.type === 'end-turn')
                || window.__llNet.legal()[0] || null;
            if (a) window.__llNet.submit(a);
        });
        const bumped = await waitFor(async () => (await version(clients[0].page)) > base.version, 4000, null);
        if (VERBOSE || bumped) await stateRow(clients[0].page, `${acting.tag} acted`);
        return bumped ? 'ok' : 'stall';
    }

    async function playSteps(n, label) {
        let ok = 0, stall = 0;
        while (ok < n) {
            const r = await playStep();
            if (r === 'winner') { line(label, 'game reached a winner'); return true; }
            if (r === 'ok') { ok++; stall = 0; }
            else if (++stall >= 6) { check(false, `${label}: game stalled`); return false; }
        }
        return false;
    }

    // ── disruption rounds ─────────────────────────────────────────────────────────
    const victimSeats = clients.filter(c => c.seat !== 0).map(c => c.seat);
    for (let round = 1; round <= ROUNDS; round++) {
        const won = await playSteps(STEP, `round ${round}`);
        if (won) break;

        const victimSeat = victimSeats[(round - 1) % victimSeats.length];

        // pick the scenario for this round, cycling through the three client-side ones
        const which = (round - 1) % 3;
        if (which === 0)      await scnReconnect(victimSeat);
        else if (which === 1) await scnDuplicateTab(victimSeat);
        else                  await scnSimultaneous();

        await assertConverged(clients, `round ${round} post-disruption`);
        await playSteps(3, `round ${round} post-play`);
        await assertConverged(clients, `round ${round} settled`);
    }

    // ── report ────────────────────────────────────────────────────────────────────
    banner('HYGIENE — page errors');
    let errTotal = 0;
    for (const tag of Object.keys(errors)) {
        for (const e of errors[tag]) { console.error(`  ${tag}: ${e}`); errTotal++; }
    }
    check(errTotal === 0, `no page/console errors across ${Object.keys(errors).length} clients`);

    await browser.close();
    if (localStack) await localStack.close();
    banner(FAILS === 0 ? 'SOAK PASS — all scenarios converged, no errors'
                       : `SOAK FAIL — ${FAILS} oracle violation(s)`);
    process.exit(FAILS === 0 ? 0 : 1);

    // ── scenario impls (closures over clients/roomId) ───────────────────────────

    async function scnReconnect(seat) {
        banner(`scenario RECONNECT — seat ${seat} drops offline and auto-rejoins`);
        const victim = clients.find(c => c.seat === seat);
        const other  = clients.find(c => c.seat !== seat);
        line(victim.tag, 'going offline (real socket drop)…');
        // Offline first so reconnect attempts fail (keeps the banner up for a
        // realistic window), THEN actually close the live socket so the app's
        // onclose fires and it enters the reconnecting state.
        await victim.ctx.setOffline(true);
        await victim.page.evaluate(() =>
            (window.__llSockets || []).forEach(s => { try { s.close(); } catch (_) {} }));
        // victim shows its reconnecting banner; a peer sees the seat drop
        await waitFor(() => bannerVisible(victim.page, 'net-status-banner'), 12000, `${victim.tag} reconnecting banner`);
        await waitFor(() => bannerVisible(other.page, 'net-peers-banner'), 12000, `peer disconnected-seat banner`);
        line(victim.tag, 'banners up; staying dark ~4s');
        await new Promise(r => setTimeout(r, 4000));
        await victim.ctx.setOffline(false);
        line(victim.tag, 'back online; expecting auto-rejoin on the same seat');
        await waitFor(async () => !(await bannerVisible(victim.page, 'net-status-banner')), 25000, `${victim.tag} banner clears after rejoin`);
        await waitFor(async () => !(await bannerVisible(other.page, 'net-peers-banner')), 25000, `peer banner clears`);
        check((await seatOf(victim.page)) === seat, `${victim.tag} kept seat ${seat} through reconnect`);
    }

    async function scnDuplicateTab(seat) {
        banner(`scenario DUPLICATE-TAB — second tab steals seat ${seat}, old tab must yield`);
        const victim = clients.find(c => c.seat === seat);
        const dupTag = `${victim.tag}b`;
        const dup = await newClient(dupTag, victim.ctx);          // SAME context → shared localStorage
        await netReady(dup.page);
        check((await seatOf(dup.page)) === seat, `${dupTag} auto-resumed seat ${seat}`);
        // Generous timeout: the displaced banner renders on the (now idle) old
        // tab, whose JS event loop can be starved for many seconds when several
        // Chromium pages share a loaded CI runner. The displacement itself is
        // instant server-side; this only waits for the paint.
        const yielded = await waitFor(async () => (await bannerText(victim.page, 'net-status-banner')).includes('another tab'), 45000, `${victim.tag} old tab shows 'another tab' displaced banner`);
        // old tab must stay quiet (no rejoin flap / ping-pong)
        await new Promise(r => setTimeout(r, 2500));
        check(await bannerVisible(victim.page, 'net-status-banner'), `${victim.tag} stayed yielded (no ping-pong)`);
        // hand the seat to the winning tab and retire the old page
        await victim.page.close().catch(() => {});
        victim.page = dup.page;                                   // new tab is now this seat
        if (yielded) line(dupTag, 'seat now played in the new tab; old tab retired');
    }

    async function scnSimultaneous() {
        banner('scenario SIMULTANEOUS — turn-holder and an off-turn seat submit in the same tick');
        await waitFor(async () => await allConverged(clients), 12000, 'converge before simultaneous submit');
        const base = await snapshot(clients[0].page);
        const holder = clients.find(c => c.seat === base.turn);
        const other  = clients.find(c => c.seat !== base.turn);
        if (!holder || !other) { line('SIMUL', 'not enough live seats; skipping'); return; }
        line('SIMUL', `${holder.tag}(turn) and ${other.tag}(off-turn) fire together at v${base.version}`);
        // fire both without awaiting between them → racing submits at the server
        await Promise.all([
            holder.page.evaluate(() => {
                const a = window.__llNet.chooseAuto() || window.__llNet.legal().find(x => x.type === 'end-turn');
                if (a) window.__llNet.submit(a);
            }),
            other.page.evaluate(() => {
                // an off-turn seat's "best" action — server must reject if illegal
                const a = window.__llNet.chooseAuto() || window.__llNet.legal()[0];
                if (a) window.__llNet.submit(a);
            }),
        ]);
        await waitFor(async () => (await version(clients[0].page)) > base.version, 5000, 'a submit to be accepted');
        // the real assertion is convergence (done by caller) — no split-brain
        check(await allConverged(clients), 'no split-brain after simultaneous submit');
    }
}

// ── convergence oracle across all live clients ───────────────────────────────────
async function allConverged(clients) {
    const live = clients.filter(c => !c.page.isClosed());
    const vs = await Promise.all(live.map(c => version(c.page).catch(() => -1)));
    return vs.every(v => v === vs[0] && v >= 0);
}
async function assertConverged(clients, label) {
    const live = clients.filter(c => !c.page.isClosed());
    await waitFor(async () => await allConverged(clients), 15000, `${label}: versions converge`);
    const hs = await Promise.all(live.map(c => hashOf(c.page).catch(() => 'ERR')));
    const same = hs.every(h => h === hs[0]);
    check(same, `${label}: ${live.length} clients agree on hash ${String(hs[0]).slice(0, 8)}${same ? '' : ` — got [${hs.map(h => String(h).slice(0,8)).join(', ')}]`}`);
}

main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
