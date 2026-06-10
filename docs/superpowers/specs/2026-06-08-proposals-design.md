# Proposals view — design

**Date:** 2026-06-08
**Status:** approved (design)
**Nav section:** `proposals` (currently `soon` → flip to `live`)

## Summary

A **review-and-merge inbox**: the operational nav view that lists every session whose
agent left changes you haven't merged yet, and lets you **Approve → merge** those changes
into the project's base branch (or **Discard** them) without leaving Mission Control.

This fills a real gap: agents edit on a throwaway `mc/<session>` worktree branch, and today
you can *view* the diff (Code Diff tab) but there's **no in-app way to apply that work** to
the real branch. Proposals adds that.

## Why this, not an approvals inbox

The backlog imagined Proposals as a pending-tool-**approvals** inbox. That data does not
exist: `createPendingApproval`/`waitForDecision` (`src/lib/permissions.ts`) are never called
because the SDK's `canUseTool` gate is dormant (see `agent-runner-sdk.ts` + the
`approval-gate-deferred` memory). An approvals inbox would always be empty. The
review-and-merge framing uses data that actually exists (worktree diffs) and delivers the
operator's real human-in-the-loop step.

## Decisions (locked during brainstorm)

1. **Approve = merge into the base branch locally** (not push-for-PR). Commit any loose
   edits on `mc/<session>`, then merge into the project's default branch in the local repo.
2. **Fleet-wide inbox** (all projects, like Live Feed) — each card carries its project.
3. **Discard requires confirmation** (it throws away work).
4. **After a successful merge**, the worktree and `mc/<session>` branch are cleaned up.

## 1. What a proposal is

Any session that (a) has a `worktree_path` and (b) has a non-empty diff of that worktree
against its project's base branch (`project.default_branch`, default `dev`). `diffWorktree`
already captures both committed and uncommitted edits, which is exactly "what the agent
changed this session."

## 2. Query — `src/lib/proposals.ts` (server-only)

`getProposals(): Promise<Proposal[]>` — for every session with a `worktree_path`, join its
project, run `diffWorktree(worktree_path, project.default_branch)`, and for each non-empty
result emit:

```ts
interface Proposal {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  branch: string;          // mc/<session>
  baseBranch: string;      // project.default_branch
  files: Array<{ status: string; path: string }>;
  additions: number;
  deletions: number;
  ts: string;              // session.updated_at, ISO
}
```

- The added/removed counts come from a **pure** helper `summarizeDiff(diff: string)` (parses
  `+`/`-` lines of a unified diff) — no DB/git, unit-tested.
- Sorted newest-first by `ts`.
- Bounded cost: only sessions with a worktree are diffed (a handful in practice).

## 3. Git actions — extend `src/lib/worktree.ts`

```ts
type MergeResult = { ok: true } | { ok: false; conflict: true; message: string };

// Commit loose edits on mc/<session>, then merge --no-ff into baseBranch in the project
// repo. On conflict: `git merge --abort`, return { conflict }. On success: remove the
// worktree + delete the branch. Returns MergeResult.
mergeWorktree(sessionId, repoPath, baseBranch): Promise<MergeResult>

// Remove the worktree (existing removeWorktree) AND delete the mc/<session> branch.
discardWorktree(sessionId, repoPath): Promise<void>
```

Merge sequence (all via `git -C`):
1. In the worktree: if `git status --porcelain` is non-empty → `git add -A` +
   `git commit -m "mission-control: <session title>"`.
2. In the project repo: `git checkout <baseBranch>` → `git merge --no-ff mc/<session>`.
3. On non-zero merge exit → `git merge --abort`; return `{ ok:false, conflict:true, message }`.
4. On success → `removeWorktree` + `git branch -D mc/<session>`; return `{ ok:true }`.

Discard = `removeWorktree` + `git branch -D mc/<session>` (no merge).

## 4. Routes (all `verifySession`-gated, `runtime='nodejs'`)

- `GET /api/proposals` → `getProposals()` (fleet-wide inbox JSON).
- `POST /api/proposals/[sessionId]/merge` → loads the session + project, calls
  `mergeWorktree`; returns `{ ok:true }` or `{ ok:false, conflict:true, message }` (200 with
  the conflict flag so the UI can render it; 404 if session/worktree missing; 500 on other
  git error).
- `POST /api/proposals/[sessionId]/discard` → `discardWorktree`; `{ ok:true }`.

## 5. UI — `src/components/proposals-view.tsx`

- Rendered when `activeSection === "proposals"` — a new branch in `mission-control.tsx`
  alongside the Live Feed / Task Board / Agent Team switch. Flip `proposals` → `status:'live'`
  in `src/lib/nav-sections.ts` and update the nav test (live set becomes
  `['agent-team','live-feed','task-board','proposals']`).
- Server data loaded in `page.tsx` as `initialProposals`, passed as a prop, mirrored into
  state with a sync effect (same pattern as `taskBoard`/`liveFeedEvents`).
- Each **card**: session title · project tag · `+N −M · k files` · actions
  **[View diff] [Approve → merge] [Discard]**.
  - **View diff** → `onSelectSession(sessionId)` (opens the session; operator reviews in the
    existing Code Diff tab) — reuses the handler already threaded for Live Feed/Task Board.
  - **Approve** → POST merge; spinner; on `ok` the card disappears (refetch); on `conflict`
    show the message inline on the card.
  - **Discard** → confirm inline ("Discard N changes? This can't be undone") → POST discard → refetch.
- Empty state: "No changes awaiting review."
- Refetch on mount + after each action (`GET /api/proposals`). Themed to match the app
  (mono + Georgia, `h-11` header, cyan/amber accents).

## 6. Error handling

- **Merge conflict** → aborted (no partial merge); card stays; inline "Merge conflict —
  resolve manually" with the branch name.
- **Base branch dirty / checked out elsewhere** → the `git checkout`/`merge` error is
  surfaced as a 500 with the message; card stays.
- **Missing worktree** (already merged/removed) → treated as no-op; the card drops on the
  next refetch.
- **Discard** is guarded by an inline confirm (irreversible).

## 7. Testing

- **Pure** `summarizeDiff(diff)` unit tests (`src/lib/proposals.test.ts`): counts `+`/`-`
  content lines, ignores `+++`/`---` headers and hunk markers; empty diff → `{0,0}`.
- Git (`mergeWorktree`/`discardWorktree`) and routes stay integration-level (manual smoke),
  per the repo convention.
- nav-sections test updated for the new live section.

## Out of scope (later)

Push-for-PR · per-file/partial merge · in-app conflict resolution · re-running a session
after a conflict · the dormant tool-approvals gate · auto-merge policies.

## What actually happened (2026-06-08/09)

Shipped on `feature/proposals` (subagent-driven for the core, inline for wiring/fixes). Build
clean, `pnpm test` **87/87** (84 + 3 `summarizeDiff`). Implemented per spec, plus three things
the smoke test forced:

- **Merge must not hijack the operator's working tree.** The first cut did `git checkout dev`
  in the project repo — fatal for the self-hosted "mission-control manages its own repo" case,
  where that repo IS this app's live working directory. Approving a proposal yanked the running
  app off `feature/proposals` onto `dev`. Fixed: `mergeWorktree` now merges in an **isolated
  temp worktree** (or wherever the base is already checked out) and **never `git checkout`s** in
  the project repo. Recorded in memory `self-hosted-repo-is-live-dir`.
- **A stale, uncheckpointed WAL caused blanket session 404s.** `data/mission-control.db` (main
  file) was old while every recent session lived in a 2.8 MB `-wal`; a connection that didn't map
  the WAL read only the stale main file → "session not found" on every route. Fixed by
  checkpointing the WAL into the main DB and pinning `DATABASE_PATH` to an **absolute** path
  (which the deploy spec already mandates for prod). Not a code change — an environment fix.
- **Notifications added** (operator request, options 1–3): an amber count **badge** on the
  Proposals nav item (dot when collapsed), a **`(N)` tab-title** count, and a bottom-right
  **toast** when a new proposal arrives while you're elsewhere. Event-driven off the existing
  `proposals` state (no polling); suppressed on the Proposals view and on initial load. The
  `NavSidebar` gained a generic `counts: Record<string, number>` prop for future reuse.
