// Verify the worktree helper against a temp repo with an apostrophe in its path.
// Run: node scripts/verify-worktree.mjs   (no agent cost, no landing-repo mutation)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorktree, removeWorktree, listWorktrees } from '../src/lib/worktree.ts';

const exec = promisify(execFile);

// Temp base dir WITH an apostrophe to replicate the A'KeemDrew risk.
const base = mkdtempSync(path.join(os.tmpdir(), "mc-wt'test-"));
const repo = path.join(base, 'repo');
const wtRoot = path.join(base, 'worktrees');
mkdirSync(repo, { recursive: true });
process.env.WORKTREE_ROOT = wtRoot;

async function git(cwd, ...args) {
  return exec('git', ['-C', cwd, ...args]);
}

let ok = true;
const check = (label, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

try {
  console.log(`[verify] base path (note apostrophe): ${base}`);
  await git(repo, 'init', '-q', '-b', 'dev');
  await git(repo, 'config', 'user.email', 't@t.dev');
  await git(repo, 'config', 'user.name', 'Test');
  writeFileSync(path.join(repo, 'README.md'), '# temp\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'init');

  const wt = await ensureWorktree('sess_test', repo, 'dev');
  check('worktree dir created', existsSync(wt.path));
  check('branch name is mc/sess_test', wt.branch === 'mc/sess_test');
  check('worktree has the committed file', existsSync(path.join(wt.path, 'README.md')));

  // worktree is a valid checkout on the session branch
  const { stdout: br } = await git(wt.path, 'branch', '--show-current');
  check('worktree HEAD is mc/sess_test', br.trim() === 'mc/sess_test');

  const list = await listWorktrees(repo);
  check('listWorktrees includes the new worktree', list.some((p) => p.replace(/\\/g, '/').includes('sess_test')));

  // idempotent
  const wt2 = await ensureWorktree('sess_test', repo, 'dev');
  check('ensureWorktree is idempotent', wt2.path === wt.path);

  await removeWorktree('sess_test', repo);
  check('worktree removed', !existsSync(wt.path));
} catch (e) {
  console.log('FAIL  threw:', e?.message ?? e);
  ok = false;
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch {}
}

console.log(ok ? '\n[verify] ALL PASS' : '\n[verify] SOME FAILED');
process.exit(ok ? 0 : 1);
