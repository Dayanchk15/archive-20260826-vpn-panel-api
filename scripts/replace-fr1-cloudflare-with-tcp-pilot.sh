#!/usr/bin/env bash
set -euo pipefail

CONF=/etc/caddy/conf.d/fr1-cloudflare-grpc.caddy
STAMP="$(date +%Y%m%d-%H%M%S)"
RELAY_PID="$(systemctl show -p MainPID --value xray-relay-v2)"
BUNNY_PID="$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp)"
PILOT_PID="$(systemctl show -p MainPID --value xray-fr1-tcp-pilot)"
CADDY_PID="$(systemctl show -p MainPID --value caddy)"

systemctl is-active --quiet xray-relay-v2 xray-fr1-bunny-xhttp xray-fr1-tcp-pilot caddy

if [ -f "$CONF" ]; then
  cp -a "$CONF" "${CONF}.${STAMP}.bak"
  rm -f "$CONF"
fi

caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
systemctl disable --now xray-fr1-cloudflare-grpc.service >/dev/null 2>&1 || true
sleep 2

test "$(systemctl show -p MainPID --value xray-relay-v2)" = "$RELAY_PID"
test "$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp)" = "$BUNNY_PID"
test "$(systemctl show -p MainPID --value xray-fr1-tcp-pilot)" = "$PILOT_PID"
test "$(systemctl show -p MainPID --value caddy)" = "$CADDY_PID"
systemctl is-active --quiet xray-relay-v2 xray-fr1-bunny-xhttp xray-fr1-tcp-pilot caddy

echo "FR1 Cloudflare gRPC retired; relay, Bunny, TCP pilot and Caddy stayed online"
