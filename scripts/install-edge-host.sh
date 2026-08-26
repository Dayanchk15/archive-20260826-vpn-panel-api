#!/bin/bash
# Install relay edge bundle on one VPS (host-side, uses panel SSH key).
set -euo pipefail
EDGE_ID="${1:?EDGE_ID required}"
EDGE_PORT="${2:?EDGE_PORT required}"
TARGET_IP="${3:?TARGET_IP required}"
SSH_PORT="${4:-22}"
USE_JUMP="${5:-0}"
KEY="${SSH_KEY:-/opt/vpn-panel-secrets/id_ed25519_edge}"
JUMP="${JUMP_HOST:-root@194.127.179.178}"
ROOT="/opt/vpn-panel-api-vps"
BUNDLE="/tmp/vpn-relay-edge-bundle.tar.gz"
REPORT_KEY="$(grep ^EDGE_REPORT_KEY= "$ROOT/.env.vps" | cut -d= -f2-)"
REPORT_URL="${PANEL_REPORT_URL:-https://sub.twidu.com/internal/traffic/report}"

ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$KEY")
scp_args=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$KEY")
if [ "$SSH_PORT" != "22" ]; then
  ssh_args+=(-p "$SSH_PORT")
  scp_args+=(-P "$SSH_PORT")
fi
if [ "$USE_JUMP" = "1" ]; then
  ssh_args+=(-o "ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $KEY -W %h:%p $JUMP")
  scp_args+=(-o "ProxyCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -i $KEY -W %h:%p $JUMP")
fi
target="root@${TARGET_IP}"

if [ ! -f "$BUNDLE" ]; then
  stage="$(mktemp -d)"
  cp -a "$ROOT/vpn-edge" "$stage/vpn-edge"
  cp "$ROOT/scripts/eu-relay-dayanch/docker-compose.edge.yml" "$stage/"
  cp "$ROOT/scripts/eu-relay-dayanch/install-edge-on-vps.sh" "$stage/"
  tar -czf "$BUNDLE" -C "$stage" .
  rm -rf "$stage"
fi

remote_tar="/tmp/vpn-relay-edge-${EDGE_ID}.tar.gz"
scp "${scp_args[@]}" "$BUNDLE" "${target}:${remote_tar}"

clients_json="$(docker exec vpn-panel-api-vps node -e "import('/app/lib/edge-clients.js').then(async m=>console.log(JSON.stringify(await m.buildEdgeClientList())))")"

ssh "${ssh_args[@]}" "$target" bash -s <<EOF
set -euo pipefail
EDGE_DIR=/opt/vpn-relay-edge
rm -rf "\$EDGE_DIR"
mkdir -p "\$EDGE_DIR"
tar -xzf ${remote_tar} -C "\$EDGE_DIR"
chmod +x "\$EDGE_DIR/install-edge-on-vps.sh"
export EDGE_PORT=${EDGE_PORT}
export VLESS_CLIENTS_JSON='${clients_json}'
export PANEL_REPORT_URL='${REPORT_URL}'
export EDGE_REPORT_KEY='${REPORT_KEY}'
export TRAFFIC_NODE_ID='${EDGE_ID}'
"\$EDGE_DIR/install-edge-on-vps.sh"
ss -tlnp | grep -E ':${EDGE_PORT}\\b' || true
docker compose -f "\$EDGE_DIR/docker-compose.edge.yml" ps
EOF

echo "OK ${EDGE_ID} ${TARGET_IP}:${EDGE_PORT}"
