# VPS Deploy — design

**Date:** 2026-06-07
**Status:** approved (design)
**Goal:** Run Mission Control on the Hetzner box at `https://mc-dev.axodcreative.com` so the
operator can use it from anywhere, not just locally.

## Decisions (locked during brainstorm)

1. **Execution model = artifacts + runbook.** I produce committed, repeatable files; the
   operator runs the steps on the box. No credentials leave the operator's machine; I do
   not SSH in.
2. **Box state unknown** → the runbook is **idempotent and self-checking** (detects what's
   installed, installs only what's missing, safe to re-run).
3. **Runtime = host Node + Caddy + systemd** (NOT Docker). The agent runtime is heavily
   host-coupled (spawns the `claude` CLI, creates a git worktree per session, runs
   `pnpm build`/preview servers binding ports, writes SQLite on disk, operates on multiple
   project repos at host paths). Running natively avoids container plumbing for all of that.
   **This deviates from ADR-002's "Docker Compose" lock** (which predates the agent runtime
   built in weeks 2–4); recorded as an ADR addendum (see §8).
4. **Agent auth = Claude Pro subscription on the box** (the operator is on Pro). The
   SDK-spawned `claude` CLI authenticates against the Pro subscription so deployed agent
   turns draw on Pro's included usage — **no metered per-token API billing**. The only
   recurring cost is the VPS (~$5–8/mo). **Honesty caveat:** subscription auth on a headless
   server works via the `claude` CLI token login but is the less-trodden path; the runbook
   tries it first and falls back to a metered `ANTHROPIC_API_KEY` only if the headless SDK
   refuses it. Pro's **usage limits** (not a dollar amount) are the real throughput ceiling.
5. **Reverse proxy = Caddy** (one-line automatic Let's Encrypt TLS), not Nginx+certbot.
6. **Deploy = manual idempotent `scripts/deploy.sh` + runbook** for v1 (no CI push-to-deploy yet).

## 1. Topology

```
Internet
  → Caddy :80/:443  (systemd; automatic Let's Encrypt TLS; reverse-proxy)
       → mission-control :3000  (systemd service; `pnpm start` = next start)
            ├ node 22 + pnpm + git + claude CLI (Pro-authed) on PATH
            ├ data/  → SQLite (WAL) + per-session git worktrees
            └ /srv/projects/<repo>  → the repos agents operate on
```
Everything runs on the single Hetzner CX22 (Ubuntu 24.04).

## 2. Filesystem + user

- Dedicated **non-root `mc` user** owns and runs the app (least privilege).
- `/srv/mission-control` — the git clone (app code).
- `/srv/mission-control/data` — SQLite db + `worktrees/` (per-session).
- `/srv/projects` — project repos Mission Control manages (e.g. a clone of this repo, AXOD
  Creative, etc.); each becomes a project via the in-app switcher pointing at its path.
- `/srv/backups` — nightly SQLite snapshots.
- Root is used only for package installs, `ufw`, and installing the systemd/Caddy units.

## 3. Environment / secrets

A `mc`-owned, non-world-readable `/srv/mission-control/.env`, loaded by systemd via
`EnvironmentFile`. Committed template is `.env.example` (the real `.env` is gitignored).

| Var | Value | Notes |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` | **Required**; `getSecret()` throws if <32 chars |
| `DATABASE_PATH` | `/srv/mission-control/data/mission-control.db` | else defaults to `./data/...` |
| `WORKTREE_ROOT` | `/srv/mission-control/data/worktrees` | else defaults under cwd |
| `NODE_ENV` | `production` | makes session cookies `secure` → HTTPS-only login |
| `PORT` | `3000` | `next start` port Caddy proxies to |
| `ANTHROPIC_API_KEY` | *(fallback only)* | omit when using Pro auth; set only if §4 fallback |

Claude Pro auth is **not** an env var — it's a CLI token login done once on the box (§5).

## 4. Artifacts to produce (committed to the repo)

- `deploy/Caddyfile` — `mc-dev.axodcreative.com { reverse_proxy localhost:3000 }`.
- `deploy/mission-control.service` — systemd unit: `WorkingDirectory=/srv/mission-control`,
  `EnvironmentFile=/srv/mission-control/.env`, `ExecStart=<pnpm> start`, `User=mc`,
  `Restart=on-failure`, `After=network.target`.
- `deploy/mc-backup.sh` + `deploy/mc-backup.service` + `deploy/mc-backup.timer` — nightly
  `sqlite3 <db> ".backup"` into `/srv/backups`, keep last 7.
- `.env.example` — the table in §3.
- `scripts/deploy.sh` — idempotent update: `git pull` → `pnpm install --frozen-lockfile` →
  `pnpm build` → `pnpm db:migrate` → `sudo systemctl restart mission-control`.
- `docs/runbook-deploy.md` — the operator's step-by-step (§5).
- `docs/decisions/adr-003-deploy-host-node.md` — addendum to ADR-002 (§8).

## 5. The runbook (idempotent; safe to re-run)

Each step checks before acting. Ordered:

1. **System packages (root):** ensure `curl git build-essential python3 ufw` (build tools +
   python3 are needed for the **`better-sqlite3` native build** under this repo's
   `ignore-scripts=true` `.npmrc` — see the pnpm-hardening note).
2. **Node 22 + pnpm:** install Node 22 (nodesource or fnm) if absent; `corepack enable` / pnpm.
3. **`claude` CLI:** install Claude Code globally if absent; verify `claude --version`.
4. **`mc` user + dirs:** create `mc`, `/srv/mission-control`, `/srv/projects`, `/srv/backups`
   with correct ownership.
5. **Clone repo** into `/srv/mission-control` (or `git pull` if present); checkout `main`.
6. **`.env`:** copy `.env.example` → `.env`; generate `SESSION_SECRET`; set paths/NODE_ENV/PORT.
7. **Install + build:** `pnpm install --frozen-lockfile` (handle the `better-sqlite3` rebuild
   per the repo's `onlyBuiltDependencies` allowlist / `pnpm rebuild better-sqlite3`); `pnpm build`.
8. **DB:** `pnpm db:migrate`; then **`pnpm seed:admin`** to create a real production admin
   (do NOT use the seeded `test@axodcreative.com`).
9. **Claude Pro auth (as `mc`):** run the `claude` device/token login so the CLI is authed to
   the Pro subscription; verify a trivial `claude` call succeeds. **Fallback:** if the
   headless SDK won't use subscription auth, put `ANTHROPIC_API_KEY` in `.env` instead.
10. **systemd:** install `mission-control.service`, `mc-backup.{service,timer}`; `daemon-reload`;
    enable + start; confirm the service is listening on :3000.
11. **Caddy:** install Caddy; drop in the `Caddyfile`; reload; it auto-provisions TLS once DNS
    resolves.
12. **Firewall:** `ufw allow OpenSSH 80 443`; enable.
13. **DNS:** point `mc-dev.axodcreative.com` (A record) at the box's IP (operator action at
    their DNS provider).
14. **Verify:** `https://mc-dev.axodcreative.com/api/health` returns 200; log in with the
    seeded prod admin; run one agent turn and confirm it streams.

## 6. Update flow (after first deploy)

`ssh` to the box → `cd /srv/mission-control` → `./scripts/deploy.sh` (pull, install, build,
migrate, restart). Caddy + DNS untouched on updates.

## 7. Error handling / safety

- `SESSION_SECRET` missing/short → app throws on boot; the runbook generates it before first start.
- `NODE_ENV=production` → cookies are `secure`; login only works over HTTPS (via Caddy), not
  raw `http://IP:3000`. Documented so it isn't mistaken for a bug.
- The agent's git worktrees land under `WORKTREE_ROOT` on a throwaway `mc/<session>` branch —
  isolation already built; no extra prod handling needed.
- Backups are local-only in v1; restore = stop service, copy snapshot over the db, start.
- No automated tests for infra; verification is the runbook's step 14 (manual smoke).

## 8. ADR addendum (adr-003)

Record that v1 deploys as **host Node + Caddy + systemd**, superseding ADR-002 decision #3/#6's
"Docker Compose" assumption, because the agent runtime (built after ADR-002) is host-coupled.
Revisit triggers: needing multi-node, or wanting hard isolation between projects.

## 9. Out of scope (later)

GitHub Actions push-to-deploy · offsite B2 backups · Uptime Robot · login rate-limiting ·
the `mc.axodcreative.com` promotion (needs AXOD issue #16) · Docker packaging.
