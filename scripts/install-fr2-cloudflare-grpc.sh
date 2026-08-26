#!/bin/bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
XRAY=/usr/local/bin/xray
RELAY_PID="$(systemctl show -p MainPID --value xray-relay-v2.service)"
BUNNY_PID="$(systemctl show -p MainPID --value xray-fr2-bunny-ws.service)"
test "$RELAY_PID" != 0
test "$BUNNY_PID" != 0
install -d -m 755 /opt/vpn-fr2-cloudflare-grpc /etc/caddy
install -m 600 /tmp/fr2-cloudflare-grpc.json /opt/vpn-fr2-cloudflare-grpc/config.json
$XRAY run -test -config /opt/vpn-fr2-cloudflare-grpc/config.json

cat > /etc/systemd/system/xray-fr2-cloudflare-grpc.service <<'EOF'
[Unit]
Description=FR2 isolated VLESS gRPC origin for Cloudflare
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-fr2-cloudflare-grpc/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<'EOF'
{
  email admin@twidu.com
  servers {
    protocols h1 h2
  }
}
fr2.levospeed.click {
  header Alt-Svc "clear"
  reverse_proxy h2c://127.0.0.1:18093
}
EOF

cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy web server for FR2 Cloudflare gRPC
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
User=root
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now xray-fr2-cloudflare-grpc.service caddy.service >/dev/null
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sleep 2
systemctl is-active --quiet xray-fr2-cloudflare-grpc.service
systemctl is-active --quiet caddy.service
test "$(systemctl show -p MainPID --value xray-relay-v2.service)" = "$RELAY_PID"
test "$(systemctl show -p MainPID --value xray-fr2-bunny-ws.service)" = "$BUNNY_PID"
echo "FR2_CLOUDFLARE_GRPC_OK relayPid=$RELAY_PID bunnyPid=$BUNNY_PID"
