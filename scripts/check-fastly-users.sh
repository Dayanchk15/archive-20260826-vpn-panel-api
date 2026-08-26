#!/bin/sh
set -eu

CONFIG="$1"
TAG="$2"
API="$3"
XRAY="$4"
shift 4

python3 - "$CONFIG" "$TAG" "$@" <<'PY'
import json
import sys

config_path, tag, *wanted = sys.argv[1:]
config = json.load(open(config_path, encoding='utf-8'))
inbound = next(item for item in config['inbounds'] if item.get('tag') == tag)
ids = {item.get('id') for item in inbound.get('settings', {}).get('clients', [])}
print(f'config_count={len(ids)}')
for uuid in wanted:
    print(f'config_{uuid}={uuid in ids}')
PY

api_output="$(mktemp)"
trap 'rm -f "$api_output"' EXIT
$XRAY api inbounduser -s "$API" -tag "$TAG" >"$api_output" 2>&1 || true
for uuid in "$@"; do
  if grep -Fq "$uuid" "$api_output"; then
    echo "api_${uuid}=true"
  else
    echo "api_${uuid}=false"
  fi
done
