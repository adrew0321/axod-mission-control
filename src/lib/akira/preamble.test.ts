import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soulLessonsPreamble } from './preamble';

test('preamble leads with SOUL then LESSONS', () => {
  const out = soulLessonsPreamble('I am AKIRA.', '### Terse\nKeep it short.');
  assert.ok(out.indexOf('## SOUL') < out.indexOf('## LESSONS'));
  assert.ok(out.includes('I am AKIRA.'));
  assert.ok(out.includes('Keep it short.'));
});

test('empty lessons render a clean placeholder', () => {
  const out = soulLessonsPreamble('I am AKIRA.', '');
  assert.ok(out.includes('## LESSONS'));
  assert.match(out, /none yet/i);
});
