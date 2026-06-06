import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampTreeWidth, nextActiveProjectId } from './ui-helpers';

test('clampTreeWidth clamps to [160, 560] and defaults NaN', () => {
  assert.equal(clampTreeWidth(300), 300);
  assert.equal(clampTreeWidth(50), 160);
  assert.equal(clampTreeWidth(9999), 560);
  assert.equal(clampTreeWidth(Number.NaN), 260);
});

test('nextActiveProjectId: removing the active picks the first other project', () => {
  const P = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextActiveProjectId(P, 'a', 'a'), 'b');
  assert.equal(nextActiveProjectId(P, 'b', 'b'), 'a');
});

test('nextActiveProjectId: removing a non-active project leaves the active unchanged', () => {
  const P = [{ id: 'a' }, { id: 'b' }];
  assert.equal(nextActiveProjectId(P, 'b', 'a'), 'a');
});

test('nextActiveProjectId: removing the only project yields undefined', () => {
  assert.equal(nextActiveProjectId([{ id: 'a' }], 'a', 'a'), undefined);
});
