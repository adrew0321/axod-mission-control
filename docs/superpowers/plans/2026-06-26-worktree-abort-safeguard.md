# Worktree-Abort Safeguard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure an agent turn only ever runs in a successfully-created isolated worktree — if one can't be created, the turn aborts cleanly instead of falling back to `repo_path`/`process.cwd()` (the live app dir).

**Architecture:** Two layers. (1) `ensureWorktree` validates `repoPath` (exists + is a git repo) and throws a clear error. (2) `runSessionTurn` requires a successful `ensureWorktree`; on a missing `repo_path` or any failure it emits an `error` event and returns `{status:'error'}` — `workingDir` is only ever a real worktree path.

**Tech Stack:** TypeScript, `node:child_process` execFile (git), `node:fs`, `node:test` via `tsx`.

## Global Constraints

- Tests use `node:test` + `node:assert/strict`, run via `pnpm test` (`tsx --test src/lib/*.test.ts`).
- Import local modules WITHOUT file extensions.
- `src/lib/worktree.ts` is pure git/fs (no `server-only`); all git calls use `execFile` with an argv array (apostrophe-safe paths). It IS unit-testable.
- `src/lib/run-turn.ts` imports `server-only` (DB/SDK) → NOT unit-testable under the runner; verify by `tsc --noEmit` + full suite (no regressions) + manual check.
- `workingDir` in `runSessionTurn` must be assigned ONLY from a successful `ensureWorktree` — never `project.repo_path`, never `process.cwd()`.
- Exact error strings: `repo path does not exist: <repoPath>`, `not a git repository: <repoPath>`, `could not prepare an isolated worktree: <err>`, and `no repo configured for this project — cannot run a turn`.
- Implementation runs in an isolated git worktree off `dev` (the repo is the live app dir — never branch-switch it).

---

### Task 1: `ensureWorktree` validates `repoPath` (pure, tested)

**Files:**
- Modify: `src/lib/worktree.ts` (add validation at the top of `ensureWorktree`)
- Modify: `src/lib/worktree.test.ts` (add two failing-path tests)

**Interfaces:**
- `ensureWorktree(sessionId: string, repoPath: string, baseBranch = 'dev'): Promise<WorktreeInfo>` — unchanged signature; now throws `Error` for a missing/non-existent `repoPath` or a non-git directory.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/worktree.test.ts`:

```ts
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
```

(`freshWorktreeRoot`, `cleanup`, `mkdtemp`, `tmpdir`, `path`, `assert`, `ensureWorktree` are all already imported/defined in this test file from the worktree-deps feature.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: FAIL — without validation, `ensureWorktree` proceeds to `git worktree add` against the bad path, which throws git's own error (not matching `/repo path does not exist/` or `/not a git repository/`), so the rejection-message assertions fail.

- [ ] **Step 3: Add the validation**

In `src/lib/worktree.ts`, at the very top of the `ensureWorktree` body — BEFORE the `if (existsSync(wtPath)) return …` short-circuit — insert:

```ts
  // An agent must only ever run in a real isolated worktree. Validate the source
  // repo up front so a bad/stale repoPath fails loudly here instead of letting the
  // caller fall back to running in the wrong directory.
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error(`repo path does not exist: ${repoPath}`);
  }
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`not a git repository: ${repoPath}`);
  }
```

So the start of `ensureWorktree` becomes:

```ts
export async function ensureWorktree(
  sessionId: string,
  repoPath: string,
  baseBranch = 'dev',
): Promise<WorktreeInfo> {
  if (!repoPath || !existsSync(repoPath)) {
    throw new Error(`repo path does not exist: ${repoPath}`);
  }
  try {
    await exec('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(`not a git repository: ${repoPath}`);
  }

  const wtPath = sessionWorktreePath(sessionId);
  const branch = sessionBranch(sessionId);

  if (existsSync(wtPath)) return { path: wtPath, branch };
  // …rest unchanged…
```

(`existsSync` and `exec` are already imported at the top of `worktree.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/worktree.test.ts`
Expected: PASS — the two new tests plus all existing worktree tests (link/idempotent/no-op/teardown-safety) stay green (they use real git repos via `makeRepo`, so validation passes for them).

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree.ts src/lib/worktree.test.ts
git commit -m "feat(worktree): validate repo_path in ensureWorktree (exists + is a git repo)"
```

---

### Task 2: `runSessionTurn` aborts when no worktree (no fallback)

No new unit test: `run-turn.ts` imports `server-only` and the SDK, so the `tsx --test` runner can't load it. The behavior is verified by `tsc --noEmit` + the full suite (no regressions) and a manual check. Task 1 already covers the validation logic that triggers the abort.

**Files:**
- Modify: `src/lib/run-turn.ts` (replace the worktree fallback block)

**Interfaces:**
- Consumes: `ensureWorktree` (now throws on bad `repoPath`, Task 1).
- `runSessionTurn` signature/return type unchanged (`Promise<TurnResult>`).

- [ ] **Step 1: Replace the worktree block**

In `src/lib/run-turn.ts`, replace this block:

```ts
    let workingDir = project?.repo_path ?? process.cwd();
    if (project?.repo_path) {
      try {
        const wt = await ensureWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev');
        workingDir = wt.path;
        if (session.worktree_path !== wt.path) {
          await db.update(sessions).set({ worktree_path: wt.path }).where(eq(sessions.id, sessionId));
        }
        emit({ type: 'worktree', path: wt.path, branch: wt.branch });
      } catch (err) {
        emit({ type: 'worktree_error', message: err instanceof Error ? err.message : String(err) });
      }
    }
```

with:

```ts
    // An agent must NEVER run outside a real isolated worktree. If we can't create
    // one, abort the turn — do not fall back to repo_path or process.cwd() (the live
    // app dir). The lease is released by the finally below.
    if (!project?.repo_path) {
      emit({ type: 'error', message: 'no repo configured for this project — cannot run a turn' });
      return { status: 'error', reason: 'no repo_path' };
    }
    let workingDir: string;
    try {
      const wt = await ensureWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev');
      workingDir = wt.path;
      if (session.worktree_path !== wt.path) {
        await db.update(sessions).set({ worktree_path: wt.path }).where(eq(sessions.id, sessionId));
      }
      emit({ type: 'worktree', path: wt.path, branch: wt.branch });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message: `could not prepare an isolated worktree: ${message}` });
      return { status: 'error', reason: `worktree failed: ${message}` };
    }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (Confirms `workingDir` is definitely assigned before its later uses — TypeScript would flag a possibly-unassigned `let workingDir: string` if any path reached usage without assignment; the early `return`s satisfy this.)

- [ ] **Step 3: Full suite — no regressions**

Run: `pnpm test`
Expected: all `src/lib/*.test.ts` pass, including Task 1's new worktree tests; 0 failures.

- [ ] **Step 4: Commit**

```bash
git add src/lib/run-turn.ts
git commit -m "feat(run-turn): abort turn when no isolated worktree (no live-dir fallback)"
```

---

## Self-Review

**Spec coverage:**
- Layer 1: `ensureWorktree` validates repo_path exists + is a git repo, throws clear errors → Task 1 (with the exact message strings). ✓
- Layer 2: `runSessionTurn` aborts (emit error + return error) on missing `repo_path` or worktree failure; `workingDir` only from a successful worktree → Task 2. ✓
- Null `repo_path` aborts → Task 2 Step 1 first branch. ✓
- Lease released on abort → the `return`s are inside the existing try/finally; noted. ✓
- Validation detection via `git rev-parse --is-inside-work-tree`, execFile argv → Task 1 Step 3. ✓
- Testing: worktree unit tests (nonexistent → throws; non-git → throws; valid still works) + tsc + suite for run-turn → Tasks 1-2. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — complete code + exact commands throughout. ✓

**Type consistency:** `ensureWorktree(sessionId, repoPath, baseBranch='dev'): Promise<WorktreeInfo>` unchanged; `runSessionTurn` returns `{status:'error', reason}` which matches `TurnResult` (`{ status: 'completed'|'skipped'|'error'; reason?: string }`). Error strings identical between spec and plan. `existsSync`/`exec` already imported in `worktree.ts`; no new imports in either file. ✓
