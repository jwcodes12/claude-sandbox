// Throwaway solo smoke: static server + chromium, click solo, assert board renders, no errors.
import path from 'node:path';
import express from 'express';
import { chromium } from 'playwright';

const APP_ROOT = '/home/opc/claude-sandbox/apps/lordlandlord';

const app = express();
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(express.static(path.join(APP_ROOT, 'src')));
const httpServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = httpServer.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
// hermetic: stub external CDN/font fetches
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 204, body: '' }));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForSelector('#btn-solo-game', { timeout: 15000 });
await page.click('#btn-solo-game');
await page.waitForSelector('#game-container:not(.hidden)', { timeout: 15000 });
// board rendered with content?
await page.waitForFunction(() => {
  const root = document.getElementById('game-root');
  return root && root.children.length > 0 && root.innerHTML.length > 500;
}, { timeout: 15000 });
// let a couple of bot turns tick
await page.waitForTimeout(3000);

const cardCount = await page.evaluate(() => document.querySelectorAll('#game-root .card, #game-root [class*="card"]').length);
console.log(`board rendered, card-ish elements: ${cardCount}`);
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exitCode = 1; }
else console.log('SOLO SMOKE PASS: board rendered, zero pageerror/console.error');

await browser.close();
httpServer.close();
