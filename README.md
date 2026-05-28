# AXOD Mission Control

> Personal command center for orchestrating AI agent teams to do development work.

**Status:** Week 1 walking skeleton complete · v0.1 in progress
**Owner:** [@adrew0321](https://github.com/adrew0321) (AXOD CREATIVE)
**License:** MIT (applied on first public release)

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
- **[Week 1: Walking Skeleton Plan](docs/plans/week-1-walking-skeleton.md)** — day-by-day buildout for the first 5 working days (with post-hoc "what actually happened" notes per day)
- **[Week 2: Single-agent SDK Plan](docs/plans/week-2-single-agent-sdk.md)** — port from CLI subprocess to `@anthropic-ai/claude-agent-sdk`
- **[Week 3: Team-of-agents Plan](docs/plans/week-3-team-of-agents.md)** — Sage dispatches Atlas; resolves the deferred approval gate + worktree wiring
- **[Team-of-Agents Architecture](docs/architecture/team-of-agents.md)** — how Sage routes work, how agents are isolated, how the team grows
- **[ADR-001: Next.js vs Astro](docs/decisions/adr-001-nextjs-vs-astro.md)** — why Next.js for this project (Astro on the landing page)
- **[ADR-002: v1 platform locks](docs/decisions/adr-002-v1-platform-locks.md)** — repo / license / domain / VPS / gateway / CI

## Build phases (5 weeks to v1)

1. **Week 1 — Walking Skeleton** ✅ — text input → spawn Claude Code subprocess → stream stdout to page
2. **Week 2 — Single agent end-to-end** — Claude Agent SDK + SQLite + approval gates + worktrees
3. **Week 3 — Sage + team-of-agents** — orchestrator pattern, Atlas as first specialist, team roster sidebar
4. **Week 4 — Workspace tabs** — Preview (iframe), Code (Monaco diff), Plan (markdown), Terminal (xterm.js)
5. **Week 5 — VPS + polish** — Docker, deploy to Hetzner, HTTPS, mobile-responsive, cost meter

## Out of scope for v1

Discord integration · skills hub · MCP audit · trust scoring · RBAC / multi-user · multi-runtime (OpenClaw + CrewAI + LangGraph simultaneously) · memory knowledge graph · recurring scheduler · marketplace / public templates · 32-panel ops dashboard.

These are valuable but premature. See [v1 spec](docs/specs/v1-mvp-spec.md) for the deferred roadmap.

## Quickstart (Week 1 walking skeleton)

**Requirements:**
- Node 22+ (see `.nvmrc`)
- pnpm 11+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- The `claude` CLI on `PATH` (`npm i -g @anthropic-ai/claude-code`)
- An Anthropic API key (or a `claude` install already logged in)

```bash
# clone + install
git clone https://github.com/adrew0321/axod-mission-control.git
cd axod-mission-control
pnpm install

# database
mkdir -p data
node node_modules/drizzle-kit/bin.cjs migrate
pnpm seed                 # demo project + Sage/Atlas agents + demo session

# env
cp .env.example .env
# set ANTHROPIC_API_KEY (only needed if `claude` isn't already authed)
# SESSION_SECRET is auto-generated; rotate with:
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# create an operator account (interactive prompt)
pnpm seed:admin

# start the dev server
pnpm dev
# → http://127.0.0.1:3000
# → you'll be redirected to /login; sign in with the account you just seeded
# → type a prompt; watch Sage stream a response token-by-token
```

**Verify the install:**
```bash
curl http://localhost:3000/api/health
# → { "status": "ok", "db": "ok", ... }
```

**Native build note:** the project's `.npmrc` ships with `ignore-scripts=true` (npm-supply-chain hardening). `better-sqlite3` needs a native binding compiled on first install; do this once:

```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
npx --no prebuild-install
```

This is captured in [`pnpm-workspace.yaml`'s `onlyBuiltDependencies`](pnpm-workspace.yaml), but the `.npmrc` setting overrides it for safety. Re-run after any `pnpm install` that re-extracts the package.

## Project layout

```
src/
  app/
    api/
      auth/{login,logout}/route.ts    # scrypt password verify → JWT cookie
      health/route.ts                 # uptime-robot endpoint (unauthenticated)
      sessions/[id]/messages/route.ts # POST a user message
      sessions/[id]/stream/route.ts   # GET SSE stream of agent response
    login/                            # /login page + form
    page.tsx                          # Server Component, reads DB → MissionControl
    layout.tsx                        # fonts + dark theme
  components/
    mission-control.tsx               # the 3-pane interactive UI (Client Component)
    ui/                               # shadcn primitives
  db/
    schema.ts                         # Drizzle SQLite schema (9 tables)
    client.ts                         # better-sqlite3 + drizzle wiring
  lib/
    auth.ts, auth-edge.ts             # session + cookie helpers
    password.ts                       # scrypt hash/verify (shared with seed script)
    rate-limit.ts                     # in-memory IP bucket
    agent-runner-stub.ts              # spawn `claude` CLI, parse stream-json
    mock-data.ts                      # types + the bits the DB doesn't store yet (artifacts)
  proxy.ts                            # Next 16 proxy (renamed from middleware)
scripts/
  seed.ts                             # demo data
  seed-admin.ts                       # interactive operator account creator
drizzle/                              # generated migration SQL + journal
docs/
  specs/v1-mvp-spec.md
  plans/week-1-walking-skeleton.md
  plans/week-2-single-agent-sdk.md
  decisions/                          # ADRs
  architecture/team-of-agents.md
```

## Relationship to AXOD CREATIVE

Mission Control is a **separate project** from the [AXOD CREATIVE landing page](https://github.com/adrew0321/AXODCREATIVE). They're built by the same person, theme-aligned (same fonts, blue palette), but completely independent codebases. Mission Control is *for* AXOD (and eventually clients); AXOD CREATIVE *showcases* AXOD.

The landing page is the **first repo Mission Control dispatches agents against** (closing the dogfood loop).
