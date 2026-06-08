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
