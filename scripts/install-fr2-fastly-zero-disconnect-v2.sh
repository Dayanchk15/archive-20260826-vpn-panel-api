#!/bin/bash
set -euo pipefail

SOURCE_CONFIG=/opt/vpn-fr2-fastly/config.json
TARGET_DIR=/opt/vpn-fr2-fastly-v2
TARGET_CONFIG="$TARGET_DIR/config.json"
TARGET_PORT=18445
UNIT=xray-fr2-fastly-v2.service
XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray-26.3.27}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="/opt/vpn-fr2-fastly-backups/$STAMP"

test -s "$SOURCE_CONFIG"
if [ ! -x "$XRAY_BIN" ]; then
  XRAY_BIN=/usr/local/bin/xray
fi
mkdir -p "$TARGET_DIR" "$BACKUP_DIR"
cp -a "$SOURCE_CONFIG" "$BACKUP_DIR/config.json"
iptables-save > "$BACKUP_DIR/iptables-save.txt"

python3 - "$SOURCE_CONFIG" "$TARGET_CONFIG" "$TARGET_PORT" <<'PY'
import json
from pathlib import Path
import sys

source, target, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
config = json.loads(Path(source).read_text())
matches = [
    inbound for inbound in config.get("inbounds", [])
    if inbound.get("tag") == "vless-xhttp-plain-fastly"
]
if len(matches) != 1:
    raise SystemExit(f"expected one Fastly inbound, found {len(matches)}")
inbound = matches[0]
inbound["port"] = port
xhttp = inbound.setdefault("streamSettings", {}).setdefault("xhttpSettings", {})
xhttp["path"] = "/"
xhttp["mode"] = "auto"
xhttp["noGRPCHeader"] = False
xhttp["noSSEHeader"] = False
xhttp["xPaddingBytes"] = "100-1000"
xhttp.pop("host", None)
config.setdefault("log", {})["access"] = "/var/log/vpn-fr2-fastly-v2-access.log"
config["log"]["error"] = "/var/log/vpn-fr2-fastly-v2-error.log"
Path(target).write_text(json.dumps(config, indent=2) + "\n")
PY

chmod 600 "$TARGET_CONFIG"
"$XRAY_BIN" run -test -config "$TARGET_CONFIG"

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=FR2 VLESS xHTTP Fastly origin v2 (zero-disconnect rollout)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY_BIN run -c $TARGET_CONFIG
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT"
for _ in $(seq 1 20); do
  ss -ltnH | awk '{print $4}' | grep -q ":${TARGET_PORT}$" && break
  sleep 1
done
systemctl is-active --quiet "$UNIT"
ss -ltnH | awk '{print $4}' | grep -q ":${TARGET_PORT}$"

while iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18444 2>/dev/null; do :; done
iptables -t nat -C PREROUTING -p tcp --dport 18444 -j REDIRECT --to-ports "$TARGET_PORT" 2>/dev/null || \
  iptables -t nat -I PREROUTING 1 -p tcp --dport 18444 -j REDIRECT --to-ports "$TARGET_PORT"
iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$TARGET_PORT" 2>/dev/null || \
  iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$TARGET_PORT"

iptables -t nat -C PREROUTING -p tcp --dport 18444 -j REDIRECT --to-ports "$TARGET_PORT"
iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports "$TARGET_PORT"
systemctl is-active --quiet xray-fr2-fastly.service

python3 - "$TARGET_CONFIG" <<'PY'
import json
from pathlib import Path
import sys
c = json.loads(Path(sys.argv[1]).read_text())
i = next(x for x in c["inbounds"] if x.get("tag") == "vless-xhttp-plain-fastly")
x = i["streamSettings"]["xhttpSettings"]
print({
    "port": i["port"],
    "clients": len(i["settings"]["clients"]),
    "path": x.get("path"),
    "mode": x.get("mode"),
    "noSSEHeader": x.get("noSSEHeader"),
    "xPaddingBytes": x.get("xPaddingBytes"),
})
PY
echo "FR2_FASTLY_V2_READY backup=$BACKUP_DIR old_service=active new_port=$TARGET_PORT"
