// Verify the rent-ladder change doesn't clip opponent cards.
const puppeteer = require('puppeteer');
const path = require('path');

async function snapshot(label, page) {
    const out = path.join(__dirname, `test-rent-ladder-${label}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log('saved', out);
}

async function measure(page) {
    return await page.evaluate(() => {
        const result = { opponents: [], yourStacks: [] };
        for (const opp of document.querySelectorAll('.opponent')) {
            const oppRect = opp.getBoundingClientRect();
            const kingdom = opp.querySelector('.opp-kingdom');
            const kRect = kingdom ? kingdom.getBoundingClientRect() : null;
            const stacks = [];
            for (const stack of opp.querySelectorAll('.color-stack')) {
                const sRect = stack.getBoundingClientRect();
                const firstCard = stack.querySelector('.card');
                const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;
                const ladder = stack.querySelector('.rent-ladder');
                const lRect = ladder ? ladder.getBoundingClientRect() : null;
                stacks.push({
                    stackTop: sRect.top, stackBottom: sRect.bottom, stackHeight: sRect.height,
                    cardTop: cardRect?.top, cardBottom: cardRect?.bottom,
                    ladderTop: lRect?.top, ladderHeight: lRect?.height,
                    clippedTop: kRect ? (sRect.top < kRect.top - 1) : null,
                    clippedBottom: kRect ? (sRect.bottom > kRect.bottom + 1) : null
                });
            }
            result.opponents.push({
                playerId: opp.dataset.playerId,
                oppTop: oppRect.top, oppBottom: oppRect.bottom, oppHeight: oppRect.height,
                kingdomTop: kRect?.top, kingdomBottom: kRect?.bottom, kingdomHeight: kRect?.height,
                kingdomScrollH: kingdom?.scrollHeight, kingdomClientH: kingdom?.clientHeight,
                kingdomOverflowY: kingdom ? (kingdom.scrollHeight - kingdom.clientHeight) : null,
                stacks
            });
        }
        for (const stack of document.querySelectorAll('.your-kingdom .color-stack')) {
            const sRect = stack.getBoundingClientRect();
            const firstCard = stack.querySelector('.card');
            const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;
            const ladder = stack.querySelector('.rent-ladder');
            const lRect = ladder ? ladder.getBoundingClientRect() : null;
            result.yourStacks.push({
                stackTop: sRect.top, stackHeight: sRect.height,
                cardTop: cardRect?.top, cardBottom: cardRect?.bottom,
                ladderTop: lRect?.top, ladderHeight: lRect?.height
            });
        }
        return result;
    });
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push('pageerror: ' + err.message));
    page.on('console', msg => {
        if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
            errors.push('console: ' + msg.text());
        }
    });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });

    await page.click('#btn-solo-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 300));

    // Inject properties onto opponents + self via the exposed __game handle.
    await page.evaluate(() => {
        const s = window.__game.state();
        const HEX = {
            BROWN:'#8B4513', LIGHTBLUE:'#ADD8E6', PINK:'#FF1493', ORANGE:'#FF8C00',
            RED:'#DC143C', YELLOW:'#FFD700', GREEN:'#228B22', DARKBLUE:'#00008B',
            UTILITY:'#E8E4DC', RAILROAD:'#000000'
        };
        function mkProp(colorKey, name, ownerId) {
            return {
                data: { id:`inj-${Math.random().toString(36).slice(2,8)}`, type:'PROPERTY',
                    colorKey, name, hex: HEX[colorKey] || '#888', value: 2 },
                owner: ownerId
            };
        }
        const p1 = s.players[1], p2 = s.players[2], p0 = s.players[0];
        if (p1) {
            p1.properties = p1.properties || {};
            p1.properties.PINK = [mkProp('PINK','St. Charles Place',1), mkProp('PINK','States Ave',1)];
            p1.properties.ORANGE = [mkProp('ORANGE','St. James',1)];
            p1.properties.RAILROAD = [mkProp('RAILROAD','Reading RR',1), mkProp('RAILROAD','B&O',1)];
        }
        if (p2) {
            p2.properties = p2.properties || {};
            p2.properties.GREEN = [mkProp('GREEN','Pacific Ave',2)];
            p2.properties.DARKBLUE = [mkProp('DARKBLUE','Boardwalk',2)];
        }
        if (p0) {
            p0.properties = p0.properties || {};
            p0.properties.YELLOW = [mkProp('YELLOW','Marvin Gardens',0)];
        }
        window.__game.update();
    });

    await new Promise(r => setTimeout(r, 350));
    await snapshot('iphone', page);

    const m1 = await measure(page);
    console.log('=== iPhone (390x844) ===');
    console.dir(m1, { depth: 5 });

    // Also test tablet width
    await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 2 });
    await new Promise(r => setTimeout(r, 250));
    await snapshot('tablet', page);
    const m2 = await measure(page);
    console.log('=== Tablet (768x1024) ===');
    console.dir(m2, { depth: 5 });

    if (errors.length) {
        console.log('ERRORS:', errors);
    }

    // Verdict
    const allStacks = [...m1.opponents.flatMap(o => o.stacks), ...m2.opponents.flatMap(o => o.stacks)];
    const clipped = allStacks.filter(s => s.clippedTop || s.clippedBottom);
    if (clipped.length) {
        console.log(`FAIL: ${clipped.length} stack(s) clipped by kingdom container`);
        process.exit(1);
    } else {
        console.log('PASS: no clipping detected');
    }

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
