# Oracle Always-Free Deploy — design

**Date:** 2026-06-10
**Status:** approved (design)
**Goal:** Run Mission Control on an Oracle Cloud **Always Free** VM at
`https://bridge.axodcreative.com`, so the operator can use it from anywhere — independent of
whether the local machine is on.

## Relationship to the existing VPS deploy

This is the **Oracle variant** of the already-approved
[`2026-06-07-vps-deploy-design`](2026-06-07-vps-deploy-design.md) and its runbook
(`docs/runbook-deploy.md`). The **app runtime model is unchanged**: host Node + Caddy +
systemd + Claude Pro CLI auth (per [ADR-003](../../decisions/adr-003-deploy-host-node.md)).
~80% of the existing runbook carries over verbatim. This spec records only the **Oracle-specific
deltas** and the two new choices (hostname, real admin).

## Decisions (locked during brainstorm)

1. **Host = Oracle Cloud Always Free, `VM.Standard.A1.Flex` (ARM Ampere), 2 vCPU / 12 GB,
   Ubuntu 24.04.** Chosen over the x86 `E2.1.Micro` (1 vCPU / 1 GB) because the 1 GB box
   fights `pnpm build` and multi-agent `claude` subprocesses. A1.Flex is resizable, so 2/12 →
   4/24 later is a free stop/resize/start (not a one-way door). arm64 is transparent: Node 22,
   pnpm, the `claude` CLI, and `better-sqlite3` (already built from source under this repo's
   `ignore-scripts=true` `.npmrc`) all support it.
2. **Hostname = `bridge.axodcreative.com`** (new; not the old `mc-dev.` dev host).
3. **Admin = real admin via interactive `pnpm seed:admin`** on the box's fresh DB. The seeded
   `test@axodcreative.com` only exists in the local dev DB and will **not** be present on the
   new box (fresh `db:migrate`). No test credentials in production.
4. **Cost = free.** Oracle Always Free has no time limit; identity verification needs a
   **credit/debit card (not charged on always-free) and no passport**. Recurring cost is $0
   for the host; agent throughput is bounded by Claude Pro usage limits (Pro CLI auth, metered
   `ANTHROPIC_API_KEY` only as fallback) — same as ADR-003.
5. **Runbook = new `docs/runbook-deploy-oracle.md`** (separate from the Hetzner runbook; the
   connect/firewall/IP steps differ enough that a clean Oracle-only file beats inline branching).
6. **OS firewall = `ufw`, flushing Oracle's restrictive default iptables**, so the OS layer
   matches the existing runbook's `ufw` step rather than maintaining Oracle's stock iptables.

## Oracle-specific deltas (the only new content vs. the Hetzner runbook)

### D1 — Provision the instance (new "step 0")
- Create an Always Free `VM.Standard.A1.Flex`: Ubuntu 24.04, **2 vCPU / 12 GB**.
- No root password — provide/generate an **SSH key pair** at creation. Default user is
  `ubuntu`; privileged steps run via `sudo` (`ssh ubuntu@<ip>` → `sudo -i`). The existing
  runbook's "run as root" maps to this.
- **Capacity note:** A1 can return "out of host capacity." 2/12 is far easier to get than the
  maxed 4/24; retry or try another availability domain if blocked.

### D2 — The double firewall (Oracle's #1 gotcha)
Opening `ufw` on the box is **not sufficient** on Oracle. Ports must be opened in **both**
layers, and the runbook treats this as an explicit, checked step:
- **Cloud layer — VCN Security List / NSG:** add **ingress rules for TCP 80 and 443**
  (SSH 22 open by default). Operator action in the Oracle console.
- **OS layer:** Oracle's Ubuntu image ships restrictive **iptables** rules (plus `ufw`) that
  block all but SSH. Per decision #6, flush the default iptables and drive ingress through
  `ufw allow OpenSSH 80 443`.

This is the most common cause of "deploy succeeded but the site won't load," so it is called
out as its own verified step.

### D3 — Reserve a static public IP
Oracle's default public IP is **ephemeral** (can change on stop/start). **Reserve** the public
IP (free, one included) so the `bridge.axodcreative.com` A-record stays valid across reboots.

### D4 — DNS
Point `bridge.axodcreative.com` (A record) at the **reserved** IP at the DNS provider. Then
identical to the Hetzner flow: `dig +short bridge.axodcreative.com` → watch Caddy issue TLS.

## Carried over unchanged (from `docs/runbook-deploy.md`)

Steps 1–12 of the existing runbook apply as-is on Ubuntu 24.04, with `mc-dev.axodcreative.com`
→ `bridge.axodcreative.com` and "root" → "`sudo`":

1. System packages (`curl git build-essential python3 ufw sqlite3 …`).
2. Node 22 + pnpm (corepack).
3. `claude` CLI (global install).
4. `mc` user + `/srv/{mission-control,projects,backups}`.
5. Clone repo → checkout `main`.
6. `.env` (`SESSION_SECRET` via `openssl rand -hex 32`; `DATABASE_PATH`, `WORKTREE_ROOT`,
   `NODE_ENV=production`, `PORT=3000`).
7. `pnpm install --frozen-lockfile` (+ `pnpm rebuild better-sqlite3` if the native load fails);
   `pnpm build`.
8. `pnpm db:migrate`; **`pnpm seed:admin`** → real admin.
9. Claude Pro CLI auth on the box (device/token login); `ANTHROPIC_API_KEY` fallback.
10. systemd `mission-control.service` + `mc-backup.{service,timer}`; enable + start.
11. Caddy reverse-proxy (`deploy/Caddyfile` → `bridge.axodcreative.com { reverse_proxy
    localhost:3000 }`) + auto-HTTPS.
12. `ufw allow OpenSSH 80 443; ufw --force enable`.

`scripts/deploy.sh` (pull → install → build → migrate → restart) is reused unchanged for updates.

## Topology

```
Internet
  → [Oracle VCN Security List: ingress 80/443/22]      ← cloud firewall (D2)
     → Oracle A1.Flex VM (Ubuntu 24.04, arm64, reserved public IP)
          → ufw (80/443/22)                            ← OS firewall (D2/D6)
             → Caddy :80/:443 (systemd; auto Let's Encrypt TLS)
                → mission-control :3000 (systemd; `pnpm start`)
                     ├ node 22 + pnpm + git + claude CLI (Pro-authed)
                     ├ data/ → SQLite (WAL) + per-session git worktrees
                     └ /srv/projects/<repo> → repos agents operate on
```

## Artifacts to produce

- **`deploy/Caddyfile`** — change site to `bridge.axodcreative.com { reverse_proxy
  localhost:3000 }`. (Single hostname; the existing Hetzner host is retired, not run in parallel.)
- **`docs/runbook-deploy-oracle.md`** — new operator runbook: D1 (provision) → D2 (both
  firewalls) → D3 (reserve IP) → carried-over steps → D4 (DNS) → verify.
- **`docs/decisions/adr-003-deploy-host-node.md`** — small amendment noting the deploy target
  is now an **Oracle Always-Free A1 (arm64)** rather than Hetzner CX22; the host/Caddy/systemd
  **decision itself is unchanged** (this is a target-host note, not a re-decision).
- Reuse unchanged: `deploy/mission-control.service`, `deploy/mc-backup.{sh,service,timer}`,
  `.env.example`, `scripts/deploy.sh`.

## Verify (acceptance)

`https://bridge.axodcreative.com/api/health` returns 200 from a machine **other than** the
local desktop (proving local-independence) → log in with the real seeded admin → run one agent
turn and confirm it streams over the SSE connection.

## Error handling / safety

- Same as the Hetzner design: `SESSION_SECRET` generated before first boot; `NODE_ENV=production`
  cookies are HTTPS-only (login only works via Caddy/HTTPS, not raw `http://IP:3000`); agent
  worktrees isolated under `WORKTREE_ROOT` on throwaway `mc/<session>` branches; nightly local
  SQLite backups (restore = stop service, copy snapshot, start).
- **Oracle-specific:** if the site is unreachable after a clean deploy, **check the VCN Security
  List first** (D2 cloud layer) — it's the most common failure and is invisible to on-box checks.
- **SSE caveat (carried from memory):** agent turns only run while a browser holds the SSE
  stream open; there is no server-initiated turn path. This is fine for the "use from anywhere
  via browser" goal, but means cron-driven server-side turns remain out of scope.

## Out of scope (later)

GitHub Actions push-to-deploy · offsite backups · uptime monitoring · login rate-limiting ·
server-side turn runner (for cron/Scheduler) · bumping the A1 to 4 vCPU / 24 GB · running the
old Hetzner host in parallel.
