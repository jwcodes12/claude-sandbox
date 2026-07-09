// net/protocol.js — wire message shapes for the authoritative net layer.
//
// Four message kinds travel over the transport:
//   Request  — a client's intent: a unique id + the fields the reducer needs.
//              Its `type` field is the ACTION type ('play','propose','react-no',
//              'concede','discard','end-turn'); routing distinguishes it from a
//              Resume purely by `type !== 'resume'` at the writer.
//   Accepted — the writer's ruling that a Request applied, at a given version
//              ({ type:'accepted', ... }).
//   Snapshot — the writer's full state, sent to one client on Resume
//              ({ type:'snapshot', ... }).
//   Resume   — a reconnecting client asking to catch up from haveVersion
//              ({ type:'resume', ... }).
//
// These are plain-data constructors (no classes, no behaviour) so a message is
// trivially JSON-serialisable and transport-agnostic. actionFromRequest strips
// a Request down to exactly what core/reducer.js reduce() consumes; the reducer
// matches legality on game fields and ignores the transport id, so the same
// shape drives both the writer's apply and every client's mirror.

export const MSG = Object.freeze({
    REQUEST: 'request',
    ACCEPTED: 'accepted',
    SNAPSHOT: 'snapshot',
    RESUME: 'resume'
});

// Note: a Request's envelope `type` is the ACTION type, not MSG.REQUEST. The
// writer routes on `type === 'resume'`; action types never collide with the
// 'resume'/'accepted'/'snapshot' envelope names, so no ambiguity arises.
export function request({ id, playerId, type, cardId, zone, targetPlayerId, options, againstReactorId, paidCardIds }) {
    return {
        type,
        id,
        playerId,
        cardId,
        zone,
        targetPlayerId,
        options,
        againstReactorId,
        paidCardIds
    };
}

export function accepted({ version, id, action }) {
    return { type: MSG.ACCEPTED, version, id, action };
}

export function snapshot({ version, seat, state }) {
    return { type: MSG.SNAPSHOT, version, seat, state };
}

export function resume({ clientId, seat, haveVersion }) {
    return { type: MSG.RESUME, clientId, seat, haveVersion };
}

// Build the reducer-input action from a Request. The reducer's isLegal matches
// only game fields (type, cardId, zone, targetPlayerId, options, againstReactorId)
// and reads playerId to know whose action it is; it ignores `id`.
export function actionFromRequest(req) {
    return {
        id: req.id,
        playerId: req.playerId,
        type: req.type,
        cardId: req.cardId,
        zone: req.zone,
        targetPlayerId: req.targetPlayerId,
        options: req.options,
        againstReactorId: req.againstReactorId,
        paidCardIds: req.paidCardIds
    };
}
