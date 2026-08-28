#!/usr/bin/env bash
# Резервная копия базы. Ставится в cron на хосте:
#
#   0 4 * * * /opt/md-note/scripts/backup.sh >> /var/log/md-note-backup.log 2>&1
#
# Восстановление:
#   gunzip -c md-note-2026-08-25.sql.gz | \
#     docker compose -f docker-compose.prod.yml exec -T postgres psql -U mdnote -d mdnote

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$PROJECT_DIR"
mkdir -p "$BACKUP_DIR"

# shellcheck disable=SC1091
source .env.production

STAMP="$(date +%F-%H%M)"
TARGET="$BACKUP_DIR/md-note-$STAMP.sql.gz"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip > "$TARGET"

echo "$(date -Is) готово: $TARGET ($(du -h "$TARGET" | cut -f1))"

# Копии старше KEEP_DAYS дней удаляем.
find "$BACKUP_DIR" -name 'md-note-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
