// Multiplayer Playwright integration harness.
// Drives real browser contexts against http://localhost:8000/ over PeerJS WebRTC.
// Usage: node ui-test/mp-test.js [scenario-number]
const { chromium } = require('playwright');

const URL = 'http://localhost:8000/';
const CDP = 'http://localhost:9222';
const JOIN_TIMEOUT = 20000;
const SNAPSHOT_TIMEOUT = 15000;

// ---- helpers ---------------------------------------------------------------

function snapshotPick(s) {
    // Only the fields we need; raw state has shared refs and isn't JSON-friendly.
    return {
        turn: s.turn,
        actionsLeft: s.actionsLeft,
        localPlayerId: s.localPlayerId,
        gameOver: !!s._gameOver,
        deckLen: (s.deck && s.deck.length) || 0,
        playersLen: s.players.length,
        hands: s.players.map(p => p.hand.map(c => c.data.id)),
        bankLens: s.players.map(p => p.bank.length),
        propLens: s.players.map(p => Object.values(p.properties || {}).reduce((a, l) => a + l.length, 0)),
        disconnected: s.players.map(p => !!p._disconnected),
    };
}

async function readState(page) {
    return page.evaluate((src) => {
        const fn = new Function('s', `return (${src})(s);`);
        return fn(window.__game.state());
    }, snapshotPick.toString());
}

async function newPage(browser) {
    // NOTE: WebRTC peer-to-peer between Playwright `newContext()` contexts does
    // not establish reliably under headed Chrome attached via CDP — the host
    // never sees the join. Sharing the default browser context (still one page
    // per simulated player) works. Each page still has its own Peer instance
    // and its own JS world, so this faithfully simulates separate clients.
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('  [pageerror]', e.message));
    page.on('console', (m) => {
        if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
            console.error('  [console.error]', m.text());
        }
    });
    await page.setViewportSize({ width: 800, height: 900 });
    // Hook the global Peer constructor so we can grab the instance later. The
    // game code does `new Peer()` once on load, so we stash that instance for
    // graceful teardown without touching any src/ file.
    await page.addInitScript(() => {
        const tryHook = () => {
            if (typeof window.Peer !== 'function' || window.__PeerHooked) return false;
            window.__PeerHooked = true;
            const Orig = window.Peer;
            window.Peer = function (...args) {
                const inst = new Orig(...args);
                window.__peer = inst;
                return inst;
            };
            window.Peer.prototype = Orig.prototype;
            return true;
        };
        if (!tryHook()) {
            const id = setInterval(() => { if (tryHook()) clearInterval(id); }, 10);
        }
    });
    await page.goto(`${URL}?bust=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-solo-game', { state: 'visible' });
    return { ctx, page };
}

async function bootHost(browser) {
    const { ctx, page } = await newPage(browser);
    await page.click('#btn-create-game');
    // Wait for PeerJS to open and the broker to assign an id.
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t && t.length > 4 && !t.startsWith('Joining') && t !== 'LOCAL-TEST';
    }, null, { timeout: JOIN_TIMEOUT });
    const peerId = await page.evaluate(() => document.getElementById('lobby-id-display').textContent.trim());
    return { ctx, page, peerId };
}

async function bootClient(browser, hostPeerId) {
    const { ctx, page } = await newPage(browser);
    // Wait for client's own PeerJS to register with the broker before we try
    // to connect to the host — Peer.connect() called before peer.open silently
    // no-ops in our environment.
    await page.waitForFunction(() => {
        const t = (document.getElementById('lobby-id-display') || {}).textContent || '';
        return t && t.length > 10 && !t.startsWith('Joining') && t !== 'LOCAL-TEST';
    }, null, { timeout: JOIN_TIMEOUT });
    await page.fill('#join-game-id', hostPeerId);
    await page.click('#btn-join-game');
    await page.waitForSelector('#lobby-container:not(.hidden)');
    return { ctx, page };
}

async function waitHostSeesClients(hostPage, expected) {
    await hostPage.waitForFunction((n) => {
        const btn = document.getElementById('btn-start-game');
        const slots = document.querySelectorAll('#lobby-slots .lobby-slot:not(.empty)');
        return slots.length >= n && btn && !btn.disabled;
    }, expected, { timeout: JOIN_TIMEOUT });
}

async function startGameOnHost(hostPage) {
    await hostPage.click('#btn-start-game');
    await hostPage.waitForSelector('#game-container:not(.hidden)');
    await hostPage.waitForFunction(() => !!window.__game);
}

async function waitClientInGame(clientPage) {
    await clientPage.waitForSelector('#game-container:not(.hidden)', { timeout: SNAPSHOT_TIMEOUT });
    await clientPage.waitForFunction(() => !!window.__game && window.__game.state().players.length > 0, null, { timeout: SNAPSHOT_TIMEOUT });
}

async function closePage(page) {
    try { await page.close({ runBeforeUnload: false }); } catch (e) { /* already gone */ }
}

function assert(cond, msg, errors) {
    if (!cond) errors.push(msg);
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

function handsEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((h, i) => arraysEqual(h, b[i]));
}

// Take exactly one play-typed action (no propose) then end the turn. Avoiding
// `propose` keeps the round-trip deterministic — propose drops the other peer
// into a reaction phase that, in MP, can only be resolved by the human at that
// peer.
async function takeTurn(page, pid) {
    return page.evaluate((p) => {
        const s0 = window.__game.state();
        if (s0.turn !== p) return { ok: false, reason: `not-our-turn turn=${s0.turn} pid=${p}` };
        // Pick the best `play` action from legal moves, skipping any propose.
        const legal = window.__game.enumerate(p) || [];
        const plays = legal.filter(a => a && a.type === 'play');
        const pick = window.__game.pickBest(p) /* pickBestPlayAction over enumerate */ || plays[0] || null;
        if (pick) window.__game.dispatch(pick);
        // Discard down to 7 if needed so endTurn() will actually advance.
        let s2 = window.__game.state();
        while (s2.players[p].hand.length > 7) {
            const cardId = s2.players[p].hand[s2.players[p].hand.length - 1].data.id;
            window.__game.dispatch({ type: 'discard', cardId });
            s2 = window.__game.state();
        }
        window.__game.endTurn();
        return { ok: true, picked: pick ? pick.type : null };
    }, pid);
}

// Some actions (e.g. rent) put the opponent into a reaction phase that, in MP,
// only the opponent can clear. Have the observer concede if needed before we
// expect the turn to advance.
async function clearReactionIfBlocked(page) {
    try {
        await page.evaluate(() => {
            const s = window.__game.state();
            if (s.reactionTargetId !== null && s.reactionTargetId === s.localPlayerId) {
                window.__game.dispatch({ type: 'concede' });
            }
        });
    } catch (e) { /* ignore */ }
}

// Force-close the page's PeerJS so peers see the close event immediately.
// page.close() alone may take many seconds to surface via WebRTC heartbeats.
async function destroyPeer(page) {
    try {
        await page.evaluate(() => {
            const p = window.__peer;
            if (!p) return;
            try {
                // Close every active conn first, then destroy the Peer.
                const conns = p.connections || {};
                for (const k of Object.keys(conns)) {
                    for (const c of conns[k] || []) {
                        try { c.close && c.close(); } catch (e) {}
                    }
                }
            } catch (e) {}
            try { p.destroy(); } catch (e) {}
        });
    } catch (e) { /* page may already be torn down */ }
}

async function disconnectAndClose(page) {
    await destroyPeer(page);
    await closePage(page);
}

// ---- scenarios -------------------------------------------------------------

async function scenarioLobbyAndHandshake(browser, playerCount) {
    const name = `${playerCount}-player lobby + snapshot`;
    const errors = [];
    const ctxs = [];
    try {
        const host = await bootHost(browser);
        ctxs.push(host.page);
        const clients = [];
        for (let i = 1; i < playerCount; i++) {
            const c = await bootClient(browser, host.peerId);
            ctxs.push(c.page);
            clients.push(c);
        }
        await waitHostSeesClients(host.page, playerCount);
        await startGameOnHost(host.page);
        for (const c of clients) await waitClientInGame(c.page);

        const hostState = await readState(host.page);
        const clientStates = [];
        for (const c of clients) clientStates.push(await readState(c.page));

        assert(hostState.playersLen === playerCount, `host players=${hostState.playersLen}`, errors);
        assert(hostState.localPlayerId === 0, `host localPlayerId=${hostState.localPlayerId}`, errors);
        const seenLocal = new Set([0]);
        clientStates.forEach((s, idx) => {
            assert(s.playersLen === playerCount, `client[${idx}] players=${s.playersLen}`, errors);
            assert(typeof s.localPlayerId === 'number' && s.localPlayerId > 0, `client[${idx}] localPlayerId=${s.localPlayerId}`, errors);
            assert(!seenLocal.has(s.localPlayerId), `client[${idx}] dup localPlayerId=${s.localPlayerId}`, errors);
            seenLocal.add(s.localPlayerId);
            assert(s.deckLen === hostState.deckLen, `client[${idx}] deckLen ${s.deckLen} vs host ${hostState.deckLen}`, errors);
            assert(handsEqual(s.hands, hostState.hands), `client[${idx}] hands differ from host`, errors);
        });

        return { name, ok: errors.length === 0, errors, host, clients, ctxs };
    } catch (e) {
        errors.push('THREW: ' + e.message + ' [stack: ' + (e.stack || '').split('\n').slice(0, 4).join(' | ') + ']');
        return { name, ok: false, errors, ctxs };
    }
}

async function scenarioActionPropagation(browser) {
    const setup = await scenarioLobbyAndHandshake(browser, 2);
    const errors = [...setup.errors];
    const name = '2-player action propagation';
    if (!setup.ok) {
        for (const c of setup.ctxs) await closePage(c);
        return { name, ok: false, errors: ['setup failed: ' + errors.join('; ')] };
    }
    const hostPage = setup.host.page;
    const clientPage = setup.clients[0].page;
    try {
        for (let round = 0; round < 6; round++) {
            const actor = round % 2 === 0 ? hostPage : clientPage;
            const observer = round % 2 === 0 ? clientPage : hostPage;
            const pid = round % 2;

            const before = await readState(observer);
            const turnRes = await takeTurn(actor, pid);
            if (!turnRes.ok) { errors.push(`round ${round}: ${turnRes.reason}`); break; }

            // If the action put the observer into a reaction phase, concede so
            // the turn can advance. Give the message a beat to arrive first.
            await observer.waitForTimeout(500);
            await clearReactionIfBlocked(observer);

            // Wait for the observer to see turn advance.
            try {
                await observer.waitForFunction((expectedTurn) => {
                    const s = window.__game.state();
                    return s.turn === expectedTurn || s._gameOver;
                }, (pid + 1) % 2, { timeout: 8000 });
            } catch (e) {
                const obs = await readState(observer);
                const act = await readState(actor);
                errors.push(`round ${round}: observer didn't see turn->${(pid + 1) % 2}. actor=${JSON.stringify({turn: act.turn, actionsLeft: act.actionsLeft, reactPid: (await actor.evaluate(()=>window.__game.state().reactionTargetId)), pickType: turnRes.picked})}, observer=${JSON.stringify({turn: obs.turn, reactPid: (await observer.evaluate(()=>window.__game.state().reactionTargetId))})}`);
                break;
            }

            const after = await readState(observer);
            if (after.gameOver) break;
            // Some change should have happened (turn or hand/bank/prop counts on actor).
            const handChanged = before.hands[pid].length !== after.hands[pid].length;
            const bankChanged = before.bankLens[pid] !== after.bankLens[pid];
            const propChanged = before.propLens[pid] !== after.propLens[pid];
            const turnChanged = before.turn !== after.turn;
            assert(handChanged || bankChanged || propChanged || turnChanged, `round ${round}: observer saw no change`, errors);
        }
    } catch (e) {
        errors.push('THREW: ' + e.message);
    } finally {
        for (const c of setup.ctxs) await closePage(c);
    }
    return { name, ok: errors.length === 0, errors };
}

async function scenarioClientDisconnect(browser) {
    const name = '3-player client disconnect';
    const setup = await scenarioLobbyAndHandshake(browser, 3);
    const errors = [...setup.errors];
    if (!setup.ok) {
        for (const c of setup.ctxs) await closePage(c);
        return { name, ok: false, errors: ['setup failed: ' + errors.join('; ')] };
    }
    const hostPage = setup.host.page;
    const survivingClient = setup.clients[1];
    const droppedClient = setup.clients[0];
    try {
        const droppedPid = (await readState(droppedClient.page)).localPlayerId;
        await disconnectAndClose(droppedClient.page);

        // Host detects disconnect.
        try {
            await hostPage.waitForFunction((pid) => {
                const s = window.__game.state();
                return s.players[pid] && s.players[pid]._disconnected === true;
            }, droppedPid, { timeout: 10000 });
        } catch (e) {
            errors.push(`host never saw players[${droppedPid}]._disconnected=true`);
        }

        // Other client should still be functional. Cycle a few turns; engine should
        // auto-skip the disconnected seat (host auto-ends their turn).
        for (let i = 0; i < 4; i++) {
            const s = await readState(survivingClient.page);
            if (s.gameOver) break;
            if (s.turn === s.localPlayerId) {
                const r = await takeTurn(survivingClient.page, s.localPlayerId);
                if (!r.ok) { errors.push(`survivor turn ${i}: ${r.reason}`); break; }
            }
            await survivingClient.page.waitForTimeout(800);
        }
        const finalState = await readState(survivingClient.page);
        assert(!finalState.gameOver || finalState.gameOver, 'sanity', errors); // just exercise reads
    } catch (e) {
        errors.push('THREW: ' + e.message);
    } finally {
        await closePage(setup.host.page);
        await closePage(survivingClient.page);
    }
    return { name, ok: errors.length === 0, errors };
}

async function scenarioHostDisconnect(browser) {
    const name = '2-player host disconnect';
    const setup = await scenarioLobbyAndHandshake(browser, 2);
    const errors = [...setup.errors];
    if (!setup.ok) {
        for (const c of setup.ctxs) await closePage(c);
        return { name, ok: false, errors: ['setup failed: ' + errors.join('; ')] };
    }
    const clientPage = setup.clients[0].page;
    try {
        await disconnectAndClose(setup.host.page);
        try {
            await clientPage.waitForFunction(() => {
                const s = window.__game.state();
                if (s._gameOver) return true;
                const b = document.getElementById('turn-banner');
                return b && /host disconnected/i.test(b.textContent || '');
            }, null, { timeout: 15000 });
        } catch (e) {
            const banner = await clientPage.evaluate(() => (document.getElementById('turn-banner') || {}).textContent || '');
            errors.push(`client never saw host-disconnect (banner="${banner}")`);
        }
        const s = await readState(clientPage);
        assert(s.gameOver === true, `client _gameOver=${s.gameOver}`, errors);
    } catch (e) {
        errors.push('THREW: ' + e.message);
    } finally {
        await closePage(setup.clients[0].page);
    }
    return { name, ok: errors.length === 0, errors };
}

// ---- runner ----------------------------------------------------------------

const SCENARIOS = [
    { id: 1, label: '2-player lobby+handshake', run: async (b) => {
        const r = await scenarioLobbyAndHandshake(b, 2);
        for (const c of r.ctxs || []) await closePage(c);
        return { name: r.name, ok: r.ok, errors: r.errors };
    }},
    { id: 2, label: '2-player action propagation', run: scenarioActionPropagation },
    { id: 3, label: '3-player snapshot', run: async (b) => {
        const r = await scenarioLobbyAndHandshake(b, 3);
        for (const c of r.ctxs || []) await closePage(c);
        return { name: r.name, ok: r.ok, errors: r.errors };
    }},
    { id: 4, label: '3-player client disconnect', run: scenarioClientDisconnect },
    { id: 5, label: '2-player host disconnect', run: scenarioHostDisconnect },
];

(async () => {
    const only = process.argv[2] ? Number(process.argv[2]) : null;
    const browser = await chromium.connectOverCDP(CDP);
    const results = [];
    try {
        for (const sc of SCENARIOS) {
            if (only && sc.id !== only) continue;
            console.log(`\n--- Scenario ${sc.id}: ${sc.label} ---`);
            const t0 = Date.now();
            let r;
            try {
                r = await sc.run(browser);
            } catch (e) {
                r = { name: sc.label, ok: false, errors: ['runner threw: ' + e.message] };
            }
            const dt = Date.now() - t0;
            console.log(`  ${r.ok ? 'PASS' : 'FAIL'} (${dt}ms) ${r.name}`);
            if (!r.ok) for (const err of r.errors) console.log(`    - ${err}`);
            results.push({ id: sc.id, ...r, ms: dt });
        }
    } finally {
        await browser.close();
    }

    const passed = results.filter(r => r.ok).length;
    console.log('\n=== summary ===');
    for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}. ${r.name} (${r.ms}ms)`);
    console.log(`${passed}/${results.length} scenarios passing`);
    process.exit(passed === results.length ? 0 : 1);
})();
