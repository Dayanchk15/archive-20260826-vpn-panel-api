#!/bin/bash
# Install probe cron on panel VPS (no deploy / no sub refresh).
set -euo pipefail
LOG_DIR=/opt/vpn-panel/logs
LOG_FILE="$LOG_DIR/relay-probe.log"
CRON_LINE='*/12 * * * * docker exec vpn-panel-api-vps node /data/files/stability-cron-probe.mjs >> /opt/vpn-panel/logs/relay-probe.log 2>&1'

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"
chmod 644 "$LOG_FILE"

if crontab -l 2>/dev/null | grep -q 'stability-cron-probe.mjs'; then
  echo "cron already installed"
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "cron installed"
fi

crontab -l | grep stability-cron-probe || true
