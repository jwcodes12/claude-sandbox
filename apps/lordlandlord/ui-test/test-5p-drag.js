// 5-player mobile drag-and-drop UX audit.
// Reports tap-target sizes, layout overflow, drag overlay behavior, and the
// dragging-source fade. Captures screenshots at each phase.
const puppeteer = require('puppeteer');
const path = require('path');

const VIEWPORTS = [
    { name: 'iphone-se',     w: 375, h: 667 },
    { name: 'iphone-14',     w: 390, h: 844 },
    { name: 'pixel-7',       w: 412, h: 915 }
];

async function snap(page, label) {
    const out = path.join(__dirname, `test-5p-${label}.png`);
    await page.screenshot({ path: out, fullPage: false });
    return out;
}

async function dispatchPointer(page, type, x, y) {
    await page.evaluate(({ type, x, y }) => {
        const el = document.elementFromPoint(x, y) || document.body;
        const ev = new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true
        });
        el.dispatchEvent(ev);
    }, { type, x, y });
}

async function dragFromTo(page, fromSel, toSel) {
    const from = await page.$(fromSel);
    const to = await page.$(toSel);
    if (!from || !to) return { ok: false, reason: `missing ${!from ? fromSel : toSel}` };
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
    const bx = b.x + b.width / 2, by = b.y + b.height / 2;

    await dispatchPointer(page, 'pointerdown', ax, ay);
    // Tiny initial nudge to cross the tap threshold and arm the overlay
    await dispatchPointer(page, 'pointermove', ax + 8, ay + 8);
    // Capture mid-drag state
    const midDrag = await page.evaluate(() => ({
        overlayCount: document.querySelectorAll('.drag-overlay').length,
        draggingSourceCount: document.querySelectorAll('.dragging-source').length
    }));
    // Step toward target
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await dispatchPointer(page, 'pointermove', ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    await dispatchPointer(page, 'pointerup', bx, by);
    return { ok: true, midDrag };
}

async function audit(page, viewport) {
    return await page.evaluate((vw) => {
        const report = { viewport: vw, issues: [], stats: {} };

        // 1. Horizontal overflow
        const docW = document.documentElement.scrollWidth;
        report.stats.docWidth = docW;
        report.stats.viewportWidth = vw.w;
        if (docW > vw.w + 1) report.issues.push(`Horizontal overflow: doc ${docW}px > viewport ${vw.w}px`);

        // 2. Hand card tap targets
        const handCards = [...document.querySelectorAll('.your-hand .card')];
        report.stats.handCards = handCards.length;
        const tooSmall = handCards.filter(c => {
            const r = c.getBoundingClientRect();
            return r.width < 36 || r.height < 36;
        });
        if (tooSmall.length) report.issues.push(`${tooSmall.length} hand card(s) below 36×36 tap target`);
        if (handCards.length) {
            const r = handCards[0].getBoundingClientRect();
            report.stats.handCardSize = { w: Math.round(r.width), h: Math.round(r.height) };
        }

        // 3. End Turn button reachable + sized
        const endBtn = document.querySelector('[data-action="end-turn"], #btn-end-turn, .end-turn-btn');
        if (!endBtn) {
            // fallback search by text
            const candidate = [...document.querySelectorAll('button, .btn')].find(b => /end turn/i.test(b.textContent));
            if (candidate) {
                const r = candidate.getBoundingClientRect();
                report.stats.endTurn = { w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.y) };
                if (r.height < 36) report.issues.push(`End Turn button height ${Math.round(r.height)}px below 36`);
                if (r.bottom > vw.h + 1 || r.top < -1) report.issues.push(`End Turn button off-screen`);
            } else {
                report.issues.push('End Turn button not found');
            }
        }

        // 4a. opp-kingdom must NOT clip its cards along the Y axis (overflow-y
        // defaults to auto when overflow-x is auto, which crops mini cards).
        document.querySelectorAll('.opp-kingdom').forEach((k, i) => {
            const kRect = k.getBoundingClientRect();
            const cards = [...k.querySelectorAll('.color-stack .card')];
            const clipped = cards.filter(c => {
                const r = c.getBoundingClientRect();
                return r.bottom > kRect.bottom + 1 || r.top < kRect.top - 1;
            });
            if (clipped.length) {
                const example = clipped[0].getBoundingClientRect();
                report.issues.push(`opp-kingdom[${i}]: ${clipped.length}/${cards.length} cards clipped (card ${Math.round(example.top)}–${Math.round(example.bottom)} vs box ${Math.round(kRect.top)}–${Math.round(kRect.bottom)})`);
            }
        });

        // 4b. Real-world overlap checks: opponent rows shouldn't visually overlap
        const opps = [...document.querySelectorAll('.opponent')];
        report.stats.opponents = opps.length;
        // Use the union of opponent contents (header + opp-kingdom card boxes)
        // since opp-kingdom is intentionally overflow:visible.
        const oppExtents = opps.map(o => {
            const cards = [...o.querySelectorAll('.color-stack .card')];
            let top = o.getBoundingClientRect().top;
            let bottom = o.getBoundingClientRect().bottom;
            cards.forEach(c => {
                const r = c.getBoundingClientRect();
                if (r.top < top) top = r.top;
                if (r.bottom > bottom) bottom = r.bottom;
            });
            return { top, bottom, header: o.getBoundingClientRect() };
        });
        for (let i = 0; i < oppExtents.length - 1; i++) {
            const a = oppExtents[i], b = oppExtents[i + 1];
            if (a.bottom > b.top + 1) {
                report.issues.push(`Opponent ${i} content (bottom ${Math.round(a.bottom)}) overlaps opponent ${i+1} (top ${Math.round(b.top)})`);
            }
        }
        const zoneStrip = document.querySelector('.zone-strip');
        if (zoneStrip && oppExtents.length) {
            const zTop = zoneStrip.getBoundingClientRect().top;
            const lastBottom = oppExtents[oppExtents.length - 1].bottom;
            if (lastBottom > zTop + 1) report.issues.push(`Last opponent content (${Math.round(lastBottom)}) spills into zone-strip (${Math.round(zTop)})`);
        }

        // 5. Vertical layout: does anything important sit beneath the hand?
        const hand = document.querySelector('.your-hand');
        if (hand) {
            const r = hand.getBoundingClientRect();
            report.stats.handTop = Math.round(r.top);
            report.stats.handBottom = Math.round(r.bottom);
            if (r.bottom > vw.h + 1) report.issues.push(`Hand bottom ${Math.round(r.bottom)} > viewport ${vw.h}`);
        }

        // 6. Body scrollable on this viewport?
        report.stats.bodyScrollH = document.body.scrollHeight;
        if (document.body.scrollHeight > vw.h + 4) {
            // Acceptable if there's a designated scroll container; flag otherwise.
            const scroll = document.querySelector('.game-scroll');
            if (!scroll) report.issues.push(`Body scrolls (${document.body.scrollHeight} > ${vw.h}) without scroll container`);
        }

        return report;
    }, viewport);
}

async function setupFivePlayerGame(page) {
    await page.click('#btn-solo-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 200));

    // Solo defaults to 3 players. We need to restart the engine with 5.
    // Easier: reset state and re-init via __game (or fall back to reloading and
    // injecting playerCount before clicking).
    await page.evaluate(() => {
        // expose engine via __game; we need startLocalGame. Look for it.
        if (typeof window.startLocalGame === 'function') {
            window.startLocalGame(5);
        } else {
            // No exposed entry; mutate state to simulate 5-player via property injection.
            // We'll add 2 extra "ghost" opponents with properties so the layout matches.
            const s = window.__game.state();
            const HEX = { BROWN:'#8B4513', LIGHTBLUE:'#ADD8E6', PINK:'#FF1493', ORANGE:'#FF8C00',
                RED:'#DC143C', YELLOW:'#FFD700', GREEN:'#228B22', DARKBLUE:'#00008B',
                UTILITY:'#E8E4DC', RAILROAD:'#000000' };
            function mkProp(colorKey, name, ownerId) {
                return { data: { id:`x-${Math.random().toString(36).slice(2,8)}`, type:'PROPERTY',
                    colorKey, name, hex: HEX[colorKey], value: 2 }, owner: ownerId };
            }
            // mutate existing opponents to have varied properties
            for (let i = 1; i < s.players.length; i++) {
                const p = s.players[i];
                p.properties = p.properties || {};
                p.properties.PINK = [mkProp('PINK','Charles',i)];
                p.properties.GREEN = [mkProp('GREEN','Pacific',i), mkProp('GREEN','Penn',i)];
                p.properties.RAILROAD = [mkProp('RAILROAD','Reading',i)];
            }
            // also add two extra opponents (ids 3, 4)
            while (s.players.length < 5) {
                const id = s.players.length;
                s.players.push({
                    id, name: id === 3 ? 'Baron Greycastle' : 'Duchess Marlow',
                    hand: [], bank: [], properties: {
                        ORANGE: [mkProp('ORANGE','St. James', id), mkProp('ORANGE','Tennessee', id)],
                        DARKBLUE: [mkProp('DARKBLUE','Boardwalk', id)]
                    }, buildings: {}
                });
            }
            // self gets a stack too
            const me = s.players[s.localPlayerId];
            me.properties = me.properties || {};
            me.properties.YELLOW = [mkProp('YELLOW','Marvin', me.id)];
            window.__game.update();
        }
    });
    await new Promise(r => setTimeout(r, 400));
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const allFails = [];

    for (const vp of VIEWPORTS) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push('pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load')) errors.push('console: ' + m.text()); });

        await page.setViewport({ width: vp.w, height: vp.h, deviceScaleFactor: 2 });
        await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });

        await setupFivePlayerGame(page);
        await snap(page, `${vp.name}-board`);

        const report = await audit(page, vp);
        console.log(`\n=== ${vp.name} (${vp.w}x${vp.h}) ===`);
        console.log('stats:', report.stats);
        if (report.issues.length) {
            console.log('ISSUES:');
            report.issues.forEach(i => console.log('  -', i));
            allFails.push({ vp: vp.name, issues: report.issues });
        } else {
            console.log('no layout issues');
        }

        // Drag test: pick a hand card and drag to bank zone (should always be valid for money cards).
        // Find first hand card with type money — fallback to any draggable card.
        const dragInfo = await page.evaluate(() => {
            const handCard = document.querySelector('.your-hand .card[data-draggable="true"]');
            const bank = document.querySelector('[data-drop-target="bank"], .your-bank, [data-drop-target]');
            return {
                handCardId: handCard?.dataset.cardId,
                handCardName: handCard?.querySelector('.card-name')?.textContent,
                bankSel: bank ? (bank.dataset.dropTarget ? `[data-drop-target="${bank.dataset.dropTarget}"]` : '.your-bank') : null
            };
        });
        console.log('drag candidate:', dragInfo);
        if (dragInfo.handCardId && dragInfo.bankSel) {
            const fromSel = `.your-hand .card[data-card-id="${dragInfo.handCardId}"]`;
            // Manually simulate the mid-drag check
            const from = await page.$(fromSel);
            const a = await from.boundingBox();
            const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
            await dispatchPointer(page, 'pointerdown', ax, ay);
            await dispatchPointer(page, 'pointermove', ax + 12, ay + 12);
            await new Promise(r => setTimeout(r, 50));
            const dragState = await page.evaluate(() => ({
                overlayCount: document.querySelectorAll('.drag-overlay').length,
                draggingSourceCount: document.querySelectorAll('.dragging-source').length,
                sourceOpacity: getComputedStyle(document.querySelector('.dragging-source') || document.body).opacity
            }));
            await snap(page, `${vp.name}-mid-drag`);
            console.log('mid-drag:', dragState);
            if (dragState.overlayCount !== 1) allFails.push({ vp: vp.name, issues: [`drag overlay count = ${dragState.overlayCount} (expected 1)`] });
            if (dragState.draggingSourceCount !== 1) allFails.push({ vp: vp.name, issues: [`dragging-source class missing on source`] });

            // Complete drag to bank
            const to = await page.$(dragInfo.bankSel);
            if (to) {
                const b = await to.boundingBox();
                const bx = b.x + b.width / 2, by = b.y + b.height / 2;
                const steps = 6;
                for (let i = 1; i <= steps; i++) {
                    const t = i / steps;
                    await dispatchPointer(page, 'pointermove', ax + (bx - ax) * t, ay + (by - ay) * t);
                }
                await dispatchPointer(page, 'pointerup', bx, by);
                await new Promise(r => setTimeout(r, 200));
                const after = await page.evaluate(() => ({
                    overlayCount: document.querySelectorAll('.drag-overlay').length,
                    draggingSourceCount: document.querySelectorAll('.dragging-source').length
                }));
                console.log('post-drop:', after);
                if (after.overlayCount > 0) allFails.push({ vp: vp.name, issues: ['drag overlay not cleaned up after drop'] });
                if (after.draggingSourceCount > 0) allFails.push({ vp: vp.name, issues: ['dragging-source class lingered after drop'] });
                await snap(page, `${vp.name}-post-drop`);
            }
        }

        if (errors.length) console.log('page errors:', errors);
        await page.close();
    }

    await browser.close();
    if (allFails.length) {
        console.log('\n=== FAILS ===');
        allFails.forEach(f => console.log(f.vp + ':', f.issues));
        process.exit(1);
    } else {
        console.log('\nALL PASS');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
