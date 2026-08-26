#!/bin/bash
set -euo pipefail

XRAY_PORT=18444
PUBLIC_PORT=80
UNIT=fr2-fastly-port80-redirect.service
XRAY_UNIT=xray-fr2-fastly.service

systemctl is-active --quiet "$XRAY_UNIT"
XRAY_PID_BEFORE="$(systemctl show -p MainPID --value "$XRAY_UNIT")"
PRODUCTION_PID_BEFORE="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PID_BEFORE="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
if ss -ltnH | awk '{print $4}' | grep -q ":${PUBLIC_PORT}$"; then
  echo "FR2 public port ${PUBLIC_PORT} is already occupied" >&2
  exit 1
fi

cat > "/etc/systemd/system/$UNIT" <<EOF
[Unit]
Description=Redirect Fastly HTTP origin port 80 to FR2 xHTTP
After=network-online.target ${XRAY_UNIT}
Wants=network-online.target
Requires=${XRAY_UNIT}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport ${PUBLIC_PORT} -j REDIRECT --to-ports ${XRAY_PORT} 2>/dev/null || /usr/sbin/iptables -t nat -A PREROUTING -p tcp --dport ${PUBLIC_PORT} -j REDIRECT --to-ports ${XRAY_PORT}'
ExecStop=/bin/sh -c '/usr/sbin/iptables -t nat -D PREROUTING -p tcp --dport ${PUBLIC_PORT} -j REDIRECT --to-ports ${XRAY_PORT} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT"
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PUBLIC_PORT}/tcp" >/dev/null
fi
systemctl is-active --quiet "$UNIT"
/usr/sbin/iptables -t nat -C PREROUTING -p tcp --dport "$PUBLIC_PORT" -j REDIRECT --to-ports "$XRAY_PORT"

XRAY_PID_AFTER="$(systemctl show -p MainPID --value "$XRAY_UNIT")"
PRODUCTION_PID_AFTER="$(pgrep -f '^xray run -c /opt/vpn-relay-edge/config.json$')"
TCP_PID_AFTER="$(systemctl show -p MainPID --value xray-fr2-tcp-pilot.service)"
[ "$XRAY_PID_BEFORE" = "$XRAY_PID_AFTER" ]
[ "$PRODUCTION_PID_BEFORE" = "$PRODUCTION_PID_AFTER" ]
[ "$TCP_PID_BEFORE" = "$TCP_PID_AFTER" ]
echo "FR2_FASTLY_PORT80_OK xrayPid=$XRAY_PID_AFTER productionPid=$PRODUCTION_PID_AFTER tcpPilotPid=$TCP_PID_AFTER"
