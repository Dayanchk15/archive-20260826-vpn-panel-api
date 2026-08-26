#!/bin/bash
# Create global HTTPS LB -> Internet NEG -> VPS:8080 (pilot only).
# Run from machine with gcloud auth. Fill variables below first.
set -euo pipefail

: "${GCP_PROJECT:?set GCP_PROJECT}"
: "${GLB_SUBDOMAIN:?set GLB_SUBDOMAIN e.g. edge.example.com}"
: "${VPS_ORIGIN_IP:?set VPS_ORIGIN_IP}"
: "${NEG_NAME:=glb-vps-pilot-neg}"
: "${BACKEND_NAME:=glb-vps-pilot-backend}"
: "${URL_MAP_NAME:=glb-vps-pilot-map}"
: "${PROXY_NAME:=glb-vps-pilot-proxy}"
: "${RULE_NAME:=glb-vps-pilot-rule}"
: "${CERT_NAME:=glb-vps-pilot-cert}"
: "${ORIGIN_PORT:=8080}"

gcloud config set project "$GCP_PROJECT"

echo "==> Reserve global IP"
gcloud compute addresses create "${RULE_NAME}-ip" --global --ip-version=IPV4 2>/dev/null || true
GLB_IP="$(gcloud compute addresses describe "${RULE_NAME}-ip" --global --format='get(address)')"
echo "GLB IP: $GLB_IP"

echo "==> Internet NEG -> ${VPS_ORIGIN_IP}:${ORIGIN_PORT}"
gcloud compute network-endpoint-groups create "$NEG_NAME" \
  --global \
  --network-endpoint-type=internet-ip-port \
  --default-port="$ORIGIN_PORT" 2>/dev/null || true
gcloud compute network-endpoint-groups update "$NEG_NAME" \
  --global \
  --add-endpoint="ip=${VPS_ORIGIN_IP},port=${ORIGIN_PORT}" 2>/dev/null || true

echo "==> Backend service (WebSocket-friendly timeout)"
gcloud compute backend-services create "$BACKEND_NAME" \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED \
  --protocol=HTTP \
  --port-name=http \
  --timeout=3600s 2>/dev/null || true
gcloud compute backend-services add-backend "$BACKEND_NAME" \
  --global \
  --network-endpoint-group="$NEG_NAME" \
  --global-network-endpoint-group 2>/dev/null || true

echo "==> URL map + HTTPS proxy"
gcloud compute url-maps create "$URL_MAP_NAME" \
  --default-service="$BACKEND_NAME" 2>/dev/null || true
gcloud compute ssl-certificates create "$CERT_NAME" \
  --domains="$GLB_SUBDOMAIN" \
  --global 2>/dev/null || true
gcloud compute target-https-proxies create "$PROXY_NAME" \
  --url-map="$URL_MAP_NAME" \
  --ssl-certificates="$CERT_NAME" 2>/dev/null || true
gcloud compute forwarding-rules create "$RULE_NAME" \
  --global \
  --target-https-proxy="$PROXY_NAME" \
  --address="${RULE_NAME}-ip" \
  --ports=443 2>/dev/null || true

cat <<EOF

Done (or resources already existed).

Next:
  1. DNS A record: ${GLB_SUBDOMAIN} -> ${GLB_IP}
  2. Wait for managed cert (15-60 min): gcloud compute ssl-certificates describe ${CERT_NAME} --global
  3. On VPS: install edge (install-on-vps.sh)
  4. Panel: node scripts/setup-glb-vps-pilot.mjs

GLB_IP=${GLB_IP}
GLB_HOST=${GLB_SUBDOMAIN}
EOF
