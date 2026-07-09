# Net layer spec — authoritative writer + version-ordered clients (Step 6/7)

**Date:** 2026-07-02
**Scope:** `src/js/net/` — the authoritative network layer that replaces the broken
P2P relay (`multiplayer.js` + `applyRemoteAction`/`handleSnapshot`/`broadcastSnapshot`
in `main.js`). Implements Steps 6 (authoritative writer) and 7 (reconnect/resume) of
`2026-07-02-deterministic-engine.md`.

This layer sits **on top of the existing pure engine** and does not reinvent it:

- `core/state.js` — `createInitialState(seed, players)`, `clone(state)`
- `core/reducer.js` — `reduce(state, action)` (PURE; rejects illegal/out-of-turn/
  over-budget/duplicate-end-turn by returning the *same* object; bumps `state.version`
  on success; stamps `state.winner`)
- `core/replay.js` — `hashState(state)` stable digest
- `core/legal.js` — `enumerateLegalActions(state, playerId)`
- `core/rng.js` — `createRng(seed)` (the ONLY randomness source; used by the transport)
- `engine.js` — `playerHasPendingReactionS(state, playerId)`

**Hard rules for everything under `net/`:**
- NO `Math.random()`, NO `Date.now()`. All randomness (transport perturbation) is
  seeded through `createRng`. All ids are deterministic counters.
- Zero dependencies. Pure JS/ESM.
- The writer is the single source of truth. Clients never mutate game state except
  by applying writer-approved `accepted` actions (or adopting a `snapshot`).

Determinism guarantee this layer relies on: because `reduce` is deterministic and every
client applies the SAME accepted actions in the SAME version order starting from the
same seed, `hashState(client.state) === hashState(writer.state)` once caught up. **That
equality is the definition of convergence** and is the assertion every suite ends on.

---

## 1. `net/protocol.js` — message factories + constants

Message shapes are fixed by the locked contract. `protocol.js` only builds/validates
them; it holds no state.

```js
export const MSG = Object.freeze({
    REQUEST:  'request',
    ACCEPTED: 'accepted',
    SNAPSHOT: 'snapshot',
    RESUME:   'resume',
});

// Request (client -> writer): id is the unique intent/action id.
export function request({ id, playerId, type, cardId = null, zone = null,
                          targetPlayerId = null, options = null,
                          againstReactorId = null, paidCardIds = null }) {
    return { type, id, playerId, cardId, zone, targetPlayerId,
             options, againstReactorId, paidCardIds };
}

// Accepted (writer -> all clients): version = writer state.version AFTER apply.
// `action` carries playerId + every game field so each client applies it identically.
export function accepted({ version, id, action }) {
    return { type: MSG.ACCEPTED, version, id, action };
}

// Snapshot (writer -> one client): full authoritative state at `version` for `seat`.
export function snapshot({ version, seat, state }) {
    return { type: MSG.SNAPSHOT, version, seat, state };
}

// Resume (client -> writer): request a snapshot; haveVersion is the client's appliedVersion.
export function resume({ clientId, seat, haveVersion }) {
    return { type: MSG.RESUME, clientId, seat, haveVersion };
}

// Build the engine action the reducer consumes from a Request. Strips transport-only
// framing but keeps `id` (so a client can dedupe by it) + playerId + all game fields.
// The reducer's isLegal() ignores id/playerId when signature-matching.
export function actionFromRequest(req) {
    return {
        id: req.id,
        playerId: req.playerId,
        type: req.type,
        cardId: req.cardId ?? null,
        zone: req.zone ?? null,
        targetPlayerId: req.targetPlayerId ?? null,
        options: req.options ?? null,
        againstReactorId: req.againstReactorId ?? null,
        paidCardIds: req.paidCardIds ?? null,
    };
}
```

---

## 2. `net/transport.js` — in-process, deterministic fake hub

Star topology: one **writer** node (`writerId = 'writer'`) and N client nodes. A client's
`send` routes to the writer; the writer's `send` (no explicit target) broadcasts to all
client nodes; a targeted `send(msg, to)` routes to exactly that node (used for the resume
Snapshot). All perturbation randomness is drawn from a single `createRng(seed)` stream in a
**fixed draw order**, so a given `{seed} + call-sequence` reproduces byte-identical delivery.

### API

```js
createHub({ seed, writerId = 'writer' }) -> hub

hub.connect(id) -> channel {
    send(msg, to)      // to omitted: client->writer, or writer->broadcast-all-clients
    onMessage(cb)      // register the single delivery callback (cb(msg))
    close()            // disconnect this node; drop queued messages addressed to it
}

hub.setConditions({ reorderWindow = 1, dropRate = 0, duplicateRate = 0 })
hub.partition(id)      // node goes offline: sends FROM it are dropped; messages TO it are held
hub.reconnect(id)      // node back online: held messages become deliverable again
hub.flush()            // deliver every currently-deliverable message (perturbed order), return count
hub.deliverOne()       // deliver exactly one message; return true if one was delivered
hub.pending()          // number of queued messages (debug/asserts)
```

### Internal model

```
node[id]      = { id, cb: null, connected: true, partitioned: false }
queue         = [ { seq, from, to, msg } ... ]        // FIFO base order
rng           = createRng(seed)
conditions    = { reorderWindow: 1, dropRate: 0, duplicateRate: 0 }
seqCounter    = 0
```

`send(from, msg, to)`:
1. Resolve targets: `to` given -> `[to]`; else `from === writerId` -> all client ids in
   ascending id order; else -> `[writerId]`.
2. If `from` is partitioned -> drop everything (offline node cannot send), return.
3. For each target (stable order):
   - `if rng.next() < dropRate` -> dropped, continue. *(draw #1: drop roll)*
   - push `{ seq: seqCounter++, from, to: target, msg }`.
   - `if rng.next() < duplicateRate` -> push a second identical entry. *(draw #2: dup roll)*

   Draw order is exactly (drop, dup) per target — this is what makes it reproducible.

`deliverOne()`:
1. `deliverable = queue.filter(e => node[e.to].connected && !node[e.to].partitioned)`.
2. If empty -> return false.
3. `window = deliverable.slice(0, max(1, reorderWindow))`.
4. `pick = window[ floor(rng.next() * window.length) ]`. *(draw #3: reorder pick)*
   With `reorderWindow === 1` this is strict FIFO (no reorder).
5. Remove `pick` from queue; invoke `node[pick.to].cb(pick.msg)`; return true.
6. Callbacks may enqueue new messages (e.g. writer broadcasting an Accepted in response
   to a Request); those land at the queue tail and are delivered by later calls.

`flush()`: `while (deliverOne()) {}` — drains all deliverable messages. Held (partitioned)
messages remain queued, so `flush` always terminates.

`partition(id)`: mark offline. Messages already queued to it stay but are skipped until
reconnect (they arrive stale and are ignored by the client version guard — harmless).
`reconnect(id)`: mark online (does NOT resend anything; the *client's* `reconnect()` method
sends the Resume that pulls a fresh Snapshot).
`close(id)`: mark disconnected and drop queued messages addressed to it.

Determinism note: every stochastic decision (drop, dup, reorder-pick) pulls from the one
seeded stream in the order above. Two runs with the same `seed` and the same ordered
sequence of `send/flush/deliverOne/partition/reconnect` calls deliver identically.

---

## 3. `net/writer.js` — the single authoritative writer

```js
import { reduce } from '../core/reducer.js';
import { hashState } from '../core/replay.js';
import { clone, createInitialState } from '../core/state.js';
import { MSG, accepted, snapshot, actionFromRequest } from './protocol.js';

export function createWriter({ seed, players, channel }) {
    let state = createInitialState(seed, players);
    const applied = new Set();       // intent ids already applied
    const byId    = new Map();       // id -> stored Accepted (for idempotent re-broadcast)
    const log     = [];              // Accepted[] in version order (audit / replay)

    channel.onMessage(handle);

    function handle(msg) {
        if (msg && msg.type === MSG.RESUME) return handleResume(msg);
        return handleRequest(msg); // anything else is a Request
    }

    function handleRequest(req) {
        if (!req || req.id == null) return;

        // Idempotent double-tap guard: same intent id -> re-broadcast the stored
        // Accepted (original version, <= current). Do NOT re-apply, do NOT bump version.
        if (applied.has(req.id)) {
            channel.send(byId.get(req.id));   // broadcast to all clients
            return;
        }

        const action = actionFromRequest(req);
        const next = reduce(state, action);
        if (next === state) return;           // illegal / out-of-turn / over-budget / no-op: DROP

        state = next;                         // reduce already bumped state.version
        applied.add(req.id);
        const acc = accepted({ version: state.version, id: req.id, action });
        byId.set(req.id, acc);
        log.push(acc);
        channel.send(acc);                    // broadcast Accepted to all clients
    }

    function handleResume(r) {
        // Reply to that client ONLY with the current authoritative state.
        channel.send(
            snapshot({ version: state.version, seat: r.seat, state: clone(state) }),
            r.clientId
        );
    }

    return {
        hashOf()     { return hashState(state); },  // convergence assertions
        getVersion() { return state.version; },
        getState()   { return clone(state); },
        get log()    { return log.slice(); },
    };
}
```

Key properties: duplicate id → re-broadcast (no re-apply); illegal → dropped silently (no
version bump, no broadcast) — this is the skipped-turn and stale/over-budget fix; every
success bumps `version` by exactly 1 and broadcasts one Accepted.

---

## 4. `net/client.js` — local version-ordered mirror

```js
import { reduce } from '../core/reducer.js';
import { hashState } from '../core/replay.js';
import { clone } from '../core/state.js';
import { MSG, request, resume } from './protocol.js';

// Deterministic, collision-free id source: per-client tag + monotonic counter.
// No Math.random / Date.now. Distinct clients use distinct tags so ids never collide.
export function makeIdSource(tag) {
    let n = 0;
    return () => `${tag}#${n++}`;
}

export function createClient({ seat, channel, state, clientId = `c${seat}`,
                               idSource = makeIdSource(`c${seat}`) }) {
    let appliedVersion = state.version;   // starts at 0 (same seed as writer)
    const seen   = new Set();             // intent ids already applied locally
    const buffer = new Map();             // version -> Accepted held out of order

    channel.onMessage(handle);

    function handle(msg) {
        if (!msg) return;
        if (msg.type === MSG.ACCEPTED) return onAccepted(msg);
        if (msg.type === MSG.SNAPSHOT) return onSnapshot(msg);
    }

    function onAccepted(msg) {
        const { version, id, action } = msg;
        // Double-tap + snap-back guard: already applied, or older than what we have.
        if (seen.has(id) || version <= appliedVersion) return;
        if (version === appliedVersion + 1) {
            state = reduce(state, action);
            appliedVersion = version;
            seen.add(id);
            drain();                      // apply any buffered contiguous successors
        } else {
            buffer.set(version, msg);     // out-of-order hold
        }
    }

    function drain() {
        let m;
        while ((m = buffer.get(appliedVersion + 1))) {
            buffer.delete(m.version);
            if (seen.has(m.id)) continue;
            state = reduce(state, m.action);
            appliedVersion = m.version;
            seen.add(m.id);
        }
    }

    function onSnapshot(msg) {
        if (msg.version <= appliedVersion) return;   // stale snapshot ignored
        state = clone(msg.state);
        appliedVersion = msg.version;
        // Post-snapshot the version guard alone suffices for dedup; discard stale buffer
        // entries and drain any that are now contiguous. `seen` may be cleared safely.
        for (const v of [...buffer.keys()]) if (v <= appliedVersion) buffer.delete(v);
        seen.clear();
        drain();
    }

    return {
        // partialAction = { type, cardId?, zone?, targetPlayerId?, options?, againstReactorId?, paidCardIds? }
        submit(partialAction) {
            const id = idSource();                       // deterministic unique intent id
            channel.send(request({ id, playerId: seat, ...partialAction }));
            return id;                                    // caller may track it
        },
        reconnect() {
            channel.send(resume({ clientId, seat, haveVersion: appliedVersion }));
        },
        hashOf()     { return hashState(state); },
        getVersion() { return appliedVersion; },
        getState()   { return clone(state); },
    };
}
```

Guards, mapped to the plan's bugs:
- `seen.has(id)` → double-tap can never apply twice on the client.
- `version <= appliedVersion` → a late/stale Accepted or Snapshot can never snap the board back.
- `version > appliedVersion + 1` → buffered until contiguous, so out-of-order delivery still
  applies in strict version order.

---

## 5. `net/testing.js` — headless harness

```js
import { createInitialState } from '../core/state.js';
import { enumerateLegalActions } from '../core/legal.js';
import { playerHasPendingReactionS } from '../engine.js';
import { createHub } from './transport.js';
import { createWriter } from './writer.js';
import { createClient, makeIdSource } from './client.js';

// makeGame wires a writer + N clients through one deterministic hub. Every client
// starts from a fresh createInitialState(seed, players) at version 0 — byte-identical
// to the writer — so pure determinism carries them forward via Accepteds alone.
export function makeGame({ seed, players, humanSeats = null }) {
    const count = typeof players === 'number' ? players : players.length;
    const hub = createHub({ seed });

    const writer = createWriter({ seed, players, channel: hub.connect('writer') });

    const clients = Array.from({ length: count }, (_, i) =>
        createClient({
            seat: i,
            channel: hub.connect(`c${i}`),
            state: createInitialState(seed, players),
            clientId: `c${i}`,
            idSource: makeIdSource(`c${i}`),
        })
    );

    const flush   = () => hub.flush();
    const hashes  = () => [writer.hashOf(), ...clients.map(c => c.hashOf())];
    const converged = () => { const h = hashes(); return h.every(x => x === h[0]); };

    // Authoritative pending actor, read from the WRITER (source of truth):
    //   { seat, phase: 'react' | 'discard' | 'turn' } | null
    function pendingActor() {
        const s = writer.getState();
        if (s.winner != null) return null;
        if (s.pendingAction) {
            const reactors = s.players.map(p => p.id)
                .filter(id => playerHasPendingReactionS(s, id));
            if (!reactors.length) return null;
            const seat = reactors.includes(s.reactionTargetId) ? s.reactionTargetId : reactors[0];
            return { seat, phase: 'react' };
        }
        if (s.mustDiscard > 0) return { seat: s.turn, phase: 'discard' };
        return { seat: s.turn, phase: 'turn' };
    }

    const legalFor = (seat) => enumerateLegalActions(writer.getState(), seat);

    // Drive an entire game across the net path with a deterministic policy.
    // policy(state, seat, legal) -> action | null. null coerces to concede/discard/end-turn.
    function playOut({ policy, maxSteps = 100000 } = {}) {
        for (let step = 0; step < maxSteps; step++) {
            const actor = pendingActor();
            if (!actor) break;                       // winner decided
            const { seat, phase } = actor;
            const legal = legalFor(seat);
            let action = policy ? policy(writer.getState(), seat, legal) : null;
            if (!action) {
                action = legal.find(a => a.type === (
                    phase === 'react' ? 'concede' : phase === 'discard' ? 'discard' : 'end-turn'));
            }
            if (!action) break;
            clients[seat].submit(action);            // client -> writer over the hub
            hub.flush();                             // writer applies + broadcasts to all
        }
        return writer.getState();
    }

    return { writer, clients, hub, flush, hashes, converged, pendingActor, legalFor, playOut };
}
```

`makeGame` returns at minimum `{ writer, clients, hub, flush, hashes() }` per contract;
`converged/pendingActor/legalFor/playOut` are convenience helpers so the six suites don't
re-implement setup or the autoplay driver.

---

## 6. The six failure-mode suites

Each imports only `core/*` + `net/*`, runs headless (vitest, `vitest run`), and finishes on
the convergence assertion `hashes().every(h => h === writerHash)`. Every scenario below is
concrete enough to code directly.

### 6.1 `idempotency.test.js` — double-tap (plan: "Double-tap does something twice")

**Scenario.** 3p, `makeGame({ seed, players: 3 })`. Seat 0 plays one legal money-to-bank card.
Force the duplicate two ways:
- (a) transport-level: `hub.setConditions({ duplicateRate: 1 })` before the submit+flush, so
  the single Request is delivered to the writer twice and each Accepted is delivered to each
  client twice.
- (b) intent-level: call `clients[0].submit(sameAction)` — capture the returned id — then push
  the *same* Request object again through `hub.connect`'s writer channel (or resubmit with the
  same id via a thin helper) so the writer sees an id it has already applied.

**Assertions (prove the fix).**
- `writer.getVersion()` increased by exactly 1 (not 2).
- The card appears in seat 0's bank exactly once; `actionsLeft` dropped by exactly 1.
- Every `clients[i].getVersion()` advanced by exactly 1; delivering the duplicate Accepted a
  second time is a no-op (`seen.has(id)` guard).
- `hashes()` all equal.

### 6.2 `stale-version.test.js` — snap-back / out-of-order (plan: "play a card and it snaps back")

**Scenario A (snap-back).** Advance a client to `appliedVersion = N` (submit + flush a couple
of legal actions). Then hand-deliver, via the client's channel `onMessage`, an OLD Accepted with
`version <= N` (reuse a captured earlier Accepted from `writer.log`) and an OLD Snapshot with
`version < N`.

**Scenario B (out-of-order).** Produce three consecutive Accepteds (versions N+1, N+2, N+3) by
having seat 0 submit three legal actions, but hold them and deliver **reversed** — either
`hub.setConditions({ reorderWindow: 3 })` and drive `deliverOne()` so the pick order is
N+3, N+2, N+1, or feed the client's `onMessage` manually in reverse.

**Assertions.**
- A: the stale Accepted and stale Snapshot are ignored — `getVersion()` unchanged, `hashOf()`
  unchanged (no snap-back).
- B: the client buffers N+2 and N+3, applies nothing until N+1 arrives, then drains N+1→N+2→N+3
  in order. Final `appliedVersion === N+3` and `clients[0].hashOf() === writer.hashOf()`.

### 6.3 `lost-jsn.test.js` — simultaneous reactions (plan: "a Just Say No is lost on simultaneous reactions")

**Scenario.** 3p. Seed/set up so seat 0 holds a fan-out charge (birthday, or a single-color rent
for a color it owns) and seats 1 and 2 each hold a Just Say No. Seat 0 `submit`s the propose;
`flush`. Now both defenders react **simultaneously**: `clients[1].submit({type:'react-no', cardId: jsn1})`
and `clients[2].submit({type:'react-no', cardId: jsn2})` are both queued before any delivery,
then `hub.setConditions({ reorderWindow: 2 })` and `flush()` so the two reactions reach the
writer in a perturbed order. Resolve the chains (defenders/attacker `concede` via `playOut` or
explicit submits).

**Assertions (prove no reaction is lost + global ordering).**
- Both JSN cards left their owners' hands and are in `discard` — neither reaction was dropped.
- The pending action resolves with the correct per-chain canceled/settled outcome.
- Run the identical scenario twice with two different hub seeds (so the two reactions serialize
  in opposite orders); the final `writer.hashOf()` is **identical** across both runs — because
  the writer imposes one global order and the two reactions live on independent chains, the
  outcome is order-independent.
- `hashes()` all equal at the end.

### 6.4 `reconnect.test.js` — drop + resume; writer continues (plan: "refresh/wifi blip → stuck / game hangs")

**Scenario A (drop + resume).** 3p. Play several actions so the writer reaches version M.
`hub.partition('c2')`, then keep seats 0/1 submitting legal actions and `flush`ing so the
writer advances further and c2 misses those Accepteds. Then `hub.reconnect('c2')` and
`clients[2].reconnect()` (sends `Resume{haveVersion}`); `flush`. The writer replies with a
`Snapshot{version: M', seat: 2}` to c2 only.

**Assertions.**
- `clients[2].getVersion() === writer.getVersion()` and `clients[2].hashOf() === writer.hashOf()`
  (correct seat + current version adopted).
- After resume, c2 submits a legal action; the writer accepts it (version +1) and **all** clients
  converge — i.e., the resumed client can act, no stall.

**Scenario B (writer/host cannot vanish → no hang).** With the server-as-writer model there is
no host-player to migrate. Simulate a total blip: `hub.partition` every client, verify the writer
state is unchanged and `pending()` messages are merely held (game does not advance, nothing
crashes). Then `reconnect` all clients and call each `client.reconnect()`; `flush`. Assert every
client resyncs to the writer hash and the game can be driven to a natural winner via `playOut`.
(Contrast with the legacy bug where host election could pick the dead host and stall — that path
does not exist here.)

### 6.5 `full-flow.test.js` — 2/3/4p to a single winner, everyone converges (plan: the convergence goal)

**Scenario.** Parametrize `players ∈ {2, 3, 4}`. For each, `makeGame({ seed, players })`, apply a
mild lossless perturbation `hub.setConditions({ reorderWindow: 3, duplicateRate: 0.3 })`
(reorder + duplicate but **no drop**, so every intent still reaches the writer and the game is
guaranteed to terminate), then `playOut({ policy })` with a seeded deterministic policy (the
`makePolicy(seed)` pattern from `tests/local-game.test.js`: prefer acting over ending, always
concede reactions, discard first legal when forced).

**Assertions.**
- The game ends: `writer.getState().winner` is a number, and it is the **only** player with the
  winning number of completed sets (exactly one winner).
- `hashes()` all equal — every client's `hashState` equals the writer's (true convergence through
  the perturbed net path).
- Every `clients[i].getVersion() === writer.getVersion()`.
- Optionally assert `converged()` after every `flush` inside a debug variant.

### 6.6 `skipped-turn.test.js` — concurrent same-seat end-turns advance once (plan: "A turn gets skipped")

**Scenario.** 3p, seat 0 on the clock with `actionsLeft` spent. Simulate two devices both deciding
"turn's over" for seat 0. Two variants, both must hold:
- (a) genuine double-tap: `clients[0].submit({type:'end-turn'})` **twice** (two DISTINCT ids).
  The first is legal → applied (turn 0→1, version +1). The second reaches the writer when it is no
  longer seat 0's turn → `reduce` returns state unchanged → dropped.
- (b) cross-device race: seat 0's action is mirrored — send an `end-turn` for playerId 0 from a
  second source with a different id, interleaved via `reorderWindow: 2`.

**Assertions (prove the skip is fixed).**
- `writer.getState().turn === 1` (advanced **exactly once**, not to 2).
- `writer.getVersion()` increased by exactly 1 across both end-turn intents.
- No client ever observes `turn === 2`; `hashes()` all equal.

---

## 7. What this replaces / integration notes

- `multiplayer.js` (PeerJS relay, `broadcastAction`, `sendSnapshot`, `_handleEnvelope`, host
  election) and `main.js`'s `applyRemoteAction` / `handleSnapshot` / `broadcastSnapshot` are
  superseded by `writer.js` + `client.js`. The in-browser wiring (Step 6 app glue) swaps the
  fake `transport.js` for a real WebSocket transport exposing the same `channel {send,onMessage,close}`
  interface — the writer/client code is transport-agnostic and unchanged.
- The writer is a single Node process (recommended by the plan) or, if P2P is retained, the host's
  `createWriter` instance; either way there is exactly one writer, so server-vs-host is a transport
  swap, not a rewrite.
- No `net/` code calls `Math.random`/`Date.now`; grep-clean is part of the definition of done.
</content>
</invoke>
