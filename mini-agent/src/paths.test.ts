import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validatePath, type Roots } from './paths';

const ROOTS: Roots = { room: '/home/akira/workshop', doorway: '/mnt/doorway' };

test('accepts a relative path inside the room', () => {
  const v = validatePath(ROOTS, 'notes/today.md');
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.abs, resolve(ROOTS.room, 'notes/today.md'));
});

test('accepts the room root itself', () => {
  assert.equal(validatePath(ROOTS, '.').ok, true);
});

test('accepts an absolute path inside the doorway', () => {
  const v = validatePath(ROOTS, '/mnt/doorway/inbox/resume.docx');
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.abs, resolve('/mnt/doorway/inbox/resume.docx'));
});

test('rejects traversal out of the room', () => {
  const v = validatePath(ROOTS, '../../etc/passwd');
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : '', /outside/i);
});

test('rejects an absolute path outside both roots', () => {
  assert.equal(validatePath(ROOTS, '/etc/passwd').ok, false);
});

test('rejects reaching production', () => {
  // The room must never be able to name prod's database.
  assert.equal(validatePath(ROOTS, '/srv/mission-control/data/mission-control.db').ok, false);
});

test('rejects a sibling directory sharing the root prefix', () => {
  // Classic startsWith bug: /home/akira/workshop-evil must NOT count as inside
  // /home/akira/workshop.
  assert.equal(validatePath(ROOTS, '/home/akira/workshop-evil/x').ok, false);
});

test('rejects an empty path', () => {
  assert.equal(validatePath(ROOTS, '').ok, false);
});

test('rejects a null byte', () => {
  assert.equal(validatePath(ROOTS, 'ok\0/../../etc/passwd').ok, false);
});
