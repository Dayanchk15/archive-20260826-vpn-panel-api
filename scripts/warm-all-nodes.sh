#!/bin/bash
set -euo pipefail
HOSTS=(
  poland1-6tum7ycmhq-ey.a.run.app
  poland2-6tum7ycmhq-ez.a.run.app
  germany1-6tum7ycmhq-ey.a.run.app
  germany2-6tum7ycmhq-ey.a.run.app
  neth1-6tum7ycmhq-ez.a.run.app
  neth2-6tum7ycmhq-ez.a.run.app
  turkey1-6tum7ycmhq-ey.a.run.app
  germany3-6tum7ycmhq-ey.a.run.app
  germany4-6tum7ycmhq-ey.a.run.app
  germany5-6tum7ycmhq-ey.a.run.app
  germany6-6tum7ycmhq-ey.a.run.app
  germany7-6tum7ycmhq-ey.a.run.app
  france1-6tum7ycmhq-ez.a.run.app
  france2-6tum7ycmhq-ez.a.run.app
  neth3-6tum7ycmhq-ez.a.run.app
  neth4-6tum7ycmhq-ez.a.run.app
)
for h in "${HOSTS[@]}"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' \
    "https://${h}/" || echo ERR)
  echo "$h -> $code"
done
