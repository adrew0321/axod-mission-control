# Team-of-Agents Architecture

> **Status:** Design · 2026-05-27
> **Companion:** [v1 MVP Spec](../specs/v1-mvp-spec.md)

## The mental model

Mission Control doesn't think of agents as opaque IDs in a queue. It thinks of them as a **named team** with stable identities, distinct roles, persistent system prompts, and per-project tool permissions — like hiring a small dev shop and giving each person a desk.

The operator (you) talks to **one** entity: **Sage the orchestrator**. Sage knows the team, knows the project, plans the work, and delegates. The other agents do the actual work. They report back through Sage so the operator's conversation stays clean.

This is the OPPOSITE of the fleet-ops dashboard pattern. There you watch 50 anonymous workers. Here you manage a team of 6.

## Why this pattern

1. **Mental model match.** You already think of "the developer who builds the front-end" as a different person from "the researcher who finds the prior art." Naming and roling them makes the routing decisions obvious.
2. **Prompt economy.** Each agent gets a tight system prompt scoped to its role instead of one bloated "do everything" prompt. Better quality output per token.
3. **Model fit.** Different roles benefit from different models — Sage (planning) wants Opus; Forge (routine git ops) wants Haiku for speed; Atlas (code) wants Sonnet for balance. Per-agent model choice = real cost savings.
4. **Permission scoping.** Atlas can edit files; Nova can hit the web but not edit; Forge can push to remote but only after explicit approval. Cleaner than per-tool ACLs across one mega-agent.
5. **Specialization breeds reliability.** A "code writer" agent that ONLY writes code gets better at it than a generalist trying to also do PR descriptions, research, and design.

## The v1 team

| Avatar | Name | Role | Model | Specialty | In v1? |
|---|---|---|---|---|---|
| 🜂 | **Sage** | Orchestrator | Opus 4.7 | Plans, delegates, reports | ✅ |
| ⚒ | **Atlas** | Lead Developer | Sonnet 4.6 | Reads codebase, writes code, runs tests, commits | ✅ |
| ⌕ | **Nova** | Researcher | Sonnet 4.6 + web tools | Web search, deep dives, summarization | v1.2 |
| ⛬ | **Echo** | QA Critic | Sonnet 4.6 | Spec compliance review, code review, regression checks | v1.3 |
| ◊ | **Pixel** | Designer | Sonnet 4.6 | UI mockups, visual companion, design iteration | v1.2 |
| ⛁ | **Forge** | DevOps | Haiku 4.5 | git ops, CI watches, deploy commands, log reading | v1.3 |

Each agent has:
- A **stable ID** (`sage`, `atlas`, `nova`, `echo`, `pixel`, `forge`) used in routing
- A **display name** the operator sees
- A **role** (1-line description)
- A **model** assignment (changeable per-session in v1.x)
- A **system prompt** stored in the DB and editable via a settings UI in v1.x
- A **tool allowlist** scoped to what the role needs
- A **color/avatar gradient** for visual identity in the UI

## How Sage routes work to specialists

Sage is a Claude agent with a tool called `dispatch_agent`:

```ts
{
  name: 'dispatch_agent',
  description: 'Hand off a task to one of your team specialists. They work in the same git worktree and report back through you.',
  input_schema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', enum: ['atlas', 'nova', 'echo', 'pixel', 'forge'] },
      task: { type: 'string', description: 'Specific instructions for the specialist. Include any constraints, file paths, or success criteria.' },
      context: { type: 'string', description: 'Optional background the specialist needs.' }
    },
    required: ['agent_id', 'task']
  }
}
```

When Sage calls `dispatch_agent('atlas', { task: '...' })`:

1. Mission Control intercepts the tool call server-side
2. Persists a "dispatch event" message in the conversation log
3. Spawns Atlas as a sibling child process targeting the same worktree
4. Atlas runs his task, possibly using his own tools (edit, run_command, etc.)
5. When Atlas finishes, his summary is fed back to Sage as the tool result
6. Sage continues, possibly dispatching another specialist or wrapping up

The operator's chat view shows:
- Their message to Sage
- Sage's response, with **dispatch cards inline** showing "Atlas → working on X"
- Atlas's reply, **attributed to Atlas but routed through Sage** (header reads "Atlas · via Sage")
- Sage's final summary

This keeps the conversation linear and readable, while making the team work transparent.

## Direct addressing (`@Atlas`)

For tight iterations on a specialist's work, the operator can bypass Sage by `@`-mentioning a team member directly:

```
@Atlas dial the marching-ants speed down 25%
```

This sends the message straight to Atlas (without spawning a new orchestrator turn). Atlas responds directly. Sage gets a notification but doesn't intervene.

This matters because once the right specialist is engaged, talking through the orchestrator adds latency without value.

## Agent isolation (worktrees)

Every active session gets its own git worktree:

```
/srv/repos/AXODCREATIVE/            ← the upstream clone
  /srv/worktrees/sess_a4f9/         ← session A, checked out to feature/borders
  /srv/worktrees/sess_b8c1/         ← session B, checked out to feature/chatbot-v17
```

All agents in a single session share that session's worktree (Sage and Atlas working together don't conflict because they take turns — Atlas blocks while Sage is reasoning, Sage blocks while Atlas is editing).

**Cross-session parallelism is safe** because each session is on its own branch in its own worktree.

When a session completes (Atlas pushes + opens PR + operator marks "done"), the worktree is removed. The branch lives on in the remote until the PR is merged or closed.

## Permission model per agent

Each agent has a tool allowlist (what they CAN do at all):

| Tool | Sage | Atlas | Nova | Echo | Pixel | Forge |
|---|---|---|---|---|---|---|
| `dispatch_agent` | ✅ | — | — | — | — | — |
| `read_file` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `edit` / `write` | — | ✅ | — | — | ✅ | — |
| `run_command` | — | ✅ | — | ✅ | — | ✅ |
| `web_fetch` | — | — | ✅ | — | ✅ | — |
| `web_search` | — | — | ✅ | — | — | — |
| `git_commit` | — | ✅ | — | — | — | ✅ |
| `git_push` | — | — | — | — | — | ✅ |
| `gh_pr_create` | — | ✅ | — | — | — | ✅ |
| `image_generate` | — | — | — | — | ✅ | — |

Within the allowlist, each tool call still goes through the **approval gate** unless the operator has set a "always allow" policy for that (agent, project, tool) triple. See [v1 spec § Tool permission model](../specs/v1-mvp-spec.md).

## Growing the team

Adding a 7th member in v1.x is a 3-step process:

1. **Define the role** — pick a name, role, model, system prompt, tool allowlist
2. **Insert a row** in `agents` table (via UI or migration)
3. **Update Sage's system prompt** to know the new member exists and when to dispatch them

That's it. No code changes if the new agent doesn't introduce new tool types.

When v1.5 ships the Skills Hub, adding a new agent will be a one-click install from the [awesome-openclaw-agents](https://github.com/mergisi/awesome-openclaw-agents) catalog.

## What this pattern is NOT

- **Not a swarm.** Agents don't autonomously negotiate or vote. Sage orchestrates explicitly.
- **Not a graph.** No DAG visualization, no node/edge state machine. Just functions calling functions.
- **Not a multi-modal team that fights.** Sage doesn't try to merge competing outputs from two agents. She picks one specialist for one task.
- **Not LangGraph or AutoGen.** Those are powerful but heavy. The team-of-agents pattern is closer to "function call hierarchy" with names and personalities painted on.

## Comparison to alternatives

| Approach | Vibe | Tradeoff vs team-of-agents |
|---|---|---|
| One mega-agent (Claude Code alone) | "Smart intern who does everything" | Simpler, but blurrier responsibility + bloated prompts + no per-role model fit |
| Anonymous worker pool (`agt_xxxx`) | "Mechanical Turk for code" | Scales horizontally but loses the mental model + no persistent identity to refine |
| Full swarm (CrewAI, AutoGen) | "Multi-agent debate club" | More autonomous but harder to control + less predictable per-token cost |
| Linear pipeline (LangChain) | "Assembly line" | Deterministic but no orchestrator judgment, can't handle ambiguous requests |
| Team-of-agents (this) | "Small dev shop" | More setup than mega-agent; less power than swarm; **right size for a solo operator** |

## How this maps to the Claude Agent SDK

Claude Agent SDK gives you the primitives:
- `Agent` class — wraps an Anthropic model with tools, system prompt, and conversation state
- `Tool` interface — define custom tools that intercept and validate calls
- Streaming response API — token-by-token streaming with tool_use events
- Permission callbacks — hook into every tool call before execution

The mapping:
- Each team member = one `Agent` instance with that member's system prompt + tool allowlist
- `dispatch_agent` = a custom `Tool` on Sage's agent that spawns a child `Agent`
- Approval gate = a permission callback registered on every agent
- Multi-turn = SDK handles it
- Tool call display in UI = consume the stream events directly, emit to SSE

This means the team-of-agents pattern is **a layer on top of the SDK, not a fork of it**. We're using the SDK as designed.

## Open design questions

These are unresolved heading into v1 build:

1. **When Sage dispatches Atlas, does Atlas see Sage's whole conversation or just the task brief?**
   Probably: just the task brief + relevant context Sage passes explicitly. Keeps Atlas's context small and focused.

2. **Can two specialists run truly in parallel within one session?**
   v1 says no — one active agent per worktree at a time. v1.4 might allow if they're touching disjoint file sets, but coordination is hard.

3. **How does Echo (QA) review Atlas's work without context loss?**
   Sage passes Atlas's full diff + commit messages + the original task brief. Echo reviews against the brief.

4. **What happens if Sage hallucinates a team member that doesn't exist?**
   The `dispatch_agent` tool's enum schema prevents this server-side. Bad agent_id = tool error, Sage retries.

5. **How does the operator's "always allow" decision propagate?**
   Per (agent, project, tool) triple — see [v1 spec § Tool permission model](../specs/v1-mvp-spec.md). Stored in `tool_permissions` table.

These get resolved during the week 2-3 build through actual implementation, not in advance.