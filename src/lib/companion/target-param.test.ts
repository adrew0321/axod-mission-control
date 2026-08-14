import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetFromParam } from './target-param';

test('room is recognised', () => {
  assert.equal(targetFromParam('room'), 'room');
});

test('an absent target defaults to laptop (back-compat)', () => {
  assert.equal(targetFromParam(null), 'laptop');
});

test('an unknown target falls back to laptop rather than throwing', () => {
  assert.equal(targetFromParam('mainframe'), 'laptop');
});
