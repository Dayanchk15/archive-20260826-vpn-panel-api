#!/bin/bash
set -euo pipefail

SOURCE_CONFIG="${SOURCE_CONFIG:-/tmp/cloudflare-ws-origin-all-users.json}"
CONFIG="/opt/vpn-cloudflare-ws/config.json"
UNIT="xray-cloudflare-ws.service"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="${CONFIG}.pre-all-users.${STAMP}"

/usr/local/bin/xray run -test -config "$SOURCE_CONFIG"
cp -a "$CONFIG" "$BACKUP"
install -m 0644 "$SOURCE_CONFIG" "$CONFIG"

if ! systemctl restart "$UNIT" || ! systemctl is-active --quiet "$UNIT"; then
  cp -a "$BACKUP" "$CONFIG"
  systemctl restart "$UNIT"
  systemctl is-active --quiet "$UNIT"
  echo "Xray update failed and was rolled back to $BACKUP" >&2
  exit 1
fi

sleep 3
ss -lntp | grep -E '127.0.0.1:(18094|10094)'
/usr/local/bin/xray api statsquery --server=127.0.0.1:10094 -pattern traffic >/dev/null
python3 - "$CONFIG" "$BACKUP" <<'PY'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
clients = config["inbounds"][0]["settings"]["clients"]
print(f"clients={len(clients)} backup={sys.argv[2]}")
PY
