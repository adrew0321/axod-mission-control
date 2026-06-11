#!/usr/bin/env bash
# Auto-retry launcher for the Oracle Always-Free A1 instance.
#
# Loops over your availability domains, retrying `oci compute instance launch`
# until Oracle grants capacity (the classic "Out of host capacity" wall), then
# exits and prints the new instance's public IP. Distinguishes capacity errors
# (keep retrying) from config errors (stop immediately) so a typo can't spin
# forever.
#
# Prereqs: OCI CLI installed + configured (~/.oci/config) and a VCN/subnet that
# already exists. Full setup: docs/runbook-oracle-autolaunch.md.
#
# Configure via environment variables (see the runbook for how to find each OCID):
#   COMPARTMENT_OCID  (required)  root tenancy OCID works on free tier
#   SUBNET_OCID       (required)  a public subnet in your VCN
#   SSH_PUB_PATH      default: ~/.ssh/id_ed25519.pub
#   DISPLAY_NAME      default: mc-bridge
#   OCPUS / MEM_GB    default: 2 / 12   (Always-Free A1 ceiling is 4 / 24)
#   RETRY_SECONDS     default: 60       wait between full AD cycles
#   MAX_ATTEMPTS      default: 0        0 = retry forever
#   IMAGE_OCID        optional, auto-discovered (Ubuntu 24.04 arm64) if unset
#   ADS               optional, space-separated AD names; auto-discovered if unset
set -uo pipefail

COMPARTMENT_OCID="${COMPARTMENT_OCID:-}"
SUBNET_OCID="${SUBNET_OCID:-}"
SSH_PUB_PATH="${SSH_PUB_PATH:-$HOME/.ssh/id_ed25519.pub}"
DISPLAY_NAME="${DISPLAY_NAME:-mc-bridge}"
OCPUS="${OCPUS:-2}"
MEM_GB="${MEM_GB:-12}"
SHAPE="VM.Standard.A1.Flex"
RETRY_SECONDS="${RETRY_SECONDS:-60}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-0}"
IMAGE_OCID="${IMAGE_OCID:-}"
ADS="${ADS:-}"

OUT=/tmp/oci-launch.out
ERR=/tmp/oci-launch.err

die() { echo "ERROR: $*" >&2; exit 1; }

command -v oci >/dev/null || die "oci CLI not found — install it (see docs/runbook-oracle-autolaunch.md)."
[ -n "$COMPARTMENT_OCID" ] || die "COMPARTMENT_OCID not set."
[ -n "$SUBNET_OCID" ]     || die "SUBNET_OCID not set."
[ -f "$SSH_PUB_PATH" ]    || die "SSH public key not found at $SSH_PUB_PATH."
SSH_PUB="$(cat "$SSH_PUB_PATH")"

# Auto-discover availability domains if not supplied.
if [ -z "$ADS" ]; then
  echo "Discovering availability domains..."
  ADS="$(oci iam availability-domain list --compartment-id "$COMPARTMENT_OCID" \
         --query 'data[].name' --raw-output 2>"$ERR" | tr -d '[],"' | tr '\n' ' ')"
  [ -n "${ADS// /}" ] || { cat "$ERR" >&2; die "could not list availability domains."; }
fi
echo "Availability domains:$ADS"

# Auto-discover the latest Ubuntu 24.04 arm64 image for this shape if not supplied.
if [ -z "$IMAGE_OCID" ]; then
  echo "Finding Ubuntu 24.04 (arm64) image..."
  IMAGE_OCID="$(oci compute image list --compartment-id "$COMPARTMENT_OCID" \
    --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC \
    --query 'data[0].id' --raw-output 2>"$ERR")"
  [ -n "$IMAGE_OCID" ] && [ "$IMAGE_OCID" != "null" ] || { cat "$ERR" >&2; die "no Ubuntu 24.04 arm64 image found."; }
fi
echo "Image: $IMAGE_OCID"

SHAPE_CONFIG="{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEM_GB}"
METADATA="{\"ssh_authorized_keys\": \"$SSH_PUB\"}"

echo "Launching $SHAPE ($OCPUS OCPU / ${MEM_GB}GB) named '$DISPLAY_NAME'. Ctrl-C to stop."
attempt=0
while :; do
  for AD in $ADS; do
    attempt=$((attempt + 1))
    echo "[$(date +%H:%M:%S)] attempt $attempt — trying $AD ..."
    if IID="$(oci compute instance launch \
        --availability-domain "$AD" \
        --compartment-id "$COMPARTMENT_OCID" \
        --shape "$SHAPE" \
        --shape-config "$SHAPE_CONFIG" \
        --image-id "$IMAGE_OCID" \
        --subnet-id "$SUBNET_OCID" \
        --assign-public-ip true \
        --display-name "$DISPLAY_NAME" \
        --metadata "$METADATA" \
        --wait-for-state RUNNING \
        --query 'data.id' --raw-output 2>"$ERR" >"$OUT" && cat "$OUT")"; then
      IP="$(oci compute instance list-vnics --instance-id "$IID" \
            --query 'data[0]."public-ip"' --raw-output 2>/dev/null || true)"
      echo ""
      echo "SUCCESS — instance is RUNNING in $AD."
      echo "  instance OCID: $IID"
      echo "  public IP:     ${IP:-<could not fetch; run: oci compute instance list-vnics --instance-id $IID>}"
      exit 0
    fi
    if grep -qiE 'out of host capacity|out of capacity|internalerror|"status": 500' "$ERR"; then
      echo "   …no capacity in $AD."
    else
      echo "   launch failed for a NON-capacity reason:" >&2
      sed 's/^/   /' "$ERR" >&2
      die "stopping — this is a config/auth error, not capacity. Fix it and re-run."
    fi
    if [ "$MAX_ATTEMPTS" -gt 0 ] && [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      die "hit MAX_ATTEMPTS=$MAX_ATTEMPTS without capacity."
    fi
  done
  echo "   cycled all ADs; sleeping ${RETRY_SECONDS}s..."
  sleep "$RETRY_SECONDS"
done
