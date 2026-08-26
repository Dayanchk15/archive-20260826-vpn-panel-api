#!/bin/bash
set -euo pipefail

XRAY_IMAGE="${XRAY_IMAGE:-ghcr.io/xtls/xray-core:latest}"
SYNC_IMAGE="${SYNC_IMAGE:-vpn-edge-sync-agent-vpn-standalone-sync-agent}"
SOURCE_CONFIG=/opt/vpn-tampa-reality/config.json
TARGET_DIR=/opt/vpn-tampa-fastly-xhttp
TARGET_CONFIG="$TARGET_DIR/config.json"
XRAY_CONTAINER=xray-tampa-fastly-xhttp
SYNC_CONTAINER=vpn-tampa-fastly-xhttp-sync-agent
XRAY_TAG=vless-xhttp-fastly-origin
XRAY_PORT=18444
XRAY_API_PORT=10087
AGENT_PORT=19225
MIN_CLIENTS="${MIN_CLIENTS:-1}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/tampa-fastly-xhttp-${STAMP}"

[ -s "$SOURCE_CONFIG" ] || { echo "Tampa Reality config is missing" >&2; exit 1; }
docker inspect xray-tampa-reality >/dev/null
docker inspect vpn-tampa-reality-sync-agent >/dev/null
REALITY_PID_BEFORE="$(docker inspect -f '{{.State.Pid}}' xray-tampa-reality)"
RELAY_PID_BEFORE="$(docker inspect -f '{{.State.Pid}}' glb-vps-edge-vpn-glb-edge-1)"

if ss -ltnH | awk '{print $4}' | grep -Eq ":(${XRAY_PORT}|${XRAY_API_PORT}|${AGENT_PORT})$"; then
  if ! docker inspect "$XRAY_CONTAINER" >/dev/null 2>&1; then
    echo "A required Tampa Fastly pilot port is already occupied" >&2
    exit 1
  fi
fi

mkdir -p "$TARGET_DIR" "$BACKUP_DIR"
[ ! -s "$TARGET_CONFIG" ] || cp "$TARGET_CONFIG" "$BACKUP_DIR/config.json"

python3 - "$SOURCE_CONFIG" "$TARGET_CONFIG" "$XRAY_TAG" "$XRAY_PORT" "$XRAY_API_PORT" <<'PY'
import json
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:3])
tag, port, api_port = sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
base = json.loads(source.read_text())
reality = next((x for x in base.get("inbounds", []) if x.get("tag") == "vless-reality-direct"), None)
if not reality:
    raise SystemExit("Tampa Reality inbound is missing")
clients = []
for item in reality.get("settings", {}).get("clients", []):
    clients.append({"id": item["id"], "email": item.get("email") or f'user-{item["id"][:8]}', "level": 0})
if not clients:
    raise SystemExit("Tampa source client list is empty")
config = {
    "log": {"loglevel": "warning"},
    "api": {"tag": "api", "services": ["StatsService", "HandlerService"]},
    "stats": {},
    "policy": {
        "levels": {"0": {"statsUserUplink": True, "statsUserDownlink": True}},
        "system": {"statsInboundUplink": True, "statsInboundDownlink": True},
    },
    "inbounds": [
        {
            "tag": tag,
            "listen": "0.0.0.0",
            "port": port,
            "protocol": "vless",
            "settings": {"clients": clients, "decryption": "none"},
            "streamSettings": {
                "network": "xhttp",
                "security": "none",
                "xhttpSettings": {
                    "path": "/",
                    "mode": "auto",
                    "noGRPCHeader": False,
                    "noSSEHeader": False,
                    "xPaddingBytes": "100-1000",
                },
            },
        },
        {
            "tag": "api",
            "listen": "127.0.0.1",
            "port": api_port,
            "protocol": "dokodemo-door",
            "settings": {"address": "127.0.0.1"},
        },
    ],
    "outbounds": [
        {"tag": "direct", "protocol": "freedom"},
        {"tag": "block", "protocol": "blackhole"},
    ],
    "routing": {
        "domainStrategy": "AsIs",
        "rules": [
            {"type": "field", "inboundTag": ["api"], "outboundTag": "api"},
            {"type": "field", "network": "udp", "port": "443", "outboundTag": "block"},
        ],
    },
}
target.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"initialClientCount": len(clients)}))
PY
chmod 600 "$TARGET_CONFIG"

docker run --rm --user 0 -v "$TARGET_CONFIG:/etc/xray/config.json:ro" "$XRAY_IMAGE" run -test -c /etc/xray/config.json
docker rm -f "$XRAY_CONTAINER" "$SYNC_CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$XRAY_CONTAINER" \
  --user 0 \
  --network host \
  --restart unless-stopped \
  -v "$TARGET_CONFIG:/etc/xray/config.json:ro" \
  "$XRAY_IMAGE" run -c /etc/xray/config.json >/dev/null

for _ in $(seq 1 15); do
  ss -ltnH | awk '{print $4}' | grep -q ":${XRAY_PORT}$" && break
  sleep 1
done
ss -ltnH | awk '{print $4}' | grep -q ":${XRAY_PORT}$"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${XRAY_PORT}/tcp" >/dev/null
fi

SYNC_KEY="$(docker inspect vpn-tampa-reality-sync-agent | python3 -c 'import json,sys; d=json.load(sys.stdin)[0]; env=d["Config"].get("Env",[]); print(next(x.split("=",1)[1] for x in env if x.startswith("EDGE_SYNC_KEY=")))')"
[ -n "$SYNC_KEY" ] || { echo "Could not obtain the existing Tampa sync credential" >&2; exit 1; }
touch "$TARGET_DIR/sync.env"
chmod 600 "$TARGET_DIR/sync.env"
docker run -d \
  --name "$SYNC_CONTAINER" \
  --network host \
  --restart unless-stopped \
  -e EDGE_ID=pilot-tampa-reality \
  -e EDGE_SYNC_KEY="$SYNC_KEY" \
  -e PANEL_PULL_URL=https://sub.twidu.com/internal/edge/clients \
  -e PANEL_PULL_INTERVAL_MS=15000 \
  -e AGENT_PORT="$AGENT_PORT" \
  -e EDGE_ENV_FILE="$TARGET_DIR/sync.env" \
  -e XRAY_BIN=/usr/local/bin/xray \
  -e XRAY_API_ADDR="127.0.0.1:${XRAY_API_PORT}" \
  -e XRAY_INBOUND_TAG="$XRAY_TAG" \
  -e XRAY_CLIENT_FLOW= \
  -e EDGE_SYNC_ALLOW_RESTART=false \
  -v "$TARGET_DIR:$TARGET_DIR" \
  -v /usr/local/bin/xray:/usr/local/bin/xray:ro \
  "$SYNC_IMAGE" >/dev/null
unset SYNC_KEY

COUNT=0
for _ in $(seq 1 30); do
  STATUS="$(curl -fsS --max-time 3 "http://127.0.0.1:${AGENT_PORT}/v1/status" 2>/dev/null || true)"
  COUNT="$(printf '%s' "$STATUS" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("clientCount", 0))' 2>/dev/null || echo 0)"
  [ "$COUNT" -ge "$MIN_CLIENTS" ] && break
  sleep 2
done
[ "$COUNT" -ge "$MIN_CLIENTS" ] || { docker logs --tail 100 "$SYNC_CONTAINER"; exit 1; }

CURRENT_JSON=/tmp/tampa-fastly-xhttp-current-users.json
docker exec "$SYNC_CONTAINER" node /app/vpn-edge/xray-client-diff.js list > "$CURRENT_JSON"
python3 - "$TARGET_CONFIG" "$CURRENT_JSON" "$XRAY_TAG" <<'PY'
import json
from pathlib import Path
import sys

config_path, current_path = map(Path, sys.argv[1:3])
tag = sys.argv[3]
clients = json.loads(current_path.read_text())
if not clients:
    raise SystemExit("No active Tampa xHTTP clients were returned")
durable = [{"id": x["uuid"], "email": x.get("email") or f'user-{x["uuid"][:8]}', "level": 0} for x in clients]
config = json.loads(config_path.read_text())
inbound = next(x for x in config["inbounds"] if x.get("tag") == tag)
inbound["settings"]["clients"] = durable
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"durableClientCount": len(durable)}))
PY
rm -f "$CURRENT_JSON"

docker run --rm --user 0 -v "$TARGET_CONFIG:/etc/xray/config.json:ro" "$XRAY_IMAGE" run -test -c /etc/xray/config.json
REALITY_PID_AFTER="$(docker inspect -f '{{.State.Pid}}' xray-tampa-reality)"
RELAY_PID_AFTER="$(docker inspect -f '{{.State.Pid}}' glb-vps-edge-vpn-glb-edge-1)"
[ "$REALITY_PID_BEFORE" = "$REALITY_PID_AFTER" ] || { echo "Tampa Reality PID changed unexpectedly" >&2; exit 1; }
[ "$RELAY_PID_BEFORE" = "$RELAY_PID_AFTER" ] || { echo "Tampa relay PID changed unexpectedly" >&2; exit 1; }
echo "TAMPA_FASTLY_XHTTP_ORIGIN_OK clientCount=$COUNT realityPid=$REALITY_PID_AFTER relayPid=$RELAY_PID_AFTER backup=$BACKUP_DIR"
