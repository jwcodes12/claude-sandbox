// Diagnostic: open Gemini with the bot profile, screenshot it, log URL/title.
// Tells us whether the session is still logged in and what Gemini is showing.
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const userDataDir = '/Users/john.watkins/chrome-bot-profile';
    const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: true,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(5000);
        const url = page.url();
        const title = await page.title();
        const hasInput = await page.locator('rich-textarea p, .ql-editor').count();
        const hasSignIn = await page.locator('text=Sign in').count();
        if (!fs.existsSync('output_images')) fs.mkdirSync('output_images');
        const shot = 'output_images/_diag.png';
        await page.screenshot({ path: shot, fullPage: false });
        console.log(JSON.stringify({ url, title, hasInput, hasSignIn, shot }, null, 2));
    } catch (e) {
        console.error('diag error:', e.message);
    } finally {
        await ctx.close();
    }
})();
