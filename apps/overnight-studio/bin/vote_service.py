#!/usr/bin/env python3
"""Overnight Studio vote service. Tiny stdlib HTTP server, localhost only.

nginx proxies /api/ on the public *.studio vhost to 127.0.0.1:8377, so from a
browser this is same-origin over HTTPS (CF terminates TLS). Writes John's
thumbs to the same sqlite the scoreboard uses.

Endpoints:
  GET  /api/health           -> {"ok": true}
  GET  /api/votes?slug=SLUG  -> {"slug","up","down","score"}   (omit slug -> all)
  POST /api/vote  {slug, vote}  vote in {1,-1}  -> {"ok","up","down"}
"""
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DB = os.environ.get("STUDIO_DB", "/home/studio/data/studio.sqlite")
HOST = "127.0.0.1"
PORT = int(os.environ.get("STUDIO_VOTE_PORT", "8377"))


def db():
    con = sqlite3.connect(DB, timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=3000")
    return con


def tally(con, slug):
    row = con.execute(
        "SELECT COALESCE(SUM(vote=1),0) up, COALESCE(SUM(vote=-1),0) down "
        "FROM votes WHERE slug=? AND source='john'",
        (slug,),
    ).fetchone()
    up, down = row["up"], row["down"]
    return {"slug": slug, "up": up, "down": down, "score": up - down}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # keep journald quiet; nginx has the access log
        pass

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path in ("/api/health", "/health"):
            return self._send(200, {"ok": True})
        if path in ("/api/votes", "/votes"):
            q = parse_qs(u.query)
            slug = (q.get("slug") or [None])[0]
            try:
                con = db()
                if slug:
                    return self._send(200, tally(con, slug))
                rows = con.execute(
                    "SELECT slug, COALESCE(SUM(vote=1),0) up, COALESCE(SUM(vote=-1),0) down "
                    "FROM votes WHERE source='john' GROUP BY slug"
                ).fetchall()
                return self._send(200, {"votes": [dict(r) for r in rows]})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            finally:
                try:
                    con.close()
                except Exception:
                    pass
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path not in ("/api/vote", "/vote"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0 or n > 4096:
                return self._send(400, {"error": "bad body"})
            data = json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        slug = str(data.get("slug", "")).strip()
        try:
            vote = int(data.get("vote"))
        except (TypeError, ValueError):
            vote = 0
        # slug must look like a real build slug; vote must be +/-1
        if not slug or len(slug) > 80 or not all(c.isalnum() or c in "-_" for c in slug):
            return self._send(400, {"error": "bad slug"})
        if vote not in (1, -1):
            return self._send(400, {"error": "vote must be 1 or -1"})
        try:
            con = db()
            con.execute(
                "INSERT INTO votes(slug, vote, source) VALUES(?,?, 'john')",
                (slug, vote),
            )
            con.commit()
            out = tally(con, slug)
            out["ok"] = True
            return self._send(200, out)
        except Exception as e:
            return self._send(500, {"error": str(e)})
        finally:
            try:
                con.close()
            except Exception:
                pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"studio vote service on http://{HOST}:{PORT} db={DB}", flush=True)
    srv.serve_forever()
