#!/bin/bash
set -euo pipefail

SOURCE=/opt/vpn-standalone-sync-pilot-fornex-reality
TARGET=/opt/vpn-standalone-sync-pilot-fornex-ws
ENV_FILE="$TARGET/agent.env"
UNIT=vpn-standalone-sync-pilot-fornex-ws.service
XRAY_CONFIG=/opt/vpn-fornex-test/config.json
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/fornex-ws-hot-sync-${STAMP}"
MIN_CLIENTS="${MIN_CLIENTS:-1}"

[ -d "$SOURCE" ] || { echo "Source sync agent is missing" >&2; exit 1; }
[ -s "$XRAY_CONFIG" ] || { echo "Fornex Xray config is missing" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
cp "$XRAY_CONFIG" "$BACKUP_DIR/config.json"

systemctl stop "$UNIT" 2>/dev/null || true
rm -rf "$TARGET"
cp -a "$SOURCE" "$TARGET"
sed -i '/^EDGE_SYNC_FINGERPRINT=/d' "$ENV_FILE"
sed -i '/^VLESS_CLIENTS_JSON=/d' "$ENV_FILE"
sed -i '/^AGENT_PORT=/d' "$ENV_FILE"
sed -i '/^EDGE_ENV_FILE=/d' "$ENV_FILE"
sed -i 's/^EDGE_ID=.*/EDGE_ID=pilot-fornex-reality/' "$ENV_FILE"
sed -i 's/^XRAY_INBOUND_TAG=.*/XRAY_INBOUND_TAG=vless-ws-fastly-origin/' "$ENV_FILE"
sed -i 's/^XRAY_CLIENT_FLOW=.*/XRAY_CLIENT_FLOW=/' "$ENV_FILE"
printf '\nAGENT_PORT=19224\nEDGE_ENV_FILE=%s\n' "$ENV_FILE" >> "$ENV_FILE"

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Standalone Xray WS client hot-sync for Fornex relay
After=network-online.target xray-fornex-test.service
Wants=network-online.target
Requires=xray-fornex-test.service

[Service]
Type=simple
WorkingDirectory=${TARGET}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${TARGET}/vpn-edge-sync-agent/server.mjs
ExecStartPre=/usr/bin/sed -i /^EDGE_SYNC_FINGERPRINT=/d ${ENV_FILE}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT"

for _ in $(seq 1 30); do
  STATUS="$(curl -fsS --max-time 3 http://127.0.0.1:19224/v1/status 2>/dev/null || true)"
  COUNT="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("clientCount", 0))' 2>/dev/null || echo 0)"
  if [ "$COUNT" -ge "$MIN_CLIENTS" ]; then break; fi
  sleep 2
done
[ "${COUNT:-0}" -ge "$MIN_CLIENTS" ] || { journalctl -u "$UNIT" -n 80 --no-pager; exit 1; }

CURRENT_JSON=/tmp/fornex-ws-current-users.json
if ! grep -q '^VLESS_CLIENTS_JSON=' "$ENV_FILE"; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  node "$TARGET/vpn-edge/xray-client-diff.js" list > "$CURRENT_JSON"
fi

python3 - "$ENV_FILE" "$XRAY_CONFIG" "$CURRENT_JSON" <<'PY'
import json
from pathlib import Path
import sys

env_path, config_path, current_path = map(Path, sys.argv[1:])
line = next(
    (item for item in env_path.read_text().splitlines() if item.startswith("VLESS_CLIENTS_JSON=")),
    None,
)
clients = json.loads(line.split("=", 1)[1]) if line else json.loads(current_path.read_text())
if not clients:
    raise SystemExit("No active clients were returned by the sync agent")
runtime_clients = [
    {"id": item["uuid"], "email": item.get("email") or f'user-{item["uuid"][:8]}', "level": 0}
    for item in clients
]
config = json.loads(config_path.read_text())
inbound = next((x for x in config.get("inbounds", []) if x.get("tag") == "vless-ws-fastly-origin"), None)
if not inbound:
    raise SystemExit("Fornex WS inbound is missing")
inbound["settings"]["clients"] = runtime_clients
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"durableClientCount": len(runtime_clients)}))
PY

/usr/local/bin/xray run -test -config "$XRAY_CONFIG"
rm -f "$CURRENT_JSON"
systemctl is-active --quiet xray-fornex-test.service
systemctl is-active --quiet "$UNIT"
echo "FORNEX_WS_HOT_SYNC_OK clientCount=$COUNT backup=$BACKUP_DIR"
