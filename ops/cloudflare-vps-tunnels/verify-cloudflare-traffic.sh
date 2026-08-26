#!/bin/bash
set -euo pipefail

UNIT="${1:?traffic reporter unit required}"
STATS_FILE="$(mktemp /tmp/cloudflare-user-stats.XXXXXX.json)"
trap 'rm -f "$STATS_FILE"' EXIT

printf 'enabled='
systemctl is-enabled "$UNIT"
printf 'active='
systemctl is-active "$UNIT"
/usr/local/bin/xray api statsquery --server=127.0.0.1:10094 -pattern user >"$STATS_FILE"
python3 - "$STATS_FILE" <<'PY'
import json
import sys

stats = json.load(open(sys.argv[1], encoding="utf-8")).get("stat", [])
user_stats = [item for item in stats if str(item.get("name", "")).startswith("user>>>")]
total = sum(int(item.get("value", 0) or 0) for item in user_stats)
print(f"userCounters={len(user_stats)} bytes={total}")
PY
journalctl -u "$UNIT" --since '-10 min' --no-pager | grep -E 'Reported|error' | tail -5 || true
