# Worktree-abort safeguard — never run an agent outside an isolated worktree

**Date:** 2026-06-26
**Status:** Design approved, pending implementation plan

## Problem

`runSessionTurn` ([src/lib/run-turn.ts](../../../src/lib/run-turn.ts)) currently falls back to
running the agent in `project.repo_path` (or `process.cwd()`) when an isolated worktree can't
be created:

```ts
let workingDir = project?.repo_path ?? process.cwd();
if (project?.repo_path) {
  try {
    const wt = await ensureWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev');
    workingDir = wt.path;
    // …persist + emit worktree…
  } catch (err) {
    emit({ type: 'worktree_error', message: … });   // swallows the error and CONTINUES
  }
}
// …the agent then runs in `workingDir`…
```

If `ensureWorktree` throws — e.g. a stale `repo_path` that doesn't exist on this host — the
catch only logs and the turn proceeds with `workingDir` pointing at the bad path. On the Mini
(2026-06-26 incident) that resolved to the **live app directory** (`/srv/mission-control`, which
is also the `mc` user's home), where the agent ran `git reset --hard` + `git clean -fd` and
**deleted the Claude credentials** (`.claude/`). An agent must NEVER run outside a real,
freshly-created worktree.

## Goal

A turn runs the agent **only** in a successfully-created isolated worktree. If one can't be
created (missing/invalid `repo_path`, or `ensureWorktree` fails for any reason), the turn
**aborts cleanly** with an error — it never falls back to `repo_path` or `process.cwd()`.

## Approach (two layers)

Chosen over the alternatives — (b) fall back to a throwaway temp dir (rejected: still runs an
agent against no real repo and hides the misconfiguration) and (c) validate only in `run-turn`
(rejected: validating in `ensureWorktree` protects every caller — scheduler, Discord, dispatch —
and is the unit-testable layer).

### Layer 1 — `worktree.ts`: fail fast and loud

`ensureWorktree(sessionId, repoPath, baseBranch)` validates `repoPath` **before** any
`git worktree add`:

- If `repoPath` is missing/empty or the directory does not exist → throw
  `Error("repo path does not exist: <repoPath>")`.
- If the directory exists but is not a git repository (no reachable `.git`) → throw
  `Error("not a git repository: <repoPath>")`.

Validation runs on every call, including the early-return path (existing worktree) — though in
practice the existing-worktree short-circuit only triggers when the worktree dir already exists.
Place the check at the top of `ensureWorktree`, before the `existsSync(wtPath)` short-circuit, so
a bad `repoPath` always fails the same way. Detect "is a git repo" with a cheap
`git -C <repoPath> rev-parse --is-inside-work-tree` (already using `execFile` argv style).

These are pure-git/fs and **unit-testable** in `src/lib/worktree.test.ts`.

### Layer 2 — `run-turn.ts`: require a worktree, abort otherwise

Replace the swallow-and-continue block with:

- If `project?.repo_path` is falsy → emit `{ type: 'error', message: 'no repo configured for this project — cannot run a turn' }` and `return { status: 'error', reason: 'no repo_path' }`.
- Else `await ensureWorktree(...)` inside a try; on success set `workingDir = wt.path` (+ persist `worktree_path`, emit `worktree`). On throw → emit `{ type: 'error', message: 'could not prepare an isolated worktree: <err>' }` and `return { status: 'error', reason: … }`.

`workingDir` is therefore assigned **only** from a successful `ensureWorktree` — it is never
`project.repo_path` and never `process.cwd()`. The agent (and the dispatch server) run only after
this point, so they always get a real worktree.

The abort happens inside the existing `try` (after the instruction is persisted and the lease is
held), so the existing `finally` still releases the lease. The emitted `error` reaches whatever
sink is attached (browser SSE, the Discord sink → "⚠️ turn failed: …", the scheduler → records
an `error` status), so the operator sees a clear failure instead of silent damage.

## Out of scope

- Auto-repairing bad `repo_path`s (a separate data concern; the operator fixes the project).
- Moving the `mc` user's HOME off the repo dir (noted as a follow-up; not this change).
- Changing how worktrees are placed or cleaned up.

## Testing

- **Unit (`worktree.test.ts`, `node:test` via tsx):**
  - `ensureWorktree` throws "repo path does not exist" for a nonexistent path.
  - `ensureWorktree` throws "not a git repository" for an existing dir that isn't a git repo
    (e.g. a fresh `mkdtemp` with no `git init`).
  - `ensureWorktree` still succeeds for a valid repo (existing test continues to pass) and the
    teardown-safety test is unaffected.
- **`run-turn.ts`** is `server-only` (imports DB/SDK), so not unit-testable under the runner —
  verified by `tsc --noEmit` + the full suite (no regressions), plus a manual check: point a
  project at a nonexistent path, trigger a turn, confirm it returns `error` with the clear
  message and the agent does **not** run (nothing executes in the live dir / cwd).
