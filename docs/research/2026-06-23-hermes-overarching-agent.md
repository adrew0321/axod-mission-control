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

## Expanded vision + web research (2026-06-28)

Operator's 40,000-ft goal: Hermes is the **personal "Jarvis / Bat-computer"** — a self-learning
assistant that is *also* the overseer of all the other agents, with real-world reach (Apple
calendar/phone, moving files laptop↔Mini, posting to YouTube/social), in service of building
**AXOD CREATIVE** (online presence, iOS/Android apps, content). Mapped to what people actually
ship today:

- **Self-learning assistant — strongest blueprint:** Nous Research's open-source **"Hermes Agent"**
  (same name) is a self-improving agent on a 5-pillar model — **Memory, Skills, Soul, Crons,
  Self-improvement**. "Self-improving" = *structured note-taking, not weight changes*: facts in
  `MEMORY.md`, per-user in `USER.md`, and it **writes a new skill doc every time it figures out
  something complex**. **MC already does all of this** (MEMORY.md + per-project memory, the
  `ship-mc-feature` skill, and the standing "watch for repeated workflows → make a skill"
  instruction). So our Hermes = formalize the 5 pillars on top of MC's existing substrate.
- **Overseer of the agents:** the supervisor-above-Sage structure from the convergent direction
  above. Hermes routes intent → project/pillar; Sage stays the in-project orchestrator.
- **Apple calendar / phone:** MCP servers exist — `mcp-server-apple-events` (Reminders+Calendar via
  EventKit), **Macuse** (Calendar/Mail/Notes/Reminders/Messages via on-device Computer Use), **iMCP**
  (Swift, iMessage/Calendar/Contacts/Reminders). **Constraint:** these are macOS-native and need the
  iCloud account on that Mac — but the Mini now runs **Ubuntu**, and the operator's dev box is
  **Windows**. So calendar/phone access needs one of: (a) **iCloud CalDAV** (cross-platform, no Mac),
  (b) run an EventKit MCP on an actual Mac signed into the Apple ID, or (c) iPhone Shortcuts. Decide
  at design time; CalDAV is the most portable.
- **Move files laptop↔Mini:** low-effort — MC already SSHes to the Mini; add an `rsync`/`scp` or
  filesystem-MCP transfer capability. No new infra.
- **YouTube / social posting:** **Postiz** (open-source, **self-hostable**, 30+ networks incl.
  YouTube/TikTok/IG/X/LinkedIn, **built-in MCP server** + REST API, explicitly supports "Hermes"
  agents) is the cleanest path. Caveat from the survey: most social MCPs *can't actually publish* —
  Postiz and Socialync are the real ones.
- **Architecture precedent:** Jarvis-on-Claude-Code builds (enochko/Ramsbaby/isair `jarvis`) = one
  engine + thin channels (Discord), MCP tools (exec/file/rag), macOS LaunchAgents for crons, RAG
  memory. MC ≈ this already; Hermes is the missing router/persona layer.

**Reality checks for the design:** (1) **Cost** — parallel multi-agent ≈15× a chat's tokens, so keep
Hermes mostly single-agent chat+tools and reserve parallel subagents for breadth-first audits
(matters on the Pro window). (2) **Security** — Hermes is high-privilege + chat-reachable: prompt-
injection defense, no raw Bash, write-dir restrictions, one subprocess at a time (the jarvis builds
all do this). (3) **Apple access** is the one genuinely hard integration (see constraint above);
everything else is additive MCP tools.

**Recommended phasing (multi-stage, not one build):**
1. **Hermes Phase 1 — self-learning fleet assistant:** the router above Sage + the 5-pillar
   memory/skills formalized + "what happened overnight / what's ready to merge" (read-only, breadth-
   first) + laptop↔Mini file movement. Cheap, high-wow, low-risk.
2. **Phase 2 — integrations as MCP tools:** Postiz (social/YouTube), then calendar (CalDAV).
3. **Phase 3 — cross-project dispatch + voice.**
Each integration is a clean add-on once the Phase 1 engine exists.

### Tina Huang / Nous "Hermes Agent OS" — and why MC is already this

- **Hermes is a shipped product** (Nous Research, Feb 2026; repo `NousResearch/hermes-agent`).
  Confirmed pillars: **Memory** (agent-curated, FTS5 cross-session recall + LLM summarization),
  **Skills** (autonomous creation + self-improvement during use; agentskills.io standard),
  **SOUL.md** (persona/voice), **Crons** (built-in, deliver to any platform), **Self-improvement**
  loop. Runs on **Nous Portal / OpenRouter / OpenAI / any endpoint** (NOT Claude-SDK-native);
  20+ messaging platforms, 60+ tools + MCP, 6 terminal backends (local/Docker/SSH/Daytona/
  Singularity/Modal); security = command approval + authorization + container isolation.
- **The "Agent OS / Mission Control" pattern people build around it** (the Tina-Huang-adjacent
  setup the operator referenced): a local dashboard over multiple agents on **4 layers** —
  Intelligence (Claude: reason/plan), Execution (OpenClaw: route/sessions), Research (Hermes:
  background workflows/Kanban/skills), **Self (Obsidian + OMI: records activity/mic → compounding
  personalized knowledge)**. Local-first. The Self layer is the differentiator: day-1 useful →
  day-30 business-specific.
- **Strategic read:** AXOD MC has *organically built this same Agent OS* — but as ONE
  Claude-Agent-SDK-native app (Sage/Atlas/Echo/Forge + Memory + Dreaming + Scheduler + Live Feed +
  Discord) instead of gluing Hermes+OpenClaw+Obsidian+OMI together. MC already has **4 of Hermes's
  5 pillars**: memory, skills (incl. autonomous skill-writing), crons (Scheduler), self-improvement
  (the standing "make a skill" instruction). The missing pieces are a **SOUL.md persona** + the
  **top-level router**.
- **Recommendation — build Hermes NATIVE; don't bolt on the Nous product.** Adopting Nous Hermes
  would fragment MC's clean Claude stack (endpoint-agnostic/non-Claude, its own gateway/terminals).
  Instead **borrow its proven patterns** into MC's own Hermes layer: a `SOUL.md` persona,
  FTS5/LLM-summarized memory recall, a formalized 5-pillar self-improvement loop, and real-world
  reach delivered as **MCP tools** (Postiz for social/YouTube, CalDAV/EventKit for calendar, rsync
  for files). The "Self-layer" compounding = deepen MC's existing Memory + Dreaming.

## Sources

- [How we built our multi-agent research system — Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- [LangGraph Multi-Agent Supervisor (docs)](https://reference.langchain.com/python/langgraph-supervisor) ·
  [langgraph-supervisor-py (GitHub)](https://github.com/langchain-ai/langgraph-supervisor-py)
- [Supervisor vs Swarm: tradeoffs and architecture (DEV)](https://dev.to/focused_dot_io/multi-agent-orchestration-in-langgraph-supervisor-vs-swarm-tradeoffs-and-architecture-1b7e)
- [enochko/jarvis — Jarvis on Claude Code (GitHub)](https://github.com/enochko/jarvis) ·
  [isair/jarvis](https://github.com/isair/jarvis) ·
  [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
