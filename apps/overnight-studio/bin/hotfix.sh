#!/usr/bin/env bash
# systemd entrypoint for the feedback hot-fix scan. Same env as nightly.sh.
set -uo pipefail
export STUDIO_HOME=/home/studio
export STUDIO_WEB=/srv/studio
export PATH="/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin:${PATH:-}"
[ -f /home/studio/.config/studio/env ] && { set -a; . /home/studio/.config/studio/env; set +a; }

ts="$(date +%Y%m%d-%H%M%S)"
mkdir -p /home/studio/logs
log="/home/studio/logs/hotfix-${ts}.log"
exec >>"$log" 2>&1
echo "=== Overnight Studio hot-fix scan ${ts} ==="
python3 /home/studio/bin/nightly.py hotfix
echo "=== done rc=$? ==="
