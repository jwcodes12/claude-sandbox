// core/legal.js — the single source of truth for what a player may do.
//
// enumerateLegalActions(state, playerId) is pure: it reads state and returns
// the list of allowed actions, enforcing turn ownership, the 3-action limit,
// the discard phase, and the reaction phase all in one place. The reducer
// rejects any action that isn't in this list, so legality lives here and
// nowhere else. The implementation currently lives in engine.js (alongside the
// rulebook it mirrors); this module is the core-layer entry point for it and
// will absorb the body outright in the Step 8 cleanup.
export { enumerateLegalActionsS as enumerateLegalActions } from '../engine.js';
