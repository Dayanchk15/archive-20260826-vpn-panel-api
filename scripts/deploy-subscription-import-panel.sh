#!/bin/sh
set -eu

ROOT=/opt/vpn-panel-api-vps
CONTAINER=vpn-panel-api-vps
stamp="$(date +%Y%m%d-%H%M%S)"
backup="$ROOT/backups/subscription-import-$stamp"

mkdir -p "$backup"
cp "$ROOT/public/admin.html" "$backup/admin.html"
cp "$ROOT/routes/admin.js" "$backup/admin.js"
if [ -f "$ROOT/lib/external-subscription-import.js" ]; then
  cp "$ROOT/lib/external-subscription-import.js" "$backup/"
fi

install -m 0644 /tmp/admin.html.subscription-import "$ROOT/public/admin.html"
install -m 0644 /tmp/admin.js.subscription-import "$ROOT/routes/admin.js"
install -m 0644 /tmp/external-subscription-import.js "$ROOT/lib/external-subscription-import.js"

docker restart "$CONTAINER" >/dev/null
i=0
while [ "$i" -lt 30 ]; do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || true)"
  [ "$health" = healthy ] && break
  i=$((i + 1))
  sleep 2
done

echo "backup=$backup"
docker inspect -f 'status={{.State.Status}} health={{.State.Health.Status}}' "$CONTAINER"
docker logs --since 90s "$CONTAINER" 2>&1 | tail -30
