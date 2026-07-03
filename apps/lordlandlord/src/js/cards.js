import { shuffleInPlace } from './core/deck.js';

export const CARD_TYPES = {
    MONEY: "MONEY",
    PROPERTY: "PROPERTY",
    ACTION: "ACTION",
    RENT: "RENT",
    BUILDING: "BUILDING",
    JOKER: "JOKER"
};

export const PROPERTIES = {
    BROWN: { name: "Brown", hex: "#8B4513", count: 2, rent: [1, 2], value: 1 },
    LIGHTBLUE: { name: "Light Blue", hex: "#ADD8E6", count: 3, rent: [1, 2, 3], value: 1 },
    PINK: { name: "Pink", hex: "#FF1493", count: 3, rent: [1, 2, 4], value: 2 },
    ORANGE: { name: "Orange", hex: "#FF8C00", count: 3, rent: [1, 3, 5], value: 2 },
    RED: { name: "Red", hex: "#DC143C", count: 3, rent: [2, 3, 6], value: 3 },
    YELLOW: { name: "Yellow", hex: "#FFD700", count: 3, rent: [2, 4, 6], value: 3 },
    GREEN: { name: "Green", hex: "#228B22", count: 3, rent: [2, 4, 7], value: 4 },
    DARKBLUE: { name: "Dark Blue", hex: "#00008B", count: 2, rent: [3, 8], value: 4 },
    UTILITY: { name: "Utility", hex: "#E8E4DC", count: 2, rent: [1, 2], textColor: "#000", value: 2 },
    RAILROAD: { name: "Railroad", hex: "#000000", count: 4, rent: [1, 2, 3, 4], value: 2 }
};

// Per Hasbro rulebook: "To play with 6 or more players, shuffle two packs
// together and play as normal." Caller decides how many packs to deal in.
//
// Pass a seeded rng (core/rng.js) to get a reproducible shuffle. Callers that
// don't care about order (some tests) may omit it and get an unseeded shuffle.
export function generateDeck(packs = 1, rng = null) {
    if (packs < 1) packs = 1;
    const deck = [];
    let idCounter = 1;
    const addCards = (template, count) => {
        for (let i = 0; i < count; i++) deck.push({ ...template, id: `c_${idCounter++}` });
    };
    const buildOnePack = () => {

    // --- MONEY (GOLD) ---
    addCards({ type: CARD_TYPES.MONEY, name: "1 Gold", value: 1, color: "#d4af37" }, 6);
    addCards({ type: CARD_TYPES.MONEY, name: "2 Gold", value: 2, color: "#d4af37" }, 5);
    addCards({ type: CARD_TYPES.MONEY, name: "3 Gold", value: 3, color: "#d4af37" }, 3);
    addCards({ type: CARD_TYPES.MONEY, name: "4 Gold", value: 4, color: "#d4af37" }, 3);
    addCards({ type: CARD_TYPES.MONEY, name: "5 Gold", value: 5, color: "#d4af37" }, 2);
    addCards({ type: CARD_TYPES.MONEY, name: "10 Gold", value: 10, color: "#d4af37" }, 1);

    // --- PROPERTIES ---
    Object.keys(PROPERTIES).forEach(colorKey => {
        const p = PROPERTIES[colorKey];
        addCards({ 
            type: CARD_TYPES.PROPERTY, 
            name: p.name, 
            colorKey, 
            value: p.value, 
            hex: p.hex, 
            textColor: p.textColor || "#fff" 
        }, p.count);
    });

    // --- WILD CARDS ---
    const wilds = [
        { colors: ['DARKBLUE', 'GREEN'], value: 4 },
        { colors: ['LIGHTBLUE', 'BROWN'], value: 1 },
        { colors: ['PINK', 'ORANGE'], value: 2 },
        { colors: ['PINK', 'ORANGE'], value: 2 },
        { colors: ['RED', 'YELLOW'], value: 3 },
        { colors: ['RED', 'YELLOW'], value: 3 },
        { colors: ['GREEN', 'RAILROAD'], value: 4 },
        { colors: ['LIGHTBLUE', 'RAILROAD'], value: 4 },
        { colors: ['UTILITY', 'RAILROAD'], value: 2 },
    ];
    wilds.forEach(w => addCards({ type: CARD_TYPES.JOKER, name: "WILD", allowedColors: w.colors, value: w.value, hex: "#a855f7" }, 1));
    addCards({ type: CARD_TYPES.JOKER, name: "RAINBOW WILD", allowedColors: Object.keys(PROPERTIES), value: 0, hex: "#a855f7", isRainbow: true }, 2);

    // --- RENT CARDS ---
    const rents = [
        { colors: ['DARKBLUE', 'GREEN'], count: 2 },
        { colors: ['BROWN', 'LIGHTBLUE'], count: 2 },
        { colors: ['PINK', 'ORANGE'], count: 2 },
        { colors: ['RED', 'YELLOW'], count: 2 },
        { colors: ['RAILROAD', 'UTILITY'], count: 2 },
    ];
    rents.forEach(r => addCards({ type: CARD_TYPES.RENT, name: "COLLECT TRIBUTE", allowedColors: r.colors, value: 1, hex: "#4a6741" }, r.count));
    addCards({ type: CARD_TYPES.RENT, name: "GREAT TRIBUTE", allowedColors: Object.keys(PROPERTIES), value: 3, hex: "#4a6741", isMulti: true }, 3);

    // --- ROYAL DECREES ---
    addCards({ type: CARD_TYPES.ACTION, name: "ROYAL CHARTER", effect: "pass_go", value: 1, hex: "#4a6741" }, 10);
    addCards({ type: CARD_TYPES.ACTION, name: "KINGDOM BREAKER", effect: "deal_breaker", value: 5, hex: "#5a3a7a" }, 2);
    addCards({ type: CARD_TYPES.ACTION, name: "SLY STEAL", effect: "sly_deal", value: 3, hex: "#8b6914" }, 3);
    addCards({ type: CARD_TYPES.ACTION, name: "FORCED TRADE", effect: "forced_deal", value: 3, hex: "#2a4a7f" }, 3);
    addCards({ type: CARD_TYPES.ACTION, name: "NOT TODAY!", effect: "just_say_no", value: 4, hex: "#1a1a1a" }, 3);
    addCards({ type: CARD_TYPES.ACTION, name: "TAX COLLECTOR", effect: "debt_collector", value: 3, hex: "#8b2020" }, 3);
    addCards({ type: CARD_TYPES.ACTION, name: "FEAST DAY", effect: "birthday", value: 2, hex: "#7a4060" }, 3);
    addCards({ type: CARD_TYPES.ACTION, name: "DOUBLE TRIBUTE", effect: "double_rent", value: 1, hex: "#2d5a27" }, 2);
    
    // --- STRONGHOLDS ---
    addCards({ type: CARD_TYPES.BUILDING, name: "THE KEEP", effect: "house", value: 3, hex: "#15803d" }, 3);
    addCards({ type: CARD_TYPES.BUILDING, name: "THE CASTLE", effect: "hotel", value: 4, hex: "#b91c1c" }, 2);
    };

    for (let p = 0; p < packs; p++) buildOnePack();

    // Shuffle (Fisher–Yates, now in core/deck.js). A seeded rng makes the
    // order reproducible; without one we fall back to an unseeded shuffle.
    if (rng) {
        shuffleInPlace(deck, rng);
    } else {
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
    }
    return deck;
}
