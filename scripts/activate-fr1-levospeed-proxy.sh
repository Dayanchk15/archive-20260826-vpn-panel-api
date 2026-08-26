#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-levospeed.it.com}"
WWW_DOMAIN="${WWW_DOMAIN:-www.levospeed.it.com}"
EXPECTED_IP="${EXPECTED_IP:-185.209.230.14}"
READY_CONFIG=/etc/caddy/Caddyfile.levospeed-ready

[ -s "$READY_CONFIG" ] || { echo "Prepared Caddyfile is missing" >&2; exit 1; }

for name in "$DOMAIN" "$WWW_DOMAIN"; do
  resolved="$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}')"
  [ "$resolved" = "$EXPECTED_IP" ] || {
    echo "$name still resolves to ${resolved:-nothing}, expected $EXPECTED_IP" >&2
    exit 1
  }
done

cp /etc/caddy/Caddyfile "/root/fr1-levospeed-backups/Caddyfile.pre-activate.$(date -u +%Y%m%d-%H%M%S)"
cp "$READY_CONFIG" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
caddy reload --config /etc/caddy/Caddyfile

for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "https://${DOMAIN}/health" >/dev/null 2>&1; then
    echo "FR1_LEVOSPEED_PROXY_ACTIVE"
    exit 0
  fi
  sleep 10
done

echo "FR1 proxy was loaded, but HTTPS certificate is not ready yet" >&2
exit 1
