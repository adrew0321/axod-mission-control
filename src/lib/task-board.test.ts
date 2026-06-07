import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBoard, buildTaskPrompt, type TaskRow, type BoardSessionRow } from './task-board';

const D = (s: string) => new Date(s);

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 't1', project_id: 'p1', title: 'A task', description: null,
    status: 'todo', session_id: null,
    created_at: D('2026-06-07T00:00:00Z'), updated_at: D('2026-06-07T00:00:00Z'),
    ...over,
  };
}
function sess(over: Partial<BoardSessionRow>): BoardSessionRow {
  return {
    id: 's1', title: 'A session', status: 'active', project_id: 'p1',
    projectName: 'Proj', updated_at: D('2026-06-07T00:00:00Z'), hasActivity: true,
    ...over,
  };
}

test('a todo task lands in the todo column as a manual card', () => {
  const b = composeBoard([task({ status: 'todo' })], [], 'Proj');
  assert.equal(b.todo.length, 1);
  assert.equal(b.todo[0].origin, 'manual');
  assert.equal(b.todo[0].column, 'todo');
  assert.equal(b.todo[0].ts, '2026-06-07T00:00:00.000Z');
});

test('an in_progress task with no finished session is not ready', () => {
  const b = composeBoard([task({ id: 't2', status: 'in_progress', session_id: 's9' })],
    [sess({ id: 's9', status: 'active' })], 'Proj');
  assert.equal(b.in_progress.length, 1);
  assert.notEqual(b.in_progress[0].ready, true);
});

test('an in_progress task whose session is done is ready for review', () => {
  const b = composeBoard([task({ id: 't3', status: 'in_progress', session_id: 's8' })],
    [sess({ id: 's8', status: 'done' })], 'Proj');
  assert.equal(b.in_progress[0].ready, true);
});

test('a done task lands in the done column', () => {
  const b = composeBoard([task({ id: 't4', status: 'done' })], [], 'Proj');
  assert.equal(b.done.length, 1);
});

test('an unlinked finished session becomes an auto done card', () => {
  const b = composeBoard([], [sess({ id: 'sa', status: 'done' })], 'Proj');
  assert.equal(b.done.length, 1);
  assert.equal(b.done[0].origin, 'auto');
  assert.equal(b.done[0].sessionId, 'sa');
});

test('an unlinked active session with activity becomes an auto in_progress card', () => {
  const b = composeBoard([], [sess({ id: 'sb', status: 'active', hasActivity: true })], 'Proj');
  assert.equal(b.in_progress.length, 1);
  assert.equal(b.in_progress[0].origin, 'auto');
});

test('an idle active session (no activity) is not shown', () => {
  const b = composeBoard([], [sess({ id: 'sc', status: 'active', hasActivity: false })], 'Proj');
  assert.equal(b.in_progress.length, 0);
});

test('a session linked to a manual task is not also an auto card', () => {
  const b = composeBoard(
    [task({ id: 't5', status: 'in_progress', session_id: 'sd' })],
    [sess({ id: 'sd', status: 'active', hasActivity: true })],
    'Proj',
  );
  assert.equal(b.in_progress.length, 1);
  assert.equal(b.in_progress[0].origin, 'manual');
});

test('auto cards never land in the todo column', () => {
  const b = composeBoard([], [
    sess({ id: 'se', status: 'active', hasActivity: true }),
    sess({ id: 'sf', status: 'done' }),
  ], 'Proj');
  assert.equal(b.todo.length, 0);
});

test('buildTaskPrompt appends description when present', () => {
  assert.equal(buildTaskPrompt({ title: 'Do X' }), 'Do X');
  assert.equal(buildTaskPrompt({ title: 'Do X', description: 'with care' }), 'Do X\n\nwith care');
  assert.equal(buildTaskPrompt({ title: '  Do X  ', description: '   ' }), 'Do X');
});
