#!/bin/bash
set -euo pipefail
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
XRAY=/usr/local/bin/xray
PROD_PID="$(systemctl show -p MainPID --value xray-fornex-test.service)"
test "$PROD_PID" != 0
install -d -m 755 /opt/vpn-fornex-cloudflare-grpc
install -m 600 /tmp/fornex-cloudflare-grpc.json /opt/vpn-fornex-cloudflare-grpc/config.json
$XRAY run -test -config /opt/vpn-fornex-cloudflare-grpc/config.json
cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-cloudflare-grpc-$STAMP"
cp -a /etc/haproxy/haproxy.cfg "/etc/haproxy/haproxy.cfg.pre-cloudflare-grpc-$STAMP"

cat > /etc/systemd/system/xray-fornex-cloudflare-grpc.service <<'EOF'
[Unit]
Description=Fornex isolated VLESS gRPC origin for Cloudflare
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart=/usr/local/bin/xray run -c /opt/vpn-fornex-cloudflare-grpc/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
EOF

if ! grep -Fq 'fornex.levospeed.click' /etc/caddy/Caddyfile; then
cat >> /etc/caddy/Caddyfile <<'EOF'

fornex.levospeed.click {
  bind 127.0.0.1
  tls {
    issuer acme {
      disable_http_challenge
    }
  }
  header Alt-Svc "clear"
  reverse_proxy h2c://127.0.0.1:18093
}
EOF
fi

python3 - <<'PY'
from pathlib import Path
p = Path('/etc/haproxy/haproxy.cfg')
s = p.read_text()
old = 'acl subscription_sni req.ssl_sni -i levospeed.it.com www.levospeed.it.com'
new = old + ' fornex.levospeed.click'
if 'fornex.levospeed.click' not in s:
    if old not in s:
        raise SystemExit('HAProxy subscription SNI ACL not found')
    p.write_text(s.replace(old, new))
PY

caddy validate --config /etc/caddy/Caddyfile
haproxy -c -f /etc/haproxy/haproxy.cfg
systemctl daemon-reload
systemctl enable --now xray-fornex-cloudflare-grpc.service >/dev/null
systemctl reload caddy-levospeed.service
systemctl reload haproxy.service
sleep 2
systemctl is-active --quiet xray-fornex-cloudflare-grpc.service
test "$(systemctl show -p MainPID --value xray-fornex-test.service)" = "$PROD_PID"
echo "FORNEX_CLOUDFLARE_GRPC_OK productionPid=$PROD_PID"
