#!/bin/bash
set -euo pipefail

SOURCE_DIR="${1:?source dir required}"
TARGET_DIR="${2:?target dir required}"
UNIT="${3:?unit required}"
XRAY_UNIT="${4:?xray unit required}"
EDGE_ID="${5:?edge id required}"
AGENT_PORT="${6:?agent port required}"
API_ADDR="${7:?api addr required}"
INBOUND_TAG="${8:?inbound tag required}"
EDGE_ENV_FILE="${9:?edge env file required}"
NODE_BIN="${10:-/usr/bin/node}"

systemctl is-active --quiet "$XRAY_UNIT"
test -s "$SOURCE_DIR/agent.env"
test -x "$NODE_BIN"

rm -rf "$TARGET_DIR"
cp -a "$SOURCE_DIR" "$TARGET_DIR"
install -d -m 700 "$(dirname "$EDGE_ENV_FILE")"
touch "$EDGE_ENV_FILE"
chmod 600 "$EDGE_ENV_FILE"

sed -i \
  -e "s/^EDGE_ID=.*/EDGE_ID=$EDGE_ID/" \
  -e "s/^AGENT_PORT=.*/AGENT_PORT=$AGENT_PORT/" \
  -e "s#^EDGE_ENV_FILE=.*#EDGE_ENV_FILE=$EDGE_ENV_FILE#" \
  -e "s/^XRAY_API_ADDR=.*/XRAY_API_ADDR=$API_ADDR/" \
  -e "s/^XRAY_INBOUND_TAG=.*/XRAY_INBOUND_TAG=$INBOUND_TAG/" \
  "$TARGET_DIR/agent.env"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=VPN client hot-sync for $EDGE_ID
After=network-online.target $XRAY_UNIT
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$TARGET_DIR/agent.env
ExecStart=$NODE_BIN $TARGET_DIR/vpn-edge-sync-agent/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.service" >/dev/null
for _ in $(seq 1 20); do
  curl -fsS --max-time 2 "http://127.0.0.1:$AGENT_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:$AGENT_PORT/health" >/dev/null
echo "HOT_SYNC_OK edge=$EDGE_ID port=$AGENT_PORT"
