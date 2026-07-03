// core/replay.js — reconstruct state from a seed + ordered action log.
//
// replay(initial, actions) folds reduce over the log, so the milestone
// invariant `createInitialState(seed) + ordered action log = final state`
// holds by construction: the same inputs always yield the same output on
// every device. Illegal entries in the log are no-ops (reduce returns the
// state unchanged), so a replay can't diverge on a stray action.
//
// hashState(state) is a stable, order-independent digest used to assert that
// two states are byte-for-byte equal (across runs, across devices). Object
// keys are sorted before hashing so incidental key-insertion order can't cause
// a false mismatch; array order (deck, hands, discard) is preserved because it
// is semantically significant.

import { reduce } from './reducer.js';

export function replay(initial, actions) {
    let state = initial;
    for (const action of actions) {
        state = reduce(state, action);
    }
    return state;
}

// Canonical JSON: recursively sort plain-object keys, leave arrays in order.
function canonical(value) {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonical(value[key]);
        }
        return out;
    }
    return value;
}

export function canonicalString(state) {
    return JSON.stringify(canonical(state));
}

export function hashState(state) {
    const str = canonicalString(state);
    // FNV-1a (32-bit), returned as hex. Cheap, stable, and good enough to
    // detect any divergence between two states in tests.
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}
