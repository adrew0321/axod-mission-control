import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSerialQueue } from './serial';

// Flush pending microtasks + one macrotask turn — deterministic regardless of
// machine load (no reliance on how long a task "takes").
const tick = () => new Promise((r) => setTimeout(r, 0));

test('runs enqueued tasks strictly one-at-a-time, in order', async () => {
  const q = createSerialQueue();
  const started: string[] = [];
  const release: Record<string, () => void> = {};
  // Each task announces it started, then blocks until we release it — so a later
  // task can only have started if the earlier one already finished.
  const gated = (id: string) => () =>
    new Promise<void>((resolve) => {
      started.push(id);
      release[id] = resolve;
    });

  q(gated('a'));
  q(gated('b'));
  q(gated('c'));

  await tick();
  assert.deepEqual(started, ['a']); // only one runs at a time — b/c are waiting

  release['a']();
  await tick();
  assert.deepEqual(started, ['a', 'b']); // b started only after a finished

  release['b']();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']); // and in order

  release['c']();
  await tick();
});

test('a failing task does not stall the queue', async () => {
  const q = createSerialQueue();
  const log: string[] = [];
  q(() => Promise.reject(new Error('boom')));
  q(async () => {
    log.push('after');
  });
  await tick();
  await tick();
  assert.deepEqual(log, ['after']);
});
