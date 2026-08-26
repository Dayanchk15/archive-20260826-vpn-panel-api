#!/bin/bash
# Configure FR2 VPS as Fastly origin for VLESS xHTTP TLS pilot.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin

PILOT_DIR=/opt/vpn-fr2-xhttp-pilot
CONFIG="$PILOT_DIR/config.json"
PORT="${1:-8443}"
DOMAIN="${2:-france2.levospeed.click}"
UNIT=xray-fr2-xhttp-pilot
LOG=/var/log/vpn-fr2-xhttp-pilot.log
XRAY=/usr/local/bin/xray

mkdir -p "$PILOT_DIR"
if [ -f /tmp/fr2-xhttp-pilot.json ]; then
  cp /tmp/fr2-xhttp-pilot.json "$CONFIG"
fi

if ! [ -x "$XRAY" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq unzip curl ca-certificates openssl >/dev/null 2>&1 || true
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v24.12.31/Xray-linux-64.zip" -o /tmp/xray.zip
  unzip -jo /tmp/xray.zip xray -d /usr/local/bin
  chmod +x /usr/local/bin/xray
  rm -f /tmp/xray.zip
fi

openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$PILOT_DIR/key.pem" \
  -out "$PILOT_DIR/cert.pem" \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN},IP:185.209.230.46"
chmod 600 "$PILOT_DIR/key.pem"

"$XRAY" run -test -config "$CONFIG"

cat > /etc/systemd/system/${UNIT}.service <<EOF
[Unit]
Description=FR2 VLESS xHTTP TLS pilot (Fastly origin)
After=network.target

[Service]
Type=simple
ExecStart=$XRAY run -c $CONFIG
Restart=on-failure
RestartSec=5
StandardOutput=append:$LOG
StandardError=append:$LOG

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${UNIT}
systemctl restart ${UNIT}
sleep 2

ufw allow ${PORT}/tcp >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null || true

systemctl is-active ${UNIT}
ss -tlnp | grep -E ":${PORT}\\b" || (journalctl -u ${UNIT} -n 20 --no-pager; exit 1)

echo "OK fr2-fastly-origin domain=${DOMAIN} port=${PORT}"
echo "--- production 8089 untouched ---"
ss -tlnp | grep 8089 || true
