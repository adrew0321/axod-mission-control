# Working Dependencies in Session Worktrees — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm build`/`pnpm test` work inside session git worktrees by linking each worktree's `node_modules` to the project's main checkout.

**Architecture:** Add two best-effort helpers to `src/lib/worktree.ts`. `ensureWorktree` creates a directory junction (Windows) / symlink (POSIX) from `<worktree>/node_modules` to `<repo>/node_modules`. `removeWorktree` unlinks that junction *before* `git worktree remove` so teardown can never recurse through the link into the live app's `node_modules`.

**Tech Stack:** TypeScript, Node `fs/promises` (`symlink`, `lstat`, `unlink`), `node:child_process` execFile (git), `node:test` via `tsx`.

## Global Constraints

- Tests run via `pnpm test` → `tsx --test src/lib/*.test.ts`. Use `node:test` + `node:assert/strict`.
- Import local modules **without** file extensions (e.g. `from './worktree'`), or `tsc`/`next build` break.
- `worktree.ts` is intentionally free of the `server-only` guard (pure git/fs) — keep it that way.
- All git/fs calls use `execFile` with an **argv array** (never a shell string) — paths may contain an apostrophe (`C:/Users/A'KeemDrew/...`).
- Cross-platform: `fs.symlink(target, path, 'junction')` → junction on Windows (no admin needed), symlink on POSIX (the `type` arg is ignored off-Windows). Junction targets must be **absolute**.
- Linking is **best-effort**: a failure logs a warning and must NOT throw (read-only jobs must never regress).
- Teardown unlink is **mandatory and safety-critical**.
- Implementation happens in an isolated git worktree (the mission-control repo is the live app dir — never branch-switch it).

---

### Task 1: Teardown safety — unlink the node_modules junction before `git worktree remove`

This task lands the safety net FIRST, so that when linking is added in Task 2, teardown is already incapable of deleting the live `node_modules`.

**Files:**
- Create: `src/lib/worktree.test.ts`
- Modify: `src/lib/worktree.ts` (add `unlinkNodeModulesLink`; call it at the top of `removeWorktree`)

**Interfaces:**
- Produces: `unlinkNodeModulesLink(worktreePath: string): Promise<void>` (module-private helper). No exported API changes — `removeWorktree(sessionId, repoPath)` keeps its signature.

- [ ] **Step 1: Write the failing test**

Create `src/lib/worktree.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: FAIL — `removeWorktree` currently runs `git worktree remove --force`, which on the junction-containing worktree either errors or (worst case) the assertion proves the source marker was deleted. Either way the test does not pass.

- [ ] **Step 3: Add the helper and call it in `removeWorktree`**

In `src/lib/worktree.ts`, extend the fs import at the top:

```ts
import { existsSync } from 'node:fs';
import { readFile, lstat, symlink, unlink } from 'node:fs/promises';
```

Add this helper (place it just above `removeWorktree`):

```ts
/**
 * Remove the `node_modules` junction/symlink from a worktree, if present. MUST run
 * before `git worktree remove` so the recursive delete can never traverse the link
 * into the project's real (live) node_modules. Removes the LINK only, never the target.
 */
async function unlinkNodeModulesLink(worktreePath: string): Promise<void> {
  const link = path.join(worktreePath, 'node_modules');
  try {
    const st = await lstat(link); // does not follow the link
    // Node reports a Windows junction as a symbolic link here; unlink removes the link.
    if (st.isSymbolicLink()) await unlink(link);
  } catch {
    /* no link present — nothing to do */
  }
}
```

Modify `removeWorktree` so it unlinks first (new first line of the body):

```ts
export async function removeWorktree(sessionId: string, repoPath: string): Promise<void> {
  const wtPath = sessionWorktreePath(sessionId);
  await unlinkNodeModulesLink(wtPath); // safety: never let git recurse into live node_modules
  if (!existsSync(wtPath)) {
    await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
    return;
  }
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "feat(worktree): unlink node_modules junction before teardown (safety)"
```

---

### Task 2: Link node_modules into every new worktree

**Files:**
- Modify: `src/lib/worktree.ts` (add `linkNodeModules`; call it at the end of `ensureWorktree`)
- Modify: `src/lib/worktree.test.ts` (add link tests)

**Interfaces:**
- Consumes: `unlinkNodeModulesLink` (Task 1) is already in place, so teardown is safe.
- Produces: `linkNodeModules(worktreePath: string, repoPath: string): Promise<void>` (module-private). `ensureWorktree(sessionId, repoPath, baseBranch?)` keeps its signature and return type `Promise<WorktreeInfo>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/worktree.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: FAIL — the link test and idempotent test fail because `ensureWorktree` does not yet create `node_modules` (`ENOENT` reading `left-pad/index.js` / missing `marker.txt`). The no-op test already passes.

- [ ] **Step 3: Add `linkNodeModules` and call it in `ensureWorktree`**

In `src/lib/worktree.ts`, add this helper (place it just above `ensureWorktree`):

```ts
/**
 * Link the worktree's node_modules to the project's main checkout so build/test jobs
 * have working dependencies (incl. already-compiled native modules). Best-effort:
 * never throws — a failure just leaves the worktree without deps (read-only jobs still
 * work). Idempotent. No-op when the project has no node_modules. The teardown in
 * removeWorktree removes this link before deleting the worktree.
 */
async function linkNodeModules(worktreePath: string, repoPath: string): Promise<void> {
  const target = path.resolve(repoPath, 'node_modules'); // absolute: required for junctions
  const link = path.join(worktreePath, 'node_modules');
  if (!existsSync(target)) return; // non-Node project / deps not installed
  if (existsSync(link)) return; // already linked or present — idempotent
  await symlink(target, link, 'junction');
}
```

Modify the end of `ensureWorktree` so it links after the worktree exists. Replace the final `return { path: wtPath, branch };` with a best-effort link call:

```ts
  } else {
    await exec('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, wtPath, baseBranch]);
  }
  await linkNodeModules(wtPath, repoPath).catch((err) =>
    console.warn('[worktree] node_modules link failed:', err instanceof Error ? err.message : err),
  );
  return { path: wtPath, branch };
```

Also handle the early-return path: `ensureWorktree` returns early when the worktree already exists (`if (existsSync(wtPath)) return { path: wtPath, branch };`). Add a link attempt there too, so a worktree created before this feature gets linked on next use:

```ts
  if (existsSync(wtPath)) {
    await linkNodeModules(wtPath, repoPath).catch((err) =>
      console.warn('[worktree] node_modules link failed:', err instanceof Error ? err.message : err),
    );
    return { path: wtPath, branch };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: PASS (4 tests total: the Task 1 safety test + the 3 added here).

- [ ] **Step 5: Run the full test + typecheck to confirm no regressions**

Run: `pnpm test`
Expected: all `src/lib/*.test.ts` pass.

Run: `pnpm exec tsc --noEmit` (or the project's typecheck script if different)
Expected: no type errors (confirms extensionless imports + signatures are clean).

- [ ] **Step 6: Commit**

```bash
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "feat(worktree): link node_modules into session worktrees for build/test jobs"
```

---

## Self-Review

**Spec coverage:**
- "Link, don't install" → Task 2 `linkNodeModules` (junction/symlink). ✓
- Cross-platform junction → `fs.symlink(target, link, 'junction')`, absolute target. ✓
- Call site at end of `ensureWorktree`, covers all callers → Task 2 (both the new-worktree path and the early-return path). ✓
- Best-effort (warn, don't throw) → `.catch(... console.warn ...)` in Task 2. ✓
- No-op when repo has no node_modules → Task 2 guard + dedicated test. ✓
- Idempotent → Task 2 guard + dedicated test. ✓
- Teardown safety (unlink before remove) → Task 1 `unlinkNodeModulesLink` + dedicated source-survives test. ✓
- No DB/config changes; change confined to `worktree.ts` (+ its test) → both tasks. ✓
- Testing list (link works / idempotent / no-op / teardown safety) → all four tests present. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — all steps contain full code and exact commands. ✓

**Type consistency:** `linkNodeModules(worktreePath, repoPath)`, `unlinkNodeModulesLink(worktreePath)`, and `ensureWorktree`/`removeWorktree` signatures are consistent across tasks and match the existing exports in `worktree.ts`. fs imports (`lstat`, `symlink`, `unlink`, `readFile`, `existsSync`) are introduced in Task 1 / extended in Task 2 without duplication. ✓
