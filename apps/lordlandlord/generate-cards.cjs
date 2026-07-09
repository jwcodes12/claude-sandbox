// Inline parallel card-art generator.
// Each task opens its own fresh tab (no pool race), polls for a real image
// (blob: or googleusercontent src, width >= 200), screenshots it, closes the tab.
//
// Usage:
//   node generate-cards.cjs                          # all cards, default parallelism 4
//   node generate-cards.cjs --parallel 6             # tune parallelism
//   node generate-cards.cjs BROWN DARKBLUE           # specific keys
//   node generate-cards.cjs --parallel 2 BROWN RED   # mix
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = 'http://localhost:9222';
const CARDS_DIR = path.join(__dirname, 'src', 'img', 'cards');
const PER_TASK_TIMEOUT_MS = 120_000;
const TYPE_DELAY_MS = 30;
const MAX_ATTEMPTS = 2;

function isLikelyGeneratedImg(src) {
    if (!src) return false;
    if (src.startsWith('blob:')) return true;
    if (src.startsWith('data:image')) return true;
    if (src.includes('googleusercontent.com')) return true;
    return false;
}

async function generateOne(context, { key, prompt }, label) {
    const page = await context.newPage();
    try {
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);

        const input = page.locator('rich-textarea p, .ql-editor').first();
        await input.waitFor({ state: 'visible', timeout: 15000 });
        await input.click();
        await page.waitForTimeout(400);

        await page.keyboard.type(prompt, { delay: TYPE_DELAY_MS });
        await page.waitForTimeout(600);
        await page.keyboard.press('Enter');

        const start = Date.now();
        let target = null;
        while (Date.now() - start < PER_TASK_TIMEOUT_MS) {
            await page.waitForTimeout(2500);
            const imgs = await page.locator('img').all();
            for (const img of imgs) {
                const [src, box] = await Promise.all([
                    img.getAttribute('src').catch(() => null),
                    img.boundingBox().catch(() => null),
                ]);
                if (!box) continue;
                if (box.width < 200 || box.height < 200) continue;
                if (!isLikelyGeneratedImg(src)) continue;
                target = img;
                break;
            }
            if (target) break;
        }

        if (!target) {
            console.error(`${label} timeout (no image after ${PER_TASK_TIMEOUT_MS / 1000}s)`);
            return { key, status: 'timeout' };
        }

        // Pull actual pixels from the <img> via canvas — avoids screenshotting
        // surrounding UI when the img's bounding box is taller than the image.
        const dataUrl = await target.evaluate((el) => {
            try {
                const c = document.createElement('canvas');
                c.width = el.naturalWidth || el.width;
                c.height = el.naturalHeight || el.height;
                c.getContext('2d').drawImage(el, 0, 0);
                return c.toDataURL('image/png');
            } catch (_) {
                return null;
            }
        });
        const dest = path.join(CARDS_DIR, `${key}.png`);
        if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
            fs.writeFileSync(dest, Buffer.from(dataUrl.split(',')[1], 'base64'));
        } else {
            // canvas was tainted (cross-origin) — fall back to element screenshot
            const buf = await target.screenshot();
            fs.writeFileSync(dest, buf);
        }
        const sec = Math.round((Date.now() - start) / 1000);
        console.log(`${label} OK in ${sec}s -> ${path.relative(__dirname, dest)}`);
        return { key, status: 'ok' };
    } catch (e) {
        console.error(`${label} error: ${e.message}`);
        return { key, status: 'error', error: e.message };
    } finally {
        await page.close().catch(() => {});
    }
}

async function generateWithRetry(context, task, label) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const r = await generateOne(context, task, `${label} (try ${attempt}/${MAX_ATTEMPTS})`);
        if (r.status === 'ok') return r;
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 5000));
    }
    return { key: task.key, status: 'failed-all-attempts' };
}

(async () => {
    const argv = process.argv.slice(2);
    let parallelism = 4;
    const keys = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--parallel' || argv[i] === '-p') {
            parallelism = Number(argv[++i]) || 4;
        } else {
            keys.push(argv[i]);
        }
    }

    const { promptPrefix, styleSuffix, cards } = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'card-prompts.json'), 'utf8')
    );
    const targets = keys.length ? cards.filter((c) => keys.includes(c.key)) : cards;
    if (!targets.length) {
        console.error('No matching cards. Available keys:');
        console.error(cards.map((c) => '  ' + c.key).join('\n'));
        process.exit(1);
    }
    if (!fs.existsSync(CARDS_DIR)) fs.mkdirSync(CARDS_DIR, { recursive: true });

    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
    } catch (e) {
        console.error('ERROR: Chrome is not listening on port 9222. Start it with:');
        console.error('  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\');
        console.error('    --remote-debugging-port=9222 \\');
        console.error('    --user-data-dir="/Users/john.watkins/chrome-bot-profile"');
        process.exit(1);
    }
    const context = browser.contexts()[0];

    const probe = await context.newPage();
    await probe.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    await probe.waitForTimeout(3000);
    const signedOut = (await probe.locator('text=Sign in').count()) > 0;
    await probe.close();
    if (signedOut) {
        console.error('ERROR: bot profile signed out of Gemini. Sign in at gemini.google.com.');
        await browser.close();
        process.exit(1);
    }
    console.log(`Session OK. Generating ${targets.length} card(s), ${parallelism} at a time.\n`);

    const tasks = targets.map((c) => ({
        key: c.key,
        prompt: `${promptPrefix} ${c.subject} ${styleSuffix}`,
    }));

    const t0 = Date.now();
    const results = [];
    const queue = tasks.slice();
    let started = 0;
    const workers = Array.from({ length: parallelism }, async () => {
        while (queue.length) {
            const t = queue.shift();
            const idx = ++started;
            const label = `[${idx}/${tasks.length}] ${t.key}`;
            console.log(`${label} start`);
            const r = await generateWithRetry(context, t, label);
            results.push(r);
        }
    });
    await Promise.all(workers);

    await browser.close();

    console.log('\n--- summary ---');
    for (const r of results) console.log(`  ${r.status.padEnd(20)} ${r.key}`);
    const ok = results.filter((r) => r.status === 'ok').length;
    console.log(`\n${ok}/${results.length} succeeded in ${Math.round((Date.now() - t0) / 1000)}s.`);
    const failed = results.filter((r) => r.status !== 'ok').map((r) => r.key);
    if (failed.length) console.log(`Retry: node generate-cards.cjs ${failed.join(' ')}`);
})();
