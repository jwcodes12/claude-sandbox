// core/rng.js — the ONLY randomness source for the engine.
//
// Deterministic mulberry32: the same seed always produces the same stream.
// The internal state is a single 32-bit integer, so it round-trips cleanly
// through JSON (stored as gameState.rngState). Snapshotting `rng.state` and
// passing it back to createRng() later resumes the exact same stream — which
// is what makes deck shuffles reproducible for replay.
//
// No unseeded randomness here (or anywhere in core/); seeds are chosen by the
// app layer and captured in state.
export function createRng(seed) {
    let a = seed >>> 0;
    return {
        next() {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
        // Current internal state. Store this in gameState.rngState and pass it
        // back to createRng() to continue the stream exactly where it left off.
        get state() { return a >>> 0; }
    };
}
