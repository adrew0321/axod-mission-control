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

> ⚠️ **The Mini's LAN address is DHCP and has moved** — it was `10.0.0.218`, and as of
> 2026-08-11 it is **`10.0.0.219`** (Ethernet, `enp1s0f0`). Substitute the current address in
> every `ssh akeem@…` command below. If SSH times out, the address has probably changed again:
> check `arp -a` for an Apple OUI (`68:5b:35:…`) rather than assuming the box is down — the
> cloudflared tunnel keeps `bridge.axodcreative.com` serving even when the Mini has no LAN
> presence at all (e.g. when it is running on the iPhone USB tether, since its built-in WiFi is
> dead). **Fix properly:** set a DHCP reservation on the router, or give it a static address.

The Mini (`mc-bridge`, `10.0.0.218` → now `10.0.0.219`) is running **v1.21.3**, publicly reachable at
**https://bridge.axodcreative.com** via a cloudflared **named tunnel** (`mc-bridge`, systemd
boot service — see Phase 3). The full stack runs 24/7: app, Scheduler, nightly health-check,
Dreaming, and the Discord bot (chat + notifications). Login: `adrew0321@gmail.com` (the
throwaway `test@` admin has been removed). Local nightly DB snapshots run (`mc-backup.timer`,
03:30 UTC → `/srv/backups`) with failure alerting wired (Phase 4b, deployed v1.21.3 — journal-only
until `DISCORD_ALERT_WEBHOOK` is set), and R2 offsite backups configured 2026-08-15 (Phase 4,
verified upload to `mc-backups`).

### Updating the live box (deploy a new release)

```bash
# code/data update — run as the app user `mc` (owns /srv/mission-control):
sudo -u mc bash -lc 'cd /srv/mission-control \
  && git pull --ff-only origin main \
  && pnpm build'
# ONLY if the release changed deps (see warning below):
#   sudo -u mc bash -lc 'cd /srv/mission-control && pnpm install --frozen-lockfile'
# ONLY if the release added migrations (drizzle/ changed):
#   sudo -u mc bash -lc 'cd /srv/mission-control && set -a; . ./.env; set +a; pnpm db:migrate'
# then restart (allowlisted for akeem — see sudo note):
sudo systemctl restart mission-control
```

> **Do NOT run `pnpm install` on every deploy.** Since the `mc`-HOME move it aborts wanting to purge
> `node_modules`, and letting it would wipe the hand-compiled `better-sqlite3` binding. Install only
> when deps actually changed, deliberately, with a native rebuild afterwards. Check first:
> `git diff <last-deployed-tag>..main -- package.json pnpm-lock.yaml`.

> **Know what root you actually have.** `sudo -n -u mc` is passwordless (`(mc) NOPASSWD: ALL`), and
> root is NOPASSWD-**allowlisted** for exactly: `systemctl restart|start|stop mission-control`,
> `systemctl restart cloudflared`, `systemctl daemon-reload`. So a remote/non-interactive session CAN
> pull, build, restart, and daemon-reload unattended. Anything else as root (writing to
> `/etc/systemd/system`, starting other units) prompts for a password and needs a real TTY. Run
> `sudo -n -l` before concluding you're blocked.

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
> - **If `pnpm install` insists on purging `node_modules`** (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
>   — it needs `CI=true` to proceed non-interactively), the purge **will** delete the
>   hand-compiled better-sqlite3 binding. Back it up first and restore it after; this is
>   faster and safer than a node-gyp rebuild when the package version is unchanged:
>
>   ```bash
>   B=node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release
>   cp "$B/better_sqlite3.node" /tmp/better_sqlite3.node.bak && \
>   CI=true pnpm install --frozen-lockfile
>   mkdir -p "$B" && cp /tmp/better_sqlite3.node.bak "$B/better_sqlite3.node"
>   node -e "const D=require('better-sqlite3');new D('data/mission-control.db',{readonly:true}).close();console.log('binding ok')"
>   ```
>
>   Only valid when the lockfile pins the **same** better-sqlite3 version that produced the
>   backup (check before restoring). Otherwise rebuild with node-gyp as documented above.
>   Still do **not** run `pnpm approve-builds` — the allowlist is intentional.

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

> **Graceful shutdown (v1.19.0+).** The app now handles SIGTERM: it clears the four
> background intervals, destroys the Discord client, aborts in-flight turns started
> through the turn broker — the SSE stream route — (which releases their
> `sessions.running_since` leases) and exits — typically in under 2s. Turns launched
> by the scheduler or the Discord bot call `runSessionTurn` directly, not through the
> broker, so they are **not** currently aborted or waited on by this drain. Before
> this, every stop hung the full `TimeoutStopSec` and was SIGKILLed (15 such timeouts
> in the journal as of 2026-08-11).
>
> The checked-in `deploy/mission-control.service` already carries the settings below,
> so a **fresh install** needs no extra steps here. An **existing install** running an
> older copy of the unit file needs to be patched in place — that's what the `sed`
> commands below are for:
>
> ```ini
> Environment=NEXT_MANUAL_SIG_HANDLE=true
> KillMode=mixed
> TimeoutStopSec=20
> ```
>
> `NEXT_MANUAL_SIG_HANDLE=true` disables Next's own built-in SIGTERM/SIGINT handler,
> which is registered before our shutdown hook runs and otherwise wins the race and
> calls `process.exit(143)` before our drain finishes — a non-zero exit after a
> systemd-requested stop marks the unit **failed**. It must be a real process env var
> (systemd `Environment=`), not a line in the `.env` file loaded via
> `EnvironmentFile=` — Next's own docs call out that the `.env` route is unreliable
> for this.
>
> `KillMode=mixed` sends SIGTERM to the main process only, then SIGKILLs everything
> left in the cgroup once the main process exits — so any orphaned `claude` CLI
> children are reaped by systemd regardless of what the app's own abort path did or
> didn't tear down. `TimeoutStopSec` is now only a backstop. Apply to an existing
> install with:
>
> ```bash
> sudo sed -i 's/^TimeoutStopSec=30$/TimeoutStopSec=20/' /etc/systemd/system/mission-control.service
> sudo sed -i '/^TimeoutStopSec=/i KillMode=mixed' /etc/systemd/system/mission-control.service
> sudo sed -i '/^ExecStart=/i Environment=NEXT_MANUAL_SIG_HANDLE=true' /etc/systemd/system/mission-control.service
> sudo systemctl daemon-reload && sudo systemctl restart mission-control
> ```
>
> **Acceptance:** `journalctl -u mission-control --since "5 min ago" | grep stop-sigterm`
> returns nothing, and `Stopping…` → `Stopped…` is seconds, not 30s.

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
*Configured 2026-08-15. Until then every snapshot lived on the same disk as the database.*

**No rclone, no aws CLI.** `deploy/mc-backup-offsite.sh` signs the request with curl's built-in AWS
SigV4 (`--aws-sigv4`, curl ≥ 7.75; the Mini has 8.5.0), so there is nothing extra to install or keep
patched. Ignore any older instruction here to `apt install rclone`.

1. **Cloudflare dashboard → R2 → Create bucket** (`mc-backups`).
2. **R2 Overview → Account Details panel → API Tokens → Manage → Create API Token.** This is *not*
   the general account API-tokens page — that one yields a Bearer token and cannot produce S3
   credentials. Choose **Object Read & Write**, scoped to the bucket. Deliberately no DELETE:
   retention is an R2 **lifecycle rule** on the bucket, because a backup job that can delete backups
   is how you lose backups.
3. **Record four values in `/srv/mission-control/.env`** (the script reads these names exactly):
   ```
   R2_ACCOUNT_ID=<32-char hex account id>
   R2_BUCKET=mc-backups
   R2_ACCESS_KEY_ID=<32 chars>
   R2_SECRET_ACCESS_KEY=<64 chars>
   ```
   **`R2_ACCOUNT_ID` is the account id, not a token.** The token screen shows a `cfat_…` token value
   far more prominently than the account id, and pasting that produces a 53-char value and a broken
   endpoint. Sanity-check by length: 32 / 10 / 32 / 64. Append as `mc` (passwordless, no TTY needed):
   ```bash
   sudo -u mc tee -a /srv/mission-control/.env >/dev/null <<'EOF'
   R2_ACCOUNT_ID=...
   EOF
   ```
4. **Test by hand before trusting the timer:**
   ```bash
   sudo -u mc bash -lc 'set -a; . /srv/mission-control/.env; set +a; \
     /srv/mission-control/deploy/mc-backup-offsite.sh'
   ```
   Expect `uploaded and verified mc-YYYYMMDD-HHMMSS.db (N bytes)`. The script re-reads the object's
   `Content-Length` and fails on a mismatch rather than trusting the PUT — a backup you have not read
   back is a rumour. Unconfigured, it exits 0 with a message, so it is safe to install early.
5. **Install and enable the nightly timer** (03:45, after the 03:30 local snapshot). Needs real root —
   `install` and `systemctl enable` are not on the NOPASSWD allowlist:
   ```bash
   sudo install -m 644 -o root -g root \
     /srv/mission-control/deploy/mc-backup-offsite.service /etc/systemd/system/
   sudo install -m 644 -o root -g root \
     /srv/mission-control/deploy/mc-backup-offsite.timer /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now mc-backup-offsite.timer
   ```
   It carries `OnFailure=mc-alert@%n.service`, so a failed upload alerts via Phase 4b.

## Phase 4b — Failure alerting (deployed 2026-08-15, v1.21.3)
Exists because `mc-backup.service` failed **49 nights running** (2026-06-26 → 08-14) and nothing said
a word. Any unit worth having is worth knowing about when it breaks.

`deploy/mc-alert@.service` is a **templated** handler: wire it into any unit with
`OnFailure=mc-alert@%n.service` and systemd passes the failed unit's name as the instance. It posts to
Discord if `DISCORD_ALERT_WEBHOOK` is set in `/srv/mission-control/.env`, and always writes to the
journal either way.

**Installing (or re-installing after a pull).** `/etc/systemd/system/*.service` are **copies**, not
symlinks into `/srv/mission-control/deploy/` — a `git pull` changes nothing on its own. The two
`install` commands are **not** on the NOPASSWD allowlist, so they need a real TTY to type a password
into; `daemon-reload` is allowlisted and runs unattended.
```bash
sudo install -m 644 -o root -g root /srv/mission-control/deploy/mc-alert@.service /etc/systemd/system/
sudo install -m 644 -o root -g root /srv/mission-control/deploy/mc-backup.service /etc/systemd/system/
sudo systemctl daemon-reload
```

**Verify:**
```bash
systemctl show mc-backup.service -p OnFailure                    # mc-alert@mc-backup.service.service
systemctl show mc-alert@mc-backup.service -p SupplementaryGroups # systemd-journal
sudo systemctl start mc-alert@mc-backup.service                  # fire it by hand
journalctl -u "mc-alert@mc-backup.service" -n 20 --no-pager      # must show mc-backup's OWN log lines
```
That last check is the whole point. **`SupplementaryGroups=systemd-journal` is load-bearing:** the
handler runs as `mc`, which is in neither `adm` nor `systemd-journal`, so without that line
`journalctl -u <failed-unit>` returns *nothing* and the alert fires with a unit name and the word
"failed" but no reason. Any future unit reading the journal as `mc` needs the same line.

**End-to-end test of the trigger itself** (the manual start above only tests the handler):
```bash
printf '[Unit]\nDescription=alert self-test\nOnFailure=mc-alert@%%n.service\n[Service]\nType=oneshot\nExecStart=/bin/false\n' \
  | sudo tee /etc/systemd/system/mc-alert-selftest.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl start mc-alert-selftest.service
journalctl -u "mc-alert@mc-alert-selftest.service.service" -n 15 --no-pager
sudo rm /etc/systemd/system/mc-alert-selftest.service && sudo systemctl daemon-reload
```

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
