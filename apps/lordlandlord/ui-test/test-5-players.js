const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = 3000;
app.use(express.static(path.join(__dirname, '..')));

const server = app.listen(PORT, async () => {
    try {
        const browser = await puppeteer.launch({ headless: "new" });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 800 });

        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', error => console.log('BROWSER ERROR:', error.message));

        await page.goto(`http://localhost:${PORT}/src/index.html`, { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('#btn-create-game');
        await page.click('#btn-create-game');
        await new Promise(r => setTimeout(r, 500));

        // Add 4 bots to make it 5 players total
        for (let i = 0; i < 4; i++) {
            await page.click('#btn-add-bot');
            await new Promise(r => setTimeout(r, 200));
        }

        // Start game
        await page.click('#btn-start-game');
        console.log("Game started with 5 players");
        await new Promise(r => setTimeout(r, 2000));

        // Let the bots play for a bit
        await page.click('#btn-auto-play');
        console.log("Royal Auto-Duel enabled");
        
        // Watch for 10 seconds
        await new Promise(r => setTimeout(r, 10000));

        await page.screenshot({ path: '5-player-battle.png' });
        console.log("Saved 5-player-battle.png");

        await browser.close();
    } catch (e) {
        console.error("Test error:", e);
    } finally {
        server.close();
        process.exit(0);
    }
});
