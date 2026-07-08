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
