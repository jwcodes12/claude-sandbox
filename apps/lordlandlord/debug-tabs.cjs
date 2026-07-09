// Walk every tab in the live Chrome via CDP, screenshot each, log URL/title/recent text.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    if (!fs.existsSync('output_images')) fs.mkdirSync('output_images');
    for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const url = p.url();
        const title = await p.title().catch(() => '?');
        if (!url.includes('gemini.google.com')) {
            console.log(`tab[${i}] skip non-gemini: ${url}`);
            continue;
        }
        const shot = path.join('output_images', `_tab${i}.png`);
        try {
            await p.bringToFront();
        } catch {}
        await p.screenshot({ path: shot, fullPage: true });
        const messages = await p.locator('message-content').count();
        const imgs = await p.locator('message-content img').count();
        const lastText = await p
            .locator('message-content')
            .last()
            .innerText()
            .catch(() => '?');
        console.log(`tab[${i}] ${url}`);
        console.log(`  title: ${title}`);
        console.log(`  message-content: ${messages}, img-in-messages: ${imgs}`);
        console.log(`  last message text (first 400 chars):`);
        console.log('    ' + lastText.slice(0, 400).replace(/\n/g, '\n    '));
        console.log(`  shot: ${shot}`);
    }
    await browser.close();
})();
