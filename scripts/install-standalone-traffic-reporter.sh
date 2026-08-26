#!/bin/bash
set -euo pipefail

EDGE_DIR="${EDGE_DIR:?EDGE_DIR is required}"
NODE_ID="${TRAFFIC_NODE_ID:?TRAFFIC_NODE_ID is required}"
API_PORT="${XRAY_API_PORT:?XRAY_API_PORT is required}"
UNIT_NAME="${TRAFFIC_UNIT_NAME:?TRAFFIC_UNIT_NAME is required}"
XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"

[ -x "$XRAY_BIN" ] || { echo "Xray CLI is missing: $XRAY_BIN" >&2; exit 1; }
[ -x "$PYTHON_BIN" ] || { echo "Python is missing: $PYTHON_BIN" >&2; exit 1; }
[ -s /tmp/standalone-traffic-reporter.py ] || { echo "Reporter upload is missing" >&2; exit 1; }
[ -s /tmp/pilot-report.env ] || { echo "Reporter environment is missing" >&2; exit 1; }

install -d -m 700 "$EDGE_DIR"
install -m 700 /tmp/standalone-traffic-reporter.py "$EDGE_DIR/traffic-reporter.py"
install -m 600 /tmp/pilot-report.env "$EDGE_DIR/traffic-report.env"

cat >/etc/systemd/system/${UNIT_NAME}.service <<EOF
[Unit]
Description=Xray traffic reporter for ${NODE_ID}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${EDGE_DIR}/traffic-report.env
Environment=XRAY_BIN=${XRAY_BIN}
Environment=XRAY_API_SERVER=127.0.0.1:${API_PORT}
Environment=TRAFFIC_REPORT_INTERVAL_SECONDS=60
Environment=TRAFFIC_NODE_ID=${NODE_ID}
ExecStart=${PYTHON_BIN} ${EDGE_DIR}/traffic-reporter.py
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

"$XRAY_BIN" api statsquery --server="127.0.0.1:${API_PORT}" -pattern traffic >/dev/null
systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
systemctl restart "$UNIT_NAME"
sleep 2
systemctl is-active --quiet "$UNIT_NAME"
echo "TRAFFIC_REPORTER_OK unit=${UNIT_NAME} node=${NODE_ID} api=127.0.0.1:${API_PORT}"
