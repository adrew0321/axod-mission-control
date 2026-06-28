# Worktree Isolation & Proposals Resilience (v1.8.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop one broken session worktree from taking down the dashboard, and stop `ensureWorktree` from ever handing an agent a directory that isn't a real worktree.

**Architecture:** Fix B extracts the proposal-building loop into a pure, fault-isolated `collectProposals(rows, diffFn)` (one throwing worktree is skipped+logged). Fix A adds worktree validation to `ensureWorktree` so a stale/hollow dir is detected and rebuilt instead of reused.

**Tech Stack:** TypeScript, `node:test` via `tsx`, real `git` (temp-dir tests), Drizzle/better-sqlite3 (untouched here).

## Global Constraints

- Tests use `node:test` + `node:assert/strict` via `pnpm test` (`tsx --test src/lib/*.test.ts`); local imports WITHOUT file extensions.
- `src/lib/proposals.ts` and `src/lib/worktree.ts` are **pure** (no `server-only`, no db) → unit-tested directly. `src/lib/proposals-data.ts` is `server-only` → NOT unit-testable; verified by `tsc --noEmit` + suite.
- Worktree validity rule: a directory is a valid worktree iff `<dir>/.git` exists AND `git -C <dir> rev-parse --show-toplevel` resolves (via `path.resolve`) to `<dir>` itself.
- Stale-dir handling = **remove & recreate** (never abort): unlink node_modules link → `git worktree remove --force` (best-effort) → `rm -rf` → `git worktree prune`, then create fresh.
- Worktree tests override `WORKTREE_ROOT` to a temp dir so they never touch the project's `data/worktrees`.
- No new dependencies, no DB migrations.
- Implementation runs in an isolated git worktree off `dev`.

---

### Task 1: Fault-isolate proposals (Fix B)

**Files:**
- Modify: `src/lib/proposals.ts` (add `ProposalRow` + `collectProposals`)
- Modify: `src/lib/proposals.test.ts` (add tests)
- Modify: `src/lib/proposals-data.ts` (delegate to `collectProposals`)

**Interfaces (produced):**
- `interface ProposalRow { sessionId: string; sessionTitle: string | null; worktreePath: string | null; updatedAt: Date | null; projectId: string; projectName: string; defaultBranch: string | null; }`
- `collectProposals(rows: ProposalRow[], diff: (wtPath: string, baseBranch: string) => Promise<{ diff: string; files: Array<{ status: string; path: string }> }>): Promise<Proposal[]>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/proposals.test.ts`:

```ts
import { collectProposals, type ProposalRow } from './proposals';

function row(over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    sessionId: 's', sessionTitle: 'S', worktreePath: '/wt/s',
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: FAIL — `collectProposals` / `ProposalRow` not exported.

- [ ] **Step 3: Implement `collectProposals`**

Append to `src/lib/proposals.ts`:

```ts
export interface ProposalRow {
  sessionId: string;
  sessionTitle: string | null;
  worktreePath: string | null;
  updatedAt: Date | null;
  projectId: string;
  projectName: string;
  defaultBranch: string | null;
}

type DiffFn = (
  wtPath: string,
  baseBranch: string,
) => Promise<{ diff: string; files: Array<{ status: string; path: string }> }>;

/**
 * Build proposals from session rows. Each row is isolated in its own try/catch:
 * a worktree whose diff throws (e.g. a broken/hollow dir with no valid base ref)
 * is skipped and logged, never fatal to the rest of the list. Sorted newest-first.
 */
export async function collectProposals(rows: ProposalRow[], diff: DiffFn): Promise<Proposal[]> {
  const proposals: Proposal[] = [];
  for (const r of rows) {
    if (!r.worktreePath) continue;
    try {
      const base = r.defaultBranch ?? 'dev';
      const { diff: text, files } = await diff(r.worktreePath, base);
      if (files.length === 0) continue;
      const { additions, deletions } = summarizeDiff(text);
      proposals.push({
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle ?? '(untitled session)',
        projectId: r.projectId,
        projectName: r.projectName,
        branch: `mc/${r.sessionId}`,
        baseBranch: base,
        files,
        additions,
        deletions,
        ts: (r.updatedAt ?? new Date()).toISOString(),
      });
    } catch (err) {
      console.warn(`[proposals] skipping session ${r.sessionId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return proposals.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/proposals.test.ts`
Expected: PASS (existing `summarizeDiff` tests + the 3 new ones).

- [ ] **Step 5: Wire `proposals-data.ts` to delegate**

Replace the whole body of `getProposals` in `src/lib/proposals-data.ts`. Change the import on line 6 from:

```ts
import { summarizeDiff, type Proposal } from './proposals';
```

to:

```ts
import { collectProposals, type Proposal } from './proposals';
```

and replace the function (the `const proposals…for…return proposals.sort` block) so it reads:

```ts
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db
    .select({
      sessionId: sessions.id,
      sessionTitle: sessions.title,
      worktreePath: sessions.worktree_path,
      updatedAt: sessions.updated_at,
      projectId: projects.id,
      projectName: projects.name,
      defaultBranch: projects.default_branch,
    })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(isNotNull(sessions.worktree_path));

  return collectProposals(rows, diffWorktree);
}
```

(The selected column aliases already match `ProposalRow` exactly. `diffWorktree` stays imported from `./worktree`. `summarizeDiff` is no longer referenced here.)

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors (the drizzle row shape is assignable to `ProposalRow[]`).

- [ ] **Step 7: Full suite + commit**

```bash
pnpm test
git add src/lib/proposals.ts src/lib/proposals.test.ts src/lib/proposals-data.ts
git commit -m "fix(proposals): fault-isolate getProposals so one bad worktree can't 500 the dashboard"
```
Expected: suite green, 0 failures.

---

### Task 2: Validate worktree before reuse (Fix A)

**Files:**
- Modify: `src/lib/worktree.ts` (export `isWorktreeValid`, add `removeStaleWorktreeDir`, validate the reuse short-circuit, import `rm`)
- Create: `src/lib/worktree.test.ts`

**Interfaces (produced):**
- `isWorktreeValid(wtPath: string): Promise<boolean>` (exported)
- `ensureWorktree(sessionId, repoPath, baseBranch?)` — unchanged signature; now rebuilds a stale dir instead of reusing it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/worktree.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureWorktree, isWorktreeValid } from './worktree';

let tmp: string, repo: string, wtRoot: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

before(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'mc-wt-'));
  repo = path.join(tmp, 'repo');
  wtRoot = path.join(tmp, 'wts');
  mkdirSync(repo);
  mkdirSync(wtRoot);
  process.env.WORKTREE_ROOT = wtRoot;
  git(repo, 'init', '-b', 'dev');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(path.join(repo, 'f.txt'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
});
after(() => {
  delete process.env.WORKTREE_ROOT;
  rmSync(tmp, { recursive: true, force: true });
});

test('ensureWorktree creates a valid worktree (fresh)', async () => {
  const wt = await ensureWorktree('sess_fresh', repo, 'dev');
  assert.equal(wt.path, path.join(wtRoot, 'sess_fresh'));
  assert.ok(existsSync(path.join(wt.path, '.git')));
  assert.equal(await isWorktreeValid(wt.path), true);
});

test('ensureWorktree reuse returns the same valid path without error', async () => {
  const a = await ensureWorktree('sess_reuse', repo, 'dev');
  const b = await ensureWorktree('sess_reuse', repo, 'dev');
  assert.equal(a.path, b.path);
  assert.equal(await isWorktreeValid(b.path), true);
});

test('ensureWorktree heals a hollow dir (no .git) by removing and recreating', async () => {
  const wtPath = path.join(wtRoot, 'sess_hollow');
  mkdirSync(wtPath, { recursive: true });
  writeFileSync(path.join(wtPath, 'junk.txt'), 'x'); // hollow: a dir with no .git
  assert.equal(await isWorktreeValid(wtPath), false);
  const wt = await ensureWorktree('sess_hollow', repo, 'dev');
  assert.equal(wt.path, wtPath);
  assert.ok(existsSync(path.join(wtPath, '.git')));
  assert.equal(await isWorktreeValid(wtPath), true);
});

test('isWorktreeValid: a missing path is false', async () => {
  assert.equal(await isWorktreeValid(path.join(wtRoot, 'does-not-exist')), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: FAIL — `isWorktreeValid` is not exported (and the heal test fails because the current short-circuit reuses the hollow dir).

- [ ] **Step 3: Add the `rm` import**

In `src/lib/worktree.ts`, change line 12 from:

```ts
import { readFile, lstat, symlink, unlink } from 'node:fs/promises';
```

to:

```ts
import { readFile, lstat, symlink, unlink, rm } from 'node:fs/promises';
```

- [ ] **Step 4: Add `isWorktreeValid` + `removeStaleWorktreeDir`**

In `src/lib/worktree.ts`, add these two functions just above `ensureWorktree` (after `linkNodeModules`):

```ts
/**
 * True only if wtPath is the top level of a real git worktree — not a stray/hollow
 * dir that git would resolve UPWARD to a parent repo (which is how a leftover dir
 * inside the app repo silently "becomes" the Mission Control repo).
 */
export async function isWorktreeValid(wtPath: string): Promise<boolean> {
  try {
    if (!existsSync(path.join(wtPath, '.git'))) return false;
    const { stdout } = await exec('git', ['-C', wtPath, 'rev-parse', '--show-toplevel']);
    return path.resolve(stdout.trim()) === path.resolve(wtPath);
  } catch {
    return false;
  }
}

/**
 * Remove a stale/corrupt scratch dir at wtPath so it can be recreated cleanly.
 * Unlinks the node_modules link first (never recurse into the live node_modules),
 * tries git's own removal (clears registration if it IS a registered worktree),
 * then hard-deletes any leftover dir and prunes stale registrations. Best-effort.
 */
async function removeStaleWorktreeDir(wtPath: string, repoPath: string): Promise<void> {
  await unlinkNodeModulesLink(wtPath);
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]).catch(() => {});
  await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
}
```

- [ ] **Step 5: Validate the reuse short-circuit**

In `src/lib/worktree.ts`, replace the existing block (currently ~lines 87-90):

```ts
  if (existsSync(wtPath)) {
    await linkNodeModules(wtPath, repoPath);
    return { path: wtPath, branch };
  }
```

with:

```ts
  if (existsSync(wtPath)) {
    if (await isWorktreeValid(wtPath)) {
      await linkNodeModules(wtPath, repoPath);
      return { path: wtPath, branch };
    }
    // Stale/corrupt scratch dir (e.g. a hollow dir with no .git that would resolve
    // to the parent repo). Remove and recreate — real session work lives on the
    // branch, not the loose dir, so this is safe.
    await removeStaleWorktreeDir(wtPath, repoPath);
  }
```

(Everything below — the `branchExists` create logic and final `linkNodeModules` + return — is unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: PASS (4 tests — fresh create, reuse, hollow heal, missing-path).

- [ ] **Step 7: Typecheck, full suite, commit**

```bash
pnpm exec tsc --noEmit
pnpm test
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "fix(worktree): validate an existing dir is a real worktree before reuse; rebuild stale/hollow dirs"
```
Expected: tsc clean; full suite green (Task 1 + Task 2 tests included).

---

## Self-Review

**Spec coverage:**
- Fix A `isWorktreeValid` (`.git` exists AND `--show-toplevel === wtPath`) → Task 2 Step 4 + tests. ✓
- Fix A `removeStaleWorktreeDir` (unlink → git remove → rm -rf → prune) → Task 2 Step 4. ✓
- Fix A validated short-circuit (valid→reuse / invalid→remove+recreate) → Task 2 Step 5. ✓
- Fix B pure `collectProposals` with per-row try/catch (skip+log) → Task 1 Step 3 + isolation test. ✓
- Fix B `proposals-data.ts` delegates → Task 1 Step 5. ✓
- Testing: real-git temp-dir worktree tests with `WORKTREE_ROOT` override (fresh/reuse/heal/missing); throwing-`diffFn` isolation + empty/null + field-mapping → Tasks 1-2. ✓
- No new deps / migrations; pure modules unit-tested, server-only verified by tsc+suite → Global Constraints. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step has complete code; commands have expected output. ✓

**Type consistency:** `ProposalRow` fields match the `proposals-data.ts` select aliases exactly; `collectProposals`'s `DiffFn` shape matches `diffWorktree`'s return (`{ diff, files }`); `isWorktreeValid` signature matches its test usage; `Proposal` fields match the existing interface in `proposals.ts`. ✓
