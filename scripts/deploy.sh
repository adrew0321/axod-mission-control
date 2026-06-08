#!/usr/bin/env bash
# Update Mission Control on the VPS: pull, install, build, migrate, restart.
# Run as the `mc` user from /srv/mission-control. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Pulling latest main…"
git pull --ff-only origin main

echo "→ Installing dependencies…"
pnpm install --frozen-lockfile

echo "→ Building…"
pnpm build

echo "→ Running migrations…"
set -a; . ./.env; set +a
pnpm db:migrate

echo "→ Restarting service…"
sudo systemctl restart mission-control

echo "✓ Deployed. Tail logs: journalctl -u mission-control -f"
