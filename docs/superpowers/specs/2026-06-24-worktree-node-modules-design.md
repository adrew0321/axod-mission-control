# Working dependencies in session worktrees

**Date:** 2026-06-24
**Status:** Design approved, pending implementation plan

## Problem

Every agent turn that touches a project repo runs inside a per-session git
worktree created by `ensureWorktree` ([src/lib/worktree.ts](../../../src/lib/worktree.ts)).
`git worktree add` produces a fresh checkout of the *tracked* files only — it does
**not** carry `node_modules` (git-ignored, and worktrees don't share it). As a
result, any job that runs `pnpm build` / `pnpm test` inside the worktree fails on
missing dependencies, while read-only jobs (git log/diff, file reads) work fine.

This first bit the unattended **nightly health-check** scheduled job, but the gap
is general: interactive turns, scheduled jobs, and dispatched jobs all go through
`ensureWorktree` ([src/lib/run-turn.ts:164](../../../src/lib/run-turn.ts)), so
"run the tests" from a browser chat fails the same way.

**Scope decision:** fix the root gap for *all* worktree turns, not just scheduled
jobs — it's the same fix and the same cost.

## Approach: link, don't install

Link the worktree's `node_modules` to the project's main checkout rather than
installing or copying.

Considered and rejected:

- **`pnpm install` per worktree** — fully isolated but slow, disk-heavy, and walks
  straight into the project's hardening: under `.npmrc` `ignore-scripts=true`,
  native modules (e.g. `better-sqlite3`) won't rebuild without replicating the
  manual prebuild workaround, so a plain install does not yield a working build.
- **Copy `node_modules`** — slow and disk-heavy per session, no advantage over a link.

Linking is the only option that is both fast and **reuses already-built native
modules**, sidestepping the `ignore-scripts` / prebuild hardening entirely.

## Mechanism

A new best-effort helper in `worktree.ts`:

```
linkNodeModules(worktreePath, repoPath):
  if <repoPath>/node_modules does not exist  -> no-op  (non-Node project / no deps)
  if <worktreePath>/node_modules already exists -> no-op  (idempotent)
  else fs.symlink(absolute <repoPath>/node_modules,
                  <worktreePath>/node_modules, 'junction')
```

- `fs.symlink(target, path, 'junction')` is cross-platform: a **directory junction**
  on Windows (no admin rights required, unlike Windows symlinks) and an ordinary
  symlink on POSIX (the `type` arg is ignored off-Windows).
- Target is an **absolute** path so the junction resolves correctly.
- pnpm's internal `node_modules/.pnpm` relative symlinks resolve correctly *through*
  the junction, and compiled native modules come along for free.

### Call site

Invoke `linkNodeModules` at the end of `ensureWorktree`
([src/lib/worktree.ts:48](../../../src/lib/worktree.ts)), after both the
new-branch and existing-branch creation paths. This single hook covers every
caller — interactive, scheduled, dispatched — automatically.

**Best-effort:** a link failure logs a warning but does **not** throw, so worktree
creation (and read-only jobs) is never regressed.

### Teardown safety (critical)

Before any `git worktree remove`, `removeWorktree`
([src/lib/worktree.ts:71](../../../src/lib/worktree.ts)) must first `lstat`
`<worktree>/node_modules`; if it is a symlink/junction, `unlink` it (remove the
link only, never recurse through it). This guarantees git's recursive delete can
**never** traverse the link into the live app's `node_modules` and wipe it — which,
for the self-hosted case where the project repo IS this app's own live working
directory, would be catastrophic.

`removeWorktree` is the shared teardown path for both `mergeWorktree` and
`discardWorktree`, so fixing it there covers all cases. The temporary merge
worktree (`_merge_<sessionId>`) is created by a direct `git worktree add` and never
gets a `node_modules` link, so it is unaffected.

## Limitations (v1)

- **Root `node_modules` only.** Complete for this single-package app. A pnpm
  workspace with nested `node_modules` is a documented future enhancement.
- **Dependency *changes* are not isolated.** A turn that edits `package.json` and
  runs `pnpm install` mutates the live `node_modules` through the junction.
  Acceptable for v1; a future option is to detect a `package.json` change and swap
  the junction for a real isolated install.
- **Staleness is a non-issue:** worktrees fork from the same branch, so their
  lockfile matches the live install; pnpm won't reinstall on `pnpm test`/`build`.

## Out of scope

- No DB schema or config changes.
- No changes to how jobs are scheduled or dispatched.
- No automatic `pnpm install` fallback (deferred; see limitations).

## Testing

`worktree.ts` is unit-tested via `tsx --test` (no `server-only` guard). New tests,
each against a throwaway temp git repo:

1. **Link works:** seed `<repo>/node_modules/marker.txt`, run `ensureWorktree`,
   assert `<worktree>/node_modules/marker.txt` is readable through the junction.
2. **Idempotent:** calling `ensureWorktree` twice does not error and leaves a valid
   link.
3. **No-op when absent:** a repo with no `node_modules` yields a worktree with no
   link and no throw.
4. **Teardown safety:** after linking, `removeWorktree` deletes the worktree but the
   **source** `<repo>/node_modules/marker.txt` still exists — proving teardown never
   followed the junction.
