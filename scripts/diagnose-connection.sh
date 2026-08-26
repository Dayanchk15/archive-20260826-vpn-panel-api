#!/bin/bash
# Диагностика timeout: образ edge, UUID в env, WebSocket, активные клиенты.
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-project-b5d55fc6-713d-4201-a8d}"
SERVERS_JSON="${SERVERS_JSON:-scripts/servers.production.json}"
SERVICE="${1:-uk2}"

REGION="$(jq -r --arg s "$SERVICE" '.servers[] | select(.service==$s) | .region' "$SERVERS_JSON")"
HOST="$(jq -r --arg s "$SERVICE" '.servers[] | select(.service==$s) | .host' "$SERVERS_JSON")"

if [ -z "$REGION" ] || [ "$REGION" = "null" ]; then
  echo "Service $SERVICE not found in $SERVERS_JSON"
  exit 1
fi

echo "=== 1. Cloud Run image ($SERVICE / $REGION) ==="
IMAGE="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(spec.template.spec.containers[0].image)')"
echo "$IMAGE"
if echo "$IMAGE" | grep -q 'xray-finalmask'; then
  echo "PROBLEM: edge uses xray-finalmask. It may ignore VLESS_CLIENTS_JSON."
  echo "FIX: bash scripts/deploy-vpn-edge-all.sh"
fi

echo ""
echo "=== 2. VLESS_CLIENTS_JSON on $SERVICE ==="
ENV_JSON="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="VLESS_CLIENTS_JSON") | .value' || true)"
if [ -z "$ENV_JSON" ]; then
  echo "PROBLEM: VLESS_CLIENTS_JSON is empty. Run sync-edge in panel."
else
  echo "$ENV_JSON" | jq .
  UUID_COUNT="$(echo "$ENV_JSON" | jq 'length')"
  echo "UUID count: $UUID_COUNT"
fi

echo ""
echo "=== 3. WebSocket test ($HOST) ==="
HTTP_CODE="$(curl -sk -o /tmp/ws-test.out -w '%{http_code}' --http1.1 "https://$HOST/" \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" || true)"
head -n 3 /tmp/ws-test.out || true
echo "HTTP code: $HTTP_CODE"
if [ "$HTTP_CODE" = "101" ]; then
  echo "OK: WebSocket upgrade works"
else
  echo "PROBLEM: expected 101 Switching Protocols"
  if grep -q 'Client sent an HTTP request to an HTTPS server' /tmp/ws-test.out 2>/dev/null; then
    echo "CAUSE: Xray inbound still has TLS. Cloud Run sends plain HTTP to container."
    echo "FIX: cd ~/vpn-panel-api && bash scripts/deploy-vpn-edge-all.sh"
  fi
fi

echo ""
echo "=== 4. Firestore registry ==="
gcloud firestore documents describe "settings/vpnEdgeRegistry" --project="$PROJECT_ID" 2>/dev/null | jq '.fields.clients.arrayValue.values | length' || echo "Registry not readable from CLI"

echo ""
echo "=== 5. Recent logs ($SERVICE) ==="
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE" \
  --project="$PROJECT_ID" --limit=8 --format='value(textPayload)' 2>/dev/null | sed '/^$/d' || true

echo ""
echo "=== Checklist ==="
echo "1) Edge image must be vpn-edge (not xray-finalmask without patch)"
echo "2) VLESS_CLIENTS_JSON must contain your user UUID"
echo "3) If links use Google IP + host=run.app -> enable FinalMask in client"
echo "4) For test without FinalMask: panel -> IP ключей -> mode direct -> resave IPs"
