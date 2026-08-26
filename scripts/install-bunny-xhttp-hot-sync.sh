#!/bin/bash
# Enable Xray API on Bunny XHTTP origin + install pull-based hot-sync agent.
# Env:
#   CONFIG UNIT INBOUND_TAG API_PORT AGENT_PORT EDGE_ID
#   SOURCE_DIR (existing agent tree to clone) optional
#   XRAY_BIN optional
set -euo pipefail

CONFIG="${CONFIG:?}"
UNIT="${UNIT:?}"
INBOUND_TAG="${INBOUND_TAG:?}"
API_PORT="${API_PORT:?}"
AGENT_PORT="${AGENT_PORT:?}"
EDGE_ID="${EDGE_ID:?}"
SOURCE_DIR="${SOURCE_DIR:-}"
TARGET_DIR="${TARGET_DIR:-/opt/vpn-standalone-sync-${EDGE_ID}}"
EDGE_ENV_FILE="${EDGE_ENV_FILE:-$(dirname "$CONFIG")/sync.env}"

systemctl is-active --quiet "$UNIT"
[ -f "$CONFIG" ]

# Resolve XRAY_BIN
if [ -z "${XRAY_BIN:-}" ] || [ ! -x "${XRAY_BIN:-}" ]; then
  XRAY_BIN="$(systemctl show -p ExecStart --value "$UNIT" | sed -n 's/.*path=\([^ ;]*\).*/\1/p' || true)"
fi
if [ -z "${XRAY_BIN:-}" ] || [ ! -x "${XRAY_BIN:-}" ]; then
  for cand in /opt/vpn-dayanch-bunny-xhttp/xray-26.3.27 /opt/vpn-fr1-bunny-xhttp2/xray /usr/local/bin/xray; do
    [ -x "$cand" ] && XRAY_BIN="$cand" && break
  done
fi
[ -x "$XRAY_BIN" ]

# Find a source agent tree with node_modules
if [ -z "$SOURCE_DIR" ] || [ ! -d "$SOURCE_DIR/vpn-edge-sync-agent" ]; then
  for cand in \
    /opt/vpn-standalone-sync-pilot-fr2-bunny \
    /opt/vpn-standalone-sync-pilot-fr2-xhttp \
    /opt/vpn-standalone-sync-cf-ws \
    /opt/vpn-standalone-sync-relay-v2 \
    /opt/vpn-standalone-sync-fr1-bunny-v2 \
    /opt/vpn-standalone-sync-*; do
    if [ -d "$cand/vpn-edge-sync-agent" ] && [ -f "$cand/agent.env" ]; then
      SOURCE_DIR="$cand"
      break
    fi
  done
fi
[ -n "$SOURCE_DIR" ] && [ -d "$SOURCE_DIR/vpn-edge-sync-agent" ]
SOURCE_ENV=""
for candidate in "$SOURCE_DIR/agent.env" "$SOURCE_DIR/.env"; do
  if [ -s "$candidate" ]; then SOURCE_ENV="$candidate"; break; fi
done
[ -n "$SOURCE_ENV" ]

# Patch config: add api + dokodemo inbound if missing
python3 - "$CONFIG" "$API_PORT" "$INBOUND_TAG" <<'PY'
import json, sys, shutil, time, os
path, api_port, inbound_tag = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg = json.load(open(path))
changed = False

# ensure target inbound exists
tags = [ib.get('tag') for ib in (cfg.get('inbounds') or [])]
if inbound_tag not in tags:
    raise SystemExit(f'missing inbound tag {inbound_tag}; have {tags}')

api = cfg.get('api') or {}
if api.get('tag') != 'api' or 'HandlerService' not in (api.get('services') or []):
    cfg['api'] = {
        'tag': 'api',
        'services': ['HandlerService', 'LoggerService', 'StatsService'],
    }
    changed = True

if 'stats' not in cfg:
    cfg['stats'] = {}
    changed = True

policy = cfg.setdefault('policy', {})
system = policy.setdefault('system', {})
for k in ('statsInboundUplink', 'statsInboundDownlink', 'statsOutboundUplink', 'statsOutboundDownlink'):
    if system.get(k) is not True:
        system[k] = True
        changed = True

inbounds = cfg.setdefault('inbounds', [])
api_ib = next((ib for ib in inbounds if ib.get('tag') == 'api'), None)
desired_api = {
    'tag': 'api',
    'listen': '127.0.0.1',
    'port': api_port,
    'protocol': 'dokodemo-door',
    'settings': {'address': '127.0.0.1'},
}
if not api_ib:
    inbounds.append(desired_api)
    changed = True
else:
    if api_ib.get('port') != api_port or api_ib.get('listen') != '127.0.0.1':
        api_ib.update(desired_api)
        changed = True

routing = cfg.setdefault('routing', {'domainStrategy': 'AsIs', 'rules': []})
rules = routing.setdefault('rules', [])
has_api_rule = any(
    r.get('outboundTag') == 'api' or r.get('inboundTag') == ['api'] or (isinstance(r.get('inboundTag'), list) and 'api' in r.get('inboundTag'))
    for r in rules
)
# xray api inbound needs routing to api outbound tag matching api.tag
if not any(
    (isinstance(r.get('inboundTag'), list) and 'api' in r.get('inboundTag', [])) or r.get('inboundTag') == 'api'
    for r in rules
):
    rules.insert(0, {'type': 'field', 'inboundTag': ['api'], 'outboundTag': 'api'})
    changed = True

if changed:
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    shutil.copy2(path, f'{path}.pre-api.{stamp}')
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    os.replace(tmp, path)
print(json.dumps({'ok': True, 'changed': changed, 'apiPort': api_port, 'inboundTag': inbound_tag}))
PY

"$XRAY_BIN" run -test -config "$CONFIG" >/tmp/bunny-xhttp-api-test.log 2>&1 || {
  echo "xray test failed after API patch" >&2
  cat /tmp/bunny-xhttp-api-test.log >&2
  exit 1
}

# Restart only this xhttp unit (brief)
BEFORE_PID="$(systemctl show -p MainPID --value "$UNIT")"
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"
AFTER_PID="$(systemctl show -p MainPID --value "$UNIT")"
[ "$AFTER_PID" != "0" ]

# Clone / refresh agent
rm -rf "$TARGET_DIR"
cp -a "$SOURCE_DIR" "$TARGET_DIR"
# Prefer symlink node_modules if huge copy fails elsewhere — already copied

# Keep sync key from source env
SYNC_KEY="$(grep -E '^EDGE_SYNC_KEY=' "$SOURCE_ENV" | head -1 | cut -d= -f2- || true)"
if [ -z "$SYNC_KEY" ]; then
  SYNC_KEY="$(grep -E '^EDGE_REPORT_KEY=' "$SOURCE_ENV" | head -1 | cut -d= -f2- || true)"
fi
[ -n "$SYNC_KEY" ]

install -m 600 /dev/null "$EDGE_ENV_FILE"

# Rewrite agent.env cleanly (drop huge VLESS_CLIENTS_JSON)
python3 - <<PY
from pathlib import Path
src = Path("$SOURCE_ENV")
dst = Path("$TARGET_DIR/agent.env")
keep = []
for line in src.read_text().splitlines():
    if line.startswith("VLESS_CLIENTS_JSON=") or line.startswith("EDGE_SYNC_FINGERPRINT="):
        continue
    keep.append(line)
vals = {
    "EDGE_ID": "$EDGE_ID",
    "AGENT_PORT": "$AGENT_PORT",
    "EDGE_ENV_FILE": "$EDGE_ENV_FILE",
    "XRAY_BIN": "$XRAY_BIN",
    "XRAY_API_ADDR": "127.0.0.1:$API_PORT",
    "XRAY_INBOUND_TAG": "$INBOUND_TAG",
    "PANEL_PULL_URL": "https://sub.twidu.com/internal/edge/clients",
    "PANEL_PULL_INTERVAL_MS": "15000",
    "EDGE_SYNC_ALLOW_RESTART": "false",
    "EDGE_SYNC_KEY": "$SYNC_KEY",
    "AGENT_BIND_ADDR": "127.0.0.1",
}
seen = set()
out = []
for line in keep:
    key = line.split("=", 1)[0] if "=" in line else None
    if key in vals:
        out.append(f"{key}={vals[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in vals.items():
    if key not in seen:
        out.append(f"{key}={value}")
dst.write_text("\\n".join(out) + "\\n")
PY

UNIT_NAME="vpn-standalone-sync-${EDGE_ID}"
cat > "/etc/systemd/system/${UNIT_NAME}.service" <<EOF
[Unit]
Description=Bunny XHTTP client hot-sync (${EDGE_ID})
After=network-online.target ${UNIT}
Wants=network-online.target
Requires=${UNIT}

[Service]
Type=simple
WorkingDirectory=${TARGET_DIR}
EnvironmentFile=${TARGET_DIR}/agent.env
ExecStart=/usr/bin/node ${TARGET_DIR}/vpn-edge-sync-agent/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$UNIT_NAME" >/dev/null

for _ in $(seq 1 30); do
  curl -fsS --max-time 2 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null

# Wait for at least one pull/apply
sleep 20
status="$(curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/v1/status")"
python3 - "$status" "$EDGE_ID" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
edge = sys.argv[2]
if not status.get('ok'):
    raise SystemExit(status.get('lastError') or 'agent not ok')
if status.get('lastError'):
    raise SystemExit(status.get('lastError'))
count = int(status.get('clientCount') or 0)
if count < 1:
    raise SystemExit(f'{edge}: clientCount={count}')
print(json.dumps({
    'ok': True,
    'edgeId': status.get('edgeId') or edge,
    'clientCount': count,
    'applyMode': status.get('applyMode'),
    'lastAppliedAt': status.get('lastAppliedAt'),
    'xrayPidBeforeRestart': None,
}))
PY

echo "BUNNY_XHTTP_HOT_SYNC_OK edge=${EDGE_ID} api=${API_PORT} agent=${AGENT_PORT} xray=${BEFORE_PID}->${AFTER_PID}"
