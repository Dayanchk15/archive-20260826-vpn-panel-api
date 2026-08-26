#!/bin/bash
# Expand Dayanch/Bunny XHTTP origin clients from a JSON array file.
# Usage: CONFIG=... UNIT=... CLIENTS_JSON=/tmp/clients.json bash expand-xhttp-origin-clients.sh
set -euo pipefail

CONFIG="${CONFIG:?}"
UNIT="${UNIT:?}"
CLIENTS_JSON="${CLIENTS_JSON:?}"
XRAY_BIN="${XRAY_BIN:-}"

[ -f "$CONFIG" ]
[ -f "$CLIENTS_JSON" ]
systemctl is-active --quiet "$UNIT"

if [ -z "$XRAY_BIN" ] || [ ! -x "$XRAY_BIN" ]; then
  # systemd ExecStart may be "{ path=/usr/local/bin/xray ; argv[]=... }"
  XRAY_BIN="$(systemctl show -p ExecStart --value "$UNIT" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
fi
if [ -z "$XRAY_BIN" ] || [ ! -x "$XRAY_BIN" ]; then
  XRAY_BIN="$(command -v xray || true)"
fi
if [ -z "$XRAY_BIN" ] || [ ! -x "$XRAY_BIN" ]; then
  for cand in /opt/vpn-dayanch-bunny-xhttp/xray-26.3.27 /opt/vpn-fr1-bunny-xhttp2/xray /usr/local/bin/xray; do
    if [ -x "$cand" ]; then XRAY_BIN="$cand"; break; fi
  done
fi
[ -x "$XRAY_BIN" ]

python3 - "$CONFIG" "$CLIENTS_JSON" <<'PY'
import json, sys, time, shutil, os
config_path, clients_path = sys.argv[1], sys.argv[2]
cfg = json.load(open(config_path))
raw = json.load(open(clients_path))
if not isinstance(raw, list) or not raw:
    raise SystemExit('clients json must be a non-empty array')

seen = set()
clients = []
for item in raw:
    uuid = str(item.get('uuid') or item.get('id') or '').strip().lower()
    if not uuid or uuid in seen:
        continue
    seen.add(uuid)
    email = str(item.get('email') or f'user-{uuid[:8]}').strip() or f'user-{uuid[:8]}'
    clients.append({'id': uuid, 'email': email, 'level': 0})

if len(clients) < 2:
    raise SystemExit(f'too few clients after normalize: {len(clients)}')

inbounds = cfg.get('inbounds') or []
if not inbounds:
    raise SystemExit('no inbounds')
# first vless inbound
target = None
for ib in inbounds:
    if ib.get('protocol') == 'vless':
        target = ib
        break
if target is None:
    target = inbounds[0]

before = len((target.get('settings') or {}).get('clients') or [])
target.setdefault('settings', {})
target['settings']['clients'] = clients
target['settings']['decryption'] = 'none'

stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
backup = f'{config_path}.pre-xhttp-expand.{stamp}'
shutil.copy2(config_path, backup)
tmp = config_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
os.replace(tmp, config_path)
print(json.dumps({'ok': True, 'backup': backup, 'before': before, 'after': len(clients), 'path': (target.get('streamSettings') or {}).get('xhttpSettings', {}).get('path')}))
PY

"$XRAY_BIN" run -test -config "$CONFIG" >/tmp/xhttp-expand-test.log 2>&1 || {
  echo "xray test failed" >&2
  cat /tmp/xhttp-expand-test.log >&2
  # restore latest backup
  latest="$(ls -1t "${CONFIG}".pre-xhttp-expand.* 2>/dev/null | head -1 || true)"
  [ -n "$latest" ] && cp -a "$latest" "$CONFIG"
  exit 1
}

systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"

python3 - "$CONFIG" <<'PY'
import json, sys
cfg=json.load(open(sys.argv[1]))
for ib in cfg.get('inbounds') or []:
  if ib.get('protocol')=='vless':
    n=len((ib.get('settings') or {}).get('clients') or [])
    path=((ib.get('streamSettings') or {}).get('xhttpSettings') or {}).get('path')
    print(f'XHTTP_EXPAND_OK clients={n} path={path} unit_active=1')
    break
PY
