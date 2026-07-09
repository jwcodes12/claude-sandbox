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
CLAUDE_TIMEOUT = int(os.environ.get("STUDIO_CLAUDE_TIMEOUT", "600"))


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

def select_model(con, role, cfg):
    """Epsilon-greedy over configured candidates. Reviewer!=builder is enforced
    by config (v0 lists claude for both; v1 adds gemini/codex)."""
    cands = cfg["models"].get(role, ["claude"])
    if len(cands) == 1:
        return cands[0]
    rows = {r["model"]: r for r in con.execute(
        "SELECT model,trials,reward_sum,failures FROM model_stats WHERE role=?",
        (role,))}
    # explore any unseen candidate first
    for m in cands:
        if m not in rows or rows[m]["trials"] == 0:
            return m
    # else exploit best mean reward, penalizing failures
    def mean(m):
        r = rows[m]
        return (r["reward_sum"] - 0.5 * r["failures"]) / max(1, r["trials"])
    return max(cands, key=mean)


# Force pure text generation: the builder/critic must return the artifact on
# stdout, never touch the filesystem or shell. Without this, `claude -p` uses its
# Write tool and emits a summary instead of the HTML.
NO_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Read", "Glob",
            "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite"]


def run_model(model, prompt, timeout=CLAUDE_TIMEOUT):
    """Return (ok, text, failure_kind). failure_kind in {None,'quota','auth','error','timeout'}."""
    if model == "claude":
        cmd = ["claude", "-p", prompt, "--disallowedTools", *NO_TOOLS]
    elif model == "gemini":
        cmd = ["gemini", "-p", prompt]          # v1: needs studio-user auth
    elif model == "codex":
        cmd = ["codex", "exec", prompt]         # v1: needs studio-user auth
    else:
        return False, "", "error"
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
               (SELECT score FROM critic_scores c WHERE c.run_id=r.id ORDER BY c.id DESC LIMIT 1) score,
               (SELECT verdict FROM critic_scores c WHERE c.run_id=r.id ORDER BY c.id DESC LIMIT 1) verdict,
               (SELECT COALESCE(SUM(vote=1),0) FROM votes v WHERE v.slug=r.slug AND v.source='john') up,
               (SELECT COALESCE(SUM(vote=-1),0) FROM votes v WHERE v.slug=r.slug AND v.source='john') down
        FROM runs r WHERE r.status='shipped' ORDER BY r.night DESC, r.id DESC
    """).fetchall()
    return [dict(x) for x in rows]


def esc(s):
    return (str(s or "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


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

    # 1) IDEATE (kind is chosen by rotation, not left to the model)
    bmodel = select_model(con, "builder", cfg)
    log(f"ideating (level {level} {ldef['name']}, energy {cad['name']}, kind={target_kind}, builder={bmodel})")
    ok, out, fk = run_model(bmodel, read_prompt(
        "ideate", level=level, level_desc=ldef["desc"], kind=target_kind, kind_guidance=guidance,
        energy_name=cad["name"], recent=", ".join(recent_titles(con)) or "none"))
    if not ok:
        bandit_update(con, "builder", bmodel, "any", failure=fk)
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
    ok, out, fk = run_model(bmodel, read_prompt("build", title=title, kind=kind, pitch=pitch, kind_guidance=guidance))
    if not ok:
        bandit_update(con, "builder", bmodel, kind, failure=fk)
        _finish_fail(con, run_id, f"build:{fk}")
        event(con, fk or "error", f"build failed: {fk}", run_id)
        render_gallery(con)
        return 3
    try:
        html = extract_html(out)
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

    # 3) CODE CRITIC (distinct role/prompt)
    cmodel = select_model(con, "code-critic", cfg)
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

    # 4) SHIP DECISION + record
    bandit_update(con, "builder", bmodel, kind, reward=(score if ship else 0.0))
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
    return run_pipeline(dry="--dry" in args)


if __name__ == "__main__":
    sys.exit(main())
