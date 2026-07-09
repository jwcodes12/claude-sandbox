// net/client.js — a client's local mirror of the authoritative state.
//
// A client never decides legality; it only mirrors what the writer accepted, in
// strict version order, so hashState(client) === hashState(writer) once caught
// up. Three guards remove the classic desync bugs:
//   - seen.has(id)              → a duplicated Accepted can't double-apply.
//   - version <= appliedVersion → a stale/replayed Accepted can't snap state
//                                 backwards.
//   - version >  appliedVersion+1 → an out-of-order Accepted is buffered until
//                                 the missing versions arrive, then drained in
//                                 contiguous order.
//
// Ids are minted by a deterministic per-client source (tag + counter), so there
// is NO Math.random / Date.now and two clients never collide ids.

import { clone } from '../core/state.js';
import { reduce } from '../core/reducer.js';
import { hashState } from '../core/replay.js';
import { request, resume } from './protocol.js';

// Deterministic id source: `${tag}#0`, `${tag}#1`, … Per-client tag ⇒ globally
// unique ids without any shared counter or randomness.
export function makeIdSource(tag) {
    let n = 0;
    return () => `${tag}#${n++}`;
}

export function createClient({
    seat,
    channel,
    state,
    clientId = `c${seat}`,
    idSource = makeIdSource(`c${seat}`)
}) {
    let appliedVersion = state.version || 0;
    const seen = new Set();           // applied intent ids (double-tap guard)
    const buffer = new Map();         // version -> Accepted (out-of-order hold)

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

    function onAccepted(msg) {
        const { version, id, action } = msg;
        if (seen.has(id) || version <= appliedVersion) return;   // double-tap + snap-back guard
        if (version === appliedVersion + 1) {
            state = reduce(state, action);
            appliedVersion = version;
            seen.add(id);
            drain();
        } else {
            buffer.set(version, msg);                            // out-of-order: hold
        }
    }

    function onSnapshot(msg) {
        if (msg.version <= appliedVersion) return;               // stale snapshot ignored
        state = clone(msg.state);
        appliedVersion = msg.version;
        for (const v of [...buffer.keys()]) if (v <= appliedVersion) buffer.delete(v);
        seen.clear();
        drain();
    }

    channel.onMessage(msg => {
        if (!msg) return;
        if (msg.type === 'accepted') onAccepted(msg);
        else if (msg.type === 'snapshot') onSnapshot(msg);
    });

    return {
        // Submit an intent for this seat. Mints a unique id, sends a Request to
        // the writer, and returns the id (so a test can hand-deliver / dup it).
        submit(partialAction) {
            const id = idSource();
            channel.send(request({ id, playerId: seat, ...partialAction }));
            return id;
        },
        // Ask the writer to catch us up from our current version.
        reconnect() {
            channel.send(resume({ clientId, seat, haveVersion: appliedVersion }));
        },
        hashOf() { return hashState(state); },
        getVersion() { return appliedVersion; },
        getState() { return clone(state); }
    };
}
