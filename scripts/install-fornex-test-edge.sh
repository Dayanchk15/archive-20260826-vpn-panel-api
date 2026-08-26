#!/bin/bash
set -euo pipefail

UUID="${TEST_UUID:-7a1639d3-242e-4cd3-88a5-585c4615323d}"
EMAIL="${TEST_EMAIL:-muhammetcaryaga90@gmail.com}"
XRAY=/usr/local/bin/xray
CONFIG_DIR=/opt/vpn-fornex-test
CONFIG="$CONFIG_DIR/config.json"
UNIT=xray-fornex-test
REALITY_SNI="${REALITY_SNI:-www.microsoft.com}"
XHTTP_PORT="${XHTTP_PORT:-18444}"
WS_PORT="${WS_PORT:-18080}"
WS_PATH="${WS_PATH:-/assets/v3/sync}"

[ -x "$XRAY" ] || { echo "Xray is not installed" >&2; exit 1; }
install -d -m 700 "$CONFIG_DIR"

KEY_OUTPUT="$("$XRAY" x25519)"
PRIVATE_KEY="$(printf '%s\n' "$KEY_OUTPUT" | awk -F': ' 'tolower($1) ~ /private/ {print $2; exit}')"
PUBLIC_KEY="$(printf '%s\n' "$KEY_OUTPUT" | awk -F': ' 'tolower($1) ~ /public|password/ {print $2; exit}')"
SHORT_ID="$(openssl rand -hex 8)"

[ -n "$PRIVATE_KEY" ] || { echo "Could not parse REALITY private key" >&2; exit 1; }
[ -n "$PUBLIC_KEY" ] || { echo "Could not parse REALITY public key" >&2; exit 1; }

cat > "$CONFIG" <<JSON
{
  "log": {
    "access": "/var/log/vpn-fornex-test-access.log",
    "error": "/var/log/vpn-fornex-test-error.log",
    "loglevel": "warning"
  },
  "dns": {
    "queryStrategy": "UseIPv4",
    "servers": ["1.1.1.1", "8.8.8.8"]
  },
  "policy": {
    "levels": {
      "0": {
        "handshake": 8,
        "connIdle": 300,
        "uplinkOnly": 2,
        "downlinkOnly": 5,
        "bufferSize": 512
      }
    }
  },
  "inbounds": [
    {
      "tag": "vless-reality-direct",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [{
          "id": "$UUID",
          "email": "$EMAIL",
          "flow": "xtls-rprx-vision",
          "level": 0
        }],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "target": "$REALITY_SNI:443",
          "xver": 0,
          "serverNames": ["$REALITY_SNI"],
          "privateKey": "$PRIVATE_KEY",
          "shortIds": ["$SHORT_ID"]
        },
        "sockopt": {
          "tcpNoDelay": true,
          "tcpKeepAliveIdle": 60,
          "tcpKeepAliveInterval": 30
        }
      },
      "sniffing": {
        "enabled": true,
        "destOverride": ["http", "tls", "quic"],
        "routeOnly": false
      }
    },
    {
      "tag": "vless-xhttp-fastly-origin",
      "listen": "0.0.0.0",
      "port": $XHTTP_PORT,
      "protocol": "vless",
      "settings": {
        "clients": [{"id": "$UUID", "email": "$EMAIL", "level": 0}],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "xhttp",
        "security": "none",
        "xhttpSettings": {
          "path": "/",
          "mode": "auto",
          "noGRPCHeader": false,
          "noSSEHeader": false,
          "xPaddingBytes": "100-1000"
        }
      }
    },
    {
      "tag": "vless-ws-fastly-origin",
      "listen": "0.0.0.0",
      "port": $WS_PORT,
      "protocol": "vless",
      "settings": {
        "clients": [{"id": "$UUID", "email": "$EMAIL", "level": 0}],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "ws",
        "security": "none",
        "wsSettings": {
          "path": "$WS_PATH"
        }
      }
    }
  ],
  "outbounds": [
    {"tag": "direct", "protocol": "freedom"},
    {"tag": "block", "protocol": "blackhole"}
  ],
  "routing": {
    "domainStrategy": "AsIs",
    "rules": [{
      "type": "field",
      "network": "udp",
      "port": "443",
      "outboundTag": "block"
    }]
  }
}
JSON

"$XRAY" run -test -config "$CONFIG"

cat > /etc/systemd/system/${UNIT}.service <<EOF
[Unit]
Description=Fornex test VLESS REALITY and Fastly origins
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
systemctl enable "$UNIT"
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"

if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow "$XHTTP_PORT/tcp" >/dev/null
  ufw allow "$WS_PORT/tcp" >/dev/null
  ufw --force enable >/dev/null
fi

cat > "$CONFIG_DIR/client-info" <<EOF
UUID=$UUID
REALITY_PUBLIC_KEY=$PUBLIC_KEY
REALITY_SHORT_ID=$SHORT_ID
REALITY_SNI=$REALITY_SNI
XHTTP_PORT=$XHTTP_PORT
WS_PORT=$WS_PORT
WS_PATH=$WS_PATH
EOF
chmod 600 "$CONFIG_DIR/client-info"

echo "EDGE_OK"
echo "PUBLIC_KEY=$PUBLIC_KEY"
echo "SHORT_ID=$SHORT_ID"
ss -ltnp | awk '$4 ~ /:(443|18444|18080)$/ {print}'
