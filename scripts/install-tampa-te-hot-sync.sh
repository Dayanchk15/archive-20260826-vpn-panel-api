#!/bin/bash
# Tampa TE WS hot-sync via Docker (host Node is v12).
set -euo pipefail

EDGE_ID=te-ws-tampa
CONFIG=/opt/vpn-tampa-tencent-ws/config.json
UNIT=xray-tampa-tencent-ws.service
INBOUND_TAG=tampa-tencent-ws-in
API_PORT=10091
AGENT_PORT=19241
XRAY_BIN="${XRAY_BIN:-/usr/local/bin/xray}"
SOURCE_DIR=/opt/vpn-standalone-sync-bunny-xhttp-tampa
TARGET_DIR=/opt/vpn-standalone-sync-te-ws-tampa
CONTAINER_NAME=vpn-te-ws-tampa-sync
EDGE_DIR=/opt/vpn-tampa-tencent-ws

systemctl is-active --quiet "$UNIT"
[ -f "$CONFIG" ]
[ -x "$XRAY_BIN" ]
[ -d "$SOURCE_DIR/vpn-edge-sync-agent" ]

python3 - "$CONFIG" "$API_PORT" "$INBOUND_TAG" <<'PY'
import json, sys, shutil, time, os
path, api_port, inbound_tag = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cfg = json.load(open(path))
changed = False
tags = [ib.get('tag') for ib in (cfg.get('inbounds') or [])]
if inbound_tag not in tags:
    raise SystemExit(f'missing inbound tag {inbound_tag}; have {tags}')
cfg['api'] = {'tag': 'api', 'services': ['HandlerService', 'LoggerService', 'StatsService']}
cfg['stats'] = cfg.get('stats') if isinstance(cfg.get('stats'), dict) else {}
policy = cfg.setdefault('policy', {})
system = policy.setdefault('system', {})
for k in ('statsInboundUplink', 'statsInboundDownlink', 'statsOutboundUplink', 'statsOutboundDownlink'):
    system[k] = True
inbounds = cfg.setdefault('inbounds', [])
api_ib = next((ib for ib in inbounds if ib.get('tag') == 'api'), None)
desired = {'tag': 'api', 'listen': '127.0.0.1', 'port': api_port, 'protocol': 'dokodemo-door', 'settings': {'address': '127.0.0.1'}}
if not api_ib:
    inbounds.append(desired)
    changed = True
elif api_ib.get('port') != api_port:
    api_ib.update(desired)
    changed = True
rules = cfg.setdefault('routing', {'domainStrategy': 'AsIs', 'rules': []}).setdefault('rules', [])
if not any(isinstance(r.get('inboundTag'), list) and 'api' in r.get('inboundTag', []) for r in rules):
    rules.insert(0, {'type': 'field', 'inboundTag': ['api'], 'outboundTag': 'api'})
    changed = True
if changed or not cfg.get('api'):
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    shutil.copy2(path, f'{path}.pre-api.{stamp}')
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    os.replace(tmp, path)
print(json.dumps({'ok': True, 'changed': True, 'apiPort': api_port}))
PY

"$XRAY_BIN" run -test -config "$CONFIG" >/tmp/tampa-te-api-test.log 2>&1
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"

rm -rf "$TARGET_DIR"
cp -a "$SOURCE_DIR" "$TARGET_DIR"
install -m 600 /dev/null "$EDGE_DIR/sync.env"

SYNC_KEY="$(grep -E '^EDGE_SYNC_KEY=' "$SOURCE_DIR/.env" | head -1 | cut -d= -f2-)"
[ -n "$SYNC_KEY" ]

cat > "$TARGET_DIR/.env" <<EOF
EDGE_ID=${EDGE_ID}
EDGE_SYNC_KEY=${SYNC_KEY}
PANEL_PULL_URL=https://sub.twidu.com/internal/edge/clients
PANEL_PULL_INTERVAL_MS=15000
AGENT_PORT=${AGENT_PORT}
CONTAINER_NAME=${CONTAINER_NAME}
EDGE_DIR=${EDGE_DIR}
XRAY_HOST_BIN=${XRAY_BIN}
XRAY_API_ADDR=127.0.0.1:${API_PORT}
XRAY_INBOUND_TAG=${INBOUND_TAG}
XRAY_CLIENT_FLOW=
EDGE_SYNC_ALLOW_RESTART=false
EOF
chmod 600 "$TARGET_DIR/.env"

COMPOSE="$TARGET_DIR/vpn-edge-sync-agent/docker-compose.standalone.yml"
[ -f "$COMPOSE" ]

cd "$TARGET_DIR/vpn-edge-sync-agent"
docker compose -f docker-compose.standalone.yml --env-file ../.env down 2>/dev/null || true
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker compose -f docker-compose.standalone.yml --env-file ../.env up -d --build

for _ in $(seq 1 40); do
  curl -fsS --max-time 2 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS --max-time 3 "http://127.0.0.1:${AGENT_PORT}/health" >/dev/null
sleep 20
status="$(curl -fsS --max-time 5 "http://127.0.0.1:${AGENT_PORT}/v1/status")"
python3 - "$status" <<'PY'
import json, sys
status = json.loads(sys.argv[1])
if not status.get('ok') or status.get('lastError'):
    raise SystemExit(status.get('lastError') or 'agent not ok')
count = int(status.get('clientCount') or 0)
if count < 1:
    raise SystemExit(f'clientCount={count}')
print(json.dumps({'ok': True, 'edgeId': status.get('edgeId'), 'clientCount': count, 'lastAppliedAt': status.get('lastAppliedAt')}))
PY

echo "TE_HOT_SYNC_OK edge=${EDGE_ID} api=${API_PORT} agent=${AGENT_PORT} mode=docker"
