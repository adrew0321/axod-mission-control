import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateQueue, type PendingGate } from './gate-queue';

const gate = (p: Partial<PendingGate>): PendingGate => ({
  id: 'c1', reason: 'irreversible', target: 'Place order', host: 'amazon.com', requestedAt: 1000, ...p,
});

test('enqueue then list returns queued gates in order', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.deepEqual(q.list().map((g) => g.id), ['a', 'b']);
});

test('list returns a copy (mutating it does not affect the queue)', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.list().pop();
  assert.equal(q.list().length, 1);
});

test('remove pulls the gate out and returns it; unknown id returns undefined', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.equal(q.remove('a')?.id, 'a');
  assert.deepEqual(q.list().map((g) => g.id), ['b']);
  assert.equal(q.remove('nope'), undefined);
});

test('expired returns only gates older than the timeout', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'old', requestedAt: 1000 }));
  q.enqueue(gate({ id: 'new', requestedAt: 9000 }));
  const exp = q.expired(11000, 5000); // now=11000, timeout=5000 → cutoff 6000
  assert.deepEqual(exp.map((g) => g.id), ['old']);
});

test('clear empties the queue and returns everything that was in it', () => {
  const q = createGateQueue();
  q.enqueue(gate({ id: 'a' }));
  q.enqueue(gate({ id: 'b' }));
  assert.deepEqual(q.clear().map((g) => g.id), ['a', 'b']);
  assert.equal(q.list().length, 0);
});
