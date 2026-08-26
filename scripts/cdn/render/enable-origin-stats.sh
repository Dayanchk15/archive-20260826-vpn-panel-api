#!/usr/bin/env bash
# Enable Xray StatsService for the isolated Render FR1 origin only.
# This deliberately restarts xray-fr1-ws-7865, never production services.
set -euo pipefail

CFG="${CFG:-/opt/vpn-fr1-ws-7865/config.json}"
UNIT="${UNIT:-xray-fr1-ws-7865.service}"
API_PORT="${API_PORT:-10096}"
XRAY="${XRAY_BIN:-/usr/local/bin/xray}"

[[ -f "$CFG" ]] || { echo "Missing config: $CFG" >&2; exit 1; }
[[ -x "$XRAY" ]] || { echo "Missing xray: $XRAY" >&2; exit 1; }
systemctl is-active --quiet "$UNIT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$CFG.bak-stats-$STAMP"
TMP="$(mktemp --suffix=.json)"
cp -a "$CFG" "$BACKUP"

python3 - "$CFG" "$TMP" "$API_PORT" <<'PY'
import json
import sys

source, target, api_port = sys.argv[1], sys.argv[2], int(sys.argv[3])
with open(source, 'r', encoding='utf-8') as handle:
    config = json.load(handle)

config['api'] = {
    'listen': f'127.0.0.1:{api_port}',
    'services': ['StatsService'],
    'tag': 'api',
}
config.setdefault('stats', {})
policy = config.setdefault('policy', {})
system = policy.setdefault('system', {})
system['statsInboundUplink'] = True
system['statsInboundDownlink'] = True
levels = policy.setdefault('levels', {})
for level in ('0', '8'):
    levels.setdefault(level, {})
    levels[level]['statsUserUplink'] = True
    levels[level]['statsUserDownlink'] = True

with open(target, 'w', encoding='utf-8') as handle:
    json.dump(config, handle, indent=2)
    handle.write('\n')
PY

"$XRAY" run -test -config "$TMP"
install -m 600 "$TMP" "$CFG"
rm -f "$TMP"
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT"
"$XRAY" api statsquery --server="127.0.0.1:$API_PORT" -pattern traffic >/tmp/render-fr1-stats-smoke.json
grep -q 'traffic' /tmp/render-fr1-stats-smoke.json
echo "RENDER_FR1_STATS_OK unit=$UNIT api=127.0.0.1:$API_PORT backup=$BACKUP"
