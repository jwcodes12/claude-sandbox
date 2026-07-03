// core/state.js — canonical game-state construction and helpers (Step 3).
//
// createInitialState(seed, players) builds a fully JSON-serialisable state
// from a seed alone: same seed + same player list => byte-identical starting
// state on every device. It deliberately holds NO client identity (no
// localPlayerId) — which seat you are is a per-client concern layered on top.
//
// clone(state) makes an independent deep copy so the reducer can apply an
// action to a fresh state without mutating the previous one.
//
// The find* helpers address cards by id, so actions can travel over the wire
// as { cardId } strings and be resolved against whichever state copy applies —
// dropping the fragile object-reference identity the engine used internally.

import { generateDeck } from '../cards.js';
import { createRng } from './rng.js';
import { initGameStateS, drawCardFromDeckS } from '../engine.js';

export function createInitialState(seed, players) {
    // players may be a count or an array of { name, ... } descriptors.
    const descriptors = typeof players === 'number'
        ? Array.from({ length: players }, () => ({}))
        : (players || []);
    const playerCount = descriptors.length;

    const rng = createRng(seed >>> 0);
    const rawDeck = generateDeck(playerCount >= 6 ? 2 : 1, rng);
    const entities = rawDeck.map(card => ({ data: card, zone: 'deck', owner: null }));

    const state = {};
    // initGameStateS records seed and picks up the rng cursor AFTER the initial
    // shuffle, so mid-game reshuffles continue the same reproducible stream.
    initGameStateS(state, entities, playerCount, seed, rng.state);

    // Deal 5 to each seat — matches the live game's opening deal. We do NOT call
    // startTurn here: seat 0 opens the game holding those 5, drawing no extra.
    for (let i = 0; i < playerCount; i++) {
        for (let c = 0; c < 5; c++) drawCardFromDeckS(state, i);
    }

    descriptors.forEach((d, i) => { if (d && d.name) state.players[i].name = d.name; });

    state.playerCount = playerCount;
    state.turn = 0;
    state.actionsLeft = 3;
    state.winner = null;            // engine-owned (was the UI's _gameOver)
    state.lastResolution = null;
    state.version = 0;
    return state;
}

// Deep, independent copy. State is intentionally plain data (no functions,
// no cyclic references). structuredClone is used when available (notably
// faster than a JSON round-trip on the hot reduce path) and still throws on
// anything non-cloneable, so accidental non-serialisable state surfaces
// immediately; we fall back to JSON where structuredClone is absent.
export function clone(state) {
    if (typeof structuredClone === 'function') return structuredClone(state);
    return JSON.parse(JSON.stringify(state));
}

// Resolve a card id within a specific player's hand (the common case for
// play / propose / discard / react actions).
export function findHandCard(state, playerId, cardId) {
    const p = state.players[playerId];
    if (!p) return null;
    return p.hand.find(c => c.data.id === cardId) || null;
}

// Resolve a card id anywhere in a player's tableau (hand, bank, properties,
// buildings). Used to resolve targeted cards for sly deal / forced deal.
export function findPlayerCard(state, playerId, cardId) {
    const p = state.players[playerId];
    if (!p) return null;
    const inHand = p.hand.find(c => c.data.id === cardId);
    if (inHand) return inHand;
    const inBank = p.bank.find(c => c.data.id === cardId);
    if (inBank) return inBank;
    for (const color of Object.keys(p.properties || {})) {
        const c = (p.properties[color] || []).find(c => c.data.id === cardId);
        if (c) return c;
    }
    for (const color of Object.keys(p.buildings || {})) {
        const c = (p.buildings[color] || []).find(c => c.data.id === cardId);
        if (c) return c;
    }
    return null;
}
