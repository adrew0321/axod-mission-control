// src/lib/companion/writeback-repo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCommitsAhead, createSessionBundle, countChangedFiles } from './writeback-repo';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args]).toString();
}
function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }

// A repo on 'dev' with one base commit, plus a branch mc/s1 two commits ahead.
function makeRepoWithBranch(): { repo: string } {
  const repo = tmp('wb-src-');
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repo });
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'base.txt'), 'base'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'base');
  git(repo, 'branch', 'mc/s1'); git(repo, 'switch', 'mc/s1');
  writeFileSync(join(repo, 'a.txt'), '1'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'c1');
  writeFileSync(join(repo, 'b.txt'), '2'); git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'c2');
  git(repo, 'switch', 'dev');
  return { repo };
}

test('countCommitsAhead counts commits the branch adds over base', async () => {
  const { repo } = makeRepoWithBranch();
  assert.equal(await countCommitsAhead(repo, 'dev', 'mc/s1'), 2);
  rmSync(repo, { recursive: true, force: true });
});

test('countCommitsAhead is 0 when the branch has nothing over base', async () => {
  const { repo } = makeRepoWithBranch();
  git(repo, 'branch', 'mc/empty', 'dev');
  assert.equal(await countCommitsAhead(repo, 'dev', 'mc/empty'), 0);
  rmSync(repo, { recursive: true, force: true });
});

test('countChangedFiles counts files changed base..branch', async () => {
  const { repo } = makeRepoWithBranch();
  assert.equal(await countChangedFiles(repo, 'dev', 'mc/s1'), 2); // a.txt, b.txt
  rmSync(repo, { recursive: true, force: true });
});

test('createSessionBundle makes a base..branch bundle that fetches into a clone of base', async () => {
  const { repo } = makeRepoWithBranch();
  const bundle = join(tmp('wb-out-'), 'session.bundle');
  await createSessionBundle(repo, 'dev', 'mc/s1', bundle);
  assert.equal(existsSync(bundle), true);

  // Simulate the laptop: a repo that has only the base commit.
  const laptop = tmp('wb-laptop-');
  execFileSync('git', ['clone', '--branch', 'dev', '--single-branch', repo, laptop]);
  execFileSync('git', ['-C', laptop, 'remote', 'remove', 'origin']);
  // Verify prerequisites are present, then fetch as a NEW review branch.
  execFileSync('git', ['-C', laptop, 'bundle', 'verify', bundle]);
  execFileSync('git', ['-C', laptop, 'fetch', bundle, 'refs/heads/mc/s1:refs/heads/akira/s1']);
  const count = execFileSync('git', ['-C', laptop, 'rev-list', '--count', 'dev..akira/s1']).toString().trim();
  assert.equal(count, '2');
  rmSync(repo, { recursive: true, force: true });
  rmSync(laptop, { recursive: true, force: true });
});
