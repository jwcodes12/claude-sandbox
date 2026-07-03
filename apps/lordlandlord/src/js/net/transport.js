// net/transport.js — a deterministic, in-process message hub (star topology).
//
// One writer node plus N client nodes. Clients send only to the writer; the
// writer either broadcasts (no target) to all clients or unicasts (a target) to
// one client (the Resume→Snapshot reply). This fake stands in for a real
// WebSocket transport in tests: writer.js and client.js speak only the
// `channel { send, onMessage, close }` interface, so swapping this for a real
// socket transport leaves them unchanged.
//
// EVERYTHING random is drawn from ONE createRng(seed) stream in a FIXED order,
// so a given {seed} + call-sequence reproduces byte-identical delivery. There is
// NO Math.random / Date.now anywhere here; all ids (seq numbers) are counters.
//
// Draw order is load-bearing and must not be reordered:
//   send():        per target, in stable order — draw#1 (drop), then draw#2 (dup)
//   deliverOne():  draw#3 (which queued message inside the reorder window fires)

import { createRng } from '../core/rng.js';

export function createHub({ seed, writerId = 'writer' } = {}) {
    const nodes = new Map();          // id -> { cb, connected, partitioned }
    let queue = [];                   // [{ seq, from, to, msg }] in enqueue order
    const rng = createRng((seed ?? 0) >>> 0);
    let seqCounter = 0;
    const conditions = { reorderWindow: 1, dropRate: 0, duplicateRate: 0 };

    function clientIdsAsc() {
        return [...nodes.keys()].filter(id => id !== writerId).sort();
    }

    function resolveTargets(from, to) {
        if (to != null) return [to];
        if (from === writerId) return clientIdsAsc();
        return [writerId];
    }

    // Deliver `from`'s message to the resolved targets, applying drop/duplicate
    // per target. A partitioned sender drops everything (an offline node can't
    // put anything on the wire).
    function send(from, msg, to) {
        const fromNode = nodes.get(from);
        if (!fromNode || fromNode.partitioned) return;
        const targets = resolveTargets(from, to);
        for (const target of targets) {
            if (!nodes.has(target)) continue;
            // draw#1: drop?
            if (rng.next() < conditions.dropRate) continue; // dropped: no dup draw
            queue.push({ seq: seqCounter++, from, to: target, msg });
            // draw#2: duplicate? (a verbatim second copy at the tail)
            if (rng.next() < conditions.duplicateRate) {
                queue.push({ seq: seqCounter++, from, to: target, msg });
            }
        }
    }

    function isDeliverable(e) {
        const n = nodes.get(e.to);
        return !!n && n.connected && !n.partitioned;
    }

    // Deliver exactly one message. Picks within a reorder window at the head of
    // the deliverable queue: window size 1 ⇒ strict FIFO. Returns false when
    // nothing is currently deliverable (e.g. all remaining targets partitioned).
    function deliverOne() {
        const deliverable = queue.filter(isDeliverable);
        if (deliverable.length === 0) return false;
        const win = Math.max(1, conditions.reorderWindow);
        const window = deliverable.slice(0, win);
        // draw#3: choose which message in the window fires next.
        const pick = window[Math.floor(rng.next() * window.length)];
        queue = queue.filter(e => e !== pick);
        const node = nodes.get(pick.to);
        if (node && node.cb) node.cb(pick.msg);   // callback may enqueue more (lands at tail)
        return true;
    }

    return {
        connect(id) {
            nodes.set(id, { cb: null, connected: true, partitioned: false });
            return {
                send: (msg, target) => send(id, msg, target),
                onMessage: (cb) => { nodes.get(id).cb = cb; },
                close: () => {
                    const n = nodes.get(id);
                    if (n) n.connected = false;
                    queue = queue.filter(e => e.to !== id); // drop queued msgs to it
                }
            };
        },

        setConditions(partial = {}) {
            Object.assign(conditions, partial);
        },

        // Take a node offline: it neither sends nor receives, and messages
        // already queued to it are HELD (not dropped) until it reconnects — so
        // they arrive stale and the client's version guard ignores them.
        partition(id) {
            const n = nodes.get(id);
            if (n) n.partitioned = true;
        },

        // Bring a node back online. Does NOT resend anything; the client calls
        // its own reconnect() to send a Resume and adopt the writer's Snapshot.
        reconnect(id) {
            const n = nodes.get(id);
            if (n) n.partitioned = false;
        },

        flush() {
            let count = 0;
            while (deliverOne()) count++;
            return count;
        },

        deliverOne,
        pending() { return queue.length; }
    };
}
