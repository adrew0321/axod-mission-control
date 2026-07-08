# Turn Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a session's agent turn run to completion independently of the browser SSE connection that started it, so a dropped/idle/reconnecting connection no longer aborts the turn.

**Architecture:** An in-memory per-session broker owns the running turn (its `AbortController`, an event buffer, and a set of subscribers). The `/stream` route starts the turn as a background task via the broker and only *subscribes*; client disconnect just unsubscribes. A generalized SSE helper (`startSseStream`) adds the heartbeat + idempotent cleanup both the companion and session streams share. "Stop" becomes an explicit `POST /stop` that aborts the broker's controller.

**Tech Stack:** TypeScript, Next.js 16 route handlers (Web `ReadableStream`/`Request`), Node 22 built-ins, `node:test` via `tsx --test`, React (client).

## Global Constraints

- **No new npm dependencies. No DB migration.** Code-only change.
- **Extensionless relative imports** (`from './sse-stream'`, not `.ts`).
- **Never abort the turn on a passive client disconnect** — only on `POST /stop` or the turn's own max-duration timeout inside `runSessionTurn`.
- **`runSessionTurn`'s signature and lease behavior are unchanged** — only how it is invoked/aborted changes (the route stops passing `req.signal` into it).
- **Unit-tested modules are pure** (`node:`-only, no `server-only`) so they run under `tsx --test`. Routes and React are verified by manual E2E per repo convention.
- **Retention window** `RETENTION_MS = 30_000`; **client max reconnects** `5`; **heartbeat** `15_000ms` (reuse `HEARTBEAT_MS`).

---

### Task 1: Generic `startSseStream` helper

Extract the heartbeat + idempotent-cleanup core (currently companion-specific in `stream-lifecycle.ts`) into a reusable module that drives any SSE stream from a subscribe/unsubscribe source.

**Files:**
- Create: `src/lib/sse-stream.ts`
- Test: `src/lib/sse-stream.test.ts`

**Interfaces:**
- Produces:
  - `interface SseEvent { type: string; [k: string]: unknown }`
  - `interface StreamLike { enqueue: (chunk: Uint8Array) => void; close: () => void }`
  - `interface AbortLike { addEventListener: (type: 'abort', cb: () => void) => void }`
  - `interface Timers { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void }`
  - `const HEARTBEAT_MS = 15_000`
  - `function sse(event: SseEvent): Uint8Array`
  - `function startSseStream(opts: { controller: StreamLike; subscribe: (emit: (event: SseEvent) => void, close: () => void) => () => void; signal: AbortLike; closeOn?: (event: SseEvent) => boolean; heartbeatMs?: number; timers?: Timers }): void`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sse-stream.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSseStream, type SseEvent } from './sse-stream';

function fakeController() {
  let closed = false;
  const chunks: string[] = [];
  return {
    isClosed: () => closed,
    chunks,
    ctrl: {
      enqueue(u: Uint8Array) {
        if (closed) throw new TypeError('Invalid state: Controller is already closed');
        chunks.push(new TextDecoder().decode(u));
      },
      close() { closed = true; },
    },
  };
}
function fakeTimers() {
  let seq = 0;
  const cbs = new Map<number, () => void>();
  return {
    tick: () => { for (const cb of [...cbs.values()]) cb(); },
    live: () => cbs.size,
    timers: {
      setInterval: (cb: () => void) => { const h = ++seq; cbs.set(h, cb); return h; },
      clearInterval: (h: unknown) => { cbs.delete(h as number); },
    },
  };
}

test('heartbeat enqueues pings while open', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  startSseStream({
    controller: fc.ctrl,
    subscribe: () => () => {},
    signal: { addEventListener() {} },
    timers: ft.timers,
  });
  ft.tick();
  assert.ok(fc.chunks.some((c) => c.includes('ping')));
});

test('emitted events are sse-encoded to the controller', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let emit!: (e: SseEvent) => void;
  startSseStream({
    controller: fc.ctrl,
    subscribe: (e) => { emit = e; return () => {}; },
    signal: { addEventListener() {} },
    timers: ft.timers,
  });
  emit({ type: 'token', content: 'hi' });
  assert.ok(fc.chunks.some((c) => c.startsWith('data: ') && c.includes('"token"') && c.includes('hi')));
});

test('a closeOn event closes the controller and unsubscribes', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let emit!: (e: SseEvent) => void;
  let unsubscribed = 0;
  startSseStream({
    controller: fc.ctrl,
    subscribe: (e) => { emit = e; return () => { unsubscribed++; }; },
    signal: { addEventListener() {} },
    closeOn: (e) => e.type === 'persisted',
    timers: ft.timers,
  });
  emit({ type: 'persisted' });
  assert.equal(fc.isClosed(), true);
  assert.equal(unsubscribed, 1);
  assert.equal(ft.live(), 0);
  assert.doesNotThrow(() => ft.tick());
});

test('signal abort tears down once (unsubscribe + close + heartbeat cleared)', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let abortCb: (() => void) | undefined;
  let unsubscribed = 0;
  startSseStream({
    controller: fc.ctrl,
    subscribe: () => () => { unsubscribed++; },
    signal: { addEventListener: (_t, cb) => { abortCb = cb; } },
    timers: ft.timers,
  });
  abortCb!();
  abortCb!();
  assert.equal(fc.isClosed(), true);
  assert.equal(unsubscribed, 1);
  assert.equal(ft.live(), 0);
});

test('the source-provided close callback tears the stream down', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let sourceClose!: () => void;
  startSseStream({
    controller: fc.ctrl,
    subscribe: (_emit, close) => { sourceClose = close; return () => {}; },
    signal: { addEventListener() {} },
    timers: ft.timers,
  });
  sourceClose();
  assert.equal(fc.isClosed(), true);
  assert.equal(ft.live(), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/sse-stream.test.ts`
Expected: FAIL — module `./sse-stream` not found.

- [ ] **Step 3: Implement**

Create `src/lib/sse-stream.ts`:

```ts
// Generic SSE stream driver: subscribe to a source, heartbeat to keep the
// connection alive, and tear down EXACTLY ONCE from any close path — client
// abort, a source-close, a terminal (closeOn) event, or a failed enqueue. Pure
// (no server-only) so it is unit-tested with a fake controller/timers. Shared by
// the companion stream and the session-turn stream.

export interface SseEvent { type: string; [k: string]: unknown }
export interface StreamLike { enqueue: (chunk: Uint8Array) => void; close: () => void }
export interface AbortLike { addEventListener: (type: 'abort', cb: () => void) => void }
export interface Timers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const encoder = new TextEncoder();
export function sse(event: SseEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export const HEARTBEAT_MS = 15_000;

export function startSseStream(opts: {
  controller: StreamLike;
  subscribe: (emit: (event: SseEvent) => void, close: () => void) => () => void;
  signal: AbortLike;
  closeOn?: (event: SseEvent) => boolean;
  heartbeatMs?: number;
  timers?: Timers;
}): void {
  const { controller, subscribe, signal, closeOn } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const timers: Timers = opts.timers ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  let closed = false;
  let hb: unknown;
  let unsubscribe: () => void = () => {};

  const cleanup = () => {
    if (closed) return; // idempotent — first caller wins
    closed = true;
    if (hb !== undefined) timers.clearInterval(hb);
    unsubscribe();
    try { controller.close(); } catch { /* already closed */ }
  };

  const rawEnqueue = (chunk: Uint8Array) => {
    if (closed) return;
    try { controller.enqueue(chunk); } catch { cleanup(); }
  };

  const emit = (event: SseEvent) => {
    rawEnqueue(sse(event));
    if (closeOn?.(event)) cleanup();
  };

  unsubscribe = subscribe(emit, cleanup);
  hb = timers.setInterval(() => rawEnqueue(sse({ type: 'ping' })), heartbeatMs);
  signal.addEventListener('abort', cleanup);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/sse-stream.test.ts`
Expected: PASS (all five).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sse-stream.ts src/lib/sse-stream.test.ts
git commit -m "feat(sse): generic startSseStream (heartbeat + idempotent cleanup)"
```

---

### Task 2: Refactor `stream-lifecycle.ts` onto `startSseStream`

Make the companion stream a thin adapter over the generic helper, so there's one heartbeat/cleanup implementation. The existing companion tests must stay green.

**Files:**
- Modify: `src/lib/companion/stream-lifecycle.ts` (replace body; keep `startCompanionStream` export + signature)
- Test: `src/lib/companion/stream-lifecycle.test.ts` (unchanged — must still pass)

**Interfaces:**
- Consumes: `startSseStream`, `StreamLike`, `AbortLike`, `Timers` (Task 1).
- Produces: `startCompanionStream(opts: { controller: StreamLike; register: (sink: { send: (cmd: Command) => void; close: () => void }) => () => void; signal: AbortLike; heartbeatMs?: number; timers?: Timers }): void` (unchanged signature).

- [ ] **Step 1: Replace the implementation**

Replace the entire contents of `src/lib/companion/stream-lifecycle.ts` with:

```ts
// The companion SSE stream, now a thin adapter over the shared startSseStream.
// The companion's registry sink maps to the generic subscribe/close contract:
// registry displacement calls the sink's close(), which tears this stream down.
import { startSseStream, type StreamLike, type AbortLike, type Timers } from '../sse-stream';
import type { Command } from './protocol';

export { HEARTBEAT_MS } from '../sse-stream';

export function startCompanionStream(opts: {
  controller: StreamLike;
  register: (sink: { send: (cmd: Command) => void; close: () => void }) => () => void;
  signal: AbortLike;
  heartbeatMs?: number;
  timers?: Timers;
}): void {
  startSseStream({
    controller: opts.controller,
    signal: opts.signal,
    heartbeatMs: opts.heartbeatMs,
    timers: opts.timers,
    subscribe: (emit, close) =>
      opts.register({ send: (cmd) => emit({ type: 'command', cmd }), close }),
  });
}
```

- [ ] **Step 2: Run the companion tests (must still pass)**

Run: `pnpm exec tsx --test src/lib/companion/stream-lifecycle.test.ts`
Expected: PASS (all pre-existing tests — displacement, abort, heartbeat).

- [ ] **Step 3: Typecheck the companion stream route still compiles**

Run: `pnpm exec tsx --test src/lib/sse-stream.test.ts src/lib/companion/stream-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/companion/stream-lifecycle.ts
git commit -m "refactor(companion): stream-lifecycle adapts the shared startSseStream"
```

---

### Task 3: `turn-broker` — per-session turn registry

**Files:**
- Create: `src/lib/turn-broker.ts`
- Test: `src/lib/turn-broker.test.ts`

**Interfaces:**
- Produces:
  - `interface BrokerEvent { type: string; [k: string]: unknown }`
  - `type TurnRun = (emit: (e: BrokerEvent) => void, signal: AbortSignal) => Promise<unknown>`
  - `interface BrokerTimers { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }`
  - `const RETENTION_MS = 30_000`
  - `function startTurn(sessionId: string, run: TurnRun, opts?: { retentionMs?: number; timers?: BrokerTimers }): { started: boolean }`
  - `function subscribe(sessionId: string, emit: (e: BrokerEvent) => void): () => void`
  - `function abort(sessionId: string): boolean`
  - `function isRunning(sessionId: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/turn-broker.test.ts` (each test uses a unique sessionId — the broker's map is module-global):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTurn, subscribe, abort, isRunning, type BrokerEvent } from './turn-broker';

function deferredRun() {
  let emit!: (e: BrokerEvent) => void;
  let signal!: AbortSignal;
  let resolve!: () => void;
  const run = (e: (ev: BrokerEvent) => void, s: AbortSignal) => {
    emit = e; signal = s;
    return new Promise<void>((r) => { resolve = r; });
  };
  return { run, e: () => emit, s: () => signal, finish: () => resolve() };
}
function fakeTimers() {
  let seq = 0;
  const cbs = new Map<number, () => void>();
  return {
    fire: () => { for (const cb of [...cbs.values()]) cb(); },
    timers: {
      setTimeout: (cb: () => void) => { const h = ++seq; cbs.set(h, cb); return h; },
      clearTimeout: (h: unknown) => { cbs.delete(h as number); },
    },
  };
}

test('startTurn runs once; a second start while running is a no-op', () => {
  const d = deferredRun();
  let calls = 0;
  const wrapped = (e: (ev: BrokerEvent) => void, s: AbortSignal) => { calls++; return d.run(e, s); };
  assert.deepEqual(startTurn('s1', wrapped), { started: true });
  assert.equal(isRunning('s1'), true);
  assert.deepEqual(startTurn('s1', wrapped), { started: false });
  assert.equal(calls, 1);
  d.finish();
});

test('subscribe replays the buffer to each new subscriber, then streams live', async () => {
  const d = deferredRun();
  startTurn('s2', d.run);
  d.e()({ type: 'start' });
  d.e()({ type: 'token', content: 'a' });

  const got1: string[] = [];
  subscribe('s2', (ev) => got1.push(ev.type));
  assert.deepEqual(got1, ['start', 'token']); // replay

  const got2: string[] = [];
  subscribe('s2', (ev) => got2.push(ev.type));
  assert.deepEqual(got2, ['start', 'token']); // second subscriber replays too

  d.e()({ type: 'persisted' });               // live fan-out to both
  assert.deepEqual(got1, ['start', 'token', 'persisted']);
  assert.deepEqual(got2, ['start', 'token', 'persisted']);
  d.finish();
});

test('a throwing subscriber is dropped; others keep receiving', () => {
  const d = deferredRun();
  startTurn('s3', d.run);
  subscribe('s3', () => { throw new Error('boom'); });
  const got: string[] = [];
  subscribe('s3', (ev) => got.push(ev.type));
  d.e()({ type: 'token', content: 'x' });
  assert.deepEqual(got, ['token']);
  d.finish();
});

test('unsubscribe stops delivery and does NOT abort the turn', () => {
  const d = deferredRun();
  startTurn('s4', d.run);
  const got: string[] = [];
  const off = subscribe('s4', (ev) => got.push(ev.type));
  off();
  d.e()({ type: 'token', content: 'x' });
  assert.deepEqual(got, []);
  assert.equal(d.s().aborted, false);
  d.finish();
});

test('abort aborts the signal handed to run; returns false when not running', () => {
  const d = deferredRun();
  startTurn('s5', d.run);
  assert.equal(abort('s5'), true);
  assert.equal(d.s().aborted, true);
  d.finish();
  assert.equal(abort('nope'), false);
});

test('when run settles, running flips false and the state is cleared after retention', async () => {
  const d = deferredRun();
  const ft = fakeTimers();
  startTurn('s6', d.run, { timers: ft.timers });
  d.e()({ type: 'persisted' });
  d.finish();
  await Promise.resolve();          // let the .then(finish) microtask run
  await Promise.resolve();
  assert.equal(isRunning('s6'), false);
  ft.fire();                        // retention timer → delete state
  // After clearing, a subscribe finds nothing and synthesizes a persisted.
  const got: string[] = [];
  subscribe('s6', (ev) => got.push(ev.type));
  assert.deepEqual(got, ['persisted']);
});

test('subscribe to an unknown session emits a synthetic persisted', () => {
  const got: string[] = [];
  const off = subscribe('never', (ev) => got.push(ev.type));
  assert.deepEqual(got, ['persisted']);
  off(); // no-op
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/turn-broker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/turn-broker.ts`:

```ts
// In-memory, per-session registry that decouples a running agent turn from the
// browser SSE connection that started it. The turn runs as a background task;
// SSE clients subscribe (replay + live) and can disconnect/reconnect without
// aborting it. Pure (node timers only, no DB/server-only) so it is unit-tested.

export interface BrokerEvent { type: string; [k: string]: unknown }
export type TurnRun = (emit: (e: BrokerEvent) => void, signal: AbortSignal) => Promise<unknown>;
export interface BrokerTimers {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const RETENTION_MS = 30_000;

interface TurnState {
  controller: AbortController;
  buffer: BrokerEvent[];
  subscribers: Set<(e: BrokerEvent) => void>;
  running: boolean;
  retention?: unknown;
}

const realTimers: BrokerTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const turns = new Map<string, TurnState>();

export function isRunning(sessionId: string): boolean {
  return turns.get(sessionId)?.running ?? false;
}

export function startTurn(
  sessionId: string,
  run: TurnRun,
  opts: { retentionMs?: number; timers?: BrokerTimers } = {},
): { started: boolean } {
  const retentionMs = opts.retentionMs ?? RETENTION_MS;
  const timers = opts.timers ?? realTimers;

  const existing = turns.get(sessionId);
  if (existing?.running) return { started: false };
  if (existing?.retention !== undefined) timers.clearTimeout(existing.retention);

  const state: TurnState = {
    controller: new AbortController(),
    buffer: [],
    subscribers: new Set(),
    running: true,
  };
  turns.set(sessionId, state);

  const publish = (e: BrokerEvent) => {
    state.buffer.push(e);
    for (const sub of [...state.subscribers]) {
      try { sub(e); } catch { state.subscribers.delete(sub); }
    }
  };

  const finish = () => {
    state.running = false;
    state.retention = timers.setTimeout(() => {
      if (turns.get(sessionId) === state && !state.running) turns.delete(sessionId);
    }, retentionMs);
  };

  // Fire-and-forget: the turn outlives this call. runSessionTurn surfaces its own
  // 'error'/'persisted' events, so finish() only handles lifecycle bookkeeping.
  Promise.resolve(run(publish, state.controller.signal)).then(finish, finish);
  return { started: true };
}

export function subscribe(sessionId: string, emit: (e: BrokerEvent) => void): () => void {
  const state = turns.get(sessionId);
  if (!state) {
    emit({ type: 'persisted' }); // nothing running/known → client closes + refreshes from DB
    return () => {};
  }
  for (const e of state.buffer) emit(e); // replay so a reconnecting client catches up
  state.subscribers.add(emit);
  return () => { state.subscribers.delete(emit); }; // NEVER touches the controller
}

export function abort(sessionId: string): boolean {
  const state = turns.get(sessionId);
  if (state?.running) { state.controller.abort(); return true; }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/turn-broker.test.ts`
Expected: PASS (all seven).

- [ ] **Step 5: Commit**

```bash
git add src/lib/turn-broker.ts src/lib/turn-broker.test.ts
git commit -m "feat(turns): in-memory per-session turn broker (start/subscribe/abort)"
```

---

### Task 4: Rework the session stream route onto the broker

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts` (replace whole file)

**Interfaces:**
- Consumes: `startTurn`, `subscribe` (Task 3); `startSseStream` (Task 1); `runSessionTurn` (existing).

- [ ] **Step 1: Replace the route**

Replace the entire contents of `src/app/api/sessions/[id]/stream/route.ts` with:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runSessionTurn } from '@/lib/run-turn';
import { startTurn, subscribe } from '@/lib/turn-broker';
import { startSseStream } from '@/lib/sse-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { id: sessionId } = await ctx.params;

  // Start the turn as a background task. Idempotent: the broker's in-process guard
  // plus runSessionTurn's cross-process DB lease make a concurrent call a no-op.
  // Crucially, req.signal is NOT passed in — a dropped connection no longer aborts
  // the turn; it only tears down this subscription (below).
  startTurn(sessionId, (emit, signal) => runSessionTurn(sessionId, { emit, signal }));

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      startSseStream({
        controller,
        signal: req.signal,
        subscribe: (emit) => subscribe(sessionId, emit),
        closeOn: (e) => e.type === 'persisted' || e.type === 'error' || e.type === 'skipped',
      });
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

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (no unused-import errors; `sseEncode` is gone, replaced by the helper).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/stream/route.ts
git commit -m "feat(turns): session stream subscribes to the broker (turn survives disconnect)"
```

---

### Task 5: Explicit Stop endpoint

**Files:**
- Create: `src/app/api/sessions/[id]/stop/route.ts`

**Interfaces:**
- Consumes: `abort` (Task 3).

- [ ] **Step 1: Create the route**

Create `src/app/api/sessions/[id]/stop/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { abort } from '@/lib/turn-broker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return new Response('Unauthorized', { status: 401 });
  }
  const { id: sessionId } = await ctx.params;
  const aborted = abort(sessionId);
  return Response.json({ ok: true, aborted });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sessions/[id]/stop/route.ts
git commit -m "feat(turns): POST /stop aborts a running turn via the broker"
```

---

### Task 6: Client — reconnect, replay-reset, and Stop-via-endpoint

The turn now outlives the connection. Rely on `EventSource`'s built-in auto-reconnect (it keeps the same object + handlers). On each (re)connect, reset the live bubbles so the broker's replay rebuilds them deterministically. Stop must hit the endpoint.

**Files:**
- Modify: `src/components/mission-control.tsx` — `handleStop` (line ~442) and the streaming handlers (lines ~608-820).

**Interfaces:**
- Consumes: `POST /api/sessions/[id]/stop` (Task 5); the broker's replay + `closeOn` behavior (Tasks 3-4).

- [ ] **Step 1: Route Stop through the endpoint**

Replace `handleStop` (currently lines ~442-450) with:

```tsx
  function handleStop() {
    const es = esRef.current;
    esRef.current = null;
    // The turn now outlives the SSE connection, so closing the stream no longer
    // stops it — abort it explicitly server-side.
    fetch(`/api/sessions/${activeSessionId}/stop`, { method: "POST" }).catch(() => {});
    es?.close();
    setIsTyping(false);
    setWorkingAgents([]);
    setAgentActivity({});
    setMessages((prev) => prev.filter((m) => !m.isStreaming));
    startTransition(() => router.refresh());
  }
```

If `activeSessionId` is not in scope at this point, use the same session reference the stream URL uses in the send handler (`session.id`); confirm which identifier is in scope by checking the `new EventSource(`/api/sessions/${…}/stream`)` line (~610) and match it exactly.

- [ ] **Step 2: Add a reset helper + reconnect handling in the send handler**

In the send handler, immediately after `const es = new EventSource(`/api/sessions/${session.id}/stream`);` and `esRef.current = es;` (lines ~610-611), add the reset helper and a reconnect counter:

```tsx
      let reconnectAttempts = 0;
      const MAX_RECONNECTS = 5;
      // Every (re)connect replays the broker's full buffer, so reset the live
      // bubbles first and let the replay rebuild them deterministically. Keep the
      // primary streaming bubble (tokens append to it) but clear its content; drop
      // the extra bubbles this turn created (dispatch + post-dispatch).
      const resetLiveTurn = () => {
        currentPrimaryId = streamingId;
        dispatchStreamId = null;
        pendingNewSageBubble = false;
        clientBubbleIds.length = 1; // keep [streamingId]
        setMessages((prev) =>
          prev
            .filter((m) => m.id === streamingId || !m.id.startsWith("dispatch_"))
            .map((m) =>
              m.id === streamingId ? { ...m, content: "", dispatch: undefined } : m,
            ),
        );
      };
      es.onopen = () => {
        reconnectAttempts = 0;
        resetLiveTurn();
      };
```

- [ ] **Step 3: Handle `skipped` like `persisted`, and close on terminal `error`**

Change the terminal branch (currently line ~796 `} else if (evt.type === "persisted") {`) to also cover `skipped`:

```tsx
          } else if (evt.type === "persisted" || evt.type === "skipped") {
```

(The body — `es.close()`, refresh, drop bubbles — is unchanged.)

And change the `error` branch (currently lines ~794-795) to close the stream too, since `error` is terminal:

```tsx
          } else if (evt.type === "error") {
            setSendError(evt.message ?? "Agent error");
            es.close();
            esRef.current = null;
            setIsTyping(false);
            setWorkingAgents([]);
            setAgentActivity({});
          }
```

- [ ] **Step 4: Make `onerror` reconnect instead of giving up**

Replace the `es.onerror` handler (currently lines ~814-820) with:

```tsx
      es.onerror = () => {
        reconnectAttempts += 1;
        if (reconnectAttempts > MAX_RECONNECTS) {
          es.close();
          esRef.current = null;
          setIsTyping(false);
          setWorkingAgents([]);
          setAgentActivity({});
          setSendError((prev) => prev ?? "Stream disconnected");
        }
        // else: leave the EventSource open — the browser auto-reconnects, the
        // broker replays, and onopen resets + rebuilds. The turn keeps running.
      };
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm exec tsc --noEmit`
Expected: PASS.

Run: `pnpm build`
Expected: build succeeds.

- [ ] **Step 6: Manual E2E (the real verification — server-only + React can't be unit-tested here)**

With the app running (`pnpm dev` or the Mini), in a session:
1. Send Sage a request that dispatches a specialist (e.g. "have Atlas fix the fail/high items").
2. Mid-turn, kill the SSE: throttle/offline the tab's network briefly (DevTools → Network → Offline for ~5s, then online), or reload the page.
3. Confirm: the turn **keeps running** (no "Stream disconnected"), the reconnected view rebuilds and shows the specialist + Sage output, and it ends with the persisted result.
4. Start another turn and click **Stop** — confirm it actually halts (check the server: the turn ends, `sessions.running_since` clears) rather than just detaching the view.

- [ ] **Step 7: Commit**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(turns): client reconnects + replays; Stop hits the abort endpoint"
```

---

### Task 7: Full green + finish the branch

- [ ] **Step 1: Whole suite + typecheck**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: PASS across the suite (existing 277 + new sse-stream and turn-broker tests).

- [ ] **Step 2: Finish**

Use superpowers:finishing-a-development-branch to merge the feature branch into `dev` (never straight to `main`). Release + Mini deploy happen afterward via the ship-mc-feature skill. No new deps, no DB migration → the Mini deploy skips `pnpm install` and `db:migrate`. Note the deploy restart itself kills any in-flight turn (unrelated to this change).

---

## Self-Review

**1. Spec coverage:**
- Turn-broker (controller/buffer/subscribers, startTurn/subscribe/abort/isRunning, retention, synthetic persisted) → Task 3. ✅
- Generalized stream-lifecycle (`startSseStream`) shared by companion + session → Tasks 1-2. ✅
- Reworked `/stream` route: startTurn + subscribe, no `req.signal` into the turn, heartbeat, closeOn → Task 4. ✅
- Explicit `POST /stop` → Task 5. ✅
- Client: onopen reset/replay-rebuild, onerror reconnect (≤5) then surface, Stop → endpoint, terminal handling → Task 6. ✅
- Edge cases: idempotent double-start (Task 3 test), finished-while-away (retention + synthetic persisted, Task 3 test), skipped/error terminal (Task 4 closeOn + Task 6). ✅
- Non-goal (deploy-restart survival) → noted, not implemented. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. The one conditional in Task 6 Step 1 (`activeSessionId` vs `session.id`) gives an exact resolution rule (match the EventSource URL identifier), not a vague instruction. ✅

**3. Type consistency:** `SseEvent`/`BrokerEvent` share `{ type: string; [k: string]: unknown }` (structurally assignable where the route wires `subscribe(sessionId, emit)`); `startSseStream`'s `subscribe: (emit, close) => () => void` matches both the companion adapter (Task 2) and the route (Task 4); `startTurn(sessionId, run, opts?)` / `subscribe` / `abort` signatures match their call sites in Tasks 4-5; `HEARTBEAT_MS`/`RETENTION_MS` are the spec's values. ✅
