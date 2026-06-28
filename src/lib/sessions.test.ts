import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitBranches,
  resolveActiveSession,
  sessionTitleOrDefault,
  validateNewSessionInput,
} from './sessions';

test('parseGitBranches: dedups local+remote, default first, drops HEAD/detached', () => {
  const raw = ['dev', 'main', 'feature/x', 'origin/dev', 'origin/main', 'origin/feature/x', 'origin/HEAD -> origin/main', '(HEAD detached at abc123)'].join('\n');
  const out = parseGitBranches(raw, 'dev');
  assert.deepEqual(out, ['dev', 'main', 'feature/x']);
});

test('parseGitBranches: default is first even if listed later, and is added if missing', () => {
  assert.deepEqual(parseGitBranches('main\nfeature/y', 'dev'), ['dev', 'main', 'feature/y']);
  assert.deepEqual(parseGitBranches('main\ndev', 'dev'), ['dev', 'main']);
});

test('resolveActiveSession: valid active id is used', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: 's1', existingIds: ['s1', 's2'], newestId: 's2' }),
    { kind: 'use', id: 's1' },
  );
});

test('resolveActiveSession: stale active id falls back to newest', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: 'gone', existingIds: ['s1', 's2'], newestId: 's2' }),
    { kind: 'use', id: 's2' },
  );
});

test('resolveActiveSession: no sessions => create', () => {
  assert.deepEqual(
    resolveActiveSession({ activeId: null, existingIds: [], newestId: null }),
    { kind: 'create' },
  );
});

test('sessionTitleOrDefault: trims, falls back', () => {
  assert.equal(sessionTitleOrDefault('  Hi  '), 'Hi');
  assert.equal(sessionTitleOrDefault(''), 'New session');
  assert.equal(sessionTitleOrDefault(null), 'New session');
});

test('validateNewSessionInput: base branch must be allowed when provided', () => {
  assert.deepEqual(validateNewSessionInput({ baseBranch: 'dev' }, ['dev', 'main']), { ok: true });
  assert.deepEqual(validateNewSessionInput({}, ['dev']), { ok: true }); // omitted is fine (defaults later)
  assert.equal(validateNewSessionInput({ baseBranch: 'nope' }, ['dev', 'main']).ok, false);
});
