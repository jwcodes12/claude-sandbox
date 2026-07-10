// net/writer.js — the single authoritative writer.
//
// Holds ONE authoritative state (from createInitialState) and is the only thing
// that advances it, always through the pure reducer. It is transport-agnostic:
// it talks to the outside world only through a `channel { send, onMessage }`, so
// the same code runs behind the fake in-process hub in tests and behind a real
// WebSocket server in production ("server-vs-host" is just a transport swap).
//
// Idempotency + rejection are the two invariants that kill desync:
//   - A Request whose id was already applied is answered with the STORED
//     Accepted (a re-broadcast) — never re-applied, never bumps the version.
//   - A Request that reduce() rejects (illegal / out-of-turn / over-budget /
//     duplicate end-turn / no-op) is DROPPED: no version bump, no broadcast.
//   - A Request that applies bumps state.version (inside reduce) and broadcasts
//     Accepted{ version, id, action } to every client.

import { createInitialState, clone } from '../core/state.js';
import { reduce } from '../core/reducer.js';
import { hashState } from '../core/replay.js';
import { accepted, snapshot, actionFromRequest } from './protocol.js';

export function createWriter({ seed, players, channel, restoreState = null }) {
    // restoreState: resume a mid-game writer after a server restart — the
    // state is plain JSON, so a saved copy IS the writer's whole world.
    // (The idempotency sets start empty: pre-restart sockets are gone, and
    // post-restart intent ids are fresh — bots get re-salted tags, browsers
    // salt per pageload.)
    let state = restoreState ? clone(restoreState) : createInitialState(seed, players);
    const applied = new Set();        // intent ids that have been applied
    const byId = new Map();           // intent id -> the Accepted we broadcast
    const log = [];                   // ordered Accepted log (for resume/tests)

    function handleRequest(req) {
        if (req == null || req.id == null) return;

        // Already applied: re-broadcast the stored ruling; do NOT re-apply.
        if (applied.has(req.id)) {
            channel.send(byId.get(req.id));
            return;
        }

        const action = actionFromRequest(req);
        const next = reduce(state, action);
        if (next === state) return;   // illegal / out-of-turn / over-budget / no-op → drop

        state = next;                 // reduce already bumped version + stamped winner
        applied.add(req.id);
        const acc = accepted({ version: state.version, id: req.id, action });
        byId.set(req.id, acc);
        log.push(acc);
        channel.send(acc);            // broadcast Accepted to all clients
    }

    function handleResume(r) {
        // Reply with a full snapshot to the resuming client ONLY.
        channel.send(
            snapshot({ version: state.version, seat: r.seat, state: clone(state) }),
            r.clientId
        );
    }

    channel.onMessage(msg => {
        if (msg && msg.type === 'resume') handleResume(msg);
        else handleRequest(msg);
    });

    return {
        hashOf() { return hashState(state); },
        getVersion() { return state.version; },
        getState() { return clone(state); },
        log
    };
}
