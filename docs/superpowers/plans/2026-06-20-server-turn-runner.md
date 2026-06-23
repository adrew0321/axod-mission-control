# Server-Side Turn Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the agent turn out of the SSE route into a reusable, sink-agnostic `runSessionTurn(sessionId, opts)` that runs headlessly, guarded by a cross-process lease, and prove it with a CLI trigger.

**Architecture:** A new server lib `src/lib/run-turn.ts` owns one turn end-to-end (load → lease → prompt → worktree → `runClaudeAgent` → persist → release), emitting observability events through an injected `emit` sink. The SSE route and a new CLI script become thin callers differing only in their `emit` sink and abort source. A `running_since` lease column on `sessions` prevents two turns colliding on one worktree.

**Tech Stack:** Next.js (vendored build), TypeScript, drizzle-orm + better-sqlite3, the Claude Agent SDK (`runClaudeAgent`), `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-06-20-server-turn-runner-design.md`.

---

## Notes for the implementer (read first)

- **Isolation:** Work in an isolated worktree on a `feature/server-turn-runner` branch (this repo is the live app dir — don't branch-switch it in place). Create it via `superpowers:using-git-worktrees` before Task 1; base it on current `dev` HEAD (set `worktree.baseRef` to `head`, or `git worktree add` from `dev`). Merge to `dev` when done.
- **Fresh-worktree env gotchas (seen on the last feature):** a new worktree needs (1) the better-sqlite3 native binding copied in — `cp` the main repo's `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node` into the same path in the worktree after `pnpm install`; (2) a `data/` dir (`mkdir -p data/worktrees`) before `pnpm build`. Do NOT run `pnpm approve-builds` (`.npmrc` `ignore-scripts=true` is intentional). Revert any `pnpm-workspace.yaml` change `pnpm install` auto-writes.
- **Imports are extensionless** (`from '@/lib/...'`, `from './turn-lease'`); a `.ts` extension breaks `tsc`/`next build`.
- **Server-only modules aren't unit-tested** (they import `'server-only'`, which throws under `node:test`); only the pure `turn-lease.ts` gets tests. After every task: `pnpm test` stays green and `pnpm build` passes before committing.

---

## File Structure

- **Create** `src/lib/turn-lease.ts` — pure helpers: `isLeaseHeld`, `resolveTurnInput`, `LEASE_GRACE_MS`. No `server-only`, no DB. Unit-tested.
- **Create** `src/lib/turn-lease.test.ts` — `node:test` unit tests for the above.
- **Create** `src/lib/run-turn.ts` — `runSessionTurn` (server-only): the whole turn, lifted from the route + lease + abort + instruction.
- **Create** `scripts/run-turn.ts` — the headless CLI.
- **Modify** `src/db/schema.ts` — add `running_since` to `sessions`; + a generated migration under `drizzle/`.
- **Modify** `src/app/api/sessions/[id]/stream/route.ts` — slim to auth + an `emit`-wired call to `runSessionTurn`.
- **Modify** `package.json` — add the `run:turn` script.

---

## Task 1: Pure lease + prompt-source helpers (TDD)

**Files:**
- Create: `src/lib/turn-lease.ts`
- Test: `src/lib/turn-lease.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/turn-lease.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLeaseHeld, resolveTurnInput, LEASE_GRACE_MS } from "./turn-lease";

const MAX = 600_000; // 10 min

test("no lease (null) is not held", () => {
  assert.equal(isLeaseHeld(null, Date.now(), MAX), false);
});

test("a fresh lease is held", () => {
  const now = Date.now();
  assert.equal(isLeaseHeld(new Date(now - 1000), now, MAX), true);
});

test("a lease within max+grace is still held", () => {
  const now = Date.now();
  const justInside = new Date(now - (MAX + LEASE_GRACE_MS) + 1000);
  assert.equal(isLeaseHeld(justInside, now, MAX), true);
});

test("a lease older than max+grace is stale (not held)", () => {
  const now = Date.now();
  const expired = new Date(now - (MAX + LEASE_GRACE_MS) - 1000);
  assert.equal(isLeaseHeld(expired, now, MAX), false);
});

test("instruction wins → kind 'instruction' with trimmed content", () => {
  assert.deepEqual(resolveTurnInput("  do the thing  ", false), {
    kind: "instruction",
    content: "do the thing",
  });
});

test("no instruction but a pending user message → kind 'reply'", () => {
  assert.deepEqual(resolveTurnInput(undefined, true), { kind: "reply" });
});

test("empty/whitespace instruction is ignored", () => {
  assert.deepEqual(resolveTurnInput("   ", true), { kind: "reply" });
});

test("nothing to respond to → kind 'none'", () => {
  assert.deepEqual(resolveTurnInput(undefined, false), { kind: "none" });
  assert.deepEqual(resolveTurnInput("", false), { kind: "none" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `./turn-lease` not found / exports missing.

- [ ] **Step 3: Write the helpers**

Create `src/lib/turn-lease.ts`:

```ts
// Pure helpers for the server turn runner: the concurrency-lease staleness rule
// and the turn-input decision. No DB, no server-only — unit-testable.

/** Extra grace beyond a turn's max duration before its lease is reclaimable. */
export const LEASE_GRACE_MS = 60_000;

/**
 * Is a live turn currently holding the session lease? A null lease is free; a
 * lease older than (maxDurationMs + grace) is stale (a crashed turn) and
 * reclaimable, so it is NOT considered held.
 */
export function isLeaseHeld(
  runningSince: Date | null,
  nowMs: number,
  maxDurationMs: number,
): boolean {
  if (!runningSince) return false;
  return runningSince.getTime() >= nowMs - (maxDurationMs + LEASE_GRACE_MS);
}

export type TurnInput =
  | { kind: "instruction"; content: string }
  | { kind: "reply" }
  | { kind: "none" };

/**
 * Decide what this turn responds to: a self-initiated instruction (wins), else
 * the session's pending last user message, else nothing.
 */
export function resolveTurnInput(
  instruction: string | undefined,
  hasPendingUserMessage: boolean,
): TurnInput {
  const trimmed = instruction?.trim();
  if (trimmed) return { kind: "instruction", content: trimmed };
  if (hasPendingUserMessage) return { kind: "reply" };
  return { kind: "none" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all `turn-lease` tests green; existing suite unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/turn-lease.ts src/lib/turn-lease.test.ts
git commit -m "feat(runner): pure lease + turn-input helpers"
```

---

## Task 2: Add the `running_since` lease column + migration

**Files:**
- Modify: `src/db/schema.ts` (the `sessions` table)
- Create: a generated migration under `drizzle/` (drizzle-kit names it)

- [ ] **Step 1: Add the column**

In `src/db/schema.ts`, the `sessions` table currently ends with `created_at` / `updated_at`. Add a nullable `running_since` column. Find:

```ts
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

(within `export const sessions = sqliteTable('sessions', { ... })`) and change to:

```ts
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // Concurrency lease: set while a turn runs (browser or CLI), null when idle.
  // A stale value (older than a turn's max duration + grace) is reclaimable.
  running_since: integer('running_since', { mode: 'timestamp' }),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `drizzle/0002_*.sql` (number may differ) containing `ALTER TABLE sessions ADD ... running_since`. (drizzle-kit picks the name.)

- [ ] **Step 3: Apply the migration to the dev DB**

Run: `pnpm db:migrate`
Expected: "migrations applied successfully". (If a worktree DB is empty, `db:migrate` builds the schema; that's fine.)

- [ ] **Step 4: Verify the column exists + build**

Run:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('PRAGMA table_info(sessions)').all().map(c=>c.name).join(', '));db.close();"
```
Expected: the list includes `running_since`.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(runner): add running_since lease column to sessions"
```

---

## Task 3: The runner — `runSessionTurn`

**Files:**
- Create: `src/lib/run-turn.ts`

This is the whole turn, lifted from the current `stream/route.ts` `start(controller)` body with `controller.enqueue(sseEncode(x))` replaced by `emit(x)`, wrapped in the lease + abort, and generalized to accept an `instruction`.

- [ ] **Step 1: Create the file**

Create `src/lib/run-turn.ts` with exactly this content:

```ts
import 'server-only';
import { and, asc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { agents, messages, projects, sessions } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { ensureWorktree } from '@/lib/worktree';
import { createDispatchServer, DISPATCH_SERVER_NAME, DISPATCH_TOOL_NAME } from '@/lib/dispatch';
import { toTerminalEvent } from '@/lib/terminal-events';
import { buildOrchestratorPrompt, type TranscriptMessage } from '@/lib/conversation';
import { parseMention } from '@/lib/mention';
import { savePlanSnapshot } from '@/lib/plans';
import { toPlanSnapshot, type PlanSnapshot } from '@/lib/plan-events';
import { LEASE_GRACE_MS, resolveTurnInput } from '@/lib/turn-lease';

const DEFAULT_MAX_DURATION_MS = 600_000;

export type TurnEmit = (e: { type: string; [k: string]: unknown }) => void;

export interface RunTurnOptions {
  emit?: TurnEmit;
  signal?: AbortSignal;
  instruction?: string;
  maxDurationMs?: number;
}

export type TurnResult = { status: 'completed' | 'skipped' | 'error'; reason?: string };

/**
 * Run one agent turn for a session, end-to-end, server-side. Sink-agnostic: the
 * SSE route passes emit=SSE + signal=req.signal; the CLI passes emit=log + no
 * signal (bounded only by maxDurationMs). Guarded by a cross-process lease on
 * sessions.running_since so a browser turn and a CLI turn can't collide.
 */
export async function runSessionTurn(
  sessionId: string,
  opts: RunTurnOptions = {},
): Promise<TurnResult> {
  const emit: TurnEmit = opts.emit ?? (() => {});
  const maxDurationMs = opts.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const session = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .then((r) => r[0]);
  if (!session) {
    emit({ type: 'error', message: 'session not found' });
    return { status: 'error', reason: 'session not found' };
  }

  // --- Acquire the lease: atomic compare-and-set. 0 rows changed => held. ---
  const now = new Date();
  const cutoff = new Date(now.getTime() - (maxDurationMs + LEASE_GRACE_MS));
  const acq = db
    .update(sessions)
    .set({ running_since: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        or(isNull(sessions.running_since), lt(sessions.running_since, cutoff)),
      ),
    )
    .run();
  if (acq.changes === 0) {
    emit({ type: 'skipped', reason: 'turn already running' });
    return { status: 'skipped', reason: 'turn already running' };
  }

  // Abort: max-duration timeout, linked with any external signal (browser Stop).
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), maxDurationMs);
  const combinedSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    // Self-initiated instruction → persist as a user message so it joins the transcript.
    if (opts.instruction?.trim()) {
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        role: 'user',
        content: opts.instruction.trim(),
        created_at: new Date(),
      });
    }

    // Whole session, chronological (rowid tie-breaks within a second). A cleared
    // session only feeds messages after the clear marker.
    const conversation = await db
      .select()
      .from(messages)
      .where(
        session.cleared_at
          ? and(eq(messages.session_id, sessionId), gt(messages.created_at, session.cleared_at))
          : eq(messages.session_id, sessionId),
      )
      .orderBy(asc(messages.created_at), asc(sql`rowid`));
    const lastUserMessage = [...conversation].reverse().find((m) => m.role === 'user');

    if (resolveTurnInput(opts.instruction, Boolean(lastUserMessage)).kind === 'none') {
      emit({ type: 'error', message: 'no prompt to respond to' });
      return { status: 'error', reason: 'no prompt to respond to' };
    }
    // lastUserMessage is now guaranteed (instruction was inserted, or one existed).

    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, session.project_id))
      .limit(1)
      .then((r) => r[0]);

    const allAgents = await db.select().from(agents);
    const sage = allAgents.find((a) => a.id === 'sage');
    const agentLabels: Record<string, string> = Object.fromEntries(
      allAgents.map((a) => [a.id, a.id === 'sage' ? 'Sage' : `${a.name} (${a.role})`]),
    );
    const transcript = buildOrchestratorPrompt(
      conversation.map((m): TranscriptMessage => ({
        role: m.role as TranscriptMessage['role'],
        agentId: m.agent_id,
        content: m.content,
      })),
      agentLabels,
    );

    const { agentId: mentionId } = parseMention(lastUserMessage!.content, allAgents);
    const addressed =
      mentionId && mentionId !== 'sage' ? allAgents.find((a) => a.id === mentionId) : undefined;
    const primary = addressed ?? sage;
    const primaryId = primary?.id ?? 'sage';

    emit({ type: 'start', messageId: lastUserMessage!.id });

    let primaryBuffer = '';
    let primaryEmitted = false;
    let costUsd: number | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    const flushPrimary = async (usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number }) => {
      if (!primaryBuffer.trim()) return;
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        agent_id: primaryId,
        role: 'agent',
        content: primaryBuffer,
        token_count_in: usage?.tokensIn,
        token_count_out: usage?.tokensOut,
        cost_usd: usage?.costUsd,
        created_at: new Date(),
      });
      primaryBuffer = '';
      primaryEmitted = true;
    };

    let workingDir = project?.repo_path ?? process.cwd();
    if (project?.repo_path) {
      try {
        const wt = await ensureWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev');
        workingDir = wt.path;
        if (session.worktree_path !== wt.path) {
          await db.update(sessions).set({ worktree_path: wt.path }).where(eq(sessions.id, sessionId));
        }
        emit({ type: 'worktree', path: wt.path, branch: wt.branch });
      } catch (err) {
        emit({ type: 'worktree_error', message: err instanceof Error ? err.message : String(err) });
      }
    }

    // Best-effort plan persistence: never let a DB hiccup break the turn.
    const persistPlan = async (snapshot: PlanSnapshot) => {
      try {
        await savePlanSnapshot(sessionId, snapshot);
      } catch (err) {
        console.error('plan persist failed:', err instanceof Error ? err.message : err);
      }
    };

    const dispatchServer = addressed
      ? null
      : createDispatchServer({
          workingDir,
          signal: combinedSignal,
          emit,
          persistMessage: async (agentId, content, usage) => {
            await db.insert(messages).values({
              id: `msg_${bytesToHex(randomBytes(8))}`,
              session_id: sessionId,
              agent_id: agentId,
              dispatched_via: primaryId,
              role: 'agent',
              content,
              token_count_in: usage.tokensIn,
              token_count_out: usage.tokensOut,
              cost_usd: usage.costUsd,
              created_at: new Date(),
            });
          },
          onBeforeDispatch: () => flushPrimary(),
          savePlanSnapshot: persistPlan,
        });

    for await (const event of runClaudeAgent({
      prompt: transcript,
      workingDir,
      model: primary?.model,
      systemPrompt: primary?.system_prompt,
      allowedTools: primary?.tools_allowlist ?? undefined,
      ...(dispatchServer
        ? {
            mcpServers: { [DISPATCH_SERVER_NAME]: dispatchServer },
            extraAllowedTools: [DISPATCH_TOOL_NAME],
          }
        : {}),
      extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' },
      signal: combinedSignal,
    })) {
      const term = toTerminalEvent(event, primaryId);
      if (term) emit(term as unknown as { type: string; [k: string]: unknown });

      if (event.type === 'token') {
        primaryBuffer += event.content;
      } else if (event.type === 'tool') {
        emit({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input });
        const planSnap = toPlanSnapshot(event.name, event.input, primaryId);
        if (planSnap) await persistPlan(planSnap);
      } else if (event.type === 'done') {
        costUsd = event.costUsd;
        tokensIn = event.tokensIn;
        tokensOut = event.tokensOut;
        if (!primaryBuffer && event.fullText) primaryBuffer = event.fullText;
      }
      if (event.type !== 'tool_result') emit(event);
    }

    await flushPrimary({ costUsd, tokensIn, tokensOut });
    if (primaryEmitted) {
      await db.update(sessions).set({ updated_at: new Date() }).where(eq(sessions.id, sessionId));
    }
    emit({ type: 'persisted' });
    return { status: 'completed' };
  } catch (err) {
    emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    // We acquired the lease above (we only reach try/finally after acq.changes>0),
    // so release it. Best-effort: a failed release self-heals via the stale TTL.
    try {
      await db.update(sessions).set({ running_since: null }).where(eq(sessions.id, sessionId)).run();
    } catch (err) {
      console.error('lease release failed:', err instanceof Error ? err.message : err);
    }
  }
}
```

- [ ] **Step 2: Typecheck / build**

Run: `pnpm build`
Expected: PASS. If `.run()` is not present on the drizzle update builder in this version, the build/types will flag it — fall back to `const acq = await db.update(...).set(...).where(...); ` and read `acq.changes` from the returned `RunResult` (drizzle better-sqlite3 returns `{ changes, lastInsertRowid }`). Apply the same to the lease release. (`AbortSignal.any` is available on Node 24; no shim needed.)

Run: `pnpm test`
Expected: PASS — suite unaffected (run-turn.ts has no unit test by design).

- [ ] **Step 3: Commit**

```bash
git add src/lib/run-turn.ts
git commit -m "feat(runner): runSessionTurn — sink-agnostic server turn with lease + abort"
```

---

## Task 4: Refactor the SSE route onto `runSessionTurn`

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts` (replace whole file)

- [ ] **Step 1: Replace the route**

Replace the entire contents of `src/app/api/sessions/[id]/stream/route.ts` with:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function sseEncode(event: { type: string; [k: string]: unknown }): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id: sessionId } = await ctx.params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: { type: string; [k: string]: unknown }) =>
        controller.enqueue(sseEncode(e));
      try {
        // signal = req.signal so the operator closing the EventSource ("Stop") aborts.
        await runSessionTurn(sessionId, { emit, signal: req.signal });
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

This removes all the turn logic and its imports (db, schema, runClaudeAgent, ensureWorktree, dispatch, terminal-events, conversation, mention, plans, plan-events, noble hashes, drizzle operators) — they now live in `run-turn.ts`. The session-not-found / no-prompt cases now arrive as in-stream `error` events from `runSessionTurn` (the client already renders `error` events); only the 401 auth check stays here.

- [ ] **Step 2: Typecheck / build + no-unused-imports**

Run: `pnpm build`
Expected: PASS, with no "unused variable/import" errors (confirms the old imports were all removed).

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/sessions/[id]/stream/route.ts"
git commit -m "refactor(runner): SSE route delegates to runSessionTurn"
```

---

## Task 5: The headless CLI trigger

**Files:**
- Create: `scripts/run-turn.ts`
- Modify: `package.json` (add the `run:turn` script)

- [ ] **Step 1: Verify `@/` resolves under tsx (quick check)**

Run:
```bash
NODE_OPTIONS=--conditions=react-server node_modules/.bin/tsx -e "import('@/lib/turn-lease').then(m=>console.log('OK', typeof m.isLeaseHeld))"
```
Expected: `OK function`. If instead it errors with "Cannot find module '@/...'", tsx isn't resolving tsconfig `paths`; fix by importing run-turn via a relative path in Step 2 (`../src/lib/run-turn`) AND confirm run-turn.ts's own `@/` imports still resolve under tsx — if they don't either, add `"imports"`/`tsconfig-paths` registration. (In practice tsx v4 reads `tsconfig.json` `paths`; this step just confirms.)

- [ ] **Step 2: Create the CLI**

Create `scripts/run-turn.ts`:

```ts
import 'dotenv/config';
import { runSessionTurn } from '@/lib/run-turn';

// One concise line per turn event so the operator can watch a headless run.
function logLine(e: { type: string; [k: string]: unknown }) {
  switch (e.type) {
    case 'worktree':
      console.log(`[worktree] ${e.path} (${e.branch})`);
      break;
    case 'worktree_error':
      console.log(`[worktree_error] ${e.message}`);
      break;
    case 'activity':
      console.log(`[activity] ${e.agent_id} ${e.tool}`);
      break;
    case 'dispatch_activity':
      console.log(`[dispatch] ${e.agent_id} ${e.tool}`);
      break;
    case 'token':
      process.stdout.write(String(e.content ?? ''));
      break;
    case 'done':
      console.log(`\n[done] cost=$${e.costUsd ?? 0}`);
      break;
    case 'persisted':
      console.log('[persisted]');
      break;
    case 'skipped':
      console.log(`[skipped] ${e.reason ?? ''}`);
      break;
    case 'error':
      console.error(`[error] ${e.message ?? ''}`);
      break;
    default:
      break;
  }
}

async function main() {
  const sessionId = process.argv[2];
  const instruction = process.argv[3]; // optional self-initiated prompt
  if (!sessionId) {
    console.error('usage: pnpm run:turn <sessionId> ["instruction"]');
    process.exit(2);
  }
  const result = await runSessionTurn(sessionId, { instruction, emit: logLine });
  console.log(`\nturn ${result.status}${result.reason ? `: ${result.reason}` : ''}`);
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

(If Step 1 showed `@/` does not resolve under tsx, change the import to `from '../src/lib/run-turn'`.)

- [ ] **Step 3: Add the package script**

In `package.json` `scripts`, add (next to `seed`/`seed:admin`):

```jsonc
    "run:turn": "cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/run-turn.ts",
```

(`cross-env` is already a devDependency; the `react-server` condition makes `server-only` a no-op so the SDK + db modules import under tsx.)

- [ ] **Step 4: Typecheck / build**

Run: `pnpm build`
Expected: PASS (the new script file is outside the Next app but should still typecheck cleanly; if `tsc` in build doesn't include `scripts/`, that's fine).

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-turn.ts package.json
git commit -m "feat(runner): headless run:turn CLI"
```

---

## Task 6: Runtime verification

**Files:** none (runtime).

Start the app once for the regression check: `pnpm dev` (main repo or worktree with the env gotchas handled), log in (`test@axodcreative.com`).

- [ ] **Step 1: Regression — the browser path still works**

In the running app, open a session and send a normal message (and one that triggers a dispatch, e.g. "@Atlas …" or a task Sage will dispatch). Confirm tokens stream, the message persists, the Plan/Terminal tabs still update, and "Stop" still aborts. This proves the refactored route still drives a turn correctly.

- [ ] **Step 2: Headless — a server-initiated turn with no browser**

Pick a session id (from the DB or the app URL). With the dev server NOT required:
```bash
pnpm run:turn <sessionId> "Reply with a one-sentence hello."
```
Expected: event lines stream to the console, ending with `[persisted]` and `turn completed`. Then confirm it persisted + released the lease:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');const s='<sessionId>';console.log('running_since:', db.prepare('SELECT running_since FROM sessions WHERE id=?').get(s).running_since);console.log('last msg:', db.prepare(\"SELECT role,substr(content,1,60) c FROM messages WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 2\").all(s));db.close();"
```
Expected: `running_since: null` (lease released) and a new `agent` message with the reply.

- [ ] **Step 3: Lease — concurrent turns don't collide**

Start a longer headless turn and, while it runs, fire a second one for the **same** session in another terminal:
```bash
pnpm run:turn <sessionId> "Do a slightly longer task."   # terminal A
pnpm run:turn <sessionId> "second"                         # terminal B, while A runs
```
Expected: terminal B prints `[skipped] turn already running` and `turn skipped`, exits non-zero, and does not touch the worktree. After A finishes, `running_since` is null again.

---

## Task 7: Docs / progress

**Files:**
- Modify: `README.md` (Navbar row / "soon" sections note) — optional one-liner
- (Outside repo) the `turns-require-client-sse` memory

- [ ] **Step 1: Note the runner exists**

If `README.md` references that background/cron turns are blocked, update that line to note a server-side `runSessionTurn` + `pnpm run:turn` CLI now exist (Scheduler/Dreaming unblocked). Keep it to a sentence; skip if no such line exists.

- [ ] **Step 2: Commit (if README changed)**

```bash
git add README.md
git commit -m "docs(runner): note server-side turn runner unblocks cron consumers"
```

- [ ] **Step 3: Update the memory (outside the repo)**

Update the `turns-require-client-sse` memory: the constraint is lifted — `src/lib/run-turn.ts` `runSessionTurn` runs a turn headlessly (sink-agnostic emit, lease on `sessions.running_since`, self-initiated instruction), invokable via `pnpm run:turn <sessionId> ["instruction"]`; the SSE route now delegates to it. This unblocks Scheduler/Dreaming. Note the CLI needs `--conditions=react-server`. This is a memory file, not a repo commit.

---

## Self-Review notes

- **Spec coverage:** sink-agnostic `runSessionTurn` (Task 3) ✓; route refactor with no duplicated logic (Task 4) ✓; cross-process CAS lease on `running_since` + stale TTL (Tasks 2/3, `isLeaseHeld`/`LEASE_GRACE_MS`) ✓; abort = max-duration ⊕ external signal (Task 3) ✓; self-initiated instruction persisted as a user message (Task 3) ✓; headless CLI with `--conditions=react-server` (Task 5) ✓; 404/no-prompt → in-stream `error` events (Tasks 3/4) ✓; unit tests on the pure helpers only, runtime verification for the rest (Tasks 1/6) ✓; docs/memory (Task 7) ✓.
- **Type consistency:** `runSessionTurn(sessionId, opts?: RunTurnOptions): Promise<TurnResult>`, `TurnEmit`, and `resolveTurnInput`/`isLeaseHeld`/`LEASE_GRACE_MS` are used identically across Tasks 1/3/4/5. The dispatch context's `emit` and `savePlanSnapshot` callbacks match the existing `createDispatchServer` signature.
- **Placeholders:** none — every code step shows the full file/snippet and exact anchor; the one conditional (drizzle `.run()` vs `await … .changes`, and tsx `@/` fallback) is spelled out with the concrete alternative.
```
