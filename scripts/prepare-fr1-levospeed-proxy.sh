#!/bin/bash
set -euo pipefail

DOMAIN="${DOMAIN:-levospeed.it.com}"
WWW_DOMAIN="${WWW_DOMAIN:-www.levospeed.it.com}"
UPSTREAM_IP="${UPSTREAM_IP:-45.140.42.39}"
UPSTREAM_HOST="${UPSTREAM_HOST:-sub.twidu.com}"
EMAIL="${EMAIL:-admin@twidu.com}"
READY_CONFIG=/etc/caddy/Caddyfile.levospeed-ready

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

mkdir -p /etc/caddy /root/fr1-levospeed-backups
if [ -s /etc/caddy/Caddyfile ]; then
  cp /etc/caddy/Caddyfile "/root/fr1-levospeed-backups/Caddyfile.$(date -u +%Y%m%d-%H%M%S)"
fi

cat > "$READY_CONFIG" <<CADDY
{
    email ${EMAIL}
    servers {
        protocols h1 h2
    }
}

${DOMAIN}, ${WWW_DOMAIN} {
    header Alt-Svc "clear"

    @allowed path /api/sub/* /sub/* /api/status/* /status/* /f/* /health
    handle @allowed {
        reverse_proxy https://${UPSTREAM_IP} {
            header_up Host ${UPSTREAM_HOST}
            header_up Accept-Encoding identity
            transport http {
                tls
                tls_server_name ${UPSTREAM_HOST}
                dial_timeout 15s
                response_header_timeout 30s
                versions 2 1.1
            }
        }
    }

    respond 404
}
CADDY

caddy validate --config "$READY_CONFIG"

# Keep only a harmless HTTP readiness endpoint active until DNS points to FR1.
# This avoids failed ACME attempts and certificate rate limits before the DNS cutover.
cat > /etc/caddy/Caddyfile <<'CADDY'
:80 {
    respond /ping "FR1 subscription edge ready" 200
    respond 404
}
CADDY

caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy
systemctl is-active --quiet caddy

curl -fsS --max-time 10 "https://${UPSTREAM_HOST}/health" >/dev/null
curl -fsS --max-time 5 http://127.0.0.1/ping >/dev/null

echo "FR1_LEVOSPEED_PROXY_PREPARED"
echo "ready_config=${READY_CONFIG}"
echo "next_dns_a=${DOMAIN}->185.209.230.14"
echo "next_dns_a=${WWW_DOMAIN}->185.209.230.14"

