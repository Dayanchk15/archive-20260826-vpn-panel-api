#!/bin/bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
XRAY=/usr/local/bin/xray
RELAY_PID="$(systemctl show -p MainPID --value xray-relay-v2.service)"
CADDY_PID="$(systemctl show -p MainPID --value caddy.service)"
test "$RELAY_PID" != 0
test "$CADDY_PID" != 0

install -d -m 755 /opt/vpn-tampa-cloudflare-grpc /opt/vpn-tampa-bunny-ws
install -m 600 /tmp/tampa-cloudflare-grpc.json /opt/vpn-tampa-cloudflare-grpc/config.json
install -m 600 /tmp/tampa-bunny-ws.json /opt/vpn-tampa-bunny-ws/config.json
$XRAY run -test -config /opt/vpn-tampa-cloudflare-grpc/config.json
$XRAY run -test -config /opt/vpn-tampa-bunny-ws/config.json
cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-multi-cdn-$STAMP"

cat > /etc/systemd/system/xray-tampa-cloudflare-grpc.service <<'EOF'
[Unit]
Description=Tampa isolated VLESS gRPC origin for Cloudflare
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-tampa-cloudflare-grpc/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/xray-tampa-bunny-ws.service <<'EOF'
[Unit]
Description=Tampa isolated VLESS WebSocket origin for Bunny CDN
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-tampa-bunny-ws/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

if ! grep -Fq '# CLOUDFLARE_TAMPA_GRPC_BEGIN' /etc/caddy/Caddyfile; then
cat >> /etc/caddy/Caddyfile <<'EOF'

# CLOUDFLARE_TAMPA_GRPC_BEGIN
https://tampa.levospeed.click:9444 {
    bind 172.17.0.1
    header Alt-Svc "clear"
    reverse_proxy h2c://127.0.0.1:18093
}
# CLOUDFLARE_TAMPA_GRPC_END
EOF
fi

caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now xray-tampa-cloudflare-grpc.service xray-tampa-bunny-ws.service >/dev/null
systemctl reload caddy
ufw allow 18090/tcp >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport 18090 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 18090 -j ACCEPT
sleep 2
systemctl is-active --quiet xray-tampa-cloudflare-grpc.service
systemctl is-active --quiet xray-tampa-bunny-ws.service
test "$(systemctl show -p MainPID --value xray-relay-v2.service)" = "$RELAY_PID"
test "$(systemctl show -p MainPID --value caddy.service)" = "$CADDY_PID"
echo "TAMPA_MULTI_CDN_OK relayPid=$RELAY_PID caddyPid=$CADDY_PID"
