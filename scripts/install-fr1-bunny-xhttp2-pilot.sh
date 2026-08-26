#!/bin/bash
# Install an isolated FR1 XHTTP pilot. Existing Xray services are only checked,
# never restarted or reconfigured by this script.
set -euo pipefail

PORT="${1:-18097}"
VERSION="${XRAY_VERSION:-v26.3.27}"
DIR=/opt/vpn-fr1-bunny-xhttp2
CONFIG="$DIR/config.json"
BIN="$DIR/xray"
UNIT=xray-fr1-bunny-xhttp2-pilot.service
ARCHIVE="/tmp/Xray-linux-64-${VERSION}.zip"
URL="https://github.com/XTLS/Xray-core/releases/download/${VERSION}/Xray-linux-64.zip"

for required in xray-relay-v2.service xray-fr1-bunny-xhttp.service; do
  systemctl is-active --quiet "$required"
done

RELAY_PID_BEFORE="$(systemctl show -p MainPID --value xray-relay-v2.service)"
BUNNY_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service)"
test "$RELAY_PID_BEFORE" != "0"
test "$BUNNY_PID_BEFORE" != "0"

mkdir -p "$DIR"
if [ ! -x "$BIN" ] || ! "$BIN" version 2>/dev/null | grep -q "${VERSION#v}"; then
  curl -fL --retry 3 --connect-timeout 20 -o "$ARCHIVE" "$URL"
  rm -rf /tmp/xray-fr1-xhttp2-unpack
  mkdir -p /tmp/xray-fr1-xhttp2-unpack
  unzip -q -o "$ARCHIVE" -d /tmp/xray-fr1-xhttp2-unpack
  install -m 755 /tmp/xray-fr1-xhttp2-unpack/xray "$BIN"
fi

install -m 600 /tmp/fr1-bunny-xhttp2.json "$CONFIG"
"$BIN" run -test -config "$CONFIG"

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=FR1 isolated Bunny VLESS XHTTP pilot 2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$BIN run -c $CONFIG
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null
systemctl restart "$UNIT"
sleep 2

ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT

systemctl is-active --quiet "$UNIT"
ss -lntp | grep -E ":${PORT}\\b" >/dev/null
test "$(systemctl show -p MainPID --value xray-relay-v2.service)" = "$RELAY_PID_BEFORE"
test "$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service)" = "$BUNNY_PID_BEFORE"

echo "FR1_XHTTP2_PILOT_OK port=${PORT} relayPid=${RELAY_PID_BEFORE} bunnyPid=${BUNNY_PID_BEFORE}"
