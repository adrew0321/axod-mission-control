#!/usr/bin/env bash
# Update Mission Control on the VPS: pull, install, build, migrate, restart.
# Run as the `mc` user from /srv/mission-control. Idempotent.
set -euo pipefail
# pnpm refuses to purge node_modules without a TTY unless CI=true. Without this the
# deploy aborts mid-install asking a question nobody can answer over SSH.
export CI=true
cd "$(dirname "$0")/.."

echo "→ Pulling latest main…"
git pull --ff-only origin main

echo "→ Installing dependencies…"
pnpm install --frozen-lockfile
# Native addons need an explicit rebuild — .npmrc sets ignore-scripts=true, so
# install never compiles them. Skipping this leaves better-sqlite3 without a
# binding and the server dies on first query.
pnpm rebuild better-sqlite3 sharp unrs-resolver

echo "→ Building…"
pnpm build

echo "→ Running migrations…"
set -a; . ./.env; set +a
pnpm db:migrate

echo "→ Restarting service…"
sudo systemctl restart mission-control

echo "✓ Deployed. Tail logs: journalctl -u mission-control -f"
