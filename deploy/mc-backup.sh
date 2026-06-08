#!/usr/bin/env bash
# Nightly SQLite backup for Mission Control. Keeps the last 7 snapshots.
set -euo pipefail

DB="${DATABASE_PATH:-/srv/mission-control/data/mission-control.db}"
DEST="/srv/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

# .backup is a consistent online snapshot (safe while the app runs, WAL mode).
sqlite3 "$DB" ".backup '$DEST/mc-$STAMP.db'"

# Prune all but the 7 most recent.
ls -1t "$DEST"/mc-*.db | tail -n +8 | xargs -r rm -f
