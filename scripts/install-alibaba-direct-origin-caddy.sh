#!/bin/bash
# Install a host-specific Alibaba ESA direct-origin Caddy route.
#
# Required env:
#   EDGE_ID       short id used in markers (fr1|fr2|fornex|tampa)
#   ESA_HOST      public ESA hostname, e.g. cdn-a2.levospeed.click
#   ESA_PATH      xHTTP path prefix, e.g. /media/v4/fr2/sync
#   UPSTREAM      local h2c upstream, e.g. 127.0.0.1:18098
#
# Optional env:
#   CADDY_FILE    default /etc/caddy/Caddyfile
#   SITE_PORT     append :PORT to Caddy site label, needed when Caddy HTTP port is remapped
#   BIND_ADDR     add "bind ADDR" inside the site block
set -euo pipefail

EDGE_ID="${EDGE_ID:?EDGE_ID required}"
ESA_HOST="${ESA_HOST:?ESA_HOST required}"
ESA_PATH="${ESA_PATH:?ESA_PATH required}"
UPSTREAM="${UPSTREAM:?UPSTREAM required}"
CADDY_FILE="${CADDY_FILE:-/etc/caddy/Caddyfile}"
SITE_PORT="${SITE_PORT:-}"
BIND_ADDR="${BIND_ADDR:-}"

if [[ "$ESA_PATH" != /* ]]; then
  echo "ESA_PATH must start with /" >&2
  exit 1
fi
if [[ ! -f "$CADDY_FILE" ]]; then
  echo "Caddy file not found: $CADDY_FILE" >&2
  exit 1
fi

MARK_BEGIN="# ALIBABA_ESA_DIRECT_ORIGIN_${EDGE_ID}_BEGIN"
MARK_END="# ALIBABA_ESA_DIRECT_ORIGIN_${EDGE_ID}_END"

if grep -qF "$MARK_BEGIN" "$CADDY_FILE"; then
  echo "ALIBABA_DIRECT_ORIGIN_ALREADY_PRESENT edge=$EDGE_ID file=$CADDY_FILE"
  caddy validate --config /etc/caddy/Caddyfile >/tmp/caddy-alibaba-direct-origin-validate.log 2>&1
  systemctl reload caddy
  exit 0
fi

BACKUP="${CADDY_FILE}.pre-alibaba-direct-${EDGE_ID}-$(date -u +%Y%m%dT%H%M%SZ)"
cp -a "$CADDY_FILE" "$BACKUP"

BIND_LINE=""
if [[ -n "$BIND_ADDR" ]]; then
  BIND_LINE="  bind $BIND_ADDR"
fi

cat >>"$CADDY_FILE" <<EOF

$MARK_BEGIN
http://${ESA_HOST}${SITE_PORT} {
${BIND_LINE}
  header Alt-Svc clear

  handle ${ESA_PATH}* {
    reverse_proxy h2c://${UPSTREAM} {
      flush_interval -1
    }
  }

  respond 404
}
$MARK_END
EOF

if ! caddy validate --config /etc/caddy/Caddyfile >/tmp/caddy-alibaba-direct-origin-validate.log 2>&1; then
  cp -a "$BACKUP" "$CADDY_FILE"
  echo "Caddy validate failed; restored $BACKUP" >&2
  cat /tmp/caddy-alibaba-direct-origin-validate.log >&2
  exit 1
fi

systemctl reload caddy

echo "ALIBABA_DIRECT_ORIGIN_OK edge=$EDGE_ID host=$ESA_HOST path=$ESA_PATH upstream=$UPSTREAM file=$CADDY_FILE backup=$BACKUP"
