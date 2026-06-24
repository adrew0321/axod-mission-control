import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkReply } from './discord-format';

test('short text → single chunk', () => {
  assert.deepEqual(chunkReply('hello'), ['hello']);
});

test('empty/whitespace text → single placeholder space (never empty)', () => {
  const out = chunkReply('');
  assert.equal(out.length, 1);
});

test('splits on newline boundaries under the max', () => {
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10);
  const out = chunkReply(text, 12);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.length <= 12));
  assert.equal(out.join('\n').replace(/\n/g, ''), 'a'.repeat(10) + 'b'.repeat(10));
});

test('hard-splits a single token longer than max', () => {
  const out = chunkReply('x'.repeat(25), 10);
  assert.ok(out.every((c) => c.length <= 10));
  assert.equal(out.join(''), 'x'.repeat(25));
});

test('every chunk respects the max for realistic mixed text', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n');
  const out = chunkReply(text, 200);
  assert.ok(out.length > 1);
  assert.ok(out.every((c) => c.length <= 200));
});
