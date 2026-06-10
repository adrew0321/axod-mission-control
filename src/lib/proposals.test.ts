import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDiff } from './proposals';

test('counts added and removed content lines', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,2 +1,3 @@',
    ' unchanged',
    '-old line',
    '+new line one',
    '+new line two',
  ].join('\n');
  assert.deepEqual(summarizeDiff(diff), { additions: 2, deletions: 1 });
});

test('ignores +++/--- file headers', () => {
  const diff = '--- a/f\n+++ b/f\n+only real addition';
  assert.deepEqual(summarizeDiff(diff), { additions: 1, deletions: 0 });
});

test('empty diff is zero/zero', () => {
  assert.deepEqual(summarizeDiff(''), { additions: 0, deletions: 0 });
});
