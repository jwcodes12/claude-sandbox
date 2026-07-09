# Real-device WebSocket test plan — Mac (+ iPhone) vs the OCI box

**Date:** 2026-07-08 · **Branch:** `session/20260703-lordlandlord-netlayer` (PR #14) · **Box:** `claude-code-dev-1` (tailscale `100.82.110.116`, MagicDNS `claude-code-dev-1.tail995b4a.ts.net`)

Goal: play real games from your Mac (and ideally iPhone on cellular — a genuinely
different network) against the WebSocket server on the box, and confirm no sync
or UI bugs that the automated suites can't see (real touch input, real Safari,
real network weather).

---

## 1. What automation already covers (so you don't re-test it)

- `npx vitest run` → 221/221 (engine, reducer, net layer, server hardening).
- Two-browser Playwright game to a winner with hash convergence.
- Refresh-resume, blip-resume, and two-tab displacement e2e (3 scenarios).
- **Chaos soak** (`npm run test:e2e:chaos`): 5 configs — 3 and 4 players, each
  player behind its own latency proxy (10–500 ms + jitter), ~75 disruptions
  (reloads / socket kills / blackholes / spikes), zero divergences, zero
  DOM-vs-state oracle violations.

What ONLY a human on real devices can check: touch/drag feel, Safari/iOS
quirks, real wifi↔cellular transitions, and "does it *look* right" beyond the
counters the oracle compares.

### Known UI issues already found (fixes in flight — do NOT spend time re-reporting)
1. False game-over overlay when your 3rd set completes off-turn (winner is
   turn-gated in the engine; renderer disagrees).
2. Payment picker: tapping the backdrop dismisses it with no way to reopen.
3. Stale resolution toast can re-fire; attacker "let it stand" shows a bogus
   payment picker; scroll position yanks on remote actions; tap-selection
   cleared by any redraw (pre-existing render-path debt, being fixed).

---

## 2. Start the stack on the box

```bash
ssh opc@100.82.110.116        # or your usual alias
cd /home/opc/claude-sandbox/apps/lordlandlord

# one tmux session, two panes (survives you closing the laptop):
tmux new -s ll -d
tmux send-keys -t ll 'cd /home/opc/claude-sandbox/apps/lordlandlord && LL_HTTP_HOST=100.82.110.116 node serve.js' C-m
tmux split-window -t ll
tmux send-keys -t ll 'cd /home/opc/claude-sandbox/apps/lordlandlord && node server/index.js' C-m
```

- Static site: `http://100.82.110.116:18180` (binds the tailscale IP via `LL_HTTP_HOST`)
- WS server: `:18181` (binds all interfaces; `tailscale0` is a trusted firewall zone, so tailnet-only reachability — nothing public)

Stop later with `tmux kill-session -t ll`.

## 3. Connect from your devices

**Option A — tailnet direct (recommended, zero extra config).**
Mac and iPhone are already on your tailnet. Open:

```
http://100.82.110.116:18180/
```

That's it — the page auto-targets `ws://100.82.110.116:18181` (same hostname).
Works on iPhone Safari too as long as Tailscale is connected (cellular is fine
and is exactly the cross-network case we want).

**Option B — SSH tunnel (if tailscale is off on the Mac).**
```bash
ssh -L 18180:localhost:18180 -L 18181:localhost:18181 opc@<box>
# then browse http://localhost:18180 on the Mac
```
Single-machine only; use two different browsers (Chrome + Safari) as the two
players — two tabs of the SAME profile will trigger seat displacement by design.

**Option C — HTTPS via `tailscale serve` (only if a device insists on TLS).**
```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:18180
sudo tailscale serve --bg --https=8443 http://127.0.0.1:18181
# URL: https://claude-code-dev-1.tail995b4a.ts.net/?ws=wss://claude-code-dev-1.tail995b4a.ts.net:8443
# undo: sudo tailscale serve reset
```
(Tailnet-only; NOT the public Funnel.)

## 4. Test checklist (~20 min)

Setup: Mac Chrome = Alice (create realm), iPhone Safari on **cellular** = Bob
(join via the share link — copy it from the lobby). A third player from Mac
Safari is a bonus.

**Happy path**
- [ ] Create realm on Mac; share link opens the join form pre-filled on iPhone.
- [ ] Both seats show in lobby with names; start; both land on the board.
- [ ] Play ~10 turns: drag to bank/board/discard, a rent/charge with payment,
      a Just-Say-No reaction, a steal (Sly Steal / Forced Trade).
- [ ] After every remote action, both screens agree: opponent hand counts
      (`H:n`), gold, actions counter, whose turn.

**Resilience (each on the phone unless noted)**
- [ ] Refresh mid-game → lands back in the SAME seat, board caught up.
- [ ] Airplane-mode flip for ~10 s mid-game → Mac shows the
      "disconnected — waiting" banner; phone shows "reconnecting…"; both clear
      by themselves; play continues; no snapped-back cards.
- [ ] Lock the phone 1–2 min, unlock → resumes (or rejoins via the banner path).
- [ ] Mac: open the game in a second tab → old tab yields with "seat is now
      played in another tab", new tab plays on; NO flapping between tabs.
- [ ] Finish a game → winner screen on both; refresh after game over lands on
      the splash (not a dead rejoin).

**Feel / UI (the part automation can't judge)**
- [ ] Touch drag on iPhone: card follows finger, drop zones highlight, no
      stuck drag after an interrupted gesture.
- [ ] Reaction modal appears promptly on the defender when charged; buttons
      respond; no dead modal left after resolution.
- [ ] Nothing important is rendered under the notch/home indicator.

## 5. Report

Append results here (or tell Claude and it will):

```
### Run YYYY-MM-DD HH:MM
Devices: <Mac Chrome …, iPhone Safari cellular …>
Happy path: PASS/FAIL notes…
Resilience: PASS/FAIL notes…
Feel/UI:    notes…
Bugs: <steps → expected vs actual, which device/screen>
```

Anything reproducible: note the step sequence + which seat acted; the server
log in tmux pane 2 and the browser console are the two things worth grabbing.
