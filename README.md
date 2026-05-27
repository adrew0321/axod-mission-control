# AXOD Mission Control

> Personal command center for orchestrating AI agent teams to do development work.

**Status:** Design phase · pre-build · v1 spec drafted 2026-05-27
**Owner:** [@adrew0321](https://github.com/adrew0321) (AXOD CREATIVE)
**License:** MIT (TBD on release)

## Vision

Open Mission Control. Type a prompt. Say *"I want to build this today."* A team of named agents — coordinated by Sage the orchestrator — starts working. Watch artifacts materialize in the workspace. Never open Claude Code or Antigravity directly.

## Architecture (one paragraph)

A **3-pane web app**: agent-team roster on the left, orchestrator chat in the middle, live workspace tabs (Preview / Code / Plan / Terminal / Research) on the right. Powered by the **Claude Agent SDK** with each agent spawned as an isolated Node child process operating in its own git worktree. **SQLite** for state. **Server-Sent Events** for streaming. Deployed via Docker Compose to a $5/mo VPS, behind Nginx + Let's Encrypt. Future: **OpenClaw** gateway for Discord integration so you can chat with agents from anywhere.

## The team (v1: Sage + Atlas. v1.x: full roster)

| Avatar | Name | Role | Default model | In v1? |
|---|---|---|---|---|
| 🜂 | **Sage** | Orchestrator | Claude Opus 4.7 | ✅ |
| ⚒ | **Atlas** | Lead Developer | Claude Sonnet 4.6 | ✅ |
| ⌕ | **Nova** | Researcher | Sonnet 4.6 + web tools | v1.2 |
| ⛬ | **Echo** | QA Critic | Sonnet 4.6 | v1.3 |
| ◊ | **Pixel** | Designer / Mockups | Sonnet 4.6 | v1.2 |
| ⛁ | **Forge** | DevOps / CI/Deploy | Haiku 4.5 | v1.3 |

## Documents

- **[v1 MVP Spec](docs/specs/v1-mvp-spec.md)** — full scope, architecture, success criteria
- **[Week 1: Walking Skeleton Plan](docs/plans/week-1-walking-skeleton.md)** — day-by-day buildout for the first 5 working days
- **[Team-of-Agents Architecture](docs/architecture/team-of-agents.md)** — how Sage routes work, how agents are isolated, how the team grows
- **[ADR-001: Next.js vs Astro](docs/decisions/adr-001-nextjs-vs-astro.md)** — why Next.js for this project (Astro on the landing page)

## Build phases (5 weeks to v1)

1. **Week 1 — Walking Skeleton** — text input → spawn Claude Code subprocess → stream stdout to page
2. **Week 2 — Single agent end-to-end** — Claude Agent SDK + SQLite + approval gates + worktrees
3. **Week 3 — Sage + team-of-agents** — orchestrator pattern, Atlas as first specialist, team roster sidebar
4. **Week 4 — Workspace tabs** — Preview (iframe), Code (Monaco diff), Plan (markdown), Terminal (xterm.js)
5. **Week 5 — VPS + polish** — Docker, deploy to Hetzner, HTTPS, mobile-responsive, cost meter

## Out of scope for v1

Discord integration · skills hub · MCP audit · trust scoring · RBAC / multi-user · multi-runtime (OpenClaw + CrewAI + LangGraph simultaneously) · memory knowledge graph · recurring scheduler · marketplace / public templates · 32-panel ops dashboard.

These are valuable but premature. See [v1 spec](docs/specs/v1-mvp-spec.md) for the deferred roadmap.

## Quickstart (when v1 ships)

```bash
# clone + install
git clone https://github.com/adrew0321/axod-mission-control.git
cd axod-mission-control
pnpm install

# env
cp .env.example .env
# set: ANTHROPIC_API_KEY, SESSION_SECRET, ADMIN_PASSWORD_HASH

# dev
pnpm dev --host 127.0.0.1
# → http://127.0.0.1:3000

# deploy (Docker)
docker compose up -d
```

## Relationship to AXOD CREATIVE

Mission Control is a **separate project** from the [AXOD CREATIVE landing page](https://github.com/adrew0321/AXODCREATIVE). They're built by the same person, theme-aligned (same fonts, blue palette), but completely independent codebases. Mission Control is *for* AXOD (and eventually clients); AXOD CREATIVE *showcases* AXOD.

The landing page will become the **first repo Mission Control dispatches agents against** (closing the dogfood loop).