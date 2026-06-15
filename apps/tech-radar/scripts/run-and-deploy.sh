#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOPICS_JSON="$APP_DIR/public/data/topics.json"
BEFORE=0

if [[ -f "$TOPICS_JSON" ]]; then
  BEFORE="$(stat -c %Y "$TOPICS_JSON" 2>/dev/null || stat -f %m "$TOPICS_JSON")"
fi

npm run worker -w @claude-sandbox/tech-radar

AFTER=0
if [[ -f "$TOPICS_JSON" ]]; then
  AFTER="$(stat -c %Y "$TOPICS_JSON" 2>/dev/null || stat -f %m "$TOPICS_JSON")"
fi

if [[ "$AFTER" -gt "$BEFORE" ]]; then
  case "${TECH_RADAR_DEPLOY_PROVIDER:-netlify}" in
    vercel)
      npm run deploy:vercel -w @claude-sandbox/tech-radar
      ;;
    netlify|*)
      npm run deploy:netlify -w @claude-sandbox/tech-radar
      ;;
  esac
else
  echo "No new Tech Radar build; skipping deploy."
fi
