# AXOD Mission Control

> A self-hosted command center for running a team of AI agents that do real development work — from a web app or from Discord.

**Status:** 🟢 **Live** — running 24/7 at **https://bridge.axodcreative.com** (`v1.8.0`), self-hosted on a home Mac Mini behind a Cloudflare Tunnel.
**Owner:** [@adrew0321](https://github.com/adrew0321) (AXOD CREATIVE) · **License:** MIT

## What it is

Mission Control turns "I want to build this" into actual code changes, done by a team of named AI agents you direct in plain language. **Sage**, the orchestrator, takes your request and either answers directly or dispatches a specialist (Atlas to write code, Echo to review it, etc.). Each agent works in an **isolated git worktree**, so its changes are sandboxed until you review and merge them. It's built on the **Claude Agent SDK** and runs against your own repositories.

You drive it two ways:
- **Web app** — a 3-pane cockpit: the agent roster, a chat with Sage, and a live workspace (Code diff · Preview · Terminal · Plan).
- **Discord** — one channel per project. Message Sage from your phone; the turn runs on the server. The bot also posts **proactive notifications** (a scheduled job finished, a nightly insight landed, a change is ready to merge).

It also works while you're away: a **Scheduler** runs recurring agent tasks (e.g. a nightly build/test health-check), and a nightly **Dreaming** pass reflects over recent activity into starrable insights.

## How it works

A **Next.js 16** app. Sage runs as the orchestrator and dispatches specialists through an in-process `dispatch_agent` MCP tool, with the full session transcript as memory; each specialist runs via the Agent SDK in the session's isolated git worktree. You can also **`@`-address a specialist** (`@Atlas …`) to skip Sage for tight iteration. State lives in **SQLite** (WAL, via Drizzle); the UI streams over **Server-Sent Events**. Background work (Scheduler, Dreaming, the Discord gateway bot) starts in-process at boot. Self-hosted with host Node + systemd + Claude Pro CLI auth; a cloudflared named tunnel provides public ingress with no open ports.

## The team

The roster is **DB-driven** — each agent is a row (id, role, model, system prompt, tool allowlist, color).

| | Agent | Role | What it does |
|---|---|---|---|
| 🜂 | **Sage** | Orchestrator | Talks to you, plans, routes work to specialists |
| ⚒ | **Atlas** | Lead Developer | Writes and edits code in the worktree |
| ⛬ | **Echo** | QA Critic | Reviews Atlas's diffs (read-only) and returns a verdict |
| ⌕ | **Nova** | Researcher | Web search/fetch for docs and references |
| ⛁ | **Forge** | DevOps | Infra/CI/deploy config changes |
| ◊ | **Pixel** | Designer | Code mockups (HTML/CSS/Tailwind/SVG) rendered in the Preview tab |

## What's shipped

- **Agent team + orchestration** — Sage routes work; specialists run in isolated worktrees; `@`-mention direct addressing; live per-agent state.
- **Workspace** — Monaco code-diff, build-and-serve Preview, live Terminal output, live `TodoWrite` Plan, file explorer; mobile-responsive.
- **Review & merge** — a Proposals inbox: approve→merge a session's worktree changes (or discard).
- **Automation** — headless turn runner; **Scheduler** (recurring tasks; a nightly health-check that runs the test suite and reports pass/fail); **Dreaming/Curator** (nightly insights).
- **Discord** — channel-per-project chat with Sage + proactive notifications (scheduled-task / dream / proposal embeds).
- **Self-hosted & live** — home Mac Mini on Ubuntu, systemd services, Cloudflare named tunnel → `bridge.axodcreative.com`, nightly local DB backups.

## What's next

- Discord **action buttons** (Approve & Merge / Discard from a notification) + `/mc new-session`.
- R2 offsite backups (local nightly snapshots already run).
- More specialists as needs arise (the team grows by adding a DB row — see below).

## Quickstart (local dev)

**Requirements:** Node 22+ · pnpm 11+ · the `claude` CLI on `PATH` (logged in, or an `ANTHROPIC_API_KEY`).

```bash
git clone https://github.com/adrew0321/axod-mission-control.git
cd axod-mission-control && pnpm install

mkdir -p data
node node_modules/drizzle-kit/bin.cjs migrate
pnpm seed                      # demo project + agents + session

cp .env.example .env           # SESSION_SECRET auto-generates; set DISCORD_* only if using the bot
pnpm seed:admin                # create your operator login (interactive)

pnpm dev                       # → http://127.0.0.1:3000  (redirects to /login)
```

**Native build note:** `.npmrc` ships `ignore-scripts=true` (supply-chain hardening), so `better-sqlite3` needs its binding compiled once after install:
```bash
cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx --no prebuild-install
```

**Tests:** `pnpm test` (node:test via tsx over the pure lib modules).
**Discord bot (optional):** set `DISCORD_BOT_TOKEN` / `DISCORD_APP_ID` / `DISCORD_ALLOWED_USER_IDS` / `DISCORD_GUILD_ID`, enable the **Message Content** privileged intent on the bot, then `/mc bind` a channel to a project.

## Deploying

Runs on a home Mac Mini (Ubuntu, host Node + systemd + Claude Pro CLI auth) behind a Cloudflare named tunnel at `bridge.axodcreative.com` — no public IP, no port-forwarding. The box pulls `main` from GitHub. See **[docs/runbook-deploy-homelab.md](docs/runbook-deploy-homelab.md)** for the full runbook (deploy procedure, security posture, and hard-won gotchas).

## Growing the team

Adding a specialist that uses existing tools (read / edit / run_command / git) is cheap: (1) seed the row in `agents`; (2) add its id to `DISPATCHABLE` in [`src/lib/dispatch.ts`](src/lib/dispatch.ts); (3) mention it in Sage's system prompt; (4) seed its `tool_permissions`. No UI changes needed. Agents needing brand-new tool types require wiring those into the runner first. See [Team-of-Agents Architecture](docs/architecture/team-of-agents.md).

## Relationship to AXOD CREATIVE

Mission Control is a **separate project** from the [AXOD CREATIVE landing page](https://github.com/adrew0321/AXODCREATIVE) — same author, theme-aligned, independent codebases. Mission Control is the tool; AXOD CREATIVE is one of the repos it works on.
