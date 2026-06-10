import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMemory } from './memory';

test('skips system and empty messages; labels operator vs agent', () => {
  const out = summarizeMemory([
    { role: 'user', content: 'add a CI pipeline' },
    { role: 'system', content: 'Atlas requested tool permissions' },
    { role: 'agent', senderName: 'Forge', content: 'Reading the README…' },
    { role: 'agent', senderName: 'Forge', content: '   ' },
  ]);
  assert.equal(out.messageCount, 2);
  assert.deepEqual(out.blocks, [
    { label: 'Operator', content: 'add a CI pipeline' },
    { label: 'Forge', content: 'Reading the README…' },
  ]);
});

test('agent with no senderName falls back to Agent', () => {
  const out = summarizeMemory([{ role: 'agent', content: 'done' }]);
  assert.equal(out.blocks[0].label, 'Agent');
});

test('approxTokens is ceil(total trimmed chars / 4)', () => {
  // "abcd" (4) + "efghij" (6) = 10 chars → ceil(10/4) = 3
  const out = summarizeMemory([
    { role: 'user', content: ' abcd ' },
    { role: 'agent', senderName: 'X', content: 'efghij' },
  ]);
  assert.equal(out.approxTokens, 3);
});

test('empty input yields zeros', () => {
  assert.deepEqual(summarizeMemory([]), { blocks: [], messageCount: 0, approxTokens: 0 });
});
