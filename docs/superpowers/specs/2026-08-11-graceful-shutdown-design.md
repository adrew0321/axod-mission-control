# Graceful shutdown — design

**Date:** 2026-08-11
**Status:** Spec, awaiting review.

## Problem

Every stop of the `mission-control` service hangs for exactly `TimeoutStopSec` (30s) and is then
SIGKILLed. Measured on the Mini: 15 stop-sigterm timeouts in the journal, and three consecutive
restarts on 2026-08-11 each took precisely 30s (`20:02:54→20:03:25`, `23:47:54→23:48:24`,
`00:33:47→00:34:17`).

Consequences:
- Every deploy and restart costs 30 wasted seconds.
- In-flight agent turns are killed mid-write rather than aborted cleanly.
- `sessions.running_since` leases are left set; sessions stay "running" until the stale-lease TTL
  in `src/lib/run-turn.ts` expires.
- The `claude` CLI subprocesses are killed by cgroup teardown rather than by their own abort path.

## Root cause

`src/instrumentation.ts` starts five background services on every server process. Nothing can stop
any of them:

| Service | File | Handle |
|---|---|---|
| Scheduler (60s tick) | `src/lib/scheduler.ts:34` | `setInterval(...)` — **return value discarded** |
| Dreaming (nightly) | `src/lib/dream.ts:174` | `setInterval(...)` — **discarded** |
| Reflect (nightly) | `src/lib/akira/reflect.ts:141` | `setInterval(...)` — **discarded** |
| Discord notify (30s poll) | `src/lib/discord-notify.ts:128` | `setInterval(...)` — **discarded** |
| Discord bot | `src/lib/discord-bot.ts:61` | `Client` — never `destroy()`ed; holds a gateway socket |

There is **no `SIGTERM`/`SIGINT`/`process.on` handler anywhere in `src/`**. Four un-clearable
intervals plus an open WebSocket keep the Node event loop alive indefinitely, so `next start` never
exits and systemd escalates to SIGKILL.

## What already works (do not rebuild)

- `src/lib/turn-broker.ts` already `.unref()`s its retention timers — they never block exit.
- `src/lib/run-turn.ts` releases the lease in a `finally` (line ~291), so **an aborted turn releases
  its own lease**. No separate lease-sweep is needed.
- A missed release self-heals via the stale-lease cutoff (`maxDurationMs + LEASE_GRACE_MS`).

## Design

### 1. `src/lib/shutdown.ts` (new, pure)

A small disposer registry — one seam, unit-testable per the repo's `node:test` via `tsx` convention
(no server-only imports, injectable timers).

```ts
export type Disposer = () => void | Promise<void>;
export function onShutdown(name: string, fn: Disposer): void;
export function runShutdown(opts?: { timeoutMs?: number; now?: () => number }): Promise<ShutdownReport>;
export function resetShutdown(): void; // tests only
```

- `runShutdown` is **idempotent** — a second SIGTERM while shutting down is a no-op, not a
  double-run.
- Each disposer is individually bounded and individually try/caught: one throwing or hanging
  disposer must not prevent the others from running.
- Returns a report (`{ name, ok, ms }[]`) so shutdown can log what drained and what didn't.

### 2. Disposer registration

Each starter retains its interval handle and registers a disposer at the point it starts. No change
to the public `startX()` signatures, so `instrumentation.ts` stays as-is apart from the signal hook.

- scheduler / dream / reflect / discord-notify → `clearInterval(handle)`
- discord-bot → `await client.destroy()`

### 3. In-flight turns — abort + bounded unwind (decided)

Add to `turn-broker.ts`:

```ts
export function runningIds(): string[];
export function abortAll(): number;      // aborts every running turn, returns count
```

Shutdown sequence: `abortAll()` → poll `runningIds().length === 0` → proceed once drained or after
the grace budget. Each aborted turn's own `finally` releases its `running_since`, so sessions come
back cleanly restartable.

**Budgets:** 5s for turn unwind, 8s total for `runShutdown`, then `process.exit(0)` regardless.
Comfortably inside systemd's 20s backstop.

### 4. Signal handler

In `src/instrumentation.ts`, after the starters, guarded to `NEXT_RUNTIME === 'nodejs'` and
registered once (`process.once`) for both `SIGTERM` and `SIGINT`:

```
signal → log → runShutdown({ timeoutMs: 8000 }) → log report → process.exit(0)
```

`process.exit(0)` is deliberate: open SSE sockets would otherwise keep the HTTP server from closing,
and we have already aborted the work those sockets were streaming.

### 5. systemd unit

`/etc/systemd/system/mission-control.service`:

- add `KillMode=mixed` — SIGTERM to the main process only, SIGKILL to stragglers on timeout. The
  spawned `claude` CLI children should be torn down by the app's abort path, not asked to handle
  SIGTERM themselves (today they hold the cgroup open).
- lower `TimeoutStopSec` 30 → 20 — a backstop, not the normal path.

## Out of scope

- Draining in-flight **HTTP** requests (Next handles its own server; we exit deliberately).
- Changing turn **resumption** semantics — turns are in-memory and die with the process by design;
  this change only ensures they die *cleanly*.
- Worktree cleanup on shutdown.
- Any change to the stale-lease TTL.

## Testing

`pnpm test` (`node:test` via `tsx`, extensionless imports):

- `src/lib/shutdown.test.ts` — runs disposers in registration order; idempotent on double-call; a
  throwing disposer doesn't block the rest; a hanging disposer is bounded by its budget; report
  shape is correct.
- `src/lib/turn-broker.test.ts` (extend) — `abortAll()` aborts every running turn and returns the
  count; `runningIds()` empties as turns settle; both are no-ops with zero turns.

Verification on the Mini after deploy: a restart completes in **well under 30s** with no
`stop-sigterm timed out` line in the journal — that is the acceptance criterion.

## Risk

Low. All changes are additive; if a disposer misbehaves the bounded budget still ends in
`process.exit(0)`, which is exactly today's behaviour minus the 30s wait.
