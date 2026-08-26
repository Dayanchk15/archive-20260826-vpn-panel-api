#!/bin/bash
set -euo pipefail

UNIT=xray-tampa-reality
CONFIG=/opt/vpn-tampa-reality/config.json
CLIENT_INFO=/opt/vpn-tampa-reality/client-info
CADDYFILE=/etc/caddy/Caddyfile
CADDY_BACKUP=/etc/caddy/Caddyfile.pre-tampa-reality
PORT=9443

PROD_CONTAINER_BEFORE="$(docker inspect -f '{{.Id}}' glb-vps-edge-vpn-glb-edge-1)"
[ -s "$CADDY_BACKUP" ] || { echo "Caddy backup is missing" >&2; exit 1; }
[ -s "$CONFIG" ] || { echo "REALITY config is missing" >&2; exit 1; }

cp "$CADDY_BACKUP" "$CADDYFILE"
caddy validate --config "$CADDYFILE"

python3 - /etc/systemd/system/${UNIT}.service <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = "-p 127.0.0.1:9443:9443/tcp"
new = "-p 0.0.0.0:9443:9443/tcp"
if old not in text and new not in text:
    raise SystemExit("Expected Docker port mapping not found")
path.write_text(text.replace(old, new, 1))
PY

systemctl stop haproxy 2>/dev/null || true
systemctl disable haproxy >/dev/null 2>&1 || true
systemctl restart caddy
systemctl daemon-reload
systemctl restart "$UNIT"
sleep 2

if command -v ufw >/dev/null 2>&1; then
  ufw allow "$PORT/tcp" >/dev/null
fi

systemctl is-active --quiet caddy
systemctl is-active --quiet "$UNIT"
systemctl is-active --quiet moonlight-proxy
if systemctl is-active --quiet haproxy; then
  echo "HAProxy should be stopped" >&2
  exit 1
fi

curl -fsS --max-time 15 https://levospeed.it.com/health >/dev/null
PROD_CONTAINER_AFTER="$(docker inspect -f '{{.Id}}' glb-vps-edge-vpn-glb-edge-1)"
[ "$PROD_CONTAINER_AFTER" = "$PROD_CONTAINER_BEFORE" ] || {
  echo "Production container changed unexpectedly" >&2
  exit 1
}
ss -ltnp | grep -q "0.0.0.0:${PORT} "
ss -ltnp | grep -q "\\*:443 "
ss -ltnp | grep -q ":8080 "

python3 - "$CLIENT_INFO" "$PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
port = sys.argv[2]
lines = path.read_text().splitlines()
result = []
found = False
for line in lines:
    if line.startswith("PUBLIC_PORT="):
        result.append(f"PUBLIC_PORT={port}")
        found = True
    else:
        result.append(line)
if not found:
    result.append(f"PUBLIC_PORT={port}")
path.write_text("\n".join(result) + "\n")
PY
chmod 600 "$CLIENT_INFO"

rm -f /tmp/fix-tampa-reality-routing.sh
echo "TAMPA_REALITY_DIRECT_PORT_OK"
echo "PUBLIC_PORT=$PORT"
echo "PRODUCTION_CONTAINER=$PROD_CONTAINER_AFTER"
