import { PROPERTIES, CARD_TYPES } from './cards.js';

function nameToSlug(name) {
    return (name || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function artSlug(card) {
    const d = card.data || {};
    if (d.type === CARD_TYPES.PROPERTY) return d.colorKey;
    if (d.type === CARD_TYPES.MONEY) return 'MONEY';
    if (d.type === CARD_TYPES.JOKER) return 'WILD';
    if (d.type === CARD_TYPES.RENT) return 'TRIBUTE';
    if (d.type === CARD_TYPES.BUILDING || d.type === CARD_TYPES.ACTION) return nameToSlug(d.name);
    return null;
}

function attachArt(cardEl, card) {
    const slug = artSlug(card);
    if (!slug) return;
    const img = document.createElement('img');
    img.className = 'card-art';
    img.src = `img/cards/${slug}.png`;
    img.alt = (card.data && card.data.name) || '';
    img.draggable = false;
    cardEl.appendChild(img);
}

/**
 * Add a color-swatch strip to RENT and WILD cards so the player can see
 * which property colors the card applies to. GREAT TRIBUTE / RAINBOW WILD
 * (isMulti / isRainbow) renders a single rainbow bar instead.
 */
function attachColorStripes(cardEl, card) {
    const d = card.data || {};
    if (d.type !== CARD_TYPES.RENT && d.type !== CARD_TYPES.JOKER) return;
    const colors = d.allowedColors;
    if (!colors || !colors.length) return;

    const strip = document.createElement('div');
    strip.className = 'color-stripes';
    if (d.isMulti || d.isRainbow || colors.length >= 8) {
        strip.classList.add('rainbow');
    } else {
        for (const colorKey of colors) {
            const sw = document.createElement('span');
            sw.className = 'color-swatch';
            const hex = (PROPERTIES[colorKey] && PROPERTIES[colorKey].hex) || '#888';
            sw.style.background = hex;
            sw.title = (PROPERTIES[colorKey] && PROPERTIES[colorKey].name) || colorKey;
            strip.appendChild(sw);
        }
    }
    cardEl.appendChild(strip);
}

export function render(root, state) {
    root.innerHTML = '';
    const scroll = el('div', 'game-scroll');
    scroll.appendChild(renderTopBar(state));
    scroll.appendChild(renderTurnIndicator(state));
    scroll.appendChild(renderOpponents(state));
    scroll.appendChild(renderZoneStrip(state));
    scroll.appendChild(renderYourArea(state));
    root.appendChild(scroll);
    // End Turn lives outside the scroll container so it's always visible
    // above the hand, regardless of how tall the kingdom area gets.
    root.appendChild(renderBottomActions(state));
    root.appendChild(renderYourHand(state));
    root.appendChild(renderActionLog(state));

    ensureBannerSplit();
    syncGameOverModal(state);
}

function renderActionLog(state) {
    const panel = el('aside', 'action-log');
    if (state._logOpen) panel.classList.add('open');
    const header = el('div', 'action-log-header');
    header.appendChild(el('span', 'action-log-title', 'Chronicle'));
    const closeBtn = el('button', 'action-log-close', '✕');
    closeBtn.dataset.action = 'toggle-log';
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = el('div', 'action-log-body');
    const entries = (state.actionLog || []).slice().reverse();
    if (entries.length === 0) {
        body.appendChild(el('div', 'action-log-empty', 'No deeds yet.'));
    } else {
        entries.forEach(entry => {
            const row = el('div', 'action-log-row');
            const text = el('span', 'action-log-text', entry.text);
            row.appendChild(text);
            body.appendChild(row);
        });
    }
    panel.appendChild(body);
    return panel;
}

function playerLabel(p, isPossessive = false) {
    if (!p) return '';
    const me = window.__game?.state()?.localPlayerId;
    const isYou = (p.id === me);
    
    if (isYou) return isPossessive ? 'your' : 'you';
    
    const name = p.name || `Lord ${p.id}`;
    const hasTitle = ['Lord', 'Lady', 'Sir', 'Baron', 'Duchess', 'Countess'].some(t => name.includes(t));
    const finalName = hasTitle ? name : `Lord ${name}`;
    
    return isPossessive ? `${finalName}'s` : finalName;
}

function computeWinnerId(state) {
    // Trust ONLY the engine's verdict. checkWinnerS is turn-gated by design
    // (you win Monopoly Deal on your own turn), so a renderer-side "3 sets =
    // winner" fallback declared off-turn winners the game hadn't — freezing a
    // live game behind a false game-over overlay.
    if (state.winner != null) return state.winner;
    if (state.winnerId != null) return state.winnerId;
    return null;
}

function renderTurnIndicator(state) {
    const wrap = el('div', 'turn-indicator');
    wrap.dataset.field = 'turn-indicator';
    const current = state.players[state.turn];
    const isYou = state.turn === state.localPlayerId;

    if (state.mustDiscard > 0) {
        wrap.classList.add('must-discard');
        const n = state.mustDiscard;
        const cardWord = n === 1 ? 'card' : 'cards';
        if (isYou) {
            wrap.appendChild(el('span', 'turn-indicator-label discard-urgency', `Discard ${n} ${cardWord} to continue`));
            wrap.appendChild(el('span', 'turn-actions-count', 'drag cards to the discard pile'));
        } else {
            const name = playerLabel(current, false);
            wrap.appendChild(el('span', 'turn-indicator-label', `Waiting for ${name}…`));
            wrap.appendChild(el('span', 'turn-actions-count', `must discard ${n} ${cardWord}`));
        }
        return wrap;
    }

    const displayLabel = isYou ? 'Your Turn' : `${playerLabel(current, true)} Turn`;
    const label = el('span', 'turn-indicator-label', displayLabel);
    wrap.appendChild(label);

    const pips = el('span', 'turn-pips');
    pips.dataset.field = 'turn-pips';
    const left = Math.max(0, Math.min(3, state.actionsLeft | 0));
    const used = 3 - left;
    for (let i = 0; i < 3; i++) {
        const pip = el('span', i < used ? 'pip used' : 'pip');
        pips.appendChild(pip);
    }
    wrap.appendChild(pips);

    const count = el('span', 'turn-actions-count', `${left}/3 actions left`);
    wrap.appendChild(count);

    if (state.doubleRentArmed) {
        const armed = el('span', 'double-rent-armed', '⚡ DOUBLE TRIBUTE armed');
        wrap.appendChild(armed);
    }

    return wrap;
}

function ensureBannerSplit() {
    const banner = document.getElementById('turn-banner');
    if (!banner || banner.dataset.splitApplied === '1') return;
    banner.dataset.splitApplied = '1';

    let hint = document.getElementById('hint-banner');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'hint-banner';
        hint.style.opacity = 0;
        banner.parentNode.insertBefore(hint, banner.nextSibling);
    }

    // flashHint and showBanner now write directly to their respective elements,
    // so the observer only sets the ceremonial as-banner class when the
    // turn-banner has content (no text-moving — that caused stale hints).
    const classify = () => {
        const text = (banner.textContent || '').trim();
        if (!text) {
            banner.classList.remove('as-banner');
            return;
        }
        banner.classList.add('as-banner');
    };
    const obs = new MutationObserver(classify);
    obs.observe(banner, { childList: true, characterData: true, subtree: true });
    classify();
}

function syncGameOverModal(state) {
    const winnerId = computeWinnerId(state);
    const existing = document.getElementById('game-over-modal');
    if (winnerId == null) {
        if (existing) existing.remove();
        return;
    }
    if (existing && existing.dataset.winnerId === String(winnerId)) return;
    if (existing) existing.remove();

    const winner = state.players[winnerId];
    const overlay = document.createElement('div');
    overlay.id = 'game-over-modal';
    overlay.className = 'game-over-modal';
    overlay.dataset.winnerId = String(winnerId);

    const content = el('div', 'game-over-content');
    const crown = el('div', 'game-over-crown', '👑');
    const title = el('h1', 'game-over-title',
        winnerId === state.localPlayerId ? 'The Crown Is Yours!' : 'A New Sovereign Reigns');
    const sub = el('p', 'game-over-sub', `${playerLabel(winner)} has claimed three realms.`);

    const setsWrap = el('div', 'game-over-sets');
    const setsHeader = el('h3', 'game-over-sets-header', 'Completed Realms');
    setsWrap.appendChild(setsHeader);

    const setRow = el('div', 'game-over-sets-row');
    const winnerProps = (winner && winner.properties) || {};
    const completed = [];
    for (const colorKey of Object.keys(winnerProps)) {
        const def = PROPERTIES[colorKey];
        if (!def) continue;
        const cards = winnerProps[colorKey] || [];
        if (cards.length >= def.count) {
            completed.push({ colorKey, def, cards: cards.slice(0, def.count) });
        }
    }
    completed.slice(0, 3).forEach(({ colorKey, def, cards }) => {
        const stack = renderColorStack(colorKey, cards);
        stack.classList.add('large');
        const tile = el('div', 'game-over-set');
        const name = el('div', 'game-over-set-name', def.name || colorKey);
        tile.append(stack, name);
        setRow.appendChild(tile);
    });
    setsWrap.appendChild(setRow);

    const again = el('button', 'game-over-again', 'Play Again');
    again.type = 'button';
    again.addEventListener('click', () => window.location.reload());

    content.append(crown, title, sub, setsWrap, again);
    overlay.appendChild(content);
    document.body.appendChild(overlay);
}

function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
}

function bankTotal(player) {
    return player.bank.reduce((s, c) => s + (c.data.value || 0), 0);
}

function completedSets(player) {
    let n = 0;
    for (const colorKey of Object.keys(player.properties || {})) {
        const def = PROPERTIES[colorKey];
        if (!def) continue;
        if (player.properties[colorKey].length >= def.count) n++;
    }
    return n;
}

function renderTopBar(state) {
    const bar = el('header', 'top-bar');
    const local = state.players[state.localPlayerId];

    const gold = el('span', 'top-stat', `${bankTotal(local)}g`);
    gold.dataset.field = 'your-gold';

    const kingdom = el('span', 'top-stat', `${completedSets(local)}/3`);
    kingdom.dataset.field = 'kingdom';

    const actions = el('span', 'top-stat top-actions', `Actions: ${state.actionsLeft}`);
    actions.dataset.field = 'actions';

    const logBtn = el('button', 'btn-log', 'Log');
    logBtn.dataset.action = 'toggle-log';
    logBtn.title = 'Chronicle of recent deeds';
    logBtn.setAttribute('aria-label', 'Open Chronicle');

    const menuBtn = el('button', 'btn-menu', '☰');
    menuBtn.dataset.action = 'menu';

    bar.append(gold, kingdom, actions, logBtn, menuBtn);
    return bar;
}

function renderBottomActions(state) {
    const bar = el('div', 'bottom-actions');
    const endTurnBtn = el('button', 'btn-end-turn', 'End Turn');
    endTurnBtn.dataset.action = 'end-turn';
    endTurnBtn.disabled =
        state.turn !== state.localPlayerId ||
        state.mustDiscard > 0 ||
        state.reactionTargetId !== null;
    bar.appendChild(endTurnBtn);
    return bar;
}

function renderOpponents(state) {
    const container = el('section', 'opponents');
    state.players.forEach(p => {
        if (p.id === state.localPlayerId) return;
        container.appendChild(renderOpponent(p));
    });
    return container;
}

function renderOpponent(p) {
    const oppEl = el('div', 'opponent');
    oppEl.dataset.playerId = String(p.id);

    const header = el('div', 'opp-header');
    const name = el('span', 'opp-name', p.name || `Lord ${p.id}`);
    const gold = el('span', 'opp-stat');
    gold.dataset.field = 'opp-gold';
    gold.textContent = `${bankTotal(p)}g`;
    const sets = el('span', 'opp-stat');
    sets.dataset.field = 'opp-sets';
    sets.textContent = `${completedSets(p)}/3`;
    const hand = el('span', 'opp-stat');
    hand.dataset.field = 'opp-hand';
    hand.textContent = `H:${p.hand.length}`;
    header.append(name, gold, sets, hand);
    oppEl.appendChild(header);

    const colorKeys = Object.keys(p.properties || {}).filter(k => (p.properties[k] || []).length > 0);
    if (colorKeys.length > 0) {
        const kingdom = el('div', 'opp-kingdom');
        for (const colorKey of colorKeys) {
            const cards = p.properties[colorKey] || [];
            const setSize = (PROPERTIES[colorKey] && PROPERTIES[colorKey].count) || 3;
            const buildings = (p.buildings && p.buildings[colorKey]) || [];
            const isComplete = cards.length >= setSize;
            for (let i = 0; i < cards.length; i += setSize) {
                const slice = cards.slice(i, i + setSize);
                // Only attach buildings to the first complete-set slice.
                const stackBuildings = (i === 0 && isComplete) ? buildings : [];
                kingdom.appendChild(renderColorStack(colorKey, slice, stackBuildings));
            }
        }
        oppEl.appendChild(kingdom);
    }
    return oppEl;
}

function renderRentLadder(colorKey, currentCount) {
    const def = PROPERTIES[colorKey];
    if (!def || !def.rent || !def.rent.length) return null;
    const ladder = el('div', 'rent-ladder');
    // Compact form: rent values separated by slashes, e.g. "1/2/4" for Pink.
    // Position (slot N) is implicit by index. The active slot — based on the
    // current card count — is highlighted in gold.
    const lastIdx = def.rent.length - 1;
    def.rent.forEach((r, i) => {
        const need = i + 1;
        const active = currentCount === need;
        // Tier styling escalates from low (first) to high (full set) so the
        // payoff of completing the set reads at a glance.
        let tier;
        if (i === lastIdx) tier = 'rent-step-tier-3';
        else if (i === 0 && lastIdx > 0) tier = 'rent-step-tier-1';
        else tier = 'rent-step-tier-2';
        const fullCls = need === def.count ? ' rent-step-full' : '';
        const cls = `rent-step ${tier}${active ? ' rent-step-active' : ''}${fullCls}`;
        const step = el('span', cls, String(r));
        ladder.appendChild(step);
        if (i < def.rent.length - 1) {
            ladder.appendChild(el('span', 'rent-sep', '/'));
        }
    });
    return ladder;
}

function renderColorStack(colorKey, cards, buildings = []) {
    const stack = el('div', 'color-stack');
    stack.dataset.colorKey = colorKey;
    const hex = (PROPERTIES[colorKey] && PROPERTIES[colorKey].hex) || '#888';
    stack.style.setProperty('--stack-color', hex);
    const ladder = renderRentLadder(colorKey, cards.length);
    if (ladder) stack.appendChild(ladder);
    cards.forEach(c => {
        const cardEl = el('div', 'card mini');
        cardEl.dataset.cardId = c.data && c.data.id;
        cardEl.style.setProperty('--card-color', hex);
        attachArt(cardEl, c);
        if (c.data && c.data.value != null) {
            const v = el('div', 'card-value mini', `${c.data.value}g`);
            cardEl.appendChild(v);
        }
        stack.appendChild(cardEl);
    });
    if (buildings && buildings.length) {
        const ring = el('div', 'building-ring');
        buildings.forEach(b => {
            const glyph = b.data && b.data.effect === 'hotel' ? '🏰' : '🏠';
            const tag = b.data && b.data.effect === 'hotel' ? '+4g' : '+3g';
            const chip = el('span', `building-chip ${b.data.effect}`, `${glyph} ${tag}`);
            chip.dataset.cardId = b.data && b.data.id;
            ring.appendChild(chip);
        });
        stack.appendChild(ring);
    }
    return stack;
}

function renderZoneStrip(state) {
    const strip = el('section', 'zone-strip');

    const deck = el('div', 'zone-deck');
    const deckCard = el('div', 'card deck-card');
    const count = el('span', 'badge-count');
    count.dataset.field = 'deck-count';
    count.textContent = String(state.deck.length);
    deck.append(deckCard, count);
    strip.appendChild(deck);

    const discard = el('div', 'zone-discard');
    discard.dataset.dropTarget = 'discard';
    if (state.mustDiscard > 0 && state.turn === state.localPlayerId) {
        discard.classList.add('discard-active');
    }
    // Show the top up to 6 cards stacked with a small offset so the pile
    // visibly grows as actions resolve.
    const visible = state.discard.slice(-6);
    if (visible.length === 0) {
        discard.appendChild(el('span', 'slot-label', 'DISCARD'));
    }
    visible.forEach((c, i) => {
        const cardEl = el('div', 'card discard-card');
        cardEl.dataset.cardId = c.data.id;
        cardEl.style.setProperty('--card-color', c.data.hex || c.data.color || '#444');
        cardEl.style.setProperty('--stack-idx', String(i));
        attachArt(cardEl, c);
        attachColorStripes(cardEl, c);
        cardEl.appendChild(el('div', 'card-name', c.data.name || ''));
        discard.appendChild(cardEl);
    });
    if (state.discard.length > visible.length) {
        const more = el('span', 'discard-more', `+${state.discard.length - visible.length}`);
        discard.appendChild(more);
    }
    const dcount = el('span', 'badge-count');
    dcount.dataset.field = 'discard-count';
    dcount.textContent = String(state.discard.length);
    discard.appendChild(dcount);
    strip.appendChild(discard);

    return strip;
}

function renderYourArea(state) {
    const wrap = el('section', 'your-area');
    const local = state.players[state.localPlayerId];

    const bank = el('div', 'your-bank');
    bank.dataset.dropTarget = `bank:${state.localPlayerId}`;
    const bankLabel = el('span', 'bank-label', 'Treasury');
    bank.appendChild(bankLabel);
    const coin = el('div', 'money-chip treasury-coin', `${bankTotal(local)}g`);
    bank.appendChild(coin);
    const total = el('span', 'bank-total');
    total.dataset.field = 'bank-total';
    total.textContent = `${local.bank.length} card${local.bank.length === 1 ? '' : 's'}`;
    bank.appendChild(total);

    const kingdom = el('div', 'your-kingdom');
    kingdom.dataset.dropTarget = `kingdom:${state.localPlayerId}`;
    const hasAny = Object.values(local.properties || {}).some(arr => arr && arr.length > 0);
    if (!hasAny) {
        const hint = el('div', 'kingdom-hint', 'Drop properties here to build your kingdom');
        kingdom.appendChild(hint);
    } else {
        for (const colorKey of Object.keys(local.properties || {})) {
            const cards = local.properties[colorKey] || [];
            if (cards.length === 0) continue;
            const setSize = (PROPERTIES[colorKey] && PROPERTIES[colorKey].count) || 3;
            const buildings = (local.buildings && local.buildings[colorKey]) || [];
            const isComplete = cards.length >= setSize;
            for (let i = 0; i < cards.length; i += setSize) {
                const slice = cards.slice(i, i + setSize);
                const stackBuildings = (i === 0 && isComplete) ? buildings : [];
                const stack = renderColorStack(colorKey, slice, stackBuildings);
                stack.classList.add('large');
                kingdom.appendChild(stack);
            }
        }
    }

    wrap.append(bank, kingdom);
    return wrap;
}

function renderYourHand(state) {
    const wrap = el('section', 'your-hand');
    const local = state.players[state.localPlayerId];

    local.hand.forEach(c => {
        const cardEl = el('div', 'card hand-card');
        cardEl.dataset.cardId = c.data.id;
        cardEl.dataset.draggable = 'true';
        cardEl.style.setProperty('--card-color', c.data.hex || c.data.color || '#444');
        attachArt(cardEl, c);
        attachColorStripes(cardEl, c);
        const name = el('div', 'card-name', c.data.name || '');
        const value = el('div', 'card-value', c.data.value != null ? `${c.data.value}g` : '');
        cardEl.append(name, value);
        if (c.data.type === CARD_TYPES.PROPERTY && c.data.colorKey) {
            const owned = (local.properties && local.properties[c.data.colorKey] || []).length;
            const ladder = renderRentLadder(c.data.colorKey, owned + 1);
            if (ladder) {
                ladder.classList.add('rent-ladder-hand');
                cardEl.appendChild(ladder);
            }
        }
        wrap.appendChild(cardEl);
    });
    return wrap;
}
