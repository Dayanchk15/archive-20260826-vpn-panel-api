#!/bin/bash
set -euo pipefail

XRAY=/usr/local/bin/xray
CONFIG=/opt/vpn-fr1-tcp-pilot/config.json
BACKUP=/opt/vpn-fr1-tcp-pilot/config.tcp-backup.json
INFO=/opt/vpn-fr1-tcp-pilot/reality-client-info
UNIT=xray-fr1-tcp-pilot
SNI=www.google.com

PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"
if [ -z "$PRODUCTION_PID_BEFORE" ]; then
  echo "FR1 production relay is not running; refusing conversion" >&2
  exit 1
fi
[ -s "$CONFIG" ] || { echo "FR1 pilot config missing" >&2; exit 1; }

if ss -ltnp | awk '$4 ~ /:443$/ {found=1} END {exit !found}'; then
  echo "Port 443 is already in use; refusing conversion" >&2
  exit 1
fi

curl -sS -o /dev/null --max-time 15 "https://$SNI/" ||
  { echo "REALITY target $SNI is not reachable" >&2; exit 1; }

cp "$CONFIG" "$BACKUP"

KEY_OUTPUT="$("$XRAY" x25519)"
PRIVATE_KEY="$(printf '%s\n' "$KEY_OUTPUT" | awk -F': ' 'tolower($1) ~ /private/ {print $2; exit}')"
PUBLIC_KEY="$(printf '%s\n' "$KEY_OUTPUT" | awk -F': ' 'tolower($1) ~ /public|password/ {print $2; exit}')"
SHORT_ID="$(openssl rand -hex 8)"

[ -n "$PRIVATE_KEY" ] || { echo "Could not parse private key" >&2; exit 1; }
[ -n "$PUBLIC_KEY" ] || { echo "Could not parse public key" >&2; exit 1; }

PRIVATE_KEY="$PRIVATE_KEY" SHORT_ID="$SHORT_ID" SNI="$SNI" CONFIG="$CONFIG" python3 <<'PY'
import json
import os

path = os.environ["CONFIG"]
with open(path, encoding="utf-8") as source:
    config = json.load(source)

pilot = next(item for item in config["inbounds"] if item.get("tag") == "vless-tcp-in")
pilot["port"] = 443
pilot["settings"]["decryption"] = "none"
for client in pilot["settings"].get("clients", []):
    client["flow"] = "xtls-rprx-vision"

pilot["streamSettings"] = {
    "network": "tcp",
    "security": "reality",
    "realitySettings": {
        "show": False,
        "dest": f'{os.environ["SNI"]}:443',
        "xver": 0,
        "serverNames": [os.environ["SNI"]],
        "privateKey": os.environ["PRIVATE_KEY"],
        "shortIds": [os.environ["SHORT_ID"]],
    },
    "sockopt": {
        "tcpNoDelay": True,
        "tcpKeepAliveIdle": 60,
        "tcpKeepAliveInterval": 30,
    },
}
pilot["sniffing"] = {
    "enabled": True,
    "destOverride": ["http", "tls", "quic"],
    "routeOnly": False,
}

with open(path, "w", encoding="utf-8") as destination:
    json.dump(config, destination, indent=2)
PY

if ! "$XRAY" run -test -config "$CONFIG"; then
  cp "$BACKUP" "$CONFIG"
  echo "REALITY config invalid; original restored" >&2
  exit 1
fi

systemctl restart "$UNIT"
sleep 2
if ! systemctl is-active --quiet "$UNIT"; then
  cp "$BACKUP" "$CONFIG"
  systemctl restart "$UNIT"
  echo "REALITY service failed; original TCP pilot restored" >&2
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw delete allow 18443/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
fi
while iptables -C INPUT -p tcp --dport 18443 -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 18443 -j ACCEPT
done
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null ||
  iptables -I INPUT -p tcp --dport 443 -j ACCEPT

cat > "$INFO" <<EOF
PUBLIC_KEY=$PUBLIC_KEY
SHORT_ID=$SHORT_ID
SNI=$SNI
EOF
chmod 600 "$INFO"

PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"
if [ "$PRODUCTION_PID_AFTER" != "$PRODUCTION_PID_BEFORE" ]; then
  echo "FR1 production PID changed unexpectedly" >&2
  exit 1
fi

echo "FR1_REALITY_OK"
echo "PUBLIC_KEY=$PUBLIC_KEY"
echo "SHORT_ID=$SHORT_ID"
echo "production_pid=$PRODUCTION_PID_AFTER"
ss -ltnp | awk '$4 ~ /:(8088|443|10085)$/ {print}'
if ss -ltnp | awk '$4 ~ /:18443$/ {found=1} END {exit !found}'; then
  echo "Old TCP pilot port 18443 is still listening" >&2
  exit 1
fi
