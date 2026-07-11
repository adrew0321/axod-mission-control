// companion/src/writeback.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBundleAsReviewBranch } from './writeback';

function git(cwd: string, ...a: string[]): string { return execFileSync('git', ['-C', cwd, ...a]).toString(); }
function tmp(p: string): string { return mkdtempSync(join(tmpdir(), p)); }

// Build: a "mini" repo on dev with mc/s1 ahead; a "laptop" repo cloned at dev.
// Return the path to a base..mc/s1 bundle plus the laptop path.
function scenario(extraMiniCommit = false) {
  const mini = tmp('wb-mini-');
  execFileSync('git', ['init', '-b', 'dev'], { cwd: mini });
  git(mini, 'config', 'user.email', 't@t'); git(mini, 'config', 'user.name', 'T');
  writeFileSync(join(mini, 'base.txt'), 'base'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'base');
  const laptop = tmp('wb-laptop-');
  execFileSync('git', ['clone', '--branch', 'dev', '--single-branch', mini, laptop]);
  execFileSync('git', ['-C', laptop, 'remote', 'remove', 'origin']);
  git(mini, 'switch', '-c', 'mc/s1');
  writeFileSync(join(mini, 'a.txt'), '1'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'c1');
  if (extraMiniCommit) { writeFileSync(join(mini, 'b.txt'), '2'); git(mini, 'add', '-A'); git(mini, 'commit', '-m', 'c2'); }
  const bundle = join(tmp('wb-b-'), 's1.bundle');
  execFileSync('git', ['-C', mini, 'bundle', 'create', bundle, 'dev..mc/s1']);
  return { mini, laptop, bundle };
}

test('first apply creates akira/s1 at the session tip', async () => {
  const { laptop, bundle } = scenario();
  const r = await applyBundleAsReviewBranch(laptop, 's1', bundle);
  assert.equal(r.branch, 'akira/s1');
  assert.equal(git(laptop, 'rev-list', '--count', 'dev..akira/s1').trim(), '1');
});

test('second apply fast-forwards the same branch', async () => {
  const first = scenario();
  await applyBundleAsReviewBranch(first.laptop, 's1', first.bundle);
  // Re-bundle after another mini commit onto the same mc/s1, then re-apply.
  writeFileSync(join(first.mini, 'c.txt'), '3'); git(first.mini, 'switch', 'mc/s1');
  git(first.mini, 'add', '-A'); git(first.mini, 'commit', '-m', 'c2');
  const bundle2 = join(tmp('wb-b2-'), 's1.bundle');
  execFileSync('git', ['-C', first.mini, 'bundle', 'create', bundle2, 'dev..mc/s1']);
  const r = await applyBundleAsReviewBranch(first.laptop, 's1', bundle2);
  assert.equal(r.branch, 'akira/s1');
  assert.equal(git(first.laptop, 'rev-list', '--count', 'dev..akira/s1').trim(), '2');
});

test('a non-fast-forward re-apply is refused and leaves the branch unchanged', async () => {
  const s = scenario(); // mini: dev(base) + mc/s1(+c1); laptop@dev; bundle = dev..mc/s1
  await applyBundleAsReviewBranch(s.laptop, 's1', s.bundle); // akira/s1 = base + c1
  // Operator adds their own commit on top of the review branch.
  git(s.laptop, 'switch', 'akira/s1');
  writeFileSync(join(s.laptop, 'mine.txt'), 'x'); git(s.laptop, 'add', '-A'); git(s.laptop, 'commit', '-m', 'mine');
  const afterMine = git(s.laptop, 'rev-parse', 'akira/s1').trim();
  git(s.laptop, 'switch', 'dev');
  // On the mini, REWRITE mc/s1 over the SAME base (amend c1) -> divergent history.
  // Same base means the bundle prerequisite is present on the laptop (verify passes),
  // so the failure is specifically the non-fast-forward fetch, not a missing prereq.
  git(s.mini, 'switch', 'mc/s1');
  writeFileSync(join(s.mini, 'a.txt'), '1-rewritten'); git(s.mini, 'add', '-A');
  git(s.mini, 'commit', '--amend', '-m', 'c1-rewritten');
  const bundle2 = join(tmp('wb-div-'), 's1.bundle');
  execFileSync('git', ['-C', s.mini, 'bundle', 'create', bundle2, 'dev..mc/s1']);
  await assert.rejects(() => applyBundleAsReviewBranch(s.laptop, 's1', bundle2), /diverged|fast-forward|rejected/i);
  assert.equal(git(s.laptop, 'rev-parse', 'akira/s1').trim(), afterMine); // unchanged
});

test('a bundle whose prerequisite is missing raises a re-ingest error', async () => {
  const { bundle } = scenario();
  const stranger = tmp('wb-stranger-'); // fresh repo without the base commit
  execFileSync('git', ['init', '-b', 'dev'], { cwd: stranger });
  git(stranger, 'config', 'user.email', 't@t'); git(stranger, 'config', 'user.name', 'T');
  writeFileSync(join(stranger, 'x.txt'), 'x'); git(stranger, 'add', '-A'); git(stranger, 'commit', '-m', 'x');
  await assert.rejects(() => applyBundleAsReviewBranch(stranger, 's1', bundle), /re-ingest|prerequisite|base commit/i);
});
