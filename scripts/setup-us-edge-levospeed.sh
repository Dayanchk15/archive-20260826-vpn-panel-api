#!/bin/bash
# US edge VPS for Happ subscriptions (like tonywaka.it.com on Hivelocity Tampa).
# Run on a NEW Ubuntu 22.04/24.04 VPS in USA (Tampa/Miami/NYC).
#
# Before run:
#   1. Buy VPS (Hivelocity TPA2, Vultr Miami, etc.)
#   2. DNS levospeed.it.com A -> THIS SERVER PUBLIC IP
#   3. Frankfurt panel already has levospeed.it.com in Caddy + subscriptionBaseUrl
#
# Usage:
#   curl -fsSL ... | bash
#   or: bash scripts/setup-us-edge-levospeed.sh
set -euo pipefail

DOMAIN="${DOMAIN:-levospeed.it.com}"
UPSTREAM_IP="${UPSTREAM_IP:-45.140.42.39}"
UPSTREAM_HOST="${UPSTREAM_HOST:-sub.twidu.com}"
EMAIL="${EMAIL:-admin@twidu.com}"

echo "=== US edge proxy for ${DOMAIN} -> ${UPSTREAM_IP} (Host: ${UPSTREAM_HOST}) ==="

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
{
    email ${EMAIL}
}

${DOMAIN} {
    handle /api/sub/* {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    handle /sub/* {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    handle /api/status/* {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    handle /status/* {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    handle /f/* {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    handle /health {
        reverse_proxy https://sub.twidu.com {
            header_up Host ${UPSTREAM_HOST}
        }
    }
    respond 404
}

:80 {
    respond /ping "US edge OK" 200
}
CADDY

caddy validate --config /etc/caddy/Caddyfile
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

echo ""
echo "=== Done ==="
echo "1. Point DNS: ${DOMAIN} A -> $(curl -sS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')"
echo "2. Wait 5-30 min for DNS + Let's Encrypt"
echo "3. Test: curl -sS https://${DOMAIN}/health"
echo "4. Test sub: curl -sS 'https://${DOMAIN}/api/sub/TOKEN?format=plain' | head"
echo ""
echo "Panel stays on Frankfurt ${UPSTREAM_IP}. Clients use https://${DOMAIN}/api/sub/..."
