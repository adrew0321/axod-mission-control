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

test('targetFromParam recognises host, room, and defaults to laptop', () => {
  assert.equal(targetFromParam('host'), 'host');
  assert.equal(targetFromParam('room'), 'room');
  assert.equal(targetFromParam('laptop'), 'laptop');
  assert.equal(targetFromParam(null), 'laptop');
  assert.equal(targetFromParam('HOST'), 'laptop', 'exact match only');
});
