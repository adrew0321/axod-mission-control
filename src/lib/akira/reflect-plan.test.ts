import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLessonReplace, type LessonNote } from './reflect-plan';

const note = (slug: string, body: string): LessonNote => ({ slug, title: slug, description: slug, body });

test('identical sets → null (no-op, no git churn)', () => {
  const cur = [note('terse-briefs', 'keep briefs short')];
  const dist = [{ title: 'terse-briefs', description: 'terse-briefs', body: 'keep briefs short' }];
  assert.equal(planLessonReplace(cur, dist), null);
});

test('a merged/dropped lesson produces a delete', () => {
  const cur = [note('a', 'x'), note('b', 'y')];
  const dist = [{ title: 'a', description: 'a', body: 'x' }]; // b dropped
  const ops = planLessonReplace(cur, dist)!;
  assert.deepEqual(ops.deletes, ['b']);
  assert.equal(ops.writes.length, 0);
});

test('a new/changed lesson produces a write', () => {
  const cur = [note('a', 'old')];
  const dist = [{ title: 'a', description: 'a', body: 'new' }, { title: 'c', description: 'c', body: 'z' }];
  const ops = planLessonReplace(cur, dist)!;
  assert.equal(ops.deletes.length, 0);
  assert.deepEqual(ops.writes.map((w) => w.title).sort(), ['a', 'c']);
});

test('SAFETY FLOOR: empty distilled + non-empty current → null (never wipe all)', () => {
  assert.equal(planLessonReplace([note('a', 'x')], []), null);
});

test('empty current + new distilled → all writes', () => {
  const ops = planLessonReplace([], [{ title: 'a', description: 'a', body: 'x' }])!;
  assert.equal(ops.writes.length, 1);
  assert.equal(ops.deletes.length, 0);
});
