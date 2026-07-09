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
sudo -u $U sqlite3 /home/studio/data/studio.sqlite \
  "INSERT OR IGNORE INTO model_stats(role,model,output_type) VALUES
   ('builder','claude','any'),('code-critic','claude','any');"

echo "== env file placeholder =="
if [ ! -f /home/studio/.config/studio/env ]; then
  printf '# Set by: sudo -u studio claude setup-token\nCLAUDE_CODE_OAUTH_TOKEN=\n' \
    > /home/studio/.config/studio/env
  chown $U:$U /home/studio/.config/studio/env
  chmod 600 /home/studio/.config/studio/env
  echo "  wrote placeholder env (TOKEN empty — fill before enabling timer)"
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

echo "== systemd units =="
install -m 644 "$SRC"/systemd/studio-votes.service   /etc/systemd/system/
install -m 644 "$SRC"/systemd/studio-nightly.service /etc/systemd/system/
install -m 644 "$SRC"/systemd/studio-nightly.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now studio-votes.service
echo "  vote service:"; systemctl is-active studio-votes.service

echo
echo "DONE. Nightly timer is installed but NOT enabled."
echo "To go live nightly:"
echo "  sudo -u studio claude setup-token   # paste into /home/studio/.config/studio/env"
echo "  sudo systemctl enable --now studio-nightly.timer"
