#!/bin/bash
# Install an isolated FR1 VLESS+gRPC origin behind Caddy without restarting production Xray.
set -euo pipefail

XRAY=/usr/local/bin/xray
DIR=/opt/vpn-fr1-cloudflare-grpc
CONFIG="$DIR/config.json"
UNIT=xray-fr1-cloudflare-grpc.service
CADDY_SNIPPET=/etc/caddy/conf.d/fr1-cloudflare-grpc.caddy
CADDYFILE=/etc/caddy/Caddyfile
PORT="${1:-18093}"
DOMAIN="${2:-fr1.levospeed.click}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CADDY_BACKUP="$CADDYFILE.pre-fr1-grpc-$STAMP"
INSTALLED=0

rollback() {
  [ "$INSTALLED" = 1 ] || return 0
  cp -a "$CADDY_BACKUP" "$CADDYFILE" 2>/dev/null || true
  rm -f "$CADDY_SNIPPET"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  caddy validate --config "$CADDYFILE" >/dev/null 2>&1 && systemctl reload caddy >/dev/null 2>&1 || true
}
trap rollback ERR

RELAY_PID_BEFORE="$(systemctl show -p MainPID --value xray-relay-v2.service)"
BUNNY_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service)"
test "$RELAY_PID_BEFORE" != 0
test "$BUNNY_PID_BEFORE" != 0
systemctl is-active --quiet xray-relay-v2.service
systemctl is-active --quiet xray-fr1-bunny-xhttp.service
systemctl is-active --quiet caddy.service

mkdir -p "$DIR" /etc/caddy/conf.d
install -m 600 /tmp/fr1-cloudflare-grpc.json "$CONFIG"
"$XRAY" run -test -config "$CONFIG"
cp -a "$CADDYFILE" "$CADDY_BACKUP"
INSTALLED=1

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=FR1 isolated VLESS gRPC origin for Cloudflare
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -c $CONFIG
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DIR /var/log

[Install]
WantedBy=multi-user.target
EOF

cat > "$CADDY_SNIPPET" <<EOF
$DOMAIN {
    header Alt-Svc "clear"
    reverse_proxy h2c://127.0.0.1:$PORT
}
EOF

if ! grep -Fq 'import /etc/caddy/conf.d/*.caddy' "$CADDYFILE"; then
  printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> "$CADDYFILE"
fi

"$XRAY" run -test -config "$CONFIG"
caddy validate --config "$CADDYFILE"
systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null
systemctl reload caddy
sleep 2

systemctl is-active --quiet "$UNIT"
ss -lntp | grep -F "127.0.0.1:$PORT" >/dev/null
[ "$(systemctl show -p MainPID --value xray-relay-v2.service)" = "$RELAY_PID_BEFORE" ]
[ "$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp.service)" = "$BUNNY_PID_BEFORE" ]

rm -f /tmp/fr1-cloudflare-grpc.json
trap - ERR
echo "FR1_CLOUDFLARE_GRPC_OK domain=$DOMAIN port=$PORT relayPid=$RELAY_PID_BEFORE bunnyPid=$BUNNY_PID_BEFORE"
