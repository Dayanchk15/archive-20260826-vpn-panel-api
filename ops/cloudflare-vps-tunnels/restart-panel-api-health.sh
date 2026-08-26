#!/bin/bash
set -euo pipefail

APP_ROOT="/opt/vpn-panel-api-vps"
CONTAINER="vpn-panel-api-vps"

grep -q 'compactWsShareLink' "$APP_ROOT/lib/vless.js"
if grep -q 'strictAddressIp' "$APP_ROOT/lib/address-ips.js"; then
  echo 'strictAddressIp must be removed before restart' >&2
  exit 1
fi

docker restart "$CONTAINER" >/dev/null
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)"
  echo "health=$status"
  if [ "$status" = 'healthy' ]; then
    exit 0
  fi
  sleep 3
done

docker logs --tail 50 "$CONTAINER"
exit 1
