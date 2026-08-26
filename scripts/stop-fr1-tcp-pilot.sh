#!/usr/bin/env bash
set -euo pipefail

RELAY_PID="$(systemctl show -p MainPID --value xray-relay-v2)"
BUNNY_PID="$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp)"
CADDY_PID="$(systemctl show -p MainPID --value caddy)"

systemctl disable --now xray-fr1-tcp-pilot.service >/dev/null 2>&1 || true
ufw delete allow 18443/tcp >/dev/null 2>&1 || true
while iptables -C INPUT -p tcp --dport 18443 -j ACCEPT 2>/dev/null; do
  iptables -D INPUT -p tcp --dport 18443 -j ACCEPT
done
sleep 1

test "$(systemctl show -p MainPID --value xray-relay-v2)" = "$RELAY_PID"
test "$(systemctl show -p MainPID --value xray-fr1-bunny-xhttp)" = "$BUNNY_PID"
test "$(systemctl show -p MainPID --value caddy)" = "$CADDY_PID"
systemctl is-active --quiet xray-relay-v2 xray-fr1-bunny-xhttp caddy
if ss -ltn | awk '$4 ~ /:18443$/ { found=1 } END { exit !found }'; then
  echo "Port 18443 is still listening" >&2
  exit 1
fi

echo "FR1 TCP pilot stopped; relay, Bunny and Caddy stayed online"
