#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI is not installed. Install with: npm install -g vercel" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/public" ]]; then
  echo "Missing public directory. Run npm run worker:force -w @claude-sandbox/tech-radar first." >&2
  exit 1
fi

exec vercel deploy --prod "$APP_DIR/public"
