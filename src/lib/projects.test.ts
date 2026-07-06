import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveActiveProject,
  slugifyProjectId,
  validateNewProjectInput,
  pickProjectId,
} from './projects';

const P = [{ id: 'axod-creative' }, { id: 'mission-control' }];

test('resolveActiveProject prefers the cookie project when it exists', () => {
  assert.equal(resolveActiveProject(P, 'mission-control', 'axod-creative')?.id, 'mission-control');
});

test('resolveActiveProject falls back to the recent-session project, then the first', () => {
  assert.equal(resolveActiveProject(P, undefined, 'mission-control')?.id, 'mission-control');
  assert.equal(resolveActiveProject(P, 'nope', undefined)?.id, 'axod-creative');
  assert.equal(resolveActiveProject(P, undefined, 'gone')?.id, 'axod-creative');
});

test('resolveActiveProject returns undefined when there are no projects', () => {
  assert.equal(resolveActiveProject([], 'x', 'y'), undefined);
});

test('slugifyProjectId lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugifyProjectId('AXOD Creative'), 'axod-creative');
  assert.equal(slugifyProjectId('  My_Repo!! 2  '), 'my-repo-2');
});

test('validateNewProjectInput requires name and repoPath', () => {
  assert.deepEqual(validateNewProjectInput({ name: 'X', repoPath: '/p' }), { ok: true });
  assert.equal(validateNewProjectInput({ name: '', repoPath: '/p' }).ok, false);
  assert.equal(validateNewProjectInput({ name: 'X', repoPath: '  ' }).ok, false);
});

test('pickProjectId slugifies the name when unused', () => {
  assert.equal(pickProjectId('Applications.Employer', []), 'applications-employer');
});

test('pickProjectId appends -2, -3 on collision', () => {
  const taken = ['applications-employer'];
  assert.equal(pickProjectId('Applications.Employer', taken), 'applications-employer-2');
  assert.equal(pickProjectId('Applications.Employer', ['applications-employer', 'applications-employer-2']), 'applications-employer-3');
});

test('pickProjectId falls back to "project" for an empty slug', () => {
  assert.equal(pickProjectId('...', []), 'project');
});
