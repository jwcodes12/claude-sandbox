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
        
        // Wait for Create Game button and click
        await page.waitForSelector('#btn-create-game');
        await page.click('#btn-create-game');
        await new Promise(r => setTimeout(r, 500));

        // Wait for Add Bot button and click
        await page.waitForSelector('#btn-add-bot');
        await page.click('#btn-add-bot');
        await new Promise(r => setTimeout(r, 500));

        // Click Start Reign
        await page.click('#btn-start-game');
        await new Promise(r => setTimeout(r, 2000));

        const uiState = await page.evaluate(() => {
            return {
                playerZonesLength: window.UI.playerZones.length,
                handSize: window.gameState.players[0].hand.length,
                turn: window.gameState.turn
            };
        });
        console.log("UI State:", JSON.stringify(uiState, null, 2));

        await page.screenshot({ path: 'screenshot.png' });
        console.log("Saved screenshot.png");

        await browser.close();
    } catch (e) {
        console.error("Test error:", e);
    } finally {
        server.close();
        process.exit(0);
    }
});
