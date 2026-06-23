# Home-lab Deploy — design (Mac Mini + Cloudflare Tunnel)

**Date:** 2026-06-11
**Status:** approved (design)
**Goal:** Run Mission Control always-on at `https://bridge.axodcreative.com` on a home Mac Mini,
after Oracle proved unworkable (no A1 capacity + card rejected for PAYG — see
[[oracle-launch-setup]] / `2026-06-10-oracle-deploy-design.md`).

## Why this pivot
Truly-free + always-on + no-card cloud does not exist; Oracle was the only fit and failed on both
capacity and payment. A home device gives always-on for **$0/mo recurring** — the operator owns
the uptime (power + home internet) instead of paying a datacenter for it.

## Decisions (locked)
1. **Host = 2011 Mac Mini A1347** (Intel x86_64, **16 GB RAM**, wired Ethernet), **wiped to
   Ubuntu Server 24.04 LTS**. x86_64 → the app runtime (Node 22, `claude` CLI, `better-sqlite3`)
   runs natively; 16 GB is ample for `pnpm build` + concurrent `claude` subprocesses. macOS is
   not retained (a 2011 Mini tops out at High Sierra — too old for the toolchain).
2. **App runtime unchanged** — host Node + systemd + Claude Pro CLI auth (ADR-003). Steps 1–10 of
   `docs/runbook-deploy.md` apply verbatim on Ubuntu 24.04.
3. **Ingress = Cloudflare Tunnel** (not a public IP + Caddy). `cloudflared` runs as a systemd
   service making an **outbound** connection to Cloudflare, which routes
   `bridge.axodcreative.com → localhost:3000` with automatic HTTPS. **No inbound ports** opened on
   the home router (`ufw` = SSH only). Requires the domain on Cloudflare — it already is, so the
   tunnel auto-creates the `bridge` DNS record. **Replaces Caddy + the public-IP/firewall steps.**
4. **Cloud = source of truth**, data migrated once at setup (DB via WAL-checkpointed `scp`; repos
   `axod-chat`, `landing`/AXODCREATIVE, `axod-research-agent` via `git clone`; skip `test-browser`).
   Identical to the Oracle plan's §A.
5. **Offsite backups = Cloudflare R2** (free 10 GB, S3-compatible) instead of Oracle Object
   Storage — natural since we're already on Cloudflare. Nightly rclone push of the local snapshot.

## Topology
```
client (anywhere) → https://bridge.axodcreative.com → Cloudflare (TLS + DNS)
  → Cloudflare Tunnel (outbound from the Mini; no open ports)
     → Mac Mini / Ubuntu 24.04 (LAN, wired)
        → mission-control :3000 (systemd) + node/pnpm/claude CLI (Pro auth)
        → SQLite + per-session worktrees ; nightly local backup → rclone → R2
```

## Artifacts
- **`docs/runbook-deploy-homelab.md`** — the operator runbook (USB install → deploy → tunnel →
  R2 → verify). Reuses `docs/runbook-deploy.md` steps 1–10 for the shared app deploy.
- Reuse unchanged: `deploy/mission-control.service`, `deploy/mc-backup.{sh,service,timer}`,
  `.env.example`, `scripts/deploy.sh`. (Caddyfile + the offsite-PAR script are unused on this host;
  R2 upload is an rclone one-liner wired into a timer.)
- ADR-003 already covers host-Node; the Cloudflare-Tunnel ingress is a host-specific note here, not
  a new decision.

## Verify (acceptance)
`https://bridge.axodcreative.com/api/health` = 200 from a phone on **cellular** (proves off-home,
desktop-independent) → log in with the migrated admin → run one agent turn → **power-cycle the Mini
and confirm services auto-recover** (the always-on guarantee).

## Out of scope / risks
- Uptime bounded by home power + internet (a small UPS mitigates power blips — later).
- No server-side turn runner (agent turns still need a browser SSE stream open — [[turns-require-client-sse]]).
- R2 stays within the free tier (10 GB) — backups are sub-MB, so no cost.
