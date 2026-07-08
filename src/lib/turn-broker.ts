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
  setTimeout: (cb, ms) => {
    const t = setTimeout(cb, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
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
