#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%d_%H%M%S)"
output="${BACKUP_DIR}/db_${timestamp}.sql.gz"
docker compose -f "${ROOT_DIR}/docker-compose.yml" exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$output"
find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime +7 -delete
printf 'Backup saved to %s\n' "$output"
