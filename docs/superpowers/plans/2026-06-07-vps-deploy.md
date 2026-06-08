# VPS Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the committed artifacts + an idempotent runbook to run Mission Control at `https://mc-dev.axodcreative.com` on the Hetzner box (host Node + Caddy + systemd; Claude Pro auth).

**Architecture:** No application code changes — this plan authors deployment files (`deploy/`, `scripts/`, `.env.example`), an operator runbook (`docs/runbook-deploy.md`), and an ADR addendum. The operator runs the runbook on the box; nothing here SSHes anywhere. The Next.js server runs under systemd behind Caddy (auto-HTTPS); agents authenticate via the operator's Claude Pro subscription through the `claude` CLI.

**Tech Stack:** Ubuntu 24.04, Node 22, pnpm, better-sqlite3 (native, prebuilt via `onlyBuiltDependencies`), `@anthropic-ai/claude-code` CLI, Caddy (Let's Encrypt), systemd, bash.

**Spec:** `docs/superpowers/specs/2026-06-07-vps-deploy-design.md`

**Note on "tests":** these are infra config artifacts. Local validation = `bash -n` for shell scripts (the dev box is Windows; `caddy validate` / `systemd-analyze verify` run on the server during the runbook, not here). Each task = author the exact file → local check where possible → commit.

---

## File Structure

- Create `.env.example` — required env template (real `.env` is gitignored).
- Create `deploy/Caddyfile` — reverse proxy + auto-HTTPS.
- Create `deploy/mission-control.service` — systemd unit for the app.
- Create `deploy/mc-backup.sh` + `deploy/mc-backup.service` + `deploy/mc-backup.timer` — nightly SQLite backup.
- Create `scripts/deploy.sh` — idempotent update script.
- Create `docs/decisions/adr-003-deploy-host-node.md` — ADR addendum.
- Create `docs/runbook-deploy.md` — operator step-by-step.
- Modify `README.md` — add a short "Deploying" pointer.

---

## Task 1: `.env.example`

**Files:** Create `.env.example`

- [ ] **Step 1: Write the file**

```bash
# Mission Control — production environment template.
# Copy to .env on the server and fill in. systemd loads it via EnvironmentFile.
# The real .env is gitignored — never commit it.

# REQUIRED: session-cookie signing key, >= 32 chars. Generate: openssl rand -hex 32
SESSION_SECRET=

# SQLite database file (absolute path in production).
DATABASE_PATH=/srv/mission-control/data/mission-control.db

# Where per-session git worktrees are created.
WORKTREE_ROOT=/srv/mission-control/data/worktrees

# Production mode → secure (HTTPS-only) session cookies.
NODE_ENV=production

# Port `next start` listens on (Caddy reverse-proxies to this).
PORT=3000

# Agent auth: PREFERRED is the Claude Pro subscription via `claude` CLI login on the
# box (no metered billing) — leave ANTHROPIC_API_KEY unset in that case.
# FALLBACK (metered, pay-per-token): set this only if the headless SDK refuses
# subscription auth.
# ANTHROPIC_API_KEY=
```

- [ ] **Step 2: Confirm it is NOT ignored**

Run: `git check-ignore .env.example || echo "trackable"`
Expected: prints `trackable` (only `.env` itself is ignored, not `.env.example`).

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat(deploy): .env.example for production"
```

---

## Task 2: `deploy/Caddyfile`

**Files:** Create `deploy/Caddyfile`

- [ ] **Step 1: Write the file** (Caddy syntax uses tabs for indentation)

```
# Caddy reverse proxy for Mission Control. Automatic HTTPS via Let's Encrypt —
# Caddy provisions + renews the cert once this name's DNS resolves to the box.
mc-dev.axodcreative.com {
	encode gzip
	reverse_proxy localhost:3000
}
```

- [ ] **Step 2: Commit** (validated on the box via `caddy validate` in the runbook)

```bash
git add deploy/Caddyfile
git commit -m "feat(deploy): Caddyfile (reverse proxy + auto-HTTPS)"
```

---

## Task 3: `deploy/mission-control.service`

**Files:** Create `deploy/mission-control.service`

Runs `next` directly via node (avoids pnpm/corepack PATH issues under systemd). The runbook
confirms `which node` is `/usr/bin/node` and adjusts if not.

- [ ] **Step 1: Write the file**

```ini
[Unit]
Description=AXOD Mission Control (Next.js server)
After=network.target

[Service]
Type=simple
User=mc
Group=mc
WorkingDirectory=/srv/mission-control
EnvironmentFile=/srv/mission-control/.env
# `next start` (equivalent to `pnpm start`). Confirm node path with `which node`.
ExecStart=/usr/bin/node /srv/mission-control/node_modules/next/dist/bin/next start
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add deploy/mission-control.service
git commit -m "feat(deploy): systemd unit for the app"
```

---

## Task 4: Nightly backup (script + service + timer)

**Files:** Create `deploy/mc-backup.sh`, `deploy/mc-backup.service`, `deploy/mc-backup.timer`

- [ ] **Step 1: Write `deploy/mc-backup.sh`**

```bash
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
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n deploy/mc-backup.sh`
Expected: no output (valid syntax).

- [ ] **Step 3: Write `deploy/mc-backup.service`**

```ini
[Unit]
Description=Mission Control nightly SQLite backup

[Service]
Type=oneshot
User=mc
Group=mc
EnvironmentFile=/srv/mission-control/.env
ExecStart=/srv/mission-control/deploy/mc-backup.sh
```

- [ ] **Step 4: Write `deploy/mc-backup.timer`**

```ini
[Unit]
Description=Run Mission Control backup nightly

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 5: Commit**

```bash
git add deploy/mc-backup.sh deploy/mc-backup.service deploy/mc-backup.timer
git commit -m "feat(deploy): nightly SQLite backup (script + timer)"
```

---

## Task 5: `scripts/deploy.sh`

**Files:** Create `scripts/deploy.sh`

- [ ] **Step 1: Write the file**

```bash
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
```

- [ ] **Step 2: Syntax-check**

Run: `bash -n scripts/deploy.sh`
Expected: no output (valid syntax).

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(deploy): idempotent update script"
```

---

## Task 6: ADR-003 (deploy addendum)

**Files:** Create `docs/decisions/adr-003-deploy-host-node.md`

- [ ] **Step 1: Write the file**

```markdown
## ADR-003: v1 deploys as host Node + Caddy + systemd (addendum to ADR-002)

> **Status:** Accepted
> **Date:** 2026-06-07
> **Deciders:** [@adrew0321](https://github.com/adrew0321) (operator)
> **Supersedes:** the "Docker Compose" / "Nginx" specifics in [ADR-002](adr-002-v1-platform-locks.md) #3 and #6, and the deployment-target table in the v1 spec.

### Context

ADR-002 and the v1 spec assumed Docker Compose + Nginx + certbot. The agent runtime built
in weeks 2–4 (after ADR-002) is heavily host-coupled: it spawns the `claude` CLI as a
subprocess, creates a git worktree per session, runs `pnpm build`/preview servers that bind
ports, writes SQLite on local disk, and operates on multiple project repos at host paths.
Containerizing all of that adds bind-mounts and in-container CLI/build plumbing for little
benefit at solo scale.

### Decision

Deploy v1 as the Next.js server running directly on the host (Hetzner CX22, Ubuntu 24.04)
under **systemd**, fronted by **Caddy** for automatic Let's Encrypt TLS. Agents authenticate
via the operator's **Claude Pro subscription** through the `claude` CLI (no metered API
billing), with `ANTHROPIC_API_KEY` as a metered fallback. Reverse proxy is Caddy (not Nginx)
for one-line auto-HTTPS.

### Consequences

- Simpler ops; no Docker layer. Recurring cost ≈ the VPS only (~$5–8/mo) when using Pro auth.
- Throughput is bounded by Claude Pro usage limits rather than a dollar amount.
- Revisit if: multi-node is needed, hard per-project isolation is needed, or we run multiple
  instances on one box.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/adr-003-deploy-host-node.md
git commit -m "docs(adr): ADR-003 host Node + Caddy deploy (supersedes ADR-002 Docker)"
```

---

## Task 7: The operator runbook

**Files:** Create `docs/runbook-deploy.md`

- [ ] **Step 1: Write the file**

````markdown
# Mission Control — VPS deploy runbook

**Target:** Ubuntu 24.04, Hetzner CX22. **Result:** `https://mc-dev.axodcreative.com`.
Run as **root** unless noted. **Idempotent** — every step checks before acting, safe to re-run.
Replace `<BOX_IP>` with the server's public IP.

## 0. Connect
```bash
ssh root@<BOX_IP>
```

## 1. System packages
```bash
apt update && apt -y upgrade
apt -y install curl git build-essential python3 ufw sqlite3 ca-certificates gnupg
```
(`build-essential` + `python3` are needed to build `better-sqlite3`, which this repo allows
to run install scripts via `onlyBuiltDependencies` despite `.npmrc`'s `ignore-scripts=true`.)

## 2. Node 22 + pnpm
```bash
node -v 2>/dev/null | grep -q '^v22' || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs; }
node -v          # expect v22.x
corepack enable && corepack prepare pnpm@latest --activate
pnpm -v
which node       # expect /usr/bin/node (matches the systemd unit; if different, edit ExecStart)
```

## 3. Claude Code CLI
```bash
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
claude --version
```

## 4. App user + directories
```bash
id mc >/dev/null 2>&1 || adduser --system --group --home /srv/mission-control mc
mkdir -p /srv/mission-control /srv/projects /srv/backups
chown -R mc:mc /srv/mission-control /srv/projects /srv/backups
```

## 5. Clone the repo (as mc)
```bash
if [ -d /srv/mission-control/.git ]; then
  sudo -u mc git -C /srv/mission-control pull --ff-only origin main
else
  sudo -u mc git clone https://github.com/adrew0321/axod-mission-control.git /srv/mission-control
fi
sudo -u mc git -C /srv/mission-control checkout main
```

## 6. Environment file
```bash
cd /srv/mission-control
sudo -u mc cp -n .env.example .env
SECRET=$(openssl rand -hex 32)
sudo -u mc sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
# Paths / NODE_ENV / PORT are already correct in the template. Verify:
sudo -u mc grep -E 'DATABASE_PATH|WORKTREE_ROOT|NODE_ENV|PORT' .env
```

## 7. Install + build (as mc)
```bash
cd /srv/mission-control
sudo -u mc pnpm install --frozen-lockfile
# If better-sqlite3 fails to load later (e.g. "invalid ELF"), rebuild from source:
#   sudo -u mc pnpm rebuild better-sqlite3
sudo -u mc pnpm build
```

## 8. Database + production admin
```bash
cd /srv/mission-control
sudo -u mc bash -c 'set -a; . ./.env; set +a; pnpm db:migrate'
# Create your REAL admin (interactive). Do NOT reuse test@axodcreative.com.
sudo -u mc bash -c 'set -a; . ./.env; set +a; pnpm seed:admin'
```

## 9. Authenticate agents with Claude Pro (as mc)
```bash
sudo -iu mc
claude            # complete the browser/device login with your Claude Pro account
#   (or: claude setup-token  — for a long-lived headless token)
echo "reply with: ok" | claude -p   # should respond, using your Pro subscription
exit
```
**Fallback (metered):** if the headless SDK won't use the subscription, add
`ANTHROPIC_API_KEY=sk-ant-...` to `/srv/mission-control/.env` instead and skip this step.

## 10. systemd service + backup timer
```bash
cp /srv/mission-control/deploy/mission-control.service /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup.service /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup.timer /etc/systemd/system/
chmod +x /srv/mission-control/deploy/mc-backup.sh /srv/mission-control/scripts/deploy.sh
# Let mc restart the service without a password (used by scripts/deploy.sh):
echo 'mc ALL=(root) NOPASSWD: /usr/bin/systemctl restart mission-control' > /etc/sudoers.d/mc-deploy
chmod 440 /etc/sudoers.d/mc-deploy
systemctl daemon-reload
systemctl enable --now mission-control
systemctl enable --now mc-backup.timer
systemctl status mission-control --no-pager
curl -fsS localhost:3000/api/health && echo "  ← app up"
```

## 11. Caddy (reverse proxy + auto-HTTPS)
```bash
command -v caddy >/dev/null || {
  apt -y install debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt update && apt -y install caddy
}
cp /srv/mission-control/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy
```

## 12. Firewall
```bash
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
ufw status
```

## 13. DNS (at your DNS provider — not on the box)
Create an **A record**: `mc-dev.axodcreative.com → <BOX_IP>`. Then:
```bash
dig +short mc-dev.axodcreative.com    # should return <BOX_IP>
journalctl -u caddy -f                # watch Caddy issue the TLS cert once DNS resolves
```

## 14. Verify (from your laptop)
```bash
curl -fsS https://mc-dev.axodcreative.com/api/health     # 200
```
Open `https://mc-dev.axodcreative.com`, log in with the admin from step 8, create a task or
send a message, and confirm Sage streams a reply.

---

## Updating later
```bash
sudo -iu mc
cd /srv/mission-control && ./scripts/deploy.sh
```

## Troubleshooting
- App logs: `journalctl -u mission-control -f`
- Caddy/TLS logs: `journalctl -u caddy -f`
- Can't log in: confirm you're on `https://` (NODE_ENV=production makes cookies HTTPS-only).
- `SESSION_SECRET must be set…`: the `.env` secret is missing/short — regenerate (step 6).
- Restore a backup: `systemctl stop mission-control`, copy a file from `/srv/backups` over
  `data/mission-control.db`, `systemctl start mission-control`.
````

- [ ] **Step 2: Commit**

```bash
git add docs/runbook-deploy.md
git commit -m "docs(deploy): operator runbook"
```

---

## Task 8: README pointer + final gate

**Files:** Modify `README.md`

- [ ] **Step 1: Add a "Deploying" line** near the roadmap or setup section:

```markdown
**Deploying:** Mission Control runs on a Hetzner VPS (host Node + Caddy + systemd, Claude Pro
auth). See [docs/runbook-deploy.md](docs/runbook-deploy.md); rationale in
[ADR-003](docs/decisions/adr-003-deploy-host-node.md).
```

- [ ] **Step 2: Sanity-check the repo still builds (no app code changed, but confirm nothing broke)**

Run: `pnpm build && pnpm test`
Expected: build clean; `pnpm test` 84/84.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(deploy): link the deploy runbook from the README"
```

---

## Self-Review notes (for the executor)

- **Spec coverage:** topology + systemd (Task 3) · fs/user + dirs (runbook Task 7 §4) · env
  table (Task 1) · Caddy auto-HTTPS (Task 2, runbook §11) · backups (Task 4) · deploy.sh
  (Task 5) · idempotent 14-step runbook incl. Pro-auth + API-key fallback + prod admin
  (Task 7) · ADR addendum (Task 6) · README pointer (Task 8). Out-of-scope items (CI deploy,
  B2, Uptime Robot, rate-limiting, domain promotion) are intentionally omitted.
- **No app code changes** — the existing 84-test suite is the only automated gate (Task 8);
  real deploy verification is the runbook's step 14 (operator-run on the box).
- **Consistency:** `mc` user, `/srv/mission-control`, `/srv/projects`, `/srv/backups`,
  `DATABASE_PATH`/`WORKTREE_ROOT`/`SESSION_SECRET`/`NODE_ENV`/`PORT`, and the
  `node …/next/dist/bin/next start` ExecStart are used identically across the unit, runbook,
  and deploy script.
