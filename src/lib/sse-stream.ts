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
