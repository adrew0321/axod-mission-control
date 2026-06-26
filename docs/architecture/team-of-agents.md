# Team-of-Agents Architecture

> **Status:** Implemented & live (`v1.8.0`, 2026-06-26) · originally designed 2026-05-27
> **Companion:** [v1 MVP Spec](../specs/v1-mvp-spec.md) · [README](../../README.md)

## The mental model

Mission Control doesn't think of agents as opaque IDs in a queue. It thinks of them as a **named team** with stable identities, distinct roles, persistent system prompts, and per-project tool permissions — like hiring a small dev shop and giving each person a desk.

The operator (you) talks to **one** entity: **Sage the orchestrator**. Sage knows the team, knows the project, plans the work, and delegates. The specialists do the actual work and report back through Sage so the operator's conversation stays clean.

This is the OPPOSITE of the fleet-ops dashboard pattern. There you watch 50 anonymous workers. Here you manage a team of six.

## Why this pattern

1. **Mental model match.** You already think of "the developer who builds the front-end" as a different person from "the researcher who finds the prior art." Naming and roling them makes the routing decisions obvious.
2. **Prompt economy.** Each agent gets a tight system prompt scoped to its role instead of one bloated "do everything" prompt. Better quality output per token.
3. **Model fit.** Roles can use different models. In practice Sage (planning) runs **Opus** and every specialist runs **Sonnet 4.6** — including Forge, which the original design slated for Haiku but was upgraded because it edits infra config (Dockerfile/CI/deploy) where mistakes are costly. Model choice is a per-agent DB column, so this is tunable without code changes.
4. **Permission scoping.** Each agent's tool allowlist matches its role: Atlas/Forge/Pixel can edit + run; Echo is read-only + run (it reviews, never writes); Nova gets web tools but no edit; Sage gets read + web + planning but no edit (it delegates writes).
5. **Specialization breeds reliability.** A "code writer" that ONLY writes code gets better at it than a generalist also doing PR descriptions, research, and design.

## The team (shipped)

The roster is **DB-driven** — each agent is a row in the `agents` table.

| Avatar | Name | Role | Model | Tools | Specialty |
|---|---|---|---|---|---|
| 🜂 | **Sage** | Orchestrator | `claude-opus-4-7` | Read/Glob/Grep, WebFetch/WebSearch, TodoWrite, + `dispatch_agent` | Plans, delegates, reports |
| ⚒ | **Atlas** | Lead Developer | `claude-sonnet-4-6` | Read/Glob/Grep, Edit/Write, Bash, WebFetch | Reads codebase, writes code, runs tests, commits (via Bash/git) |
| ⛬ | **Echo** | QA Critic | `claude-sonnet-4-6` | Read/Glob/Grep, Bash (**read-only — no Edit/Write**) | Reviews Atlas's diff against the brief, returns a verdict |
| ⌕ | **Nova** | Researcher | `claude-sonnet-4-6` | Read/Glob/Grep, WebFetch, WebSearch | Web search, deep dives, summarization |
| ⛁ | **Forge** | DevOps | `claude-sonnet-4-6` | Read/Glob/Grep, Edit/Write, Bash, WebFetch | Infra/CI/deploy config changes |
| ◊ | **Pixel** | Designer | `claude-sonnet-4-6` | Read/Glob/Grep, Edit/Write, Bash, WebFetch | Code mockups (HTML/CSS/Tailwind/SVG) rendered in the Preview tab |

Each agent has a stable **ID** (`sage`/`atlas`/`echo`/`nova`/`forge`/`pixel`) used in routing, a display **name**, a **role**, a **model**, a DB-stored **system prompt**, a **tool allowlist**, and a **color/avatar** for UI identity. Tools are the real Agent-SDK tools (no abstract `git_commit`/`image_generate` — git is done through `Bash`, mockups through `Edit`/`Write`).

## How a turn runs

Every operator message becomes one **turn**, executed end-to-end by `runSessionTurn` ([src/lib/run-turn.ts](../../src/lib/run-turn.ts)) — server-side and **sink-agnostic** (the same function backs the web SSE stream, the Discord bot, the Scheduler, and the headless CLI). A per-session lease on `sessions.running_since` prevents two turns colliding. The turn rebuilds the **full session transcript** as Sage's prompt (so Sage has memory of the whole conversation), then runs the primary agent through the SDK.

## How Sage routes work to specialists

Sage has an in-process MCP tool, `mcp__mission_control__dispatch_agent` ([src/lib/dispatch.ts](../../src/lib/dispatch.ts)):

```ts
dispatch_agent({
  agent_id: 'atlas' | 'echo' | 'nova' | 'forge' | 'pixel',  // enum — Sage can't invent members
  task: '...',        // specific instructions, constraints, success criteria
  context?: '...',    // optional background
})
```

When Sage calls it:

1. Mission Control intercepts the tool call **in-process** (no child process — it's an MCP server registered on Sage's SDK query).
2. Sage's buffered reply so far is flushed and persisted as a message.
3. The specialist runs through the SDK in the **same session worktree**, with its own tool allowlist.
4. The specialist's output is persisted (attributed to it, `dispatched_via: 'sage'`) and returned to Sage as the tool result.
5. Sage continues — dispatching another specialist or wrapping up.

The operator's chat shows their message, Sage's response with inline activity, the specialist's reply attributed to it (routed via Sage), and Sage's summary — linear and readable.

## Direct addressing (`@Atlas`)

For tight iteration, the operator can bypass Sage by `@`-mentioning a specialist:

```
@Atlas dial the marching-ants speed down 25%
```

A pure `parseMention` ([src/lib/mention.ts](../../src/lib/mention.ts)) detects the leading mention and the turn runs **that specialist as the primary agent** (no Sage turn, no dispatch tool), with the full transcript as context. Once the right specialist is engaged, talking through the orchestrator just adds latency.

## Agent isolation (worktrees)

Every session that touches a repo gets its own git worktree under `data/worktrees/<sessionId>`, on a session branch (`mc/<sessionId>`) forked from the project's default branch:

```
<project repo>/
  data/worktrees/sess_a4f9/   ← session A on mc/sess_a4f9
  data/worktrees/sess_b8c1/   ← session B on mc/sess_b8c1
```

All agents in a session share that worktree (they take turns — only one agent is active at a time). **Cross-session parallelism is safe** because each session is its own branch/worktree. Worktrees also **link `node_modules`** from the main checkout (a junction/symlink, removed before teardown), so build/test commands work inside them. ([src/lib/worktree.ts](../../src/lib/worktree.ts))

When the operator approves a session's work in the **Proposals** view, `mergeWorktree` commits the session branch and merges it into the base branch (in an isolated worktree, never disturbing the running checkout), then removes the worktree + branch. Discard throws it away. (There's no PR step in v1 — merge is local.)

## Permission / safety model

Each agent has a **tool allowlist** (above) — the hard boundary on what it can do at all. A per-tool-call **approval gate** exists in the schema (`approvals`, `tool_permissions`) but is **dormant in v1**: an inline `canUseTool` prompt wasn't workable on the SDK version in use. The **v1 safety model is therefore the allowlist + worktree isolation + human diff review at merge time** — you see every change in the Proposals diff before it touches a real branch. (See [approval-gate notes] in the v1 spec.)

## Automation: turns without a human at the keyboard

Because `runSessionTurn` needs no browser, agents also run unattended:

- **Scheduler** ([src/lib/scheduler.ts](../../src/lib/scheduler.ts)) — an in-process ticker fires due `schedules` rows as agent turns (e.g. a nightly health-check that runs the test suite; the agent ends with a `HEALTH: PASS/FAIL` verdict the scheduler records as a green/red status).
- **Dreaming/Curator** ([src/lib/dream.ts](../../src/lib/dream.ts)) — a nightly read-only pass reflects over recent sessions into starrable insights.
- **Discord bot** ([src/lib/discord-bot.ts](../../src/lib/discord-bot.ts)) — channel-per-project chat runs turns server-side and posts proactive notifications.

All three start in-process at boot via `instrumentation.ts`.

## Growing the team

Adding a specialist that uses **existing** tools (Read/Edit/Bash/WebFetch/…) is cheap:

1. **Seed the row** in `agents` — id, name, role, model, system prompt, tool allowlist, color.
2. **Add the id to `DISPATCHABLE`** in [src/lib/dispatch.ts](../../src/lib/dispatch.ts) so Sage may dispatch it (the enum stops Sage inventing members).
3. **Update Sage's system prompt** so it knows the member exists and when to route to it.
4. **Seed `tool_permissions`** for the (agent, project, tool) triples.

No UI changes — the roster, icons, and accent colors are wired generically. An agent needing a **brand-new tool type** would also require wiring that tool into the runner first.

## What this pattern is NOT

- **Not a swarm.** Agents don't autonomously negotiate or vote. Sage orchestrates explicitly.
- **Not a graph.** No DAG, no node/edge state machine. Functions calling functions.
- **Not competing outputs.** Sage picks one specialist for one task; it doesn't merge rival drafts.
- **Not LangGraph/AutoGen.** Those are powerful but heavy. This is closer to a "function-call hierarchy with names and personalities painted on."

## Comparison to alternatives

| Approach | Vibe | Tradeoff vs team-of-agents |
|---|---|---|
| One mega-agent | "Smart intern who does everything" | Simpler, but blurry responsibility + bloated prompt + no per-role model fit |
| Anonymous worker pool | "Mechanical Turk for code" | Scales horizontally but loses the mental model + no persistent identity |
| Full swarm (CrewAI, AutoGen) | "Multi-agent debate club" | More autonomous, harder to control, less predictable cost |
| Linear pipeline (LangChain) | "Assembly line" | Deterministic but no orchestrator judgment for ambiguous requests |
| Team-of-agents (this) | "Small dev shop" | More setup than a mega-agent; less power than a swarm; **right size for a solo operator** |

## How this maps to the Claude Agent SDK

The pattern is **a layer on top of the SDK, not a fork of it**:

- Each team member = an SDK query with that member's system prompt + tool allowlist + model.
- `dispatch_agent` = an in-process MCP server/tool on Sage's query that runs a specialist query and returns its output as the tool result.
- Streaming = the runner consumes the SDK's token/tool/done events and re-emits them to whatever sink is attached (SSE, Discord, log).
- The dormant approval gate = a `canUseTool`-style hook (deferred — see safety model above).

## Design questions — resolved in build

1. **Does a dispatched specialist see Sage's whole conversation?** It gets the task + context Sage passes, run in the shared worktree — not Sage's full chat. Keeps its context focused.
2. **Can two specialists run truly in parallel within one session?** No — one active agent per worktree at a time (turns serialize on the session lease). Cross-session is parallel.
3. **How does Echo review Atlas's work?** Echo is dispatched read-only into the same worktree and reviews the diff against the brief, returning a verdict block.
4. **What if Sage hallucinates a non-existent member?** The `dispatch_agent` enum rejects it server-side → tool error → Sage retries.
5. **How does "always allow" propagate?** Moot in v1 — the per-call approval gate is dormant; the allowlist + diff-review-at-merge is the safety model.
