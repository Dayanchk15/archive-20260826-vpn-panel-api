#!/bin/bash
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
FASTLY_HOST="${FASTLY_HOST:-painfully-super-puma.global.ssl.fastly.net}"
XRAY_PORT="${XRAY_PORT:-18444}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="/root/Caddyfile.fastly-${STAMP}"

[ -s "$CADDYFILE" ] || { echo "Caddyfile is missing" >&2; exit 1; }
systemctl is-active --quiet caddy.service
docker inspect xray-tampa-reality >/dev/null
docker inspect xray-tampa-fastly-xhttp >/dev/null
CADDY_PID_BEFORE="$(systemctl show -p MainPID --value caddy.service)"
REALITY_PID_BEFORE="$(docker inspect -f '{{.State.Pid}}' xray-tampa-reality)"
XHTTP_PID_BEFORE="$(docker inspect -f '{{.State.Pid}}' xray-tampa-fastly-xhttp)"
cp "$CADDYFILE" "$BACKUP"

if ! grep -q '# FASTLY_TAMPA_XHTTP_BEGIN' "$CADDYFILE"; then
  python3 - "$CADDYFILE" "$FASTLY_HOST" "$XRAY_PORT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
host = sys.argv[2]
port = int(sys.argv[3])
text = path.read_text()
needle = ':80 {'
if needle not in text:
    raise SystemExit('Tampa Caddy catch-all :80 block is missing')
block = f'''# FASTLY_TAMPA_XHTTP_BEGIN
http://{host} {{
    reverse_proxy 127.0.0.1:{port} {{
        flush_interval -1
        transport http {{
            versions 1.1
            dial_timeout 10s
        }}
    }}
}}
# FASTLY_TAMPA_XHTTP_END

'''
path.write_text(text.replace(needle, block + needle, 1))
PY
fi

caddy fmt --overwrite "$CADDYFILE"
caddy validate --config "$CADDYFILE"
systemctl reload caddy.service
sleep 2
systemctl is-active --quiet caddy.service

CADDY_PID_AFTER="$(systemctl show -p MainPID --value caddy.service)"
REALITY_PID_AFTER="$(docker inspect -f '{{.State.Pid}}' xray-tampa-reality)"
XHTTP_PID_AFTER="$(docker inspect -f '{{.State.Pid}}' xray-tampa-fastly-xhttp)"
[ "$CADDY_PID_BEFORE" = "$CADDY_PID_AFTER" ] || { echo "Caddy PID changed unexpectedly" >&2; exit 1; }
[ "$REALITY_PID_BEFORE" = "$REALITY_PID_AFTER" ] || { echo "Tampa Reality PID changed unexpectedly" >&2; exit 1; }
[ "$XHTTP_PID_BEFORE" = "$XHTTP_PID_AFTER" ] || { echo "Tampa xHTTP PID changed unexpectedly" >&2; exit 1; }

STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $FASTLY_HOST" http://127.0.0.1/)"
[ "$STATUS" = "400" ] || { echo "Unexpected Tampa xHTTP proxy status: $STATUS" >&2; exit 1; }
echo "TAMPA_FASTLY_PORT80_OK caddyPid=$CADDY_PID_AFTER realityPid=$REALITY_PID_AFTER xhttpPid=$XHTTP_PID_AFTER backup=$BACKUP"
