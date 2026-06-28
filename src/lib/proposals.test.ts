import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDiff, collectProposals, type ProposalRow } from './proposals';

test('counts added and removed content lines', () => {
  const diff = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -1,2 +1,3 @@',
    ' unchanged',
    '-old line',
    '+new line one',
    '+new line two',
  ].join('\n');
  assert.deepEqual(summarizeDiff(diff), { additions: 2, deletions: 1 });
});

test('ignores +++/--- file headers', () => {
  const diff = '--- a/f\n+++ b/f\n+only real addition';
  assert.deepEqual(summarizeDiff(diff), { additions: 1, deletions: 0 });
});

test('empty diff is zero/zero', () => {
  assert.deepEqual(summarizeDiff(''), { additions: 0, deletions: 0 });
});

function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    sessionId: 's', sessionTitle: 'S', worktreePath: '/wt/s', baseBranch: null,
    updatedAt: new Date('2026-06-01T00:00:00Z'), projectId: 'p', projectName: 'P',
    defaultBranch: 'dev', ...over,
  };
}
const okDiff = { diff: '+a\n', files: [{ status: 'M', path: 'f.ts' }] };

test('collectProposals isolates a throwing worktree (one bad row never sinks the rest)', async () => {
  const rows = [
    row({ sessionId: 'a', worktreePath: '/wt/a', updatedAt: new Date('2026-06-03T00:00:00Z') }),
    row({ sessionId: 'bad', worktreePath: '/wt/bad', updatedAt: new Date('2026-06-02T00:00:00Z') }),
    row({ sessionId: 'c', worktreePath: '/wt/c', updatedAt: new Date('2026-06-01T00:00:00Z') }),
  ];
  const diff = async (wt: string) => {
    if (wt === '/wt/bad') throw new Error("fatal: bad revision 'dev'");
    return okDiff;
  };
  const res = await collectProposals(rows, diff);
  assert.deepEqual(res.map((p) => p.sessionId), ['a', 'c']); // bad skipped; newest-first
});

test('collectProposals skips empty diffs and null worktree paths', async () => {
  const rows = [
    row({ sessionId: 'empty', worktreePath: '/wt/empty' }),
    row({ sessionId: 'nullwt', worktreePath: null }),
    row({ sessionId: 'real', worktreePath: '/wt/real' }),
  ];
  const diff = async (wt: string) =>
    wt === '/wt/real' ? okDiff : { diff: '', files: [] as Array<{ status: string; path: string }> };
  const res = await collectProposals(rows, diff);
  assert.deepEqual(res.map((p) => p.sessionId), ['real']);
});

test('collectProposals maps fields and counts the diff', async () => {
  const rows = [row({ sessionId: 'x', sessionTitle: null, worktreePath: '/wt/x', defaultBranch: null })];
  const diff = async () => ({ diff: '+one\n-two\n', files: [{ status: 'M', path: 'f' }] });
  const [p] = await collectProposals(rows, diff);
  assert.equal(p.sessionTitle, '(untitled session)');
  assert.equal(p.branch, 'mc/x');
  assert.equal(p.baseBranch, 'dev'); // null defaultBranch falls back to 'dev'
  assert.deepEqual({ a: p.additions, d: p.deletions }, { a: 1, d: 1 });
});

test('collectProposals: session base_branch wins over project default', async () => {
  const rows = [row({ sessionId: 'b', worktreePath: '/wt/b', baseBranch: 'main', defaultBranch: 'dev' })];
  let seenBase = '';
  const diff = async (_wt: string, base: string) => {
    seenBase = base;
    return { diff: '+a\n', files: [{ status: 'M', path: 'f' }] };
  };
  const [p] = await collectProposals(rows, diff);
  assert.equal(seenBase, 'main'); // diff invoked with the session base
  assert.equal(p.baseBranch, 'main');
});
