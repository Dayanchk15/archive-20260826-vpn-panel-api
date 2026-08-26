#!/bin/bash
# Phase 2 at 00:00 Asia/Ashgabat — remove users from legacy servers.
set -euo pipefail
export TZ=Asia/Ashgabat

echo "[phase2 $(date -Iseconds) Ashgabat] start"
docker exec vpn-panel-api-vps node scripts/migrate-remove-legacy-phase2.mjs
echo "[phase2 $(date -Iseconds) Ashgabat] exit=$?"
