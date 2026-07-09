# Overnight Studio

An autonomous agent-org that builds and ships **one small web toy every night**,
then learns from John's 👍/👎 and an AI critic panel which ideas and which models
are worth repeating.

- **Gallery:** https://studio.johnwatkinscodes.work/ — newest build featured, archive below.
- **Each build:** `https://studio.johnwatkinscodes.work/s/<slug>/` (unique, permanent URL).
- Runs on `claude-code-dev` (129.213.16.65) as the dedicated `studio` user.

## How it works (v0)

Nightly (~02:30 ET) the pipeline runs `bin/nightly.py`, **as the `studio` user**
(scoped to `/home/studio` + `/srv/studio`, with its own `~/.claude` credentials):

0. **Pick a kind** — rotate across `art-toy / article / game / site` (the least
   recently built kind wins), gated by the night's level/energy budget, so the
   studio alternates content types instead of only making toys.
1. **Ideate** — a "creative director" prompt invents one concrete, single-file idea
   of that kind, avoiding recent builds.
2. **Build** — a "lead builder" prompt emits one self-contained `index.html`
   (inline CSS+JS, no network) to **stdout**. Tools are disabled, so the model
   can never touch the filesystem — the artifact is pure text we capture.
3. **Code critic** (gemini) — a *distinct model + adversarial role* judges the
   build **comparatively** against past shipped sites (relative, never absolute)
   and decides ship/no-ship.
4. **Vision critic** (gemini) — headless chromium screenshots the built page and
   Gemini judges how it actually *looks*. Supplementary signal; doesn't gate ship.
5. **Record + publish** — run + both critic scores + bandit outcomes go to sqlite;
   the site is written to `/srv/studio/sites/<slug>/`; the gallery is regenerated
   (badge = average critic score).

Reviewer ≠ builder is a hard rule and now enforced by **model**: builder = claude,
critics = gemini (via the Gemini API). Model choice per role is a cost-aware
bandit — reward is quality-per-`model_cost`, so it favors a model that's ~as good
but cheaper and only reaches for a pricier one when clearly better.

## Layout

| Path | What |
|------|------|
| `/home/studio/bin/` | pipeline + vote service (private, `studio`-owned) |
| `/home/studio/prompts/` | ideate / build / code-critic prompts |
| `/home/studio/data/studio.sqlite` | scoreboard + votes (bandit, critics, runs) |
| `/home/studio/config.json` | level ladder, cadence, kinds, model candidates (live/mutable) |
| `/home/studio/.claude/.credentials.json` | studio's claude auth (copied from opc's account) |
| `/srv/studio/gallery/index.html` | the gallery (nginx docroot, `httpd_sys_content_t`) |
| `/srv/studio/sites/<slug>/` | each published build |

State lives under `/home/studio` (isolation); only static output lives under
`/srv/studio` so nginx can serve it under SELinux without home-dir grants.

## Hosting

Served at **`studio.johnwatkinscodes.work`** over HTTPS through the box's
existing **cloudflared "box" tunnel**. The tunnel's ingress config
(`~/.cloudflared/config.yml`) routes that hostname to the nginx `:80` vhost
(`nginx/studio.conf` → `/etc/nginx/conf.d/`):

- `/`            → gallery (`/srv/studio/gallery`)
- `/s/<slug>/`   → a build (`/srv/studio/sites/<slug>`)
- `/api/…`       → the localhost vote service

The wildcard CNAME already resolves every `*.johnwatkinscodes.work` to the
tunnel, so adding a site is just: add an ingress rule above the catch-all and
`systemctl --user restart cloudflared-box` — no Cloudflare dashboard, no DNS
record. HTTPS is terminated at Cloudflare with the existing one-level
`*.johnwatkinscodes.work` Universal SSL cert, which **covers `studio.` but not
nested `*.studio.`** — that's why builds live at `studio.…/s/<slug>/` (path)
rather than `<slug>.studio.…` (which would need paid Advanced Certificate
Manager). URLs are permanent and unique per build.

Two guardrails: the studio vhost uses `listen 80`, so the main server in
`nginx.conf` is marked `default_server` to stop it hijacking the default (digest
docroot) — it did once. And because CF terminates HTTPS, builds run in a secure
context; the build rule is *same-origin relative URLs only* (no mixed content).
The URL scheme is `config.json → public` (`base:""` = served at the host root).

## Vote service

`bin/vote_service.py` — stdlib HTTP on `127.0.0.1:8377`, nginx-proxied at `/api/`:

- `POST /api/vote {slug, vote:±1}` → records John's thumb, returns tallies
- `GET  /api/votes?slug=…` → tallies
- `GET  /api/health`

## Deploy / operate

```bash
sudo ./deploy.sh                          # idempotent provision/update; copies studio creds, leaves timer OFF
sudo systemctl enable --now studio-nightly.timer   # go live nightly (~02:30 ET)

sudo systemctl start studio-nightly.service        # manual run (logs in /home/studio/logs/)
sudo -u studio python3 /home/studio/bin/nightly.py gallery   # rebuild gallery only
```

## Roadmap

- **v0 (this):** claude-only pipeline, code critic, gallery, votes, demo site zero.
- **v1:** full council + critic panel — vision critic on screenshots (headless
  chromium, present at `/usr/bin/chromium-browser`), playtest critic; gemini/codex
  authed as the studio user (like claude is now) so the bandit has real model choices.
- **v2:** critic trust-weighting vs John's votes, component harvest into
  `~/studio/lib/` on Sunday retros, digest-RSS announcements of new sites.

The weekly retro promotes a level if all runs shipped, peak budget <70%, and zero
failures; demotes on ≥2 failures. It can only climb through *implemented* levels;
at the ceiling it writes an upgrade proposal for John instead of self-promoting.
