# v1.8.3 — Worktree isolation & proposals resilience (design)

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Trigger:** 2026-06-27 incident — a hollow worktree dir 500'd the whole dashboard (see memory `worktree-hollow-dir-incident`).

## Why / scope

During the Discord Phase 3 live-test, a session (`sess_a4f9`) ended up with a **hollow** worktree directory at `data/worktrees/sess_a4f9` — a directory with a `node_modules` symlink and a `dist/` build but **no `.git`**. Two compounding weaknesses turned that into an outage:

1. `ensureWorktree` reuses any directory that merely *exists* at the worktree path, without checking it's a real git worktree. Because the worktree root lives **inside** the Mission Control repo (`process.cwd()/data/worktrees`), git run inside a hollow dir resolves *upward* to the MC repo (`/srv/mission-control`), which has no local `dev` branch.
2. `getProposals` diffs every session-with-a-worktree against `dev` in one loop with **no per-session error handling**, so that single `fatal: bad revision 'dev'` threw and 500'd **every page that lists proposals** (the entire dashboard) plus the Discord notifier tick (every 30s).

This release hardens both. **In scope:** fix A (validate-before-reuse) and fix B (fault-isolate proposals). **Out of scope:** fix C (relocating the worktree root off the MC repo — deferred; A neutralizes its danger), changing how proposals are detected or how `mergeWorktree`/`discardWorktree` work, and reconstructing the exact agent navigation that touched the live landing checkout (cold trail — turns log to the Discord sink, not the journal; A makes handing an agent a non-worktree dir structurally impossible).

## Fix A — `ensureWorktree` validates an existing dir before reusing it

File: `src/lib/worktree.ts` (pure — its header already declares it safe to unit-test via tsx).

New helper:

```ts
/** True only if wtPath is the top level of a real git worktree (not a stray dir
 * that git would resolve upward to a parent repo). */
async function isWorktreeValid(wtPath: string): Promise<boolean> {
  try {
    if (!existsSync(path.join(wtPath, '.git'))) return false;
    const { stdout } = await exec('git', ['-C', wtPath, 'rev-parse', '--show-toplevel']);
    return path.resolve(stdout.trim()) === path.resolve(wtPath);
  } catch {
    return false;
  }
}
```

The `--show-toplevel === wtPath` comparison is the crux: a hollow dir resolves to `/srv/mission-control`, so toplevel ≠ wtPath → invalid.

New helper to clear a stale/corrupt dir (mirrors `removeWorktree`'s safety ordering, plus a hard delete + prune since a hollow dir is not a registered worktree that `git worktree remove` can clean):

```ts
async function removeStaleWorktreeDir(wtPath: string, repoPath: string): Promise<void> {
  await unlinkNodeModulesLink(wtPath); // never let rm/git recurse into the live node_modules
  await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath]).catch(() => {});
  await rm(wtPath, { recursive: true, force: true }).catch(() => {});
  await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
}
```

(`rm` imported from `node:fs/promises`.)

Change the short-circuit in `ensureWorktree` (currently lines ~87-90):

```ts
  if (existsSync(wtPath)) {
    if (await isWorktreeValid(wtPath)) {
      await linkNodeModules(wtPath, repoPath);
      return { path: wtPath, branch };
    }
    // Stale/corrupt scratch dir (e.g. a hollow dir that would resolve to the
    // parent repo). Remove and recreate — real session work lives on the branch,
    // not the loose dir, so this is safe.
    await removeStaleWorktreeDir(wtPath, repoPath);
  }
```

Execution then falls through to the existing create logic: if `mc/<sessionId>` still exists as a branch, attach the new worktree to it (`git worktree add wtPath branch`); otherwise create it from `baseBranch` (`git worktree add -b branch wtPath baseBranch`). No other changes to `ensureWorktree`.

## Fix B — fault-isolate `getProposals`

Extract the per-row transform into a **pure** function so it is unit-testable (`proposals-data.ts` is `server-only` and cannot load under tsx).

New pure function in `src/lib/proposals.ts`:

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

type DiffFn = (wtPath: string, baseBranch: string) => Promise<{ diff: string; files: Array<{ status: string; path: string }> }>;

/** Build proposals from session rows. Each row is isolated: a worktree whose diff
 * throws (e.g. a broken/hollow dir) is skipped + logged, never fatal to the rest. */
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

`src/lib/proposals-data.ts` keeps only the DB fetch, then delegates:

```ts
export async function getProposals(): Promise<Proposal[]> {
  const rows = await db.select({ /* …unchanged column selection… */ })
    .from(sessions)
    .innerJoin(projects, eq(sessions.project_id, projects.id))
    .where(isNotNull(sessions.worktree_path));
  return collectProposals(rows, diffWorktree);
}
```

Behavior is identical for healthy sessions; the only change is that a throwing session is skipped+logged instead of bubbling up and 500-ing the caller.

## Testing

- **`src/lib/worktree.test.ts` (new, `node:test` via tsx, real git in a temp dir, `WORKTREE_ROOT` overridden to the temp dir):**
  - `isWorktreeValid`: a real worktree → `true`; a hollow dir (`mkdir`, no `.git`) → `false`; a missing path → `false`.
  - `ensureWorktree` fresh: creates a worktree whose `.git` exists and `--show-toplevel === wtPath`.
  - `ensureWorktree` reuse: a second call returns the same path without error and without recreating.
  - `ensureWorktree` heal: pre-create a hollow dir at the worktree path → `ensureWorktree` detects it invalid, removes it, and returns a valid worktree (`.git` present, toplevel === wtPath).
- **`src/lib/proposals.test.ts` (extend):** `collectProposals` with three rows where the middle row's `diff` **throws** → result contains the other two, omits the thrower, and the call does not reject. Also: a row with `files: []` is skipped; ordering is newest-first by `ts`.
- **Effectful glue (`proposals-data.ts`, the `ensureWorktree` wiring):** not unit-tested — verified by `tsc --noEmit` + full suite (no regressions) + a post-deploy runtime check (dashboard 200, notifier quiet).

## Rollout

Subagent-driven TDD on a worktree off `dev` → merge to `dev` → release **v1.8.3** (`dev`→`main`, tag, push) → deploy to the Mini (no new deps, no migrations → `git pull` → `pnpm build` → `systemctl restart`) → confirm `curl /` 200 and no `[discord-notify] tick failed` in the logs.
