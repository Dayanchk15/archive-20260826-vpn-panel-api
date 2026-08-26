#!/bin/bash
# Deploy vpn-panel-api to VPS (run from project root on dev machine or CI).
set -euo pipefail

VPS_HOST="${VPS_HOST:-root@45.140.42.39}"
REMOTE_DIR="${REMOTE_DIR:-/opt/vpn-panel-api-vps}"
LOCAL_DIR="${LOCAL_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"

echo "==> Deploy $LOCAL_DIR -> $VPS_HOST:$REMOTE_DIR"

ssh "$VPS_HOST" "mkdir -p $REMOTE_DIR/{lib,routes,middleware,public,scripts}"

# Remove retired Google Cloud/Cloud Run artifacts from the deployment target.
# This is limited to known GCP filenames/directories and does not touch VPS
# services, PostgreSQL data, or subscription files.
ssh "$VPS_HOST" "rm -rf $REMOTE_DIR/cloud-run-deployer $REMOTE_DIR/vpn-edge $REMOTE_DIR/subscription-relay-cloudrun $REMOTE_DIR/lib-patch $REMOTE_DIR/tmp-deploy; rm -f $REMOTE_DIR/lib/*gcp* $REMOTE_DIR/lib/*cloud-run* $REMOTE_DIR/lib/google-drive-subscription.js $REMOTE_DIR/lib/firestore.js $REMOTE_DIR/vpn-edge/generate-xray-config.js $REMOTE_DIR/public/cloud-run-*.js $REMOTE_DIR/public/gcp-*.js $REMOTE_DIR/public/test-gcp-*.sh $REMOTE_DIR/.env.vps.bak-google-drive-* $REMOTE_DIR/GOOGLE_CLOUD_COST_AUDIT.md $REMOTE_DIR/gcp-cost-metrics.js $REMOTE_DIR/delete-orphan-gcp-services.mjs $REMOTE_DIR/list-all-gcp-run-services.mjs $REMOTE_DIR/fix-cloudrun-429.mjs $REMOTE_DIR/lib/server-cloudrun.js $REMOTE_DIR/apply-scaling-preset.js; find $REMOTE_DIR/scripts -maxdepth 1 -type f \( -iname '*gcp*' -o -iname '*cloudrun*' -o -iname '*cloud-run*' -o -iname '*euphoric*' -o -iname '*soppy*' \) -delete"

scp -r \
  "$LOCAL_DIR/lib/"* \
  "$VPS_HOST:$REMOTE_DIR/lib/"

scp -r \
  "$LOCAL_DIR/routes/"* \
  "$VPS_HOST:$REMOTE_DIR/routes/"

scp \
  "$LOCAL_DIR/middleware/"* \
  "$VPS_HOST:$REMOTE_DIR/middleware/" 2>/dev/null || true

scp \
  "$LOCAL_DIR/public/admin.html" \
  "$LOCAL_DIR/public/login.html" \
  "$LOCAL_DIR/public/panel-i18n.js" \
  "$VPS_HOST:$REMOTE_DIR/public/"

scp \
  "$LOCAL_DIR/server.js" \
  "$LOCAL_DIR/package.json" \
  "$LOCAL_DIR/package-lock.json" \
  "$LOCAL_DIR/Dockerfile" \
  "$LOCAL_DIR/docker-compose.vps.yml" \
  "$VPS_HOST:$REMOTE_DIR/"

scp "$LOCAL_DIR/scripts/"*.sh "$VPS_HOST:$REMOTE_DIR/scripts/" 2>/dev/null || true
scp "$LOCAL_DIR/scripts/import-google-drive-secrets.mjs" "$LOCAL_DIR/scripts/refresh-all-subscriptions.mjs" "$VPS_HOST:$REMOTE_DIR/scripts/"
ssh "$VPS_HOST" "bash $REMOTE_DIR/scripts/ensure-edge-report-key.sh 2>/dev/null || true"

ssh "$VPS_HOST" "cd $REMOTE_DIR && docker compose --env-file .env.vps -f docker-compose.vps.yml up -d --build vpn-panel-api"

ssh "$VPS_HOST" "curl -fsS http://127.0.0.1:8081/health"
echo ""
echo "Deploy OK: https://sub.twidu.com"
