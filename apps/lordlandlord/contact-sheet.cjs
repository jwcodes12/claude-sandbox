// Render a large contact sheet (PNG) of every card image.
// 4 cols x 6 rows, each cell ~380x600, with labels.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CARDS_DIR = path.join(__dirname, 'src', 'img', 'cards');
const OUT_PATH = '/tmp/cards-sheet.png';

(async () => {
    const { cards } = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'card-prompts.json'), 'utf8')
    );

    const cells = cards.map((c) => {
        const file = path.join(CARDS_DIR, `${c.key}.png`);
        return { key: c.key, src: fs.existsSync(file) ? `file://${file}` : null };
    });

    const html = `<!doctype html>
<html><head><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #111; font-family: -apple-system, sans-serif; color: #eee; padding: 24px; }
  h1 { margin: 0 0 24px; font-size: 28px; letter-spacing: 0.05em; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; }
  .cell { display: flex; flex-direction: column; align-items: center; background: #1c1c1c; padding: 12px; border-radius: 8px; }
  .cell img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px; background: #000; }
  .cell .missing { width: 100%; aspect-ratio: 2 / 3; display: flex; align-items: center; justify-content: center; background: #401010; color: #f88; border-radius: 6px; font-weight: 700; }
  .cell .label { margin-top: 10px; font-size: 16px; font-weight: 700; letter-spacing: 0.04em; }
</style></head><body>
<h1>LORD LANDLORD — card art preview (${cards.length})</h1>
<div class="grid">
${cells
    .map(
        (c) => `
  <div class="cell">
    ${c.src ? `<img src="${c.src}" />` : `<div class="missing">MISSING</div>`}
    <div class="label">${c.key}</div>
  </div>`
    )
    .join('')}
</div>
</body></html>`;

    const tmpHtml = '/tmp/_cards-sheet.html';
    fs.writeFileSync(tmpHtml, html);

    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1800, height: 1200 });
    await page.goto(`file://${tmpHtml}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: OUT_PATH, fullPage: true });
    await page.close();
    await browser.close();
    console.log(`wrote ${OUT_PATH}`);
})();
