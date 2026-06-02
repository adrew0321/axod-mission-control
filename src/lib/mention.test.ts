import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMention } from './mention';

const AGENTS = [
  { id: 'sage', name: 'Sage' },
  { id: 'atlas', name: 'Atlas' },
  { id: 'echo', name: 'Echo' },
];

test('matches @id case-insensitively and strips the mention', () => {
  assert.deepEqual(parseMention('@Atlas dial it down', AGENTS), { agentId: 'atlas', text: 'dial it down' });
  assert.deepEqual(parseMention('@atlas go', AGENTS), { agentId: 'atlas', text: 'go' });
  assert.deepEqual(parseMention('@ECHO review', AGENTS), { agentId: 'echo', text: 'review' });
});

test('matches by first word of the name', () => {
  const agents = [{ id: 'echo', name: 'Echo Critic' }];
  assert.equal(parseMention('@Echo look', agents).agentId, 'echo');
});

test('no mention → null, text unchanged', () => {
  assert.deepEqual(parseMention('just do the thing', AGENTS), { agentId: null, text: 'just do the thing' });
});

test('mention must be leading', () => {
  assert.equal(parseMention('do it @Atlas now', AGENTS).agentId, null);
});

test('unrecognized @ → null, text unchanged (goes verbatim to Sage)', () => {
  assert.deepEqual(parseMention('@nobody hi', AGENTS), { agentId: null, text: '@nobody hi' });
});

test('bare @ → null', () => {
  assert.equal(parseMention('@ hi', AGENTS).agentId, null);
});

test('mention with no task → empty text', () => {
  assert.deepEqual(parseMention('@Atlas', AGENTS), { agentId: 'atlas', text: '' });
});
