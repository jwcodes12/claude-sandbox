// tests/net/reconnect.test.js
//
// FAILURE MODE PINNED: "refresh or wifi blip -> stuck / game hangs".
//
// Two independent recovery paths must never leave the game wedged:
//
//   1. CLIENT blip. A seat is partitioned mid-game (a refresh / dropped wifi),
//      the table keeps moving through the OTHER seats, then the seat comes back
//      and calls reconnect(). It must (a) catch up to the authoritative version
//      (via the writer's Resume -> Snapshot and/or the held Accepteds), (b) NOT
//      snap backwards when the stale in-flight messages finally arrive, and
//      (c) be able to submit a legal action that the writer ACCEPTS — i.e. the
//      game continues, it does not hang.
//
//   2. WRITER death. The single authority is killed and recreated purely from
//      its Accepted log (equivalently a snapshot). The reconstructed writer must
//      be byte-identical to the one that died (same version, same hash), a fresh
//      client must be able to Resume onto it, and the next legal action must be
//      accepted so play continues with no stall.
//
// Everything is seeded; there is no Math.random / Date.now. Actions submitted are
// REAL legal actions enumerated from state (so the scenario is realistic); the
// only hand-crafted deliveries are the deliberately stale ones (that is exactly
// what the "arrives late after a blip" case is about).

import { describe, it, expect } from 'vitest';

import { createInitialState } from '../../src/js/core/state.js';
import { enumerateLegalActions } from '../../src/js/core/legal.js';
import { hashState } from '../../src/js/core/replay.js';
import { createRng } from '../../src/js/core/rng.js';

import { makeGame } from '../../src/js/net/testing.js';
import { createHub } from '../../src/js/net/transport.js';
import { createWriter } from '../../src/js/net/writer.js';
import { createClient, makeIdSource } from '../../src/js/net/client.js';
import { request } from '../../src/js/net/protocol.js';

const PLAYERS = 3;

// A deterministic bot policy (mirrors tests/local-game.test.js): prefer doing
// something over ending the turn, always concede reactions, discard first when
// forced. Seeded => a given seed yields a repeatable game.
function makePolicy(seed) {
    const rng = createRng(seed >>> 0);
    return (state, playerId, legal) => {
        if (!legal.length) return null;
        const concede = legal.find(a => a.type === 'concede');
        if (concede || legal.some(a => a.type === 'react-no')) return concede || null;
        const discard = legal.find(a => a.type === 'discard');
        if (state.mustDiscard > 0 && discard) return discard;
        const nonEnd = legal.filter(a => a.type !== 'end-turn');
        const pool = (nonEnd.length && rng.next() < 0.85) ? nonEnd : legal;
        return pool[Math.floor(rng.next() * pool.length)];
    };
}

// Phase-appropriate fallback when a policy declines.
function defaultFor(phase, legal) {
    if (phase === 'react') return legal.find(a => a.type === 'concede') || null;
    if (phase === 'discard') return legal.find(a => a.type === 'discard') || null;
    return legal.find(a => a.type === 'end-turn') || null;
}

// Pick any legal action the writer will accept, preferring one with a visible,
// non-targeting effect (play-to-bank never triggers another seat's reaction).
function pickAction(legal, phase) {
    return (
        legal.find(a => a.type === 'play' && a.zone === 'bank') ||
        (phase === 'discard' && legal.find(a => a.type === 'discard')) ||
        (phase === 'react' && (legal.find(a => a.type === 'concede') || legal.find(a => a.type === 'react-no'))) ||
        legal.find(a => a.type === 'play') ||
        legal.find(a => a.type === 'end-turn') ||
        legal[0] ||
        null
    );
}

// Drive the authoritative writer forward through real, legal, seeded moves.
function driveWriter(g, steps, policy) {
    let n = 0;
    while (n < steps) {
        const actor = g.pendingActor();
        if (!actor) break;
        const legal = g.legalFor(actor.seat);
        let action = policy ? policy(g.writer.getState(), actor.seat, legal) : null;
        if (!action) action = defaultFor(actor.phase, legal);
        if (!action) break;
        g.clients[actor.seat].submit(action);
        g.flush();
        n++;
    }
}

// Advance the game ONLY through seats other than `avoidSeat`, using non-targeting
// actions (play-to-bank / end-turn) so `avoidSeat` is never forced to react while
// it is offline. Stops the instant it would be `avoidSeat`'s move.
function advanceAvoiding(g, avoidSeat, maxSteps) {
    let n = 0;
    while (n < maxSteps) {
        const actor = g.pendingActor();
        if (!actor) break;
        if (actor.seat === avoidSeat) break;
        const legal = g.legalFor(actor.seat);
        const action = pickAction(legal, actor.phase);
        if (!action) break;
        g.clients[actor.seat].submit(action);
        g.flush();
        n++;
    }
}

describe('net/reconnect — a partitioned client resumes and keeps playing (no hang)', () => {
    it('partition a seat, advance via others, reconnect -> converge -> submit accepted', () => {
        const SEED = 91117;
        const PART = 2; // the seat that "refreshes / drops wifi"

        const g = makeGame({ seed: SEED, players: PLAYERS });

        // The refresh: seat 2 goes offline. It can neither send nor receive; the
        // writer's broadcasts to it are HELD on the wire (not dropped).
        g.hub.partition('c' + PART);

        // The table keeps moving through seats 0 and 1 only.
        advanceAvoiding(g, PART, 40);

        const writerVer = g.writer.getVersion();
        expect(writerVer).toBeGreaterThan(0);        // the world actually moved on
        expect(g.writer.getState().winner).toBeNull(); // ...but the game isn't over

        // The offline seat learned NOTHING and is stuck behind; its inbound
        // Accepteds are queued (held), waiting for it to come back.
        expect(g.clients[PART].getVersion()).toBe(0);
        expect(g.hub.pending()).toBeGreaterThan(0);

        // The seats that stayed online are fully caught up with the writer.
        expect(g.clients[0].getVersion()).toBe(writerVer);
        expect(g.clients[1].getVersion()).toBe(writerVer);

        // Wifi returns. The client asks to catch up (Resume) and the hub drains.
        g.hub.reconnect('c' + PART);
        g.clients[PART].reconnect();
        g.flush();

        // RECOVERED: the reconnected seat is exactly at the authoritative version
        // and hash — no hang, no snap-back, nothing left in flight for it.
        expect(g.clients[PART].getVersion()).toBe(writerVer);
        expect(g.clients[PART].hashOf()).toBe(g.writer.hashOf());
        expect(g.hub.pending()).toBe(0);
        expect(g.converged()).toBe(true);

        // And it is genuinely playable again: the reconnected seat is now to move
        // (we stopped advancing exactly at its turn). It submits a REAL legal
        // action; the writer ACCEPTS it and everyone converges one version higher.
        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        expect(actor.seat).toBe(PART);

        const before = g.writer.getVersion();
        const action = pickAction(g.legalFor(actor.seat), actor.phase);
        expect(action).not.toBeNull();

        g.clients[actor.seat].submit(action);
        g.flush();

        expect(g.writer.getVersion()).toBe(before + 1); // writer accepted its move
        expect(g.clients[PART].getVersion()).toBe(before + 1);
        expect(g.converged()).toBe(true);
        expect(g.clients.every(c => c.getVersion() === g.writer.getVersion())).toBe(true);
    });

    it('a client that LOST all messages catches up solely via the writer Snapshot, ignores the late stale Accepteds, and can act', () => {
        // This is the "drop its messages" reading: the blipped client receives
        // NONE of the in-flight Accepteds (it connects only after they were sent),
        // so its ONLY path back is Resume -> the writer's real Snapshot. Then the
        // stale Accepteds arrive late and must be ignored (no snap-back). Then it
        // must be able to submit a legal action the writer accepts.
        const SEED = 4242;
        const g = makeGame({ seed: SEED, players: PLAYERS });

        // Move the authoritative writer forward with real play.
        driveWriter(g, 8, makePolicy(SEED));
        const ver = g.writer.getVersion();
        expect(ver).toBeGreaterThanOrEqual(1);
        expect(g.writer.getState().winner).toBeNull();

        // Whose move it is now — the blipped client will take this seat.
        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        const seat = actor.seat;

        // A brand-new client for that seat, wired to the live hub AFTER the log
        // was produced, so it has genuinely seen none of versions 1..ver. It sits
        // at v0 with the byte-identical starting position.
        const chan = g.hub.connect('blip');
        const blip = createClient({
            seat,
            channel: chan,
            state: createInitialState(SEED, PLAYERS),
            clientId: 'blip',
            idSource: makeIdSource('blip')
        });
        expect(blip.getVersion()).toBe(0);
        expect(blip.hashOf()).toBe(hashState(createInitialState(SEED, PLAYERS)));

        // Resume: the REAL writer replies with a real Snapshot at the current
        // version/seat, and the REAL client adopts it in one jump.
        blip.reconnect();
        g.flush();
        expect(blip.getVersion()).toBe(ver);
        expect(blip.hashOf()).toBe(g.writer.hashOf());

        // A stale Accepted from early in the log now arrives late (the classic
        // "held message shows up after the snapshot"). It MUST be ignored: no
        // version regression, no state snap-back.
        const stale = g.writer.log[0];
        expect(stale.type).toBe('accepted');
        expect(stale.version).toBe(1);
        const inj = g.hub.connect('inj');
        inj.send(stale, 'blip');
        g.flush();
        expect(blip.getVersion()).toBe(ver);
        expect(blip.hashOf()).toBe(g.writer.hashOf());

        // Fully playable: submit a real legal action off the adopted snapshot;
        // the writer accepts it and the resumed client tracks the new version.
        const action = pickAction(enumerateLegalActions(blip.getState(), seat), actor.phase);
        expect(action).not.toBeNull();
        blip.submit(action);
        g.flush();
        expect(g.writer.getVersion()).toBe(ver + 1);
        expect(blip.getVersion()).toBe(ver + 1);
        expect(blip.hashOf()).toBe(g.writer.hashOf());
        expect(g.converged()).toBe(true); // the original seats tracked it too
    });
});

describe('net/reconnect — the single authority dies and is rebuilt from its Accepted log (no stall)', () => {
    it('recreate the writer from its log -> identical state -> a fresh client resumes and the game continues', () => {
        const SEED = 31337;

        // Phase A — a live game up to the crash point.
        const g = makeGame({ seed: SEED, players: PLAYERS });
        driveWriter(g, 7, makePolicy(SEED));

        const oldVer = g.writer.getVersion();
        const oldHash = g.writer.hashOf();
        const oldLog = g.writer.log.slice(); // the durable Accepted log
        expect(oldVer).toBeGreaterThanOrEqual(1);
        expect(oldLog.length).toBe(oldVer); // contiguous: one Accepted per version
        expect(g.writer.getState().winner).toBeNull();

        // The action that WOULD have come next, captured before the crash.
        const actor = g.pendingActor();
        expect(actor).not.toBeNull();
        const nextAction = pickAction(g.legalFor(actor.seat), actor.phase);
        expect(nextAction).not.toBeNull();

        // Phase B — the writer process is killed and recreated on a fresh
        // transport, rebuilt purely by replaying its Accepted log (each logged
        // action fed back in as a Request, in version order).
        const hub2 = createHub({ seed: SEED });
        const writer2 = createWriter({ seed: SEED, players: PLAYERS, channel: hub2.connect('writer') });
        const feeder = hub2.connect('feeder');
        for (const acc of oldLog) {
            feeder.send(request({ ...acc.action }), 'writer');
            hub2.flush();
        }

        // RECOVERED authority is byte-identical to the one that died.
        expect(writer2.getVersion()).toBe(oldVer);
        expect(writer2.hashOf()).toBe(oldHash);

        // Phase C — a fresh client resumes onto the recovered writer. Because it
        // connected after replay, it has no held Accepteds: its catch-up is the
        // recovered writer's Snapshot alone.
        const seat = actor.seat;
        const client2 = createClient({
            seat,
            channel: hub2.connect('c' + seat),
            state: createInitialState(SEED, PLAYERS),
            clientId: 'c' + seat,
            idSource: makeIdSource('recov')
        });
        client2.reconnect();
        hub2.flush();
        expect(client2.getVersion()).toBe(oldVer);
        expect(client2.hashOf()).toBe(oldHash);

        // The game CONTINUES past the crash: the next legal action is accepted and
        // the resumed client advances with the writer — no stall.
        client2.submit(nextAction);
        hub2.flush();
        expect(writer2.getVersion()).toBe(oldVer + 1);
        expect(client2.getVersion()).toBe(oldVer + 1);
        expect(client2.hashOf()).toBe(writer2.hashOf());

        // And it keeps going for several more real moves without wedging. Each
        // seat's move is fed to the recovered writer as a Request (playerId is the
        // acting seat); we stop at any reaction to keep the driver simple.
        const mover = hub2.connect('mover');
        for (let i = 0; i < 5; i++) {
            const s = writer2.getState();
            if (s.winner != null || s.pendingAction) break;
            const seatToMove = s.turn;
            const phase = s.mustDiscard > 0 ? 'discard' : 'turn';
            const mv = pickAction(enumerateLegalActions(s, seatToMove), phase);
            if (!mv) break;
            mover.send(request({ id: 'mv#' + i, playerId: seatToMove, ...mv }), 'writer');
            hub2.flush();
        }
        // Whatever happened, the recovered authority is internally consistent:
        // one Accepted logged per version bump.
        expect(writer2.log.length).toBe(writer2.getVersion());
        expect(writer2.getVersion()).toBeGreaterThanOrEqual(oldVer + 1);
    });
});
