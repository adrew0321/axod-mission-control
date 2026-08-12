import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onShutdown, runShutdown, resetShutdown } from './shutdown';

test('runs disposers in registration order and reports success', async () => {
  resetShutdown();
  const order: string[] = [];
  onShutdown('a', () => { order.push('a'); });
  onShutdown('b', async () => { order.push('b'); });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.deepEqual(order, ['a', 'b']);
  assert.equal(report.ran, true);
  assert.deepEqual(report.results.map((r) => r.name), ['a', 'b']);
  assert.ok(report.results.every((r) => r.ok));
});

test('is idempotent: a second call returns the same report without re-running', async () => {
  resetShutdown();
  let calls = 0;
  onShutdown('once', () => { calls++; });

  const first = await runShutdown({ timeoutMs: 1000 });
  const second = await runShutdown({ timeoutMs: 1000 });

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test('a throwing disposer is recorded but does not block the rest', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('boom', () => { throw new Error('nope'); });
  onShutdown('after', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.equal(reached, true);
  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].error, 'nope');
  assert.equal(report.results[1].ok, true);
});

test('a hanging disposer is bounded by its budget and the next one still runs', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('hang', () => new Promise<void>(() => {}), 20);
  onShutdown('after', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 1000 });

  assert.equal(report.results[0].timedOut, true);
  assert.equal(report.results[0].ok, false);
  assert.equal(reached, true);
});

test('disposers registered after the total budget is spent are marked timedOut', async () => {
  resetShutdown();
  let reached = false;
  onShutdown('slow', () => new Promise<void>(() => {}), 50);
  onShutdown('never', () => { reached = true; });

  const report = await runShutdown({ timeoutMs: 30 });

  assert.equal(reached, false);
  assert.equal(report.results[1].timedOut, true);
});
