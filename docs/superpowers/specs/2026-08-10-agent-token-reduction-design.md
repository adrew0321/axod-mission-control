# Agent Token Reduction — Tier 1 Design (instrumentation, isolation, per-agent caps)

**Status:** Approved design (2026-08-10).
**Feature:** Cut the token and latency cost of every agent turn — especially dispatched
specialists — and, for the first time, **measure** it. Four moves at one chokepoint: record the
cache-token fields we currently drop, stop leaking the operator's personal Claude config into
every agent subprocess, give each agent a turn/budget ceiling, and set reasoning effort per role.

Triggered by the operator burning through the subscription usage window faster than expected,
specifically when Sage dispatches specialists.

---

## Why this slice, and not the bigger one

The single largest token cost in the system is almost certainly **not** in this slice: every turn
re-sends the whole session transcript as one fresh prompt string
(`buildOrchestratorPrompt` → `query({ prompt })` in `src/lib/run-turn.ts`), with no SDK
`resume`. Because that transcript is one growing text block, it cannot act as a stable cached
prefix, so per-session cost grows roughly quadratically with turn count.

Fixing that (Tier 2) changes what "the model's context" *is* — it stops being the DB transcript —
which ripples into `cleared_at`, `@`-mentions, the Discord path, and the scheduler. It deserves its
own spec.

**Tier 1 goes first because Tier 2 cannot be graded without it.** Session resume's entire value is
cache hits, and we do not currently record cache tokens. This slice is both a real cut and the
measuring stick for the next one.

## Locked decisions

- **Isolation level: project-only.** `settingSources: ['project']` + `strictMcpConfig: true`.
  Drops the user-scope github MCP server, the superpowers plugin and its SessionStart injection,
  and the operator's personal `effortLevel`/`model` settings. **Keeps** the target repo's own
  `CLAUDE.md` / `AGENTS.md`, which load automatically for any project — no re-injection code.
  Chosen because Atlas and the team are expected to change Mission Control on their own
  initiative, and this repo's `AGENTS.md` ("This is NOT the Next.js you know") is exactly the
  guidance they must not lose.
- **Cap behavior: stop and report back honestly.** A capped specialist returns its partial output
  to Sage clearly labelled as incomplete. No silent truncation, no auto-retry.
- **Knob storage: nullable columns on `agents`.** Same seam as `model` and `tools_allowlist`,
  retunable without a deploy.
- **Visibility: dashboard totals *and* AKIRA awareness.** Both, per the operator. Totals only —
  no charting — to hold the slice down.

## Components

### 1. The chokepoint (`src/lib/agent-runner-sdk.ts`)

Every agent turn — Sage, all five specialists, AKIRA, scheduler, dream, reflect — funnels through
`runClaudeAgent`. All four changes land here so none is missed.

**a. Isolation.** Add to the `query()` options:

```ts
settingSources: ['project'],
strictMcpConfig: true,
```

Per the SDK typings, omitting `settingSources` loads *all* filesystem settings (user, project,
local) plus plugins; omitting `strictMcpConfig` merges MCP servers from project `.mcp.json`, user
settings, and plugins. Today that means each agent subprocess boots the operator's global `github`
MCP server (~60 tool schemas from `~/.claude.json`) and takes the superpowers SessionStart hook
injection — neither of which any agent uses. Cost is per-dispatch and paid cold each time.

**b. New pass-through options** on `RunAgentOptions`, all optional:

```ts
effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
maxTurns?: number;
maxBudgetUsd?: number;
```

Forwarded to `query()` only when set, so an unset value keeps SDK default behavior.

**c. Usage capture moves out of the success branch.** Today usage is read only when
`message.subtype === 'success'`, so any run that errors, times out, or hits a cap records **zero**
tokens. `SDKResultError` carries `usage` and `total_cost_usd` too. Read usage for every `result`
message, and extend the `done` event:

```ts
| { type: 'done'; fullText: string; costUsd?: number; tokensIn?: number; tokensOut?: number;
    cacheReadTokens?: number; cacheCreationTokens?: number;
    stoppedBy?: 'max_turns' | 'max_budget' }
```

`cacheReadTokens` / `cacheCreationTokens` come from `usage.cacheReadInputTokens` /
`usage.cacheCreationInputTokens`.

**d. Cap hits become `done`, not fatal error.** Result subtypes `error_max_turns` and
`error_max_budget_usd` emit `done` with `stoppedBy` set and whatever text accumulated, so partial
work flows to the caller. Other error subtypes (`error_during_execution`,
`error_max_structured_output_retries`) keep today's fatal-error behavior.

### 2. Schema + migration (`src/db/schema.ts`, `drizzle/`)

Additive columns only — plain `ALTER TABLE ADD COLUMN`, **no table rebuild**, so this avoids the
FK-in-transaction failure documented for migration 0010.

`messages`:
- `cache_read_tokens` integer, nullable
- `cache_creation_tokens` integer, nullable

`agents`:
- `effort` text, nullable
- `max_turns` integer, nullable
- `max_budget_usd` real, nullable

All nullable: existing rows stay null, and null means "fall back to the documented default."

### 3. Per-agent defaults (`scripts/seed.ts`)

Added to the existing `onConflictDoUpdate` set so the deploy reseed applies them to the live rows.

| Agent | Role | effort | max_turns | max_budget_usd |
|---|---|---|---|---|
| sage | orchestrator | high | 30 | 3.0 |
| atlas | developer | high | 40 | 3.0 |
| forge | devops | high | 40 | 3.0 |
| pixel | designer | medium | 30 | 3.0 |
| nova | researcher | medium | 20 | 3.0 |
| echo | qa | medium | 15 | 3.0 |
| akira | concierge | low | 15 | 3.0 |

Rationale: Atlas and Forge do open-ended implementation and need room; Echo judges a diff that
already exists; AKIRA is a Haiku front-door concierge whose job is brevity.

`max_budget_usd` is a **runaway guard, not a spend cap** — the Mini authenticates with a
subscription OAuth token, but the SDK still computes `total_cost_usd` per turn, so the ceiling
works as a proxy for "this agent has gone off the rails."

### 4. Callers (`src/lib/dispatch.ts`, `src/lib/run-turn.ts`)

Both already load the agent row. Each passes `effort`, `maxTurns`, `maxBudgetUsd` through to
`runClaudeAgent`, and persists the two new usage fields alongside the existing ones.

`dispatch.ts` additionally handles `stoppedBy`. The tool result returned to Sage is prefixed with a
plain statement of what happened, e.g.:

> Atlas stopped early: hit its 40-turn cap before finishing. Files it already changed are in the
> worktree. Partial output follows.

The existing `dispatch_error` event carries the same fact to the operator's stream. This upholds
the shared execution-discipline rule: never present unfinished work as done.

### 5. Usage rollup (`src/lib/usage-rollup.ts`, new)

A pure module — no IO, never throws — matching the `fleet-snapshot` / `dream-insights` pattern.

```ts
export interface UsageRow {
  agentId: string | null;
  tokensIn: number | null; tokensOut: number | null;
  cacheReadTokens: number | null; cacheCreationTokens: number | null;
  costUsd: number | null;
}
export interface UsageTotals {
  tokensIn: number; tokensOut: number;
  cacheReadTokens: number; cacheCreationTokens: number;
  costUsd: number;
  messageCount: number;   // every row considered
  recordedCount: number;  // rows with any non-null usage field
}
export function rollUpUsage(rows: UsageRow[]): UsageTotals;
export function rollUpByAgent(rows: UsageRow[]): Record<string, UsageTotals>;
```

A null field contributes zero to its sum. `recordedCount` is what distinguishes "these agents used
zero tokens" from "these rows predate the migration" — the dashboard renders `—` instead of `0`
when `recordedCount === 0`. Unit-tested with `node:test` via `tsx`, extensionless imports (repo
convention).

### 6. Dashboard surface

A compact totals block: per-session token/cost totals on the session view, and a fleet-wide rollup
on the dashboard. Plain numbers — input, output, cache-read, cache-creation, cost. Messages
predating the migration render `—` rather than `0`, so history does not read as free.

### 7. AKIRA awareness (`src/lib/fleet-contributors.ts`, `src/lib/fleet-snapshot.ts`)

Token usage is a genuinely new *kind* of thing, so it gets a snapshot contributor and a
`FleetSnapshot` field: today's totals and the heaviest session. That lets AKIRA answer "what did
today burn?" from the front door without a dashboard trip.

## Data flow

1. `run-turn` / `dispatch` load the agent row → pass `effort` / `maxTurns` / `maxBudgetUsd`.
2. `runClaudeAgent` spawns an isolated subprocess (project settings only, no foreign MCP).
3. On the `result` message, usage is captured regardless of subtype; cap hits emit
   `done` + `stoppedBy`.
4. Callers persist all six usage fields to `messages`.
5. `usage-rollup` aggregates on read for the dashboard and the fleet snapshot.

## Testing

- `usage-rollup.ts` — totals, per-agent grouping, null handling, empty input. Pure unit tests.
- Cap-reason mapping — a pure helper translating a result subtype to `stoppedBy`, tested directly
  rather than through the SDK.
- Dispatch cap-labelling — the prefix text is produced by a pure function, tested independently of
  the runner.
- Regression: `pnpm test` + `pnpm exec tsc --noEmit` green before the merge to `dev`.

The `query()` options themselves are configuration, not logic; they are verified in the live smoke
test rather than mocked.

## Rollout

Standard `ship-mc-feature` path: isolated worktree off `dev` → merge to `dev` → version bump in
both `package.json` and `src/lib/version.ts` → `dev`→`main` release merge + tag → deploy to the
Mini.

Deploy notes:
- **Migration required** (additive only — safe under `pnpm db:migrate`).
- **Reseed required** — the per-agent defaults live in the seed upsert, and the live agents table
  is known to drift from the repo if the seed is skipped.
- **No new dependencies**, so skip `pnpm install` on the Mini per the runbook.

## Success criteria

After a live multi-turn session on the Mini:
- `messages.cache_read_tokens` / `cache_creation_tokens` are populated for new rows.
- A capped dispatch shows the honest "stopped early" text rather than a silent truncation.
- The dashboard totals and AKIRA's answer agree with a direct SQL sum.
- If cache reads sit near zero while input tokens climb turn over turn, that is the confirmation
  that Tier 2 (session resume) is the real fix — and this slice provides the baseline.

## Out of scope (→ later)

- **SDK session resume** (Tier 2) — the quadratic-transcript fix. Own spec, once this slice's data
  justifies it.
- **Summarizing specialist reports** before they enter Sage's transcript — a full Atlas report is
  currently replayed in every subsequent turn of the session.
- Charting, historical trend lines, or per-model cost breakdowns in the dashboard.
- Any change to model selection — Opus/Sonnet/Haiku assignment is already appropriate per role.

## Resolved decisions

- **Isolation:** project-only, not fully hermetic — chosen so agents keep repo `AGENTS.md`
  guidance when self-directing changes to Mission Control.
- **Cap behavior:** stop + honest partial report; no auto-continue.
- **Defaults:** tuned per role rather than one flat value.
- **Visibility:** dashboard totals *and* a fleet contributor for AKIRA.
