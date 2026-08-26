#!/usr/bin/env bash
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${CADDYFILE}.worker-ws.${STAMP}.bak"
OLD_CADDY_PID="$(systemctl show -p MainPID --value caddy)"
OLD_RELAY_PID="$(systemctl show -p MainPID --value xray-relay-v2)"
OLD_BUNNY_PID="$(systemctl show -p MainPID --value xray-tampa-bunny-ws)"

cp -a "$CADDYFILE" "$BACKUP"

python3 - "$CADDYFILE" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old = '''https://tampa.levospeed.click:9444 {
    bind 172.17.0.1
    header Alt-Svc "clear"
    reverse_proxy h2c://127.0.0.1:18093
}'''
new = '''https://tampa.levospeed.click:9444 {
    bind 172.17.0.1
    header Alt-Svc "clear"

    handle /bunny/tampa* {
        reverse_proxy 127.0.0.1:18090
    }

    handle {
        reverse_proxy h2c://127.0.0.1:18093
    }
}'''
if new in text:
    print("Tampa Worker WebSocket route already present")
elif old not in text:
    raise SystemExit("Expected Tampa Cloudflare Caddy block was not found; refusing to edit")
else:
    path.write_text(text.replace(old, new, 1))
    print("Added isolated Tampa WebSocket route")
PY

if ! caddy validate --config "$CADDYFILE"; then
  cp -a "$BACKUP" "$CADDYFILE"
  exit 1
fi

systemctl reload caddy
sleep 2

test "$(systemctl show -p MainPID --value caddy)" = "$OLD_CADDY_PID"
test "$(systemctl show -p MainPID --value xray-relay-v2)" = "$OLD_RELAY_PID"
test "$(systemctl show -p MainPID --value xray-tampa-bunny-ws)" = "$OLD_BUNNY_PID"
systemctl is-active --quiet caddy xray-relay-v2 xray-tampa-bunny-ws xray-tampa-cloudflare-grpc

echo "Caddy reloaded without restart; production and Bunny PIDs unchanged"
echo "Backup: $BACKUP"
