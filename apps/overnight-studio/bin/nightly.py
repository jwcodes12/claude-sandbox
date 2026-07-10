#!/usr/bin/env python3
"""Overnight Studio nightly pipeline (v0, claude-only).

Flow: ideate -> build single-file site -> code-critic -> record to sqlite ->
regenerate gallery. Reviewer role always uses a distinct prompt from the
builder (v1 will also force a distinct model). Safe by construction: the
builder emits HTML to stdout; we never grant it tool/exec permissions.

Env:
  STUDIO_HOME (default /home/studio)  -- all state lives under here
  STUDIO_DB   (default $STUDIO_HOME/data/studio.sqlite)
Usage:
  nightly.py            run tonight's pipeline
  nightly.py gallery    only regenerate the gallery from the DB
  nightly.py --dry KIND ideate+build+critic into STUDIO_HOME but tag as dry
"""
import json
import os
import random
import re
import subprocess
import sys
import sqlite3
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    ET = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    ET = None

HOME = Path(os.environ.get("STUDIO_HOME", "/home/studio"))   # private state
WEB = Path(os.environ.get("STUDIO_WEB", "/srv/studio"))       # nginx-served, httpd_sys_content_t
DB = os.environ.get("STUDIO_DB", str(HOME / "data" / "studio.sqlite"))
PROMPTS = HOME / "prompts"
SITES = WEB / "sites"
GALLERY = WEB / "gallery"
CONFIG = HOME / "config.json"
DOMAIN = "studio.johnwatkinscodes.work"
CLAUDE_TIMEOUT = int(os.environ.get("STUDIO_CLAUDE_TIMEOUT", "300"))
# Builds may involve real high-reasoning thinking (e.g. codex on an art toy), so
# give the build step room. The whole night is still capped by the unit's
# TimeoutStartSec (1h). A genuinely hung API call is caught by this ceiling.
BUILD_TIMEOUT = int(os.environ.get("STUDIO_BUILD_TIMEOUT", "1800"))


# ---------- helpers ----------

def now_et():
    return datetime.now(ET) if ET else datetime.now()


def log(msg):
    print(f"[{now_et():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def db():
    con = sqlite3.connect(DB, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    return con


def load_config():
    return json.loads(CONFIG.read_text())


def public(cfg):
    """Public URL scheme. mode 'path' (default) works on the raw IP and behind
    CF at a shared prefix with the one-level Universal SSL cert. mode 'subdomain'
    needs CF Advanced Certificate Manager for nested *.studio certs."""
    return cfg.get("public", {"mode": "path", "base": "/studio",
                              "domain": DOMAIN, "origin": "http://129.213.16.65"})


def build_url(cfg, slug):
    p = public(cfg)
    if p.get("mode") == "subdomain":
        return f"https://{slug}.{p.get('domain', DOMAIN)}/"
    return f"{p.get('base', '/studio')}/s/{slug}/"


def api_base(cfg):
    p = public(cfg)
    return "/api" if p.get("mode") == "subdomain" else f"{p.get('base', '/studio')}/api"


def event(con, kind, detail, run_id=None):
    con.execute("INSERT INTO events(run_id,kind,detail) VALUES(?,?,?)",
                (run_id, kind, detail))
    con.commit()


def read_prompt(name, **kw):
    # [[token]] substitution (JSON braces in the prompt bodies stay literal)
    t = (PROMPTS / f"{name}.md").read_text()
    for k, v in kw.items():
        t = t.replace(f"[[{k}]]", str(v))
    return t


# ---------- model dispatch (v0: claude only; bandit-ready) ----------

def select_model(con, role, cfg, kind="any", exclude=None):
    """Pick a model for (role, kind) with epsilon-greedy exploration over the
    PER-KIND scoreboard. So the studio keeps trying alternatives and learns e.g.
    that codex makes better art toys while claude writes better articles, routing
    each kind to whatever scores best per cost. Critic selection passes
    exclude=<builder> so the reviewer is never the builder's model."""
    cands = [m for m in cfg["models"].get(role, ["claude"]) if m != exclude]
    if not cands:
        return None
    if len(cands) == 1:
        return cands[0]
    rows = {(r["model"], r["output_type"]): r for r in con.execute(
        "SELECT model,output_type,trials,reward_sum,failures FROM model_stats WHERE role=?", (role,))}
    costs = cfg.get("model_cost", {})
    # cost is a GENTLE penalty, not a divisor: value = quality - w*cost. So a
    # clearly-better model wins the hard tasks and cost only breaks near-ties
    # (models that are "about as good" but not much cheaper don't get dropped).
    w = cfg.get("cost_weight", 0.15)

    def value(m):
        r = rows.get((m, kind))
        if r and r["trials"] > 0:                     # per-kind stats if we have them
            q = (r["reward_sum"] - 0.5 * r["failures"]) / r["trials"]
        else:                                         # else this model's cross-kind average
            t = sum(x["trials"] for (mm, _), x in rows.items() if mm == m)
            if t == 0:
                return None
            s = sum(x["reward_sum"] for (mm, _), x in rows.items() if mm == m)
            f = sum(x["failures"] for (mm, _), x in rows.items() if mm == m)
            q = (s - 0.5 * f) / t
        return q - w * costs.get(m, 0.5)

    # 1) always try a (model, kind) pairing we've never tested
    untried = [m for m in cands if rows.get((m, kind), {"trials": 0})["trials"] == 0]
    if untried:
        return random.choice(untried)
    # 2) keep exploring with a decaying probability (explore early, exploit later)
    seen = sum(rows[(m, kind)]["trials"] for m in cands if (m, kind) in rows)
    if random.random() < max(0.12, 0.6 / (1 + seen)):
        return random.choice(cands)
    # 3) exploit: best quality-per-cost for this kind
    scored = [(m, value(m)) for m in cands]
    scored = [(m, v) for m, v in scored if v is not None]
    return max(scored, key=lambda x: x[1])[0] if scored else random.choice(cands)


# Force pure text generation: the builder/critic must return the artifact on
# stdout, never touch the filesystem or shell. Without this, `claude -p` uses its
# Write tool and emits a summary instead of the HTML.
NO_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Read", "Glob",
            "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite"]

# Pin EXACT Claude model ids so the studio never rides a shifting account default
# (e.g. when Fable leaves the subscription) or the pinned CLI's lagging aliases
# (its 'opus' still maps to 4.6). Exact ids resolve fine via the OAuth token.
CLAUDE_MODELS = {
    "opus": "claude-opus-4-8",              # top quality, top cost — for hard builds
    "sonnet": "claude-sonnet-5",            # balanced default
    "haiku": "claude-haiku-4-5-20251001",   # cheap/fast
    "claude": "claude-sonnet-5",            # back-compat for old stats
}


def run_model(model, prompt, timeout=CLAUDE_TIMEOUT):
    """Return (ok, text, failure_kind). failure_kind in {None,'quota','auth','error','timeout'}."""
    if model == "gemini":
        return gemini_generate(prompt, timeout=timeout)
    if model == "codex":
        return codex_exec(prompt, timeout=timeout)
    cli_id = CLAUDE_MODELS.get(model)
    if not cli_id:
        return False, "", "error"
    cmd = ["claude", "-p", prompt, "--model", cli_id, "--disallowedTools", *NO_TOOLS]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    out, err = p.stdout or "", (p.stderr or "").lower()
    if p.returncode != 0 or not out.strip():
        if any(k in err for k in ("usage limit", "rate limit", "quota", "429")):
            return False, out, "quota"
        if any(k in err for k in ("auth", "login", "oauth", "token", "401", "403")):
            return False, out, "auth"
        return False, out, "error"
    return True, out, None


GEMINI_MODEL = os.environ.get("STUDIO_GEMINI_MODEL", "gemini-2.5-flash")


def gemini_generate(prompt, image_path=None, model=GEMINI_MODEL, timeout=120):
    """Gemini via the HTTP API (GEMINI_API_KEY). Supports an optional PNG for the
    vision critic. agy's subscription auth is per-user and can't run headless, so
    the studio service uses the portable API key (agy-gemini's fallback path)."""
    import base64
    import urllib.request
    import urllib.error
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return False, "", "auth"
    parts = [{"text": prompt}]
    if image_path:
        try:
            with open(image_path, "rb") as f:
                parts.append({"inline_data": {"mime_type": "image/png",
                              "data": base64.b64encode(f.read()).decode()}})
        except OSError:
            return False, "", "error"
    body = json.dumps({"contents": [{"parts": parts}],
                       "generationConfig": {"temperature": 0.3}}).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode())
        text = d["candidates"][0]["content"]["parts"][0]["text"]
        return (True, text, None) if text.strip() else (False, "", "error")
    except urllib.error.HTTPError as e:
        code = e.code
        return False, "", ("quota" if code == 429 else "auth" if code in (401, 403) else "error")
    except Exception:
        return False, "", "error"


def codex_exec(prompt, model=None, timeout=CLAUDE_TIMEOUT):
    """Codex (gpt) via `codex exec`. Runs non-interactively in a read-only sandbox
    and writes only its final message to a temp file (-o), which we read back —
    avoids the noisy event stream on stdout."""
    out_f = f"/tmp/codex-{os.getpid()}-{abs(hash(prompt)) % 100000}.txt"
    cmd = ["codex", "exec", "--skip-git-repo-check", "-s", "read-only", "-o", out_f]
    if model:
        cmd += ["-m", model]
    cmd.append(prompt)
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "", "timeout"
    try:
        with open(out_f) as f:
            text = f.read()
    except OSError:
        text = ""
    finally:
        try:
            os.remove(out_f)
        except OSError:
            pass
    err = ((p.stderr or "") + (p.stdout or "")).lower()
    if p.returncode != 0 or not text.strip():
        if any(k in err for k in ("rate limit", "quota", "429", "usage limit")):
            return False, "", "quota"
        if any(k in err for k in ("unauthorized", "auth", "login", "401", "403")):
            return False, "", "auth"
        return False, "", "error"
    return True, text, None


def screenshot(html_path, out_path, w=900, h=650, timeout=60):
    """Headless-chromium screenshot of a built page (the vision critic's eyes)."""
    udir = f"/tmp/studio-chrome-{os.getpid()}"
    cmd = ["chromium-browser", "--headless=new", "--disable-gpu", "--no-sandbox",
           "--hide-scrollbars", f"--user-data-dir={udir}",
           f"--screenshot={out_path}", f"--window-size={w},{h}",
           "--virtual-time-budget=2500", f"file://{html_path}"]
    try:
        subprocess.run(cmd, capture_output=True, timeout=timeout)
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception:
        return False


def run_model_retry(model, prompt, tries=2, timeout=CLAUDE_TIMEOUT):
    """run_model with a retry on transient failures (timeout/quota/error) — a
    single stalled call shouldn't lose the whole night. Auth failures don't retry."""
    import time
    ok, out, fk = False, "", "error"
    for i in range(tries):
        ok, out, fk = run_model(model, prompt, timeout=timeout)
        # don't retry auth (won't fix itself) or timeout (already waited the full
        # budget — retrying would blow the hour cap)
        if ok or fk in ("auth", "timeout"):
            break
        if i < tries - 1:
            log(f"  {model} {fk}; retrying…")
            time.sleep(5)
    return ok, out, fk


def bandit_update(con, role, model, output_type, reward=None, failure=None):
    con.execute(
        "INSERT INTO model_stats(role,model,output_type,trials,reward_sum,failures,last_used) "
        "VALUES(?,?,?,0,0,0,datetime('now')) "
        "ON CONFLICT(role,model,output_type) DO NOTHING",
        (role, model, output_type))
    con.execute("UPDATE model_stats SET last_used=datetime('now') WHERE role=? AND model=? AND output_type=?",
                (role, model, output_type))
    if reward is not None:
        con.execute("UPDATE model_stats SET trials=trials+1, reward_sum=reward_sum+? "
                    "WHERE role=? AND model=? AND output_type=?",
                    (reward, role, model, output_type))
    if failure:
        con.execute("UPDATE model_stats SET failures=failures+1 "
                    "WHERE role=? AND model=? AND output_type=?",
                    (role, model, output_type))
    con.commit()


# ---------- extraction ----------

def extract_json(text):
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\n?|```$", "", t.strip()).strip()
    a, b = t.find("{"), t.rfind("}")
    if a == -1 or b == -1:
        raise ValueError("no JSON object in model output")
    return json.loads(t[a:b + 1])


def extract_html(text):
    t = text.strip()
    m = re.search(r"<!DOCTYPE html>.*?</html>", t, re.I | re.S)
    if m:
        return m.group(0)
    m = re.search(r"<html.*?</html>", t, re.I | re.S)
    if m:
        return "<!DOCTYPE html>\n" + m.group(0)
    # last resort: strip a single fenced block
    m = re.search(r"```(?:html)?\n(.*?)```", t, re.S)
    if m and "<html" in m.group(1).lower():
        return m.group(1).strip()
    raise ValueError("no HTML document in model output")


def slugify(words, night):
    base = re.sub(r"[^a-z0-9]+", "-", words.lower()).strip("-")[:40].strip("-") or "untitled"
    return f"{night}-{base}"


# ---------- gallery ----------

def gallery_data(con):
    rows = con.execute("""
        SELECT r.slug,r.title,r.kind,r.brief,r.night,COALESCE(r.shipped_at,r.created_at) shipped_at,
               (SELECT AVG(score) FROM critic_scores c WHERE c.run_id=r.id) score,
               (SELECT verdict FROM critic_scores c WHERE c.run_id=r.id
                  ORDER BY (role='code') DESC, c.id DESC LIMIT 1) verdict,
               (SELECT COALESCE(SUM(vote=1),0) FROM votes v WHERE v.slug=r.slug AND v.source='john') up,
               (SELECT COALESCE(SUM(vote=-1),0) FROM votes v WHERE v.slug=r.slug AND v.source='john') down
        FROM runs r WHERE r.status='shipped' ORDER BY r.night DESC, r.id DESC
    """).fetchall()
    return [dict(x) for x in rows]


def esc(s):
    return (str(s or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# A tiny floating feedback widget injected into every build so friends can report
# bugs / leave notes while they play. Posts to the same-origin vote service. The
# markers make injection idempotent (strip old, add fresh) across hot-fixes.
FB_START, FB_END = "<!--studio-fb-start-->", "<!--studio-fb-end-->"
FEEDBACK_WIDGET = """
<div id="sfb" style="position:fixed;right:12px;bottom:12px;z-index:2147483000;font:14px system-ui,sans-serif">
  <button id="sfb-t" style="border:0;border-radius:20px;padding:8px 14px;background:#12151d;color:#e7e9ee;box-shadow:0 2px 10px #0007;cursor:pointer">💬 feedback</button>
  <form id="sfb-f" style="display:none;flex-direction:column;gap:6px;background:#12151d;border:1px solid #2a3040;border-radius:12px;padding:10px;width:240px;box-shadow:0 4px 20px #0009">
    <textarea id="sfb-x" rows="3" maxlength="2000" placeholder="bug or idea? tell the studio…" style="width:100%;box-sizing:border-box;background:#0b0d12;color:#e7e9ee;border:1px solid #2a3040;border-radius:8px;padding:7px;font:inherit;font-size:13px"></textarea>
    <div style="display:flex;gap:6px;align-items:center"><span id="sfb-m" style="flex:1;color:#6fce9b;font-size:12px"></span><button type="button" id="sfb-c" style="border:0;background:none;color:#6b7488;cursor:pointer">close</button><button type="submit" style="border:0;border-radius:8px;padding:6px 12px;background:#20264a;color:#e7e9ee;cursor:pointer">send</button></div>
  </form>
</div>
<script>(function(){
  var S="__SLUG__",A="__API__";
  var v=localStorage.getItem('studio_voter');
  if(!v){v=(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random()).replace(/[^a-zA-Z0-9]/g,'').slice(0,32);localStorage.setItem('studio_voter',v);}
  var t=document.getElementById('sfb-t'),f=document.getElementById('sfb-f'),x=document.getElementById('sfb-x'),m=document.getElementById('sfb-m');
  function toggle(o){f.style.display=o?'flex':'none';t.style.display=o?'none':'inline-block';if(o)x.focus();}
  t.onclick=function(){toggle(true)};document.getElementById('sfb-c').onclick=function(){toggle(false)};
  f.onsubmit=function(e){e.preventDefault();var txt=(x.value||'').trim();if(!txt)return;
    fetch(A+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:S,text:txt,voter:v})})
    .then(function(r){return r.json()}).then(function(d){if(d&&d.ok){x.value='';m.textContent='thanks!';setTimeout(function(){toggle(false);m.textContent='';},1200);}else m.textContent='try again';})
    .catch(function(){m.textContent='offline?';});};
})();</script>
"""


def strip_feedback_widget(html):
    return re.sub(re.escape(FB_START) + ".*?" + re.escape(FB_END), "", html, flags=re.S)


def inject_feedback_widget(html, slug, api):
    html = strip_feedback_widget(html)
    w = FB_START + FEEDBACK_WIDGET.replace("__SLUG__", slug).replace("__API__", api) + FB_END
    low = html.lower()
    i = low.rfind("</body>")
    if i == -1:
        i = low.rfind("</html>")
    return (html[:i] + w + html[i:]) if i != -1 else (html + w)


def _card(cfg, it, hero=False):
    url = build_url(cfg, it["slug"])
    badge = f"{it['score']:.2f}" if it["score"] is not None else "—"
    title, pitch, verdict = esc(it["title"] or it["slug"]), esc(it["brief"]), esc(it["verdict"])
    night = esc(it["night"])
    cls = "card hero" if hero else "card"
    verdict_html = f'<p class="verdict"><span class="badge">critic {badge}</span>{verdict}</p>' if hero else \
                   f'<p class="verdict"><span class="badge">critic {badge}</span></p>'
    return f"""
      <article class="{cls}">
        <a class="frame" href="{url}" target="_blank" rel="noopener">
          <iframe src="{url}" loading="lazy" tabindex="-1" scrolling="no"
                  sandbox="allow-scripts allow-same-origin" title="{title}"></iframe>
          <span class="open">open ↗</span>
        </a>
        <div class="meta">
          <h2>{title} <span class="kind">{esc(it['kind'])}</span></h2>
          <p class="pitch">{pitch}</p>
          {verdict_html}
          <div class="row">
            <span class="date">{night}</span>
            <div class="vote" data-slug="{esc(it['slug'])}">
              <button data-v="1">👍 <b>{it['up']}</b></button>
              <button data-v="-1">👎 <b>{it['down']}</b></button>
            </div>
          </div>
          <form class="fb" data-slug="{esc(it['slug'])}">
            <input class="fbin" type="text" maxlength="2000" placeholder="tell the studio what you think…">
            <button class="fbsend" type="submit">Send</button>
            <span class="fbmsg"></span>
          </form>
        </div>
      </article>"""


def render_gallery(con):
    cfg = load_config()
    items = gallery_data(con)
    if items:
        hero = f'<section class="latest"><p class="eyebrow">Latest build</p>{_card(cfg, items[0], hero=True)}</section>'
        rest = "".join(_card(cfg, it) for it in items[1:])
        archive = f'<section class="archive"><h2 class="sec">Archive</h2><div class="grid">{rest}</div></section>' if rest else ""
        empty = ""
    else:
        hero = archive = ""
        empty = '<p class="empty">The studio is warming up. First build ships tonight.</p>'
    html = (GALLERY_TMPL.replace("{{HERO}}", hero).replace("{{ARCHIVE}}", archive)
            .replace("{{EMPTY}}", empty).replace("{{API}}", api_base(cfg)))
    GALLERY.mkdir(parents=True, exist_ok=True)
    out = GALLERY / "index.html"
    out.write_text(html)
    os.chmod(out, 0o644)  # nginx (user 'nginx') must be able to read it
    log(f"gallery: {len(items)} shipped site(s) -> {out}")


# ---------- pipeline ----------

# What each content kind should be. Injected into ideate/build/critic so the
# studio alternates between makes instead of only building toys.
KIND_GUIDANCE = {
    "art-toy": "an ART TOY — a delightful interactive visual the visitor pokes or drags and it responds; motion and feel matter most.",
    "game": "a GAME — a real playable loop with a clear goal, scoring, a win/lose state, and a restart.",
    "article": "an ARTICLE — a genuinely interesting, specific short written piece (~500-900 words), beautifully typeset (readable measure, headings, a pull-quote); no interaction needed, craft = writing quality + typography.",
    "site": "a SITE — a small, focused single-purpose page that does one useful or charming thing well.",
}


def pick_kind(con, allowed):
    """Rotate content types: pick the allowed kind that was built least recently
    (unbuilt kinds first), so the studio alternates article/game/toy/site."""
    recent = [r["kind"] for r in con.execute(
        "SELECT kind FROM runs WHERE status='shipped' ORDER BY id DESC LIMIT 20")]

    def staleness(k):
        return recent.index(k) if k in recent else 10_000
    return max(allowed, key=staleness)


def recent_titles(con, n=8):
    return [r["title"] for r in con.execute(
        "SELECT title FROM runs WHERE status='shipped' ORDER BY id DESC LIMIT ?", (n,))]


def peer_list(con, n=6):
    rows = con.execute("""
        SELECT r.slug,(SELECT score FROM critic_scores c WHERE c.run_id=r.id ORDER BY c.id DESC LIMIT 1) s
        FROM runs r WHERE r.status='shipped' ORDER BY s DESC NULLS LAST LIMIT ?""", (n,)).fetchall()
    return ", ".join(f"{x['slug']}({x['s']:.2f})" if x['s'] is not None else x['slug'] for x in rows) or "none yet"


def run_pipeline(dry=False):
    cfg = load_config()
    con = db()
    night = f"{now_et():%Y-%m-%d}"
    dow = str(now_et().isoweekday() % 7)  # 0=Sun
    cad = cfg["cadence"].get(dow, {"name": "weeknight-light", "build": True, "energy": 1})
    if not cad.get("build") and not dry:
        event(con, "retro", f"{night}: sunday retro, no build")
        log("Sunday retro night — no build. (v0: component harvest is a v2 feature.)")
        render_gallery(con)
        return 0

    level = cfg["level"]
    ldef = cfg["levels"][str(level)]
    target_kind = pick_kind(con, ldef["kinds"])
    guidance = KIND_GUIDANCE.get(target_kind, target_kind)

    # 1) IDEATE (kind is chosen by rotation; builder is routed per-kind)
    bmodel = select_model(con, "builder", cfg, target_kind)
    log(f"ideating (level {level} {ldef['name']}, energy {cad['name']}, kind={target_kind}, builder={bmodel})")
    ok, out, fk = run_model_retry(bmodel, read_prompt(
        "ideate", level=level, level_desc=ldef["desc"], kind=target_kind, kind_guidance=guidance,
        energy_name=cad["name"], recent=", ".join(recent_titles(con)) or "none"))
    if not ok:
        bandit_update(con, "builder", bmodel, target_kind, failure=fk)
        event(con, fk or "error", f"ideate failed: {fk}")
        log(f"IDEATE FAILED ({fk}); aborting.")
        _record_fail(con, night, level, bmodel, f"ideate:{fk}")
        render_gallery(con)
        return 2
    try:
        idea = extract_json(out)
        title = str(idea["title"])[:60]
        kind = target_kind  # rotation decides the kind, not the model
        pitch = str(idea.get("pitch", ""))[:280]
        slug = slugify(idea.get("slug_words", title), night)
    except Exception as e:
        event(con, "error", f"ideate parse: {e}")
        log(f"IDEATE PARSE FAILED: {e}; aborting.")
        _record_fail(con, night, level, bmodel, "ideate:parse")
        render_gallery(con)
        return 2
    log(f"idea: {title!r} [{kind}] slug={slug}")

    # open the run row now so a later crash still leaves a record
    cur = con.execute(
        "INSERT OR REPLACE INTO runs(slug,night,level,kind,title,brief,builder_model,status) "
        "VALUES(?,?,?,?,?,?,?, 'building')",
        (slug, night, level, kind, title, pitch, bmodel))
    con.commit()
    run_id = cur.lastrowid

    # 2) BUILD
    log("building index.html")
    ok, out, fk = run_model_retry(bmodel, read_prompt(
        "build", title=title, kind=kind, pitch=pitch, kind_guidance=guidance), timeout=BUILD_TIMEOUT)
    if not ok:
        bandit_update(con, "builder", bmodel, kind, failure=fk)
        _finish_fail(con, run_id, f"build:{fk}")
        event(con, fk or "error", f"build failed: {fk}", run_id)
        render_gallery(con)
        return 3
    try:
        html = inject_feedback_widget(extract_html(out), slug, api_base(cfg))
    except Exception as e:
        _finish_fail(con, run_id, "build:parse")
        event(con, "error", f"build parse: {e}", run_id)
        render_gallery(con)
        return 3
    site_dir = SITES / slug
    site_dir.mkdir(parents=True, exist_ok=True)
    (site_dir / "index.html").write_text(html)
    os.chmod(site_dir, 0o755)
    os.chmod(site_dir / "index.html", 0o644)
    log(f"wrote {site_dir/'index.html'} ({len(html)} bytes)")

    # 3) CODE CRITIC (distinct model from the builder)
    cmodel = select_model(con, "code-critic", cfg, kind, exclude=bmodel)
    log(f"code critic ({cmodel})")
    ok, out, fk = run_model(cmodel, read_prompt(
        "code-critic", title=title, kind=kind, pitch=pitch, kind_guidance=guidance,
        peers=peer_list(con), html=html[:120000]))
    score, ship, verdict = 0.5, True, "(critic unavailable)"
    if ok:
        try:
            v = extract_json(out)
            score = max(0.0, min(1.0, float(v.get("score", 0.5))))
            ship = bool(v.get("ship", True))
            verdict = str(v.get("verdict", ""))[:600]
            rank = str(v.get("rank_note", ""))[:200]
            con.execute("INSERT INTO critic_scores(run_id,role,critic_model,score,rank_note,verdict) "
                        "VALUES(?,?,?,?,?,?)", (run_id, "code", cmodel, score, rank, verdict))
            con.commit()
            bandit_update(con, "code-critic", cmodel, kind, reward=1.0)
        except Exception as e:
            event(con, "error", f"critic parse: {e}", run_id)
            bandit_update(con, "code-critic", cmodel, kind, failure="error")
    else:
        bandit_update(con, "code-critic", cmodel, kind, failure=fk)
        event(con, fk or "error", f"critic failed: {fk}", run_id)

    # 3b) VISION CRITIC — screenshot the page, judge how it LOOKS (gemini vision,
    #     must differ from the builder). Supplementary signal; doesn't gate ship.
    vmodel = select_model(con, "vision-critic", cfg, kind, exclude=bmodel)
    shot = f"/tmp/studio-{slug}.png"
    if not vmodel:
        log("vision critic skipped (builder is the vision model)")
    elif screenshot(str(site_dir / "index.html"), shot):
        log(f"vision critic ({vmodel})")
        vok, vout, vfk = gemini_generate(read_prompt(
            "vision-critic", title=title, kind=kind, kind_guidance=guidance,
            peers=peer_list(con)), image_path=shot)
        if vok:
            try:
                vv = extract_json(vout)
                vscore = max(0.0, min(1.0, float(vv.get("score", 0.5))))
                con.execute("INSERT INTO critic_scores(run_id,role,critic_model,score,verdict) "
                            "VALUES(?,?,?,?,?)", (run_id, "vision", GEMINI_MODEL, vscore,
                                                  str(vv.get("verdict", ""))[:600]))
                con.commit()
                bandit_update(con, "vision-critic", "gemini", kind, reward=1.0)
                log(f"vision score {vscore:.2f}")
            except Exception as e:
                event(con, "error", f"vision parse: {e}", run_id)
                bandit_update(con, "vision-critic", "gemini", kind, failure="error")
        else:
            bandit_update(con, "vision-critic", "gemini", kind, failure=vfk)
            event(con, vfk or "error", f"vision critic failed: {vfk}", run_id)
        try:
            os.remove(shot)
        except OSError:
            pass
    else:
        event(con, "error", "screenshot failed", run_id)

    # 4) SHIP DECISION + record. Builder reward = quality gate = average of the
    #    night's critic scores (code + vision) if shipped, else 0.
    avg = con.execute("SELECT AVG(score) FROM critic_scores WHERE run_id=?", (run_id,)).fetchone()[0]
    builder_reward = (avg if avg is not None else score) if ship else 0.0
    bandit_update(con, "builder", bmodel, kind, reward=builder_reward)
    if ship:
        con.execute("UPDATE runs SET status='shipped', shipped_at=datetime('now') WHERE id=?", (run_id,))
        con.commit()
        log(f"SHIPPED {slug}  critic={score:.2f}  {build_url(cfg, slug)}")
    else:
        _finish_fail(con, run_id, "critic:rejected")
        log(f"critic rejected build (score {score:.2f}); not shipped.")

    render_gallery(con)
    return 0 if ship else 4


def _record_fail(con, night, level, model, reason):
    slug = f"{night}-failed-{model}"
    con.execute("INSERT OR REPLACE INTO runs(slug,night,level,builder_model,status,fail_reason) "
                "VALUES(?,?,?,?, 'failed', ?)", (slug, night, level, model, reason))
    con.commit()


def _finish_fail(con, run_id, reason):
    con.execute("UPDATE runs SET status='failed', fail_reason=? WHERE id=?", (reason, run_id))
    con.commit()


def hotfix(con, slug):
    """Repair a shipped build from friends' unhandled feedback. Only replaces the
    live file if a fresh critic pass says it's not worse (regression guard)."""
    cfg = load_config()
    run = con.execute("SELECT * FROM runs WHERE slug=? AND status='shipped'", (slug,)).fetchone()
    if not run:
        return f"{slug}: no shipped run"
    fb = con.execute("SELECT id,text FROM feedback WHERE slug=? AND handled=0 ORDER BY id", (slug,)).fetchall()
    if not fb:
        return f"{slug}: no new feedback"
    site = SITES / slug / "index.html"
    try:
        cur_html = site.read_text()
    except OSError:
        return f"{slug}: no build file"
    kind = run["kind"] or "site"
    guidance = KIND_GUIDANCE.get(kind, kind)
    fb_text = "\n".join("- " + f["text"] for f in fb)[:2000]
    prior = con.execute("SELECT AVG(score) FROM critic_scores WHERE run_id=?", (run["id"],)).fetchone()[0] or 0.5

    # cheap gate: don't burn an expensive rebuild on pure praise / vague notes
    gok, gout, _ = gemini_generate(
        "Feedback left on a small web toy/game:\n" + fb_text +
        "\n\nIs ANY of it an actionable bug report or a concrete improvement request "
        "(not just praise or a vague reaction)? Answer with ONLY 'yes' or 'no'.", timeout=60)
    if gok and gout.strip().lower().startswith("no"):
        con.execute("UPDATE feedback SET handled=1 WHERE slug=? AND handled=0", (slug,))
        con.commit()
        event(con, "fix-skip", f"{slug}: feedback not actionable ({len(fb)} item(s))", run["id"])
        return f"{slug}: not actionable, acknowledged"

    bmodel = select_model(con, "builder", cfg, kind)
    log(f"hotfix {slug}: {len(fb)} feedback item(s), builder={bmodel}")
    ok, out, fk = run_model_retry(bmodel, read_prompt(
        "fix", title=run["title"], kind=kind, kind_guidance=guidance,
        feedback=fb_text, html=strip_feedback_widget(cur_html)[:120000]), timeout=BUILD_TIMEOUT)
    if not ok:
        event(con, fk or "error", f"hotfix build failed: {fk}", run["id"])
        return f"{slug}: fix build failed ({fk})"
    try:
        new_html = inject_feedback_widget(extract_html(out), slug, api_base(cfg))
    except Exception as e:
        event(con, "error", f"hotfix parse: {e}", run["id"])
        return f"{slug}: fix parse failed"

    # critique the fix (distinct model from the fixer)
    cmodel = select_model(con, "code-critic", cfg, kind, exclude=bmodel)
    cok, cout, _ = run_model(cmodel, read_prompt(
        "code-critic", title=run["title"], kind=kind, pitch=run["brief"] or "",
        kind_guidance=guidance, peers=peer_list(con), html=new_html[:120000]))
    newscore = prior
    if cok:
        try:
            newscore = max(0.0, min(1.0, float(extract_json(cout).get("score", prior))))
        except Exception:
            pass

    con.execute("UPDATE feedback SET handled=1 WHERE slug=? AND handled=0", (slug,))
    if newscore + 0.02 >= prior:                      # not worse -> ship the fix
        site.write_text(new_html)
        os.chmod(site, 0o644)
        con.execute("INSERT INTO critic_scores(run_id,role,critic_model,score,verdict) "
                    "VALUES(?,?,?,?,?)", (run["id"], "code", cmodel, newscore, "(post-hotfix)"))
        con.commit()
        event(con, "fix", f"{slug}: fixed {len(fb)} feedback; {prior:.2f}->{newscore:.2f} ({bmodel})", run["id"])
        render_gallery(con)
        return f"{slug}: FIXED {prior:.2f}->{newscore:.2f}"
    con.commit()                                      # feedback marked handled; keep original
    event(con, "fix-skip", f"{slug}: fix {newscore:.2f} < {prior:.2f}, kept original", run["id"])
    return f"{slug}: kept original (fix {newscore:.2f} < {prior:.2f})"


def hotfix_scan():
    """Fix every shipped build that has unhandled feedback. Run by a timer so
    friends' reports get acted on between nightly builds."""
    con = db()
    slugs = [r["slug"] for r in con.execute(
        "SELECT DISTINCT f.slug FROM feedback f JOIN runs r ON r.slug=f.slug "
        "WHERE f.handled=0 AND r.status='shipped'")]
    if not slugs:
        log("hotfix: no new feedback")
        return 0
    for s in slugs:
        log(hotfix(con, s))
    return 0


GALLERY_TMPL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overnight Studio</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0b0d12;color:#e7e9ee}
  header{padding:34px 20px 6px;max-width:1100px;margin:0 auto;
         display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}
  h1{margin:0;font-size:26px;letter-spacing:.3px}
  header p{margin:0;color:#8b93a7;flex:1 1 320px}
  main{max-width:1100px;margin:0 auto;padding:8px 20px 60px}
  .eyebrow{margin:22px 0 8px;color:#7c86ff;font-size:12px;letter-spacing:.14em;text-transform:uppercase}
  .sec{margin:34px 0 14px;font-size:15px;color:#8b93a7;font-weight:600;
       border-top:1px solid #1f2430;padding-top:22px}
  .grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
  .empty{color:#8b93a7;text-align:center;padding:60px 0}
  .card{background:#12151d;border:1px solid #1f2430;border-radius:14px;overflow:hidden;
        display:flex;flex-direction:column}
  .card.hero{border-color:#2b2f6b}
  .frame{position:relative;display:block;aspect-ratio:16/10;background:#0b0d12;overflow:hidden}
  .card.hero .frame{aspect-ratio:16/8}
  .frame iframe{position:absolute;top:0;left:0;width:200%;height:200%;border:0;
        transform:scale(.5);transform-origin:top left;pointer-events:none}
  .frame .open{position:absolute;right:8px;bottom:8px;background:#0009;padding:3px 8px;
        border-radius:8px;font-size:12px;color:#cfd4e0}
  .meta{padding:12px 14px 14px}
  .meta h2{margin:0 0 4px;font-size:17px}
  .card.hero .meta h2{font-size:21px}
  .kind{font-size:11px;color:#7c86ff;border:1px solid #2b2f6b;border-radius:6px;padding:1px 6px;vertical-align:middle}
  .pitch{margin:0 0 8px;color:#aeb6c8;font-size:14px}
  .verdict{margin:0 0 10px;color:#8b93a7;font-size:13px}
  .badge{display:inline-block;margin-right:6px;background:#1c2230;color:#9fb0ff;
        border-radius:6px;padding:1px 6px;font-size:12px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .date{color:#6b7488;font-size:12px}
  .vote button{font:inherit;font-size:14px;background:#1a1f2b;color:#e7e9ee;border:1px solid #2a3040;
        border-radius:9px;padding:6px 12px;margin-left:8px;cursor:pointer}
  .vote button:active{transform:translateY(1px)}
  .vote button.on{border-color:#7c86ff;background:#20264a}
  .fb{display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap}
  .fbin{flex:1 1 160px;min-width:0;font:inherit;font-size:13px;background:#0f131b;color:#e7e9ee;
        border:1px solid #2a3040;border-radius:9px;padding:7px 10px}
  .fbin::placeholder{color:#5c6580}
  .fbsend{font:inherit;font-size:13px;background:#1a1f2b;color:#e7e9ee;border:1px solid #2a3040;
        border-radius:9px;padding:7px 12px;cursor:pointer}
  .fbsend:active{transform:translateY(1px)}
  .fbmsg{font-size:12px;color:#6fce9b}
</style>
</head>
<body>
<header>
  <h1>Overnight Studio</h1>
  <p>A little web toy, built and shipped every night. 👍/👎 teach it what to make next.</p>
</header>
<main>
{{EMPTY}}
{{HERO}}
{{ARCHIVE}}
</main>
<script>
(function(){
  var API = '{{API}}';
  // stable per-browser voter id so a thumb is one toggleable vote
  var voter = localStorage.getItem('studio_voter');
  if(!voter){
    voter = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random())
              .replace(/[^a-zA-Z0-9]/g,'').slice(0,32);
    localStorage.setItem('studio_voter', voter);
  }
  function setCounts(box, d){
    box.querySelector('[data-v="1"] b').textContent = d.up;
    box.querySelector('[data-v="-1"] b').textContent = d.down;
  }
  function mark(box, mine){
    box.querySelectorAll('button').forEach(function(b){
      b.classList.toggle('on', parseInt(b.getAttribute('data-v'),10) === mine);
    });
    box.setAttribute('data-mine', mine || 0);
  }
  // 1) load live counts + which ones I already voted on
  fetch(API+'/votes?voter='+voter).then(function(r){return r.json()}).then(function(d){
    var counts={}; (d.votes||[]).forEach(function(v){counts[v.slug]=v});
    var mine=d.mine||{};
    document.querySelectorAll('.vote').forEach(function(box){
      var slug=box.getAttribute('data-slug');
      if(counts[slug]) setCounts(box, counts[slug]);
      mark(box, mine[slug]||0);
    });
  }).catch(function(){});
  // 2) toggle vote on click
  document.querySelectorAll('.vote').forEach(function(box){
    var slug=box.getAttribute('data-slug');
    box.querySelectorAll('button').forEach(function(btn){
      btn.addEventListener('click', function(){
        var v=parseInt(btn.getAttribute('data-v'),10);
        var cur=parseInt(box.getAttribute('data-mine')||'0',10);
        var send = (cur===v) ? 0 : v;   // click your current vote again to undo
        box.querySelectorAll('button').forEach(function(b){b.disabled=true});
        fetch(API+'/vote',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({slug:slug,vote:send,voter:voter})})
          .then(function(r){return r.json()})
          .then(function(d){ if(d&&typeof d.up==='number'){ setCounts(box,d); mark(box, d.myvote||0);} })
          .catch(function(){})
          .finally(function(){ box.querySelectorAll('button').forEach(function(b){b.disabled=false}); });
      });
    });
  });
  // 3) text feedback
  document.querySelectorAll('.fb').forEach(function(form){
    var slug=form.getAttribute('data-slug');
    var input=form.querySelector('.fbin'), msg=form.querySelector('.fbmsg');
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var text=(input.value||'').trim();
      if(!text) return;
      form.querySelector('.fbsend').disabled=true;
      fetch(API+'/feedback',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({slug:slug,text:text,voter:voter})})
        .then(function(r){return r.json()})
        .then(function(d){ if(d&&d.ok){ input.value=''; msg.textContent='thanks — noted'; } else { msg.textContent='hmm, try again'; } })
        .catch(function(){ msg.textContent='offline?'; })
        .finally(function(){ form.querySelector('.fbsend').disabled=false; setTimeout(function(){msg.textContent='';},4000); });
    });
  });
})();
</script>
</body>
</html>
"""


def main():
    args = sys.argv[1:]
    if args and args[0] == "gallery":
        render_gallery(db())
        return 0
    if args and args[0] == "hotfix":
        return hotfix_scan()
    if args and args[0] == "fix" and len(args) > 1:
        print(hotfix(db(), args[1]))
        return 0
    if args and args[0] == "widgets":            # backfill the feedback widget into existing builds
        cfg = load_config()
        n = 0
        for d in sorted(SITES.glob("*/index.html")):
            html = d.read_text()
            if FB_START not in html:
                d.write_text(inject_feedback_widget(html, d.parent.name, api_base(cfg)))
                os.chmod(d, 0o644)
                n += 1
        print(f"injected feedback widget into {n} build(s)")
        return 0
    return run_pipeline(dry="--dry" in args)


if __name__ == "__main__":
    sys.exit(main())
