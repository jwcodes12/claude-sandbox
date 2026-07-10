// promo/hotfix-drill.mjs — prove hotfix-while-playing against the LIVE services.
// Two browsers join a real game on the production ws server (:18181), play,
// then `systemctl --user restart lordlandlord-ws` fires mid-game. The room is
// restored from var/rooms.json and both clients rejoin + resume by themselves.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:18180/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        let v = null;
        try { v = await fn(); } catch { /* transient */ }
        if (v) return v;
        if (Date.now() > end) throw new Error(`timeout: ${what}`);
        await sleep(80);
    }
}

const browser = await chromium.launch();
const pages = [];
for (const name of ['Drill-A', 'Drill-B']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => console.error(`${name} pageerror:`, e.message));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    pages.push(page);
}
const [A, B] = pages;

await A.fill('#player-name-create', 'Drill-A');
await A.click('#btn-create-game');
await A.waitForFunction(() => {
    const el = document.getElementById('lobby-id-display');
    return el && el.textContent.trim().length >= 8;
}, null, { timeout: 15000 });
const roomId = (await A.textContent('#lobby-id-display')).trim();
await B.fill('#player-name-join', 'Drill-B');
await B.fill('#join-game-id', roomId);
await B.click('#btn-join-game');
await A.waitForFunction(() => !document.getElementById('btn-start-game').disabled, null, { timeout: 15000 });
await A.click('#btn-start-game');
for (const p of pages) await p.waitForFunction(() => !!window.__llNet, null, { timeout: 15000 });
console.log(`live game ${roomId} started on production ws`);

const version = (p) => p.evaluate(() => window.__llNet.version());
async function playSteps(n) {
    for (let done = 0, stagnant = 0; done < n;) {
        await waitFor(async () => (await version(A)) === (await version(B)), 15000, 'converge');
        const st = await A.evaluate(() => {
            const s = window.__llNet.getState();
            return { turn: s.turn, version: s.version, winner: s.winner, pending: !!s.pendingAction };
        });
        if (st.winner != null) return;
        let acting = st.pending ? null : (st.turn === 0 ? A : B);
        if (!acting) {
            for (const p of pages) {
                if (await p.evaluate(() => window.__llNet.legal().some(a => a.type === 'concede' || a.type === 'react-no'))) { acting = p; break; }
            }
            acting = acting || A;
        }
        await acting.evaluate((d) => {
            const legal = window.__llNet.legal();
            const a = d ? (legal.find(x => x.type === 'concede') || legal.find(x => x.type === 'discard') || legal.find(x => x.type === 'end-turn') || legal[0]) : window.__llNet.chooseAuto();
            if (a) window.__llNet.submit(a);
        }, stagnant >= 2);
        const before = st.version;
        const bumped = await waitFor(async () => (await version(A)) > before, 5000, 'bump').catch(() => false);
        if (bumped) { done++; stagnant = 0; } else if (++stagnant >= 6) throw new Error('stalled');
    }
}

await playSteps(5);
const vBefore = await version(A);
const hashBefore = await A.evaluate(() => window.__llNet.hash());
console.log(`pre-hotfix: version ${vBefore}, hash ${hashBefore}`);

console.log('>>> HOTFIX: restarting lordlandlord-ws mid-game...');
execSync('systemctl --user restart lordlandlord-ws');

// Both clients must rejoin + resume on their own and land on the same state.
await waitFor(async () => {
    const [vA, vB, hA, hB] = await Promise.all([
        version(A), version(B),
        A.evaluate(() => window.__llNet.hash()),
        B.evaluate(() => window.__llNet.hash()),
    ]);
    return vA === vBefore && vB === vBefore && hA === hashBefore && hB === hashBefore;
}, 30000, 'both clients to rejoin the restored room with identical state');
console.log('post-hotfix: both clients rejoined the restored room, state intact');

await playSteps(3);
const hashAfter = await A.evaluate(() => window.__llNet.hash());
const hashAfterB = await B.evaluate(() => window.__llNet.hash());
if (hashAfter !== hashAfterB) throw new Error(`diverged after restart: ${hashAfter} vs ${hashAfterB}`);
console.log(`post-hotfix play: converged at ${hashAfter}`);

// tidy: leave the drill room so it reaps quickly
for (const p of pages) await p.evaluate(() => { try { localStorage.clear(); } catch {} });
await browser.close();
console.log('\nHOTFIX DRILL PASS: server restarted mid-game, nobody lost their seat.');
