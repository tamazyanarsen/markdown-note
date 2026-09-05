#!/usr/bin/env bash
# Резервная копия. Ставится в cron на хосте:
#
#   0 4 * * * /opt/md-note/scripts/backup.sh >> /var/log/md-note-backup.log 2>&1
#
# Копий две, и нужны обе: база и вложения заметок. В базе лежат только
# метаданные файлов, сами байты — в томе uploads-data, и дамп до них не
# достаёт. Дамп без вложений восстановит заметки со сломанными картинками.
#
# Восстановление базы:
#   gunzip -c md-note-2026-08-25.sql.gz | \
#     docker compose -f docker-compose.prod.yml exec -T postgres psql -U mdnote -d mdnote
#
# Восстановление вложений:
#   docker compose -f docker-compose.prod.yml exec -T app \
#     tar -xz -C /app/uploads < md-note-uploads-2026-08-25.tar.gz

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
UPLOADS_TARGET="$BACKUP_DIR/md-note-uploads-$STAMP.tar.gz"

docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip > "$TARGET"

echo "$(date -Is) готово: $TARGET ($(du -h "$TARGET" | cut -f1))"

# Вложения архивируются из контейнера приложения: том смонтирован туда,
# а на хосте его путь зависит от драйвера тома и вычислять его незачем.
docker compose -f docker-compose.prod.yml exec -T app \
  tar -cz -C /app/uploads . > "$UPLOADS_TARGET"

echo "$(date -Is) готово: $UPLOADS_TARGET ($(du -h "$UPLOADS_TARGET" | cut -f1))"

# Копии старше KEEP_DAYS дней удаляем.
find "$BACKUP_DIR" -name 'md-note-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'md-note-uploads-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
