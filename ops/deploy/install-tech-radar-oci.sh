#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/claude-sandbox}"
CONFIG_DIR="$HOME/.config/claude-sandbox"
SYSTEMD_DIR="$HOME/.config/systemd/user"

mkdir -p "$CONFIG_DIR" "$SYSTEMD_DIR"
mkdir -p "$HOME/.local/state/claude-sandbox/tech-radar"

if [[ ! -f "$CONFIG_DIR/tech-radar.env" ]]; then
  cp "$REPO_DIR/ops/systemd/tech-radar.env.example" "$CONFIG_DIR/tech-radar.env"
  echo "Created $CONFIG_DIR/tech-radar.env. Fill in feed URLs and deploy/model tokens before enabling the timer." >&2
fi

cp "$REPO_DIR/ops/systemd/tech-radar.service" "$SYSTEMD_DIR/tech-radar.service"
cp "$REPO_DIR/ops/systemd/tech-radar.timer" "$SYSTEMD_DIR/tech-radar.timer"

systemctl --user daemon-reload

if [[ "${ENABLE_TECH_RADAR_TIMER:-0}" == "1" ]]; then
  systemctl --user enable tech-radar.timer
fi

echo "Installed tech-radar systemd user timer."
echo "Edit: $CONFIG_DIR/tech-radar.env"
echo "Enable: ENABLE_TECH_RADAR_TIMER=1 $0"
echo "Start:  systemctl --user start tech-radar.timer"
echo "Logs:  journalctl --user -u tech-radar.service -f"
