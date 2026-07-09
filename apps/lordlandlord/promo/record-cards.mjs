// promo/record-cards.mjs — record each title card into /tmp/ll-promo/cards/NN.webm
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/ll-promo/cards';
fs.mkdirSync(OUT, { recursive: true });

const DURATIONS = { 1: 9600, 2: 17200, 3: 11900, 4: 10900, 5: 14900, 6: 9700 };
const NAMES = { 1: 'intro', 2: 'roast', 3: 'rebuild', 4: 'receipts', 5: 'names', 6: 'outro' };

const browser = await chromium.launch();
for (const [n, ms] of Object.entries(DURATIONS)) {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: OUT, size: { width: 1280, height: 720 } },
    });
    const page = await context.newPage();
    await page.goto(`file://${path.join(__dirname, 'cards.html')}?card=${n}`, { waitUntil: 'load' });
    await page.waitForTimeout(ms);
    const vid = page.video();
    await context.close();
    const dest = path.join(OUT, `0${n}-${NAMES[n]}.webm`);
    fs.copyFileSync(await vid.path(), dest);
    fs.unlinkSync(await vid.path());
    console.log(`card ${n} (${NAMES[n]}): ${ms / 1000}s -> ${dest}`);
}
await browser.close();
console.log('CARDS DONE');
