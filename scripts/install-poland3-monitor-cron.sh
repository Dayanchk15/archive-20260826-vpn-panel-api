#!/bin/bash
# Install poland3 health check cron (every 15 min) on VPS.
set -euo pipefail

CRON_LINE='*/15 * * * * root /opt/vpn-panel-api-vps/scripts/monitor-poland3-cron.sh >> /var/log/poland3-monitor.log 2>&1'
MARKER='# vpn-panel-poland3-monitor'

if grep -q "$MARKER" /etc/crontab 2>/dev/null; then
  echo "Cron already installed"
else
  echo "$CRON_LINE $MARKER" >> /etc/crontab
  echo "Installed: $CRON_LINE"
fi

chmod +x /opt/vpn-panel-api-vps/scripts/monitor-poland3-cron.sh
/opt/vpn-panel-api-vps/scripts/monitor-poland3-cron.sh && echo "Initial check OK" || echo "Initial check FAILED (see output above)"
