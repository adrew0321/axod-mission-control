# Mission Control — Oracle Always-Free deploy runbook

> ⚠️ **Superseded — historical reference.** Oracle never yielded A1 capacity; the live deploy is the home Mac Mini behind a Cloudflare Tunnel — see **[runbook-deploy-homelab.md](runbook-deploy-homelab.md)**. Kept for reference only.

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
