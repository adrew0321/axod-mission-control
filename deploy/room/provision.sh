#!/usr/bin/env bash
# Provision AKIRA's room on the Mini. Idempotent — safe to re-run.
#
# Run as the OPERATOR (not root, not mc). Requires membership of the `lxd` group.
# Verified end-to-end 2026-08-14: this needs NO root at all. `lxd init` would, but
# creating the storage pool and bridge with the `lxc` client over the trusted socket
# achieves the same thing as an lxd-group member.
set -euo pipefail

CONTAINER=akira-room
DOORWAY="$HOME/AKIRA"
POOL=default
BRIDGE=lxdbr0
LIVE_ENV=/srv/mission-control/.env

command -v lxc >/dev/null || { echo "lxc not found — install LXD first"; exit 1; }
[ -d "$DOORWAY/inbox" ] || { echo "missing $DOORWAY/inbox — finish slice 0 first (docs/runbook-mini-desktop.md)"; exit 1; }
id -nG | tr ' ' '\n' | grep -qx lxd || { echo "you are not in the 'lxd' group"; exit 1; }

# --- LXD init, without root -------------------------------------------------
lxc storage show "$POOL"  >/dev/null 2>&1 || lxc storage create "$POOL" dir
lxc network show "$BRIDGE" >/dev/null 2>&1 || lxc network create "$BRIDGE"
lxc profile device get default root path >/dev/null 2>&1 \
  || lxc profile device add default root disk path=/ pool="$POOL"
lxc profile device get default eth0 nic  >/dev/null 2>&1 \
  || lxc profile device add default eth0 nic network="$BRIDGE" name=eth0

GW=$(lxc network get "$BRIDGE" ipv4.address | cut -d/ -f1)
[ -n "$GW" ] || { echo "could not determine the $BRIDGE gateway"; exit 1; }
echo "bridge gateway: $GW  (this is what the room uses to reach Mission Control)"

# --- container --------------------------------------------------------------
if ! lxc info "$CONTAINER" >/dev/null 2>&1; then
  lxc launch ubuntu:24.04 "$CONTAINER"
  for _ in $(seq 1 40); do
    [ "$(lxc info "$CONTAINER" | awk '/^Status:/{print $2}')" = "RUNNING" ] && break
    sleep 3
  done
fi

# Map container root -> the host operator, so files she writes in the doorway are
# owned by you and open normally in LibreOffice. Verified working without any
# /etc/subuid edit on this host.
printf 'uid %s 0\ngid %s 0\n' "$(id -u)" "$(id -g)" | lxc config set "$CONTAINER" raw.idmap -

lxc config device remove "$CONTAINER" doorway >/dev/null 2>&1 || true
lxc config device add "$CONTAINER" doorway disk source="$DOORWAY" path=/mnt/doorway
lxc restart "$CONTAINER"
sleep 6

# --- runtime ----------------------------------------------------------------
lxc exec "$CONTAINER" -- bash -lc '
  set -e
  id akira &>/dev/null || useradd -m -s /bin/bash akira
  mkdir -p /home/akira/workshop && chown -R akira:akira /home/akira
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates >/dev/null
  command -v node >/dev/null || {
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null
  }
  command -v tsx >/dev/null || npm install -g pnpm tsx >/dev/null 2>&1
'

# --- agent ------------------------------------------------------------------
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
lxc file push -rq "$REPO_ROOT/room-agent" "$CONTAINER"/home/akira/
lxc exec "$CONTAINER" -- bash -lc 'cd /home/akira/room-agent && pnpm install --silent'

# The room gets its OWN credential, never the laptop Companion's (Decision 5): the
# room holds this on disk and a shell in the room can read it. Mission Control fails
# closed when the two are equal, so refuse here rather than provision a room that can
# never connect. Read from the live .env (mc-owned; passwordless via the sudo
# allowlist) and pipe it in over stdin so it never lands in a process argument list.
TOKEN=$(sudo -n -u mc grep -m1 '^ROOM_COMPANION_TOKEN=' "$LIVE_ENV" | cut -d= -f2- | tr -d '\r"' || true)
LAPTOP_TOKEN=$(sudo -n -u mc grep -m1 '^COMPANION_TOKEN=' "$LIVE_ENV" | cut -d= -f2- | tr -d '\r"' || true)
[ -n "$TOKEN" ] || { echo "ROOM_COMPANION_TOKEN not set in $LIVE_ENV — mint one with: openssl rand -hex 32"; exit 1; }
[ "$TOKEN" != "$LAPTOP_TOKEN" ] || { echo "ROOM_COMPANION_TOKEN must differ from COMPANION_TOKEN — Mission Control rejects the room when they match"; exit 1; }
printf 'ROOM_TOKEN=%s\nMINI_URL=http://%s:3000\nROOM_ROOT=/home/akira/workshop\nROOM_DOORWAY=/mnt/doorway\n' \
  "$TOKEN" "$GW" | lxc exec "$CONTAINER" -- tee /home/akira/room-agent/.env > /dev/null
lxc exec "$CONTAINER" -- bash -c 'chmod 600 /home/akira/room-agent/.env; chown -R akira:akira /home/akira/room-agent'

# --- service ----------------------------------------------------------------
TSX=$(lxc exec "$CONTAINER" -- bash -lc 'command -v tsx')
sed "s|__TSX__|$TSX|" "$(dirname "$0")/akira-room.service" \
  | lxc exec "$CONTAINER" -- tee /etc/systemd/system/akira-room.service > /dev/null
lxc exec "$CONTAINER" -- bash -c 'systemctl daemon-reload && systemctl enable --now akira-room'

# --- workshop remote ---------------------------------------------------------
# Decision 6: her work survives a container rebuild via a bare repo on the
# Mini — outside the container, reachable over the bridge — not a public
# host. Durability without a public push channel; commits and pushes to it
# are both ungated (Decision 6).
WORKSHOP_REMOTE="$HOME/akira-workshop.git"
if [ ! -d "$WORKSHOP_REMOTE" ]; then
  git init --bare "$WORKSHOP_REMOTE"
  echo "created workshop remote at $WORKSHOP_REMOTE"
fi

lxc config device remove "$CONTAINER" workshop-remote >/dev/null 2>&1 || true
lxc config device add "$CONTAINER" workshop-remote disk source="$WORKSHOP_REMOTE" path=/mnt/workshop-remote

lxc exec "$CONTAINER" -- sudo -u akira bash -lc '
  cd /home/akira/workshop
  git rev-parse --git-dir >/dev/null 2>&1 || git init
  git remote get-url origin >/dev/null 2>&1 || git remote add origin /mnt/workshop-remote
  git config user.email "akira@axodcreative.com"
  git config user.name "AKIRA"
'

sleep 8
echo
echo "=== agent log ==="
lxc exec "$CONTAINER" -- journalctl -u akira-room -n 5 --no-pager
echo
echo "Look for: [room] connected to http://$GW:3000"
echo "Then verify the boundary holds:"
echo "  lxc exec $CONTAINER -- ls /srv     # must be empty"
echo "  lxc exec $CONTAINER -- ls /home    # must NOT contain $USER"
