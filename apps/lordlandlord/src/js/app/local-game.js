// app/local-game.js — single-process game orchestrator (Step 5a).
//
// Owns exactly one authoritative `state` and is the ONLY thing that writes it,
// always through the pure reducer. Humans and bots go through the same path:
// an action + a seat id -> reduce -> new state. There is no direct mutation and
// no second writer, which is what removes the local desync class even before a
// network writer exists.
//
// It is deliberately DOM-free and framework-free so it can be unit-tested by
// autoplaying whole games. Bot "IQ" is injected as a `policy` so the loop logic
// (whose turn, reaction chains, auto-end, winner) is tested independently of how
// clever the bots are; the browser layer (Step 5b) supplies the real policy and
// an onChange renderer, and drives pacing with its own timers.

import { reduce } from '../core/reducer.js';
import { clone } from '../core/state.js';
import { enumerateLegalActions } from '../core/legal.js';
import { playerHasPendingReactionS } from '../engine.js';

// A policy chooses a seat's action given the current state and its legal moves:
//   policy(state, playerId, legalActions) -> action | null
// Returning null means "nothing deliberate": on a normal turn that becomes an
// end-turn, in a reaction it becomes a concede, in a forced discard it becomes
// discarding the first legal card. The controller attaches playerId itself.

export function createLocalGame({ state, humanSeats = [0], policy, onChange = null }) {
    if (!state) throw new Error('createLocalGame: state is required');
    if (typeof policy !== 'function') throw new Error('createLocalGame: policy is required');

    const humans = new Set(humanSeats);
    let current = state;

    const isHuman = (seat) => humans.has(seat);
    const emitChange = () => { if (onChange) onChange(current); };

    // Who must act right now, or null if the game is waiting on a human / over.
    // Returns { seat, phase } where phase is 'react' | 'discard' | 'turn'.
    function pendingActor() {
        if (current.winner != null) return null;
        if (current.pendingAction) {
            // Prefer the derived reactionTargetId; fall back to the lowest
            // unsettled reactor. Deterministic either way.
            const reactors = current.players
                .map(p => p.id)
                .filter(id => playerHasPendingReactionS(current, id));
            if (reactors.length === 0) return null; // nothing to do; shouldn't happen
            const seat = reactors.includes(current.reactionTargetId)
                ? current.reactionTargetId
                : reactors[0];
            return { seat, phase: 'react' };
        }
        if (current.mustDiscard > 0) return { seat: current.turn, phase: 'discard' };
        return { seat: current.turn, phase: 'turn' };
    }

    // Apply one action for a seat. Returns true if the state actually advanced.
    function applyFor(seat, action) {
        if (!action) return false;
        const prev = current;
        current = reduce(prev, { ...action, playerId: seat });
        const changed = current !== prev;
        if (changed) emitChange();
        return changed;
    }

    // Ask the policy for a bot's move in the given phase and coerce null into a
    // sensible default so a passive/holding policy can never stall the loop.
    function botMove(seat, phase) {
        const legal = enumerateLegalActions(current, seat);
        const chosen = policy(current, seat, legal);
        if (chosen) return chosen;
        if (phase === 'react') return legal.find(a => a.type === 'concede') || null;
        if (phase === 'discard') return legal.find(a => a.type === 'discard') || null;
        return legal.find(a => a.type === 'end-turn') || null;
    }

    // Drive the game forward until it is a human's move (or the game is over).
    // Bots act automatically; a human turn with no actions left auto-ends, just
    // like the old update() loop, so control returns to the humans only when
    // they genuinely have a decision to make.
    function advance() {
        // Guard against a misbehaving policy that keeps returning no-op actions.
        let guard = 0;
        const GUARD_MAX = 100000;
        while (guard++ < GUARD_MAX) {
            const actor = pendingActor();
            if (!actor) return;                       // game over / stuck-empty
            const { seat, phase } = actor;

            if (isHuman(seat)) {
                // A human turn with nothing left to do auto-ends the turn.
                if (phase === 'turn' &&
                    current.actionsLeft <= 0 &&
                    current.pendingAction === null &&
                    current.mustDiscard === 0) {
                    if (!applyFor(seat, { type: 'end-turn' })) return;
                    continue;
                }
                return; // wait for the human to submit
            }

            if (!applyFor(seat, botMove(seat, phase))) {
                // No legal/effective move for a bot — nothing more we can do
                // without risking an infinite loop.
                return;
            }
        }
        throw new Error('local-game: advance() exceeded its step guard');
    }

    return {
        // Read-only view of the authoritative state (external callers get a copy
        // so they can never mutate the source of truth by reference).
        getState() { return clone(current); },
        // Internal/live handle — used by the browser layer's renderer, which
        // treats it as read-only. Avoids cloning on every render frame.
        peek() { return current; },

        // A human seat submits an action; bots then play out any consequences.
        // Only valid when a human is on the clock, and (if the action names a
        // seat) only for that human — you can't act for someone else.
        submit(action) {
            const actor = pendingActor();
            if (!actor) return false;
            if (!isHuman(actor.seat)) return false;   // not a human's move
            if (action && action.playerId != null && action.playerId !== actor.seat) return false;
            const changed = applyFor(actor.seat, action);
            advance();
            return changed;
        },

        // Kick the loop (e.g. at game start so seat-0-is-a-bot games begin, or
        // when the opening actor is a bot).
        start() { advance(); return current; },
        advance() { advance(); return current; },

        whoseTurn() { return pendingActor(); },
        isOver() { return current.winner != null; },
        winner() { return current.winner; }
    };
}
