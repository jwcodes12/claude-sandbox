// net/testing.js — a test harness that wires a writer + N clients onto one hub.
//
// makeGame builds a byte-identical starting position on the writer and on every
// client (same seed, same players, version 0), then exposes the handful of
// helpers the six net suites need: submit through a seat's client, perturb the
// hub, flush, and assert convergence (all hashes equal the writer's).
//
// The WRITER is the source of truth for "who acts next" and "what is legal",
// exactly as production would be: clients only mirror accepted actions.

import { createInitialState } from '../core/state.js';
import { enumerateLegalActions } from '../core/legal.js';
import { playerHasPendingReactionS } from '../engine.js';
import { createHub } from './transport.js';
import { createWriter } from './writer.js';
import { createClient, makeIdSource } from './client.js';

export function makeGame({ seed, players, humanSeats = null }) {
    const playerCount = typeof players === 'number'
        ? players
        : (players || []).length;

    const hub = createHub({ seed });
    const writer = createWriter({ seed, players, channel: hub.connect('writer') });

    const clients = [];
    for (let i = 0; i < playerCount; i++) {
        clients[i] = createClient({
            seat: i,
            channel: hub.connect('c' + i),
            state: createInitialState(seed, players),   // byte-identical to writer at v0
            clientId: 'c' + i,
            idSource: makeIdSource('c' + i)
        });
    }

    const hashes = () => [writer.hashOf(), ...clients.map(c => c.hashOf())];
    const converged = () => {
        const [w, ...cs] = hashes();
        return cs.every(h => h === w);
    };

    // Whose move it is, read from the WRITER's state (source of truth).
    // Returns { seat, phase } with phase 'react' | 'discard' | 'turn', or null.
    function pendingActor() {
        const s = writer.getState();
        if (s.winner != null) return null;
        if (s.pendingAction) {
            const reactors = s.players.map(p => p.id)
                .filter(id => playerHasPendingReactionS(s, id));
            if (reactors.length === 0) return null;
            const seat = reactors.includes(s.reactionTargetId)
                ? s.reactionTargetId
                : reactors[0];
            return { seat, phase: 'react' };
        }
        if (s.mustDiscard > 0) return { seat: s.turn, phase: 'discard' };
        return { seat: s.turn, phase: 'turn' };
    }

    const legalFor = (seat) => enumerateLegalActions(writer.getState(), seat);

    // Drive the game to completion (or maxSteps) via a policy. On each step the
    // current actor's client submits an action, then the hub flushes fully so
    // the writer applies it and everyone catches up before the next step.
    function playOut({ policy, maxSteps = 100000 } = {}) {
        let steps = 0;
        while (steps++ < maxSteps) {
            const actor = pendingActor();
            if (!actor) break;
            const { seat, phase } = actor;
            const legal = legalFor(seat);
            let action = policy ? policy(writer.getState(), seat, legal) : null;
            if (!action) {
                if (phase === 'react') action = legal.find(a => a.type === 'concede') || null;
                else if (phase === 'discard') action = legal.find(a => a.type === 'discard') || null;
                else action = legal.find(a => a.type === 'end-turn') || null;
            }
            if (!action) break; // nothing to do (defensive; shouldn't happen)
            clients[seat].submit(action);
            hub.flush();
        }
        return writer.getState();
    }

    return {
        writer,
        clients,
        hub,
        flush: () => hub.flush(),
        hashes,
        converged,
        pendingActor,
        legalFor,
        playOut
    };
}
