// core/deck.js — deck shuffling, extracted out of cards.js.
//
// The Fisher–Yates shuffle used to live in cards.js and used unseeded
// randomness, so no two runs matched and replay was impossible. It now is
// driven entirely by an injected seeded rng (see core/rng.js), so a given
// seed reproduces the exact deck order — for the initial deal and every
// mid-game reshuffle.
export function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
