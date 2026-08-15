#!/usr/bin/env bash
# Offsite backup: upload the newest local Mission Control snapshot to Cloudflare R2.
#
# Uses curl's built-in AWS SigV4 signing (curl >= 7.75; the Mini has 8.5.0), so there
# is no rclone, no aws CLI, and nothing new to install or keep patched.
#
# Runs after deploy/mc-backup.sh. Clean no-op when unconfigured, so it is safe to
# install before the credentials exist.
#
# Requires in /srv/mission-control/.env:
#   R2_ACCOUNT_ID          Cloudflare account id (the R2 endpoint subdomain)
#   R2_BUCKET              bucket name, e.g. mc-backups
#   R2_ACCESS_KEY_ID       R2 API token, "Object Read & Write", scoped to that bucket
#   R2_SECRET_ACCESS_KEY
#
# Retention: handled by an R2 lifecycle rule on the bucket, not here. Pruning from a
# backup script means giving it DELETE, and a backup job that can delete backups is
# how you lose backups.
set -euo pipefail

DEST="/srv/backups"
ACCOUNT="${R2_ACCOUNT_ID:-}"
BUCKET="${R2_BUCKET:-}"
KEY="${R2_ACCESS_KEY_ID:-}"
SECRET="${R2_SECRET_ACCESS_KEY:-}"

if [ -z "$ACCOUNT" ] || [ -z "$BUCKET" ] || [ -z "$KEY" ] || [ -z "$SECRET" ]; then
  echo "R2 not configured — need R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID," \
       "R2_SECRET_ACCESS_KEY in .env. Skipping offsite upload; local snapshots kept."
  exit 0
fi

LATEST="$(ls -1t "$DEST"/mc-*.db 2>/dev/null | head -n1 || true)"
if [ -z "$LATEST" ]; then
  echo "no snapshot found in $DEST — nothing to upload." >&2
  exit 1
fi

OBJ="$(basename "$LATEST")"
URL="https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}/${OBJ}"
LOCAL_BYTES="$(stat -c%s "$LATEST")"

echo "uploading ${OBJ} (${LOCAL_BYTES} bytes) → r2://${BUCKET}/"

# UNSIGNED-PAYLOAD: curl streams the body with -T and cannot hash it up front to
# include in the signature. R2 accepts this over HTTPS, which is what protects the
# bytes in transit.
curl -fsS --retry 3 --retry-delay 5 --max-time 300 \
  --aws-sigv4 "aws:amz:auto:s3" \
  --user "${KEY}:${SECRET}" \
  -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
  -T "$LATEST" "$URL"

# Verify instead of trusting the PUT. A backup you have not read back is a rumour.
REMOTE_BYTES="$(curl -fsS -I --max-time 60 \
  --aws-sigv4 "aws:amz:auto:s3" \
  --user "${KEY}:${SECRET}" \
  -H "x-amz-content-sha256: UNSIGNED-PAYLOAD" \
  "$URL" | awk 'tolower($1) == "content-length:" { print $2 }' | tr -d '\r')"

if [ "${REMOTE_BYTES:-}" != "$LOCAL_BYTES" ]; then
  echo "VERIFY FAILED for ${OBJ}: remote='${REMOTE_BYTES:-<absent>}' local='${LOCAL_BYTES}'" >&2
  exit 1
fi

echo "uploaded and verified ${OBJ} (${LOCAL_BYTES} bytes)"
