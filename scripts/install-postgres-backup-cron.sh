#!/bin/bash
set -euo pipefail

SCRIPT="/opt/vpn-panel-api-vps/scripts/backup-postgres.sh"
CRON_LINE="0 3 * * * root $SCRIPT >> /var/log/vpn-panel-postgres-backup.log 2>&1"
CRON_FILE="/etc/cron.d/vpn-panel-postgres-backup"

chmod +x "$SCRIPT"
echo "$CRON_LINE" > "$CRON_FILE"
chmod 644 "$CRON_FILE"
echo "Installed daily backup cron: $CRON_FILE"
