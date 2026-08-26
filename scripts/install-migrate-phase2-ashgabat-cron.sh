#!/bin/bash
set -euo pipefail
ROOT="${1:-/opt/vpn-panel-api-vps}"
MARKER="# vpn-panel-euphoric-phase2-ashgabat"
CRON_LINE="0 0 * * * root TZ=Asia/Ashgabat ${ROOT}/scripts/migrate-phase2-ashgabat-cron.sh >> /var/log/vpn-euphoric-phase2.log 2>&1"

chmod +x "${ROOT}/scripts/migrate-phase2-ashgabat-cron.sh"

# Remove old London-midnight job if present
sed -i '/vpn-panel-euphoric-migration/d' /etc/crontab 2>/dev/null || true

if grep -q "$MARKER" /etc/crontab 2>/dev/null; then
  echo "Phase2 Ashgabat cron already installed"
else
  echo "$CRON_LINE $MARKER" >> /etc/crontab
  echo "Installed: $CRON_LINE"
fi

echo "Phase 2 runs daily at 00:00 Asia/Ashgabat (skips if phase2Pending=false)"
