#!/bin/sh
set -eu

SOURCE_DIR="${1:?source standalone agent directory required}"
EDGE_ID="${2:?edge id required}"
API_PORT="${3:?API port required}"
TARGET=/opt/vpn-standalone-sync-relay-v2
SERVICE=/etc/systemd/system/vpn-standalone-sync-relay-v2.service

if [ ! -d "$TARGET" ]; then
  cp -a "$SOURCE_DIR" "$TARGET"
fi

ENV_FILE="$TARGET/agent.env"
set_env() {
  key="$1"
  value="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s#^$key=.*#$key=$value#" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

set_env EDGE_ID "$EDGE_ID"
set_env XRAY_BIN /usr/local/bin/xray-relay-v2
set_env XRAY_API_ADDR "127.0.0.1:$API_PORT"
set_env XRAY_INBOUND_TAG vless-tcp-in
set_env AGENT_PORT 19222
set_env EDGE_ENV_FILE "$ENV_FILE"
set_env EDGE_SYNC_ALLOW_RESTART false
sed -i '/^EDGE_SYNC_FINGERPRINT=/d' "$ENV_FILE"
chmod 0600 "$ENV_FILE"

cat >"$SERVICE" <<EOF
[Unit]
Description=Relay v2 client hot-sync ($EDGE_ID)
After=network-online.target xray-relay-v2.service
Wants=network-online.target
Requires=xray-relay-v2.service

[Service]
Type=simple
WorkingDirectory=$TARGET
EnvironmentFile=$ENV_FILE
ExecStartPre=/usr/bin/sed -i /^EDGE_SYNC_FINGERPRINT=/d $ENV_FILE
ExecStart=/usr/bin/node $TARGET/vpn-edge-sync-agent/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now vpn-standalone-sync-relay-v2.service
for _ in $(seq 1 30); do
  status="$(curl -fsS --max-time 2 http://127.0.0.1:19222/v1/status 2>/dev/null || true)"
  echo "$status" | grep -q '"lastError":null' && break
  sleep 1
done
curl -fsS --max-time 3 http://127.0.0.1:19222/v1/status
echo
echo "NATIVE_RELAY_V2_AGENT_OK edge=$EDGE_ID api=$API_PORT"
