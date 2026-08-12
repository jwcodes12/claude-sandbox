#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIGEST_JSON="$APP_DIR/public/data/digest.json"
BEFORE=0

if [[ -f "$DIGEST_JSON" ]]; then
  BEFORE="$(stat -c %Y "$DIGEST_JSON" 2>/dev/null || stat -f %m "$DIGEST_JSON")"
fi

npm run worker -w @claude-sandbox/tech-radar

AFTER=0
if [[ -f "$DIGEST_JSON" ]]; then
  AFTER="$(stat -c %Y "$DIGEST_JSON" 2>/dev/null || stat -f %m "$DIGEST_JSON")"
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
  echo "No new Tech Digest build; skipping deploy."
fi
