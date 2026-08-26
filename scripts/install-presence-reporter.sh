#!/bin/bash
set -euo pipefail

NODE_ID="${1:?node id required}"
shift
[ "$#" -gt 0 ] || { echo 'at least one access log is required' >&2; exit 2; }

DIR=/opt/vpn-presence
UNIT=vpn-presence-reporter
install -d -m 700 "$DIR"
install -m 700 /tmp/presence-from-logs.mjs "$DIR/presence-from-logs.mjs"
test -s "$DIR/presence.env"
chmod 600 "$DIR/presence.env"

LOG_ARGS=''
for log_path in "$@"; do
  if [ ! -e "$log_path" ]; then
    install -o root -g root -m 640 /dev/null "$log_path"
  fi
  LOG_ARGS="$LOG_ARGS '$log_path'"
done

cat > "/etc/systemd/system/${UNIT}.service" <<EOF
[Unit]
Description=VPN client presence reporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$DIR/presence.env
Environment=TRAFFIC_NODE_ID=$NODE_ID
Environment=PRESENCE_DEBOUNCE_MS=45000
ExecStart=/bin/sh -c "tail -n 0 -F$LOG_ARGS | /usr/bin/node $DIR/presence-from-logs.mjs"
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT.service" >/dev/null
systemctl restart "$UNIT.service"
sleep 1
systemctl is-active --quiet "$UNIT.service"
echo "PRESENCE_REPORTER_OK node=$NODE_ID logs=$#"
