# Reliability rewrite — progress + remaining work

**Date:** 2026-07-02
**Branch:** `session/20260702-deterministic-engine` (local, not pushed)
**Parent plan:** [2026-07-02-deterministic-engine.md](./2026-07-02-deterministic-engine.md) · **Net spec:** [2026-07-02-net-layer-spec.md](./2026-07-02-net-layer-spec.md)
**Test status:** **198/198 passing** (15 files; the original 157 unchanged throughout)
**Issue tracker:** [claude-sandbox #10 Reliability rewrite tracker](https://github.com/jwcodes12/claude-sandbox/issues/10)
**Previous standalone tracker:** [lordlandlord #9](https://github.com/jwcodes12/lordlandlord/issues/9)

---

## Part 1 — Work done

### Step 1 — Seed the deck (`8909a79`)
- `core/rng.js`: deterministic mulberry32 with a JSON-serializable cursor (`rng.state`).
- `core/deck.js`: Fisher–Yates shuffle extracted from `cards.js`, driven only by an injected rng.
- `seed` + `rngState` stored in game state; the initial deal and the mid-game reshuffle
  (formerly `Math.random()` at `engine.js:113` / `cards.js:98`) now draw from the seeded stream.
- Same seed ⇒ identical deck order, every run, every device.

### Step 2 — State-parametric engine (`85d742d`)
- Every rulebook function now has a canonical `*S(state, …)` form mutating only its argument.
- Legacy wrappers keep the old names bound to the `gameState` singleton, so `main.js` and all
  existing tests run unchanged. Pure mechanical change; behavior identical.

### Step 3 — `createInitialState` + `clone` + id-addressing (`a33b7d6`)
- `core/state.js`: `createInitialState(seed, players)` builds a fully JSON-serializable start
  state from a seed alone — **no `localPlayerId`** (client identity stays out of canonical state).
- `clone(state)` deep-copies; `findHandCard`/`findPlayerCard` resolve cards **by id**, so actions
  travel as `{ cardId }` strings instead of object references.

### Step 4 — Pure reducer + replay ⇒ **Milestone 1** (`53a4961`)
- `core/legal.js`: single source of truth for what a player may do.
- `core/reducer.js`: `reduce(state, action) → newState` — clone → legality guard → dispatch →
  winner stamp → `version++`. Illegal / out-of-turn / over-budget / duplicate actions return the
  input state **unchanged**. Rules that lived in the UI are folded in: `actionsLeft` on plays,
  end-of-turn discard to deck bottom, concede/auto-surrender payment, engine-owned `winner`
  (formerly the UI's `_gameOver`).
- `core/replay.js`: `replay(initial, log)` + `hashState` (stable, key-order-independent digest).
- **Milestone 1 definition of done — all five criteria met:** replay identical across runs
  (including a forced deck-empty reshuffle); `initial + log = final` end-to-end; guards reject the
  three desync actions; new suites pass with the original 157 untouched; `core/` grep-clean of
  `Math.random`. Fuzz: 50 seeds all reach exactly one winner with byte-identical replays.

### Step 5a — Headless local-game controller (`523783d`)
- `app/local-game.js`: owns a single authoritative state and is the **only writer**; humans and
  bots both go through `reduce`. DOM-free; bot "IQ" is an injected policy, so the loop (turn
  order, reaction chains, auto-end, winner) is unit-tested by autoplaying whole games.
- Reducer gained explicit payment: `concede` may carry `paidCardIds` (the human's payment-picker
  choice), applied deterministically so it replays identically.

### Step 5b — `main.js` wired onto controller for solo path *(local working tree, not pushed)*
- `main.js` solo startup now builds `createInitialState(...)` and wraps it in `createLocalGame(...)`;
  the controller is the solo path authority.
- Solo `dispatchAction`, manual end-turn, reaction handling, payment, and bot compatibility shims
  route through `game.submit(...)` / `game.advance(...)` instead of direct singleton mutation.
- Browser bot policy reuses the existing score/pick logic against explicit state.
- `window.__game.state()` returns a controller-backed clone plus view metadata in solo mode.
- Forced Trade picker emits id-based legal actions (`myCardId` / `targetCardId`) and removes the
  `nonCompletePropertyCards` crash.
- Reducer/legal now own `swap-wild` as a free id-based action.
- **Verify:** `npm test` => **198/198 passing**; headless Playwright solo smoke reached a winner
  with no page/console errors.
- GitHub handoff: [claude-sandbox #10 tracker](https://github.com/jwcodes12/claude-sandbox/issues/10);
  previous standalone [#5 Step 5b](https://github.com/jwcodes12/lordlandlord/issues/5).

### Step 6 core — Authoritative net layer + failure-mode proof (`885254e`)
Built via multi-agent workflow (design → build → 6 parallel test authors → adversarial
verification → full regression).

- `net/protocol.js` — `Request` / `Accepted` / `Snapshot` / `Resume` shapes.
- `net/writer.js` — the single authority: idempotent intent-id replay (re-broadcasts the stored
  ruling, never re-applies), reducer no-ops **dropped, not broadcast**, monotonic `version`,
  Accepted log, Resume→Snapshot.
- `net/client.js` — local mirror: ignores `version ≤ appliedVersion` (kills snap-back), dedupes
  seen ids (kills double-tap), buffers out-of-order rulings and drains contiguously, adopts
  snapshots, reconnects.
- `net/transport.js` — deterministic in-process fake network: seeded reorder / duplicate /
  partition / reconnect. `net/testing.js` — `makeGame` harness. No `Math.random`/`Date.now`
  anywhere in `net/`.

**Failure-mode suites (`tests/net/`, 22 tests) — each pins a real cross-wifi bug:**

| Suite | Bug pinned | Teeth proven? |
|---|---|---|
| `idempotency` (5) | double-tap does something twice | ✅ guard broken → suite failed |
| `stale-version` (5) | played card snaps back | ✅ |
| `lost-jsn` (3) | Just Say No lost on simultaneous reactions | ✅ |
| `reconnect` (3) | wifi blip/refresh → hang; **writer killed + rebuilt from log → game continues** | ✅ |
| `skipped-turn` (3) | a turn gets skipped | ✅ |
| `full-flow` (3) | 2/3/4p full games under reorder+dup+double-tap → every client hash == writer hash, one winner | ⚠️ defense-in-depth only¹ |

¹ No *single* guard break trips `full-flow` (guards are redundant); it fails only when both
writer idempotency guards are removed together. The individual guards get their teeth from the
other five suites. Also noted: the fake hub's `partition()` *holds* messages rather than dropping
them, so pure snapshot-adoption recovery is exercised by the fresh-client and writer-kill tests
rather than the partition test; and the idempotency suite's writer-re-broadcast assertion has
teeth only for the client-side guard.

### Infrastructure decision (agreed with owner)
The Step 6b server runs **on the existing OCI box**, exposed via **Tailscale Funnel**
(public `wss://`, zero opened inbound ports), sandboxed in a hardened `DynamicUser=yes` systemd
unit (`ProtectSystem=strict`, no FS access, `MemoryMax`/`CPUQuota`). Funnel is fully public
(cert-transparency-discoverable), so app-layer hardening below is part of 6b's definition of
done, not polish. Stakes are low — the process holds ephemeral game state only, no secrets.
Kill switch: `tailscale funnel off`. (Free managed hosts rejected: they sleep on idle, which
*is* the stall bug we're eliminating.)

### Step 6b — Real transport: WebSocket server + browser adapter *(done; GitHub #11, monorepo working tree)*
The writer/client/protocol stayed untouched (verified: `git diff` clean on `net/{protocol,writer,client,transport,testing}.js` and `core/**`); this was a transport swap plus lobby, exactly as planned.
- `server/index.js`: Node `ws` process, one `net/writer.js` per room behind a fixed wire contract
  (control frames on key `t`: `create`/`join`/`rejoin`/`add-bot`/`start`/`leave`; game frames
  forwarded verbatim on key `type`; `clientId = 'c'+seat`). **All hardening landed:** crypto room
  ids + 16-byte seat tokens, connection↔seat binding (spoofed `playerId`/`seat` rejected before
  the writer), JSON-parse guard, 16KB `maxPayload`, per-connection token-bucket rate limit,
  `maxRooms`/`maxConns` caps, heartbeat + dead-socket terminate, empty-room reaping. Bots run
  server-side. Only dep: `ws`.
- `src/js/net/ws-transport.js`: browser channel adapter (`createWsSession`) with lobby API,
  outbox queue, and auto-reconnect (0.5s→8s backoff) → `rejoin` → `Resume` via `onRejoined`.
- `main.js`: third authority path `activeNetGame` beside solo; splash/lobby DOM rewired to the
  WS session (`?room=` share links, `?ws=`/`window.LL_WS_URL` override); PeerJS left in place but
  unwired (deleted at Step 8). `window.__llNet` test hook drives e2e.
- `src/js/net/ws-testing.js` + `tests/net-ws/` (6 suites, 12 tests): failure-mode intent ported to
  the real loopback server — full-flow convergence, idempotent duplicate frames, socket-destroy
  rejoin + snapshot adoption, stale/behind clients, **seat-binding rejection (new hardening
  suite)**, skipped-turn. Artificial reorder/drop stays fake-hub-only (TCP is ordered).
- `tests/server/` (9 tests): lobby/token auth, spoofing, oversized frame (1009), rate limit
  (1008), `maxRooms`, real-socket mini game with hash convergence, rejoin + `reconnect()`.
- Deploy: `ops/systemd/lordlandlord.service` (hardened, `DynamicUser=yes`) + `server/README.md`
  with Tailscale Funnel steps. Not yet enabled on the box.
- **Verified (2026-07-04):** `npx vitest run` → **219/219** (22 files; 198 baseline + 21 new);
  `npm run test:e2e` → two-browser Playwright game to a winner in 82 driver steps, hash
  convergence, zero page/console errors; `node tests/e2e/solo-smoke.mjs` → solo board renders,
  zero errors; `node server/index.js` boot check binds 18181.

---

## Part 2 — Remaining work

### Step 7 — Reconnect & resume (browser-side polish)
Mostly proven at the net layer (client `reconnect()`, writer rebuild from Accepted log). Remaining
is UX: page refresh re-joins via stored room/seat token, "reconnecting…" indicator, and a
disconnected-seat banner for others. No host migration needed — the server is the authority.

### Step 8 — Cleanup
- Delete legacy `engine.js` wrappers (`initGameState`, `startTurn`, … singleton bindings) and
  migrate the old tests to the state-first API.
- Remove the live `window.__game` mutation handle (read-only clone only) and the PeerJS
  `multiplayer.js` path + its CDN script tag.
- Fold `enumerateLegalActionsS`'s body into `core/legal.js` proper.
- `initGameStateS` seed-fallback tightening; drop the unseeded `generateDeck` fallback.

### Suggested order
6b → 7 → 8. Each step ships green on the full suite before the next; 6b is the first point
where two phones on different networks can actually play against the new stack.
