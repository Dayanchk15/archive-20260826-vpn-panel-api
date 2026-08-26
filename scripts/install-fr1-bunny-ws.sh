#!/bin/bash
# Replace only the isolated, unpublished FR1 Bunny pilot with VLESS+WS.
set -euo pipefail

XRAY=/usr/local/bin/xray
DIR=/opt/vpn-fr1-bunny-xhttp
CONFIG="$DIR/config.json"
UNIT=xray-fr1-bunny-xhttp
PORT="${1:-18092}"
PRODUCTION_UNIT=xray-relay-v2.service

PRODUCTION_PID_BEFORE="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test -n "$PRODUCTION_PID_BEFORE"
test "$PRODUCTION_PID_BEFORE" != "0"
systemctl is-active --quiet "$PRODUCTION_UNIT"

mkdir -p "$DIR"
install -m 600 /tmp/fr1-bunny-ws.json "$CONFIG"
"$XRAY" run -test -config "$CONFIG"
systemctl restart "$UNIT"
sleep 2

systemctl is-active --quiet "$UNIT"
ss -lntp | grep -E ":${PORT}\\b" >/dev/null
PRODUCTION_PID_AFTER="$(systemctl show -p MainPID --value "$PRODUCTION_UNIT")"
test "$PRODUCTION_PID_AFTER" = "$PRODUCTION_PID_BEFORE"
rm -f /tmp/fr1-bunny-ws.json

echo "FR1_BUNNY_WS_OK port=${PORT} productionPid=${PRODUCTION_PID_AFTER}"
