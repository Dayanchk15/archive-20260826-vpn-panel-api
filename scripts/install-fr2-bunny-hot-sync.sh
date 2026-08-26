#!/bin/bash
# Clone the proven FR2 hot-sync agent for the isolated Bunny inbound.
set -euo pipefail

SOURCE_DIR=/opt/vpn-standalone-sync-pilot-fr2-xhttp
TARGET_DIR=/opt/vpn-standalone-sync-pilot-fr2-bunny
UNIT=vpn-standalone-sync-pilot-fr2-bunny
SOURCE_ENV="$SOURCE_DIR/agent.env"
TARGET_ENV="$TARGET_DIR/agent.env"
TARGET_EDGE_ENV=/opt/vpn-fr2-bunny-ws/sync.env

systemctl is-active --quiet xray-fr2-bunny-ws.service
[ -s "$SOURCE_ENV" ]

rm -rf "$TARGET_DIR"
cp -a "$SOURCE_DIR" "$TARGET_DIR"
install -m 600 /dev/null "$TARGET_EDGE_ENV"

sed -i \
  -e 's/^EDGE_ID=.*/EDGE_ID=pilot-fr2-bunny/' \
  -e 's/^AGENT_PORT=.*/AGENT_PORT=19227/' \
  -e "s#^EDGE_ENV_FILE=.*#EDGE_ENV_FILE=$TARGET_EDGE_ENV#" \
  -e 's/^XRAY_API_ADDR=.*/XRAY_API_ADDR=127.0.0.1:10089/' \
  -e 's/^XRAY_INBOUND_TAG=.*/XRAY_INBOUND_TAG=vless-bunny-ws-in/' \
  "$TARGET_ENV"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=FR2 Bunny WebSocket client hot-sync
After=network-online.target xray-fr2-bunny-ws.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$TARGET_ENV
ExecStart=/usr/bin/node $TARGET_DIR/vpn-edge-sync-agent/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null

for _ in $(seq 1 20); do
  curl -fsS --max-time 2 http://127.0.0.1:19227/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:19227/health >/dev/null
sleep 18

status="$(curl -fsS --max-time 5 http://127.0.0.1:19227/v1/status)"
python3 - "$status" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
if not status.get('ok') or status.get('lastError'):
    raise SystemExit(status.get('lastError') or 'Bunny hot-sync is not healthy')
if int(status.get('clientCount') or 0) < 1:
    raise SystemExit('Bunny hot-sync has no clients')
print(json.dumps({
    'ok': True,
    'edgeId': status.get('edgeId'),
    'clientCount': status.get('clientCount'),
    'applyMode': status.get('applyMode'),
    'lastAppliedAt': status.get('lastAppliedAt'),
}))
PY

echo FR2_BUNNY_HOT_SYNC_OK
