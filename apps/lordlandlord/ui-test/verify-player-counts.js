// Verify the layout across 2-5 player games.
const puppeteer = require('puppeteer');
const path = require('path');

async function runCount(browser, playerCount) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
            errors.push('console: ' + msg.text());
        }
    });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });

    await page.type('#player-name-create', 'Mr. Shrewsberry');
    await page.click('#btn-create-game');
    await page.waitForSelector('#lobby-container:not(.hidden)');
    for (let i = 0; i < playerCount - 1; i++) await page.click('#btn-add-bot');
    await page.click('#btn-start-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 200));

    const layout = await page.evaluate(() => ({
        opponentCount: document.querySelectorAll('.opponent').length,
        handCount: document.querySelectorAll('.your-hand .card').length,
        topBar: !!document.querySelector('.top-bar'),
        endTurnVisible: !!document.querySelector('[data-action="end-turn"]')
    }));

    await page.screenshot({ path: path.join(__dirname, `verify-${playerCount}p.png`), fullPage: true });

    const expectedOpps = playerCount - 1;
    if (layout.opponentCount !== expectedOpps) errors.push(`${playerCount}p: expected ${expectedOpps} opponents, got ${layout.opponentCount}`);
    if (layout.handCount !== 5) errors.push(`${playerCount}p: expected 5 hand cards, got ${layout.handCount}`);
    if (!layout.topBar) errors.push(`${playerCount}p: top bar missing`);
    if (!layout.endTurnVisible) errors.push(`${playerCount}p: end turn missing`);

    await page.close();
    return { playerCount, layout, errors };
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const allErrors = [];

    for (const n of [2, 3, 4, 5]) {
        const r = await runCount(browser, n);
        console.log(`${n}-player:`, r.layout);
        allErrors.push(...r.errors);
    }

    await browser.close();

    if (allErrors.length) {
        console.log('\nERRORS:');
        allErrors.forEach(e => console.log(' - ' + e));
        process.exit(1);
    }
    console.log('\nAll player counts verified.');
}

main().catch(err => { console.error(err); process.exit(1); });
