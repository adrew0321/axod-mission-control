import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureWorktree, removeWorktree } from './worktree';

const exec = promisify(execFile);

/** Create a temp git repo on branch `dev` with one commit. Returns its path. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mc-wt-repo-'));
  await exec('git', ['-C', dir, 'init', '-b', 'dev']);
  await exec('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', ['-C', dir, 'commit', '-m', 'init']);
  return dir;
}

/** Point worktreeRoot() at a fresh temp dir for this test. Returns the root. */
async function freshWorktreeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mc-wt-root-'));
  process.env.WORKTREE_ROOT = root;
  return root;
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
}

test('removeWorktree unlinks the node_modules junction without deleting the source', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  const sessionId = 'sess_safety';
  try {
    // Source node_modules with a marker the test will assert survives.
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'marker.txt'), 'keep-me');

    // Create the worktree, then manually link node_modules into it (Task 2 will
    // make ensureWorktree do this automatically; here we set up the hazard by hand).
    const wt = await ensureWorktree(sessionId, repo, 'dev');
    await symlink(path.resolve(repo, 'node_modules'), path.join(wt.path, 'node_modules'), 'junction');
    assert.equal(existsSync(path.join(wt.path, 'node_modules', 'marker.txt')), true);

    await removeWorktree(sessionId, repo);

    // Worktree gone; the SOURCE node_modules marker must still exist.
    assert.equal(existsSync(wt.path), false, 'worktree should be removed');
    assert.equal(
      existsSync(path.join(repo, 'node_modules', 'marker.txt')),
      true,
      'teardown must NOT follow the junction into the source node_modules',
    );
  } finally {
    await cleanup(repo, root);
  }
});
