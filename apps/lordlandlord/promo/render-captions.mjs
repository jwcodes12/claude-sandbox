// promo/render-captions.mjs — caption bands as transparent PNGs (ffmpeg here
// has no drawtext, and this matches the cards' styling anyway).
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/tmp/ll-promo/captions';
fs.mkdirSync(OUT, { recursive: true });

const CAPTIONS = {
    'lobby': 'forging the realm · joining by code',
    'play': 'two phones · one live realm',
    'refresh': 'mid-game refresh → straight back into your seat',
    'heal': 'connection killed → it heals itself',
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 130 } });
for (const [name, text] of Object.entries(CAPTIONS)) {
    await page.setContent(`
        <body style="margin:0;background:transparent">
        <div style="width:1280px;height:130px;display:flex;align-items:center;justify-content:center;font-family:Georgia,serif;">
          <div style="background:rgba(10,6,2,0.72);border:1px solid rgba(212,175,55,0.45);border-radius:14px;
                      padding:16px 42px;color:#d4af37;font-size:38px;letter-spacing:0.5px;
                      text-shadow:0 2px 8px rgba(0,0,0,0.8);">${text}</div>
        </div></body>`);
    await page.screenshot({ path: `${OUT}/${name}.png`, omitBackground: true });
    console.log(`${name}.png`);
}
await browser.close();
console.log('CAPTIONS DONE');
