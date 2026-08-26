#!/bin/bash
# Install bare-metal Xray relay edges on Contabo VPS (password SSH from panel host).
set -euo pipefail

ROOT="/opt/vpn-panel-api-vps"
REPORT_KEY="$(grep ^EDGE_REPORT_KEY= "$ROOT/.env.vps" | cut -d= -f2-)"
REPORT_URL="${PANEL_REPORT_URL:-https://sub.twidu.com/internal/traffic/report}"
PASS="${CONTABO_SSH_PASS:?Set CONTABO_SSH_PASS}"

install_one() {
  local edge_id="$1"
  local port="$2"
  local ip="$3"
  echo "=== install $edge_id $ip:$port ==="

  local config_file="/tmp/vpn-relay-config-${edge_id}.json"
  docker exec -e EDGE_PORT="$port" -e OUTPUT="/tmp/edge-config.json" vpn-panel-api-vps node /app/scripts/generate-edge-config-file.mjs
  docker cp vpn-panel-api-vps:/tmp/edge-config.json "$config_file"

  sshpass -p "$PASS" scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
    "$config_file" "$ROOT/scripts/start-xray-bare.sh" "root@${ip}:/tmp/"

  sshpass -p "$PASS" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=120 "root@${ip}" \
    "sed -i 's/\r$//' /tmp/start-xray-bare.sh; mkdir -p /opt/vpn-relay-edge; cp /tmp/$(basename "$config_file") /opt/vpn-relay-edge/config.json; chmod +x /tmp/start-xray-bare.sh; /tmp/start-xray-bare.sh ${port}"

  echo "OK $edge_id $ip:$port"
}

install_one relay-eu-fr1 8088 185.209.230.14
install_one relay-eu-fr2 8089 185.209.230.46

echo "=== connectivity from panel ==="
for spec in "185.209.230.14:8088" "185.209.230.46:8089"; do
  ip="${spec%:*}"
  port="${spec#*:}"
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "http://${ip}:${port}/" || echo ERR)"
  echo "ws://${ip}:${port}/ -> HTTP $code"
done
