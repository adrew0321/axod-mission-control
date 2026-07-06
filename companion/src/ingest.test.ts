import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveIngestMeta, isGitRepo, createBundle } from './ingest';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('deriveIngestMeta uses the folder basename and the head branch', () => {
  assert.deepEqual(deriveIngestMeta('C:/TEI/Applications.Employer', 'develop'), {
    name: 'Applications.Employer',
    branch: 'develop',
  });
});

test('deriveIngestMeta defaults an empty branch to main', () => {
  assert.deepEqual(deriveIngestMeta('/home/a/TEI/App', ''), { name: 'App', branch: 'main' });
});

test('deriveIngestMeta normalises Windows backslash paths', () => {
  assert.deepEqual(deriveIngestMeta('C:\\TEI\\Applications.Employer', 'main'), {
    name: 'Applications.Employer',
    branch: 'main',
  });
});

test('isGitRepo is false for a plain dir, true for a git repo', () => {
  const plain = tmp('mc-plain-');
  assert.equal(isGitRepo(plain), false);
  execFileSync('git', ['init'], { cwd: plain });
  assert.equal(isGitRepo(plain), true);
  rmSync(plain, { recursive: true, force: true });
});

test('createBundle writes a valid git bundle of the repo', async () => {
  const repo = tmp('mc-repo-');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'c1'], { cwd: repo });

  const out = join(repo, 'out.bundle');
  await createBundle(repo, out);
  assert.equal(existsSync(out), true);
  // git verifies its own bundle format:
  execFileSync('git', ['bundle', 'verify', out], { cwd: repo });
  rmSync(repo, { recursive: true, force: true });
});
