#!/usr/bin/env bash
# systemd entrypoint for the nightly pipeline. Runs as the studio user, scoped to
# /home/studio (state) and /srv/studio (published output). claude auth lives in
# studio's own ~/.claude/.credentials.json. Sets paths, finds the AI CLIs, tees a
# dated log. HOME is the service user's home so `claude` finds its auth.
set -uo pipefail

export STUDIO_HOME=/home/studio
export STUDIO_WEB=/srv/studio
# claude is the system-wide /usr/bin/claude; gemini (v1) is in linuxbrew.
export PATH="/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ts="$(date +%Y%m%d-%H%M%S)"
mkdir -p /home/studio/logs
log="/home/studio/logs/nightly-${ts}.log"
exec >>"$log" 2>&1

echo "=== Overnight Studio nightly ${ts} ==="
if ! command -v claude >/dev/null 2>&1; then
  echo "FATAL: claude CLI not on PATH for the studio user. Install it and set the OAuth token." >&2
  exit 10
fi
python3 /home/studio/bin/nightly.py
rc=$?
echo "=== done rc=${rc} ==="
exit $rc
