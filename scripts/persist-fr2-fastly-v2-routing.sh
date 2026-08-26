#!/bin/bash
set -euo pipefail

cat > /etc/systemd/system/fr2-fastly-port80-redirect.service <<'EOF'
[Unit]
Description=Route new FR2 Fastly connections to zero-disconnect xHTTP v2
After=network-online.target xray-fr2-fastly-v2.service
Wants=network-online.target
Requires=xray-fr2-fastly-v2.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'while /usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18444 2>/dev/null; do :; done; /usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport 18444 -j REDIRECT --to-ports 18445 2>/dev/null || /usr/sbin/iptables -t nat -I PREROUTING 1 -p tcp --dport 18444 -j REDIRECT --to-ports 18445; /usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18445 2>/dev/null || /usr/sbin/iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18445'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport 18444 -j REDIRECT --to-ports 18445 2>/dev/null || true; /usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18445 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl restart fr2-fastly-port80-redirect.service
systemctl is-active --quiet fr2-fastly-port80-redirect.service
systemctl is-active --quiet xray-fr2-fastly.service
systemctl is-active --quiet xray-fr2-fastly-v2.service
/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport 18444 -j REDIRECT --to-ports 18445
/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 18445
echo FR2_FASTLY_V2_ROUTING_PERSISTED
