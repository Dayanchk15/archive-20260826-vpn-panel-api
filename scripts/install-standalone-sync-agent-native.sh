#!/bin/bash
set -euo pipefail

EDGE_ID="${EDGE_ID:?EDGE_ID is required}"
EDGE_DIR="${EDGE_DIR:?EDGE_DIR is required}"
XRAY_API_ADDR="${XRAY_API_ADDR:?XRAY_API_ADDR is required}"
XRAY_INBOUND_TAG="${XRAY_INBOUND_TAG:?XRAY_INBOUND_TAG is required}"
XRAY_CLIENT_FLOW="${XRAY_CLIENT_FLOW:-}"
AGENT_PORT="${AGENT_PORT:?AGENT_PORT is required}"
SOURCE=/tmp/standalone-sync-source
KEY_FILE=/tmp/standalone-sync-key
DEPLOY_DIR="/opt/vpn-standalone-sync-${EDGE_ID}"
UNIT="vpn-standalone-sync-${EDGE_ID}"

[ -s "$SOURCE/vpn-edge-sync-agent/server.mjs" ] || {
  echo "Standalone sync source is missing" >&2
  exit 1
}
[ -s "$KEY_FILE" ] || { echo "Standalone sync key is missing" >&2; exit 1; }

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends nodejs npm
fi

rm -rf "$DEPLOY_DIR"
install -d -m 700 "$DEPLOY_DIR"
cp -a "$SOURCE/." "$DEPLOY_DIR/"
cat >"$DEPLOY_DIR/package.json" <<'EOF'
{"type":"module"}
EOF
(
  cd "$DEPLOY_DIR/vpn-edge-sync-agent"
  npm install --omit=dev
)
ln -sfn "$DEPLOY_DIR/vpn-edge-sync-agent/node_modules" "$DEPLOY_DIR/node_modules"
install -m 600 /dev/null "$EDGE_DIR/sync.env"

key="$(tr -d '\r\n' <"$KEY_FILE")"
[ -n "$key" ] || { echo "Standalone sync key is empty" >&2; exit 1; }
cat >"$DEPLOY_DIR/agent.env" <<EOF
EDGE_ID=$EDGE_ID
EDGE_SYNC_KEY=$key
PANEL_PULL_URL=https://sub.twidu.com/internal/edge/clients
PANEL_PULL_INTERVAL_MS=15000
AGENT_PORT=$AGENT_PORT
EDGE_ENV_FILE=$EDGE_DIR/sync.env
XRAY_BIN=/usr/local/bin/xray
XRAY_API_ADDR=$XRAY_API_ADDR
XRAY_INBOUND_TAG=$XRAY_INBOUND_TAG
XRAY_CLIENT_FLOW=$XRAY_CLIENT_FLOW
EDGE_SYNC_ALLOW_RESTART=false
EOF
chmod 600 "$DEPLOY_DIR/agent.env"

cat >"/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=Standalone Xray client hot-sync ($EDGE_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DEPLOY_DIR
EnvironmentFile=$DEPLOY_DIR/agent.env
ExecStart=/usr/bin/node $DEPLOY_DIR/vpn-edge-sync-agent/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT"
for _ in $(seq 1 12); do
  if curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null
sleep 18
status="$(curl -fsS --max-time 10 "http://127.0.0.1:${AGENT_PORT}/v1/status")"
python3 - "$status" <<'PY'
import json
import sys

status = json.loads(sys.argv[1])
if not status.get("ok"):
    raise SystemExit("Sync status is not OK")
if status.get("lastError"):
    raise SystemExit(f"Sync error: {status['lastError']}")
if int(status.get("clientCount") or 0) < 1:
    raise SystemExit("Sync agent reports no clients")
print(json.dumps({
    "ok": True,
    "edgeId": status.get("edgeId"),
    "clientCount": status.get("clientCount"),
    "lastAppliedAt": status.get("lastAppliedAt"),
    "applyMode": status.get("applyMode"),
}, indent=2))
PY

rm -rf "$SOURCE" "$KEY_FILE"
echo "STANDALONE_NATIVE_SYNC_OK edge=$EDGE_ID tag=$XRAY_INBOUND_TAG"
