# AXOD Mission Control

> Personal command center for orchestrating AI agent teams to do development work.

**Status:** Weeks 1–4 released to `main` · **Echo (QA agent) + orchestrator session memory** landed on `dev` · Week 5 (VPS deploy) next · v1 ≈ 90%
**Owner:** [@adrew0321](https://github.com/adrew0321) (AXOD CREATIVE)
**License:** MIT (applied on first public release)

## Vision

Open Mission Control. Type a prompt. Say *"I want to build this today."* A team of named agents — coordinated by Sage the orchestrator — starts working. Watch artifacts materialize in the workspace. Never open Claude Code or Antigravity directly.

## Architecture (one paragraph)

A **3-pane web app**: agent-team roster on the left, orchestrator chat in the middle, live workspace tabs (Preview / Plan / Code / Terminal) on the right. Powered by the **Claude Agent SDK** — Sage runs as the orchestrator and dispatches specialists (currently Atlas) via an in-process `dispatch_agent` MCP tool; each specialist runs through the SDK in the session's **isolated git worktree**. **SQLite** (WAL, via Drizzle) for state. **Server-Sent Events** for streaming. Below `md` the layout collapses to a tab-switched mobile view. Next up: Docker Compose deploy to a Hetzner VPS behind Nginx + Let's Encrypt. Future: **OpenClaw** gateway for Discord so you can chat with agents from anywhere.

## The team

The roster is **DB-driven** — each agent is a row in the `agents` table (id, role, model, system prompt, tool allowlist, color). The UI already renders icons + accent colors for all six; the gate on *dispatching* a new specialist is the `DISPATCHABLE` allowlist + any new tool types it needs (see [Growing the team](#growing-the-team)).

| Avatar | Name | Role | Default model | Status |
|---|---|---|---|---|
| 🜂 | **Sage** | Orchestrator | Claude Opus 4.7 | ✅ shipped |
| ⚒ | **Atlas** | Lead Developer | Claude Sonnet 4.6 | ✅ shipped |
| ⛬ | **Echo** | QA Critic | Sonnet 4.6 | ✅ shipped (on `dev`) |
| ⌕ | **Nova** | Researcher | Sonnet 4.6 + web tools | v1.2 |
| ⛁ | **Forge** | DevOps / CI / Deploy | Haiku 4.5 | v1.3 |
| ◊ | **Pixel** | Designer / Mockups | Sonnet 4.6 | v1.3 |

> **Echo shipped** as the first post-v1 agent (it needed **zero new tool plumbing** — `read_file` + `run_command` — and closes the quality loop on Atlas's diffs). Nova and Pixel, which need new web-search / image-generation tools, are next. See [where we're going](#where-were-going).

## Build phases (5 weeks to v1)

1. **Week 1 — Walking Skeleton** ✅ — text input → spawn `claude` subprocess → stream stdout to page
2. **Week 2 — Single agent end-to-end** ✅ — Claude Agent SDK + SQLite + tool allowlist + worktrees + stop/abort
3. **Week 3 — Sage + team-of-agents** ✅ — `dispatch_agent` orchestration, Atlas as first specialist, live per-agent roster state, live worktree diff
4. **Week 4 — Workspace tabs** ✅ — Preview (build-and-serve), Code (Monaco diff, collapsible file list), Plan (live `TodoWrite` checklist), Terminal (live streamed output) · **mobile-responsive** layout
5. **Week 5 — VPS deploy + dogfood ship** ⏳ — Docker Compose → Hetzner, Nginx + HTTPS, ship one real AXOD CREATIVE change end-to-end

### v1 finish line (what's left)

Of the 10 v1 success criteria, only **two** remain (see [v1 spec](docs/specs/v1-mvp-spec.md)):

- **#8** — running on the VPS with HTTPS
- **#10** — ship at least one real AXOD CREATIVE change through the UI (the dogfood loop)

Everything else — Sage→Atlas auto-routing, diff review, worktree isolation, session resume, cost/token meter, and mobile-responsiveness — is done and released.

## Where we're going

**Strategy: finish v1 before expanding the team.** The team-of-agents pattern is already proven with Atlas, so adding agents is low-risk and can happen anytime; deploy is the thing gated by a definition of done, so it goes first.

| Version | Adds | Notes |
|---|---|---|
| **v1 (now)** | VPS deploy + HTTPS + one dogfood ship | Closes v1's definition of done |
| **v1.1** ✅ | **Echo** (QA critic) — shipped on `dev` | First post-v1 agent; no new tools — proved the "3rd agent" path. Session memory landed alongside it. |
| **v1.2** | **Nova** (researcher) | Build the `web_search` / `web_fetch` tool plumbing |
| **v1.3** | **Forge** (devops) + **Pixel** (designer) | Forge reuses git tooling; Pixel needs `image_generate` |
| **v1.4** | Multi-project switcher | Mission Control itself + client repos |
| **v1.5** | Discord via OpenClaw gateway | Chat with agents from anywhere |
| **v2.0+** | Multi-runtime · RBAC · memory knowledge graph · recurring scheduler · marketplace | See [v1 spec deferred roadmap](docs/specs/v1-mvp-spec.md) |

<a name="growing-the-team"></a>
### Growing the team (how a new agent gets added)

Adding a specialist that uses **existing** tools (read / edit / run_command / git) is cheap:

1. **Seed the row** in the `agents` table — id, name, role, model, system prompt, tool allowlist, color.
2. **Add the id to `DISPATCHABLE`** in [`src/lib/dispatch.ts`](src/lib/dispatch.ts) so Sage may dispatch it (the enum prevents Sage inventing agents).
3. **Update Sage's system prompt** so it knows the new member exists and when to route to them.
4. Seed a `tool_permissions` policy (`always` / `ask` / `deny`) per (agent, project, tool).

No UI changes needed — the roster, icons, and accent colors for Nova / Echo / Pixel / Forge are already wired in `mission-control.tsx`. Agents needing **new tool types** (Nova's web search, Pixel's image gen) additionally require wiring those tools into the runner first. See [Team-of-Agents Architecture](docs/architecture/team-of-agents.md).

## Documents

- **[v1 MVP Spec](docs/specs/v1-mvp-spec.md)** — full scope, architecture, data model, success criteria, deferred roadmap
- **[Team-of-Agents Architecture](docs/architecture/team-of-agents.md)** — how Sage routes work, how agents are isolated, how the team grows
- **Week plans** (each with post-hoc "what actually happened" notes):
  [Week 1 — Walking Skeleton](docs/plans/week-1-walking-skeleton.md) ·
  [Week 2 — Single-agent SDK](docs/plans/week-2-single-agent-sdk.md) ·
  [Week 3 — Team of agents](docs/plans/week-3-team-of-agents.md) ·
  [Week 4 — Workspace tabs](docs/plans/week-4-workspace-tabs.md)
- **Design specs** — [`docs/superpowers/specs/`](docs/superpowers/specs/) (per-feature design docs: terminal tab, live Plan, mobile layout, collapsible diff, …)
- **ADRs** — [ADR-001: Next.js vs Astro](docs/decisions/adr-001-nextjs-vs-astro.md) · [ADR-002: v1 platform locks](docs/decisions/adr-002-v1-platform-locks.md)

## Out of scope for v1

Discord integration · skills hub · MCP audit · trust scoring · RBAC / multi-user · multi-runtime (OpenClaw + CrewAI + LangGraph simultaneously) · memory knowledge graph · recurring scheduler · marketplace / public templates · 32-panel ops dashboard.

These are valuable but premature. See the [v1 spec](docs/specs/v1-mvp-spec.md) for the full deferred roadmap.

## Quickstart

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
# → type a prompt; Sage responds and dispatches Atlas for real code changes
```

**Verify the install:**
```bash
curl http://localhost:3000/api/health
# → { "status": "ok", "db": "ok", ... }
```

**Tests:**
```bash
pnpm test                 # node:test via tsx over the pure lib modules
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
      auth/{login,logout}/route.ts        # scrypt password verify → JWT cookie
      health/route.ts                     # uptime-robot endpoint (unauthenticated)
      approvals/[id]/decision/route.ts    # approve / deny / always (dormant gate infra)
      sessions/[id]/messages/route.ts     # POST a user message
      sessions/[id]/stream/route.ts       # GET SSE stream of the agent turn (Sage + dispatch)
      sessions/[id]/diff/route.ts         # worktree diff for the Code tab
      sessions/[id]/preview/route.ts      # build-and-serve the worktree site for the Preview tab
    login/                                # /login page + form
    page.tsx                              # Server Component: reads DB → MissionControl
    layout.tsx                            # fonts + dark theme
  components/
    mission-control.tsx                   # the 3-pane interactive UI (Client Component)
    diff-viewer.tsx                       # Monaco side-by-side diff + collapsible file list
    terminal-view.tsx                     # live streamed command output (lightweight, no xterm)
    plan-view.tsx                         # live TodoWrite checklist
    markdown.tsx                          # chat markdown rendering
    ui/                                   # shadcn primitives
  db/
    schema.ts                             # Drizzle SQLite schema (9 tables)
    client.ts                             # better-sqlite3 + drizzle wiring
  lib/
    auth.ts, auth-edge.ts, password.ts    # session/cookie + scrypt helpers
    rate-limit.ts                         # in-memory IP bucket
    agent-runner-sdk.ts                   # run a Claude Agent SDK query, yield token/tool/done events
    dispatch.ts                           # Sage's in-process `dispatch_agent` MCP tool
    worktree.ts                           # per-session git worktree create/cleanup
    preview.ts                            # build + serve the worktree site
    permissions.ts                        # tool allowlist / policy lookups
    terminal-events.ts, ansi.ts           # Bash tool events → terminal lines (+ SGR parsing)
    plan-events.ts                        # TodoWrite events → plan snapshot
    message-segments.ts                   # paragraph-split agent chat bubbles
    mock-data.ts                          # shared TYPES only (Agent/Message/Session/Artifact)
  proxy.ts                                # Next 16 proxy (renamed from middleware)
scripts/
  seed.ts                                 # demo project + Sage/Atlas + demo session
  seed-admin.ts                           # interactive operator account creator
drizzle/                                  # generated migration SQL + journal
docs/
  specs/v1-mvp-spec.md
  plans/week-{1,2,3,4}-*.md
  architecture/team-of-agents.md
  decisions/                              # ADRs
  superpowers/specs/                      # per-feature design docs
```

## Relationship to AXOD CREATIVE

Mission Control is a **separate project** from the [AXOD CREATIVE landing page](https://github.com/adrew0321/AXODCREATIVE). They're built by the same person, theme-aligned (same fonts, blue palette), but completely independent codebases. Mission Control is *for* AXOD (and eventually clients); AXOD CREATIVE *showcases* AXOD.

The landing page is the **first repo Mission Control dispatches agents against** (closing the dogfood loop).
