#!/bin/bash
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
BACKUP="${CADDYFILE}.pre-cloudflare-ws.$(date +%Y%m%d-%H%M%S)"
TEMP="$(mktemp /tmp/Caddyfile.cloudflare-ws.XXXXXX)"
trap 'rm -f "$TEMP"' EXIT

if grep -q '/media/v3/tampa/ws' "$CADDYFILE"; then
  caddy validate --config "$CADDYFILE"
  systemctl reload caddy
  exit 0
fi

cp -a "$CADDYFILE" "$BACKUP"
awk '
  /^[[:space:]]*handle \/bunny\/tampa\*/ && !inserted {
    print "    handle /media/v3/tampa/ws* {"
    print "        reverse_proxy 127.0.0.1:18094 {"
    print "            header_up Host {host}"
    print "            flush_interval -1"
    print "            transport http {"
    print "                versions 1.1"
    print "            }"
    print "        }"
    print "    }"
    print ""
    inserted=1
  }
  { print }
  END { if (!inserted) exit 42 }
' "$CADDYFILE" > "$TEMP"

caddy validate --config "$TEMP"
install -o root -g root -m 0644 "$TEMP" "$CADDYFILE"
systemctl reload caddy
systemctl is-active caddy
