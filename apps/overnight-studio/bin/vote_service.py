#!/usr/bin/env python3
"""Overnight Studio vote + feedback service. Tiny stdlib HTTP, localhost only.

nginx proxies /api/ on the public studio vhost to 127.0.0.1:8377, so from a
browser this is same-origin over HTTPS. A "voter" is a browser-stored random id,
so a thumb is one toggleable vote per (slug, voter) — counts stay correct on
reload and the UI can show what you already picked.

Endpoints:
  GET  /api/health
  GET  /api/votes[?voter=ID]        -> {"votes":[{slug,up,down}], "mine":{slug:vote}}
  GET  /api/votes?slug=SLUG[&voter=] -> {slug,up,down,score,myvote}
  POST /api/vote     {slug, vote in {1,-1,0}, voter}  (0 = remove my vote)
  POST /api/feedback {slug, text, voter}
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


def valid_slug(s):
    return bool(s) and len(s) <= 80 and all(c.isalnum() or c in "-_" for c in s)


def valid_voter(s):
    return bool(s) and len(s) <= 64 and all(c.isalnum() or c in "-_" for c in s)


def tally(con, slug, voter=None):
    r = con.execute(
        "SELECT COALESCE(SUM(vote=1),0) up, COALESCE(SUM(vote=-1),0) down "
        "FROM votes WHERE slug=?", (slug,)).fetchone()
    out = {"slug": slug, "up": r["up"], "down": r["down"], "score": r["up"] - r["down"]}
    if voter:
        m = con.execute("SELECT vote FROM votes WHERE slug=? AND voter=?", (slug, voter)).fetchone()
        out["myvote"] = m["vote"] if m else 0
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > 8192:
            return None
        try:
            return json.loads(self.rfile.read(n).decode() or "{}")
        except Exception:
            return None

    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        if path in ("/api/health", "/health"):
            return self._send(200, {"ok": True})
        if path in ("/api/votes", "/votes"):
            q = parse_qs(u.query)
            slug = (q.get("slug") or [None])[0]
            voter = (q.get("voter") or [None])[0]
            if voter and not valid_voter(voter):
                voter = None
            con = db()
            try:
                if slug:
                    return self._send(200, tally(con, slug, voter))
                rows = con.execute(
                    "SELECT slug, COALESCE(SUM(vote=1),0) up, COALESCE(SUM(vote=-1),0) down "
                    "FROM votes GROUP BY slug").fetchall()
                out = {"votes": [dict(r) for r in rows]}
                if voter:
                    mine = con.execute("SELECT slug, vote FROM votes WHERE voter=?", (voter,)).fetchall()
                    out["mine"] = {r["slug"]: r["vote"] for r in mine}
                return self._send(200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)})
            finally:
                con.close()
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        path = u.path.rstrip("/") or "/"
        data = self._body()
        if data is None:
            return self._send(400, {"error": "bad body"})
        slug = str(data.get("slug", "")).strip()
        voter = str(data.get("voter", "")).strip()
        if not valid_slug(slug):
            return self._send(400, {"error": "bad slug"})
        if not valid_voter(voter):
            return self._send(400, {"error": "bad voter"})

        if path in ("/api/vote", "/vote"):
            try:
                vote = int(data.get("vote"))
            except (TypeError, ValueError):
                return self._send(400, {"error": "bad vote"})
            if vote not in (1, -1, 0):
                return self._send(400, {"error": "vote must be 1, -1, or 0"})
            con = db()
            try:
                if vote == 0:
                    con.execute("DELETE FROM votes WHERE slug=? AND voter=?", (slug, voter))
                else:
                    con.execute(
                        "INSERT INTO votes(slug,voter,vote,source,updated_at) "
                        "VALUES(?,?,?, 'john', datetime('now')) "
                        "ON CONFLICT(slug,voter) DO UPDATE SET vote=excluded.vote, updated_at=datetime('now')",
                        (slug, voter, vote))
                con.commit()
                out = tally(con, slug, voter)
                out["ok"] = True
                return self._send(200, out)
            except Exception as e:
                return self._send(500, {"error": str(e)})
            finally:
                con.close()

        if path in ("/api/feedback", "/feedback"):
            text = str(data.get("text", "")).strip()
            if not text or len(text) > 2000:
                return self._send(400, {"error": "feedback must be 1-2000 chars"})
            con = db()
            try:
                con.execute("INSERT INTO feedback(slug,voter,text,source) VALUES(?,?,?, 'john')",
                            (slug, voter, text))
                con.commit()
                return self._send(200, {"ok": True})
            except Exception as e:
                return self._send(500, {"error": str(e)})
            finally:
                con.close()

        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"studio vote service on http://{HOST}:{PORT} db={DB}", flush=True)
    srv.serve_forever()
