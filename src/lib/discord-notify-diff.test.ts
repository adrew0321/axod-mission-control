import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScheduleRuns, pickNewDreams, diffProposals } from './discord-notify-diff';

const sched = (id: string, lastRunAtMs: number | null, lastStatus: string | null = 'ok') =>
  ({ id, projectId: 'p', title: 't', lastRunAtMs, lastStatus });

test('diffScheduleRuns: advanced last_run_at is new; unchanged is not', () => {
  const prev = new Map([['a', 100]]);
  const { newRuns, next } = diffScheduleRuns(prev, [sched('a', 200), sched('b', 50)]);
  assert.deepEqual(newRuns.map((r) => r.id).sort(), ['a', 'b']); // a advanced, b is brand new
  assert.equal(next.get('a'), 200);
  assert.equal(next.get('b'), 50);

  const second = diffScheduleRuns(next, [sched('a', 200), sched('b', 50)]);
  assert.deepEqual(second.newRuns, []); // nothing advanced
});

test('diffScheduleRuns: null last_run_at (never ran) is never new and not in next', () => {
  const { newRuns, next } = diffScheduleRuns(new Map(), [sched('a', null)]);
  assert.deepEqual(newRuns, []);
  assert.equal(next.has('a'), false);
});

test('pickNewDreams: new since cursor; none when stale', () => {
  const rows = [
    { id: 'd2', createdAtMs: 200, status: 'ok', insightCount: 3 },
    { id: 'd1', createdAtMs: 100, status: 'ok', insightCount: 1 },
  ];
  const a = pickNewDreams(150, rows);
  assert.deepEqual(a.newDreams.map((d) => d.id), ['d2']);
  assert.equal(a.next, 200);

  const b = pickNewDreams(200, rows);
  assert.deepEqual(b.newDreams, []);
  assert.equal(b.next, 200);
});

test('pickNewDreams: null cursor treats all as new (loop discards on prime)', () => {
  const rows = [{ id: 'd1', createdAtMs: 100, status: 'ok', insightCount: 0 }];
  const r = pickNewDreams(null, rows);
  assert.deepEqual(r.newDreams.map((d) => d.id), ['d1']);
  assert.equal(r.next, 100);
});

test('diffProposals: new id fires; merged-then-reappearing re-fires', () => {
  const a = diffProposals(new Set(), new Set(['s1']));
  assert.deepEqual(a.newIds, ['s1']);
  assert.deepEqual([...a.next], ['s1']);

  const b = diffProposals(new Set(['s1']), new Set(['s1'])); // still present, not new
  assert.deepEqual(b.newIds, []);

  const c = diffProposals(new Set(['s1']), new Set()); // merged/discarded — gone
  assert.deepEqual(c.newIds, []);
  assert.deepEqual([...c.next], []);

  const d = diffProposals(new Set(), new Set(['s1'])); // reappears → fires again
  assert.deepEqual(d.newIds, ['s1']);
});
