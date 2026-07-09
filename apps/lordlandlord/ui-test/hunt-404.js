// Find every request that 4xxs while loading the game.
const puppeteer = require('puppeteer');

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    const requests = [];
    page.on('response', (res) => {
        const status = res.status();
        if (status >= 400) requests.push({ status, url: res.url() });
    });
    page.on('requestfailed', (req) => {
        requests.push({ status: 'FAILED', url: req.url(), reason: req.failure()?.errorText });
    });
    page.on('pageerror', (err) => console.log('pageerror:', err.message));

    await page.setViewport({ width: 390, height: 844 });
    await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });

    await page.type('#player-name-create', 'Mr. Shrewsberry');
    await page.click('#btn-create-game');
    await page.waitForSelector('#lobby-container:not(.hidden)');
    await page.click('#btn-add-bot');
    await page.click('#btn-start-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 500));

    console.log('Failed/4xx requests:');
    requests.forEach(r => console.log(' -', r.status, r.url, r.reason || ''));

    // Also check whether PeerJS loaded
    const peerLoaded = await page.evaluate(() => typeof Peer);
    console.log('typeof Peer:', peerLoaded);

    await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
