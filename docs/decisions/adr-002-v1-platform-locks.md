## ADR-002: v1 platform locks (repo, license, domain, hosting, gateway, CI)

> **Status:** Accepted
> **Date:** 2026-05-27
> **Deciders:** [@adrew0321](https://github.com/adrew0321) (operator)
> **Companion ADRs:** [ADR-001](adr-001-nextjs-vs-astro.md) (Next.js choice)

### Context

The Week 1 plan ([docs/plans/week-1-walking-skeleton.md](../plans/week-1-walking-skeleton.md)) lists a half-dozen platform-level questions that need answers before Week 2 work depends on them: repo visibility, license, domain, VPS, AI gateway, CI provider. None of these individually warrants a full ADR (most were decided in <5 min during spec drafting), but recording them in one place avoids relitigation and gives Week 2-5 work something to point at.

### Decisions

| # | Question | Decision | Trigger to revisit |
|---|---|---|---|
| 1 | **Repo visibility** | Private until v0.1 is shipped + the operator wants to share publicly. | Either of: (a) v0.1 ships AND the operator decides this is shareable, or (b) external contributors get involved earlier. |
| 2 | **License** | MIT, applied at first public release. License file already in the repo from initial scaffold. | First public release. |
| 3 | **Production domain** | `mc-dev.axodcreative.com` (a DNS record → the Hetzner VPS, behind Nginx + Let's Encrypt) for early access. Promote to `mc.axodcreative.com` after AXOD CREATIVE issue #16 (custom-domain DNS work) ships. **Not** a Cloudflare Pages deployment — Mission Control is a long-running Node server and can't run on Pages; if Cloudflare is used at all here it's only as DNS / proxy in front of the Hetzner origin. | AXOD CREATIVE issue #16 closes. |
| 4 | **VPS provider** | Hetzner. Smallest CX22 box ($5/mo). Already provisioned during pre-week setup. | Cost > $50/mo OR Mission Control needs more than a single node (multi-region, geo-redundancy). |
| 5 | **AI gateway** | Direct Anthropic API (`https://api.anthropic.com`) for v1. No Cloudflare AI Gateway, no LiteLLM, no proxy layer. | Either: monthly Anthropic bill > $200 (then add a gateway for caching + observability), OR we add a non-Anthropic model (then we need routing). |
| 6 | **CI provider** | GitHub Actions. Free tier covers this repo's load. Workflow runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm tsc --noEmit` on every push and PR to `main`. | Either: GH Actions free minutes exhausted, OR we want self-hosted runners for the deploy step. |

### Rationale (one line each)

1. **Private** — nothing to gain from public yet; we still have hardcoded paths, in-progress auth, and no docs for outsiders. Public when it stops being embarrassing.
2. **MIT** — operator-friendly default for personal tooling that may go open-source. Not GPL (no copyleft need), not Apache (no patent grant need).
3. **`mc-dev.axodcreative.com`** — a staging subdomain pointing (A/CNAME, optionally Cloudflare-proxied) at the Hetzner box. Earlier drafts said `mc-dev.axodcreative.pages.dev`, but that implies a Cloudflare Pages deploy — impossible here (child-process spawns, `better-sqlite3` on local disk, long-lived SSE, local git worktrees all require a real VM). Promote to the `mc.axodcreative.com` apex/subdomain once issue #16's DNS work lands.
4. **Hetzner** — cheapest reputable EU-based provider, supports Docker, 1-min provision. Was already provisioned in pre-week so the switching cost is now zero.
5. **Direct Anthropic** — one less moving part. Cloudflare AI Gateway and LiteLLM are valuable but not until cost or observability becomes a real problem.
6. **GitHub Actions** — repo already on GitHub; second-system tax of a different CI is not worth the cost saving (which is zero for our volume).

### Consequences

- Week 2-5 work can assume: GitHub remote, Hetzner box, direct Anthropic, MIT-friendly, private-during-build.
- The Week 5 deploy plan can stop debating "where" and focus on "how" (Docker Compose + Nginx + Let's Encrypt).
- Documentation and code can reference these decisions without re-deriving them.

### Out of scope

- Database hosting (we're on SQLite, no hosting decision required for v1).
- Frontend hosting (the Next.js app runs on the same Hetzner box as the agent runtimes — no separate Vercel/Cloudflare frontend deploy).
- Observability (Uptime Robot for the health endpoint is the only thing planned; full APM is post-v1).
