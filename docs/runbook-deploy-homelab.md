# Mission Control — home-lab deploy runbook (Mac Mini + Cloudflare Tunnel)

**Host:** 2011 Mac Mini (A1347, Intel x86_64, 16 GB RAM), wiped to **Ubuntu Server 24.04 LTS**,
wired Ethernet. **Ingress:** a **Cloudflare Tunnel** (no public IP, no port-forwarding) →
`https://bridge.axodcreative.com`. **Result:** Mission Control reachable from anywhere, on whether
or not your desktop is on.

Same app runtime as the cloud runbooks (host Node + systemd + Claude Pro CLI auth, per
[ADR-003](decisions/adr-003-deploy-host-node.md)); only the **host** and **networking** differ.
Cloud = source of truth; local data migrated once.

---

## Current state (2026-06-26) — LIVE

The Mini (`mc-bridge`, `10.0.0.218`) is running **v1.8.0**, publicly reachable at
**https://bridge.axodcreative.com** via a cloudflared **named tunnel** (`mc-bridge`, systemd
boot service — see Phase 3). The full stack runs 24/7: app, Scheduler, nightly health-check,
Dreaming, and the Discord bot (chat + notifications). Login: `adrew0321@gmail.com` (the
throwaway `test@` admin has been removed). Local nightly DB snapshots run (`mc-backup.timer`,
03:30 UTC → `/srv/backups`); R2 offsite backups (Phase 4) deferred.

### Updating the live box (deploy a new release)

```bash
# code/data update — run as the app user `mc` (owns /srv/mission-control):
sudo -u mc bash -lc 'cd /srv/mission-control \
  && git pull --ff-only origin main \
  && pnpm install --frozen-lockfile \
  && pnpm build \
  && (set -a; . ./.env; set +a; pnpm db:migrate)'
# then restart (allowlisted for akeem — see sudo note):
sudo systemctl restart mission-control
```

`scripts/deploy.sh` automates this but assumes `mc` can sudo the restart; run the restart as
`akeem` instead. The `ERR_PNPM_IGNORED_BUILDS` warning on install is the intentional
`ignore-scripts` allowlist — do NOT `pnpm approve-builds`.

### Gotchas learned (the hard way)

- **The Mini DB is SEPARATE from any dev machine's DB.** They do not sync. Work done against a
  local `pnpm dev` (channel `/mc bind`s, schedules, sessions) does NOT appear on the Mini. This
  silently broke Discord chat once: with no `discord_bindings` row on the Mini, `handleMessage`
  dropped messages at the binding check (no turn, nothing logged). **The Mini is the source of
  truth — keep any local `pnpm dev` stopped, or re-migrate the DB.** Re-create per-channel
  bindings on the box itself (`/mc bind` from Discord, which now hits the Mini) and schedules via
  the Scheduler UI / a DB insert.
- **`pnpm seed:admin` is interactive and does NOT work over piped stdin** (its hidden-password
  readline hangs). Seed non-interactively (small env-driven script) instead. Deleting an admin
  needs its `auth_sessions` rows cleared first (FK `auth_sessions.user_id → auth_users.id`).
- **Discord bot token = one gateway connection.** When handing the bot from a dev machine to the
  Mini, STOP the dev server first, then restart the Mini service, so only one process holds the
  token.

### Security posture (2026-06-26)

- App runs as `mc`; `mc`'s only sudo right is `systemctl restart mission-control` (contained).
- `akeem` sudo is scoped: passwordless only for `sudo -u mc …` and specific service restarts
  (`/etc/sudoers.d/99-akeem-nopasswd`); **arbitrary root requires akeem's password**. Log reads
  go through `akeem`'s `adm` group membership (no sudo). One-time root admin (apt installs,
  installing systemd units, editing `/root` or sudoers) therefore needs an interactive password.

---

## Phase 0 — Make the Ubuntu installer (on your Windows PC)
1. Download **Ubuntu Server 24.04 LTS** ISO: <https://ubuntu.com/download/server> (the "Manual
   install" / ISO, ~2–3 GB).
2. Get a **USB stick ≥ 4 GB** (its contents will be erased).
3. Write the ISO to the USB with **Rufus** (<https://rufus.ie>):
   - Device = your USB · Boot selection = the Ubuntu ISO · leave defaults · **Start** →
     if asked ISO vs DD mode, choose **DD Image mode** (boots cleanly on Mac EFI).
   - (balenaEtcher works too — it always uses DD mode.)

## Phase 1 — Install Ubuntu on the Mac Mini
You need a **monitor (HDMI)**, a **USB keyboard**, and an **Ethernet cable** to the router.

> **Networking reality on the 2011 A1347.** Its built-in Wi-Fi is a **Broadcom BCM4331** whose
> Linux driver is proprietary and **not on the offline Server installer** — you cannot join any
> Wi-Fi (not even a phone hotspot) during install. Use **wired** networking. If you have no
> Ethernet cable handy, the no-cable fallback is **USB tethering** (not Wi-Fi tethering): plug a
> phone in by USB cable and enable USB tethering — Linux sees a plain wired interface, no drivers
> needed. iPhone tethering works (interface `enx…`, DHCP `172.20.10.x`) and gets you online for
> the whole deploy; just note its IP is NAT'd behind the phone so the LAN can't SSH in (you work
> at the Mini's keyboard until Ethernet is connected). On Ubuntu 24.04 there's no `dhclient` — if
> an interface comes up without an IP, point netplan at it (`/etc/netplan/99-iface.yaml`,
> `dhcp4: true`, `chmod 600`, `netplan apply`).
1. Plug in the USB stick, monitor, keyboard, Ethernet.
2. Power on while **holding the Option/Alt (⌥) key** → the Mac boot picker appears.
3. Select **"EFI Boot"** (the USB) → Enter.
4. Run the Ubuntu Server installer:
   - Language/keyboard → defaults.
   - Network → it should grab a DHCP address over Ethernet; **note the IP** shown (e.g.
     `192.168.1.50`).
   - Storage → **"Use an entire disk"** (this **erases macOS** — intended).
   - Profile → set your name, a **server name** (e.g. `mc-bridge`), username (e.g. `akeem`), password.
   - **"Install OpenSSH server" → YES** (so you can finish headless from your PC).
   - Skip the snap suggestions. Let it install, then **Reboot** and pull the USB.
5. After reboot it's headless — from your **Windows PC** confirm SSH:
   ```bash
   ssh akeem@<MAC_MINI_IP>
   ```
   You can now unplug the monitor/keyboard; everything else is done over SSH.

> **Optional but recommended — give it a fixed LAN IP** so it's predictable: either set a DHCP
> reservation for the Mac Mini's MAC address in your router, or note that Cloudflare Tunnel
> doesn't actually need a fixed IP (it dials outbound) — only your SSH convenience does.

## Phase 2 — Deploy Mission Control (same as the cloud runbook)
SSH in (`ssh akeem@<MAC_MINI_IP>`), then `sudo -i`. Run **steps 1–10 of
`docs/runbook-deploy.md`** exactly as written (they're OS-identical on Ubuntu 24.04) — i.e.:
system packages · Node 22 + pnpm · `claude` CLI · `mc` user + `/srv/{mission-control,projects,backups}`
· clone repo (`main`) · `.env` (SESSION_SECRET, paths, `NODE_ENV=production`, `PORT=3000`) ·
`pnpm install` + `pnpm build`.

> **Gotchas hit during the actual Mac Mini run** (patch these into the base runbook too):
> - **Give `mc` a login shell.** Step 4's `adduser --system mc` creates the user with **no shell**, but
>   step 9 / Claude auth need `sudo -iu mc`. Run `usermod -s /bin/bash mc` first or the login silently fails.
> - **better-sqlite3 has no prebuilt binding here** → `pnpm install` leaves it unbuilt (allowlist is
>   intentional — do **not** `pnpm approve-builds`). Compile it from source with npm's bundled node-gyp:
>   `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && node /usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild`.
> - **Create the data dirs before `pnpm build`/`db:migrate`** — the build instantiates the DB:
>   `mkdir -p /srv/mission-control/data/worktrees`.

**Then migrate your data BEFORE first start** — same as the Oracle runbook's §A:
- **DB:** on this Windows PC, stop the local app, then checkpoint the WAL into the main `.db`.
  **There is no `sqlite3` CLI on Windows** — run a throwaway node script instead:
  `node -e "const D=require('better-sqlite3');new D('data/mission-control.db').pragma('wal_checkpoint(TRUNCATE)')"`.
  Then `scp data/mission-control.db akeem@<MAC_MINI_IP>:mission-control.db`; on the Mini, clear any stale
  `-wal`/`-shm` and `install -o mc -g mc -m 600 /home/akeem/mission-control.db /srv/mission-control/data/mission-control.db`.
- **Repos:** commit/push any uncommitted work, then on the Mini
  `sudo -u mc git clone` `axod-chat`, `AXODCREATIVE` (landing), `axod-research-agent` into
  `/srv/projects/`. (Skip `test-browser`.)

Then finish the app steps:
- `pnpm db:migrate` (against the migrated DB).
- Claude Pro auth: `sudo -iu mc`, run `claude`, complete device login, test `echo ok | claude -p`, `exit`.
- systemd app service + local backup timer (runbook-deploy.md step 10), **but SKIP Caddy (step 11)
  and the `ufw` 80/443 rules (step 12)** — the tunnel replaces them. Confirm the app is up locally:
  ```bash
  curl -fsS localhost:3000/api/health && echo "  ← app up"
  ```

## Phase 3 — Cloudflare Tunnel (the ingress)
All on the Mac Mini (as root unless noted).

> **Prerequisite:** the named tunnel needs `axodcreative.com` to be a **zone in your Cloudflare
> account** (so `cloudflared tunnel login` lists it and `route dns` can write the record). If the
> domain isn't registered yet, the cleanest path is to **register it via Cloudflare Registrar** —
> it's added as a zone automatically, no nameserver changes. To **smoke-test before you own the
> domain**, run a throwaway quick tunnel (no login, no DNS): `cloudflared tunnel --url
> http://127.0.0.1:3000` prints an ephemeral `https://<random>.trycloudflare.com` you can open
> from your phone. It runs in the foreground and dies on Ctrl+C/reboot — it's for verification
> only; do the steps below for the permanent boot service.

1. **Install `cloudflared`:** (apt repo below, or simpler on a fresh box: download the `.deb` —
   `curl -L -o /tmp/cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && apt install /tmp/cf.deb`)
   ```bash
   mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | tee /etc/apt/sources.list.d/cloudflared.list
   apt update && apt -y install cloudflared
   cloudflared --version
   ```
2. **Authenticate to your Cloudflare account** (opens a URL — paste it into your PC's browser,
   pick the `axodcreative.com` zone):
   ```bash
   cloudflared tunnel login
   ```
3. **Create the tunnel** (writes a credentials JSON under `/root/.cloudflared/`):
   ```bash
   cloudflared tunnel create mc-bridge
   cloudflared tunnel list      # note the Tunnel ID
   ```
4. **Config file** `/root/.cloudflared/config.yml`:
   ```yaml
   tunnel: mc-bridge
   credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
   ingress:
     - hostname: bridge.axodcreative.com
       service: http://127.0.0.1:3000   # use 127.0.0.1, NOT localhost — see note below
     - service: http_status:404
   ```
   > **Use `127.0.0.1`, not `localhost`.** `next start` listens on IPv4 only, but `localhost`
   > frequently resolves to IPv6 `::1` first, so `cloudflared` gets **"unable to reach the origin
   > service"** (502 Bad Gateway) even though `curl localhost:3000` works (curl falls back to IPv4).
5. **Create the DNS record** (auto — no manual Cloudflare DNS edit needed):
   ```bash
   cloudflared tunnel route dns mc-bridge bridge.axodcreative.com
   ```
6. **Run it as a service** (starts on boot):
   ```bash
   cloudflared service install
   systemctl enable --now cloudflared
   systemctl status cloudflared --no-pager
   ```

## Phase 4 — Offsite backups → Cloudflare R2 (free 10 GB)
Replaces the Oracle Object Storage piece; same idea (nightly push of the local snapshot).
1. **Cloudflare dashboard → R2 → Create bucket** (e.g. `mc-backups`).
2. **R2 → Manage API Tokens → Create API Token** (Object Read & Write, scoped to that bucket).
   Note the **Access Key ID**, **Secret Access Key**, and your **account R2 endpoint**
   (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
3. On the Mini, install **rclone** and configure an R2 remote:
   ```bash
   apt -y install rclone
   sudo -u mc rclone config create r2 s3 provider Cloudflare \
     access_key_id <ACCESS_KEY> secret_access_key <SECRET> \
     endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com acl private
   ```
   (`rclone.conf` lands in the `mc` user's home, mode 600 — not committed.)
4. Reuse the existing `deploy/mc-backup-offsite.{service,timer}` but point the upload at R2.
   Simplest: a tiny wrapper that rclone-copies the newest snapshot:
   ```bash
   # on the Mini, as a quick alternative to PAR upload:
   sudo -u mc bash -c 'rclone copy "$(ls -1t /srv/backups/mc-*.db | head -1)" r2:mc-backups'
   ```
   Wire that into a nightly timer (mirror `deploy/mc-backup.timer`, 03:45).

## Phase 5 — Verify
From your **phone on cellular** (proves it's reachable off your home network and independent of
your desktop):
```
https://bridge.axodcreative.com/api/health      → 200
```
Open `https://bridge.axodcreative.com`, log in with your **migrated** admin, confirm your
sessions/tasks/memory are present, register the `/srv/projects/*` repos, send a message, confirm
an agent streams. Then **pull the power, plug it back in, and confirm it all comes back on its own**
(systemd brings up `mission-control` + `cloudflared` at boot) — that's your always-on guarantee.

---

## Notes & troubleshooting
- **No inbound ports are open** on your home router — `cloudflared` dials *out* to Cloudflare.
  Keep `ufw` to **SSH only** (`ufw allow OpenSSH; ufw enable`).
- **Cookies/HTTPS:** `NODE_ENV=production` makes session cookies `secure`; the browser reaches
  the app via Cloudflare HTTPS, so that's satisfied. If login misbehaves, confirm you're on the
  `https://bridge…` URL, not the LAN IP.
- **Uptime caveat:** this box is only up when your home power + internet are up. A power blip =
  downtime until it reboots (systemd auto-restarts the services). A small UPS removes most of that
  risk if you want it later.
- **Updates:** `sudo -iu mc; cd /srv/mission-control && ./scripts/deploy.sh` (unchanged).
- **Mac Mini won't boot the USB:** re-hold Option at chime; if the USB doesn't appear, re-write it
  in **DD mode** (Rufus) / use balenaEtcher.
