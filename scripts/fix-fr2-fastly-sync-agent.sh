#!/bin/sh
set -eu

UNIT=/etc/systemd/system/vpn-standalone-sync-pilot-fr2-xhttp.service
ENV_FILE=/opt/vpn-standalone-sync-pilot-fr2-xhttp/agent.env
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

systemctl is-active --quiet xray-fr2-fastly-v2.service
grep -q '^XRAY_API_ADDR=127.0.0.1:10088$' "$ENV_FILE"
grep -q '^XRAY_INBOUND_TAG=vless-xhttp-plain-fastly$' "$ENV_FILE"

cp -a "$UNIT" "$UNIT.pre-v2-sync-$STAMP.bak"
sed -i \
  -e 's/xray-fr2-fastly\.service/xray-fr2-fastly-v2.service/g' \
  "$UNIT"

systemctl daemon-reload
# Only the Node hot-sync agent is restarted. The Xray services are untouched.
systemctl restart vpn-standalone-sync-pilot-fr2-xhttp.service

for _ in $(seq 1 20); do
  curl -fsS --max-time 2 http://127.0.0.1:19226/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:19226/health
systemctl is-active --quiet xray-fr2-fastly-v2.service
systemctl is-active --quiet xray-fr2-fastly.service
echo
echo "FR2_FASTLY_SYNC_AGENT_V2_OK backup=$UNIT.pre-v2-sync-$STAMP.bak"
