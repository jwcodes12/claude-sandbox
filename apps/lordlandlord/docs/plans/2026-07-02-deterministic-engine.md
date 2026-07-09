# Reliability plan: deterministic engine + authoritative writer

**Date:** 2026-07-02
**Goal:** Move Lord Landlord from fragile, drift-prone multiplayer to a boring, reliable design where the game state is deterministic and there is exactly one source of truth. The UI must not be the source of truth for game rules.

**First milestone (non-negotiable):**

```
createInitialState(seed) + ordered action log = final state
```

Priority is **organic desync between honest players** (skipped turns, rolled-back moves, lost reactions, reconnect hangs) — not cheating. The same fixes remove the cheating class for free, so we spend no extra effort on it.

---

## 1. The core problem

Every device runs its own copy of the game, changes the shared state locally the instant you tap, *then* broadcasts the move. There is no single source of truth, and the shuffle uses unseeded randomness (`Math.random()`). When two devices act close together, a message arrives late, the deck reshuffles, or a connection blips, the copies drift apart. That drift is every bug.

Two root causes:
- **Nondeterminism** — `engine.js:113` (mid-game reshuffle) and `cards.js:98` (initial deal) use `Math.random()`, so no two runs match and replay is impossible.
- **Two writers** — each client mutates its own `gameState` singleton (`engine.js:9`) optimistically, then broadcasts; the host merely relays and periodically overwrites everyone with a full snapshot (last-writer-wins, `main.js:357`).

---

## 2. Bugs, in plain terms (what a player sees)

| What you see | Why it happens between honest players | Where |
|---|---|---|
| A turn gets skipped | Two devices both auto-decide "turn's over"; the counter advances twice with no turn check on the receiver | `main.js:469`, `applyRemoteAction` `main.js:1370` |
| You play a card and it snaps back | A state-sync generated *before* your move arrives *after* it and overwrites it | `main.js:357` |
| A Just Say No is lost on simultaneous reactions | No global ordering; devices apply concurrent reactions in different orders | `multiplayer.js:255` |
| Hands drift in a long game | Deck empties; each device reshuffles with its own `Math.random()` | `engine.js:113` |
| Double-tap does something twice | No debounce / no dedupe of a repeated action | `input.js`, no action id |
| Refresh or wifi blip → stuck / game hangs | No reconnect+resync; if the host drops, election can pick the dead host and everyone stalls | `main.js:137`, `main.js:180` |

---

## 3. Where state lives and gets mutated today (audit)

**Single source of truth (and its problems):** exported mutable singleton `gameState` (`engine.js:9-21`) holding deck, discard, players[]{hand,bank,properties,buildings}, turn, actionsLeft, pendingAction, etc. `localPlayerId` (a client concern) is wrongly baked into it (`:16`). It is also handed to the page live via `window.__game.state()` (`main.js:1926`).

**Engine (`engine.js`) is not a reducer** — every function mutates the singleton in place and identifies cards by object reference (`hand.filter(c => c !== card)`). Only `swapWildColor` self-checks whose turn it is.

**The rulebook is duplicated across three code paths:** local `dispatchAction` (`main.js:495`), network `applyRemoteAction` (`main.js:1309`), and bot `playBotTurn` (`main.js:1229`). The 3-action counter is decremented in three different places (`main.js:669, 1283, 1411`).

**The UI directly changes canonical state** in many places: discard splices hand + deck (`main.js:617`), payment transfers cards on submit (`~main.js:812`), concede moves all assets in the click handler (`main.js:552`), `_gameOver` is set by the render loop (`main.js:463`), auto-end-turn is decided and broadcast by `update()` (`main.js:469`), and setup sets `turn/actionsLeft/localPlayerId` literally, bypassing `startTurn` (`main.js:301, 404`).

**The "action log" is not replayable** — `gameState.actionLog` (`main.js:440`) is a display feed capped at 100 and spliced. Nothing reconstructs state from it, so `initial + log = final` does not exist today.

---

## 4. Target architecture

Four layers, one-way dependency **core → net → app → render**. Core never imports DOM or the network transport. Render stays pure (`render(root, state)` already is).

```
src/js/core/
  rng.js       // mulberry32(seed) -> { next() }   — the ONLY randomness source
  deck.js      // generateDeck(packs, rng)          — shuffle moves here from cards.js
  state.js     // createInitialState(seed, players), clone()   (no localPlayerId inside)
  legal.js     // enumerateLegalActions(state, playerId)        (pure)
  reducer.js   // reduce(state, action) -> newState             (PURE; the whole rulebook)
  replay.js    // replay(initial, actions[]) -> final; hashState(state)
src/js/net/
  protocol.js  // request / accepted / snapshot / resume message shapes
  server-or-host.js  // the authoritative writer (see below)
  client.js    // send request; apply accepted/snapshot in version order
src/js/app/controller.js   // main.js, slimmed: input -> action request, subscribe, render
```

Three ideas:

1. **A deterministic engine.** One pure function `reduce(state, action) -> newState`. Same seed + same ordered actions = the exact same game on every device. The engine owns turn order, the 3-action limit, hands, board, and the winner. It rejects any action not returned by `enumerateLegalActions` (turn ownership + `actionsLeft > 0` + phase all enforced in one place). `actionsLeft--` lives in exactly one spot, killing the three-way split. RNG lives **in the state** (`seed` + `rngState`), so snapshots and replay reproduce deck order exactly.

2. **One authoritative writer + version numbers.** Exactly one place applies moves and stamps each result with a monotonic `version`. Everyone else sends a move as a *request*, waits for the approved result, and renders it. Clients ignore anything whose `version <= appliedVersion` (removes snap-back) and ignore a duplicate action id (removes double-tap).

3. **Recommended: a tiny WebSocket server as that writer.** Not required for correctness — host-authoritative P2P would also give one writer — but a server deletes P2P's two worst reliability problems: *the host is a player who can vanish mid-game* and *flaky NAT/relay connections on mobile* (the current TURN relay is described as "flaky or rate-limited" in `multiplayer.js:7`). It's a single Node process that holds the state, validates each request against the engine, bumps the version, and broadcasts the approved result. Because the authority sits behind one interface, server-vs-host is a swap, not a rewrite — so **Milestone 1 does not depend on this decision.**

### Shapes

```js
// core/state.js — fully JSON-serializable, no client identity inside
State = {
  version: 0, seed, rngState,
  playerCount, players: [{ id, name, hand, bank, properties, buildings, disconnected }],
  deck, discard, turn, actionsLeft, mustDiscard,
  pendingAction, reactionTargetId, pendingReactors, doubleRentArmed,
  lastResolution, winner            // winner is engine-owned (was UI _gameOver)
}
// wire: request (client -> writer)     accepted / snapshot (writer -> all)
Request  = { id, playerId, type, cardId, zone, targetPlayerId, options, color, againstReactorId }
Accepted = { type:'accepted', version, action }
Snapshot = { type:'snapshot', version, seat, state }
```

---

## 5. Migration — engine first, each step ships on its own

Steps 1–4 are pure-engine (no network changes) and gated by the existing `tests/*.test.js` plus a new determinism test. The live game keeps running on the legacy path behind a back-compat wrapper until Step 5.

- **Step 1 — Seed the deck.** Add `core/rng.js`; store `seed` + `rngState` in state; thread a seeded rng into the reshuffle (replace `engine.js:113`) and move the shuffle into `core/deck.js` (out of `cards.js:98`). *Ship: identical game, now reproducible. Unblocks everything.*
- **Step 2 — State-parametric engine (mechanical).** Engine functions take `state` as first arg; keep a back-compat `gameState` wrapper so `main.js`/tests compile unchanged. *No behavior change.*
- **Step 3 — Id-addressable + `createInitialState`/`clone`.** Resolve `cardId` internally (drop object-ref identity); remove `localPlayerId` from state.
- **Step 4 — Pure reducer + replay + determinism test. → 🏁 Milestone 1.** Extract `legal.js`; build `reducer.js` (clone → legality guard → dispatch → `version++`); fold in the rules currently in the UI (discard-to-deck `main.js:617`, concede `main.js:552`, payment `~main.js:812`, `actionsLeft--` `main.js:669`, winner/`_gameOver` `main.js:463`); add `replay.js` + `tests/determinism.test.js`. *Ship: `initial + log = final` holds and is tested.*
- **Step 5 — Route single-player through the engine.** Rewrite `dispatchAction` to build an action request and call `reduce`; delete the direct-mutation branches; `window.__game.state()` returns a read-only clone.
- **Step 6 — Stand up the authoritative writer (WebSocket server recommended).** Clients send requests; the writer validates via the engine, bumps `version`, broadcasts `accepted`. Clients render only approved state, drop `version <= appliedVersion` (snap-back gone) and duplicate ids (double-tap gone). Replace `applyRemoteAction`/`handleSnapshot`/`broadcastSnapshot`.
- **Step 7 — Reconnect & resume.** A refresh or dropped connection rejoins, gets the current state + version, and continues. With a server there is no host to migrate, so the hang cannot happen. (If P2P is kept instead: `resume` snapshot + fix the host election to exclude the departed host — `main.js:180`.)
- **Step 8 — Cleanup.** Remove legacy `engine.js` wrappers and the live `window.__game` mutation handle.

---

## 6. Milestone 1 — definition of done

A pure `src/js/core/` (Steps 1–4, no network changes) where:

1. `hashState(replay(createInitialState(seed), log))` is identical across two runs, including a forced deck-empty reshuffle.
2. A live game's recorded action log satisfies `replay(createInitialState(seed), recordedLog) === liveFinalState` — **initial + log = final** end-to-end.
3. `reduce` rejects (returns state unchanged) an out-of-turn action, an over-budget 4th action, and a duplicate same-seat end-turn.
4. New `determinism` + `reducer-guards` tests pass, and the existing `tests/engine.test.js` / `scenarios.test.js` still pass unchanged (proving the extraction preserved the rulebook).
5. No `Math.random()` remains in `core/` (grep-clean); the only randomness is `core/rng.js` seeded from state.

---

## 7. Tests for the failure modes

All new suites import only `core/*` + `net/*` and run headless with a fake in-process transport (no real network):

- **`determinism.test.js`** — `initial + log = final` via `hashState`; replay twice → identical; force a reshuffle then continue two copies → identical decks; fuzz ≥50 seeds asserting equal replays + a single winner.
- **`reducer-guards.test.js`** — out-of-turn play → no-op; 4th action → no-op, `actionsLeft` never negative; two same-seat end-turns advance the turn exactly once.
- **`idempotency.test.js`** — same action id twice → applied once; same `accepted{version}` twice → no double-apply.
- **`stale-version.test.js`** — older snapshot ignored, newer adopted, out-of-order accepted buffered until contiguous.
- **`reconnect.test.js`** — a dropped client resumes with the correct seat, current version, and can submit a legal action; killing the writer/host continues the game (no stall).
- **`full-flow.test.js`** — parametrized over 2/3/4 players to a natural winner; every client's `hashState` equals the writer's at the end (true convergence), exactly one winner.

Keep the existing engine/scenarios/dropvalid/input/render suites as regression gates through Steps 1–5. The `ui-test/` Playwright scripts remain a manual smoke layer.
