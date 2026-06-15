#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/../.." && pwd)"
TOPIC_JSON="${1:?Usage: AGENT=claude|codex scripts/agent-research.sh public/data/articles/<topic>.json}"
AGENT="${AGENT:-claude}"
OUT_DIR="${TECH_RADAR_RESEARCH_DIR:-$APP_DIR/research-notes}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TOPIC_NAME="$(basename "$TOPIC_JSON" .json)"
OUT_FILE="$OUT_DIR/${STAMP}-${TOPIC_NAME}-${AGENT}.md"

mkdir -p "$OUT_DIR"

PROMPT="$(cat <<'PROMPT_EOF'
You are doing a manual research pass for Tech Radar.

Use the attached topic JSON as your source list. Write a balanced research note that:

- identifies the primary source and secondhand takes
- explains what would make the hot take true
- explains what would make it misleading
- names missing facts that should be checked next
- suggests whether the topic deserves a long article, short update, or no further action

Do not edit files. Do not browse unless your CLI session is explicitly configured to allow it.
PROMPT_EOF
)"

case "$AGENT" in
  claude)
    claude --print --add-dir "$REPO_DIR" "$PROMPT

Topic JSON:
$(cat "$TOPIC_JSON")" > "$OUT_FILE"
    ;;
  codex)
    {
      printf '%s\n\n' "$PROMPT"
      printf 'Topic JSON:\n'
      cat "$TOPIC_JSON"
    } | codex exec --cd "$REPO_DIR" --sandbox read-only --ask-for-approval never - > "$OUT_FILE"
    ;;
  *)
    echo "Unknown AGENT=$AGENT. Use AGENT=claude or AGENT=codex." >&2
    exit 1
    ;;
esac

echo "$OUT_FILE"
