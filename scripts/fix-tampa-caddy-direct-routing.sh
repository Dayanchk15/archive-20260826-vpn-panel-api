#!/bin/bash
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
PUBLIC_IP=74.115.172.101
CADDY_IP=172.17.0.1
CADDY_PORT=9444
ROUTE_SCRIPT=/usr/local/sbin/levospeed-caddy-route
ROUTE_UNIT=/etc/systemd/system/levospeed-caddy-route.service
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_DIR="/root/levospeed-caddy-fix-${STAMP}"

mkdir -p "$BACKUP_DIR"
cp "$CADDYFILE" "$BACKUP_DIR/Caddyfile"
iptables-save > "$BACKUP_DIR/iptables.rules"

python3 - "$CADDYFILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8-sig")
if "protocols h1 h2" not in text:
    marker = "    email admin@twidu.com\n"
    replacement = marker + "    servers {\n        protocols h1 h2\n    }\n"
    if marker not in text:
        raise SystemExit("Caddy global options block was not recognized")
    text = text.replace(marker, replacement, 1)
if 'header Alt-Svc "clear"' not in text:
    marker = "    encode zstd gzip\n"
    if marker not in text:
        raise SystemExit("Caddy site encoding directive was not recognized")
    text = text.replace(marker, marker + '    header Alt-Svc "clear"\n', 1)
path.write_text(text, encoding="utf-8")
PY

caddy validate --config "$CADDYFILE"
caddy reload --config "$CADDYFILE"
systemctl is-active --quiet caddy

cat > "$ROUTE_SCRIPT" <<EOF
#!/bin/bash
set -euo pipefail
iptables -C INPUT -p tcp -d ${CADDY_IP} --dport ${CADDY_PORT} -j ACCEPT 2>/dev/null || \
  iptables -I INPUT 1 -p tcp -d ${CADDY_IP} --dport ${CADDY_PORT} -j ACCEPT
iptables -t nat -C PREROUTING -p tcp -d ${PUBLIC_IP} --dport 443 \
  -j DNAT --to-destination ${CADDY_IP}:${CADDY_PORT} 2>/dev/null || \
  iptables -t nat -I PREROUTING 1 -p tcp -d ${PUBLIC_IP} --dport 443 \
    -j DNAT --to-destination ${CADDY_IP}:${CADDY_PORT}
EOF
chmod 750 "$ROUTE_SCRIPT"

cat > "$ROUTE_UNIT" <<EOF
[Unit]
Description=Route levospeed HTTPS directly to Caddy without restarting Xray
After=network-online.target docker.service caddy.service
Wants=network-online.target
Requires=caddy.service

[Service]
Type=oneshot
ExecStart=${ROUTE_SCRIPT}
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now levospeed-caddy-route.service
systemctl is-active --quiet levospeed-caddy-route.service
systemctl is-active --quiet xray-tampa-reality.service

curl --noproxy '*' -kfsS --max-time 15 \
  --resolve levospeed.it.com:${CADDY_PORT}:${CADDY_IP} \
  "https://levospeed.it.com:${CADDY_PORT}/health" >/dev/null

echo "TAMPA_CADDY_DIRECT_ROUTE_OK"
echo "backup=${BACKUP_DIR}"
