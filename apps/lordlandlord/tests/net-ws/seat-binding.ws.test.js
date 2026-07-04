// tests/net-ws/seat-binding.ws.test.js
//
// HARDENING SUITE (new; no fake-hub analogue): "a socket can only speak for
// the seat it is bound to".
//
// The fake hub trusted playerId; the real server must not. A seat-bound socket
// sending a game frame claiming ANOTHER seat's playerId (or a resume for
// another seat) gets {t:'err', code:'bad-frame'} and the writer never sees the
// frame. A connection that never joined a seat cannot inject game frames at
// all. Legitimate frames from the bound seat still flow.

import { describe, it, expect, afterEach } from 'vitest';
import { makeWsGame, connectSocket } from '../../src/js/net/ws-testing.js';
import { request, resume } from '../../src/js/net/protocol.js';
import { pickApplying } from './helpers.js';

const games = [];
const extras = [];
afterEach(async () => {
    while (extras.length) extras.pop().sock.terminate();
    while (games.length) await games.pop().close();
});

async function boot() {
    const g = await makeWsGame({ players: 2 });
    games.push(g);
    return g;
}

describe('ws seat-binding — spoofed and unbound game frames never reach the writer', () => {
    it('a bound socket spoofing another seat\'s playerId is rejected with err and dropped', async () => {
        const g = await boot();
        const v0Hash = g.writer.hashOf();

        // Seat 0's socket claims to be seat 1. end-turn WOULD apply for the
        // seat to move, so if the guard leaked, the writer would bump a version.
        g.sendRaw(0, request({ id: 'spoof#0', playerId: 1, type: 'end-turn' }));
        const err = await g.sockets[0].next('err');
        expect(err.code).toBe('bad-frame');

        await g.settle();
        expect(g.writer.getVersion()).toBe(0);          // nothing applied
        expect(g.writer.log.length).toBe(0);
        expect(g.writer.hashOf()).toBe(v0Hash);
        expect(g.converged()).toBe(true);
    });

    it('a bound socket spoofing another seat\'s resume is rejected (no snapshot leak)', async () => {
        const g = await boot();

        // Watch seat 1's raw socket: a leaked snapshot would arrive there (the
        // server unicasts snapshots to 'c'+seat's CURRENT socket).
        let snapshots = 0;
        for (const seat of [0, 1]) {
            g.sockets[seat].sock.on('message', (data) => {
                const m = JSON.parse(data.toString());
                if (m.type === 'snapshot') snapshots++;
            });
        }

        g.sendRaw(0, resume({ clientId: 'c1', seat: 1, haveVersion: 0 }));
        const err = await g.sockets[0].next('err');
        expect(err.code).toBe('bad-frame');

        await g.settle();
        expect(snapshots).toBe(0);                       // no seat got a snapshot
        expect(g.writer.getVersion()).toBe(0);
    });

    it('an unbound connection (never joined a seat) cannot inject game frames', async () => {
        const g = await boot();

        const lurker = await connectSocket(g.port);      // connected, never seated
        extras.push(lurker);
        lurker.send(request({ id: 'unbound#0', playerId: 0, type: 'end-turn' }));
        const err = await lurker.next('err');
        expect(err.code).toBe('bad-frame');

        lurker.send(resume({ clientId: 'c0', seat: 0, haveVersion: 0 }));
        expect((await lurker.next('err')).code).toBe('bad-frame');

        await g.settle();
        expect(g.writer.getVersion()).toBe(0);
        expect(g.writer.log.length).toBe(0);

        // And the legitimate path still works: the REAL seat 0 acts, the writer
        // applies it, and every mirror converges — the guard blocked only the
        // imposter, not the game.
        const action = pickApplying(g, 0);
        expect(action).not.toBeNull();
        g.clients[0].submit(action);
        await g.waitUntil(() => g.writer.getVersion() >= 1, { what: 'legit action to apply' });
        await g.settle();
        expect(g.writer.getVersion()).toBe(1);
        expect(g.converged()).toBe(true);
    });
});
