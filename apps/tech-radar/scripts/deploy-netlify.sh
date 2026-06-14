#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v netlify >/dev/null 2>&1; then
  echo "netlify CLI is not installed. Install with: npm install -g netlify-cli" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/public" ]]; then
  echo "Missing public directory. Run npm run worker:force -w @claude-sandbox/tech-radar first." >&2
  exit 1
fi

exec netlify deploy --prod --dir="$APP_DIR/public"
