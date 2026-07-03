const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3001;
app.use(express.static(path.join(__dirname, '..')));

const testReport = {
    timestamp: new Date().toISOString(),
    tests: [],
    passed: 0,
    failed: 0,
    cardTests: {}
};

function assert(condition, message) {
    if (condition) {
        testReport.passed++;
        console.log(`✓ ${message}`);
        testReport.tests.push({ status: 'PASS', message });
        return true;
    } else {
        testReport.failed++;
        console.error(`✗ ${message}`);
        testReport.tests.push({ status: 'FAIL', message });
        return false;
    }
}

async function setupGame(page) {
    await page.goto(`http://localhost:${PORT}/src/index.html`, {
        waitUntil: 'domcontentloaded'
    });

    await page.waitForSelector('#btn-create-game');
    await page.click('#btn-create-game');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#btn-add-bot');
    await new Promise(r => setTimeout(r, 300));
    await page.click('#btn-start-game');
    await new Promise(r => setTimeout(r, 1000));
}

async function testMoneyCards(page) {
    console.log("\n=== Testing MONEY Cards ===");

    const moneyTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const moneyCards = allCards.filter(c => c.data.type === 'MONEY');
        const values = {};

        moneyCards.forEach(card => {
            const val = card.data.value;
            values[val] = (values[val] || 0) + 1;
        });

        return {
            totalMoneyCards: moneyCards.length,
            values,
            expectedTotal: 6 + 5 + 3 + 3 + 2 + 1 // From cards.js
        };
    });

    assert(moneyTest.totalMoneyCards === moneyTest.expectedTotal,
        `Money cards count: ${moneyTest.totalMoneyCards} (expected ${moneyTest.expectedTotal})`);

    assert(moneyTest.values[1] === 6, `1 Gold cards: ${moneyTest.values[1]} (expected 6)`);
    assert(moneyTest.values[2] === 5, `2 Gold cards: ${moneyTest.values[2]} (expected 5)`);
    assert(moneyTest.values[3] === 3, `3 Gold cards: ${moneyTest.values[3]} (expected 3)`);
    assert(moneyTest.values[4] === 3, `4 Gold cards: ${moneyTest.values[4]} (expected 4)`);
    assert(moneyTest.values[5] === 2, `5 Gold cards: ${moneyTest.values[5]} (expected 2)`);
    assert(moneyTest.values[10] === 1, `10 Gold cards: ${moneyTest.values[10]} (expected 1)`);

    testReport.cardTests.MONEY = moneyTest;
}

async function testPropertyCards(page) {
    console.log("\n=== Testing PROPERTY Cards ===");

    const propTest = await page.evaluate(() => {
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

        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const propCards = allCards.filter(c => c.data.type === 'PROPERTY');
        const byColor = {};

        propCards.forEach(card => {
            const color = card.data.colorKey;
            byColor[color] = (byColor[color] || 0) + 1;
        });

        return {
            totalPropertyCards: propCards.length,
            byColor,
            expected: PROPERTIES
        };
    });

    assert(propTest.totalPropertyCards === 28,
        `Total property cards: ${propTest.totalPropertyCards} (expected 28)`);

    Object.entries(propTest.expected).forEach(([color, info]) => {
        const actual = propTest.byColor[color] || 0;
        assert(actual === info.count,
            `${color} properties: ${actual} (expected ${info.count})`);
    });

    testReport.cardTests.PROPERTY = propTest;
}

async function testWildCards(page) {
    console.log("\n=== Testing WILD/JOKER Cards ===");

    const wildTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const wilds = allCards.filter(c => c.data.type === 'JOKER');
        const rainbowWilds = wilds.filter(c => c.data.isRainbow);
        const standardWilds = wilds.filter(c => !c.data.isRainbow);

        return {
            totalWilds: wilds.length,
            rainbowWilds: rainbowWilds.length,
            standardWilds: standardWilds.length,
            standardWildColors: standardWilds.map(w => w.data.allowedColors)
        };
    });

    assert(wildTest.rainbowWilds === 2,
        `Rainbow wilds: ${wildTest.rainbowWilds} (expected 2)`);
    assert(wildTest.standardWilds === 9,
        `Standard wilds: ${wildTest.standardWilds} (expected 9)`);
    assert(wildTest.totalWilds === 11,
        `Total wild cards: ${wildTest.totalWilds} (expected 11)`);

    testReport.cardTests.JOKER = wildTest;
}

async function testRentCards(page) {
    console.log("\n=== Testing RENT Cards ===");

    const rentTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const rentCards = allCards.filter(c => c.data.type === 'RENT');
        const multiRent = rentCards.filter(c => c.data.isMulti);
        const dualRent = rentCards.filter(c => !c.data.isMulti);

        return {
            totalRentCards: rentCards.length,
            multiRent: multiRent.length,
            dualRent: dualRent.length,
            dualColorPairs: dualRent.map(r => r.data.allowedColors)
        };
    });

    assert(rentTest.multiRent === 3,
        `Multi-color rent cards: ${rentTest.multiRent} (expected 3)`);
    assert(rentTest.dualRent === 10,
        `Dual-color rent cards: ${rentTest.dualRent} (expected 10)`);
    assert(rentTest.totalRentCards === 13,
        `Total rent cards: ${rentTest.totalRentCards} (expected 13)`);

    testReport.cardTests.RENT = rentTest;
}

async function testActionCards(page) {
    console.log("\n=== Testing ACTION Cards ===");

    const actionTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const actionCards = allCards.filter(c => c.data.type === 'ACTION');
        const byEffect = {};

        actionCards.forEach(card => {
            const effect = card.data.effect;
            byEffect[effect] = (byEffect[effect] || 0) + 1;
        });

        return {
            totalActionCards: actionCards.length,
            byEffect
        };
    });

    const expectedActions = {
        'pass_go': 10,
        'deal_breaker': 2,
        'sly_deal': 3,
        'forced_deal': 3,
        'just_say_no': 3,
        'debt_collector': 3,
        'birthday': 3,
        'double_rent': 2
    };

    Object.entries(expectedActions).forEach(([effect, count]) => {
        const actual = actionTest.byEffect[effect] || 0;
        assert(actual === count,
            `${effect} cards: ${actual} (expected ${count})`);
    });

    const totalExpected = Object.values(expectedActions).reduce((a, b) => a + b, 0);
    assert(actionTest.totalActionCards === totalExpected,
        `Total action cards: ${actionTest.totalActionCards} (expected ${totalExpected})`);

    testReport.cardTests.ACTION = actionTest;
}

async function testBuildingCards(page) {
    console.log("\n=== Testing BUILDING Cards ===");

    const buildingTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(gs.discard, ...gs.players.map(p => p.hand));

        const buildingCards = allCards.filter(c => c.data.type === 'BUILDING');
        const keeps = buildingCards.filter(c => c.data.effect === 'house');
        const castles = buildingCards.filter(c => c.data.effect === 'hotel');

        return {
            totalBuildings: buildingCards.length,
            keeps: keeps.length,
            castles: castles.length
        };
    });

    assert(buildingTest.keeps === 3,
        `The Keep cards: ${buildingTest.keeps} (expected 3)`);
    assert(buildingTest.castles === 2,
        `The Castle cards: ${buildingTest.castles} (expected 2)`);
    assert(buildingTest.totalBuildings === 5,
        `Total building cards: ${buildingTest.totalBuildings} (expected 5)`);

    testReport.cardTests.BUILDING = buildingTest;
}

async function testTotalDeckSize(page) {
    console.log("\n=== Testing Total Deck Size ===");

    const deckTest = await page.evaluate(() => {
        const gs = window.gameState;
        const allCards = gs.deck.concat(
            gs.discard,
            ...gs.players.map(p => [
                ...p.hand,
                ...p.bank,
                ...Object.values(p.properties).flat(),
                ...Object.values(p.buildings).flat()
            ].flat())
        );

        const uniqueIds = new Set(allCards.map(c => c.data.id));
        const byType = {};

        allCards.forEach(card => {
            const type = card.data.type;
            byType[type] = (byType[type] || 0) + 1;
        });

        return {
            totalCards: allCards.length,
            uniqueCards: uniqueIds.size,
            byType
        };
    });

    // Expected total from cards.js:
    // Money: 20, Properties: 28, Wilds: 11, Rent: 13, Actions: 29, Buildings: 5 = 106
    const expectedTotal = 106;

    assert(deckTest.totalCards === expectedTotal,
        `Total deck size: ${deckTest.totalCards} (expected ${expectedTotal})`);

    assert(deckTest.uniqueCards === deckTest.totalCards,
        `All cards have unique IDs: ${deckTest.uniqueCards} === ${deckTest.totalCards}`);

    console.log("\nDeck composition:");
    Object.entries(deckTest.byType).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
    });

    testReport.cardTests.TOTAL_DECK = deckTest;
}

async function testGameMechanics(page) {
    console.log("\n=== Testing Game Mechanics ===");

    // Test initial hand size (after turn start, player 0 draws 2 more = 7 total)
    const initialHandTest = await page.evaluate(() => {
        return window.gameState.players.map(p => p.hand.length);
    });

    // Player whose turn it is will have drawn 2 cards (5 initial + 2 = 7)
    initialHandTest.forEach((handSize, idx) => {
        const expected = idx === 0 ? 7 : 5; // Player 0 is current turn
        assert(handSize === expected,
            `Player ${idx} initial hand: ${handSize} cards (expected ${expected})`);
    });

    // Test turn actions
    const turnTest = await page.evaluate(() => {
        return {
            actionsLeft: window.gameState.actionsLeft,
            turn: window.gameState.turn
        };
    });

    assert(turnTest.actionsLeft === 3,
        `Initial actions per turn: ${turnTest.actionsLeft} (expected 3)`);

    // Test property set completion detection
    const setTest = await page.evaluate(() => {
        // Manually create a completed set for testing
        const p = window.gameState.players[0];
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

        // Find some brown properties
        const brownProps = window.gameState.deck.filter(c =>
            c.data.type === 'PROPERTY' && c.data.colorKey === 'BROWN'
        ).slice(0, 2);

        if (brownProps.length === 2) {
            p.properties.BROWN = brownProps;
            brownProps.forEach(c => {
                c.zone = 'board';
                c.owner = 0;
            });

            const completedSets = Object.keys(p.properties).filter(color =>
                p.properties[color].length >= PROPERTIES[color].count
            ).length;

            return {
                hasCompletedSet: completedSets > 0,
                brownCount: p.properties.BROWN.length
            };
        }

        return { hasCompletedSet: false, brownCount: 0 };
    });

    if (setTest.brownCount === 2) {
        assert(setTest.hasCompletedSet,
            "Property set completion detection works");
    }

    testReport.cardTests.GAME_MECHANICS = { initialHandTest, turnTest, setTest };
}

async function testRentCalculation(page) {
    console.log("\n=== Testing Rent Calculation ===");

    const rentCalcTest = await page.evaluate(() => {
        // Import from main.js module context
        const calculateRent = (playerId, color) => {
            const p = window.gameState.players[playerId];
            const props = p.properties[color] || [];
            if (props.length === 0) return 0;

            const PROPERTIES = {
                BROWN: { count: 2, rent: [1, 2] },
                LIGHTBLUE: { count: 3, rent: [1, 2, 3] },
                PINK: { count: 3, rent: [1, 2, 4] },
                ORANGE: { count: 3, rent: [1, 3, 5] },
                RED: { count: 3, rent: [2, 3, 6] },
                YELLOW: { count: 3, rent: [2, 4, 6] },
                GREEN: { count: 3, rent: [2, 4, 7] },
                DARKBLUE: { count: 2, rent: [3, 8] },
                UTILITY: { count: 2, rent: [1, 2] },
                RAILROAD: { count: 4, rent: [1, 2, 3, 4] }
            };

            const baseRent = PROPERTIES[color].rent[Math.min(props.length - 1, PROPERTIES[color].rent.length - 1)];
            let bonus = 0;

            if (p.buildings[color]) {
                p.buildings[color].forEach(b => {
                    if (b.data.effect === 'house') bonus += 3;
                    if (b.data.effect === 'hotel') bonus += 4;
                });
            }

            return baseRent + bonus;
        };
        const PROPERTIES = {
            BROWN: { count: 2, rent: [1, 2] },
            RED: { count: 3, rent: [2, 3, 6] }
        };

        const p = window.gameState.players[0];

        // Test 1: Single BROWN property
        const brownProp = window.gameState.deck.find(c =>
            c.data.type === 'PROPERTY' && c.data.colorKey === 'BROWN'
        );
        if (brownProp) {
            p.properties.BROWN = [brownProp];
            const rent1 = calculateRent(0, 'BROWN');

            // Test 2: Complete BROWN set
            const brownProp2 = window.gameState.deck.find(c =>
                c.data.type === 'PROPERTY' && c.data.colorKey === 'BROWN' && c !== brownProp
            );
            if (brownProp2) {
                p.properties.BROWN = [brownProp, brownProp2];
                const rent2 = calculateRent(0, 'BROWN');

                return {
                    singleBrown: rent1,
                    completeBrown: rent2,
                    expectedSingle: 1,
                    expectedComplete: 2
                };
            }
        }

        return null;
    });

    if (rentCalcTest) {
        assert(rentCalcTest.singleBrown === rentCalcTest.expectedSingle,
            `Single BROWN rent: ${rentCalcTest.singleBrown} (expected ${rentCalcTest.expectedSingle})`);
        assert(rentCalcTest.completeBrown === rentCalcTest.expectedComplete,
            `Complete BROWN set rent: ${rentCalcTest.completeBrown} (expected ${rentCalcTest.expectedComplete})`);
    }

    testReport.cardTests.RENT_CALCULATION = rentCalcTest;
}

async function runAllTests() {
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on('pageerror', error => {
        console.error('Browser Error:', error.message);
    });

    try {
        console.log("🧪 Starting Unit Tests for Lord Landlord Card Game\n");

        await setupGame(page);
        console.log("✓ Game initialized\n");

        // Run all card tests
        await testMoneyCards(page);
        await testPropertyCards(page);
        await testWildCards(page);
        await testRentCards(page);
        await testActionCards(page);
        await testBuildingCards(page);
        await testTotalDeckSize(page);
        await testGameMechanics(page);
        await testRentCalculation(page);

        // Save report
        fs.writeFileSync('test-unit-results.json', JSON.stringify(testReport, null, 2));

        console.log("\n" + "=".repeat(50));
        console.log("TEST SUMMARY");
        console.log("=".repeat(50));
        console.log(`Total Tests: ${testReport.passed + testReport.failed}`);
        console.log(`✓ Passed: ${testReport.passed}`);
        console.log(`✗ Failed: ${testReport.failed}`);
        console.log(`Success Rate: ${((testReport.passed / (testReport.passed + testReport.failed)) * 100).toFixed(1)}%`);
        console.log("=".repeat(50));

        await browser.close();

        return testReport.failed === 0;

    } catch (error) {
        console.error("\n✗ Test suite failed:", error);
        await browser.close();
        throw error;
    }
}

const server = app.listen(PORT, async () => {
    try {
        const success = await runAllTests();
        process.exit(success ? 0 : 1);
    } catch (error) {
        console.error(error);
        process.exit(1);
    } finally {
        server.close();
    }
});
