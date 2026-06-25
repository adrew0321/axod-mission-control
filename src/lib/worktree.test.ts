import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
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

    // Create the worktree — ensureWorktree now links node_modules automatically.
    const wt = await ensureWorktree(sessionId, repo, 'dev');
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

test('ensureWorktree links node_modules so the source is readable through the worktree', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    await mkdir(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;');

    const wt = await ensureWorktree('sess_link', repo, 'dev');

    const linked = await readFile(path.join(wt.path, 'node_modules', 'left-pad', 'index.js'), 'utf8');
    assert.equal(linked, 'module.exports=1;');
  } finally {
    await removeWorktree('sess_link', repo).catch(() => {});
    await cleanup(repo, root);
  }
});

test('ensureWorktree is idempotent: a second call leaves a valid node_modules link', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'marker.txt'), 'm');

    await ensureWorktree('sess_idem', repo, 'dev');
    await ensureWorktree('sess_idem', repo, 'dev'); // must not throw

    assert.equal(existsSync(path.join(root, 'sess_idem', 'node_modules', 'marker.txt')), true);
  } finally {
    await removeWorktree('sess_idem', repo).catch(() => {});
    await cleanup(repo, root);
  }
});

test('ensureWorktree is a no-op for linking when the repo has no node_modules', async () => {
  const repo = await makeRepo(); // no node_modules created
  const root = await freshWorktreeRoot();
  try {
    const wt = await ensureWorktree('sess_none', repo, 'dev');
    assert.equal(existsSync(wt.path), true, 'worktree still created');
    assert.equal(existsSync(path.join(wt.path, 'node_modules')), false, 'no link created');
  } finally {
    await removeWorktree('sess_none', repo).catch(() => {});
    await cleanup(repo, root);
  }
});
