#!/usr/bin/env bash
# Install reliability cron jobs on VPS host (runs inside vpn-panel-api-vps container).
set -euo pipefail

MARKER="# vpn-panel-reliability"
LOG_SYNC="/var/log/vpn-sync-cron.log"
LOG_MONITOR="/var/log/vpn-monitor-cron.log"
LOG_TLS="/var/log/vpn-tls-monitor.log"
LOG_UUID="/var/log/vpn-uuid-drift.log"
LOG_TRIM="/var/log/vpn-trim-revisions.log"
LOG_PREWARM="/var/log/vpn-prewarm-cron.log"
LOG_DIGEST="/var/log/vpn-daily-digest.log"
LOG_STABILIZE="/var/log/vpn-stabilize-cron.log"
CONTAINER="${VPN_PANEL_CONTAINER:-vpn-panel-api-vps}"

touch "$LOG_SYNC" "$LOG_MONITOR" "$LOG_TLS" "$LOG_UUID" "$LOG_TRIM" "$LOG_PREWARM" "$LOG_DIGEST" "$LOG_STABILIZE"

NEW_LINES=$(cat <<EOF
2,17,32,47 * * * * docker exec $CONTAINER node /app/scripts/sync-euphoric-only.mjs >> $LOG_SYNC 2>&1 $MARKER-sync
5,35 * * * * docker exec -e NODE_AUTO_FIX=true -e MONITOR_TELEGRAM=true $CONTAINER node /app/scripts/monitor-all-nodes.mjs >> $LOG_MONITOR 2>&1 $MARKER-monitor
8,18,28,38,48,58 * * * * docker exec $CONTAINER node /app/scripts/monitor-tls-connect.mjs >> $LOG_TLS 2>&1 $MARKER-tls
*/8 * * * * docker exec -e PREWARM_PEAK_ONLY=true $CONTAINER node /app/scripts/prewarm-cold-nodes.mjs >> $LOG_PREWARM 2>&1 $MARKER-prewarm
15 */6 * * * docker exec $CONTAINER node /app/scripts/check-uuid-drift-light.mjs >> $LOG_UUID 2>&1 $MARKER-uuid
30 4 * * * docker exec $CONTAINER node /app/scripts/trim-euphoric-revisions.mjs >> $LOG_TRIM 2>&1 $MARKER-trim
0 8 * * * docker exec $CONTAINER node /app/scripts/telegram-daily-digest.mjs >> $LOG_DIGEST 2>&1 $MARKER-digest
10 */6 * * * docker exec $CONTAINER node /app/scripts/stabilize-subscription.mjs >> $LOG_STABILIZE 2>&1 $MARKER-stabilize
EOF
)

( crontab -l 2>/dev/null | grep -v "$MARKER" || true; echo "$NEW_LINES" ) | crontab -

echo "Installed reliability cron (sync, monitor, tls-probe, prewarm, uuid-drift, revision trim, daily digest)"
crontab -l | grep "$MARKER" || true
