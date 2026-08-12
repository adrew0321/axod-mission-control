# Agent model & provider strategy — Ollama evaluation + Echo diversity

**Date:** 2026-08-11
**Status:** Decided, not implemented. Review before acting.

## Context

An external proposal recommended migrating AKIRA and the agent roster from Claude to
Ollama-hosted local models (Qwen3-Coder 30B for most agents, GPT-OSS 20B for Echo),
adding a `provider` field per agent, and building dynamic capability-based agent discovery.

This document records the review of that proposal and the decided next steps.

## What the proposal got right

- **Model diversity for Echo.** Atlas and Echo running identical weights with the same
  context is a fake second opinion — correlated blind spots, correlated hallucinations.
  Echo's whole value is being decorrelated from Atlas. This holds independent of Ollama.
- **Provider as a first-class field.** `agents` (src/db/schema.ts:14-27) already carries
  `model`, `tools_allowlist`, `effort`, `max_turns`, `max_budget_usd` per agent. The
  proposed "model profile" is mostly built already.
- **Add Ollama as a second provider rather than replacing Claude.** Correct sequencing;
  the only way to get a real A/B comparison.

## What the proposal missed

### 1. There is no model API to swap — there is the Claude Agent SDK

`src/lib/agent-runner-sdk.ts:136` calls `query()` from `@anthropic-ai/claude-agent-sdk`,
which spawns the `claude` CLI subprocess. The DB `model` string is passed through at
line 140. The agent loop, tool execution, MCP servers, `allowedTools`, the `maxTurns` /
`maxBudgetUsd` caps, streaming deltas, and cache-token accounting all belong to the SDK.
Ollama does not speak that protocol.

`provider: 'ollama'` is therefore not a config change. It is one of:

- **Proxy route** — point the CLI at an Anthropic-compatible shim (LiteLLM /
  claude-code-router) via `ANTHROPIC_BASE_URL`. Keeps the whole loop. Cheapest.
  Risk: local models' tool-call fidelity through a translation layer.
- **Second runner** — write `runOllamaAgent` emitting the same `AgentEvent` union, with
  its own tool loop and Read/Edit/Bash implementations. That is rebuilding the agent
  loop — the cost already identified as the real price of AKIRA sovereignty.

`AgentEvent` is a clean seam and `dispatch.ts` / `run-turn.ts` / `akira-turn.ts` /
`dream.ts` / `reflect.ts` all consume it. But `akira/tools.ts`, `akira/browser-tools.ts`,
and `dispatch.ts` import the SDK directly, so the seam leaks.

### 2. The hardware does not exist

The Mini is a 16GB A1347 with no usable GPU. Qwen3-Coder 30B — even the MoE at Q4,
~18GB — does not fit, and would run at single-digit tokens/sec on that CPU. Every row
of the proposal's model table assumes a GPU box. **Confirmed with operator: no GPU box
yet.** This is the gate on everything else.

### 3. The cost argument is near-zero here

`agent-runner-sdk.ts:72-76` states it: the Mini authenticates with a subscription token,
so `maxBudgetUsd` is a runaway proxy, not a bill. Local inference buys sovereignty and
privacy — not savings.

### 4. Capability discovery is a separate feature

Dynamic agent selection is orthogonal to provider swap and YAGNI at six agents. Sage can
already see the roster. Do not let it ride along.

### 5. Prompt portability is a real tax

Prompts are long and Claude-tuned (shared execution-discipline clause, SOUL injection,
memory injection). A 20-30B local model follows those much worse. Any agent moved local
needs prompt re-tuning **and** a reseed.

## Decided sequencing

### Step 1 — Timeboxed spike (do first, before any schema work)

Throwaway branch on the laptop. Ollama + a small model, LiteLLM or claude-code-router in
front, `ANTHROPIC_BASE_URL` pointed at it, one Echo-shaped task through `runClaudeAgent`.

Answers exactly one question: **does the CLI's tool loop work against a translated local
model, or does it fall apart on tool-call formatting?**

That answer decides whether `provider` is a config field or a ground-up second runner.
Half a day. No migration, no release.

### Step 2 — Echo model diversity (free, take it now)

**Decision: move Echo to `claude-opus-5`.**

Rationale:
- Opus 5 has both high precision and high recall on code review and bug-finding — the
  extra findings are mostly real rather than false positives. That is Echo's job.
- Largest decorrelation available inside the Claude family: Atlas is `claude-sonnet-4-6`,
  so Opus 5 is a different tier *and* two generations off. Also decorrelates Echo from
  Sage (`claude-opus-4-7`).
- The cost objection does not apply — subscription token, so the real price is latency.

Concrete changes at `scripts/seed.ts:183-194`:

| Field | From | To | Why |
|---|---|---|---|
| `model` | `claude-sonnet-4-6` | `claude-opus-5` | the decision |
| `max_budget_usd` | `3` | `~5` | Opus 5 is $5/$25 vs Sonnet 4.6's $3/$15 — the runaway guard trips ~40% earlier and turns long reviews into `stoppedBy` caps instead of verdicts |
| `effort` | `medium` | `medium` (unchanged) | Opus 5 stays accurate at lower effort on review work — capability gain without full latency cost. Test `high` later, don't start there |

Then **reseed on deploy** — a stale live prompt has bitten this project before.

`ECHO_SYSTEM_PROMPT` (`scripts/seed.ts:43-64`) needs **no changes**. Newer models follow
"only report high-severity" / "be conservative" instructions literally, which tanks
measured recall; Echo's prompt already asks for a per-finding severity tag, which is the
pattern these models want. The "do NOT nitpick style the project does not enforce" line
is a scoped constraint, not a blanket filter — keep it.

Runner-up was `claude-opus-4-8` (same price, one generation back, still a real gap from
Atlas) if Opus 5 proves too slow. `claude-sonnet-5` was rejected: staying in Sonnet tier
is the weakest decorrelation available and defeats the purpose.

### Step 3 — `provider` column and model profile (deferred)

Right idea, wrong time. Building it before the spike means designing a seam without
knowing its shape. If the spike says the SDK cannot drive local models, the abstraction
needed is a whole second runner emitting `AgentEvent`, not a config field.

### Not doing

- Migrating the roster to Ollama — no hardware.
- Capability-based dynamic agent discovery — YAGNI at six agents.
- A second paid cloud vendor for Echo — needs the same proxy plumbing as the spike, so
  it is not a cheaper shortcut; it falls out of Step 1 if the shim works.

## Side note

The whole roster is on prior-generation model IDs (`claude-opus-4-7`, `claude-sonnet-4-6`).
Nothing is broken — those are still active — but Opus 5 and Sonnet 5 are current whenever
a full sweep is wanted.
