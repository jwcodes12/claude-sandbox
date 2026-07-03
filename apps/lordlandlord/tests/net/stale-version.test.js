// tests/net/stale-version.test.js
//
// FAILURE MODE PINNED: "a played card snaps back".
//
// Two ways a client's local mirror can regress an already-applied version:
//   1. OUT-OF-ORDER Accepteds. The hub delivers version N+1 / N+2 before the
//      missing version N. A naive client would apply them immediately (jumping
//      ahead / desyncing) or, worse, refuse and later re-apply out of order. The
//      contract says: BUFFER anything with version > appliedVersion+1, apply
//      nothing until the contiguous predecessor arrives, then DRAIN in order.
//   2. STALE Snapshot. After the client has advanced to a newer version, an
//      older Snapshot (or an old Accepted) arrives late. A naive client would
//      clone the old state and "snap back", un-playing cards. The contract says
//      version <= appliedVersion is IGNORED.
//
// This suite drives BOTH against the real client.js. To force an EXACT delivery
// order deterministically (the hub's deliverOne reorders by an internal RNG we
// don't want to reverse-engineer) we build a client on a controlled channel and
// hand it real Accepted/Snapshot messages — this is precisely what a reordering
// hub does at the client's receive boundary. Every message applied is a REAL
// writer ruling (from writer.log), so a fully drained client MUST hash-equal the
// authoritative writer state; that equality is the convergence assertion.

import { describe, it, expect } from 'vitest';

import { createInitialState } from '../../src/js/core/state.js';
import { reduce } from '../../src/js/core/reducer.js';
import { hashState } from '../../src/js/core/replay.js';

import { makeGame } from '../../src/js/net/testing.js';
import { createClient, makeIdSource } from '../../src/js/net/client.js';
import { snapshot } from '../../src/js/net/protocol.js';

const SEED = 20260702;
const PLAYERS = 3;

// Drive the authoritative writer through real, legal actions and return the
// makeGame handle. writer.log is then an ordered Accepted list at versions
// 1,2,3,... (contiguous — each accepted bumps state.version by exactly 1).
// We prefer 'end-turn' so the game keeps rotating without anyone winning, which
// guarantees a long enough log for the reordering windows below.
function driveWriter(seed, players, steps) {
    const g = makeGame({ seed, players });
    let n = 0;
    while (n < steps) {
        const actor = g.pendingActor();
        if (!actor) break;
        const legal = g.legalFor(actor.seat);
        const action =
            legal.find(a => a.type === 'end-turn') ||
            legal.find(a => a.type === 'play') ||
            legal[0];
        if (!action) break;
        g.clients[actor.seat].submit(action);
        g.flush();
        n++;
    }
    return g;
}

// Rebuild the authoritative state as it was AT a given version by replaying the
// first `upto` accepted actions on a fresh initial state (same seed/players).
// Used to synthesise Snapshots at specific past/newer versions.
function stateAtVersion(seed, players, log, upto) {
    let s = createInitialState(seed, players);
    for (let i = 0; i < upto; i++) s = reduce(s, log[i].action);
    return s;
}

// A fresh client wired to a channel we fully control: we capture its onMessage
// callback and deliver messages in whatever order the test dictates.
function controlledClient(seed, players) {
    let cb = null;
    const channel = {
        send() {},
        onMessage(fn) { cb = fn; },
        close() {}
    };
    const client = createClient({
        seat: 0,
        channel,
        state: createInitialState(seed, players),
        clientId: 'c0',
        idSource: makeIdSource('c0')
    });
    return { client, deliver: (msg) => cb(msg) };
}

describe('net/stale-version — out-of-order Accepteds & stale Snapshots (no snap-back)', () => {
    it('baseline: the writer produced a contiguous Accepted log and clients converged', () => {
        const g = driveWriter(SEED, PLAYERS, 12);
        const log = g.writer.log;
        expect(log.length).toBeGreaterThanOrEqual(6);
        // versions are strictly contiguous 1..K
        log.forEach((acc, i) => expect(acc.version).toBe(i + 1));
        expect(g.writer.getVersion()).toBe(log.length);
        // the harness's own clients caught up
        expect(g.converged()).toBe(true);
    });

    it('holds N+1/N+2 out of order (applies NOTHING) then drains contiguously when N arrives', () => {
        const g = driveWriter(SEED, PLAYERS, 12);
        const log = g.writer.log;
        expect(log.length).toBeGreaterThanOrEqual(6);

        const [v1, v2, v3] = [log[0], log[1], log[2]];
        expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);

        const { client, deliver } = controlledClient(SEED, PLAYERS);
        const initialHash = hashState(createInitialState(SEED, PLAYERS));
        expect(client.getVersion()).toBe(0);
        expect(client.hashOf()).toBe(initialHash);

        // Deliver N+1 and N+2 BEFORE N. These must be buffered, not applied:
        // appliedVersion stays 0 and the state does not move at all.
        deliver(v2);
        expect(client.getVersion()).toBe(0);
        expect(client.hashOf()).toBe(initialHash);

        deliver(v3);
        expect(client.getVersion()).toBe(0);
        expect(client.hashOf()).toBe(initialHash);

        // Release N. The client applies v1, then drains the buffered v2, v3 in
        // contiguous version order in one shot.
        deliver(v1);
        expect(client.getVersion()).toBe(3);
        expect(client.hashOf()).toBe(hashState(stateAtVersion(SEED, PLAYERS, log, 3)));

        // Deliver the remainder in order and converge on the writer.
        for (let i = 3; i < log.length; i++) deliver(log[i]);
        expect(client.getVersion()).toBe(g.writer.getVersion());
        expect(client.hashOf()).toBe(g.writer.hashOf());
    });

    it('a duplicated Accepted for an already-applied version does not double-apply', () => {
        const g = driveWriter(SEED, PLAYERS, 12);
        const log = g.writer.log;
        const { client, deliver } = controlledClient(SEED, PLAYERS);

        // Apply v1..v3 in order.
        deliver(log[0]);
        deliver(log[1]);
        deliver(log[2]);
        expect(client.getVersion()).toBe(3);
        const hashAt3 = client.hashOf();

        // A verbatim re-delivery of v2 and v3 (version <= appliedVersion, and a
        // seen id) must be ignored — no re-apply, no snap.
        deliver(log[1]);
        deliver(log[2]);
        expect(client.getVersion()).toBe(3);
        expect(client.hashOf()).toBe(hashAt3);

        // Finish and converge.
        for (let i = 3; i < log.length; i++) deliver(log[i]);
        expect(client.getVersion()).toBe(g.writer.getVersion());
        expect(client.hashOf()).toBe(g.writer.hashOf());
    });

    it('ignores a STALE Snapshot delivered after a newer one — the played card does not snap back', () => {
        const g = driveWriter(SEED, PLAYERS, 12);
        const log = g.writer.log;
        expect(log.length).toBeGreaterThanOrEqual(6);

        const { client, deliver } = controlledClient(SEED, PLAYERS);

        // Advance the client to version 5 via a Snapshot (as a Resume reply would).
        const newer = snapshot({
            version: 5,
            seat: 0,
            state: stateAtVersion(SEED, PLAYERS, log, 5)
        });
        deliver(newer);
        expect(client.getVersion()).toBe(5);
        const hashAt5 = client.hashOf();
        expect(hashAt5).toBe(hashState(stateAtVersion(SEED, PLAYERS, log, 5)));

        // A STALE Snapshot at version 2 arrives late. It MUST be ignored: no
        // regression of appliedVersion, no state snap-back.
        const older = snapshot({
            version: 2,
            seat: 0,
            state: stateAtVersion(SEED, PLAYERS, log, 2)
        });
        deliver(older);
        expect(client.getVersion()).toBe(5);
        expect(client.hashOf()).toBe(hashAt5);

        // A STALE Accepted (version 2 <= appliedVersion 5) must also be ignored.
        deliver(log[1]);
        expect(client.getVersion()).toBe(5);
        expect(client.hashOf()).toBe(hashAt5);

        // Resume live from v6 (contiguous with the snapshot) and converge on the writer.
        for (let i = 5; i < log.length; i++) deliver(log[i]);
        expect(client.getVersion()).toBe(g.writer.getVersion());
        expect(client.hashOf()).toBe(g.writer.hashOf());
    });

    it('combined: buffered future versions survive a stale Snapshot and still drain to the writer', () => {
        const g = driveWriter(SEED, PLAYERS, 12);
        const log = g.writer.log;
        expect(log.length).toBeGreaterThanOrEqual(6);

        const { client, deliver } = controlledClient(SEED, PLAYERS);

        // Buffer v2 and v3 while stuck at v0.
        deliver(log[1]);
        deliver(log[2]);
        expect(client.getVersion()).toBe(0);

        // A stale Snapshot at version 0 arrives — must be ignored (version <= appliedVersion).
        deliver(snapshot({ version: 0, seat: 0, state: createInitialState(SEED, PLAYERS) }));
        expect(client.getVersion()).toBe(0);

        // Release v1: applies v1 then drains buffered v2, v3.
        deliver(log[0]);
        expect(client.getVersion()).toBe(3);

        for (let i = 3; i < log.length; i++) deliver(log[i]);
        expect(client.getVersion()).toBe(g.writer.getVersion());
        expect(client.hashOf()).toBe(g.writer.hashOf());
    });
});
