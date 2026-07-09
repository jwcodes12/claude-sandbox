// End-to-end play verification: tap-select, tap-target, end turn, bot turn.
const puppeteer = require('puppeteer');
const path = require('path');

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
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
    await page.click('#btn-add-bot');
    await page.click('#btn-start-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 200));

    // Step 1: tap-select a money card in hand
    const before = await page.evaluate(() => ({
        handCount: document.querySelectorAll('.your-hand .card').length,
        actions: document.querySelector('[data-field="actions"]').textContent,
        bankChips: document.querySelectorAll('.your-bank .money-chip').length
    }));
    console.log('initial:', before);

    // Find a money card by name pattern
    const moneyCardId = await page.evaluate(() => {
        for (const c of document.querySelectorAll('.your-hand .card')) {
            const name = c.querySelector('.card-name')?.textContent || '';
            if (/Gold$/.test(name)) return c.dataset.cardId;
        }
        return null;
    });

    if (!moneyCardId) {
        console.log('No money card found in hand (random deal). Skipping play test, but verifying other features.');
    } else {
        console.log('money card id:', moneyCardId);

        // Tap to select
        await page.click(`.your-hand .card[data-card-id="${moneyCardId}"]`);
        await new Promise(r => setTimeout(r, 100));
        const selected = await page.evaluate(() =>
            !!document.querySelector('.your-hand .card.selected')
        );
        console.log('selected after tap:', selected);
        if (!selected) errors.push('card did not become selected after tap');

        // Tap bank to play
        await page.click('.your-bank');
        await new Promise(r => setTimeout(r, 200));

        const after = await page.evaluate(() => ({
            handCount: document.querySelectorAll('.your-hand .card').length,
            actions: document.querySelector('[data-field="actions"]').textContent,
            bankChips: document.querySelectorAll('.your-bank .money-chip').length,
            yourGold: document.querySelector('[data-field="your-gold"]').textContent
        }));
        console.log('after play:', after);

        if (after.handCount !== before.handCount - 1) errors.push(`hand should decrement: ${before.handCount} -> ${after.handCount}`);
        if (after.actions !== 'Actions: 2') errors.push(`actions should be 2: ${after.actions}`);
        if (after.bankChips !== 1) errors.push(`bank should have 1 chip: ${after.bankChips}`);
    }

    // Click End Turn
    await page.click('[data-action="end-turn"]');
    await new Promise(r => setTimeout(r, 100));

    const afterEndTurn = await page.evaluate(() => ({
        actions: document.querySelector('[data-field="actions"]').textContent,
        endDisabled: document.querySelector('[data-action="end-turn"]').disabled
    }));
    console.log('after end turn:', afterEndTurn);
    if (!afterEndTurn.endDisabled) errors.push(`end turn button should be disabled during bot turn`);

    await page.screenshot({ path: path.join(__dirname, 'verify-play.png'), fullPage: true });

    await browser.close();
    if (errors.length) {
        console.log('\nERRORS:');
        errors.forEach(e => console.log(' - ' + e));
        process.exit(1);
    }
    console.log('\nGameplay verified.');
}

main().catch(err => { console.error(err); process.exit(1); });
