// Lifecycle for the companion SSE stream: register the sink, heartbeat, and tear
// down EXACTLY ONCE from any close path — client abort, registry displacement (a
// new companion connecting closes the old sink), or a failed enqueue. This is the
// fix for the leaked heartbeat interval that fired controller.enqueue() on an
// already-closed controller (uncaught ERR_INVALID_STATE, once per orphaned stream).
// Pure (only ./protocol types) so it is unit-tested with a fake controller/timers.
import type { Command } from './protocol';

export interface StreamLike {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
}
export interface AbortLike {
  addEventListener: (type: 'abort', cb: () => void) => void;
}
export interface Timers {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const encoder = new TextEncoder();
function sse(event: { type: string; [k: string]: unknown }): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export const HEARTBEAT_MS = 15_000;

export function startCompanionStream(opts: {
  controller: StreamLike;
  register: (sink: { send: (cmd: Command) => void; close: () => void }) => () => void;
  signal: AbortLike;
  heartbeatMs?: number;
  timers?: Timers;
}): void {
  const { controller, register, signal } = opts;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const timers: Timers = opts.timers ?? {
    setInterval: (cb, ms) => setInterval(cb, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };

  let closed = false;
  let hb: unknown;
  let unregister: () => void = () => {};

  const cleanup = () => {
    if (closed) return; // idempotent — any path can call this, only the first wins
    closed = true;
    if (hb !== undefined) timers.clearInterval(hb);
    unregister();
    try {
      controller.close();
    } catch {
      /* already closed */
    }
  };

  const safeEnqueue = (chunk: Uint8Array) => {
    if (closed) return;
    try {
      controller.enqueue(chunk);
    } catch {
      cleanup(); // controller closed out from under us — stop everything
    }
  };

  unregister = register({
    send: (cmd) => safeEnqueue(sse({ type: 'command', cmd })),
    close: cleanup, // registry displacement tears this stream down cleanly
  });

  // heartbeat so the laptop (and any proxy) keeps the stream alive
  hb = timers.setInterval(() => safeEnqueue(sse({ type: 'ping' })), heartbeatMs);
  signal.addEventListener('abort', cleanup);
}
