# Mission Control — VPS deploy runbook

> ⚠️ **Superseded — historical reference.** The live deploy is the home Mac Mini behind a Cloudflare Tunnel (`https://bridge.axodcreative.com`) — see **[runbook-deploy-homelab.md](runbook-deploy-homelab.md)**. This Hetzner runbook is kept for reference only.

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
usermod -s /bin/bash mc   # `--system` users default to nologin; step 9's `sudo -iu mc` needs a real shell
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
# pnpm will warn about "ignored build scripts" — that's the intended hardening; do NOT run
# `pnpm approve-builds` (the onlyBuiltDependencies allowlist is the real control).
# Create the data dirs BEFORE building: the Next build instantiates the DB layer, so a
# missing data/ dir makes `pnpm build` fail with "cannot open database ... directory does not exist".
sudo -u mc mkdir -p /srv/mission-control/data/worktrees
# Verify better-sqlite3's native binding loads (build/Release/better_sqlite3.node):
sudo -u mc node -e "new (require('better-sqlite3'))(':memory:'); console.log('sqlite ok')"
# If that throws ("could not locate the bindings file" / "invalid ELF header"), the prebuilt
# binary was missing or mismatched. `pnpm rebuild better-sqlite3` often silently no-ops when
# prebuild-install can't download; compile it directly with npm's bundled node-gyp instead:
#   cd /srv/mission-control/node_modules/better-sqlite3
#   sudo -u mc node /usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild
#   cd /srv/mission-control   # then re-run the sqlite check above
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
