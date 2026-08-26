#!/bin/bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/vpn-panel/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CONTAINER="${POSTGRES_CONTAINER:-vpn-panel-postgres}"
DB_USER="${POSTGRES_USER:-vpn_panel}"
DB_NAME="${POSTGRES_DB:-vpn_panel}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/${DB_NAME}_${STAMP}.sql.gz"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip -9 > "$OUT"
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$RETENTION_DAYS" -delete

echo "Backup saved: $OUT ($(du -h "$OUT" | awk '{print $1}'))"
