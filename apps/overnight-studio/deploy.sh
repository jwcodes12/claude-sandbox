#!/usr/bin/env bash
# Provision / update Overnight Studio on this box. Idempotent. Run with sudo.
#   sudo ./deploy.sh
# Leaves the nightly TIMER disabled: enable it only after `claude setup-token`
# has populated /home/studio/.config/studio/env for the studio user.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
U=studio

command -v sqlite3 >/dev/null || { echo "sqlite3 required"; exit 1; }
id "$U" >/dev/null 2>&1 || { echo "user '$U' missing"; exit 1; }

echo "== dirs =="
install -d -o $U -g $U -m 751 /home/studio
install -d -o $U -g $U -m 755 /home/studio/{bin,prompts,data,logs}
install -d -o $U -g $U -m 700 /home/studio/.config/studio
install -d -o $U -g $U -m 755 /srv/studio /srv/studio/sites /srv/studio/gallery

echo "== code + prompts =="
install -o $U -g $U -m 755 "$SRC"/bin/nightly.py   /home/studio/bin/nightly.py
install -o $U -g $U -m 755 "$SRC"/bin/nightly.sh   /home/studio/bin/nightly.sh
install -o $U -g $U -m 755 "$SRC"/bin/hotfix.sh    /home/studio/bin/hotfix.sh
install -o $U -g $U -m 755 "$SRC"/bin/vote_service.py /home/studio/bin/vote_service.py
install -o $U -g $U -m 644 "$SRC"/prompts/*.md     /home/studio/prompts/

echo "== config (never clobber live) =="
if [ ! -f /home/studio/config.json ]; then
  install -o $U -g $U -m 644 "$SRC"/config.default.json /home/studio/config.json
  echo "  installed default config"
else
  echo "  kept existing /home/studio/config.json"
fi

echo "== db schema + bandit seed =="
sudo -u $U sqlite3 /home/studio/data/studio.sqlite < "$SRC"/schema.sql
# migrate older DBs that predate the feedback.handled column (hot-fix loop)
sudo -u $U sqlite3 /home/studio/data/studio.sqlite \
  "ALTER TABLE feedback ADD COLUMN handled INTEGER NOT NULL DEFAULT 0;" 2>/dev/null || true
sudo -u $U sqlite3 /home/studio/data/studio.sqlite \
  "INSERT OR IGNORE INTO model_stats(role,model,output_type) VALUES
   ('builder','claude','any'),('code-critic','claude','any');"

echo "== AI CLI auth for studio =="
# claude: uses system-wide /usr/bin/claude with a dedicated long-lived token in
#   /home/studio/.config/studio/env (CLAUDE_CODE_OAUTH_TOKEN). Copying opc's
#   ~/.claude/.credentials.json is UNSTABLE (shared OAuth refresh-token rotates),
#   so DON'T — run `claude setup-token` and put the token in that env file.
install -d -o $U -g $U -m 700 /home/studio/.claude
install -o $U -g $U -m 644 /home/opc/.claude/settings.json /home/studio/.claude/settings.json 2>/dev/null || true
grep -q CLAUDE_CODE_OAUTH_TOKEN /home/studio/.config/studio/env 2>/dev/null \
  || echo "  NOTE: add CLAUDE_CODE_OAUTH_TOKEN to /home/studio/.config/studio/env (claude setup-token)"
# gemini: no CLI (deprecated) — studio uses the Gemini HTTP API via GEMINI_API_KEY
grep -q GEMINI_API_KEY /home/studio/.config/studio/env 2>/dev/null \
  || echo "  NOTE: add GEMINI_API_KEY to /home/studio/.config/studio/env"
# agy (multi-model gateway) + codex: install binaries system-wide so studio can run them
[ -f /home/opc/.local/bin/agy ] && install -m 755 /home/opc/.local/bin/agy /usr/local/bin/agy || true
if [ -f /home/opc/.local/bin/codex ]; then
  install -m 755 "$(readlink -f /home/opc/.local/bin/codex)" /usr/local/bin/codex
  install -d -o $U -g $U -m 700 /home/studio/.codex
  [ -f /home/studio/.codex/auth.json ] || install -o $U -g $U -m 600 /home/opc/.codex/auth.json /home/studio/.codex/auth.json 2>/dev/null || true
  install -o $U -g $U -m 644 /home/opc/.codex/config.toml /home/studio/.codex/config.toml 2>/dev/null || true
fi

echo "== SELinux label for /srv/studio =="
semanage fcontext -a -t httpd_sys_content_t "/srv/studio(/.*)?" 2>/dev/null || true
restorecon -R /srv/studio

echo "== nginx (subdomain vhost) =="
rm -f /etc/nginx/default.d/studio-path.conf   # retire the old /studio/ path mount
# The studio vhost uses `listen 80`; mark the main server default_server so it
# can never hijack the default (which serves the digest docroot).
sed -i 's/^\(\s*listen\s\+\)80;/\180 default_server;/; s/^\(\s*listen\s\+\)\[::\]:80;/\1[::]:80 default_server;/' /etc/nginx/nginx.conf
install -m 644 "$SRC"/nginx/studio.conf /etc/nginx/conf.d/studio.conf
nginx -t
systemctl reload nginx

echo "== cloudflared tunnel ingress (studio.johnwatkinscodes.work -> nginx :80) =="
CF=/home/opc/.cloudflared/config.yml
if [ -f "$CF" ] && ! grep -q "studio.johnwatkinscodes.work" "$CF"; then
  echo "  NOTE: add this rule ABOVE the catch-all in $CF, then: systemctl --user restart cloudflared-box"
  echo "    - hostname: studio.johnwatkinscodes.work"
  echo "      service: http://127.0.0.1:80"
fi

echo "== backfill feedback widget into existing builds =="
sudo -u $U env STUDIO_HOME=/home/studio STUDIO_WEB=/srv/studio python3 /home/studio/bin/nightly.py widgets || true

echo "== systemd units =="
for u in studio-votes.service studio-nightly.service studio-nightly.timer \
         studio-hotfix.service studio-hotfix.timer; do
  install -m 644 "$SRC"/systemd/$u /etc/systemd/system/
done
systemctl daemon-reload
systemctl enable --now studio-votes.service
systemctl enable --now studio-hotfix.timer   # every 2h; cheap when no feedback
echo "  vote service:"; systemctl is-active studio-votes.service
echo "  hotfix timer:"; systemctl is-active studio-hotfix.timer

echo
echo "DONE. To enable nightly builds (~02:30 ET):"
echo "  sudo systemctl enable --now studio-nightly.timer"
echo "Manual run: sudo systemctl start studio-nightly.service  (logs in /home/studio/logs/)"
echo "Hot-fix now: sudo systemctl start studio-hotfix.service"
