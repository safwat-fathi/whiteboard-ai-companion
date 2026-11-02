#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/whiteboard}"
BACKUP_DIR="${DATA_DIR}/backups"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET_DB="${BACKUP_DIR}/whiteboard-${TIMESTAMP}.db"
KEEP_DAYS=14

mkdir -p "${BACKUP_DIR}"

# 1. Online copy of SQLite database using VACUUM INTO
DB_PATH="${DATA_DIR}/whiteboard.db"
if [[ -f "${DB_PATH}" ]]; then
  sqlite3 "${DB_PATH}" "VACUUM INTO '${TARGET_DB}'"
  echo "Database backed up to ${TARGET_DB}"
else
  echo "Warning: Database file ${DB_PATH} not found, skipping VACUUM INTO" >&2
fi

# 2. Prune local DB backups older than KEEP_DAYS
find "${BACKUP_DIR}" -name "whiteboard-*.db" -type f -mtime +"${KEEP_DAYS}" -delete

# 3. Optional off-box sync with rclone if RCLONE_REMOTE is set
if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  echo "Syncing backups and blobs to ${RCLONE_REMOTE}..."
  rclone sync "${BACKUP_DIR}" "${RCLONE_REMOTE}/backups"
  if [[ -d "${DATA_DIR}/blobs" ]]; then
    rclone sync "${DATA_DIR}/blobs" "${RCLONE_REMOTE}/blobs"
  fi
  echo "Remote sync complete."
fi
