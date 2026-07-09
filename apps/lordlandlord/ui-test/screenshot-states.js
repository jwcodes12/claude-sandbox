// Capture screenshots of different board states on mobile viewports to
// verify the rent-ladder rendering across hand cards and color stacks.
const puppeteer = require('puppeteer');
const path = require('path');

const VP = { width: 390, height: 844, deviceScaleFactor: 2 }; // iPhone 14

const HEX = {
    BROWN:'#8B4513', LIGHTBLUE:'#ADD8E6', PINK:'#FF1493', ORANGE:'#FF8C00',
    RED:'#DC143C', YELLOW:'#FFD700', GREEN:'#228B22', DARKBLUE:'#00008B',
    UTILITY:'#E8E4DC', RAILROAD:'#000000'
};

async function snap(page, label) {
    const out = path.join(__dirname, `state-${label}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log('saved', out);
}

async function snapFull(page, label) {
    // The .game-scroll container holds the scrollable middle section.
    // For "full-page" we need to capture the scroll contents, not the viewport.
    await page.evaluate(() => {
        const root = document.getElementById('game-root');
        if (root) {
            root.style.height = 'auto';
            root.style.overflow = 'visible';
        }
        const scroll = document.querySelector('.game-scroll');
        if (scroll) {
            scroll.style.overflowY = 'visible';
            scroll.style.height = 'auto';
        }
    });
    await new Promise(r => setTimeout(r, 150));
    const out = path.join(__dirname, `state-${label}-full.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log('saved', out);
}

async function bootGame(page) {
    await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });
    await page.click('#btn-solo-game');
    await page.waitForSelector('#game-container:not(.hidden)');
    await new Promise(r => setTimeout(r, 250));
}

async function setState(page, recipe) {
    await page.evaluate((HEX, recipe) => {
        const s = window.__game.state();
        // Wipe everyone's hand/board so we start fresh.
        s.players.forEach(p => { p.hand = []; p.bank = []; p.properties = {}; p.buildings = {}; });

        function mkCard(opts) {
            return {
                data: {
                    id: `inj-${Math.random().toString(36).slice(2,8)}`,
                    type: opts.type,
                    name: opts.name || '',
                    value: opts.value ?? 1,
                    hex: opts.hex || '#888',
                    colorKey: opts.colorKey,
                    allowedColors: opts.allowedColors,
                    isRainbow: opts.isRainbow,
                    effect: opts.effect,
                },
                zone: opts.zone || 'hand',
                owner: opts.owner ?? 0,
                currentColor: opts.currentColor,
            };
        }

        const PROP = (color, name) => ({ type:'PROPERTY', colorKey: color, name: name || color, hex: HEX[color], value: 2 });
        const WILD = (cols, val=2) => ({ type:'JOKER', name:'WILD', allowedColors: cols, value: val, hex:'#a855f7' });
        const RAINBOW = () => ({ type:'JOKER', name:'RAINBOW WILD', allowedColors: Object.keys(HEX), value:0, hex:'#a855f7', isRainbow: true });
        const MONEY = (v) => ({ type:'MONEY', name:`${v} Gold`, value: v, hex:'#d4af37' });
        const ACTION = (name, effect, v=3) => ({ type:'ACTION', name, effect, value: v, hex:'#5a3a7a' });
        const RENT = (cols, name='COLLECT TRIBUTE') => ({ type:'RENT', name, allowedColors: cols, value:1, hex:'#4a6741' });
        const BLDG = (effect) => ({ type:'BUILDING', name: effect==='hotel'?'THE CASTLE':'THE KEEP', effect, value: effect==='hotel'?4:3, hex: effect==='hotel'?'#b91c1c':'#15803d' });

        // recipe.you: { hand: [...], board: { COLOR: { count, withWild, building } }, bank: [...] }
        const you = s.players[0];
        if (recipe.you) {
            recipe.you.hand?.forEach(opts => {
                you.hand.push(mkCard({ ...opts, zone:'hand', owner: 0 }));
            });
            for (const [color, cfg] of Object.entries(recipe.you.board || {})) {
                you.properties[color] = [];
                for (let i = 0; i < (cfg.count || 0); i++) {
                    const c = mkCard({ ...PROP(color, `${color}_${i}`), zone:'board', owner: 0, currentColor: color });
                    you.properties[color].push(c);
                }
                if (cfg.wild) {
                    const w = mkCard({ ...WILD(cfg.wild.colors, cfg.wild.value), zone:'board', owner: 0, currentColor: color });
                    you.properties[color].push(w);
                }
                if (cfg.rainbow) {
                    const w = mkCard({ ...RAINBOW(), zone:'board', owner: 0, currentColor: color });
                    you.properties[color].push(w);
                }
                if (cfg.building) {
                    you.buildings[color] = you.buildings[color] || [];
                    you.buildings[color].push(mkCard({ ...BLDG(cfg.building), zone:'board', owner: 0 }));
                    if (cfg.hotel) {
                        you.buildings[color].push(mkCard({ ...BLDG('hotel'), zone:'board', owner: 0 }));
                    }
                }
            }
            recipe.you.bank?.forEach(v => you.bank.push(mkCard({ ...MONEY(v), zone:'bank', owner: 0 })));
        }

        // opponents: similar but simpler
        for (let i = 1; i < s.players.length && recipe.opps && i-1 < recipe.opps.length; i++) {
            const cfg = recipe.opps[i-1];
            const opp = s.players[i];
            for (const [color, c] of Object.entries(cfg.board || {})) {
                opp.properties[color] = [];
                for (let k = 0; k < (c.count || 0); k++) {
                    opp.properties[color].push(mkCard({ ...PROP(color), zone:'board', owner: i, currentColor: color }));
                }
                if (c.building) {
                    opp.buildings[color] = opp.buildings[color] || [];
                    opp.buildings[color].push(mkCard({ ...BLDG(c.building), zone:'board', owner: i }));
                }
            }
            for (let h = 0; h < (cfg.handCount || 0); h++) {
                opp.hand.push(mkCard({ type:'MONEY', value:1, name:'X' }));
            }
            for (const v of (cfg.bank || [])) {
                opp.bank.push(mkCard({ ...MONEY(v), zone:'bank', owner: i }));
            }
        }
        window.__game.update();
    }, HEX, recipe);
    await new Promise(r => setTimeout(r, 250));
}

async function main() {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport(VP);

    // STATE 1: Early game — small hand, no board yet
    await bootGame(page);
    await setState(page, {
        you: {
            hand: [
                { type:'PROPERTY', colorKey:'BROWN', name:'Brown', hex: HEX.BROWN, value:1 },
                { type:'PROPERTY', colorKey:'PINK', name:'Pink', hex: HEX.PINK, value:2 },
                { type:'PROPERTY', colorKey:'GREEN', name:'Green', hex: HEX.GREEN, value:4 },
                { type:'MONEY', name:'3 Gold', value:3, hex:'#d4af37' },
                { type:'ACTION', name:'SLY STEAL', effect:'sly_deal', value:3, hex:'#8b6914' },
            ],
            board: {},
            bank: [1, 2],
        },
        opps: [{ handCount: 4 }, { handCount: 5 }],
    });
    await snapFull(page, '1-early-empty-board');

    // STATE 2: Mid game — you have partial sets in several colors with rent ladders showing
    await setState(page, {
        you: {
            hand: [
                { type:'PROPERTY', colorKey:'PINK', name:'Pink', hex: HEX.PINK, value:2 },
                { type:'PROPERTY', colorKey:'RAILROAD', name:'Railroad', hex: HEX.RAILROAD, value:2 },
                { type:'JOKER', name:'WILD', allowedColors:['PINK','ORANGE'], value:2, hex:'#a855f7' },
                { type:'JOKER', name:'RAINBOW WILD', allowedColors: Object.keys(HEX), value:0, hex:'#a855f7', isRainbow:true },
                { type:'RENT', name:'COLLECT TRIBUTE', allowedColors:['PINK','ORANGE'], value:1, hex:'#4a6741' },
            ],
            board: {
                BROWN: { count: 1 },
                PINK: { count: 2 }, // 2/3
                GREEN: { count: 1, wild: { colors:['GREEN','DARKBLUE'], value:4 } }, // GREEN 1 real + 1 wild
                RAILROAD: { count: 2 }, // 2/4
            },
            bank: [1, 1, 3],
        },
        opps: [
            { handCount: 3, board: { ORANGE: { count: 2 } }, bank: [2] },
            { handCount: 5, board: { YELLOW: { count: 1 }, DARKBLUE: { count: 1 } }, bank: [5] },
        ],
    });
    await snapFull(page, '2-midgame-mixed-stacks');

    // STATE 3: Complete sets with house/hotel + opponents with stuff
    await setState(page, {
        you: {
            hand: [
                { type:'ACTION', name:'KINGDOM BREAKER', effect:'deal_breaker', value:5, hex:'#5a3a7a' },
                { type:'BUILDING', name:'THE KEEP', effect:'house', value:3, hex:'#15803d' },
                { type:'BUILDING', name:'THE CASTLE', effect:'hotel', value:4, hex:'#b91c1c' },
                { type:'RENT', name:'GREAT TRIBUTE', allowedColors: Object.keys(HEX), value:3, hex:'#4a6741', isMulti:true },
            ],
            board: {
                BROWN: { count: 2, building: 'house' },
                YELLOW: { count: 3, building: 'house', hotel: true },
                GREEN: { count: 2 }, // 2/3 partial
            },
            bank: [5, 2, 1],
        },
        opps: [
            { handCount: 6, board: { RED: { count: 3 }, RAILROAD: { count: 3 } }, bank: [3, 1] },
            { handCount: 2, board: { DARKBLUE: { count: 2, building: 'house' } }, bank: [10] },
        ],
    });
    await snapFull(page, '3-buildings-and-completes');

    // STATE 4: Late game — full hand with rainbow wild and many properties on board
    await setState(page, {
        you: {
            hand: [
                { type:'PROPERTY', colorKey:'DARKBLUE', name:'Dark Blue', hex: HEX.DARKBLUE, value:4 },
                { type:'PROPERTY', colorKey:'UTILITY', name:'Utility', hex: HEX.UTILITY, value:2 },
                { type:'JOKER', name:'WILD', allowedColors:['UTILITY','RAILROAD'], value:2, hex:'#a855f7' },
                { type:'JOKER', name:'WILD', allowedColors:['RED','YELLOW'], value:3, hex:'#a855f7' },
                { type:'ACTION', name:'FEAST DAY', effect:'birthday', value:2, hex:'#7a4060' },
                { type:'ACTION', name:'TAX COLLECTOR', effect:'debt_collector', value:3, hex:'#8b2020' },
                { type:'ACTION', name:'ROYAL CHARTER', effect:'pass_go', value:1, hex:'#4a6741' },
                { type:'ACTION', name:'NOT TODAY!', effect:'just_say_no', value:4, hex:'#1a1a1a' },
            ],
            board: {
                BROWN: { count: 1 },
                PINK: { count: 1, rainbow: true },
                ORANGE: { count: 3 },
                GREEN: { count: 2 },
                RAILROAD: { count: 3 },
            },
            bank: [1, 1, 2, 3, 5],
        },
        opps: [
            { handCount: 7, board: { LIGHTBLUE: { count: 3, building: 'house' }, PINK: { count: 1 } }, bank: [2, 4] },
            { handCount: 4, board: { UTILITY: { count: 2 } }, bank: [] },
        ],
    });
    await snapFull(page, '4-late-full-hand');

    await browser.close();
    console.log('done');
}

main().catch(e => { console.error(e); process.exit(1); });
