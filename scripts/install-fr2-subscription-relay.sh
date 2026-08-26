#!/bin/bash
# Install an isolated subscription relay on FR2. VPN/Xray services are untouched.
set -euo pipefail

PORT="${1:-18091}"
DEPLOY_DIR=/opt/vpn-fr2-subscription-relay
APP="$DEPLOY_DIR/server.mjs"
UNIT=fr2-subscription-relay

command -v node >/dev/null
[ -s /tmp/fr2-subscription-relay.mjs ]

PRODUCTION_PID_BEFORE="$(systemctl show -p MainPID --value xray-relay-v2.service)"
install -d -m 755 "$DEPLOY_DIR"
install -m 644 /tmp/fr2-subscription-relay.mjs "$APP"

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=FR2 isolated subscription relay for Bunny CDN
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PORT=$PORT
Environment=SUBSCRIPTION_ORIGIN=https://sub.twidu.com
Environment=RELAY_ID=fr2
EnvironmentFile=-$DEPLOY_DIR/relay.env
ExecStart=/usr/bin/node $APP
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT" >/dev/null
sleep 2
systemctl is-active --quiet "$UNIT"
curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null

ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || \
  iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT

PRODUCTION_PID_AFTER="$(systemctl show -p MainPID --value xray-relay-v2.service)"
[ "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_PID_AFTER" ] || {
  echo "Production VPN PID changed unexpectedly" >&2
  exit 1
}

rm -f /tmp/fr2-subscription-relay.mjs
echo "FR2_SUBSCRIPTION_RELAY_OK port=$PORT productionPid=$PRODUCTION_PID_AFTER"
