import { PROPERTIES, CARD_TYPES } from './cards.js';

// Maps Lord Landlord card names to their Monopoly Deal equivalents
// and provides short rule descriptions.
export const CARD_LIBRARY = {
    'ROYAL CHARTER':   { md: 'Pass Go',          desc: 'Draw 2 extra cards.' },
    'KINGDOM BREAKER': { md: 'Deal Breaker',     desc: 'Steal a complete property set from any opponent.' },
    'SLY STEAL':       { md: 'Sly Deal',         desc: 'Steal one property from an opponent (cannot be from a complete set).' },
    'FORCED TRADE':    { md: 'Forced Deal',      desc: 'Swap any one property with an opponent.' },
    'NOT TODAY!':      { md: 'Just Say No',      desc: 'Cancel an action played against you.' },
    'TAX COLLECTOR':   { md: 'Debt Collector',   desc: 'Force one opponent to pay you 5g.' },
    'FEAST DAY':       { md: "It's My Birthday", desc: 'Every opponent pays you 2g.' },
    'DOUBLE TRIBUTE':  { md: 'Double The Rent',  desc: 'Doubles the next rent you collect this turn (uses 2 actions).' },
    'THE KEEP':        { md: 'House',            desc: 'Adds 3g to rent on a completed color set.' },
    'THE CASTLE':      { md: 'Hotel',            desc: 'Adds 4g to rent on a completed set that already has a Keep.' },
    'COLLECT TRIBUTE': { md: 'Rent',             desc: 'Collect rent from one opponent for one of the colors shown.' },
    'GREAT TRIBUTE':   { md: 'Multi-Color Rent', desc: 'Collect rent from EVERY opponent for any color you choose.' },
    'WILD':            { md: 'Wild Property',    desc: 'A property that can stand in for any of the colors shown.' },
    'RAINBOW WILD':    { md: 'Rainbow Wild',     desc: 'Any color. No value on its own.' },
};

export function infoForCard(card) {
    const d = (card && card.data) || {};
    const generic = { name: d.name || '?', md: '', desc: '', value: d.value };

    if (d.type === CARD_TYPES.PROPERTY) {
        const def = PROPERTIES[d.colorKey] || {};
        return {
            ...generic,
            md: `${def.name || d.colorKey} Property`,
            desc: `${def.count || '?'} of this color completes a set.`,
        };
    }
    if (d.type === CARD_TYPES.MONEY) {
        return { ...generic, md: 'Money', desc: `Bank for ${d.value}g of value.` };
    }
    if (d.type === CARD_TYPES.JOKER || d.type === CARD_TYPES.RENT || d.type === CARD_TYPES.ACTION || d.type === CARD_TYPES.BUILDING) {
        const lib = CARD_LIBRARY[d.name] || {};
        return { ...generic, md: lib.md || '', desc: lib.desc || '' };
    }
    return generic;
}
