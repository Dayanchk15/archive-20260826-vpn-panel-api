#!/bin/bash
# Standalone VLESS xHTTP + TLS pilot on FR2 — does NOT touch production xray on :8089.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin

XRAY=/usr/local/bin/xray
PILOT_DIR=/opt/vpn-fr2-xhttp-pilot
CONFIG="$PILOT_DIR/config.json"
PORT="${1:-8443}"
FR2_IP="${2:-185.209.230.46}"
UNIT=xray-fr2-xhttp-pilot
LOG=/var/log/vpn-fr2-xhttp-pilot.log

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

if [ ! -f "$PILOT_DIR/cert.pem" ] || [ ! -f "$PILOT_DIR/key.pem" ]; then
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$PILOT_DIR/key.pem" \
    -out "$PILOT_DIR/cert.pem" \
    -subj "/CN=${FR2_IP}" \
    -addext "subjectAltName=IP:${FR2_IP}"
  chmod 600 "$PILOT_DIR/key.pem"
fi

"$XRAY" run -test -config "$CONFIG"

cat > /etc/systemd/system/${UNIT}.service <<EOF
[Unit]
Description=FR2 VLESS xHTTP TLS pilot (direct connect test)
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

systemctl is-active ${UNIT}
ss -tlnp | grep -E ":${PORT}\\b" || (echo NOT_LISTENING; journalctl -u ${UNIT} -n 20 --no-pager; exit 1)
echo "OK fr2-xhttp-pilot port=${PORT} config=${CONFIG}"
