#!/bin/bash
# Install real byte traffic reporter for an already-running Xray Stats API.
# NEVER restarts Xray. Aborts if statsquery fails.
set -euo pipefail

EDGE_DIR="${EDGE_DIR:?}"
NODE_ID="${TRAFFIC_NODE_ID:?}"
API_PORT="${XRAY_API_PORT:?}"
UNIT_NAME="${TRAFFIC_UNIT_NAME:?}"
XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
REPORT_ENV="${REPORT_ENV:-/tmp/pilot-report.env}"

[ -x "$XRAY_BIN" ] || { echo "Xray missing: $XRAY_BIN" >&2; exit 1; }
[ -x "$PYTHON_BIN" ] || { echo "Python missing" >&2; exit 1; }
[ -s /tmp/standalone-traffic-reporter.py ] || { echo "Reporter script missing" >&2; exit 1; }
[ -s "$REPORT_ENV" ] || { echo "Report env missing" >&2; exit 1; }

# Safety: Stats API must already answer. No config rewrite, no Xray restart.
"$XRAY_BIN" api statsquery --server="127.0.0.1:${API_PORT}" -pattern traffic >/tmp/stats-smoke-${NODE_ID}.json
python3 - <<PY
import json
raw=open('/tmp/stats-smoke-${NODE_ID}.json','r',encoding='utf-8',errors='ignore').read()
ok=False
try:
  data=json.loads(raw)
  stats=data.get('stat') or []
  ok=any('user>>>' in str(s.get('name','')) or 'traffic' in str(s.get('name','')) for s in stats)
except Exception:
  ok=('user>>>' in raw) or ('traffic' in raw)
if not ok:
  raise SystemExit('Stats API returned no traffic counters; refusing install')
print('STATS_OK')
PY

install -d -m 700 "$EDGE_DIR"
install -m 700 /tmp/standalone-traffic-reporter.py "$EDGE_DIR/traffic-reporter.py"
install -m 600 "$REPORT_ENV" "$EDGE_DIR/traffic-report.env"

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

systemctl daemon-reload
systemctl enable "$UNIT_NAME" >/dev/null
systemctl restart "$UNIT_NAME"
sleep 2
systemctl is-active --quiet "$UNIT_NAME"
echo "TRAFFIC_REPORTER_OK unit=${UNIT_NAME} node=${NODE_ID} api=127.0.0.1:${API_PORT}"
