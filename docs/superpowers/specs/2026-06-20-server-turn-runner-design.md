# Server-Side Turn Runner — Design

**Date:** 2026-06-20
**Status:** Approved (design); pending implementation plan.

## Problem

An agent turn only runs inside the SSE route `GET /api/sessions/[id]/stream`:
the turn logic lives in that route's `ReadableStream.start(controller)` and
writes its output by `controller.enqueue`-ing SSE frames. So a turn cannot run
unless a browser opens the stream. This blocks every background/scheduled use —
**Scheduler** and **Dreaming** both need to run agents on a cron with no browser
attached (see memory `turns-require-client-sse`).

The turn itself never needed a browser: `runClaudeAgent` is a plain
`async function*` that yields events and accepts an `AbortSignal`; the Claude SDK
auth is the CLI device-login (works headless). The browser coupling is
incidental plumbing — the turn logic just happens to be inlined in the SSE
route.

## Goal & scope

Extract the turn into a reusable, sink-agnostic server function and prove it
runs with no browser.

**In scope:**
- `runSessionTurn(sessionId, opts)` — a server lib that runs one turn end-to-end
  (load → lease → prompt → worktree → `runClaudeAgent` → persist → release),
  emitting observability events through an injected sink.
- Refactor the SSE route to call it (no duplicated turn logic).
- A lightweight cross-process **concurrency lease** so a CLI turn and a browser
  turn can't run the same session/worktree at once.
- A minimal headless **CLI trigger**: `pnpm run:turn <sessionId> ["instruction"]`.
- Support a **self-initiated instruction** (what Dreaming/Scheduler need), not
  only answering a pending user message.

**Out of scope (separate epics):** the Scheduler cron system (`schedules` table,
ticker, `scheduler-view`), the Dreaming/Curator agent, any in-process scheduler.
This spec is the foundation those consume.

## Architecture

One new server lib owns a turn; the SSE route and the CLI are thin callers that
differ only in their `emit` sink and abort source.

```
runSessionTurn(sessionId, { emit?, signal?, instruction?, maxDurationMs? })   src/lib/run-turn.ts (server-only)
   loads session/conversation/project/agents · builds transcript · acquires lease ·
   sets up worktree · runs runClaudeAgent · persists messages + plan · releases lease ·
   emits observability events
      ├─ SSE route  → emit = (e) => controller.enqueue(sseEncode(e)) ; signal = req.signal
      └─ CLI script → emit = logLine                                 ; signal = (timeout only)
```

### `runSessionTurn` — interface

```ts
interface RunTurnOptions {
  emit?: (e: { type: string; [k: string]: unknown }) => void; // default: no-op
  signal?: AbortSignal;          // external abort (route passes req.signal)
  instruction?: string;          // self-initiated prompt; if omitted, answer last pending user msg
  maxDurationMs?: number;        // default 600_000 (mirrors today's dispatch stream-close timeout)
}
type TurnResult = { status: 'completed' | 'skipped' | 'error'; reason?: string };
async function runSessionTurn(sessionId: string, opts?: RunTurnOptions): Promise<TurnResult>;
```

### Behavior (the sequence)

Lifted from the route's `start(controller)` body, with `controller.enqueue(sseEncode(x))` replaced by `emit(x)`:

1. Load the session. Not found → `emit({type:'error'})`, return `{status:'error', reason:'session not found'}`.
2. **Acquire the lease** (see below). Held by a live turn → return `{status:'skipped', reason:'turn already running'}` and `emit({type:'skipped'})`. Nothing else runs.
3. From here in a `try/finally` that **releases the lease**.
4. If `instruction` is set, persist it as a `role:'user'` message (so the transcript includes it and history stays coherent).
5. Load the conversation (respecting `cleared_at`, same query as today). Resolve the last `role:'user'` message. If there is none (no pending message and no instruction) → `emit` + return `{status:'error', reason:'no prompt to respond to'}`.
6. Build the transcript (`buildOrchestratorPrompt`) and resolve addressing (`parseMention` → primary = addressed specialist or Sage).
7. `ensureWorktree` (emit `worktree` / `worktree_error`); persist `worktree_path` if changed.
8. Build the dispatch context — its `emit`, `persistMessage`, `onBeforeDispatch` (`flushPrimary`), and `savePlanSnapshot` callbacks, exactly as today. Its `emit` is the **same** `emit` passed to `runSessionTurn`, so primary + specialist events funnel through one sink.
9. `for await (event of runClaudeAgent({ ..., signal: combinedSignal }))`: emit terminal/activity/token/raw events, accumulate the primary buffer, upsert the plan on `TodoWrite`, capture usage on `done` — all as today.
10. Flush the primary's closing message; bump `sessions.updated_at`; `emit({type:'persisted'})`; return `{status:'completed'}`.

### The SSE route, refactored

`GET` keeps auth (cookie → 401) and the SSE `Response` wrapper. Its stream body becomes:

```ts
async start(controller) {
  const emit = (e) => controller.enqueue(sseEncode(e));
  try { await runSessionTurn(sessionId, { emit, signal: req.signal }); }
  catch (err) { emit({ type: 'error', message: err instanceof Error ? err.message : String(err) }); }
  finally { controller.close(); }
}
```

Session-not-found / no-prompt checks move into `runSessionTurn` and surface as emitted `error` events rather than pre-stream 404/400 HTTP statuses (the client already renders `error` events; only the 401 auth check stays at the route). The route drops from ~230 lines of turn logic to ~15.

## Concurrency lease (cross-process safe)

A CLI turn (separate process) and a browser turn (Next process) must not run the
same session's git worktree simultaneously. Add one nullable column to
`sessions`:

```ts
running_since: integer('running_since', { mode: 'timestamp' }),  // null = idle
```

(drizzle-kit generated migration.) Acquire with an atomic compare-and-set — a
single conditional UPDATE, reliable because better-sqlite3 is synchronous /
single-writer:

```sql
UPDATE sessions SET running_since = :now
WHERE id = :id AND (running_since IS NULL OR running_since < :staleCutoff)
```

- `staleCutoff = now - (maxDurationMs + 60_000)` — a crashed turn's lease
  auto-expires and is reclaimable.
- 0 rows changed → a live turn holds it → `skipped` (no side effects).
- The `finally` clears `running_since` **only if this call acquired it** (guard
  with a local `acquired` flag), never stomping another holder's lease.

The pure decision logic is extracted to `src/lib/turn-lease.ts` and unit-tested:
`isLeaseStale(runningSince, now, ttlMs)` and the prompt-source decision
(`instruction` → use it; else last user message; else "no prompt").

## Abort / timeout

`runSessionTurn` creates a timeout `AbortController` (`setTimeout(abort, maxDurationMs)`).
If `opts.signal` is provided, the run aborts when **either** that or the timeout
fires (linked via `addEventListener('abort', …)`). The combined signal is passed
to `runClaudeAgent`. The route supplies `req.signal` so the browser "Stop" still
aborts; the CLI supplies no external signal and is bounded only by the timeout.
The timer is cleared in `finally`.

## CLI trigger

`scripts/run-turn.ts`, run via a new package script:

```jsonc
"run:turn": "cross-env NODE_OPTIONS=--conditions=react-server tsx scripts/run-turn.ts"
```

Usage: `pnpm run:turn <sessionId> ["instruction"]`. It loads `dotenv/config`,
then calls `runSessionTurn(sessionId, { instruction, emit: logLine })` where
`logLine` prints one concise line per event (`[activity] sage Read …`,
`[agent] …`, `[done] $<cost>`, `[persisted]`, `[skipped] …`). Exit code: `0` on
`completed`, non-zero on `skipped` / `error`.

**Why `--conditions=react-server`:** `run-turn.ts` imports `runSessionTurn`,
which imports `@/db/client` and `runClaudeAgent` — both import `'server-only'`,
which **throws** in a plain node/tsx process. Running with Node's
`react-server` export condition resolves `server-only` to its empty (no-throw)
module, the same condition Next uses for RSC. Verified:
`node --conditions=react-server -e "require('server-only')"` imports cleanly;
plain `node` throws. (The existing seed scripts dodge this by instantiating their
own `Database` and never importing `@/db/client`; the runner can't, because
`runClaudeAgent` is itself `server-only`.)

## Error handling

- A thrown turn error is caught, surfaced as an `error` event, and the lease is
  released in `finally` — a turn never leaks a held lease.
- Message + plan persistence stay best-effort (unchanged from today).
- Lease not acquired → clean `skipped` return, zero side effects (no worktree, no
  agent run).

## Testing

Per the codebase pattern, server-only modules (`run-turn.ts`) are not
unit-tested (they import `'server-only'`, which throws under `node:test`).

- **Unit (`src/lib/turn-lease.test.ts`, `node:test` via tsx):** `isLeaseStale`
  (fresh / stale / null) and the prompt-source decision (instruction vs last
  user message vs neither).
- **Runtime verification:**
  1. **Regression** — a browser turn still works end-to-end through the
     refactored route (the existing live path, incl. a dispatch turn).
  2. **Headless** — `pnpm run:turn <sessionId> "say hello"` runs a full turn with
     no browser; the agent reply persists; `running_since` is null afterward.
  3. **Lease** — start a CLI turn, fire a second `run:turn` for the same session
     mid-flight → it prints `skipped`, exits non-zero, leaves the worktree
     untouched.

## Files touched

- **New** `src/lib/run-turn.ts` — `runSessionTurn` (server-only).
- **New** `src/lib/turn-lease.ts` + `src/lib/turn-lease.test.ts` — pure lease /
  prompt-source helpers and their tests.
- **New** `scripts/run-turn.ts` — the CLI.
- **Modify** `src/db/schema.ts` — add `running_since`; + a generated migration
  under `drizzle/`.
- **Modify** `src/app/api/sessions/[id]/stream/route.ts` — slim to an auth check
  + `emit`-wired call to `runSessionTurn`.
- **Modify** `package.json` — add the `run:turn` script.

## Notes for later (not this spec)

- Scheduler/Dreaming call `runSessionTurn` directly (in-process ticker) or via the
  CLI (systemd timer). Either reuses the lease + instruction support built here.
- The `skipped`/lease model also gives the eventual Scheduler a natural "don't
  double-fire" guarantee.
