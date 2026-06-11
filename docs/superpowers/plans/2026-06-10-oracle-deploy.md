# Oracle Always-Free Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the committable artifacts + operator runbook to deploy Mission Control on an Oracle Always-Free ARM VM at `https://bridge.axodcreative.com`, with one-time data migration (cloud = source of truth) and nightly offsite backups to Oracle Object Storage.

**Architecture:** Reuse the existing host-Node + Caddy + systemd + Claude-Pro-auth model (ADR-003) unchanged. This plan only adds/edits the artifacts that differ for Oracle: the Caddyfile hostname, an offsite-backup script + systemd timer, an `.env.example` entry, an ADR amendment, and a new Oracle-specific runbook. The operator runs the runbook against the Oracle console + SSH; this plan does not provision cloud resources.

**Tech Stack:** Bash, systemd units, Caddy, SQLite, Oracle Cloud (A1.Flex ARM / Ubuntu 24.04 / Object Storage Pre-Authenticated Requests), `curl` for upload.

**Verification note:** These are infra artifacts, not unit-testable app code. Each task verifies with a *runnable* check that works on this Windows dev machine (Git Bash `bash -n`, content grep, `git diff`). The real end-to-end validation is the runbook's on-box smoke test (operator-run, documented in Task 6). Reference spec: `docs/superpowers/specs/2026-06-10-oracle-deploy-design.md`.

---

## File Structure

**Modify:**
- `deploy/Caddyfile` — change site label `mc-dev.axodcreative.com` → `bridge.axodcreative.com`.
- `.env.example` — add the (commented) `OBJECT_STORAGE_PAR_URL` backup variable.
- `docs/decisions/adr-003-deploy-host-node.md` — append an Oracle-target amendment.

**Create:**
- `deploy/mc-backup-offsite.sh` — upload the latest local snapshot to Object Storage via a PAR URL.
- `deploy/mc-backup-offsite.service` — oneshot unit running the script as `mc`.
- `deploy/mc-backup-offsite.timer` — nightly at 03:45 (after the 03:30 local backup).
- `docs/runbook-deploy-oracle.md` — the operator runbook (provision → firewalls → IP → migrate → carried-over deploy → offsite backup → DNS → verify).

Each artifact has one responsibility; the offsite backup is intentionally separate from the existing `mc-backup.*` (local snapshots) so the local job keeps working even if the PAR is unset/expired.

---

### Task 1: Point Caddy at the new hostname

**Files:**
- Modify: `deploy/Caddyfile:3`

- [ ] **Step 1: Edit the site label**

Replace the full contents of `deploy/Caddyfile` with:

```caddyfile
# Caddy reverse proxy for Mission Control. Automatic HTTPS via Let's Encrypt —
# Caddy provisions + renews the cert once this name's DNS resolves to the box.
bridge.axodcreative.com {
	encode gzip
	reverse_proxy localhost:3000
}
```

- [ ] **Step 2: Verify the hostname changed and nothing else did**

Run: `git diff deploy/Caddyfile`
Expected: exactly one line changed — `mc-dev.axodcreative.com {` → `bridge.axodcreative.com {`. The `reverse_proxy localhost:3000` and `encode gzip` lines are unchanged.

- [ ] **Step 3: Commit**

```bash
git add deploy/Caddyfile
git commit -m "feat(deploy): point Caddy at bridge.axodcreative.com"
```

---

### Task 2: Add the Object Storage backup variable to the env template

**Files:**
- Modify: `.env.example` (append after the `ANTHROPIC_API_KEY` block)

- [ ] **Step 1: Append the variable**

Add these lines to the end of `.env.example`:

```bash

# OFFSITE BACKUP (optional): an Oracle Object Storage Pre-Authenticated Request
# (PAR) URL that permits OBJECT WRITES to the backup bucket. The trailing slash
# matters — the backup script appends the object name to it. Generated in the
# Oracle console (see docs/runbook-deploy-oracle.md, "Offsite backups"); rotate
# before it expires. Leave unset to keep local-only snapshots.
# OBJECT_STORAGE_PAR_URL=
```

- [ ] **Step 2: Verify it's present and commented (so it never breaks a default boot)**

Run: `git diff .env.example`
Expected: the new block is added; the `OBJECT_STORAGE_PAR_URL=` line is commented (`#`), matching the `ANTHROPIC_API_KEY` fallback style.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat(deploy): add OBJECT_STORAGE_PAR_URL to env template"
```

---

### Task 3: Offsite backup upload script

**Files:**
- Create: `deploy/mc-backup-offsite.sh`

- [ ] **Step 1: Write the script**

Create `deploy/mc-backup-offsite.sh` with:

```bash
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
```

- [ ] **Step 2: Verify the script is syntactically valid**

Run: `bash -n deploy/mc-backup-offsite.sh`
Expected: no output, exit 0 (syntax OK).

- [ ] **Step 3: Verify the no-PAR path is a clean no-op (the safety property)**

Run: `bash deploy/mc-backup-offsite.sh`
Expected: prints `OBJECT_STORAGE_PAR_URL unset — skipping offsite upload (local snapshots kept).` and exits 0 (because the variable is not set in this shell).

- [ ] **Step 4: Commit**

```bash
git add deploy/mc-backup-offsite.sh
git commit -m "feat(deploy): offsite backup upload to Object Storage via PAR"
```

---

### Task 4: systemd service + timer for the offsite backup

**Files:**
- Create: `deploy/mc-backup-offsite.service`
- Create: `deploy/mc-backup-offsite.timer`

- [ ] **Step 1: Write the service unit**

Create `deploy/mc-backup-offsite.service` (mirrors `mc-backup.service`, loads `.env` for the PAR):

```ini
[Unit]
Description=Mission Control nightly offsite backup (Object Storage)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=mc
Group=mc
EnvironmentFile=/srv/mission-control/.env
ExecStart=/srv/mission-control/deploy/mc-backup-offsite.sh
```

- [ ] **Step 2: Write the timer unit**

Create `deploy/mc-backup-offsite.timer` (15 min after the local backup's 03:30):

```ini
[Unit]
Description=Run Mission Control offsite backup nightly

[Timer]
OnCalendar=*-*-* 03:45:00
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 3: Verify the units are consistent with the local-backup pair**

Run: `git diff --cached --stat; cat deploy/mc-backup-offsite.service deploy/mc-backup-offsite.timer`
Expected: service runs as `User=mc`/`Group=mc` with `EnvironmentFile=/srv/mission-control/.env` and `ExecStart` pointing at `mc-backup-offsite.sh`; timer fires `03:45:00` with `Persistent=true` and `WantedBy=timers.target`.

- [ ] **Step 4: Commit**

```bash
git add deploy/mc-backup-offsite.service deploy/mc-backup-offsite.timer
git commit -m "feat(deploy): systemd timer for nightly offsite backup"
```

---

### Task 5: Amend ADR-003 with the Oracle target

**Files:**
- Modify: `docs/decisions/adr-003-deploy-host-node.md` (append a dated amendment)

- [ ] **Step 1: Append the amendment**

Add to the end of `docs/decisions/adr-003-deploy-host-node.md`:

```markdown

---

### Amendment 2026-06-10 — deploy target is Oracle Always-Free (arm64)

The host/Caddy/systemd/Pro-auth **decision is unchanged**; only the target host moves.
v1 now deploys to an **Oracle Cloud Always-Free `VM.Standard.A1.Flex`** (ARM Ampere,
2 vCPU / 12 GB, Ubuntu 24.04) at `https://bridge.axodcreative.com`, replacing the planned
Hetzner CX22. Rationale: free-forever with no passport requirement and far more RAM than the
x86 free micro (1 GB), which would struggle with `pnpm build` and concurrent `claude`
subprocesses. arm64 is transparent — Node 22, pnpm, the `claude` CLI, and `better-sqlite3`
(built from source under this repo's `ignore-scripts` setup) all support it.

Consequences specific to Oracle: a **two-layer firewall** (VCN Security List ingress *and* the
host's `ufw`/iptables — both must allow 80/443); a **reserved (static) public IP** so DNS
survives stop/start; and **offsite backups to Oracle Object Storage** via a scoped write-only
Pre-Authenticated Request. Cloud is the source of truth; local data is migrated once at setup.
See `docs/runbook-deploy-oracle.md` and `docs/superpowers/specs/2026-06-10-oracle-deploy-design.md`.
```

- [ ] **Step 2: Verify the amendment reads consistently**

Run: `git diff docs/decisions/adr-003-deploy-host-node.md`
Expected: only an appended amendment section; it states the host model is unchanged and names the Oracle A1.Flex target, double firewall, reserved IP, and Object Storage backups.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/adr-003-deploy-host-node.md
git commit -m "docs(adr): amend ADR-003 with Oracle Always-Free target"
```

---

### Task 6: The operator runbook

**Files:**
- Create: `docs/runbook-deploy-oracle.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbook-deploy-oracle.md` with the full content below.

````markdown
# Mission Control — Oracle Always-Free deploy runbook

**Target:** Oracle Cloud Always Free, `VM.Standard.A1.Flex` (ARM Ampere), 2 vCPU / 12 GB,
Ubuntu 24.04. **Result:** `https://bridge.axodcreative.com`.
Login is the `ubuntu` user via SSH key; privileged steps use `sudo`. **Idempotent** — every
step checks before acting, safe to re-run. Replace `<BOX_IP>` with the reserved public IP.

> **Cloud = source of truth.** Local data is migrated once (§A). After that, the box is canonical.

## 0. Provision the instance (Oracle console — you do this)
1. Create a free Oracle Cloud account (needs a credit/debit card for identity verification —
   **not charged** on Always Free; **no passport required**).
2. Compute → **Create Instance**:
   - Image: **Ubuntu 24.04**.
   - Shape: **Ampere / `VM.Standard.A1.Flex`** → set **2 OCPU / 12 GB** (Always-Free eligible).
   - **SSH keys:** upload your public key (or download the generated key). There is no root
     password; you log in as `ubuntu`.
   - Networking: let it create a VCN + subnet with a public IP.
3. If you get **"Out of host capacity"**, retry, or pick another Availability Domain/region.

## 1. Reserve a static public IP (so DNS survives reboots)
Oracle's default public IP is **ephemeral**. Networking → the instance's VNIC → its public IP →
**reserve / convert to reserved** (one is included free). Note it as `<BOX_IP>`.

## 2. Open BOTH firewalls (Oracle's #1 gotcha)
Opening only the OS firewall is NOT enough — Oracle blocks at the cloud layer too.

**2a. Cloud layer (Oracle console):** VCN → the subnet's **Security List** (or an NSG on the
VNIC) → add **Ingress** rules: source `0.0.0.0/0`, IP protocol TCP, destination ports **80** and
**443**. (Port 22 is already allowed.)

**2b. OS layer (on the box):** Oracle's Ubuntu image ships restrictive iptables. Switch to `ufw`:
```bash
ssh ubuntu@<BOX_IP>
sudo iptables -F                 # flush Oracle's default rules
sudo netfilter-persistent save 2>/dev/null || true
sudo apt update && sudo apt -y install ufw
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
sudo ufw status                  # expect 22, 80, 443 allowed
```

## 3. Become root for the install
```bash
sudo -i
```
From here, steps mirror the Hetzner runbook (`docs/runbook-deploy.md`) — run them on this box.

## 4. System packages
```bash
apt update && apt -y upgrade
apt -y install curl git build-essential python3 sqlite3 ca-certificates gnupg
```
(`build-essential` + `python3` build `better-sqlite3` from source on arm64, which this repo
allows via `onlyBuiltDependencies` despite `.npmrc`'s `ignore-scripts=true`.)

## 5. Node 22 + pnpm + Claude CLI
```bash
node -v 2>/dev/null | grep -q '^v22' || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs; }
node -v          # expect v22.x (arm64)
corepack enable && corepack prepare pnpm@latest --activate
pnpm -v
which node       # expect /usr/bin/node (matches the systemd unit; if different, edit ExecStart)
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code
claude --version
```

## 6. App user + directories
```bash
id mc >/dev/null 2>&1 || adduser --system --group --home /srv/mission-control mc
mkdir -p /srv/mission-control /srv/projects /srv/backups
chown -R mc:mc /srv/mission-control /srv/projects /srv/backups
```

## 7. Clone the repo (as mc)
```bash
if [ -d /srv/mission-control/.git ]; then
  sudo -u mc git -C /srv/mission-control pull --ff-only origin main
else
  sudo -u mc git clone https://github.com/adrew0321/axod-mission-control.git /srv/mission-control
fi
sudo -u mc git -C /srv/mission-control checkout main
```

## 8. Environment file
```bash
cd /srv/mission-control
sudo -u mc cp -n .env.example .env
SECRET=$(openssl rand -hex 32)
sudo -u mc sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
sudo -u mc grep -E 'DATABASE_PATH|WORKTREE_ROOT|NODE_ENV|PORT' .env   # verify paths
```

## A. MIGRATE YOUR DATA (cloud = source of truth) — do this BEFORE first build/start

### A1. The database (the one irreplaceable artifact)
**On your LOCAL machine**, with the local app stopped (so the DB is quiescent):
```bash
# Local: fold the WAL into the main file for a clean, single-file snapshot.
sqlite3 "C:/Users/A'KeemDrew/AXOD/axod-mission-control/data/mission-control.db" "PRAGMA wal_checkpoint(TRUNCATE);"
# Local: copy it to the box (lands in the ubuntu user's home).
scp "C:/Users/A'KeemDrew/AXOD/axod-mission-control/data/mission-control.db" ubuntu@<BOX_IP>:mission-control.db
```
**On the BOX**, put it in place owned by mc, before migrate/build:
```bash
install -d -o mc -g mc /srv/mission-control/data
install -o mc -g mc -m 600 /home/ubuntu/mission-control.db /srv/mission-control/data/mission-control.db
rm -f /home/ubuntu/mission-control.db
```

### A2. Project repos (git is the transfer — not file copy)
**On your LOCAL machine**, commit + push any uncommitted work first so nothing is lost:
- `landing` (AXODCREATIVE): commit/push `src/components/Pricing.astro`.
- `research-agent`: commit/push the `package.json` change and `plans/`.
- `axod-chat`: already clean.

**On the BOX**, clone each under `/srv/projects` (as mc):
```bash
sudo -u mc git clone https://github.com/adrew0321/axod-chat.git            /srv/projects/axod-chat
sudo -u mc git clone https://github.com/adrew0321/AXODCREATIVE.git         /srv/projects/landing
sudo -u mc git clone https://github.com/adrew0321/axod-research-agent.git  /srv/projects/research-agent
```
(`test-browser` is intentionally **skipped** — not a git repo, treated as throwaway.)
After the app is up (§12), register each path in the in-app project switcher.

## 9. Install + build (as mc)
```bash
cd /srv/mission-control
sudo -u mc pnpm install --frozen-lockfile
# If better-sqlite3 fails to load later ("invalid ELF header" on arch mismatch), rebuild:
#   sudo -u mc pnpm rebuild better-sqlite3
sudo -u mc pnpm build
```

## 10. Database migrate + admin
```bash
cd /srv/mission-control
# Runs against the MIGRATED db from §A1 — applies any newer migrations to your real data.
sudo -u mc bash -c 'set -a; . ./.env; set +a; pnpm db:migrate'
# Your migrated db already has your real admin. Only run seed:admin if you did NOT migrate a db:
#   sudo -u mc bash -c 'set -a; . ./.env; set +a; pnpm seed:admin'
```

## 11. Authenticate agents with Claude Pro (as mc)
```bash
sudo -iu mc
claude            # complete the browser/device login with your Claude Pro account
echo "reply with: ok" | claude -p   # should respond using your Pro subscription
exit
```
**Fallback (metered):** if the headless SDK won't use the subscription, add
`ANTHROPIC_API_KEY=sk-ant-...` to `/srv/mission-control/.env` and skip this step.

## 12. systemd services (app + both backup timers)
```bash
cp /srv/mission-control/deploy/mission-control.service /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup.service /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup.timer /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup-offsite.service /etc/systemd/system/
cp /srv/mission-control/deploy/mc-backup-offsite.timer /etc/systemd/system/
chmod +x /srv/mission-control/deploy/mc-backup.sh /srv/mission-control/deploy/mc-backup-offsite.sh /srv/mission-control/scripts/deploy.sh
echo 'mc ALL=(root) NOPASSWD: /usr/bin/systemctl restart mission-control' > /etc/sudoers.d/mc-deploy
chmod 440 /etc/sudoers.d/mc-deploy
systemctl daemon-reload
systemctl enable --now mission-control
systemctl enable --now mc-backup.timer
systemctl enable --now mc-backup-offsite.timer
systemctl status mission-control --no-pager
curl -fsS localhost:3000/api/health && echo "  ← app up"
```

## 13. Offsite backups → Oracle Object Storage
**Oracle console:**
1. Storage → **Buckets** → **Create Bucket** (e.g. `mc-backups`, Standard, private).
2. Open the bucket → **Pre-Authenticated Requests** → **Create**:
   - Target: **Bucket** · Access type: **Permit object writes** · set an **Expiry** (e.g. 1 year).
   - **Copy the URL now** (shown once). It ends with `/o/` — keep the trailing slash.
**On the box**, add it to `.env` (mc-owned, mode 600) and test:
```bash
sudo -u mc sed -i "s|^# OBJECT_STORAGE_PAR_URL=.*|OBJECT_STORAGE_PAR_URL=PASTE_PAR_URL_HERE|" /srv/mission-control/.env
sudo systemctl start mc-backup.service          # make a fresh local snapshot
sudo systemctl start mc-backup-offsite.service  # upload it
journalctl -u mc-backup-offsite.service -n 20 --no-pager   # expect "uploaded mc-....db"
```
Confirm the object appears in the bucket. **Rotate the PAR before its expiry.**

## 14. Caddy (reverse proxy + auto-HTTPS)
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

## 15. DNS (at your DNS provider)
Create an **A record**: `bridge.axodcreative.com → <BOX_IP>` (the reserved IP). Then:
```bash
dig +short bridge.axodcreative.com    # should return <BOX_IP>
journalctl -u caddy -f                # watch Caddy issue the TLS cert once DNS resolves
```

## 16. Verify (from a machine OTHER than your desktop — proves local-independence)
```bash
curl -fsS https://bridge.axodcreative.com/api/health     # 200
```
Open `https://bridge.axodcreative.com`, log in with your **migrated** admin, confirm your
sessions/tasks/memory are present, register the `/srv/projects/*` repos, send a message, and
confirm an agent streams a reply.

---

## Updating later
```bash
sudo -iu mc
cd /srv/mission-control && ./scripts/deploy.sh
```

## Troubleshooting
- **Site unreachable after a clean deploy → check the VCN Security List FIRST** (§2a). This is
  the most common Oracle failure and is invisible to on-box checks.
- App logs: `journalctl -u mission-control -f` · Caddy/TLS: `journalctl -u caddy -f`.
- Offsite upload failing: `journalctl -u mc-backup-offsite.service -n 30` — usually an expired
  PAR; regenerate it (§13) and update `.env`.
- Can't log in: confirm `https://` (NODE_ENV=production → cookies are HTTPS-only).
- `better-sqlite3` "invalid ELF header": `sudo -u mc pnpm rebuild better-sqlite3` (§9).
- Restore: `systemctl stop mission-control`, copy a snapshot from `/srv/backups` (or the bucket)
  over `data/mission-control.db`, `systemctl start mission-control`.
````

- [ ] **Step 2: Verify the runbook references every artifact and the right hostname**

Run: `grep -nE 'bridge.axodcreative.com|mc-backup-offsite|OBJECT_STORAGE_PAR_URL|VCN|Security List|wal_checkpoint' docs/runbook-deploy-oracle.md`
Expected: matches for the hostname, the offsite units, the PAR variable, the VCN/Security List firewall step, and the WAL checkpoint in migration. Confirm **no** remaining `mc-dev.axodcreative.com`.

- [ ] **Step 3: Commit**

```bash
git add docs/runbook-deploy-oracle.md
git commit -m "docs(deploy): Oracle Always-Free operator runbook"
```

---

### Task 7: Cross-check pass (plan ↔ spec ↔ artifacts)

**Files:** none (verification only)

- [ ] **Step 1: Confirm every artifact the spec promised exists**

Run: `git ls-files deploy/ docs/runbook-deploy-oracle.md docs/decisions/adr-003-deploy-host-node.md | grep -E 'Caddyfile|mc-backup-offsite|runbook-deploy-oracle|adr-003'`
Expected: lists `deploy/Caddyfile`, `deploy/mc-backup-offsite.sh`, `deploy/mc-backup-offsite.service`, `deploy/mc-backup-offsite.timer`, `docs/runbook-deploy-oracle.md`, `docs/decisions/adr-003-deploy-host-node.md`.

- [ ] **Step 2: Confirm the offsite script + timer wiring is internally consistent**

Run: `grep -h 'OBJECT_STORAGE_PAR_URL' deploy/mc-backup-offsite.sh .env.example; grep 'mc-backup-offsite.sh' deploy/mc-backup-offsite.service`
Expected: the variable name matches across script + env template, and the service's `ExecStart` names the script. (Both confirmed → no orphaned references.)

- [ ] **Step 3: Final review of the full diff**

Run: `git log --oneline -7; git diff main --stat`
Expected: 6 artifact commits (Tasks 1–6) on `feature/oracle-deploy`; changed files are exactly the three modified + four created above (plus the two spec commits already present). No stray edits.

---

## Self-Review (completed during planning)

- **Spec coverage:** host/hostname (Task 1, 6), env var (Task 2), offsite script + units (Tasks 3–4), ADR amendment (Task 5), runbook with provision/double-firewall/reserved-IP/migration/Object-Storage/DNS/verify (Task 6). Migration A1/A2 + skip `test-browser` covered in Task 6 §A. Server-side turn runner correctly absent (out of scope).
- **Placeholder scan:** none — every artifact's full content is inline; `PASTE_PAR_URL_HERE` is a deliberate operator-supplied secret, not a plan gap.
- **Consistency:** `OBJECT_STORAGE_PAR_URL` identical across `.env.example`, the script, and the service; offsite timer (03:45) ordered after local backup (03:30); units mirror the existing `mc-backup.*` pattern (User=mc, EnvironmentFile, WantedBy=timers.target).
