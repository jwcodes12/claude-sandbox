# Lord Landlord WebSocket game server

The authoritative multiplayer server (Step 6b). One process hosts many rooms;
each started room runs a single `src/js/net/writer.js` writer behind a
server-side channel, so the wire behaviour is identical to the fake-hub test
harness: `accepted` broadcasts to every seat, `snapshot` unicast on `resume`.

## Run locally

```sh
cd apps/lordlandlord
npm run serve:ws          # node server/index.js, listens on LL_WS_PORT (default 18181)
```

Or embed it (tests do this):

```js
import { createGameServer } from './server/index.js';
const server = await createGameServer({ port: 0 });   // port 0 = pick a free port
console.log(server.port);
await server.close();
```

## Environment variables

| Variable     | Default | Meaning                          |
| ------------ | ------- | -------------------------------- |
| `LL_WS_PORT` | `18181` | TCP port the WebSocket server binds |

Everything else (room/connection caps, rate limit, heartbeat, empty-room TTL,
max payload) is an option to `createGameServer(opts)` — see the `DEFAULTS`
object at the top of `server/index.js`.

## Tests

```sh
cd apps/lordlandlord
npx vitest run tests/server
```

## systemd

A hardened unit lives at `ops/systemd/lordlandlord.service`
(DynamicUser, ProtectSystem=strict, read-only home, 512M memory cap):

```sh
sudo cp ops/systemd/lordlandlord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lordlandlord.service
journalctl -u lordlandlord.service -f
```

Note: `ExecStart` uses `/usr/bin/node`. If node lives elsewhere on the box
(e.g. Homebrew at `/home/linuxbrew/.linuxbrew/bin/node`), symlink it or adjust
`ExecStart` accordingly.

## Exposing over Tailscale Funnel

The server binds plain `ws://` on 18181; Tailscale Funnel terminates TLS and
gives you a public `wss://` endpoint:

```sh
tailscale funnel --bg 18181            # expose port 18181 at https://<machine>.<tailnet>.ts.net/
tailscale funnel status                # confirm the mapping
```

Clients then connect to `wss://<machine>.<tailnet>.ts.net/`. To stop exposing:

```sh
tailscale funnel --bg off 18181
```
