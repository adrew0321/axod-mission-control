import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCompanionStream } from './stream-lifecycle';
import type { Command } from './protocol';

// A fake ReadableStream controller that mirrors the real one's key behavior:
// enqueue() AFTER close() throws (this is the ERR_INVALID_STATE we're fixing).
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
      close() {
        closed = true;
      },
    },
  };
}

// A deterministic timer stand-in — tick() fires every live interval once.
function fakeTimers() {
  let seq = 0;
  const cbs = new Map<number, () => void>();
  return {
    tick: () => {
      for (const cb of [...cbs.values()]) cb();
    },
    live: () => cbs.size,
    timers: {
      setInterval: (cb: () => void) => {
        const h = ++seq;
        cbs.set(h, cb);
        return h;
      },
      clearInterval: (h: unknown) => {
        cbs.delete(h as number);
      },
    },
  };
}

test('heartbeat enqueues pings while the stream is open', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  startCompanionStream({
    controller: fc.ctrl,
    register: () => () => {},
    signal: { addEventListener() {} },
    timers: ft.timers,
  });
  ft.tick();
  assert.ok(fc.chunks.some((c) => c.includes('ping')));
});

// THE REGRESSION: registry displacement (a new companion connects) calls the old
// sink's close(). The heartbeat MUST stop — otherwise the next tick enqueues on a
// closed controller and throws ERR_INVALID_STATE (the uncaughtException in prod).
test('registry displacement stops the heartbeat — no enqueue after close', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let sink: { send: (c: Command) => void; close: () => void } | undefined;
  startCompanionStream({
    controller: fc.ctrl,
    register: (s) => {
      sink = s;
      return () => {};
    },
    signal: { addEventListener() {} },
    timers: ft.timers,
  });

  sink!.close(); // registry displaces this companion
  assert.equal(fc.isClosed(), true);
  assert.equal(ft.live(), 0, 'heartbeat interval must be cleared on displacement');
  assert.doesNotThrow(() => ft.tick(), 'a tick after close must not enqueue/throw');
});

test('client abort tears down exactly once and stops the heartbeat', () => {
  const fc = fakeController();
  const ft = fakeTimers();
  let abortCb: (() => void) | undefined;
  let unregistered = 0;
  startCompanionStream({
    controller: fc.ctrl,
    register: () => () => {
      unregistered++;
    },
    signal: { addEventListener: (_t, cb) => { abortCb = cb; } },
    timers: ft.timers,
  });

  abortCb!();
  abortCb!(); // idempotent — a second abort must not double-unregister or throw
  assert.equal(fc.isClosed(), true);
  assert.equal(unregistered, 1);
  assert.equal(ft.live(), 0);
  assert.doesNotThrow(() => ft.tick());
});
