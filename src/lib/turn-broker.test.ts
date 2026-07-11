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

test('a finished (retained) turn can be restarted before retention fires', async () => {
  const ft = fakeTimers();
  const d1 = deferredRun();
  assert.deepEqual(startTurn('r1', d1.run, { timers: ft.timers }), { started: true });
  d1.e()({ type: 'token', content: 'first' });
  d1.finish();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(isRunning('r1'), false); // finished; state retained, retention timer pending

  // Restart before retention fires → fresh turn (new buffer), and the OLD retention
  // timer must have been cleared so it can't delete the new running state.
  const d2 = deferredRun();
  assert.deepEqual(startTurn('r1', d2.run, { timers: ft.timers }), { started: true });
  assert.equal(isRunning('r1'), true);
  ft.fire(); // the old retention timer (if not cleared) would delete state here
  assert.equal(isRunning('r1'), true);

  // The restart started from an empty buffer — a new subscriber sees only new events.
  const got: string[] = [];
  subscribe('r1', (ev) => got.push(ev.type));
  d2.e()({ type: 'token', content: 'second' });
  assert.deepEqual(got, ['token']); // not the retained 'first' from the previous turn
  d2.finish();
});

test('a rejecting run still finishes: running flips false, then clears after retention', async () => {
  const ft = fakeTimers();
  startTurn('rj1', () => Promise.reject(new Error('boom')), { timers: ft.timers });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(isRunning('rj1'), false); // rejection routed to finish (the .then's 2nd arg)
  assert.equal(abort('rj1'), false);     // not running → abort is a no-op
  ft.fire();                             // retention timer → delete state
  const got: string[] = [];
  subscribe('rj1', (ev) => got.push(ev.type));
  assert.deepEqual(got, ['persisted']);  // state gone → synthetic persisted
});
