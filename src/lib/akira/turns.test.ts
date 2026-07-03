import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTurns, type MessageRow } from './turns';

const row = (p: Partial<MessageRow>): MessageRow => ({
  role: 'user',
  content: 'hello',
  created_at: new Date(1000),
  ...p,
});

test('maps rows to turns, oldest-first, mapping roles to you/akira', () => {
  const turns = toTurns([
    row({ role: 'user', content: 'hi', created_at: new Date(1000) }),
    row({ role: 'agent', content: 'hello there', created_at: new Date(2000) }),
  ]);
  assert.deepEqual(turns, [
    { role: 'you', content: 'hi', at: 1000 },
    { role: 'akira', content: 'hello there', at: 2000 },
  ]);
});

test('sorts by created_at ascending even if input is unsorted', () => {
  const turns = toTurns([
    row({ role: 'agent', content: 'second', created_at: new Date(2000) }),
    row({ role: 'user', content: 'first', created_at: new Date(1000) }),
  ]);
  assert.deepEqual(turns.map((t) => t.content), ['first', 'second']);
});

test('drops synthetic user messages (brief instruction, gate-approval)', () => {
  const turns = toTurns([
    row({ role: 'user', content: 'Brief the operator on the current fleet state.', created_at: new Date(1000) }),
    row({ role: 'agent', content: 'Here is your brief.', created_at: new Date(2000) }),
    row({ role: 'user', content: 'I approved the gated action — continue.', created_at: new Date(3000) }),
    row({ role: 'user', content: 'what about obsidian memory?', created_at: new Date(4000) }),
  ]);
  assert.deepEqual(turns.map((t) => t.content), ['Here is your brief.', 'what about obsidian memory?']);
});

test('drops the attachment wrapper but keeps the real question text', () => {
  const withFiles =
    'read this please\n\n[Attached files — open them with your Read tool:\n- /tmp/x.png]';
  const turns = toTurns([row({ role: 'user', content: withFiles, created_at: new Date(1000) })]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].content, 'read this please');
});

test('skips empty/blank message rows', () => {
  const turns = toTurns([
    row({ role: 'user', content: '   ', created_at: new Date(1000) }),
    row({ role: 'agent', content: 'real', created_at: new Date(2000) }),
  ]);
  assert.deepEqual(turns.map((t) => t.content), ['real']);
});
