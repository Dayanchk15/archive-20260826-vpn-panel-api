#!/bin/bash
# Install Dayanch EU relay edge in /opt/vpn-relay-edge/ (does NOT touch remnanode :443).
if grep -q $'\r' "$0" 2>/dev/null; then
  sed -i 's/\r$//' "$0"
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail
export PATH="/usr/bin:/bin:/sbin:${PATH:-}"
COMPOSE_BIN="/usr/libexec/docker/cli-plugins/docker-compose"

EDGE_DIR="${EDGE_DIR:-/opt/vpn-relay-edge}"
EDGE_PORT="${EDGE_PORT:?EDGE_PORT required}"
VLESS_CLIENTS_JSON="${VLESS_CLIENTS_JSON:-[]}"
PANEL_REPORT_URL="${PANEL_REPORT_URL:-https://sub.twidu.com/internal/traffic/report}"
EDGE_REPORT_KEY="${EDGE_REPORT_KEY:-}"
TRAFFIC_NODE_ID="${TRAFFIC_NODE_ID:-relay-eu-edge}"

mkdir -p "$EDGE_DIR/vpn-edge"
if [ ! -f "$EDGE_DIR/docker-compose.edge.yml" ]; then
  echo "docker-compose.edge.yml missing in $EDGE_DIR"
  exit 1
fi

cat >"$EDGE_DIR/.env" <<EOF
EDGE_PORT=${EDGE_PORT}
PANEL_REPORT_URL=${PANEL_REPORT_URL}
EDGE_REPORT_KEY=${EDGE_REPORT_KEY}
TRAFFIC_NODE_ID=${TRAFFIC_NODE_ID}
EOF
if [ -n "${VLESS_CLIENTS_JSON_FILE:-}" ] && [ -f "$VLESS_CLIENTS_JSON_FILE" ]; then
  printf 'VLESS_CLIENTS_JSON=' >>"$EDGE_DIR/.env"
  cat "$VLESS_CLIENTS_JSON_FILE" >>"$EDGE_DIR/.env"
  echo >>"$EDGE_DIR/.env"
else
  printf 'VLESS_CLIENTS_JSON=' >>"$EDGE_DIR/.env"
  printf '%s\n' "$VLESS_CLIENTS_JSON" >>"$EDGE_DIR/.env"
fi

cd "$EDGE_DIR"
if [ "${SKIP_DOCKER_COMPOSE:-}" = "1" ]; then
  echo "edge env ready at $EDGE_DIR (docker skipped)"
  exit 0
fi
run_compose() {
  bash -c 'exec "$1" "${@:2}"' _ "$COMPOSE_BIN" "$@"
}
run_compose -f docker-compose.edge.yml build --pull
run_compose -f docker-compose.edge.yml up -d --force-recreate

echo "EU relay edge listening on :${EDGE_PORT}"
run_compose -f docker-compose.edge.yml ps
