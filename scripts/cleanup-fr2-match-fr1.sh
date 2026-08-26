#!/bin/bash
set -euo pipefail

XRAY=/usr/local/bin/xray
PRODUCTION_CONFIG=/opt/vpn-relay-edge/config.json
PILOT_DIR=/opt/vpn-fr2-tcp-pilot
PILOT_CONFIG="$PILOT_DIR/config.json"
PILOT_UNIT=xray-fr2-tcp-pilot

PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"
if [ -z "$PRODUCTION_PID_BEFORE" ] || [ ! -f "$PRODUCTION_CONFIG" ]; then
  echo "Production FR2 relay validation failed; refusing cleanup" >&2
  exit 1
fi
[ -s /tmp/fr2-tcp-pilot-config.json ] || {
  echo "Copied FR1 pilot config is missing" >&2
  exit 1
}

# Remove only the two FR2 test services. Production :8089 stays untouched.
systemctl disable --now xray-fr2-fastly.service xray-fr2-ws-tls.service 2>/dev/null || true
rm -f /etc/systemd/system/xray-fr2-fastly.service
rm -f /etc/systemd/system/xray-fr2-ws-tls.service
rm -rf /opt/vpn-fr2-fastly
rm -rf /opt/vpn-fr2-ws
rm -f /var/log/vpn-fr2-fastly-access.log
rm -f /var/log/vpn-fr2-fastly-error.log
rm -f /var/log/vpn-fr2-ws-access.log
rm -f /var/log/vpn-fr2-ws-error.log

# Remove the obsolete certificate renewal entry for the deleted WS+TLS pilot.
if [ -x /root/.acme.sh/acme.sh ]; then
  /root/.acme.sh/acme.sh --remove -d fr2direct.levospeed.click --ecc >/dev/null 2>&1 || true
fi

install -d -m 755 "$PILOT_DIR"
install -m 600 /tmp/fr2-tcp-pilot-config.json "$PILOT_CONFIG"
"$XRAY" run -test -config "$PILOT_CONFIG"

cat > /etc/systemd/system/${PILOT_UNIT}.service <<EOF
[Unit]
Description=FR2 VLESS TCP pilot (direct connect test)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$XRAY run -c $PILOT_CONFIG
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576
StandardOutput=append:/var/log/vpn-fr2-tcp-pilot.log
StandardError=append:/var/log/vpn-fr2-tcp-pilot.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$PILOT_UNIT"
systemctl restart "$PILOT_UNIT"
sleep 2
systemctl is-active --quiet "$PILOT_UNIT"

if command -v ufw >/dev/null 2>&1; then
  ufw delete allow 80/tcp >/dev/null 2>&1 || true
  ufw delete allow 443/tcp >/dev/null 2>&1 || true
  ufw delete allow 18444/tcp >/dev/null 2>&1 || true
  ufw allow 18443/tcp >/dev/null 2>&1 || true
  ufw allow 10085/tcp >/dev/null 2>&1 || true
fi

for port in 80 443 18444; do
  while iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; do
    iptables -D INPUT -p tcp --dport "$port" -j ACCEPT
  done
done
for port in 18443 10085; do
  iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null ||
    iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
done

rm -f /tmp/fr2-tcp-pilot-config.json

PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$' || true)"
if [ "$PRODUCTION_PID_AFTER" != "$PRODUCTION_PID_BEFORE" ]; then
  echo "Production FR2 relay PID changed unexpectedly" >&2
  exit 1
fi

echo "FR2_MATCHED_FR1"
echo "production_pid=$PRODUCTION_PID_AFTER"
systemctl list-units --type=service --all 'xray*' --no-pager
ps -C xray -o pid,args
ss -ltnp | awk '$4 ~ /:(8089|18443|10085)$/ {print}'
if ss -ltnp | awk '$4 ~ /:(443|18444)$/ {found=1} END {exit !found}'; then
  echo "Obsolete FR2 pilot port still listening" >&2
  exit 1
fi
