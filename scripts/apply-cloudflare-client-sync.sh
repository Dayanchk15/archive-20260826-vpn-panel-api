#!/bin/bash
set -euo pipefail

CONFIG="${CONFIG:-/opt/vpn-cloudflare-ws/config.json}"
CLIENTS="${CLIENTS:-/tmp/edge-clients.json}"
PATCHER="${PATCHER:-/tmp/sync-cloudflare-origin-clients.py}"
UNIT="${UNIT:-xray-cloudflare-ws.service}"
RESULT="$(mktemp /tmp/cf-client-sync.XXXXXX.json)"
trap 'rm -f "$RESULT"' EXIT

python3 "$PATCHER" "$CONFIG" "$CLIENTS" > "$RESULT"
BACKUP="$(python3 - "$RESULT" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding='utf-8'))['backup'])
PY
)"

CHANGES="$(python3 - "$RESULT" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
print(int(data.get('added', 0)) + int(data.get('removedStale', 0)))
PY
)"

if [ "$CHANGES" = 0 ]; then
  systemctl is-active --quiet "$UNIT"
  cat "$RESULT"
  echo "unitActive=true"
  echo "restartSkipped=true"
  exit 0
fi

if ! systemctl restart "$UNIT" || ! systemctl is-active --quiet "$UNIT"; then
  cp -a "$BACKUP" "$CONFIG"
  systemctl restart "$UNIT"
  systemctl is-active --quiet "$UNIT"
  echo 'Cloudflare client sync failed and was rolled back' >&2
  exit 1
fi

cat "$RESULT"
echo "unitActive=true"
