#!/bin/bash
set -euo pipefail
ENV_FILE="/opt/vpn-panel-api-vps/.env.vps"
if grep -q '^EDGE_REPORT_KEY=' "$ENV_FILE" 2>/dev/null; then
  echo EDGE_KEY_EXISTS
  exit 0
fi
KEY="$(docker run --rm node:22-slim node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
echo "EDGE_REPORT_KEY=$KEY" >> "$ENV_FILE"
echo ADDED_EDGE_KEY
