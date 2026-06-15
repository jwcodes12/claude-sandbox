#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$APP_DIR/.vercel/output"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI is not installed. Install with: npm install -g vercel" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/public" ]]; then
  echo "Missing public directory. Run npm run worker:force -w @claude-sandbox/tech-radar first." >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/static"
cp -a "$APP_DIR/public/." "$OUTPUT_DIR/static/"
cat > "$OUTPUT_DIR/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    {
      "src": "/(.*)",
      "headers": {
        "Cache-Control": "public, max-age=300"
      },
      "continue": true
    },
    {
      "src": "/data/(.*)",
      "headers": {
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600"
      },
      "continue": true
    }
  ]
}
JSON

args=(deploy --prod --yes --prebuilt "$APP_DIR")

if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  args+=(--token="$VERCEL_TOKEN")
fi

if [[ -n "${VERCEL_SCOPE:-}" ]]; then
  args+=(--scope="$VERCEL_SCOPE")
fi

exec vercel "${args[@]}"
