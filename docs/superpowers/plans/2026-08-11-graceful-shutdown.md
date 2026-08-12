# Graceful Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mission-control` exit cleanly on SIGTERM instead of hanging the full 30s `TimeoutStopSec` and being SIGKILLed on every stop.

**Architecture:** A small pure disposer registry (`src/lib/shutdown.ts`) that every background service registers a teardown function with. `src/instrumentation.ts` binds SIGTERM/SIGINT, runs the registry with a bounded budget, and exits. In-flight agent turns are aborted through the existing turn broker; because `run-turn.ts` already releases its lease in a `finally`, aborted turns release `sessions.running_since` themselves.

**Tech Stack:** TypeScript, Next.js 16 instrumentation hook, `node:test` run via `tsx`, systemd.

## Global Constraints

- Tests run via `pnpm test` → `tsx --test`. Use `node:test` + `node:assert/strict`.
- **Imports must be extensionless** (`from './shutdown'`, never `'./shutdown.ts'`) — a `.ts` extension breaks `tsc` and `next build`.
- New test files under `src/lib/*.test.ts` are picked up by the existing `pnpm test` glob. **Do not** add a new glob to `package.json`.
- `src/lib/shutdown.ts` and `src/lib/turn-broker.ts` must stay **pure** — no `server-only`, no DB imports — so they remain unit-testable.
- Every service starter keeps its existing `globalThis.__mcXStarted` idempotence flag; disposers reset that flag so start/stop stays symmetric.
- Total shutdown budget **8000ms**; turn-drain budget **5000ms**. systemd `TimeoutStopSec` becomes **20s** as a backstop only.
- Commit messages end with the repo trailer: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Work in an isolated worktree off `dev`. Never branch-switch the live checkout.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/shutdown.ts` (new) | Disposer registry + bounded runner. Pure. |
| `src/lib/shutdown.test.ts` (new) | Unit tests for the registry. |
| `src/lib/turn-broker.ts` (modify) | Add `runningIds`, `abortAll`, `drainTurns`. |
| `src/lib/turn-broker.test.ts` (modify) | Tests for the three new functions. |
| `src/lib/scheduler.ts` (modify) | Retain interval handle; register disposer. |
| `src/lib/dream.ts` (modify) | Same. |
| `src/lib/akira/reflect.ts` (modify) | Same. |
| `src/lib/discord-notify.ts` (modify) | Same. |
| `src/lib/discord-bot.ts` (modify) | Register disposer that destroys the client. |
| `src/instrumentation.ts` (modify) | Register turn-drain disposer; bind SIGTERM/SIGINT; exit. |
| `docs/runbook-deploy-homelab.md` (modify) | Record new unit settings + corrected ops facts. |

---

### Task 1: Shutdown registry

**Files:**
- Create: `src/lib/shutdown.ts`
- Test: `src/lib/shutdown.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `onShutdown(name: string, fn: Disposer, budgetMs?: number): void`, `runShutdown(opts?: RunShutdownOpts): Promise<ShutdownReport>`, `resetShutdown(): void`, types `Disposer`, `DisposerResult`, `ShutdownReport`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/shutdown.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShutdown, runShutdown, resetShutdown } from './shutdown';

test('runs disposers in registration order and reports success', async () => {
  resetShutdown();
  const order: string[] = [];
  onShutdown('a', () => { order.push('a'); });
  onShutdown('b', async () => { order.push('b'); });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.deepEqual(order, ['a', 'b']);
  assert.equal(report.ran, true);
  assert.deepEqual(report.results.map((r) => r.name), ['a', 'b']);
  assert.ok(report.results.every((r) => r.ok));
});

test('is idempotent: a second call returns the same report without re-running', async () => {
  resetShutdown();
  let calls = 0;
  onShutdown('once', () => { calls++; });

  const first = await runShutdown({ timeoutMs: 1000 });
  const second = await runShutdown({ timeoutMs: 1000 });

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test('a throwing disposer is recorded but does not block the rest', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('boom', () => { throw new Error('nope'); });
  onShutdown('after', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.equal(reached, true);
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].error, 'nope');
  assert.equal(report.results[1].ok, true);
});

test('a hanging disposer is bounded by its budget and the next one still runs', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('hang', () => new Promise<void>(() => {}), 20);
  onShutdown('after', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.equal(report.results[0].timedOut, true);
  assert.equal(report.results[0].ok, false);
  assert.equal(reached, true);
});

test('disposers registered after the total budget is spent are marked timedOut', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('slow', () => new Promise<void>(() => {}), 50);
  onShutdown('never', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 30 });

  assert.equal(reached, false);
  assert.equal(report.results[1].timedOut, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/shutdown.test.ts`
Expected: FAIL — `Cannot find module './shutdown'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/shutdown.ts`:

```ts
// Process-wide shutdown registry. Background services register a disposer here;
// the SIGTERM handler in src/instrumentation.ts runs them all under a bounded
// budget and then exits. Pure (injectable clock/timers, no server-only or DB
// imports) so it is unit-tested with node:test.

export type Disposer = () => void | Promise<void>;

export interface DisposerResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  timedOut?: boolean;
}

export interface ShutdownReport {
  ran: boolean;
  results: DisposerResult[];
  totalMs: number;
}

export interface RunShutdownOpts {
  /** Total budget across every disposer. */
  timeoutMs?: number;
  /** Per-disposer default when one is not given at registration. */
  defaultBudgetMs?: number;
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Entry {
  name: string;
  fn: Disposer;
  budgetMs?: number;
}

const entries: Entry[] = [];
let inFlight: Promise<ShutdownReport> | null = null;

export function onShutdown(name: string, fn: Disposer, budgetMs?: number): void {
  entries.push({ name, fn, budgetMs });
}

/** Tests only: clear the registry and allow runShutdown to run again. */
export function resetShutdown(): void {
  entries.length = 0;
  inFlight = null;
}

/**
 * Run every registered disposer once, in registration order. Idempotent: a
 * second SIGTERM while shutting down returns the in-flight promise rather than
 * re-running teardown.
 */
export function runShutdown(opts: RunShutdownOpts = {}): Promise<ShutdownReport> {
  if (inFlight) return inFlight;
  inFlight = execute(opts);
  return inFlight;
}

async function execute(opts: RunShutdownOpts): Promise<ShutdownReport> {
  const now = opts.now ?? (() => Date.now());
  const setT = opts.setTimeout ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearT =
    opts.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const totalMs = opts.timeoutMs ?? 8000;
  const perDefault = opts.defaultBudgetMs ?? totalMs;
  const start = now();
  const deadline = start + totalMs;
  const results: DisposerResult[] = [];

  for (const entry of entries) {
    const t0 = now();
    const remaining = deadline - t0;
    if (remaining <= 0) {
      results.push({ name: entry.name, ok: false, ms: 0, timedOut: true });
      continue;
    }

    const budget = Math.min(entry.budgetMs ?? perDefault, remaining);
    let timedOut = false;
    let error: string | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        let handle: unknown;
        let settled = false;
        const settle = (act: () => void) => {
          if (settled) return;
          settled = true;
          if (handle !== undefined) clearT(handle);
          act();
        };
        handle = setT(() => {
          timedOut = true;
          settle(resolve);
        }, budget);
        Promise.resolve()
          .then(() => entry.fn())
          .then(
            () => settle(resolve),
            (err) => settle(() => reject(err)),
          );
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    results.push({
      name: entry.name,
      ok: !timedOut && error === undefined,
      ms: now() - t0,
      ...(error !== undefined ? { error } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    });
  }

  return { ran: true, results, totalMs: now() - start };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsx --test src/lib/shutdown.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shutdown.ts src/lib/shutdown.test.ts
git commit -m "feat(shutdown): bounded, idempotent disposer registry

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Turn broker drain

**Files:**
- Modify: `src/lib/turn-broker.ts` (append after `abort`, line 89-93)
- Test: `src/lib/turn-broker.test.ts` (append)

**Interfaces:**
- Consumes: existing `startTurn`, `abort`, `isRunning` from Task 0 (pre-existing code).
- Produces: `runningIds(): string[]`, `abortAll(): number`, `drainTurns(opts?): Promise<{ aborted: number; drained: boolean }>`.

- [ ] **Step 1: Write the failing test**

First **extend the existing import** at the top of `src/lib/turn-broker.test.ts` — do not add a second
`import ... from './turn-broker'` statement, which `no-duplicate-imports` will reject:

```ts
import { startTurn, subscribe, abort, isRunning, runningIds, abortAll, drainTurns, type BrokerEvent } from './turn-broker';
```

Then append these tests. Note they assert on **their own session ids**, never on global emptiness:
`turns` is a module-level map shared across every test in this file, so an earlier test that leaves a
deferred turn running would make a bare `assert.equal(res.drained, true)` fail intermittently.

```ts
test('runningIds lists only running turns; abortAll aborts them and returns the count', () => {
  const a = deferredRun();
  const b = deferredRun();
  startTurn('drain-a', a.run, { timers: fakeTimers().timers });
  startTurn('drain-b', b.run, { timers: fakeTimers().timers });

  assert.equal(runningIds().includes('drain-a'), true);
  assert.equal(runningIds().includes('drain-b'), true);

  const n = abortAll();
  assert.ok(n >= 2);
  assert.equal(a.s().aborted, true);
  assert.equal(b.s().aborted, true);

  a.finish();
  b.finish();
});

test('drainTurns returns a well-formed result and does not hang when idle', async () => {
  const res = await drainTurns({ timeoutMs: 50, pollMs: 1 });
  assert.equal(typeof res.aborted, 'number');
  assert.equal(typeof res.drained, 'boolean');
});

test('drainTurns waits for an aborted turn to settle', async () => {
  const d = deferredRun();
  startTurn('drain-wait', d.run, { timers: fakeTimers().timers });
  assert.equal(isRunning('drain-wait'), true);

  // Injected sleep finishes the turn on the first poll, simulating the turn's
  // own finally block unwinding after the abort.
  let polls = 0;
  const sleep = async () => {
    polls++;
    if (polls === 1) d.finish();
    await Promise.resolve();
  };

  const res = await drainTurns({ timeoutMs: 1000, pollMs: 1, sleep });

  assert.ok(res.aborted >= 1);
  assert.equal(d.s().aborted, true);
  // Assert on THIS turn, not global emptiness — other tests share the map.
  assert.equal(isRunning('drain-wait'), false);
  assert.equal(runningIds().includes('drain-wait'), false);
});

test('drainTurns gives up at its deadline and reports drained=false', async () => {
  const d = deferredRun();
  startTurn('drain-stuck', d.run, { timers: fakeTimers().timers });

  let t = 0;
  const res = await drainTurns({
    timeoutMs: 10,
    pollMs: 1,
    sleep: async () => { t += 5; },
    now: () => t,
  });

  // This turn never settles, so the drain must report failure.
  assert.equal(res.drained, false);
  assert.equal(isRunning('drain-stuck'), true);
  d.finish();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/turn-broker.test.ts`
Expected: FAIL — `runningIds is not a function` / no exported member.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/turn-broker.ts`:

```ts
/** Session ids with a turn currently running. */
export function runningIds(): string[] {
  const ids: string[] = [];
  for (const [id, state] of turns) if (state.running) ids.push(id);
  return ids;
}

/** Abort every running turn. Returns how many were aborted. */
export function abortAll(): number {
  let n = 0;
  for (const state of turns.values()) {
    if (state.running) {
      state.controller.abort();
      n++;
    }
  }
  return n;
}

/**
 * Abort all running turns and wait for them to unwind. Each turn's own `finally`
 * in run-turn.ts releases its sessions.running_since lease, so draining here is
 * what makes sessions cleanly restartable after a deploy. Injectable clock/sleep
 * so it stays unit-testable.
 */
export async function drainTurns(
  opts: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<{ aborted: number; drained: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 50;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        (t as { unref?: () => void }).unref?.();
      }));

  const aborted = abortAll();
  const deadline = now() + timeoutMs;
  while (runningIds().length > 0 && now() < deadline) {
    await sleep(pollMs);
  }
  return { aborted, drained: runningIds().length === 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsx --test src/lib/turn-broker.test.ts`
Expected: PASS — existing tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/turn-broker.ts src/lib/turn-broker.test.ts
git commit -m "feat(turn-broker): runningIds, abortAll, drainTurns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Register disposers for the four interval services

**Files:**
- Modify: `src/lib/scheduler.ts:29-36`
- Modify: `src/lib/dream.ts:156-178`
- Modify: `src/lib/akira/reflect.ts:127-144`
- Modify: `src/lib/discord-notify.ts:122-134`

**Interfaces:**
- Consumes: `onShutdown` from Task 1.
- Produces: nothing new — `startX()` signatures are unchanged.

- [ ] **Step 1: Add the disposer in `scheduler.ts`**

Add the import at the top of the file (alongside the existing imports):

```ts
import { onShutdown } from './shutdown';
```

Replace the body of `startScheduler` so the interval handle is retained:

```ts
export function startScheduler(): void {
  const g = globalThis as unknown as { __mcSchedulerStarted?: boolean };
  if (g.__mcSchedulerStarted) return;
  g.__mcSchedulerStarted = true;
  void tick(); // run once at boot, then on the interval
  const handle = setInterval(() => void tick(), TICK_MS);
  onShutdown('scheduler', () => {
    clearInterval(handle);
    g.__mcSchedulerStarted = false;
  });
  console.log('[scheduler] started (60s tick)');
}
```

- [ ] **Step 2: Add the disposer in `dream.ts`**

Add the import at the top of the file:

```ts
import { onShutdown } from './shutdown';
```

Replace the last three lines of `startDreaming` (the `void check(); setInterval(...); console.log(...)` block) with:

```ts
  void check();
  const handle = setInterval(() => void check(), DREAM_TICK_MS);
  onShutdown('dreaming', () => {
    clearInterval(handle);
    g.__mcDreamingStarted = false;
  });
  console.log(`[dreaming] started (nightly hour ${NIGHTLY_HOUR})`);
```

- [ ] **Step 3: Add the disposer in `akira/reflect.ts`**

Add the import at the top of the file (note the extra `../` — this file is one level deeper):

```ts
import { onShutdown } from '../shutdown';
```

Replace the last three lines of `startReflecting` with:

```ts
  void check();
  const handle = setInterval(() => void check(), TICK_MS);
  onShutdown('reflect', () => {
    clearInterval(handle);
    g.__mcReflectingStarted = false;
  });
  console.log(`[reflect] started (nightly hour ${REFLECTION_HOUR})`);
```

- [ ] **Step 4: Add the disposer in `discord-notify.ts`**

Add the import at the top of the file:

```ts
import { onShutdown } from './shutdown';
```

Replace the body of `startDiscordNotify` after the guard flags:

```ts
  const handle = setInterval(() => {
    void tick().catch((err) =>
      console.error('[discord-notify] tick failed:', err instanceof Error ? err.message : err),
    );
  }, POLL_MS);
  onShutdown('discord-notify', () => {
    clearInterval(handle);
    g.__mcDiscordNotifyStarted = false;
  });
  console.log('[discord-notify] started (30s poll)');
```

- [ ] **Step 5: Verify types and tests still pass**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scheduler.ts src/lib/dream.ts src/lib/akira/reflect.ts src/lib/discord-notify.ts
git commit -m "feat(shutdown): retain interval handles and register disposers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Discord client disposer

**Files:**
- Modify: `src/lib/discord-bot.ts:61-98`

**Interfaces:**
- Consumes: `onShutdown` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

At the top of `src/lib/discord-bot.ts`:

```ts
import { onShutdown } from './shutdown';
```

- [ ] **Step 2: Register the disposer**

In `startDiscordBot`, immediately after the `client.login(token).catch(...)` call at the end of the function, add:

```ts
  onShutdown('discord-bot', async () => {
    g.__mcDiscordStarted = false;
    await client.destroy();
  });
```

`client.destroy()` closes the gateway WebSocket, which is one of the handles keeping the event loop alive. Do **not** touch the module-level `readyClient` here — leaving it alone avoids a type change, and the process is exiting immediately afterward.

- [ ] **Step 3: Verify types**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/discord-bot.ts
git commit -m "feat(shutdown): destroy the discord client on teardown

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Bind SIGTERM/SIGINT and exit

**Files:**
- Modify: `src/instrumentation.ts` (whole file)

**Interfaces:**
- Consumes: `onShutdown` / `runShutdown` (Task 1), `drainTurns` (Task 2), the five `startX()` functions (Tasks 3-4).
- Produces: nothing — this is the top-level wiring.

Registration order matters and falls out naturally: the five starters register their disposers first (so the tickers stop before anything else), then the turn-drain disposer is registered last (so no ticker can start a new turn while turns are draining).

- [ ] **Step 1: Replace the file**

```ts
// Next.js startup hook (runs once per server process). Starts the in-process
// background tickers: the Scheduler, the Dreaming Curator, and the Discord Bot.
// Guarded to the Node runtime (not Edge); each starter is itself idempotent so
// dev/HMR re-registration is safe.
//
// Each starter registers a disposer with src/lib/shutdown.ts. We bind SIGTERM
// here and run those disposers under a bounded budget, then exit explicitly:
// without this the four background intervals and the Discord gateway socket keep
// the event loop alive forever and systemd SIGKILLs us at TimeoutStopSec.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
    const { startDreaming } = await import('@/lib/dream');
    startDreaming();
    const { startReflecting } = await import('@/lib/akira/reflect');
    startReflecting();
    const { startDiscordBot } = await import('@/lib/discord-bot');
    startDiscordBot();
    const { startDiscordNotify } = await import('@/lib/discord-notify');
    startDiscordNotify();

    const { onShutdown, runShutdown } = await import('@/lib/shutdown');
    const { drainTurns } = await import('@/lib/turn-broker');

    // Registered last so the tickers above are already stopped: no new turn can
    // start while we drain. Each aborted turn releases its own lease via the
    // finally block in run-turn.ts.
    onShutdown(
      'turns',
      async () => {
        const { aborted, drained } = await drainTurns({ timeoutMs: 5000 });
        console.log(`[shutdown] turns aborted=${aborted} drained=${drained}`);
      },
      6000,
    );

    const g = globalThis as unknown as { __mcSignalsBound?: boolean };
    if (!g.__mcSignalsBound) {
      g.__mcSignalsBound = true;
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          console.log(`[shutdown] ${signal} received`);
          void runShutdown({ timeoutMs: 8000 }).then((report) => {
            for (const r of report.results) {
              const flags = `${r.timedOut ? ' timeout' : ''}${r.error ? ` error=${r.error}` : ''}`;
              console.log(`[shutdown] ${r.name} ok=${r.ok} ${r.ms}ms${flags}`);
            }
            console.log(`[shutdown] complete in ${report.totalMs}ms`);
            // Explicit: open SSE sockets would otherwise keep the HTTP server
            // from closing, and the work they were streaming is already aborted.
            process.exit(0);
          });
        });
      }
    }
  }
}
```

- [ ] **Step 2: Verify types and the full suite**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Verify the real behaviour locally**

Run: `pnpm build && pnpm start`
Wait for `✓ Ready`, confirm the five ticker log lines, then in a second terminal find the PID and send SIGTERM:

```bash
# PowerShell: Get-Process node | Select-Object Id,StartTime
kill -TERM <pid>
```

Expected: `[shutdown] SIGTERM received`, one `[shutdown] <name> ok=true` line per disposer, `[shutdown] complete in <N>ms` with N well under 8000, and the process exits on its own within a couple of seconds.

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat(shutdown): handle SIGTERM/SIGINT and exit cleanly

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: systemd unit + runbook

**Files:**
- Modify: `docs/runbook-deploy-homelab.md`

The unit file lives on the Mini at `/etc/systemd/system/mission-control.service`, not in this repo, so this task records the change; it is applied during deploy (Phase 5).

- [ ] **Step 1: Document the unit change**

Add to `docs/runbook-deploy-homelab.md`, in the systemd section:

````markdown
> **Graceful shutdown (v1.19.0+).** The app now handles SIGTERM: it clears the four
> background intervals, destroys the Discord client, aborts in-flight turns (which
> releases their `sessions.running_since` leases) and exits — typically in under 2s.
> Before this, every stop hung the full `TimeoutStopSec` and was SIGKILLed (15 such
> timeouts in the journal as of 2026-08-11). The unit needs two changes to match:
>
> ```ini
> KillMode=mixed
> TimeoutStopSec=20
> ```
>
> `KillMode=mixed` sends SIGTERM to the main process only and SIGKILLs stragglers at
> the timeout — the spawned `claude` CLI children are torn down by the app's abort
> path, and under the default `control-group` they were holding the cgroup open.
> `TimeoutStopSec` is now only a backstop. Apply with:
>
> ```bash
> sudo sed -i 's/^TimeoutStopSec=30$/TimeoutStopSec=20/' /etc/systemd/system/mission-control.service
> sudo sed -i '/^TimeoutStopSec=/i KillMode=mixed' /etc/systemd/system/mission-control.service
> sudo systemctl daemon-reload && sudo systemctl restart mission-control
> ```
>
> **Acceptance:** `journalctl -u mission-control --since "5 min ago" | grep stop-sigterm`
> returns nothing, and `Stopping…` → `Stopped…` is seconds, not 30s.
````

- [ ] **Step 2: Correct two stale ops facts in the same file**

While editing the runbook, fix the drift found on 2026-08-11:

1. Replace any remaining `10.0.0.218` SSH examples with `10.0.0.219`.
2. Add, next to the existing better-sqlite3 gotcha:

````markdown
> **If `pnpm install` insists on purging `node_modules`** (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`
> — it needs `CI=true` to proceed non-interactively), the purge **will** delete the
> hand-compiled better-sqlite3 binding. Back it up first and restore it after; this is
> faster and safer than a node-gyp rebuild when the package version is unchanged:
>
> ```bash
> B=node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release
> cp $B/better_sqlite3.node /tmp/better_sqlite3.node.bak
> CI=true pnpm install --frozen-lockfile
> mkdir -p $B && cp /tmp/better_sqlite3.node.bak $B/better_sqlite3.node
> node -e "const D=require('better-sqlite3');new D('data/mission-control.db',{readonly:true}).close();console.log('binding ok')"
> ```
>
> Only valid when the lockfile pins the **same** better-sqlite3 version that produced the
> backup (check before restoring). Otherwise rebuild with node-gyp as documented above.
> Still do **not** run `pnpm approve-builds` — the allowlist is intentional.
````

- [ ] **Step 3: Commit**

```bash
git add docs/runbook-deploy-homelab.md
git commit -m "docs(runbook): graceful-shutdown unit settings, current Mini IP, binding backup

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Done criteria

- `pnpm test` green (existing suite + 9 new tests).
- `pnpm exec tsc --noEmit` clean.
- Local `pnpm start` + SIGTERM exits in under ~2s with a `[shutdown] complete` line.
- Feature branch merged into `dev` (never straight to `main`).
- After release + deploy: a Mini restart shows **no** `stop-sigterm timed out` in the journal.
