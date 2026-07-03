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

        await page.goto(`http://localhost:${PORT}/src/index.html`, { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('#btn-create-game');
        await page.click('#btn-create-game');
        await new Promise(r => setTimeout(r, 500));
        
        // Add 2 bots for a 3-player game
        await page.click('#btn-add-bot');
        await new Promise(r => setTimeout(r, 200));
        await page.click('#btn-add-bot');
        await new Promise(r => setTimeout(r, 200));
        
        await page.click('#btn-start-game');
        console.log("Game started with 3 players");
        await new Promise(r => setTimeout(r, 2000));

        await page.click('#btn-auto-play');
        console.log("Royal Auto-Duel enabled, letting the bots battle...");
        
        // Wait 15 seconds to let the board fill up
        await new Promise(r => setTimeout(r, 15000));

        await page.screenshot({ path: 'test-full-game.png' });
        console.log("Saved test-full-game.png!");

        await browser.close();
    } catch (e) {
        console.error("Test error:", e);
    } finally {
        server.close();
        process.exit(0);
    }
});
