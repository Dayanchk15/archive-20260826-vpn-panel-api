#!/bin/bash
# Run ON the VPS (origin behind Google LB). Does not touch panel or Cloud Run.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/vpn-panel-api-vps}"
COMPOSE_DIR="$REPO_DIR/scripts/glb-vps-pilot"
ENV_FILE="$COMPOSE_DIR/.env"

mkdir -p "$COMPOSE_DIR"
if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
VLESS_CLIENTS_JSON=[]
PANEL_REPORT_URL=${PANEL_REPORT_URL:-https://levospeed.it.com/internal/traffic/report}
EDGE_REPORT_KEY=${EDGE_REPORT_KEY:-}
EOF
fi

cd "$COMPOSE_DIR"
docker compose -f docker-compose.edge.yml build
docker compose -f docker-compose.edge.yml up -d

echo "Edge on 127.0.0.1:8080 — allow GLB to reach VPS:8080 (ufw/security group)."
docker compose -f docker-compose.edge.yml ps
