#!/bin/bash
# Install VLESS + WebSocket + TLS edge on FR2 (direct-to-VPS, competitor-style).
# Obtains a Let's Encrypt cert, then runs Xray on :443. Production :8089 untouched.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:/sbin

DOMAIN="${1:-fr2direct.levospeed.click}"
PORT="${2:-443}"
WS_DIR=/opt/vpn-fr2-ws
CONFIG="$WS_DIR/config.json"
UNIT=xray-fr2-ws-tls
XRAY=/usr/local/bin/xray

mkdir -p "$WS_DIR"
[ -f /tmp/fr2-ws-tls.json ] && cp /tmp/fr2-ws-tls.json "$CONFIG"

if ! [ -x "$XRAY" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq unzip curl ca-certificates >/dev/null 2>&1 || true
  curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/v24.12.31/Xray-linux-64.zip" -o /tmp/xray.zip
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/xray.zip').extract('xray','/usr/local/bin')"
  chmod +x /usr/local/bin/xray
  rm -f /tmp/xray.zip
fi

# --- Let's Encrypt via acme.sh (HTTP-01 standalone on :80) ---
if [ ! -s "$WS_DIR/fullchain.pem" ] || [ "${FORCE_CERT:-0}" = "1" ]; then
  if [ ! -f /root/.acme.sh/acme.sh ]; then
    curl -fsSL https://get.acme.sh | sh -s email=admin@"${DOMAIN#*.}" >/dev/null 2>&1 || true
  fi
  ACME=/root/.acme.sh/acme.sh
  fuser -k 80/tcp >/dev/null 2>&1 || true
  sleep 1
  "$ACME" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
  "$ACME" --issue --standalone -d "$DOMAIN" --keylength ec-256 --force
  "$ACME" --install-cert -d "$DOMAIN" --ecc \
    --key-file "$WS_DIR/key.pem" \
    --fullchain-file "$WS_DIR/fullchain.pem" \
    --reloadcmd "systemctl restart ${UNIT} 2>/dev/null || true"
fi

[ -s "$WS_DIR/fullchain.pem" ] || { echo "CERT_MISSING for $DOMAIN" >&2; exit 1; }
chmod 600 "$WS_DIR/key.pem"

"$XRAY" run -test -config "$CONFIG"

cat > /etc/systemd/system/${UNIT}.service <<EOF
[Unit]
Description=FR2 VLESS WS+TLS edge (direct)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -c $CONFIG
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${UNIT}
systemctl restart ${UNIT}
sleep 2

ufw allow ${PORT}/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null || true

systemctl is-active ${UNIT}
ss -tlnp | grep -E ":${PORT}\b" || { journalctl -u ${UNIT} -n 20 --no-pager; exit 1; }
echo "OK fr2-ws-tls domain=${DOMAIN} port=${PORT}"
echo "--- production 8089 untouched ---"
ss -tlnp | grep 8089 || true
