import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNewActions, type ActionLite } from './action-feed-diff';

const row = (id: string, atMs: number): ActionLite => ({
  id, atMs, target: 'host', event: 'result', command: `cmd-${id}`,
  cwd: null, exitCode: 0, status: 'ok', reason: null,
});

test('a null cursor takes everything and advances to the newest', () => {
  const out = pickNewActions(null, [row('a', 100), row('b', 200)]);
  assert.deepEqual(out.newActions.map((a) => a.id), ['a', 'b']);
  assert.equal(out.next, 200);
});

test('only rows strictly newer than the cursor are new', () => {
  const out = pickNewActions(150, [row('a', 100), row('b', 200)]);
  assert.deepEqual(out.newActions.map((a) => a.id), ['b']);
  assert.equal(out.next, 200);
});

test('an empty batch leaves the cursor untouched', () => {
  assert.deepEqual(pickNewActions(150, []), { newActions: [], next: 150 });
});

test('a row exactly at the cursor is not re-posted', () => {
  const out = pickNewActions(200, [row('b', 200)]);
  assert.deepEqual(out.newActions, []);
  assert.equal(out.next, 200);
});
