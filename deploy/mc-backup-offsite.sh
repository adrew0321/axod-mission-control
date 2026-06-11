#!/usr/bin/env bash
# Offsite backup: upload the newest local Mission Control snapshot to Oracle
# Object Storage via a Pre-Authenticated Request (PAR) URL. Runs after the
# local mc-backup job. No-op (clean exit) if no PAR is configured.
set -euo pipefail

DEST="/srv/backups"
PAR="${OBJECT_STORAGE_PAR_URL:-}"

if [ -z "$PAR" ]; then
  echo "OBJECT_STORAGE_PAR_URL unset — skipping offsite upload (local snapshots kept)."
  exit 0
fi

# Newest snapshot produced by deploy/mc-backup.sh.
LATEST="$(ls -1t "$DEST"/mc-*.db 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST" ]; then
  echo "no snapshot found in $DEST — nothing to upload." >&2
  exit 1
fi

OBJ="$(basename "$LATEST")"
# PAR ends with '/'; appending the object name names the uploaded object.
# -f makes curl exit non-zero on HTTP errors so systemd records a failure.
curl -fsS -T "$LATEST" "${PAR}${OBJ}"
echo "uploaded $OBJ to Object Storage."
