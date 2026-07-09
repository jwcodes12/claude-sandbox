#!/usr/bin/env bash
# systemd entrypoint for the nightly pipeline. Sets up the studio env, finds the
# AI CLIs, and tees a dated log. Auth (CLAUDE_CODE_OAUTH_TOKEN) comes from the
# EnvironmentFile in the unit.
set -uo pipefail

export STUDIO_HOME=/home/studio
export STUDIO_WEB=/srv/studio
export HOME=/home/studio
# claude/gemini/codex may live in the studio user's ~/.local/bin or in linuxbrew.
export PATH="/home/studio/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

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
