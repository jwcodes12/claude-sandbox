// Auto-play harness. Boots the game in a real browser via CDP,
// drives random valid moves for the local player, lets bots take their turns,
// runs until someone wins or maxTurns hit. Captures console errors, layout
// problems (overlapping fixed hand vs page content), and final screenshots.
//
// Usage: node ui-test/auto-play.js [games=10] [maxTurnsPerGame=200] [playerCount=3]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const GAMES = Number(process.argv[2]) || 10;
const MAX_TURNS = Number(process.argv[3]) || 200;
const PLAYER_COUNT = Number(process.argv[4]) || 3;
const URL = 'http://localhost:8000/';
const OUT_DIR = '/tmp/auto-play';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function bootGame(page, context) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await page.goto(`${URL}?bust=${Date.now()}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#btn-solo-game', { state: 'attached' });
    await page.evaluate(() => document.getElementById('btn-solo-game').click());
    await page.waitForSelector('#game-container:not(.hidden)');
    await page.waitForFunction(() => !!window.__game);
}

async function detectLayoutIssues(page) {
    return page.evaluate(() => {
        const issues = [];
        const hand = document.querySelector('.your-hand');
        const handBox = hand && hand.getBoundingClientRect();
        // The scroll container holds everything except the hand; it must
        // never extend into the hand's space. Inner sections (kingdom/bank)
        // can have unclipped layout boxes that exceed the scroll viewport
        // without being a real visual bug.
        const scroll = document.querySelector('.game-scroll');
        const scrollBox = scroll && scroll.getBoundingClientRect();
        if (handBox && scrollBox && scrollBox.bottom > handBox.top + 2) {
            issues.push(`scroll overlaps hand by ${Math.round(scrollBox.bottom - handBox.top)}px`);
        }
        // Card art that failed to load (broken src or 404)
        const cards = document.querySelectorAll('.card');
        const broken = Array.from(cards)
            .map((c) => c.querySelector('img.card-art'))
            .filter((img) => img && img.complete && img.naturalWidth === 0)
            .map((img) => img.getAttribute('src'));
        if (broken.length > 0) issues.push(`broken art: ${[...new Set(broken)].join(', ')}`);
        return issues;
    });
}

async function playOne(page, context, gameIdx) {
    const errors = [];
    const issues = new Set();
    const onConsole = (m) => {
        if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
            errors.push('console: ' + m.text());
        }
    };
    const onPageError = (e) => errors.push('pageerror: ' + e.message);
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    await bootGame(page, context);

    let turns = 0;
    let winner = null;
    let stalled = 0;
    while (turns < MAX_TURNS) {
        const status = await page.evaluate(() => {
            const s = window.__game.state();
            return {
                turn: s.turn,
                actionsLeft: s.actionsLeft,
                gameOver: !!s._gameOver,
                winner: window.__game.checkWinner(),
                localId: s.localPlayerId,
                handCount: s.players[s.localPlayerId].hand.length,
                reactionTargetId: s.reactionTargetId,
                hasNotToday: s.players[s.localPlayerId].hand.some(c => c.data.effect === 'just_say_no'),
                pendingEffect: s.pendingAction && s.pendingAction.card && s.pendingAction.card.data.effect,
            };
        });
        if (status.gameOver || status.winner !== null) {
            winner = status.winner;
            break;
        }

        // Reaction phase
        if (status.reactionTargetId !== null) {
            if (status.reactionTargetId === status.localId) {
                // Defend big threats with NOT TODAY when available
                const bigThreat = status.pendingEffect && ['deal_breaker', 'sly_deal', 'forced_deal'].includes(status.pendingEffect);
                await page.evaluate((useNo) => {
                    const s = window.__game.state();
                    if (useNo) {
                        const local = s.players[s.localPlayerId];
                        const card = local.hand.find(c => c.data.effect === 'just_say_no');
                        if (card) {
                            window.__game.dispatch({ type: 'react-no', cardId: card.data.id });
                            return;
                        }
                    }
                    window.__game.dispatch({ type: 'concede' });
                }, status.hasNotToday && bigThreat);
            } else {
                await page.evaluate(() => window.__game.botReact());
            }
            await page.waitForTimeout(20);
            turns++;
            continue;
        }

        // Layout check every 10 turns
        if (turns % 10 === 0) {
            const layoutIssues = await detectLayoutIssues(page);
            for (const i of layoutIssues) {
                if (!issues.has(i)) {
                    issues.add(i);
                    await page.screenshot({ path: path.join(OUT_DIR, `g${gameIdx}-t${turns}.png`), fullPage: false });
                }
            }
        }

        if (status.turn === status.localId) {
            // Local player: use the smart-pick (now includes propose actions).
            const acted = await page.evaluate(() => {
                if (window.__game.state().actionsLeft <= 0) return false;
                const pick = window.__game.pickBestAny(window.__game.state().localPlayerId);
                if (pick) {
                    window.__game.dispatch(pick);
                    return true;
                }
                return false;
            });
            if (!acted) {
                await page.evaluate(() => window.__game.endTurn());
                stalled = 0;
            }
        } else {
            // Drive bot turn synchronously
            await page.evaluate(() => window.__game.playBotTurn());
            await page.waitForTimeout(50);
        }

        // Detect stall (bots can be stuck on must-discard etc.)
        if (status.actionsLeft === 3 && status.handCount > 7) {
            stalled++;
            if (stalled > 5) {
                issues.add(`game ${gameIdx} stalled at turn ${turns} (hand=${status.handCount})`);
                break;
            }
        }
        turns++;
    }

    // Final layout check + screenshot
    const finalIssues = await detectLayoutIssues(page);
    finalIssues.forEach((i) => issues.add(i));
    const shot = path.join(OUT_DIR, `game-${gameIdx}.png`);
    await page.screenshot({ path: shot, fullPage: true });

    page.off('console', onConsole);
    page.off('pageerror', onPageError);

    return {
        gameIdx,
        turns,
        winner,
        errors,
        issues: Array.from(issues),
        shot,
    };
}

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const ctx = browser.contexts()[0];
    const results = [];
    for (let g = 0; g < GAMES; g++) {
        const page = await ctx.newPage();
        await page.setViewportSize({ width: 454, height: 800 });
        let r;
        try {
            r = await playOne(page, ctx, g);
        } catch (e) {
            r = { gameIdx: g, turns: 0, winner: null, errors: ['THREW: ' + e.message], issues: [], shot: null };
        }
        await page.close();
        const status = r.winner !== null ? `won-by-${r.winner}` : r.errors.length ? 'errored' : r.issues.length ? 'issues' : 'no-winner';
        console.log(`game ${g}: turns=${r.turns} ${status} errs=${r.errors.length} issues=${r.issues.length}`);
        if (r.errors.length) console.log('   errors:', r.errors.slice(0, 3));
        if (r.issues.length) console.log('   issues:', r.issues.slice(0, 3));
        results.push(r);
    }
    await browser.close();

    const summary = {
        total: results.length,
        wins: results.filter((r) => r.winner !== null).length,
        errored: results.filter((r) => r.errors.length).length,
        layout_issues: results.filter((r) => r.issues.length).length,
        avg_turns: Math.round(results.reduce((s, r) => s + r.turns, 0) / results.length),
    };
    console.log('\n--- summary ---');
    console.log(JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2));
})();
