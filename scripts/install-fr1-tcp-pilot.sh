#!/bin/bash
# Standalone VLESS TCP pilot on FR1 — does NOT touch production xray on :8088.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin

XRAY=/usr/local/bin/xray
PILOT_DIR=/opt/vpn-fr1-tcp-pilot
CONFIG="$PILOT_DIR/config.json"
PORT="${1:-18443}"
UNIT=xray-fr1-tcp-pilot
LOG=/var/log/vpn-fr1-tcp-pilot.log

mkdir -p "$PILOT_DIR"
if [ -f /tmp/fr1-tcp-pilot.json ]; then
  cp /tmp/fr1-tcp-pilot.json "$CONFIG"
fi

if ! [ -x "$XRAY" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1 || true
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v24.12.31/Xray-linux-64.zip" -o /tmp/xray.zip
  unzip -jo /tmp/xray.zip xray -d /usr/local/bin
  chmod +x /usr/local/bin/xray
  rm -f /tmp/xray.zip
fi

"$XRAY" run -test -config "$CONFIG"

cat > /etc/systemd/system/${UNIT}.service <<EOF
[Unit]
Description=FR1 VLESS TCP pilot (direct connect test)
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
echo "OK fr1-tcp-pilot port=${PORT} config=${CONFIG}"
