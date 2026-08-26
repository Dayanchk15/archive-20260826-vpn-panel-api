#!/bin/bash
set -euo pipefail

echo "HOST=$(hostname)"
echo SERVICES
systemctl --no-pager --plain list-units --type=service --state=running | grep xray || true
echo SUMMARY
find /opt -maxdepth 2 -name config.json -print0 | sort -z | while IFS= read -r -d '' file; do
  jq -r '[input_filename, (.inbounds[0].port // 0), (.inbounds[0].streamSettings.network // "-"), (.inbounds[0].streamSettings.wsSettings.path // "-"), ((.inbounds[0].settings.clients // []) | length)] | @tsv' "$file" 2>/dev/null || true
done
echo CADDY
cat /etc/caddy/Caddyfile 2>/dev/null || true
find /etc/caddy/conf.d -maxdepth 1 -type f -name '*.caddy' -print0 2>/dev/null | while IFS= read -r -d '' file; do
  echo "FILE=$file"
  cat "$file"
done
