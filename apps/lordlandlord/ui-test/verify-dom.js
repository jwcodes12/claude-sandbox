// Verify the new DOM UI renders correctly across viewport sizes.
const puppeteer = require('puppeteer');
const path = require('path');

const URL = 'http://localhost:8765/';

const viewports = [
    { name: 'iphone-portrait', width: 390, height: 844, scaleFactor: 2 },
    { name: 'pixel-portrait', width: 412, height: 915, scaleFactor: 2.6 },
    { name: 'tablet-portrait', width: 768, height: 1024, scaleFactor: 2 },
    { name: 'desktop', width: 1280, height: 800, scaleFactor: 1 }
];

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const errors = [];

    for (const vp of viewports) {
        const page = await browser.newPage();
        page.on('pageerror', (err) => errors.push(`[${vp.name}] page error: ${err.message}`));
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(`[${vp.name}] console: ${msg.text()}`);
        });

        await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.scaleFactor });
        await page.goto(URL, { waitUntil: 'networkidle2' });

        // Bypass PeerJS (would block waiting for connect).
        await page.evaluate(() => {
            const idEl = document.getElementById('lobby-id-display');
            if (idEl) idEl.textContent = 'LOCAL-TEST';
        });

        // Create lobby with 3 bots (4-player game)
        await page.type('#player-name-create', 'Mr. Shrewsberry');
        await page.click('#btn-create-game');
        await page.waitForSelector('#lobby-container:not(.hidden)');
        for (let i = 0; i < 3; i++) await page.click('#btn-add-bot');
        await page.click('#btn-start-game');
        await page.waitForSelector('#game-container:not(.hidden)');
        // Let the initial render settle
        await new Promise(r => setTimeout(r, 250));

        const layout = await page.evaluate(() => ({
            topBar: !!document.querySelector('.top-bar'),
            opponentCount: document.querySelectorAll('.opponent').length,
            yourHand: document.querySelectorAll('.your-hand .card').length,
            yourBank: !!document.querySelector('.your-bank'),
            yourKingdom: !!document.querySelector('.your-kingdom'),
            zoneStrip: !!document.querySelector('.zone-strip'),
            endTurnBtn: !!document.querySelector('[data-action="end-turn"]'),
            actionsText: document.querySelector('[data-field="actions"]')?.textContent,
            yourGold: document.querySelector('[data-field="your-gold"]')?.textContent,
            kingdomText: document.querySelector('[data-field="kingdom"]')?.textContent,
            canvasGone: !document.getElementById('gameCanvas'),
            uiLayerGone: !document.getElementById('ui-layer'),
            autoDuelGone: !document.getElementById('btn-auto-play')
        }));

        const screenshotPath = path.join(__dirname, `verify-${vp.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        console.log(`\n=== ${vp.name} (${vp.width}x${vp.height}) ===`);
        console.log(JSON.stringify(layout, null, 2));
        console.log(`screenshot: ${screenshotPath}`);

        const expected = {
            topBar: true,
            opponentCount: 3,
            yourHand: 5,
            yourBank: true,
            yourKingdom: true,
            zoneStrip: true,
            endTurnBtn: true,
            canvasGone: true,
            uiLayerGone: true,
            autoDuelGone: true
        };
        for (const [k, v] of Object.entries(expected)) {
            if (layout[k] !== v) errors.push(`[${vp.name}] ${k}: expected ${v}, got ${layout[k]}`);
        }

        await page.close();
    }

    await browser.close();

    if (errors.length) {
        console.log('\nERRORS:');
        errors.forEach(e => console.log(' - ' + e));
        process.exit(1);
    }
    console.log('\nAll viewports verified.');
}

main().catch(err => { console.error(err); process.exit(1); });
