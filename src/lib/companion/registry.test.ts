import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerCompanion, isOnline, sendCommand, resolveResult } from './registry';

test('offline send rejects', async () => {
  await assert.rejects(() => sendCommand({ action: 'read' }).result, /offline/i);
});

test('round-trips a command to a result by id', async () => {
  const seen: { id: string }[] = [];
  const unreg = registerCompanion({ send: (c) => seen.push(c) });
  assert.equal(isOnline(), true);
  const { id, result } = sendCommand({ action: 'read' });
  assert.equal(seen[0].id, id);
  resolveResult({ id, status: 'ok', text: 'done' });
  assert.equal((await result).text, 'done');
  unreg();
  assert.equal(isOnline(), false);
});

test('times out when no result arrives', async () => {
  const unreg = registerCompanion({ send: () => {} });
  const { result } = sendCommand({ action: 'read' }, 30); // 30ms timeout
  await assert.rejects(() => result, /timeout/i);
  unreg();
});
