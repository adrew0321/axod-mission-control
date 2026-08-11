# Agent Token Reduction (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the token and latency cost of every agent turn — and record, for the first time, the cache-token figures that reveal where the spend actually goes.

**Architecture:** All agent turns funnel through one function, `runClaudeAgent` in `src/lib/agent-runner-sdk.ts`. Four changes land there: isolate the subprocess from the operator's personal Claude config, accept per-agent effort/turn/budget knobs, capture usage on *every* result (not just successes), and turn cap-hits into a labelled partial result instead of a fatal error. Two new pure modules carry the logic that can be tested without the SDK; the knobs live as nullable columns on `agents`; the recorded numbers surface in the existing dashboard topbar and in AKIRA's fleet snapshot.

**Tech Stack:** Next.js (see `AGENTS.md` — this is not the Next.js you know), TypeScript, Drizzle ORM + SQLite (better-sqlite3), `@anthropic-ai/claude-agent-sdk` 0.3.153, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-10-agent-token-reduction-design.md`

## Global Constraints

- **No new dependencies.** The Mini's deploy skips `pnpm install`; adding a dep breaks that and risks the hand-compiled `better-sqlite3` binding.
- **Migrations must be additive only** — `ALTER TABLE ADD COLUMN`. A migration that recreates a table fails under `pnpm db:migrate` (FK-in-transaction).
- **Tests:** `node:test` via `tsx`. Import with **extensionless** paths (`./agent-caps`, not `./agent-caps.ts`) — the `.ts` extension breaks `tsc` and the Next build.
- **Test files are pure**: no `server-only`, no `@/db/client` import, or the tsx runner cannot load them.
- **Both gates green before merge:** `pnpm test` and `pnpm exec tsc --noEmit`.
- **Work in an isolated worktree off `dev`.** Never branch-switch the live checkout. Merge to `dev`, never straight to `main`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Effort values** are exactly: `low` | `medium` | `high` | `xhigh` | `max`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/agent-caps.ts` *(new)* | Pure: resolve per-agent caps with defaults, map SDK result subtype → stop reason, compose the cap-notice sentence |
| `src/lib/agent-caps.test.ts` *(new)* | Unit tests for the above |
| `src/lib/usage-rollup.ts` *(new)* | Pure: sum usage rows into totals, group by agent |
| `src/lib/usage-rollup.test.ts` *(new)* | Unit tests for the above |
| `src/db/schema.ts` | +2 columns on `messages`, +3 on `agents` |
| `drizzle/0012_*.sql` *(generated)* | The additive migration |
| `src/lib/agent-runner-sdk.ts` | Isolation, knob pass-through, usage capture, `stoppedBy` |
| `src/lib/run-turn.ts` | Pass knobs from the agent row; persist cache tokens |
| `src/lib/dispatch.ts` | Pass knobs; persist cache tokens; label capped results |
| `src/lib/akira-turn.ts` | Pass AKIRA's knobs |
| `src/lib/dream.ts`, `src/lib/akira/reflect.ts` | Literal caps for the two single-shot read-only passes |
| `scripts/seed.ts` | Per-role defaults in the agents upsert |
| `src/lib/usage-data.ts` *(new)* | Server-only: today's fleet usage totals from the DB |
| `src/lib/fleet-snapshot.ts` | +`usage` slice on `FleetSnapshot` |
| `src/lib/fleet-contributors.ts` | +usage contributor |
| `src/lib/akira/prompt.ts` | Render the usage line into AKIRA's snapshot block |
| `src/lib/mock-data.ts` | +cache fields on the `Session` type |
| `src/app/dashboard/page.tsx` | Extend the existing session totals query |
| `src/components/mission-control.tsx` | Two more chips in the existing topbar totals row |

---

### Task 1: Pure caps module

**Files:**
- Create: `src/lib/agent-caps.ts`
- Test: `src/lib/agent-caps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type EffortLevel`, `type StoppedBy`, `interface ResolvedCaps { effort: EffortLevel; maxTurns: number; maxBudgetUsd: number }`, `resolveCaps(row)`, `stoppedByFromSubtype(subtype: string): StoppedBy | null`, `capNotice(agentName: string, stoppedBy: StoppedBy, limit: number): string`, and `DEFAULT_CAPS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent-caps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCaps, stoppedByFromSubtype, capNotice, DEFAULT_CAPS } from './agent-caps';

test('resolveCaps uses the row values when present', () => {
  const caps = resolveCaps({ effort: 'high', max_turns: 40, max_budget_usd: 3 });
  assert.deepEqual(caps, { effort: 'high', maxTurns: 40, maxBudgetUsd: 3 });
});

test('resolveCaps falls back to defaults on null/missing row', () => {
  assert.deepEqual(resolveCaps(null), DEFAULT_CAPS);
  assert.deepEqual(resolveCaps(undefined), DEFAULT_CAPS);
  assert.deepEqual(resolveCaps({ effort: null, max_turns: null, max_budget_usd: null }), DEFAULT_CAPS);
});

test('resolveCaps falls back per-field, not all-or-nothing', () => {
  const caps = resolveCaps({ effort: null, max_turns: 12, max_budget_usd: null });
  assert.equal(caps.maxTurns, 12);
  assert.equal(caps.effort, DEFAULT_CAPS.effort);
  assert.equal(caps.maxBudgetUsd, DEFAULT_CAPS.maxBudgetUsd);
});

test('resolveCaps rejects an unknown effort string', () => {
  assert.equal(resolveCaps({ effort: 'turbo', max_turns: null, max_budget_usd: null }).effort, DEFAULT_CAPS.effort);
});

test('resolveCaps rejects non-positive numeric caps', () => {
  const caps = resolveCaps({ effort: null, max_turns: 0, max_budget_usd: -1 });
  assert.equal(caps.maxTurns, DEFAULT_CAPS.maxTurns);
  assert.equal(caps.maxBudgetUsd, DEFAULT_CAPS.maxBudgetUsd);
});

test('stoppedByFromSubtype maps only the two cap subtypes', () => {
  assert.equal(stoppedByFromSubtype('error_max_turns'), 'max_turns');
  assert.equal(stoppedByFromSubtype('error_max_budget_usd'), 'max_budget');
  assert.equal(stoppedByFromSubtype('error_during_execution'), null);
  assert.equal(stoppedByFromSubtype('success'), null);
});

test('capNotice names the agent, the cap, and where partial work lives', () => {
  const turns = capNotice('Atlas', 'max_turns', 40);
  assert.match(turns, /Atlas stopped early/);
  assert.match(turns, /40-turn cap/);
  assert.match(turns, /worktree/);

  const budget = capNotice('Forge', 'max_budget', 3);
  assert.match(budget, /Forge stopped early/);
  assert.match(budget, /\$3 budget guard/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/agent-caps.test.ts`
Expected: FAIL — cannot find module `./agent-caps`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/agent-caps.ts
// Pure per-agent execution caps: resolution with defaults, SDK stop-reason
// mapping, and the operator-facing notice for a capped run. No IO, never throws,
// so the tsx test runner can import it directly.

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type StoppedBy = 'max_turns' | 'max_budget';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ResolvedCaps {
  effort: EffortLevel;
  maxTurns: number;
  maxBudgetUsd: number;
}

/** Applied when an agent row leaves a cap null. Deliberately conservative:
 *  a new agent gets a safe ceiling until someone tunes its row. */
export const DEFAULT_CAPS: ResolvedCaps = {
  effort: 'medium',
  maxTurns: 20,
  maxBudgetUsd: 3,
};

export interface CapsRow {
  effort?: string | null;
  max_turns?: number | null;
  max_budget_usd?: number | null;
}

const positive = (n: number | null | undefined, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;

/** Resolve an agent row's caps, falling back per-field so a partially-tuned
 *  row keeps the values it does set. */
export function resolveCaps(row: CapsRow | null | undefined): ResolvedCaps {
  const effort = EFFORT_LEVELS.find((e) => e === row?.effort) ?? DEFAULT_CAPS.effort;
  return {
    effort,
    maxTurns: positive(row?.max_turns, DEFAULT_CAPS.maxTurns),
    maxBudgetUsd: positive(row?.max_budget_usd, DEFAULT_CAPS.maxBudgetUsd),
  };
}

/** A cap hit is a *bounded stop*, not a crash — the SDK reports it as an error
 *  subtype, but partial work is real and must reach the operator. Other error
 *  subtypes stay fatal. */
export function stoppedByFromSubtype(subtype: string): StoppedBy | null {
  if (subtype === 'error_max_turns') return 'max_turns';
  if (subtype === 'error_max_budget_usd') return 'max_budget';
  return null;
}

/** The sentence prefixed to a capped specialist's report. Never claim done. */
export function capNotice(agentName: string, stoppedBy: StoppedBy, limit: number): string {
  const cap = stoppedBy === 'max_turns' ? `${limit}-turn cap` : `$${limit} budget guard`;
  return (
    `${agentName} stopped early: hit its ${cap} before finishing the task. ` +
    `Any files it already changed are in the worktree. Partial output follows.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/agent-caps.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-caps.ts src/lib/agent-caps.test.ts
git commit -m "feat(agents): pure per-agent cap resolution + stop-reason mapping

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Pure usage rollup module

**Files:**
- Create: `src/lib/usage-rollup.ts`
- Test: `src/lib/usage-rollup.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface UsageRow`, `interface UsageTotals`, `emptyTotals()`, `rollUpUsage(rows: UsageRow[]): UsageTotals`, `rollUpByAgent(rows: UsageRow[]): Record<string, UsageTotals>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/usage-rollup.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollUpUsage, rollUpByAgent, emptyTotals, type UsageRow } from './usage-rollup';

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  agentId: 'atlas',
  tokensIn: 100,
  tokensOut: 20,
  cacheReadTokens: 900,
  cacheCreationTokens: 50,
  costUsd: 0.25,
  ...over,
});

test('empty input yields zeroed totals', () => {
  assert.deepEqual(rollUpUsage([]), emptyTotals());
});

test('sums every field across rows', () => {
  const t = rollUpUsage([row(), row()]);
  assert.equal(t.tokensIn, 200);
  assert.equal(t.tokensOut, 40);
  assert.equal(t.cacheReadTokens, 1800);
  assert.equal(t.cacheCreationTokens, 100);
  assert.equal(t.costUsd, 0.5);
  assert.equal(t.messageCount, 2);
  assert.equal(t.recordedCount, 2);
});

test('null fields contribute zero but still count as a message', () => {
  const t = rollUpUsage([
    row(),
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.tokensIn, 100);
  assert.equal(t.messageCount, 2);
  assert.equal(t.recordedCount, 1); // the all-null row was never instrumented
});

test('recordedCount is zero when nothing was ever recorded', () => {
  const t = rollUpUsage([
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: null, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.recordedCount, 0);
  assert.equal(t.messageCount, 1);
});

test('a row with any non-null field counts as recorded', () => {
  const t = rollUpUsage([
    { agentId: 'sage', tokensIn: null, tokensOut: null, cacheReadTokens: 7, cacheCreationTokens: null, costUsd: null },
  ]);
  assert.equal(t.recordedCount, 1);
  assert.equal(t.cacheReadTokens, 7);
});

test('rollUpByAgent groups by agent id', () => {
  const byAgent = rollUpByAgent([row(), row({ agentId: 'echo', tokensIn: 5 })]);
  assert.equal(byAgent.atlas.tokensIn, 100);
  assert.equal(byAgent.echo.tokensIn, 5);
  assert.equal(Object.keys(byAgent).length, 2);
});

test('rollUpByAgent buckets a null agent id under "unknown"', () => {
  const byAgent = rollUpByAgent([row({ agentId: null })]);
  assert.equal(byAgent.unknown.tokensIn, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/usage-rollup.test.ts`
Expected: FAIL — cannot find module `./usage-rollup`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/usage-rollup.ts
// Pure token-usage aggregation. No IO, never throws — the tsx test runner
// imports it directly, and both the dashboard and AKIRA's fleet snapshot read
// through it so they can never disagree about the arithmetic.

export interface UsageRow {
  agentId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
}

export interface UsageTotals {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** Every row considered. */
  messageCount: number;
  /** Rows carrying at least one non-null usage field. Distinguishes "used zero
   *  tokens" from "predates the instrumentation" — the UI shows a dash, not 0,
   *  when this is zero. */
  recordedCount: number;
}

export function emptyTotals(): UsageTotals {
  return {
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    messageCount: 0,
    recordedCount: 0,
  };
}

const num = (n: number | null): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

const isRecorded = (r: UsageRow): boolean =>
  [r.tokensIn, r.tokensOut, r.cacheReadTokens, r.cacheCreationTokens, r.costUsd].some(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );

export function rollUpUsage(rows: UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) {
    t.tokensIn += num(r.tokensIn);
    t.tokensOut += num(r.tokensOut);
    t.cacheReadTokens += num(r.cacheReadTokens);
    t.cacheCreationTokens += num(r.cacheCreationTokens);
    t.costUsd += num(r.costUsd);
    t.messageCount += 1;
    if (isRecorded(r)) t.recordedCount += 1;
  }
  return t;
}

export function rollUpByAgent(rows: UsageRow[]): Record<string, UsageTotals> {
  const out: Record<string, UsageRow[]> = {};
  for (const r of rows) {
    const key = r.agentId ?? 'unknown';
    (out[key] ??= []).push(r);
  }
  return Object.fromEntries(Object.entries(out).map(([k, rs]) => [k, rollUpUsage(rs)]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/usage-rollup.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/usage-rollup.ts src/lib/usage-rollup.test.ts
git commit -m "feat(usage): pure token-usage rollup with recorded-vs-zero distinction

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Schema columns + additive migration

**Files:**
- Modify: `src/db/schema.ts` (agents table at :14-22, messages table at :45-57)
- Create (generated): `drizzle/0012_*.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: DB columns `messages.cache_read_tokens`, `messages.cache_creation_tokens`, `agents.effort`, `agents.max_turns`, `agents.max_budget_usd`. All nullable.

- [ ] **Step 1: Add the agents columns**

In `src/db/schema.ts`, the `agents` table becomes:

```ts
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  model: text('model').notNull(),
  system_prompt: text('system_prompt').notNull(),
  tools_allowlist: text('tools_allowlist', { mode: 'json' }).$type<string[]>(),
  color: text('color'),
  // Per-agent execution caps. Nullable → src/lib/agent-caps.ts DEFAULT_CAPS
  // applies. Kept in the DB (not code) so they can be retuned without a deploy.
  effort: text('effort'),
  max_turns: integer('max_turns'),
  max_budget_usd: real('max_budget_usd'),
});
```

- [ ] **Step 2: Add the messages columns**

In the same file, append to the `messages` table, after `cost_usd`:

```ts
  cost_usd: real('cost_usd'),
  // Cache accounting. Null on rows written before this migration — that is
  // "not recorded", not "zero" (see src/lib/usage-rollup.ts recordedCount).
  cache_read_tokens: integer('cache_read_tokens'),
  cache_creation_tokens: integer('cache_creation_tokens'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
```

`integer`, `text`, and `real` are already imported in this file — no import change.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0012_<name>.sql` plus an updated `drizzle/meta/_journal.json`.

- [ ] **Step 4: Verify the migration is additive**

Run: `cat drizzle/0012_*.sql`
Expected: **only** `ALTER TABLE ... ADD ...` statements — five of them. If you see `CREATE TABLE __new_`, `DROP TABLE`, or `RENAME`, stop: a table rebuild will fail on the Mini under `pnpm db:migrate`, and this plan's design requires additive-only.

- [ ] **Step 5: Apply locally and confirm typecheck**

Run: `pnpm db:migrate && pnpm exec tsc --noEmit`
Expected: migration applies clean; tsc reports no errors.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): additive columns for cache tokens and per-agent caps

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The chokepoint — isolation, knobs, usage capture, cap handling

**Files:**
- Modify: `src/lib/agent-runner-sdk.ts`

**Interfaces:**
- Consumes: `resolveCaps` is *not* used here — callers pass explicit values. Uses `stoppedByFromSubtype` and `type EffortLevel`, `type StoppedBy` from `./agent-caps` (Task 1).
- Produces: `RunAgentOptions` gains `effort?: EffortLevel`, `maxTurns?: number`, `maxBudgetUsd?: number`. The `done` event gains `cacheReadTokens?: number`, `cacheCreationTokens?: number`, `stoppedBy?: StoppedBy`.

- [ ] **Step 1: Extend the event type and options**

At the top of `src/lib/agent-runner-sdk.ts`, add the import and change the `done` variant:

```ts
import { withExecutionDiscipline } from './agent-discipline';
import { stoppedByFromSubtype, type EffortLevel, type StoppedBy } from './agent-caps';

export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; content: string; isError: boolean }
  | {
      type: 'done';
      fullText: string;
      costUsd?: number;
      tokensIn?: number;
      tokensOut?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      /** Set when the run ended by hitting a cap rather than finishing. */
      stoppedBy?: StoppedBy;
    }
  | { type: 'error'; message: string; fatal: boolean };
```

Then add to `RunAgentOptions`, just above `signal?: AbortSignal;`:

```ts
  /**
   * Reasoning effort for this agent. Lower effort means fewer, more consolidated
   * tool calls and less preamble — the main latency and token lever we have that
   * doesn't change the model.
   */
  effort?: EffortLevel;
  /** Hard ceiling on agent turns. A runaway loop becomes a bounded stop. */
  maxTurns?: number;
  /**
   * Runaway guard in USD. The Mini authenticates with a subscription token, so
   * this is not a billing limit — the SDK still computes per-turn cost, so it
   * works as a proxy for "this agent has gone off the rails".
   */
  maxBudgetUsd?: number;
```

- [ ] **Step 2: Destructure the new options**

Change the destructuring at the top of `runClaudeAgent`:

```ts
  const {
    prompt,
    workingDir,
    model,
    systemPrompt,
    signal,
    mcpServers,
    extraAllowedTools,
    extraEnv,
    effort,
    maxTurns,
    maxBudgetUsd,
  } = opts;
```

- [ ] **Step 3: Isolate the subprocess and pass the knobs**

In the `query({ options: { ... } })` object, after the `allowedTools: autoRun,` line, add:

```ts
        // Isolation: load ONLY the target repo's own settings (which includes its
        // CLAUDE.md / AGENTS.md — agents changing this repo must keep that
        // guidance), and only the MCP servers we pass explicitly. Without these,
        // every agent subprocess also inherits the operator's user-scope config:
        // the global `github` MCP server (~60 tool schemas) and the superpowers
        // plugin's SessionStart injection — neither of which any agent uses.
        settingSources: ['project'],
        strictMcpConfig: true,
        ...(effort ? { effort } : {}),
        ...(maxTurns ? { maxTurns } : {}),
        ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
```

- [ ] **Step 4: Capture usage on every result, and treat caps as a bounded stop**

Replace the whole `else if (message.type === 'result') { ... }` block (currently lines 182-199) with:

```ts
      } else if (message.type === 'result') {
        // Usage is present on BOTH the success and error result shapes. Reading
        // it only on success meant every errored, timed-out, or capped run
        // recorded zero tokens — precisely the runs worth accounting for.
        const usage = {
          costUsd: message.total_cost_usd,
          tokensIn: message.usage?.input_tokens,
          tokensOut: message.usage?.output_tokens,
          cacheReadTokens: message.usage?.cacheReadInputTokens,
          cacheCreationTokens: message.usage?.cacheCreationInputTokens,
        };

        if (message.subtype === 'success') {
          if (!fullText && message.result) {
            fullText = message.result;
            yield { type: 'token', content: message.result };
          }
          yield { type: 'done', fullText, ...usage };
        } else {
          const stoppedBy = stoppedByFromSubtype(message.subtype);
          if (stoppedBy) {
            // A cap hit is a bounded stop, not a crash: whatever the agent
            // produced so far is real work. Hand it back as `done` + stoppedBy
            // so the caller can report it honestly instead of losing it.
            yield { type: 'done', fullText, ...usage, stoppedBy };
          } else {
            const detail =
              'errors' in message && message.errors?.length ? `: ${message.errors.join('; ')}` : '';
            // Fatal: a non-cap failure result means the agent turn ended badly.
            yield { type: 'error', message: `agent ended (${message.subtype})${detail}`, fatal: true };
          }
        }
      }
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. If `settingSources` rejects `['project']`, widen it to `settingSources: ['project'] as const` — the SDK types it as `SettingSource[]`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-runner-sdk.ts
git commit -m "feat(agents): isolate agent subprocesses + capture cache usage + bounded caps

settingSources project-only and strictMcpConfig keep the operator's global
github MCP server and superpowers plugin out of every dispatched agent.
Usage is now read on error results too, so capped/failed runs stop
recording zero tokens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Persist cache tokens and pass knobs from `run-turn`

**Files:**
- Modify: `src/lib/run-turn.ts`

**Interfaces:**
- Consumes: `resolveCaps` from `./agent-caps` (Task 1); the extended `done` event (Task 4); the new `messages` columns (Task 3).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Import and resolve the primary agent's caps**

Add to the imports:

```ts
import { resolveCaps } from '@/lib/agent-caps';
```

After `const primaryId = primary?.id ?? 'sage';` (currently line 138), add:

```ts
    const primaryCaps = resolveCaps(primary);
```

- [ ] **Step 2: Widen the usage variables and the flush signature**

Replace the usage locals (currently lines 144-146) with:

```ts
    let costUsd: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreationTokens: number | undefined;
```

Change `flushPrimary` to accept and persist them:

```ts
    const flushPrimary = async (usage?: {
      costUsd?: number;
      tokensIn?: number;
      tokensOut?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    }) => {
      if (!primaryBuffer.trim()) return;
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        agent_id: primaryId,
        role: 'agent',
        content: primaryBuffer,
        token_count_in: usage?.tokensIn,
        token_count_out: usage?.tokensOut,
        cache_read_tokens: usage?.cacheReadTokens,
        cache_creation_tokens: usage?.cacheCreationTokens,
        cost_usd: usage?.costUsd,
        created_at: new Date(),
      });
      primaryBuffer = '';
      primaryEmitted = true;
    };
```

- [ ] **Step 3: Pass the caps into the runner**

In the `runClaudeAgent({ ... })` call (currently line 219), add after `allowedTools: primary?.tools_allowlist ?? undefined,`:

```ts
      effort: primaryCaps.effort,
      maxTurns: primaryCaps.maxTurns,
      maxBudgetUsd: primaryCaps.maxBudgetUsd,
```

- [ ] **Step 4: Record the new usage fields from the done event**

In the event loop, replace the `else if (event.type === 'done')` branch with:

```ts
      } else if (event.type === 'done') {
        costUsd = event.costUsd;
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
        cacheReadTokens = event.cacheReadTokens;
        cacheCreationTokens = event.cacheCreationTokens;
        if (!primaryBuffer && event.fullText) primaryBuffer = event.fullText;
      }
```

And update the final flush (currently line 252):

```ts
    await flushPrimary({ costUsd, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens });
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/run-turn.ts
git commit -m "feat(turns): apply per-agent caps and persist cache tokens

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Dispatch — caps, cache tokens, and honest cap reporting

**Files:**
- Modify: `src/lib/dispatch.ts`

**Interfaces:**
- Consumes: `resolveCaps`, `capNotice` from `./agent-caps` (Task 1); the extended `done` event (Task 4).
- Produces: `DispatchTokenUsage` gains `cacheReadTokens?: number`, `cacheCreationTokens?: number`.

- [ ] **Step 1: Extend the usage type and imports**

```ts
import { runClaudeAgent } from './agent-runner-sdk';
import { resolveCaps, capNotice, type StoppedBy } from './agent-caps';

export interface DispatchTokenUsage {
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}
```

- [ ] **Step 2: Resolve caps and track the stop reason**

Inside the tool handler, after the `ctx.emit({ type: 'dispatch_start', ... })` call, replace the three result locals with:

```ts
      const caps = resolveCaps(agent);
      let fullText = '';
      const usage: DispatchTokenUsage = {};
      let errored: string | undefined;
      let stoppedBy: StoppedBy | undefined;
```

- [ ] **Step 3: Pass the caps to the nested runner**

In the `runClaudeAgent({ ... })` call, add after `allowedTools: agent.tools_allowlist ?? undefined,`:

```ts
        effort: caps.effort,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
```

- [ ] **Step 4: Capture the new usage fields and the stop reason**

Replace the `else if (event.type === 'done')` branch:

```ts
        } else if (event.type === 'done') {
          usage.costUsd = event.costUsd;
          usage.tokensIn = event.tokensIn;
          usage.tokensOut = event.tokensOut;
          usage.cacheReadTokens = event.cacheReadTokens;
          usage.cacheCreationTokens = event.cacheCreationTokens;
          stoppedBy = event.stoppedBy;
          if (!fullText && event.fullText) fullText = event.fullText;
        }
```

- [ ] **Step 5: Label a capped result honestly**

Replace the block from `if (fullText) {` through the `return` at the end of the handler:

```ts
      // A capped specialist did real work — surface it, clearly marked as
      // incomplete. Silently returning partial output as if it were finished is
      // exactly the failure the shared execution discipline exists to prevent.
      const notice = stoppedBy
        ? capNotice(
            agent.name,
            stoppedBy,
            stoppedBy === 'max_turns' ? caps.maxTurns : caps.maxBudgetUsd,
          )
        : undefined;

      const body =
        fullText || (errored ? `${agent.name} failed: ${errored}` : `${agent.name} produced no output.`);
      const result = notice ? `${notice}\n\n${body}` : body;

      if (fullText) {
        await ctx.persistMessage(agent.id, result, usage);
      }
      if (notice) {
        ctx.emit({ type: 'dispatch_error', agent_id: agent.id, message: notice });
      }
      ctx.emit({ type: 'dispatch_done', agent_id: agent.id, errored: Boolean(errored) });

      return { content: [{ type: 'text', text: result }], isError: Boolean(errored) && !fullText };
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dispatch.ts
git commit -m "feat(dispatch): per-agent caps, cache-token capture, honest cap reporting

A specialist that hits its turn or budget cap returns its partial work
prefixed with a plain statement that it stopped early, and fires
dispatch_error so the operator sees it too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Apply caps to the remaining runner call sites

**Files:**
- Modify: `src/lib/akira-turn.ts` (runClaudeAgent call at :115)
- Modify: `src/lib/dream.ts` (runClaudeAgent call at :94)
- Modify: `src/lib/akira/reflect.ts` (runClaudeAgent call at :73)

**Interfaces:**
- Consumes: `resolveCaps` from `./agent-caps` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: AKIRA reads her caps from the agents row**

In `src/lib/akira-turn.ts`, add the import:

```ts
import { resolveCaps } from '@/lib/agent-caps';
```

Immediately before the `for await (const event of runClaudeAgent({` line, add:

```ts
    const akiraCaps = resolveCaps(akira);
```

Then add inside the call object, after `allowedTools: akira?.tools_allowlist ?? undefined,`:

```ts
      effort: akiraCaps.effort,
      maxTurns: akiraCaps.maxTurns,
      maxBudgetUsd: akiraCaps.maxBudgetUsd,
```

- [ ] **Step 2: Cap the Curator (dream) pass**

In `src/lib/dream.ts`, add inside the `runClaudeAgent({ ... })` call, after the `allowedTools` line:

```ts
      // Single-shot read-only pass over context we already assembled — it does
      // not need deep reasoning or many turns.
      effort: 'medium',
      maxTurns: 10,
      maxBudgetUsd: 1,
```

- [ ] **Step 3: Cap the Reflector pass**

In `src/lib/akira/reflect.ts`, add inside the `runClaudeAgent({ ... })` call, after the `allowedTools` line:

```ts
      // Same shape as the Curator: one read-only pass over supplied context.
      effort: 'medium',
      maxTurns: 10,
      maxBudgetUsd: 1,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira-turn.ts src/lib/dream.ts src/lib/akira/reflect.ts
git commit -m "feat(agents): cap the AKIRA, Curator, and Reflector runs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Seed the per-role defaults

**Files:**
- Modify: `scripts/seed.ts` (agent rows at :155-220, upsert set at :226-240)

**Interfaces:**
- Consumes: the `agents` columns from Task 3.
- Produces: live default values for every seeded agent.

- [ ] **Step 1: Add caps to each agent row**

In the `agentRows` array, add three fields to each entry, exactly:

| id | add |
|---|---|
| `sage` | `effort: 'high', max_turns: 30, max_budget_usd: 3,` |
| `atlas` | `effort: 'high', max_turns: 40, max_budget_usd: 3,` |
| `echo` | `effort: 'medium', max_turns: 15, max_budget_usd: 3,` |
| `nova` | `effort: 'medium', max_turns: 20, max_budget_usd: 3,` |
| `forge` | `effort: 'high', max_turns: 40, max_budget_usd: 3,` |
| `pixel` | `effort: 'medium', max_turns: 30, max_budget_usd: 3,` |
| `akira` | `effort: 'low', max_turns: 15, max_budget_usd: 3,` |

For example, the `echo` entry becomes:

```ts
    {
      id: 'echo',
      name: 'Echo',
      role: 'qa',
      model: 'claude-sonnet-4-6',
      system_prompt: ECHO_SYSTEM_PROMPT,
      tools_allowlist: ['Read', 'Glob', 'Grep', 'Bash'],
      color: 'from-violet-400 to-purple-600',
      effort: 'medium',
      max_turns: 15,
      max_budget_usd: 3,
    },
```

- [ ] **Step 2: Carry the caps through the upsert**

The seed upserts with `onConflictDoUpdate` so a reseed refreshes existing rows. Add the three fields to that `set` object, alongside `model`:

```ts
        set: {
          name: row.name,
          role: row.role,
          model: row.model,
          effort: row.effort,
          max_turns: row.max_turns,
          max_budget_usd: row.max_budget_usd,
          // ...existing fields (system_prompt, tools_allowlist, color) unchanged
        },
```

Keep every field already in that `set` — only add. Without this, a reseed on the Mini leaves the live agents at null caps.

- [ ] **Step 3: Run the seed and verify**

Run: `pnpm seed`
Then: `node -e "const D=require('better-sqlite3');const db=new D('./data/mission-control.db',{readonly:true});console.table(db.prepare('select id, effort, max_turns, max_budget_usd from agents order by id').all())"`
Expected: all seven agents show the values from the table above — no nulls.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed.ts
git commit -m "feat(seed): per-role effort and cap defaults

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Usage in the fleet snapshot (AKIRA awareness)

**Files:**
- Create: `src/lib/usage-data.ts`
- Modify: `src/lib/fleet-snapshot.ts` (`FleetSnapshot` at :5-15, `emptySnapshot` at :19-31)
- Modify: `src/lib/fleet-contributors.ts` (contributor list at :107-115)
- Modify: `src/lib/akira/prompt.ts` (`renderSnapshot` at :26-51)
- Modify: `src/lib/akira/prompt.test.ts`

**Interfaces:**
- Consumes: `rollUpUsage`, `type UsageTotals` from `./usage-rollup` (Task 2); the `messages` columns from Task 3.
- Produces: `getUsageToday(): Promise<UsageTotals>` from `src/lib/usage-data.ts`; `FleetSnapshot.usage: { tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, costUsd, recordedCount }`.

- [ ] **Step 1: Write the failing prompt test**

Add to `src/lib/akira/prompt.test.ts`:

```ts
test('renderSnapshot reports today\'s token usage', () => {
  const snap = emptySnapshot();
  snap.usage = {
    tokensIn: 1200,
    tokensOut: 340,
    cacheReadTokens: 88000,
    cacheCreationTokens: 4100,
    costUsd: 1.25,
    recordedCount: 12,
  };
  const text = renderSnapshot(snap);
  assert.match(text, /Tokens today/);
  assert.match(text, /88,000 cache-read/);
  assert.match(text, /\$1\.25/);
});

test('renderSnapshot says so when no usage was recorded today', () => {
  const text = renderSnapshot(emptySnapshot());
  assert.match(text, /Tokens today: none recorded/);
});
```

`emptySnapshot` is already imported at the top of that file (`import { emptySnapshot } from '../fleet-snapshot';`) — no import change needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/prompt.test.ts`
Expected: FAIL — `usage` is not a property of `FleetSnapshot`, and the rendered text lacks "Tokens today".

- [ ] **Step 3: Add the snapshot slice**

In `src/lib/fleet-snapshot.ts`, add to the `FleetSnapshot` interface, after `soulProposal`:

```ts
  usage: {
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    /** Zero means nothing was instrumented today — not "zero tokens". */
    recordedCount: number;
  };
```

And in `emptySnapshot()`, after `soulProposal: null,`:

```ts
    usage: { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, recordedCount: 0 },
```

- [ ] **Step 4: Render it in AKIRA's prompt**

In `src/lib/akira/prompt.ts`, insert before the `if (s.soulProposal)` line:

```ts
  const u = s.usage;
  lines.push(
    u.recordedCount === 0
      ? 'Tokens today: none recorded'
      : `Tokens today: ${u.tokensIn.toLocaleString('en-US')} in, ${u.tokensOut.toLocaleString('en-US')} out, ` +
        `${u.cacheReadTokens.toLocaleString('en-US')} cache-read, ` +
        `${u.cacheCreationTokens.toLocaleString('en-US')} cache-write — $${u.costUsd.toFixed(2)} across ${u.recordedCount} messages`,
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/akira/prompt.test.ts`
Expected: PASS, including the two new tests.

- [ ] **Step 6: Write the DB reader**

Create `src/lib/usage-data.ts`:

```ts
import 'server-only';
import { gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { messages } from '@/db/schema';
import { rollUpUsage, type UsageRow, type UsageTotals } from './usage-rollup';

/** Usage recorded since local midnight. The arithmetic lives in usage-rollup so
 *  the dashboard and AKIRA can never disagree about it. */
export async function getUsageToday(): Promise<UsageTotals> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      agentId: messages.agent_id,
      tokensIn: messages.token_count_in,
      tokensOut: messages.token_count_out,
      cacheReadTokens: messages.cache_read_tokens,
      cacheCreationTokens: messages.cache_creation_tokens,
      costUsd: messages.cost_usd,
    })
    .from(messages)
    .where(gte(messages.created_at, since));
  return rollUpUsage(rows as UsageRow[]);
}
```

- [ ] **Step 7: Register the contributor**

In `src/lib/fleet-contributors.ts`, add the import:

```ts
import { getUsageToday } from './usage-data';
```

Add the contributor, after `soulProposalContributor`:

```ts
const usageContributor: SnapshotContributor = {
  key: 'usage',
  collect: async () => {
    const t = await getUsageToday();
    return {
      usage: {
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut,
        cacheReadTokens: t.cacheReadTokens,
        cacheCreationTokens: t.cacheCreationTokens,
        costUsd: t.costUsd,
        recordedCount: t.recordedCount,
      },
    };
  },
};
```

And add `usageContributor,` to the end of the `CONTRIBUTORS` array.

- [ ] **Step 8: Full test + typecheck**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/usage-data.ts src/lib/fleet-snapshot.ts src/lib/fleet-contributors.ts src/lib/akira/prompt.ts src/lib/akira/prompt.test.ts
git commit -m "feat(usage): today's token totals in the fleet snapshot

AKIRA can now answer 'what did today burn?' from the front door.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Cache totals in the dashboard topbar

**Files:**
- Modify: `src/lib/mock-data.ts` (`Session` interface at :24-37)
- Modify: `src/app/dashboard/page.tsx` (totals query at :107-115, session object at :150-152)
- Modify: `src/components/mission-control.tsx` (totals row at :929-942)

**Interfaces:**
- Consumes: the `messages` columns from Task 3.
- Produces: `Session.cacheReadTokens: number`, `Session.cacheCreationTokens: number`, `Session.usageRecordedCount: number`.

- [ ] **Step 1: Extend the Session type**

In `src/lib/mock-data.ts`, add to the `Session` interface after `tokensOut: number;`:

```ts
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Messages in this session carrying any recorded usage. Zero → the UI shows
   *  a dash rather than 0, so pre-instrumentation history doesn't read as free. */
  usageRecordedCount: number;
```

- [ ] **Step 2: Extend the totals query**

In `src/app/dashboard/page.tsx`, replace the `totals` query (lines 107-115) with:

```ts
  const totals = await db
    .select({
      tokensIn: sql<number>`COALESCE(SUM(${messages.token_count_in}), 0)`,
      tokensOut: sql<number>`COALESCE(SUM(${messages.token_count_out}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${messages.cache_read_tokens}), 0)`,
      cacheCreationTokens: sql<number>`COALESCE(SUM(${messages.cache_creation_tokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${messages.cost_usd}), 0)`,
      recordedCount: sql<number>`COUNT(${messages.token_count_in}) + COUNT(${messages.cache_read_tokens})`,
    })
    .from(messages)
    .where(eq(messages.session_id, currentSessionRow.id))
    .then((rows) => rows[0]);
```

`COUNT(col)` in SQLite counts non-null values only, so `recordedCount` is zero exactly when nothing in this session was instrumented.

- [ ] **Step 3: Pass the new fields through**

In the same file, extend the session object built at lines 150-152:

```ts
    costUsd: Number(totals?.costUsd ?? 0),
    tokensIn: Number(totals?.tokensIn ?? 0),
    tokensOut: Number(totals?.tokensOut ?? 0),
    cacheReadTokens: Number(totals?.cacheReadTokens ?? 0),
    cacheCreationTokens: Number(totals?.cacheCreationTokens ?? 0),
    usageRecordedCount: Number(totals?.recordedCount ?? 0),
```

- [ ] **Step 4: Render the two new chips**

In `src/components/mission-control.tsx`, inside the totals row (the `<div className="hidden md:flex items-center gap-4 ...">` block at line 929), add after the existing OUT chip:

```tsx
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">CACHE R:</span>
              <span className="text-[#e6edf3]">
                {session.usageRecordedCount === 0
                  ? "—"
                  : `${(session.cacheReadTokens / 1000).toFixed(1)}k`}
              </span>
            </div>
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">CACHE W:</span>
              <span className="text-[#e6edf3]">
                {session.usageRecordedCount === 0
                  ? "—"
                  : `${(session.cacheCreationTokens / 1000).toFixed(1)}k`}
              </span>
            </div>
```

- [ ] **Step 5: Confirm no other Session constructor broke**

Run: `pnpm exec tsc --noEmit`
Expected: **clean.** `src/app/dashboard/page.tsx:150` is the only place a `Session` object is constructed (`mock-data.ts` declares the interface but builds no session), and Step 3 already updated it. If tsc does report a missing-property error somewhere else, add `cacheReadTokens: 0, cacheCreationTokens: 0, usageRecordedCount: 0` there.

- [ ] **Step 6: Add today's fleet-wide totals beside the session totals**

The chips above are scoped to the current session. Spec §6 also calls for a fleet-wide rollup, which is what makes "am I burning my window today?" answerable at a glance.

In `src/app/dashboard/page.tsx`, add the import:

```ts
import { getUsageToday } from "@/lib/usage-data";
```

and load it alongside the other data (after the `totals` query):

```ts
  const usageToday = await getUsageToday();
```

then pass it to the component: `usageToday={usageToday}` on the `<MissionControl ... />` element.

In `src/components/mission-control.tsx`, add to the `MissionControlProps` interface after `initialPlan: PlanSnapshot | null;`:

```ts
  usageToday: UsageTotals;
```

importing the type: `import { type UsageTotals } from "@/lib/usage-rollup";`

Add `usageToday,` to the destructured props in the `MissionControl(...)` signature, then render one more chip at the end of the same totals row:

```tsx
            <div className="flex gap-1.5 items-center bg-[#161c25]/50 px-2 py-0.5 rounded border border-[#1e2632]">
              <span className="text-[#5c6470]">TODAY:</span>
              <span className="text-[#00e0ff] font-bold">
                {usageToday.recordedCount === 0
                  ? "—"
                  : `$${usageToday.costUsd.toFixed(2)}`}
              </span>
              <span className="text-[#5c6470]">
                {usageToday.recordedCount === 0
                  ? ""
                  : `/ ${((usageToday.tokensIn + usageToday.cacheReadTokens + usageToday.cacheCreationTokens) / 1000).toFixed(0)}k in`}
              </span>
            </div>
```

Note the fleet figure counts cache-read and cache-write alongside fresh input — that sum is the number that actually moves your usage window, and keeping it visible is the whole point of the slice.

- [ ] **Step 7: Verify the build**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/mock-data.ts src/app/dashboard/page.tsx src/components/mission-control.tsx
git commit -m "feat(dashboard): cache totals per session plus today's fleet spend

Renders a dash rather than 0 for sessions predating the instrumentation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Full verification and merge to `dev`

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: a merged `dev`.

- [ ] **Step 1: Run both gates**

Run: `pnpm test && pnpm exec tsc --noEmit`
Expected: all tests pass; no type errors. Do not proceed on a failure — fix it in the owning task's file.

- [ ] **Step 2: Confirm the isolation actually took effect**

Run: `pnpm exec tsx -e "import('./src/lib/agent-runner-sdk.ts').then(()=>console.log('module loads'))"`
Then read `src/lib/agent-runner-sdk.ts` and confirm by eye that `settingSources: ['project']` and `strictMcpConfig: true` are inside the `query({ options: { ... } })` object — not nested in the wrong scope. This is configuration the type system will accept in either place, so it needs a human read.

- [ ] **Step 3: Verify the migration is still additive**

Run: `cat drizzle/0012_*.sql`
Expected: only `ALTER TABLE ... ADD ...` lines. This is the last chance to catch a rebuild before it fails on the Mini.

- [ ] **Step 4: Merge to `dev`**

Use superpowers:finishing-a-development-branch. Merge the feature branch into `dev` — never straight to `main`. Then unlink the worktree's junctioned `node_modules` **before** removing the worktree (on Windows, `Remove-Item -Recurse` on a junction deletes the target).

- [ ] **Step 5: Report what to watch on the first live run**

After the deploy, the first multi-turn session should show non-null `cache_read_tokens` on new `messages` rows. If cache reads stay near zero while `token_count_in` climbs turn over turn, that is the evidence that Tier 2 (SDK session resume) is the real fix — which is exactly what this slice was built to determine.

---

## Deploy notes (Phase 4/5 of ship-mc-feature)

- **Version bump required** in both `package.json` and `src/lib/version.ts` — keep them equal. This is a feature: minor bump.
- **Migration required.** Additive only, so plain `pnpm db:migrate` on the Mini is safe.
- **Reseed required** — `pnpm seed` on the Mini. The per-agent caps live in the seed upsert, and the live `agents` table is known to drift from the repo when a reseed is skipped.
- **No new dependencies** — skip `pnpm install` on the Mini, per the runbook. Never let it purge `node_modules`.
- **Verify:** `/api/health` shows the new version + `db:ok`; a dispatch produces non-null `cache_read_tokens`; AKIRA answers a "what did today burn?" question with real numbers.
