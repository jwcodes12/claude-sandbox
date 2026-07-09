// Strategic Game Suite — runs many full games with distinct bot strategies and
// validates the DOM after every dispatch. Captures violations to /tmp/strategic-games.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:8000/';
const OUT_DIR = '/tmp/strategic-games';
const MAX_TURNS = 250;
const GAMES_PER_MATCHUP = 2;

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const STRATEGIES = ['AGGRESSIVE', 'GREEDY', 'BUILDER', 'DEFENSIVE', 'BALANCED'];

const DEVICES = [
    { name: 'iPhone SE', viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 },
    { name: 'iPhone 14', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
    { name: 'Pixel 7',   viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6 },
];

function combos3(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i++)
        for (let j = i + 1; j < arr.length; j++)
            for (let k = j + 1; k < arr.length; k++)
                out.push([arr[i], arr[j], arr[k]]);
    return out;
}

// Strategy and validator code installed page-side. Kept as a string so it runs in
// the page context with full access to window.__game.
const PAGE_INSTALL = `
(() => {
    const G = window.__game;
    if (!G || window.__strategicInstalled) return;
    window.__strategicInstalled = true;

    const PROP_COUNTS = {
        BROWN: 2, LIGHTBLUE: 3, PINK: 3, ORANGE: 3, RED: 3,
        YELLOW: 3, GREEN: 3, DARKBLUE: 2, UTILITY: 2, RAILROAD: 4,
    };

    function setSizeFor(color) { return PROP_COUNTS[color] || 3; }
    function isJSN(card) { return card && card.data && card.data.effect === 'just_say_no'; }

    function ownColors(state, pid) {
        const p = state.players[pid];
        const out = new Set();
        Object.keys(p.properties || {}).forEach(c => {
            if ((p.properties[c] || []).length > 0) out.add(c);
        });
        return out;
    }

    function isCompleting(state, pid, action) {
        if (action.type !== 'play') return false;
        if (action.zone !== 'board') return false;
        const color = action.options && action.options.color;
        if (!color) return false;
        const have = (state.players[pid].properties[color] || []).length;
        return have + 1 >= setSizeFor(color);
    }

    function isExtending(state, pid, action) {
        if (action.type !== 'play' || action.zone !== 'board') return false;
        const color = action.options && action.options.color;
        if (!color) return false;
        const have = (state.players[pid].properties[color] || []).length;
        return have > 0 && have + 1 < setSizeFor(color);
    }

    function isWildOnEmpty(state, pid, action) {
        if (action.type !== 'play' || action.zone !== 'board') return false;
        const color = action.options && action.options.color;
        const have = (state.players[pid].properties[color] || []).length;
        const card = state.players[pid].hand.find(c => c.data.id === action.cardId);
        return have === 0 && card && card.data.type === 'JOKER';
    }

    function isPropOnEmpty(state, pid, action) {
        if (action.type !== 'play' || action.zone !== 'board') return false;
        const color = action.options && action.options.color;
        if (!color) return false;
        const have = (state.players[pid].properties[color] || []).length;
        const card = state.players[pid].hand.find(c => c.data.id === action.cardId);
        return have === 0 && card && card.data.type === 'PROPERTY';
    }

    function cardOf(state, pid, cardId) {
        return state.players[pid].hand.find(c => c.data.id === cardId);
    }

    function isJSNAction(state, pid, action) {
        if (action.type !== 'play' || action.zone !== 'bank') return false;
        const c = cardOf(state, pid, action.cardId);
        return isJSN(c);
    }

    function effectOf(state, pid, action) {
        const c = cardOf(state, pid, action.cardId);
        return c && c.data && c.data.effect;
    }

    function typeOf(state, pid, action) {
        const c = cardOf(state, pid, action.cardId);
        return c && c.data && c.data.type;
    }

    function bankWeight(state, pid, action, base) {
        if (action.type !== 'play' || action.zone !== 'bank') return 0;
        if (isJSNAction(state, pid, action)) return 0;
        const c = cardOf(state, pid, action.cardId);
        if (c && c.data && c.data.type === 'MONEY') return base;
        return base * 0.6;
    }

    function bestBy(actions, fn) {
        let best = null, bestScore = 0;
        for (const a of actions) {
            const s = fn(a) || 0;
            if (s > bestScore) { best = a; bestScore = s; }
        }
        return best;
    }

    const STRATS = {
        AGGRESSIVE: (actions, state, pid) => {
            const owned = ownColors(state, pid);
            return bestBy(actions, a => {
                if (a.type === 'propose') {
                    const eff = effectOf(state, pid, a);
                    if (eff === 'deal_breaker') return 40;
                    if (eff === 'sly_deal') return 30;
                    if (eff === 'forced_deal') return 25;
                    if (eff === 'debt_collector') return 20;
                    if (eff === 'birthday') return 15;
                    if (typeOf(state, pid, a) === 'RENT') {
                        const c = cardOf(state, pid, a.cardId);
                        return c && c.data.isMulti ? 10 : 12;
                    }
                    return 5;
                }
                if (a.type === 'play') {
                    if (isJSNAction(state, pid, a)) return 25;
                    if (isCompleting(state, pid, a)) return 14;
                    if (isExtending(state, pid, a)) return 8;
                    if (typeOf(state, pid, a) === 'BUILDING') return 8;
                    if (isPropOnEmpty(state, pid, a)) return 6;
                    if (isWildOnEmpty(state, pid, a)) return 5;
                    if (a.zone === 'bank') return bankWeight(state, pid, a, 4);
                    return 2;
                }
                return 0;
            });
        },
        GREEDY: (actions, state, pid) => {
            const owned = ownColors(state, pid);
            return bestBy(actions, a => {
                if (a.type === 'propose') {
                    const eff = effectOf(state, pid, a);
                    if (typeOf(state, pid, a) === 'RENT') {
                        const c = cardOf(state, pid, a.cardId);
                        const col = a.options && a.options.color;
                        if (col && owned.has(col) && !c.data.isMulti) return 30;
                        return 6;
                    }
                    if (eff === 'debt_collector') return 18;
                    if (eff === 'birthday') return 15;
                    return 3;
                }
                if (a.type === 'play') {
                    if (isJSNAction(state, pid, a)) return 22;
                    if (isCompleting(state, pid, a)) return 25;
                    if (a.zone === 'bank') return bankWeight(state, pid, a, 20);
                    if (typeOf(state, pid, a) === 'BUILDING') return 5;
                    if (isExtending(state, pid, a)) return 8;
                    if (isPropOnEmpty(state, pid, a)) return 6;
                    return 1;
                }
                return 0;
            });
        },
        BUILDER: (actions, state, pid) => {
            return bestBy(actions, a => {
                if (a.type === 'play') {
                    if (isJSNAction(state, pid, a)) return 25;
                    if (typeOf(state, pid, a) === 'BUILDING') {
                        const eff = effectOf(state, pid, a);
                        return eff === 'house' ? 30 : 28;
                    }
                    if (isCompleting(state, pid, a)) return 40;
                    if (isExtending(state, pid, a)) return 20;
                    if (isWildOnEmpty(state, pid, a)) return 12;
                    if (isPropOnEmpty(state, pid, a)) return 10;
                    if (a.zone === 'bank') return bankWeight(state, pid, a, 8);
                    return 2;
                }
                if (a.type === 'propose') {
                    if (typeOf(state, pid, a) === 'RENT') return 6;
                    return 5;
                }
                return 0;
            });
        },
        DEFENSIVE: (actions, state, pid) => {
            return bestBy(actions, a => {
                if (a.type === 'play') {
                    if (isJSNAction(state, pid, a)) return 99;
                    if (isCompleting(state, pid, a)) return 22;
                    if (a.zone === 'bank') {
                        const c = cardOf(state, pid, a.cardId);
                        if (!c) return 0;
                        if (c.data.type === 'MONEY') return 15;
                        if (c.data.type === 'ACTION') return 12;
                        return 10;
                    }
                    if (typeOf(state, pid, a) === 'BUILDING') return 4;
                    if (isExtending(state, pid, a)) return 5;
                    if (isPropOnEmpty(state, pid, a)) return 3;
                    return 0;
                }
                if (a.type === 'propose') {
                    const c = cardOf(state, pid, a.cardId);
                    if (typeOf(state, pid, a) === 'RENT' && c && c.data.isMulti) return 6;
                    return 2;
                }
                return 0;
            });
        },
        BALANCED: (actions, state, pid) => {
            try { return G.pickBestAny(pid); } catch (_e) { return null; }
        },
    };

    window.__strategicPick = (name, pid) => {
        const fn = STRATS[name];
        const state = G.state();
        if (!fn) return null;
        const actions = G.enumerate(pid);
        const pick = fn(actions, state, pid);
        if (pick && pick.type === 'play' && pick.zone === 'board') {
            pick.options = { ...(pick.options || {}), _colorPicked: true };
        }
        return pick;
    };
    window.__strategicSet = (pid, name) => {
        const fn = STRATS[name];
        if (!fn) return;
        G.setBotStrategy(pid, (actions, state, p) => fn(actions, state, p));
    };

    // ---- Validators ----
    const TOTAL_CARDS = 106;
    window.__violations = [];
    let curMeta = { game: 0, turn: 0, label: '' };
    window.__setMeta = (m) => { curMeta = { ...curMeta, ...m }; };

    function snapshot() {
        const s = G.state();
        return {
            turn: s.turn,
            actionsLeft: s.actionsLeft,
            mustDiscard: s.mustDiscard,
            pending: !!s.pendingAction,
            hands: s.players.map(p => p.hand.length),
            banks: s.players.map(p => p.bank.length),
            sets: s.players.map(p => Object.keys(p.properties).reduce((n, c) => n + ((p.properties[c] || []).length >= setSizeFor(c) ? 1 : 0), 0)),
        };
    }

    function collectIds(state) {
        const ids = [];
        state.deck.forEach(c => ids.push(c.data.id));
        state.discard.forEach(c => ids.push(c.data.id));
        state.players.forEach(p => {
            p.hand.forEach(c => ids.push(c.data.id));
            p.bank.forEach(c => ids.push(c.data.id));
            Object.values(p.properties || {}).forEach(arr => arr.forEach(c => ids.push(c.data.id)));
            Object.values(p.buildings || {}).forEach(arr => arr.forEach(c => ids.push(c.data.id)));
        });
        if (state.pendingAction && state.pendingAction.card) ids.push(state.pendingAction.card.data.id);
        return ids;
    }

    const VALIDATORS = {
        'card-conservation': () => {
            const ids = collectIds(G.state());
            if (ids.length !== TOTAL_CARDS) return 'count=' + ids.length;
            const seen = new Set();
            for (const id of ids) { if (seen.has(id)) return 'dup id=' + id; seen.add(id); }
            return null;
        },
        'action-count-sanity': () => {
            const a = G.state().actionsLeft;
            if (!(a >= 0 && a <= 3)) return 'actionsLeft=' + a;
            return null;
        },
        'phantom-pending': () => {
            const s = G.state();
            if (s.pendingAction === null && (s.pendingReactors || []).length > 0) return 'reactors w/o pending';
            return null;
        },
        'turn-indicator-dom': () => {
            const lbl = document.querySelector('.turn-indicator-label');
            if (!lbl) return 'missing turn label';
            const s = G.state();
            const isYou = s.turn === s.localPlayerId;
            const cur = s.players[s.turn];
            const expected = isYou ? 'Your Turn' : ((cur && cur.name) || ('Lord ' + s.turn)) + "'s Turn";
            if (lbl.textContent.trim() !== expected) return 'got "' + lbl.textContent.trim() + '" expected "' + expected + '"';
            return null;
        },
        'opp-sets-badge': () => {
            const s = G.state();
            const badges = document.querySelectorAll('.opp-stat[data-field="opp-sets"]');
            const opps = s.players.filter(p => p.id !== s.localPlayerId);
            if (badges.length !== opps.length) return 'badge count mismatch ' + badges.length + ' vs ' + opps.length;
            for (let i = 0; i < opps.length; i++) {
                const sets = Object.keys(opps[i].properties).reduce((n, c) => n + ((opps[i].properties[c] || []).length >= setSizeFor(c) ? 1 : 0), 0);
                const m = badges[i].textContent.match(/(\\d+)\\s*\\/\\s*\\d+/);
                const txt = m ? m[1] : badges[i].textContent.trim();
                if (String(sets) !== txt) return 'opp ' + opps[i].id + ' sets=' + sets + ' dom=' + badges[i].textContent.trim();
            }
            return null;
        },
        'opp-hand-badge': () => {
            const s = G.state();
            const badges = document.querySelectorAll('.opp-stat[data-field="opp-hand"]');
            const opps = s.players.filter(p => p.id !== s.localPlayerId);
            if (badges.length !== opps.length) return 'badge count mismatch';
            for (let i = 0; i < opps.length; i++) {
                const m = badges[i].textContent.match(/(\\d+)/);
                const txt = m ? m[1] : '';
                if (String(opps[i].hand.length) !== txt) return 'opp ' + opps[i].id + ' hand=' + opps[i].hand.length + ' dom=' + badges[i].textContent.trim();
            }
            return null;
        },
        'hand-visible': () => {
            const s = G.state();
            const me = s.players[s.localPlayerId];
            if (me.hand.length === 0) return null;
            const cards = document.querySelectorAll('.your-hand .card');
            if (cards.length === 0) return 'hand cards exist but DOM empty (hand.length=' + me.hand.length + ')';
            return null;
        },
        'stale-modal': () => {
            const modal = document.getElementById('info-modal');
            if (!modal) return null;
            if (modal.classList.contains('hidden')) return null;
            const kind = modal.dataset.modalKind || '';
            const allowed = ['info', 'picker', 'reaction', 'payment', 'must-discard', 'confirm'];
            if (!allowed.includes(kind)) return 'modal open w/o kind (kind="' + kind + '")';
            return null;
        },
        'buildings-rendered': () => {
            const s = G.state();
            const me = s.players[s.localPlayerId];
            for (const color of Object.keys(me.buildings || {})) {
                const blds = me.buildings[color] || [];
                if (blds.length === 0) continue;
                if ((me.properties[color] || []).length < setSizeFor(color)) continue;
                const chips = document.querySelectorAll('.building-chip');
                if (chips.length === 0) return 'no building-chip rendered for ' + color;
            }
            return null;
        },
        'dom-no-dup-cardid': () => {
            const counts = new Map();
            document.querySelectorAll('.your-hand .card[data-card-id]').forEach(el => {
                const id = el.dataset.cardId;
                counts.set(id, (counts.get(id) || 0) + 1);
            });
            for (const [id, n] of counts.entries()) {
                if (n > 1) return 'cardId ' + id + ' rendered ' + n + ' times in hand';
            }
            return null;
        },
        'end-turn-reachable': () => {
            const s = G.state();
            if (s._gameOver) return null;
            const btn = document.querySelector('.btn-end-turn');
            if (!btn) return 'missing .btn-end-turn';
            const r = btn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return 'btn zero size';
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
            const top = document.elementFromPoint(cx, cy);
            if (!top) return null;
            const modal = document.getElementById('info-modal');
            if (modal && !modal.classList.contains('hidden') && modal.contains(top)) return null;
            if (!btn.contains(top) && !top.contains(btn)) return 'btn covered by ' + (top.tagName + '.' + (top.className || ''));
            return null;
        },
        'horizontal-overflow': () => {
            const sw = document.documentElement.scrollWidth;
            if (sw > window.innerWidth + 2) return 'scrollWidth=' + sw + ' innerWidth=' + window.innerWidth;
            return null;
        },
        'hand-fits-no-hscroll': () => {
            const hand = document.querySelector('.your-hand');
            if (!hand) return null;
            const diff = hand.scrollWidth - hand.clientWidth;
            if (diff > 2) return 'hand scrollWidth-clientWidth=' + diff;
            return null;
        },
        'end-turn-visible-at-point': () => {
            const s = G.state();
            if (s._gameOver) return null;
            const btn = document.querySelector('.btn-end-turn');
            if (!btn) return 'missing .btn-end-turn';
            const r = btn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return 'btn zero size';
            const cx = Math.round(r.left + r.width / 2);
            const cy = Math.round(r.top + r.height / 2);
            if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null;
            const top = document.elementFromPoint(cx, cy);
            if (!top) return null;
            const modal = document.getElementById('info-modal');
            if (modal && !modal.classList.contains('hidden')) return null;
            if (top !== btn && !btn.contains(top)) return 'covered by ' + top.tagName + '.' + (top.className || '');
            return null;
        },
    };

    window.__runValidators = () => {
        const fired = [];
        for (const name of Object.keys(VALIDATORS)) {
            try {
                const msg = VALIDATORS[name]();
                if (msg) fired.push({ name, msg, snap: snapshot(), meta: { ...curMeta } });
            } catch (e) {
                fired.push({ name, msg: 'THREW ' + e.message, snap: snapshot(), meta: { ...curMeta } });
            }
        }
        if (fired.length) window.__violations.push(...fired);
        return fired;
    };

    // ---- Dispatch wrapper ----
    const origDispatch = G.dispatch;
    G.dispatch = function wrapped(action) {
        const r = origDispatch.apply(this, arguments);
        try { window.__runValidators(); } catch (_e) {}
        return r;
    };
})();
`;

async function bootGame(page) {
    await page.goto(`${URL}?bust=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-solo-game', { state: 'attached' });
    await page.evaluate(() => document.getElementById('btn-solo-game').click());
    await page.waitForSelector('#game-container:not(.hidden)');
    await page.waitForFunction(() => !!window.__game);
    await page.evaluate((src) => {
        const tag = document.createElement('script');
        tag.textContent = src;
        document.head.appendChild(tag);
    }, PAGE_INSTALL);
    const installedType = await page.evaluate(() => typeof window.__strategicSet);
    if (installedType !== 'function') throw new Error('install failed: __strategicSet=' + installedType);
}

async function setStrategies(page, names) {
    await page.evaluate((arr) => {
        window.__game.clearBotStrategies();
        arr.forEach((n, i) => window.__strategicSet(i, n));
    }, names);
}

async function getState(page) {
    return page.evaluate(() => {
        const s = window.__game.state();
        return {
            turn: s.turn,
            actionsLeft: s.actionsLeft,
            gameOver: !!s._gameOver,
            winner: window.__game.checkWinner(),
            localId: s.localPlayerId,
            mustDiscard: s.mustDiscard,
            reactionTargetId: s.reactionTargetId,
            pending: s.pendingAction !== null,
            handLocal: s.players[s.localPlayerId].hand.length,
            hasJSN: s.players[s.localPlayerId].hand.some(c => c.data.effect === 'just_say_no'),
            pendingEffect: s.pendingAction && s.pendingAction.card && s.pendingAction.card.data.effect,
        };
    });
}

async function playGame(page, gameIdx, names) {
    const label = names.join(' x ');
    await bootGame(page);
    await setStrategies(page, names);
    await page.evaluate((m) => window.__setMeta(m), { game: gameIdx, label, turn: 0 });

    let actionTicks = 0;
    let turns = 0;
    let stallCount = 0;
    let winner = null;
    let lastSig = '';
    let lastTurnId = -1;
    const MAX_TICKS = 1500;

    while (turns < MAX_TURNS && actionTicks < MAX_TICKS) {
        actionTicks++;
        await page.evaluate((t) => window.__setMeta({ turn: t }), turns);
        const st = await getState(page);

        if (st.gameOver || st.winner !== null) { winner = st.winner; break; }

        if (st.reactionTargetId !== null) {
            if (st.reactionTargetId === st.localId) {
                const bigThreat = st.pendingEffect && ['deal_breaker', 'sly_deal', 'forced_deal'].includes(st.pendingEffect);
                await page.evaluate((useNo) => {
                    const s = window.__game.state();
                    if (useNo) {
                        const c = s.players[s.localPlayerId].hand.find(x => x.data.effect === 'just_say_no');
                        if (c) { window.__game.dispatch({ type: 'react-no', cardId: c.data.id }); return; }
                    }
                    window.__game.dispatch({ type: 'concede' });
                }, st.hasJSN && bigThreat);
            } else {
                await page.evaluate(() => window.__game.botReact());
            }
            await page.waitForTimeout(20);
            turns++;
            continue;
        }

        if (st.mustDiscard > 0) {
            await page.evaluate(() => {
                const s = window.__game.state();
                const turnP = s.players[s.turn];
                if (turnP.hand.length === 0) { s.mustDiscard = 0; return; }
                const card = turnP.hand[turnP.hand.length - 1];
                const origLocal = s.localPlayerId;
                s.localPlayerId = s.turn;
                window.__game.dispatch({ type: 'discard', cardId: card.data.id });
                s.localPlayerId = origLocal;
            });
            await page.waitForTimeout(10);
            turns++;
            continue;
        }

        if (st.turn === st.localId) {
            const acted = await page.evaluate((name) => {
                const s = window.__game.state();
                if (s.actionsLeft <= 0) return false;
                const pick = window.__strategicPick(name, s.localPlayerId);
                if (pick) { window.__game.dispatch(pick); return true; }
                return false;
            }, names[st.localId]);
            if (!acted) {
                await page.evaluate(() => window.__game.endTurn());
            }
        } else {
            await page.evaluate(() => window.__game.playBotTurn());
            await page.waitForTimeout(40);
        }

        const sig = await page.evaluate(() => {
            const s = window.__game.state();
            const counts = s.players.map(p =>
                p.hand.length + ':' + p.bank.length + ':' +
                Object.values(p.properties || {}).reduce((n, a) => n + a.length, 0)
            ).join('|');
            return s.turn + '#' + s.actionsLeft + '#' + counts + '#' + s.deck.length;
        });
        if (sig === lastSig) { stallCount++; if (stallCount > 60) break; }
        else { stallCount = 0; lastSig = sig; }

        if (st.turn !== lastTurnId) { turns++; lastTurnId = st.turn; }
    }

    const violations = await page.evaluate(() => window.__violations.slice());
    const cardCount = await page.evaluate(() => {
        const s = window.__game.state();
        let n = s.deck.length + s.discard.length;
        s.players.forEach(p => {
            n += p.hand.length + p.bank.length;
            Object.values(p.properties || {}).forEach(a => n += a.length);
            Object.values(p.buildings || {}).forEach(a => n += a.length);
        });
        if (s.pendingAction && s.pendingAction.card) n++;
        return n;
    });
    const winnerSets = winner !== null ? await page.evaluate((w) => {
        const s = window.__game.state();
        const p = s.players[w];
        const COUNTS = { BROWN: 2, LIGHTBLUE: 3, PINK: 3, ORANGE: 3, RED: 3, YELLOW: 3, GREEN: 3, DARKBLUE: 2, UTILITY: 2, RAILROAD: 4 };
        return Object.keys(p.properties).filter(c => (p.properties[c] || []).length >= (COUNTS[c] || 3)).length;
    }, winner) : 0;

    // Save screenshots for unique violations
    const seenShots = new Set();
    for (const v of violations) {
        const key = `${v.meta.game}-${v.meta.turn}-${v.name}`;
        if (seenShots.has(key)) continue;
        seenShots.add(key);
        const shot = path.join(OUT_DIR, `violation-${key}.png`);
        try { await page.screenshot({ path: shot, fullPage: false }); v.screenshot = shot; } catch (_e) {}
    }

    return { gameIdx, label, names, turns, winner, winnerSets, cardCount, violations, stalled: turns >= MAX_TURNS || winner === null };
}

(async () => {
    const matchups = combos3(STRATEGIES);
    const browser = await chromium.launch({ headless: true });

    const results = [];
    let gameIdx = 0;
    console.log('=== Strategic Game Suite ===');

    for (const mu of matchups) {
        for (let g = 0; g < GAMES_PER_MATCHUP; g++) {
            gameIdx++;
            const dev = DEVICES[(gameIdx - 1) % DEVICES.length];
            const ctx = await browser.newContext({
                viewport: dev.viewport,
                deviceScaleFactor: dev.deviceScaleFactor,
                isMobile: true,
                hasTouch: true,
            });
            const page = await ctx.newPage();
            let r;
            try {
                r = await playGame(page, gameIdx, mu);
                r.device = dev.name;
            } catch (e) {
                r = { gameIdx, label: mu.join(' x '), names: mu, turns: 0, winner: null, winnerSets: 0, cardCount: 0, violations: [], stalled: true, error: e.message, device: dev.name };
            }
            await ctx.close();
            const winnerName = r.winner !== null ? r.names[r.winner] : null;
            const status = winnerName ? `winner=${winnerName}` : 'stall';
            const vcount = (r.violations || []).length;
            const vlabel = vcount === 0 ? 'no violations' : `${vcount} violation${vcount > 1 ? 's' : ''}`;
            console.log(`matchup ${r.label.padEnd(40)} game ${g + 1} [${(r.device || dev.name).padEnd(10)}]: turns=${String(r.turns).padEnd(3)} ${status.padEnd(20)} ${vlabel}`);
            if (vcount > 0) {
                const uniq = new Map();
                for (const v of r.violations) {
                    const k = `${v.meta.turn}-${v.name}`;
                    if (!uniq.has(k)) uniq.set(k, v);
                }
                for (const v of uniq.values()) {
                    console.log(`   - turn ${v.meta.turn}: ${v.name} — ${v.msg}`);
                    if (v.screenshot) console.log(`   screenshot: ${v.screenshot}`);
                }
            }
            if (r.error) console.log('   ERROR: ' + r.error);
            results.push(r);
        }
    }

    await browser.close();

    const winsByStrat = Object.fromEntries(STRATEGIES.map(s => [s, 0]));
    let totalWins = 0, stalls = 0, totalViolations = 0, cardFails = 0;
    const violatingGames = new Set();
    for (const r of results) {
        if (r.winner !== null) {
            totalWins++;
            winsByStrat[r.names[r.winner]]++;
        } else stalls++;
        if (r.violations && r.violations.length) {
            totalViolations += r.violations.length;
            violatingGames.add(r.gameIdx);
            for (const v of r.violations) if (v.name === 'card-conservation') cardFails++;
        }
        if (r.cardCount && r.cardCount !== 106) cardFails++;
    }

    console.log(`\n=== Per-strategy win rate (${results.length} games) ===`);
    for (const s of STRATEGIES) {
        const w = winsByStrat[s];
        console.log(`  ${s.padEnd(11)} ${w}/${results.length} (${Math.round((w / results.length) * 100)}%)`);
    }

    console.log('=== Summary ===');
    console.log(`  total games:    ${results.length}`);
    console.log(`  wins:           ${totalWins}`);
    console.log(`  stalls:         ${stalls}`);
    console.log(`  violations:     ${totalViolations} (across ${violatingGames.size} games)`);
    console.log(`  card-conservation failures: ${cardFails}`);

    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));

    process.exit((totalViolations === 0 && cardFails === 0) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
