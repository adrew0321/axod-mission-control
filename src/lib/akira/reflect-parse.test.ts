import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReflection } from './reflect-parse';

test('parses a clean object', () => {
  const out = parseReflection(JSON.stringify({
    lessons: [{ title: 'Terse briefs', description: 'prefers terse', body: 'Keep briefs to 2 sentences.' }],
    soulProposal: { text: 'I am AKIRA, warmer and terser.', reason: 'he values brevity' },
  }));
  assert.equal(out.lessons.length, 1);
  assert.equal(out.lessons[0].title, 'Terse briefs');
  assert.equal(out.soulProposal?.reason, 'he values brevity');
});

test('parses inside a ```json fence', () => {
  const out = parseReflection('```json\n{ "lessons": [], "soulProposal": null }\n```');
  assert.deepEqual(out, { lessons: [], soulProposal: null });
});

test('missing/absent soulProposal → null', () => {
  assert.equal(parseReflection('{ "lessons": [] }').soulProposal, null);
  assert.equal(parseReflection('{ "lessons": [], "soulProposal": {} }').soulProposal, null); // no text
});

test('drops malformed lesson entries', () => {
  const out = parseReflection(JSON.stringify({ lessons: [{ title: 'ok', description: 'd', body: 'b' }, { title: 'x' }] }));
  assert.equal(out.lessons.length, 1);
});

test('garbage → safe empty default', () => {
  assert.deepEqual(parseReflection('not json at all'), { lessons: [], soulProposal: null });
});
