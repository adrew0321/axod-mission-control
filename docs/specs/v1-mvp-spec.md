# v1 MVP Spec — AXOD Mission Control

> **Status:** Build in progress · Weeks 1–4 complete & released to `main` · Week 5 (deploy) in progress (as of 2026-06-01)
> **Created:** 2026-05-27
> **Owner:** [@adrew0321](https://github.com/adrew0321)
> **Target ship:** 5 weeks from build start
> **Companion:** [Week 1 Walking Skeleton plan](../plans/week-1-walking-skeleton.md)

## Build progress

- **Week 1 — walking skeleton:** ✅ Next.js app, single-user scrypt auth + protected routes, SQLite/Drizzle schema, SSE plumbing, health endpoint, ADRs.
- **Week 2 — single agent (SDK):** ✅ Sage runs on the Claude Agent SDK, real orchestrator prompt, DB-driven tool allowlist, message persistence, stop/abort. Approval-gate infra built but dormant (see below).
- **Week 3 — team of agents:** ✅ Sage dispatches **Atlas** via an in-process `dispatch_agent` MCP tool; Atlas runs in an isolated git worktree, streams live ("Atlas · via Sage"), and reports back. Live worktree **diff review** in the Code tab. Live **per-agent state** in the roster. Message ordering fixed (Sage-pre → specialist → Sage-post).
- **Decision (Week 3 Day 1, operator-approved):** the inline `canUseTool` approval gate is **not achievable on SDK 0.3.x** (callback never fires; streaming-input hangs). v1 safety is therefore a **static model**: per-agent capability allowlist + worktree isolation + operator diff review. The inline-card infra stays in the repo, dormant, to be wired if a future SDK fixes the control protocol. See [week-3 plan](../plans/week-3-team-of-agents.md) Day 1.
- **Week 4 — workspace tabs:** ✅ Preview (build-and-serve), Code (Monaco diff + collapsible file list), Plan (live `TodoWrite` checklist), Terminal (live streamed output, lightweight `TerminalView`). All four read live session data; last mock wiring removed. **Mobile-responsive** layout shipped (criterion #9). Released to `main` 2026-05-31 + follow-up 2026-06-01.
- **Remaining for v1:** Week 5 — VPS deploy + HTTPS (#8) and one real AXOD CREATIVE dogfood ship (#10). Plan `docs/plans/week-5-deploy.md` deferred to its own session.

## Vision

A web app that lets a single human operator dispatch a small team of named AI agents — coordinated by an orchestrator named Sage — to do development work on real repositories, with live artifacts streamed to the operator and human-in-the-loop approval gates for risky actions. The operator never needs to open Claude Code, Antigravity, or any other agent CLI directly.

## v1 success criteria

You can answer YES to all of these after week 5:

1. I can dispatch Sage from the web UI to make a code change in AXOD CREATIVE.
2. Sage routes the work to Atlas (the developer) without me typing Atlas's name.
3. I see the diff in the Code tab before anything's committed.
4. ~~I can approve / deny / "always allow" tool calls inline in the chat.~~ **Revised (Week 3 Day 1):** inline gates aren't achievable on SDK 0.3.x. v1 safety = capability allowlist + worktree isolation + operator **diff review** before merge. (Inline-card infra remains dormant for a future SDK.)
5. Atlas's work happens in an isolated git worktree (so parallel agents won't collide when added).
6. I can close the browser and resume the session later.
7. I can see how much the session cost in tokens and dollars.
8. The app runs on my VPS with HTTPS.
9. The web UI is mobile-responsive (I can dispatch from my phone).
10. I shipped at least one real AXOD CREATIVE change through it.

If any one of these isn't true, v1 isn't done.

## What's IN for v1 (the lock list)

✅ **3-column UI** — team roster (left) · orchestrator chat (middle) · workspace tabs (right)
✅ **2 agents only** — Sage (orchestrator, Opus 4.7) and Atlas (developer, Sonnet 4.6)
✅ **Claude Agent SDK** as the agent runtime
✅ **Single project** — AXOD CREATIVE hardcoded for v1 (project switcher is a stub)
✅ **SQLite (WAL mode)** via Drizzle ORM for sessions, messages, approvals, agents
✅ **Server-Sent Events** for streaming agent output to the workspace
⚠️ **Approval gates** — *planned* inline; **revised to a static safety model** (capability allowlist + worktree isolation + operator diff review) because `canUseTool` doesn't fire on SDK 0.3.x. Inline-card infra is built but dormant.
✅ **Git worktree isolation** per agent (one worktree per active session)
✅ **Workspace tabs** — Preview (sandboxed iframe), Code (Monaco diff), Plan (live `TodoWrite` checklist, *not* static markdown — week 4 day 4), Terminal (live streamed command output, lightweight `TerminalView` rather than full xterm.js — week 4 day 3). All four read live session data; the last mock wiring (`mockArtifacts`) was removed week 4 day 5.
✅ **Auth** — session cookie + scrypt password, single-user
✅ **Cost + token meter** — read from Claude Agent SDK response metadata
⏳ **VPS deploy** — Docker Compose + Nginx + Let's Encrypt on Hetzner CX21 *(in v1 scope; not yet built — week 5; plan `docs/plans/week-5-deploy.md` deferred to its own session)*
✅ **Mobile-responsive** — 3-col collapses to a single tab-switched pane below `md` with a bottom tab bar (Team/Chat/Workspace); criterion #9. Shipped week 4 (2026-06-01). (Swipe nav was dropped — conflicted with Monaco/terminal horizontal scroll; the tab bar is the nav.)
✅ **Session resume** — refresh the page or close the browser, the conversation persists

## What's deliberately CUT (deferred)

| Cut | Why | Lands in |
|---|---|---|
| Echo, Nova, Forge, Pixel (other agents) | Sage + Atlas covers the dev loop; others added one at a time once the pattern is proven. **Echo first** (no new tools); see re-sequenced roadmap below | v1.1 – v1.3 |
| Discord integration | Web UI works on mobile via responsive design; Discord adds OpenClaw dependency | v1.5 (~1 week) |
| OpenClaw gateway | Only needed for Discord and multi-channel; v1 web-only | v1.5 |
| Skills hub / marketplace | Premature; v1 has hand-written agent prompts | v1.6 |
| Multi-runtime (CrewAI / LangGraph / Antigravity simultaneously) | Adds complexity; Claude Agent SDK covers v1 use cases | v2.0 |
| RBAC / multi-user | Solo tool for now; decide if/when to share with clients | v2.0 |
| MCP audit / trust scoring | Builderz-style security panels; useful but not core to the MVP loop | v2.0 |
| Memory knowledge graph | Agent memory + cross-session recall, with a knowledge-graph visualization | v2.2 |
| Recurring scheduler | Cron-driven agent dispatches | v2.0 |
| 32-panel ops dashboard | The hybrid UX rejects this aesthetic anyway | never |

## Architecture

### High-level

```
                    ┌─────────────────────────────┐
                    │       Web UI (Next.js)      │
                    │   3-pane: team / chat / ws  │
                    └──────────┬──────────────────┘
                               │ HTTP + SSE
                    ┌──────────▼──────────────────┐
                    │  Mission Control Server     │
                    │  - REST API                 │
                    │  - SSE streams              │
                    │  - Approval queue           │
                    │  - SQLite (sessions/state)  │
                    └──────────┬──────────────────┘
                               │ spawns
                    ┌──────────▼──────────────────┐
                    │   Agent Manager             │
                    │   - 1 worktree per session  │
                    │   - 1 child process per     │
                    │     active agent            │
                    └──────────┬──────────────────┘
                               │ uses
                    ┌──────────▼──────────────────┐
                    │  Claude Agent SDK           │
                    │  (Anthropic API)            │
                    └─────────────────────────────┘
```

### Data model (SQLite via Drizzle)

```ts
// db/schema.ts
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),                  // 'axod-creative'
  name: text('name').notNull(),                 // 'AXOD CREATIVE'
  repo_path: text('repo_path').notNull(),       // '/srv/repos/AXODCREATIVE'
  github_url: text('github_url'),
  default_branch: text('default_branch').default('dev'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),                  // 'sage' | 'atlas'
  name: text('name').notNull(),                 // 'Sage' | 'Atlas'
  role: text('role').notNull(),                 // 'orchestrator' | 'developer'
  model: text('model').notNull(),               // 'claude-opus-4-7' | 'claude-sonnet-4-6'
  system_prompt: text('system_prompt').notNull(),
  tools_allowlist: text('tools_allowlist', { mode: 'json' }), // ['read_file', 'edit', ...]
  color: text('color'),                         // for avatar gradient
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                  // 'sess_a4f9'
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title'),                         // auto-derived from first prompt
  branch: text('branch'),                       // 'feature/testimonials-borders'
  worktree_path: text('worktree_path'),         // '/srv/worktrees/sess_a4f9'
  status: text('status').notNull(),             // 'active' | 'paused' | 'completed' | 'errored'
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id),  // null = user
  role: text('role').notNull(),                 // 'user' | 'agent' | 'system'
  content: text('content').notNull(),
  tool_calls: text('tool_calls', { mode: 'json' }),
  token_count_in: integer('token_count_in'),
  token_count_out: integer('token_count_out'),
  cost_usd: real('cost_usd'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id).notNull(),
  tool_name: text('tool_name').notNull(),       // 'edit' | 'run_command' | 'web_fetch'
  tool_args: text('tool_args', { mode: 'json' }),
  status: text('status').notNull(),             // 'pending' | 'approved' | 'denied' | 'always'
  decided_at: integer('decided_at', { mode: 'timestamp' }),
});

export const tool_permissions = sqliteTable('tool_permissions', {
  agent_id: text('agent_id').references(() => agents.id).notNull(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  tool_name: text('tool_name').notNull(),
  policy: text('policy').notNull(),             // 'always' | 'ask' | 'deny'
}, (t) => ({ pk: primaryKey({ columns: [t.agent_id, t.project_id, t.tool_name] }) }));

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  session_id: text('session_id').references(() => sessions.id).notNull(),
  agent_id: text('agent_id').references(() => agents.id).notNull(),
  type: text('type').notNull(),                 // 'preview' | 'diff' | 'plan' | 'terminal' | 'research'
  title: text('title'),
  content: text('content'),                     // markdown / HTML / shell text
  file_changes: text('file_changes', { mode: 'json' }), // [{path, op, before, after}]
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const auth_users = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  email: text('email').unique().notNull(),
  password_hash: text('password_hash').notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const auth_sessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),                  // session cookie value
  user_id: text('user_id').references(() => auth_users.id).notNull(),
  expires_at: integer('expires_at', { mode: 'timestamp' }).notNull(),
});
```

### REST API surface (v1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | scrypt-verify password, set session cookie |
| POST | `/api/auth/logout` | clear session cookie |
| GET | `/api/projects` | list (just AXOD CREATIVE for v1) |
| GET | `/api/agents` | list (Sage + Atlas) |
| GET | `/api/sessions` | list recent sessions |
| POST | `/api/sessions` | create new session (creates worktree) |
| GET | `/api/sessions/:id` | session detail + message history |
| POST | `/api/sessions/:id/messages` | send a user message → triggers orchestrator |
| GET | `/api/sessions/:id/artifacts` | list artifacts |
| GET | `/api/sessions/:id/artifacts/:artifact_id` | get one artifact |
| GET | `/api/approvals?status=pending` | list pending approvals |
| POST | `/api/approvals/:id/decision` | approve / deny / always |

### SSE streams (v1)

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions/:id/stream` | live agent output for this session (token-by-token streaming, tool call events, status changes) |
| `GET /api/sessions/:id/artifacts/stream` | live artifact updates (new artifact, artifact updated) |

Server-Sent Events chosen over WebSocket because all the streams are server → client (one-way). Browser auto-reconnects on disconnect. Simpler.

### Process model

```
mission-control-server (Node)
│
├── HTTP/SSE listener (Hono on Next.js API routes)
├── SQLite handle (better-sqlite3, WAL mode)
└── AgentManager singleton
    ├── activeAgents: Map<sessionId, AgentProcess>
    └── for each session:
        ├── worktree at /srv/worktrees/<session_id>/
        ├── child process running Claude Agent SDK
        └── SSE channel pushing tokens/events to the web UI
```

When a session is started:
1. Server creates a new git worktree from the project's default branch
2. AgentManager spawns Sage as a child process targeting the worktree
3. Sage receives the user's message + system prompt
4. Sage may use `dispatch_agent('atlas', { task })` tool → AgentManager spawns Atlas as a sibling process in the same worktree
5. All output streams back through SSE to the web UI

When session ends (user marks done or auto-timeout):
1. Sage commits + pushes (with approval)
2. Worktree gets cleaned up
3. Session marked `completed`

### Tool permission model (the approval gate)

Every tool call goes through this gate:

```ts
async function checkPermission(agent, project, toolName, toolArgs) {
  // 1. Check user-set policy for this agent + project + tool combo
  const policy = await getToolPermission(agent.id, project.id, toolName);

  if (policy === 'always') return { allow: true };
  if (policy === 'deny') return { allow: false, reason: 'policy:deny' };

  // 2. Otherwise create a pending approval and surface in UI
  const approval = await createApproval({
    session_id: currentSessionId,
    agent_id: agent.id,
    tool_name: toolName,
    tool_args: toolArgs,
  });

  // 3. Block until user decides (or 5min timeout)
  const decision = await waitForApproval(approval.id, 5 * 60 * 1000);

  if (decision === 'always') {
    await setToolPermission(agent.id, project.id, toolName, 'always');
  }

  return { allow: decision !== 'denied' };
}
```

User decisions persist as `tool_permissions` rows. "Always allow Atlas to edit files in AXOD CREATIVE" only has to be clicked once per agent + project + tool triple.

### Git worktree strategy

```bash
# When session sess_a4f9 starts:
git -C /srv/repos/AXODCREATIVE worktree add /srv/worktrees/sess_a4f9 dev
git -C /srv/worktrees/sess_a4f9 checkout -b feature/auto-<session-slug>

# When session ends successfully:
# (Agent has already committed + pushed via approval gate)
git -C /srv/repos/AXODCREATIVE worktree remove /srv/worktrees/sess_a4f9

# When session is paused (no destructive cleanup):
# Worktree persists. Resume = re-spawn agent pointing at same worktree.
```

This is how parallel sessions don't collide even though they're on the same repo. (Used the Superpowers worktree skill pattern as reference.)

## The agents (v1 system prompts — first drafts)

### Sage

```
You are Sage, the orchestrator agent for AXOD Mission Control.

Your job is to:
1. Receive the operator's request in plain English.
2. Decide what work needs to happen and which team member should do it.
3. Use the `dispatch_agent` tool to assign work to specialists.
4. Monitor their progress and report back to the operator in plain English.
5. Surface approval requests when team members need permission for risky actions.

You do NOT do the work yourself. You delegate. If the request is small enough
that it doesn't need a specialist, you can answer directly — but default to
dispatching.

Your team (v1):
- Atlas (developer): writes code, runs tests, commits, opens PRs.
  Use `dispatch_agent('atlas', { task })` to assign.

Speak warmly but concisely. Default to short responses unless the operator
asks for detail. Always tell the operator who you're dispatching to and why,
in one sentence.
```

### Atlas

```
You are Atlas, the lead developer on AXOD's agent team.

You receive task assignments from Sage. You work in an isolated git worktree
on a feature branch. You:
- Read existing code to understand conventions before changing anything
- Make focused changes (one cohesive change per session)
- Run the project's build/test commands to verify
- Commit with clear messages and push when given approval
- Open PRs when the work is done

You respect the project's existing patterns. Don't add libraries casually.
Don't refactor unrelated code. Don't comment everything.

If you're blocked or unsure, ask Sage. She'll relay to the operator.

When you finish a chunk of work, summarize it in 2-3 sentences for Sage to
report back.
```

## Auth model (v1)

- **Single user.** `auth_users` table seeded with one row via `pnpm seed:admin` (interactive script that prompts for password, scrypt-hashes it, inserts).
- **Session cookies.** 7-day expiry. HTTP-only, Secure, SameSite=Lax.
- **No SSO / OAuth in v1** — added when multi-user becomes a thing.
- **Rate limiting** on `/api/auth/login` (5 attempts per IP per 15 min) to prevent brute force.

## Deployment target (v1)

| Component | Choice |
|---|---|
| Provider | Hetzner Cloud (CX21 = 4GB / 2vCPU / 40GB / ~$5/mo, Ashburn or Helsinki) |
| OS | Ubuntu 24.04 LTS |
| Orchestration | Docker Compose |
| Reverse proxy | Nginx (Caddy as alternative if simpler) |
| TLS | Let's Encrypt via certbot |
| Domain | `mc.axodcreative.com` (subdomain on existing axodcreative.com once that's set up — issue #16 on AXOD CREATIVE) |
| DB backup | Nightly cron to S3-compatible storage (Backblaze B2 ~$0.005/GB/mo) |
| Monitoring | Uptime Robot (free tier) pinging `/health` every 5 min |

Estimated v1 running cost: **$5-8/mo** (VPS) + **~$20-50/mo** (Claude API at solo usage levels).

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Sage's orchestrator prompt doesn't reliably trigger dispatch_agent | A/B test with Opus 4.7 vs Sonnet 4.6 in week 3; fall back to explicit slash commands if needed |
| Multiple agents on same worktree cause conflicts | v1 has only 1 active agent per worktree by design. v1.x adds queue. Won't truly be parallel until each agent gets its own worktree of the same branch. |
| Claude Agent SDK changes API mid-build | Pin to a specific SDK version; check release notes weekly |
| Cost spike from a runaway agent | Per-session token cap (e.g., 100k tokens), enforced server-side; kill switch if exceeded |
| Lost work if worktree deleted prematurely | Auto-commit every N tool calls; never `worktree remove` without explicit "completed" status |
| User locked out of their own VPS | Set up emergency `axod-mc-recover` SSH key + a "panic mode" CLI that disables web auth and forces local-only access |

## Definition of done — v1 launch

You merge a PR to `main` of `adrew0321/AXODCREATIVE` that was originated, drafted, tested, and pushed by an Atlas agent dispatched by Sage, via the Mission Control web UI running on your VPS, with at least one approval gate fired and decided through the UI, and the session cost displayed below $0.50. Tweet about it.

## Out of scope (deferred roadmap)

**Re-sequenced 2026-06-01 (operator-approved):** agents-before-Discord, and **Echo promoted to the first post-v1 hire** because it needs zero new tool plumbing (`read_file` + `run_command`) and closes the quality loop on Atlas's diffs. Nova/Pixel (new web-search / image-gen tools) move later.

| Version | Adds | Effort estimate |
|---|---|---|
| v1.1 | **Echo** (QA critic) — reviews Atlas's diff against the task brief; no new tools | ~3 days |
| v1.2 | **Nova** (researcher) — build `web_search` / `web_fetch` tool plumbing first | ~1 week |
| v1.3 | **Forge** (DevOps, git/CI/deploy) + **Pixel** (designer, needs `image_generate`) | ~3 days each |
| v1.4 | Multi-project switcher (Mission Control itself + client repos) | ~1 week |
| v1.5 | Discord integration via OpenClaw gateway | ~1 week |
| v1.6 | Skills hub (templates from awesome-openclaw-agents catalog) | ~2 weeks |
| v2.0 | Multi-runtime (OpenClaw + CrewAI + LangGraph + Claude Code agents in same dashboard) | ~3 weeks |
| v2.1 | RBAC + collaborator invites | ~1 week |
| v2.2 | Memory knowledge graph + cross-session recall | ~2 weeks |
| v2.3 | Recurring scheduler (cron-driven dispatches) | ~3 days |
| v3.0 | SaaS option / public marketplace | TBD |

## Open questions (decide before week 1)

- [ ] Repo public from day 1, or private until v0.1? **Default: private until v0.1.**
- [ ] License? **Default: MIT, set on first public release.**
- [ ] Domain: `mc.axodcreative.com` requires #16 done first. **Default: use `mc-dev.axodcreative.com` (a DNS record → the Hetzner VPS, behind Nginx + Let's Encrypt) until #16 ships.** Not a Cloudflare Pages deploy — this app needs a real VM (see [ADR-002](../decisions/adr-002-v1-platform-locks.md)).
- [ ] VPS provider final choice: Hetzner or DigitalOcean? **Default: Hetzner (cheaper, EU privacy posture).**
- [ ] Use Anthropic API directly, or via Cloudflare AI Gateway? **Default: direct for v1, switch to AI Gateway in v1.2 for analytics.**
- [ ] CI on the Mission Control repo itself? **Default: GitHub Actions running tests + lint on every PR. Match AXOD CREATIVE's pattern.**