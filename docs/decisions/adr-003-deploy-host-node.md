## ADR-003: v1 deploys as host Node + Caddy + systemd (addendum to ADR-002)

> **Status:** Accepted — core decision live; host/proxy evolved (see update)
> **Date:** 2026-06-07
>
> **Update (2026-06-26):** the host-Node + systemd + Claude-Pro-CLI-auth core decision stands and is in production. Two specifics changed since: the **host** moved Hetzner → Oracle → **home Mac Mini**, and **Caddy was replaced by a Cloudflare named tunnel** (no public IP, no open ports, so no reverse proxy/TLS to manage). Current deploy: [runbook-deploy-homelab.md](../runbook-deploy-homelab.md).
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
