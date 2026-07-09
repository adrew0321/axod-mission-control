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
