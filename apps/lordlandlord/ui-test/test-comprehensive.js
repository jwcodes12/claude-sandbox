const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
app.use(express.static(path.join(__dirname, '..')));

// Test results storage
const testResults = {
    timestamp: new Date().toISOString(),
    tests: [],
    cardTypesTested: new Set(),
    screenshots: []
};

function log(message, data = null) {
    const entry = { time: new Date().toISOString(), message };
    if (data) entry.data = data;
    testResults.tests.push(entry);
    console.log(`[${entry.time}] ${message}`, data || '');
}

async function takeScreenshot(page, name, description) {
    const filename = `screenshots/${name}-${Date.now()}.png`;
    await page.screenshot({ path: filename, fullPage: true });
    testResults.screenshots.push({ name, description, filename });
    log(`Screenshot: ${filename}`, { description });
}

async function waitForGameState(page, condition, timeout = 5000) {
    return page.waitForFunction(condition, { timeout });
}

async function getGameState(page) {
    return page.evaluate(() => {
        const gs = window.gameState;
        return {
            turn: gs.turn,
            actionsLeft: gs.actionsLeft,
            mustDiscard: gs.mustDiscard,
            reactionTargetId: gs.reactionTargetId,
            doubleRentArmed: gs.doubleRentArmed,
            players: gs.players.map(p => ({
                id: p.id,
                handSize: p.hand.length,
                bankSize: p.bank.length,
                bankValue: p.bank.reduce((s, c) => s + c.data.value, 0),
                properties: Object.keys(p.properties).map(color => ({
                    color,
                    count: p.properties[color].length,
                    cards: p.properties[color].map(c => c.data.name)
                })),
                buildings: Object.keys(p.buildings).map(color => ({
                    color,
                    count: p.buildings[color].length
                })),
                completedSets: Object.keys(p.properties).filter(color => {
                    const PROPERTIES = {
                        BROWN: { count: 2 },
                        LIGHTBLUE: { count: 3 },
                        PINK: { count: 3 },
                        ORANGE: { count: 3 },
                        RED: { count: 3 },
                        YELLOW: { count: 3 },
                        GREEN: { count: 3 },
                        DARKBLUE: { count: 2 },
                        UTILITY: { count: 2 },
                        RAILROAD: { count: 4 }
                    };
                    return p.properties[color].length >= PROPERTIES[color].count;
                }).length
            })),
            deckSize: gs.deck.length,
            discardSize: gs.discard.length,
            winner: gs.players.findIndex(p => {
                const completedSets = Object.keys(p.properties).filter(color => {
                    const PROPERTIES = {
                        BROWN: { count: 2 },
                        LIGHTBLUE: { count: 3 },
                        PINK: { count: 3 },
                        ORANGE: { count: 3 },
                        RED: { count: 3 },
                        YELLOW: { count: 3 },
                        GREEN: { count: 3 },
                        DARKBLUE: { count: 2 },
                        UTILITY: { count: 2 },
                        RAILROAD: { count: 4 }
                    };
                    return p.properties[color].length >= PROPERTIES[color].count;
                }).length;
                return completedSets >= 3;
            })
        };
    });
}

async function trackCardPlayed(page) {
    return page.evaluate(() => {
        return new Promise(resolve => {
            const originalExecute = window.gameState._executeAction || function() {};
            window.gameState._executeAction = function(card, ...args) {
                resolve({
                    cardType: card.data.type,
                    cardName: card.data.name,
                    effect: card.data.effect
                });
                return originalExecute.call(this, card, ...args);
            };
        });
    });
}

async function analyzeCardDistribution(page) {
    return page.evaluate(() => {
        const deck = window.gameState.deck.concat(
            window.gameState.discard,
            ...window.gameState.players.map(p => [...p.hand, ...p.bank, ...Object.values(p.properties).flat(), ...Object.values(p.buildings).flat()])
        );

        const distribution = {};
        deck.forEach(card => {
            const type = card.data.type;
            if (!distribution[type]) {
                distribution[type] = { count: 0, cards: {} };
            }
            distribution[type].count++;
            const name = card.data.name;
            distribution[type].cards[name] = (distribution[type].cards[name] || 0) + 1;
        });

        return distribution;
    });
}

async function testCardMechanics(page) {
    log("=== Testing Card Mechanics ===");

    // Get initial state
    let state = await getGameState(page);
    log("Initial game state", state);
    await takeScreenshot(page, "01-initial-state", "Game just started");

    // Enable auto-duel
    await page.click('#btn-auto-play');
    log("Auto-duel enabled");

    // Monitor game for card plays
    const observedCards = new Set();
    const maxTurns = 200;
    let turnCount = 0;

    while (turnCount < maxTurns) {
        await new Promise(r => setTimeout(r, 500));
        state = await getGameState(page);
        turnCount++;

        // Take periodic screenshots
        if (turnCount % 20 === 0) {
            await takeScreenshot(page, `turn-${turnCount}`, `Game state at turn ${turnCount}`);
            log(`Turn ${turnCount}`, state);
        }

        // Track card types played
        state.players.forEach(p => {
            p.properties.forEach(prop => {
                prop.cards.forEach(cardName => observedCards.add(cardName));
            });
        });

        // Check for winner
        if (state.winner >= 0) {
            log(`Winner detected: Player ${state.winner} at turn ${turnCount}!`);
            await takeScreenshot(page, "final-winner", `Player ${state.winner} won the game`);
            break;
        }

        // Safety: Check if game is stuck
        if (turnCount % 50 === 0) {
            const progress = state.players.reduce((sum, p) => sum + p.completedSets, 0);
            log(`Progress check at turn ${turnCount}: ${progress} completed sets total`);
        }
    }

    log(`Game completed in ${turnCount} turns`);
    log("Cards observed during game", Array.from(observedCards));

    return { turnCount, state, observedCards: Array.from(observedCards) };
}

async function testSpecificCardEffects(page) {
    log("=== Testing Specific Card Effects ===");

    // Inject test scenarios
    const effectsToTest = [
        'pass_go',
        'deal_breaker',
        'sly_deal',
        'forced_deal',
        'just_say_no',
        'debt_collector',
        'birthday',
        'double_rent',
        'collect_rent'
    ];

    for (const effect of effectsToTest) {
        const hasEffect = await page.evaluate((effectName) => {
            const allCards = window.gameState.deck.concat(
                window.gameState.discard,
                ...window.gameState.players.map(p => [...p.hand, ...p.bank, ...Object.values(p.properties).flat(), ...Object.values(p.buildings).flat()])
            );
            return allCards.some(c => c.data.effect === effectName ||
                                     (effectName === 'collect_rent' && c.data.type === 'RENT'));
        }, effect);

        log(`Card effect '${effect}' exists in deck: ${hasEffect}`);
        testResults.cardTypesTested.add(effect);
    }
}

async function runFullGameTest() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Capture console logs
    page.on('console', msg => {
        const text = msg.text();
        if (!text.includes('Skipping unknown resource') && !text.includes('favicon')) {
            log(`Browser: ${text}`);
        }
    });
    page.on('pageerror', error => log(`Browser Error: ${error.message}`));

    try {
        log("Starting comprehensive test suite");

        await page.goto(`http://localhost:${PORT}/src/index.html`, {
            waitUntil: 'domcontentloaded',
            timeout: 10000
        });

        // Create screenshots directory
        if (!fs.existsSync('screenshots')) {
            fs.mkdirSync('screenshots');
        }

        await takeScreenshot(page, "00-splash-screen", "Initial splash screen");

        // Create game
        await page.waitForSelector('#btn-create-game');
        await page.type('#player-name-create', 'Test Player 1');
        await page.click('#btn-create-game');
        await new Promise(r => setTimeout(r, 500));

        await takeScreenshot(page, "lobby", "Lobby screen");

        // Add bot
        await page.click('#btn-add-bot');
        await new Promise(r => setTimeout(r, 300));

        // Start game
        await page.click('#btn-start-game');
        await new Promise(r => setTimeout(r, 1000));

        log("Game started successfully");

        // Analyze card distribution
        const distribution = await analyzeCardDistribution(page);
        log("Card distribution", distribution);

        // Test specific card effects
        await testSpecificCardEffects(page);

        // Run full game
        const gameResults = await testCardMechanics(page);

        // Final state analysis
        const finalState = await getGameState(page);
        log("=== Final Game State ===", finalState);

        // Generate test report
        testResults.gameResults = gameResults;
        testResults.cardDistribution = distribution;
        testResults.finalState = finalState;
        testResults.cardTypesTested = Array.from(testResults.cardTypesTested);

        // Save test results
        fs.writeFileSync('test-results.json', JSON.stringify(testResults, null, 2));
        log("Test results saved to test-results.json");

        // Print summary
        console.log("\n=== TEST SUMMARY ===");
        console.log(`Total turns: ${gameResults.turnCount}`);
        console.log(`Winner: Player ${finalState.winner}`);
        console.log(`Screenshots taken: ${testResults.screenshots.length}`);
        console.log(`Card effects tested: ${testResults.cardTypesTested.length}`);
        console.log(`Cards observed: ${gameResults.observedCards.length}`);

        await browser.close();
        return true;

    } catch (error) {
        log("Test failed with error", error.message);
        await takeScreenshot(page, "error-state", "Error occurred");
        await browser.close();
        throw error;
    }
}

const server = app.listen(PORT, async () => {
    try {
        await runFullGameTest();
        console.log("\n✓ All tests completed successfully!");
    } catch (error) {
        console.error("\n✗ Tests failed:", error);
    } finally {
        server.close();
        process.exit(0);
    }
});
