# Research — Hermes as the overarching ("Jarvis") agent

**Date:** 2026-06-23
**Status:** Research only — no design/commitment yet
**Goal:** Explore how to build **Hermes**, a single overarching agent the operator talks to
that handles all of Mission Control — "like Iron Man talking to Jarvis."

---

## Framing: we already have a one-level version

Sage is a lead-agent-with-dispatch — it orchestrates Atlas/Echo via the in-process
`dispatch_agent` tool in a shared per-session git worktree. That is already a 1-level
orchestrator-worker pattern.

**Hermes, as described, is the level _above_ Sage:** one persistent, cross-project agent the
operator converses with that can reach into every project, the pillars (Memory / Dreaming /
Scheduler), and the whole fleet. The three examples below each illuminate a different facet of
building that overarching layer.

Existing pieces that already point at Hermes:
- **`runSessionTurn`** (headless, sink-agnostic, lease-guarded) — the execution substrate.
- **Live Feed** — a fleet-wide activity stream (a natural audit trail for routing decisions).
- **Memory pillar + Dreaming/Curator** — long-term/cross-session memory substrate.
- **Scheduler** — recurring/overnight task execution.
- **Discord bot spec** (`docs/superpowers/specs/2026-06-22-discord-bot-design.md`) — a channel
  that, under the Hermes lens, becomes a *thin client into Hermes* rather than a separate thing.

---

## Example 1 — Anthropic orchestrator-worker ("lead agent + subagents")

**What it is.** A lead agent (Opus 4) analyzes a request, plans, and spawns 3–5 subagents
(Sonnet 4) that run **in parallel, each with its own context window**, then synthesizes their
findings. Beat single-agent Opus by **90.2%** on internal research evals.

**Mechanics worth stealing:**
- **Memory/checkpointing** — the lead saves its plan to external memory because context
  truncates past ~200K tokens; completed phases are summarized and stored before proceeding.
- **Artifact pattern** — subagents write output to external storage and pass back *lightweight
  references*, instead of routing everything through the lead (less token bloat / info loss).
- **Explicit delegation** — vague tasks caused duplicated work; each subagent needs objective,
  output format, tool guidance, and boundaries. Embed scaling rules (simple → 1 agent; complex
  → 10+).

**Use case for Hermes.** "Hermes, audit all projects for stale proposals and tell me what's
ready to merge" → spawn a read-only subagent per project in parallel, each returns a short
findings artifact, Hermes synthesizes one answer.

**⚠️ Key caveat (the most important finding).** Anthropic explicitly says this pattern is **not**
for "most coding tasks… domains requiring all agents to share context… tasks with heavy
interdependencies," and that multi-agent uses **~15× the tokens of a chat** (agents alone ~4×).
Mission Control's core dev loop is exactly that shared-context, interdependent case — which
Sage→Atlas already handles sequentially in one worktree. **So Hermes' sweet spot is breadth-first
fleet work (status, audits, cross-project ops), NOT re-architecting the dev loop into parallel
coders.**

---

## Example 2 — LangGraph supervisor (hierarchical, "supervisor-of-supervisors")

**What it is.** A central supervisor node receives every message, classifies intent, and routes
to specialist agents; control returns to it after each step. Explicitly supports **multi-level
hierarchy** (a supervisor managing other supervisors).

**Supervisor vs. swarm tradeoffs (measured in the source):**

| Metric | Supervisor | Swarm |
|---|---|---|
| Routing accuracy | ~94% | ~91% |
| Single-domain latency | ~4.2s | ~2.8s |
| LLM calls (single-domain) | 2 | 1 |

- **Supervisor** → centralized audit trail, routing precision, easier debugging; cost is extra
  latency/LLM calls and a potential bottleneck.
- **Swarm** (peer-to-peer handoff) → faster, but loses the audit trail and can ping-pong.
- **Recommended hybrid:** "supervisor to decide the lane, then in-lane handoffs."
- *"A multi-agent system without a recursion guard is a production incident waiting to happen."*

**Use case for Hermes.** The cleanest structural fit for "Hermes runs all of Mission Control":
Hermes = top supervisor (routes intent to the right *project*), Sage = per-project sub-supervisor
(routes to Atlas/Echo). One audit trail of every routing decision — maps onto the existing Live
Feed.

---

## Example 3 — "Jarvis" personal assistant on Claude Code ([enochko/jarvis](https://github.com/enochko/jarvis))

**Why it's the closest analog.** A Jarvis built on **Claude Code headless (`claude -p`)** — the
exact MC stack — whose philosophy is *"the agent engine is the product; channels are secondary."*

**Architecture worth copying:**
- **One engine, many thin channels** — a single agent endpoint; Telegram/web/CLI/Watch are thin
  clients that all call it. (→ the Discord bot becomes one channel into Hermes.)
- **Persistent memory layer** — Obsidian vault (facts + execution logs), RAG planned. (→ MC's
  Memory pillar + Dreaming.)
- **Overnight orchestrator** with scheduling, quotas, retry. (→ MC's Scheduler.)
- **Security hardening** — prompt-injection detection, no Bash tool, write-directory
  restrictions, one subprocess at a time (semaphore). Relevant because Hermes is high-privilege
  and reachable from chat.

**Use case for Hermes.** The "Iron Man ↔ Jarvis" experience: from Discord/web/voice, "Hermes,
what happened overnight?" → answers from Dreaming insights + Live Feed; "kick off the
landing-page redesign" → routes to that project's Sage. One voice, everywhere, with memory.

Other references in the space: [isair/jarvis](https://github.com/isair/jarvis) (private,
offline, "third person in the room", unlimited MCPs), [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
(Stanford SAIL local-first framework, eight built-in agent types).

---

## Convergent direction (for a future design, not committed)

- **Structure (from #2):** Hermes as a thin **supervisor/router above Sage** — intent →
  project/pillar, with a recursion guard. Reuse the headless turn runner + Live Feed as the
  audit trail.
- **Reasoning (from #1):** Hermes spawns **parallel read-only subagents only for breadth-first
  fleet tasks** (status/audits), using the artifact/reference pattern — deliberately **not** for
  the interdependent coding loop.
- **Experience (from #3):** "engine is the product" — Hermes is one agent with the pillars as its
  memory/scheduling, and channels (web, Discord) are thin clients into it.

**Open questions to resolve at design time:** where Hermes runs (in-process vs the turn runner);
how it holds cross-project state/memory; how routing decisions surface in the UI; cost controls
given the token multiples; and the security model for a high-privilege chat-reachable agent.

---

## Sources

- [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- [LangGraph Multi-Agent Supervisor (docs)](https://reference.langchain.com/python/langgraph-supervisor) ·
  [langgraph-supervisor-py (GitHub)](https://github.com/langchain-ai/langgraph-supervisor-py)
- [Supervisor vs Swarm: tradeoffs and architecture (DEV)](https://dev.to/focused_dot_io/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture-1b7e)
- [enochko/jarvis — Jarvis on Claude Code (GitHub)](https://github.com/enochko/jarvis) ·
  [isair/jarvis](https://github.com/isair/jarvis) ·
  [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
