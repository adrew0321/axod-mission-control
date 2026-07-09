# Turn Decoupling — Design (client-independent session turns)

**Status:** Approved design (2026-07-08).
**Feature:** Make a session's agent turn run to completion independently of the browser SSE connection that started it, so a dropped/idle/reconnecting connection no longer aborts the turn (the "Stream disconnected" mid-dispatch failure).

## Problem

A session turn currently runs *inside* the SSE request: `GET /api/sessions/[id]/stream` calls `runSessionTurn(id, { emit, signal: req.signal })`. Because the turn's abort is `req.signal`, **any** drop of that browser connection — Cloudflare tunnel idle-timeout (the stream has no heartbeat), a network blip, or navigating away — aborts the turn and any in-flight `dispatch_agent`. The client's `EventSource.onerror` then shows "Stream disconnected." Observed live: an operator asked Sage to dispatch Atlas three times because each turn's connection dropped before it completed.

`runSessionTurn` is already sink-agnostic (`emit` + optional `signal`), persists all messages to the DB as it runs, and is guarded by a cross-process lease on `sessions.running_since`. So the turn logic is ready to run headlessly — only the *route* couples it to the browser.

## Goal

Decouple the turn from the client connection: the turn runs as a background task; SSE clients merely *subscribe* to its event stream and can disconnect/reconnect freely; "Stop" becomes an explicit action. A reconnecting client catches up via event replay.

## Non-goals (explicitly out of scope)

- **Surviving a server restart/deploy.** The turn runs in the Next.js process; a `systemd` restart SIGKILLs the `claude` subprocess and the in-memory broker. That needs turn-resumption / a separate worker — a distinct, larger effort. Here, a restart kills the turn, the lease self-heals via its stale TTL, and a reconnecting client finds nothing running and refreshes from the DB.
- Multi-process / durable job queue (approach B). Overkill now.

## Hard constraints

- `runSessionTurn` signature and DB/lease behavior stay as-is; only *how it is invoked and aborted* changes.
- Reuse existing patterns: the companion registry (single-sink bus) and `stream-lifecycle.ts` (heartbeat + idempotent cleanup). Generalize the latter so companion and session streams share one heartbeat/cleanup helper rather than duplicating it.
- Never abort the turn on a passive client disconnect — only on the explicit Stop endpoint or the turn's own max-duration timeout.
- Extensionless relative imports; `node:`-only (no `server-only`) in the unit-tested broker so it runs under `tsx --test`.

## Architecture

```
POST /messages ── persists user msg
     │
     ▼
GET /stream ── broker.startTurn(id, run) ──(background)──> runSessionTurn(id, {emit: publish, signal: broker.signal})
     │                                                          │ publish → buffer + fan-out
     └── broker.subscribe(id, sseEmit) ◄── replay buffer + live events ──┘
            │  (heartbeat; client disconnect → unsubscribe only)
POST /stop ── broker.abort(id) → turn's signal aborts
```

### Component 1 — `src/lib/turn-broker.ts` (new, pure, unit-tested)

In-memory map `sessionId → TurnState`:

```ts
interface BrokerEvent { type: string; [k: string]: unknown }
interface TurnState {
  controller: AbortController;
  buffer: BrokerEvent[];
  subscribers: Set<(e: BrokerEvent) => void>;
  running: boolean;
  retentionTimer?: ReturnType<typeof setTimeout>;
}
```

API (timers injectable for tests):

- `startTurn(sessionId, run: (emit: (e: BrokerEvent) => void, signal: AbortSignal) => Promise<unknown>): { started: boolean }`
  - If a `TurnState` exists and `running`, return `{ started: false }` (idempotent — the caller then just subscribes).
  - Else (no state, or a retained *finished* state from a previous turn): if a retained state exists, clear its retention timer and discard it, then create fresh state (new `AbortController`, empty buffer, empty subscribers, `running: true`), and invoke `run(publish, controller.signal)` **without awaiting**. `publish(e)` appends to `buffer` and calls every subscriber (each in try/catch; a throwing subscriber is dropped).
  - When the `run` promise settles (resolve or reject), set `running = false` and start a retention timer (`RETENTION_MS`, default 30_000) that deletes the state. (Errors are surfaced by `runSessionTurn` itself via an `error`/`persisted` event; the broker does not synthesize them here.)
  - Returns `{ started: true }`.
- `subscribe(sessionId, emit): () => void`
  - If no state exists (no turn ran, or it was retained-then-cleared): emit a synthetic `{ type: 'persisted' }` and return a no-op unsubscribe — the client closes and refreshes from the DB.
  - Else: replay the current `buffer` to `emit` in order, add `emit` to `subscribers`, and return an unsubscribe that removes it. Unsubscribe **never** touches the controller.
- `abort(sessionId): boolean` — if a running state exists, `controller.abort()` and return true; else false.
- `isRunning(sessionId): boolean`.

Testable with a fake `run` (captures `emit`/`signal`) and injected timers.

### Component 2 — Generalize `src/lib/companion/stream-lifecycle.ts`

Extract the heartbeat + idempotent-cleanup core into a generic helper both streams use:

```ts
startSseStream({
  controller,               // ReadableStream controller
  subscribe,                // (emit) => unsubscribe  — bus/broker/registry subscription
  signal,                   // req.signal (abort → cleanup only)
  heartbeatMs?, timers?,
}): void
```

Cleanup (idempotent, on any of: `signal` abort, failed enqueue, explicit terminal) clears the heartbeat, calls `unsubscribe`, and closes the controller — the pattern already proven for the companion stream. The companion stream's `register`-based wiring becomes a thin adapter (`subscribe = (emit) => registerCompanion({ send: cmd => emit(sse(cmd)), close: ... })`) or keeps `startCompanionStream` layered on top. Session stream calls `startSseStream` with `subscribe = (emit) => broker.subscribe(id, brokerEvt => emit(sse(brokerEvt)))`.

When a terminal event (`persisted` or `error`) is emitted to a subscriber, the session route ends that client's stream cleanly (close controller) so the browser sees a clean finish rather than an error.

### Component 3 — Rework `GET /api/sessions/[id]/stream/route.ts`

Auth (session cookie) unchanged. Then:

```ts
broker.startTurn(sessionId, (emit, signal) => runSessionTurn(sessionId, { emit, signal }));
// build ReadableStream; in start(controller):
startSseStream({
  controller,
  signal: req.signal,
  subscribe: (emit) => broker.subscribe(sessionId, (e) => emit(sseEncode(e))),
});
```

The route no longer passes `req.signal` into `runSessionTurn`. `req.signal` now only tears down *this client's* subscription + heartbeat.

### Component 4 — `POST /api/sessions/[id]/stop/route.ts` (new)

Auth → `broker.abort(sessionId)` → `Response.json({ ok: true, aborted })`. (If a stop route already exists, fold this in; otherwise add it.) The Stop button in `mission-control.tsx` calls this endpoint instead of only closing the EventSource.

### Component 5 — Client (`src/components/mission-control.tsx`)

Because the turn outlives the connection:

- **`es.onopen`:** reset this turn's live streaming bubbles (Sage/specialist) to empty. Every (re)connect starts from the broker's replayed buffer, so reset-then-rebuild is deterministic and idempotent across reconnects.
- **`es.onmessage`:** unchanged event handling; it now naturally processes the replayed buffer followed by live events.
- **`es.onerror`:** do **not** immediately declare failure. Attempt reconnect with backoff (reopen the `EventSource`; or rely on EventSource's built-in retry by not calling `es.close()`), showing a soft "reconnecting…" only. After N consecutive failed reconnects (default 5), surface "Stream disconnected" as today.
- **`persisted`:** close the stream, `router.refresh()` (unchanged).
- **Stop button:** `POST /api/sessions/[id]/stop`, then close the EventSource locally.

## Error handling

- Turn error → `runSessionTurn` emits `error` then finishes; broker fans it out; clients render it and the route closes cleanly; lease released in `runSessionTurn`'s `finally`.
- Subscriber throw on publish → caught, subscriber dropped.
- Heartbeat/enqueue on a closed controller → idempotent cleanup (existing pattern).
- Turn finishes while no client connected → buffer retained `RETENTION_MS`; a reconnect within the window sees the buffered `persisted`; after it, `subscribe` synthesizes `persisted` → client refreshes from DB.

## Testing

- **`turn-broker.test.ts` (pure, `tsx --test`):** startTurn idempotency (second start while running → `{started:false}`, turn runs once); subscribe replays the full buffer to a new subscriber; a second subscriber also gets the replay; publish fans out to all; unsubscribe does not abort the controller; `abort` aborts the signal passed to `run`; on `run` settling, `running` flips false and the state is cleared after the retention timer; `subscribe` to an unknown session emits a synthetic `persisted`.
- **stream-lifecycle:** existing tests carry over; add a case for the generic `startSseStream` subscribe/unsubscribe/heartbeat-cleanup.
- **Route / Stop / client:** server-only + React → verified by manual E2E (drive a real dispatch, drop the connection mid-turn, confirm the turn completes and the reconnected client shows the result; hit Stop and confirm it aborts). Matches this repo's convention (routes/UI aren't unit-tested).

## Rollout

Code-only; no DB migration, no new deps. Ships via the ship-mc-feature release + Mini deploy. Note the deploy itself will (as always) kill any in-flight turn on restart — unrelated to this change.
