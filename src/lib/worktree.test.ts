import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureWorktree, removeWorktree, isWorktreeValid, mergeWorktree, commitWorktreeEdits } from './worktree';

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

test('ensureWorktree throws when the repo path does not exist', async () => {
  const root = await freshWorktreeRoot();
  const missing = path.join(tmpdir(), 'mc-no-such-repo-' + Date.now());
  try {
    await assert.rejects(() => ensureWorktree('sess_missing', missing, 'dev'), /repo path does not exist/);
  } finally {
    await cleanup(root);
  }
});

test('ensureWorktree throws when the path is not a git repository', async () => {
  const root = await freshWorktreeRoot();
  const notGit = await mkdtemp(path.join(tmpdir(), 'mc-notgit-'));
  try {
    await assert.rejects(() => ensureWorktree('sess_notgit', notGit, 'dev'), /not a git repository/);
  } finally {
    await cleanup(notGit, root);
  }
});

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

test('isWorktreeValid: true for a real worktree, false for a hollow dir or missing path', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    const wt = await ensureWorktree('sess_valid', repo, 'dev');
    assert.equal(await isWorktreeValid(wt.path), true);

    const hollow = path.join(root, 'hollow');
    await mkdir(hollow, { recursive: true });
    await writeFile(path.join(hollow, 'junk.txt'), 'x'); // a dir with no .git
    assert.equal(await isWorktreeValid(hollow), false);

    assert.equal(await isWorktreeValid(path.join(root, 'does-not-exist')), false);
  } finally {
    await removeWorktree('sess_valid', repo).catch(() => {});
    await cleanup(repo, root);
  }
});

test('ensureWorktree heals a hollow dir (no .git) by removing and recreating', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    const wtPath = path.join(root, 'sess_hollow');
    await mkdir(wtPath, { recursive: true });
    await writeFile(path.join(wtPath, 'junk.txt'), 'x'); // hollow: a dir with no .git
    assert.equal(await isWorktreeValid(wtPath), false);

    const wt = await ensureWorktree('sess_hollow', repo, 'dev');
    assert.equal(wt.path, wtPath);
    assert.equal(existsSync(path.join(wtPath, '.git')), true);
    assert.equal(await isWorktreeValid(wtPath), true);
  } finally {
    await removeWorktree('sess_hollow', repo).catch(() => {});
    await cleanup(repo, root);
  }
});

test('commitWorktreeEdits commits loose edits and is a no-op on a clean tree', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  const sessionId = 'sess_commitloose';
  try {
    const wt = await ensureWorktree(sessionId, repo, 'dev');

    // No edits yet -> no commit.
    assert.equal(await commitWorktreeEdits(sessionId, repo), false);

    // Make an edit -> it commits.
    await writeFile(path.join(wt.path, 'new.txt'), 'hello');
    assert.equal(await commitWorktreeEdits(sessionId, repo), true);

    // Clean again -> no-op.
    assert.equal(await commitWorktreeEdits(sessionId, repo), false);

    // The commit is on mc/<sessionId>, ahead of dev.
    const { stdout: ahead } = await exec('git', ['-C', repo, 'rev-list', '--count', `dev..mc/${sessionId}`]);
    assert.equal(ahead.trim(), '1');
  } finally {
    await removeWorktree(sessionId, repo).catch(() => {});
    await cleanup(repo, root);
  }
});

test('mergeWorktree commits as Mission Control and excludes node_modules', async () => {
  const repo = await makeRepo();
  const root = await freshWorktreeRoot();
  try {
    const wt = await ensureWorktree('sess_merge', repo, 'dev');
    // A real change + a node_modules dir that must NOT be committed.
    await writeFile(path.join(wt.path, 'feature.txt'), 'hello\n');
    await mkdir(path.join(wt.path, 'node_modules', 'junkpkg'), { recursive: true });
    await writeFile(path.join(wt.path, 'node_modules', 'junkpkg', 'index.js'), 'x');
    await exec('git', ['-C', wt.path, 'add', 'node_modules']).catch(() => {}); // even if an agent pre-staged it

    const res = await mergeWorktree('sess_merge', repo, 'dev');
    assert.equal(res.ok, true);

    // The merge commit author is Mission Control (inline identity applied).
    const { stdout: author } = await exec('git', ['-C', repo, 'log', 'dev', '-1', '--format=%an']);
    assert.equal(author.trim(), 'Mission Control');

    // feature.txt landed on dev; node_modules did NOT.
    const { stdout: tree } = await exec('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'dev']);
    assert.ok(tree.split('\n').includes('feature.txt'), 'feature.txt should be committed');
    assert.ok(!tree.split('\n').some((f) => f.startsWith('node_modules')), 'node_modules must NOT be committed');
  } finally {
    await cleanup(repo, root);
  }
});
