# Session & Branch Management (web) — design

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Context:** Deferred during Discord Phase 3 scoping — the operator cannot create/switch sessions or choose a branch in the web UI (today there is one implicit session per project and the base branch is always the project default). See memory `operating-model-dev-vs-prod`.

## Why / scope

Today the web UI has a project switcher but **no way to list, create, or switch sessions**, and **no branch choice** — sessions always fork `mc/<id>` from `project.default_branch`, and "the active session" is silently whichever row was updated most recently (`getActiveSessionId` = newest `updated_at`). This builds, as **one cohesive feature**:

1. **Sessions:** create, list, and switch sessions within a project (web UI).
2. **Branch choice:** pick the base branch a session forks from, at create time.
3. **Active-context visibility:** a header breadcrumb showing Project ▸ Session ▸ base branch.
4. **Project switching:** verify the existing `ProjectSwitcher` works; fix if broken.

**Decisions locked in brainstorming:**
- **Fork-only branch model:** a session always works on its own `mc/<id>` worktree, forked from a base branch the user picks. No attach-to-existing-branch mode (keeps the isolated-worktree/proposal model and the v1.8.3 hardening intact).
- **Active session is explicit and server-side:** one source of truth per project, shared by web + Discord + scheduler.
- **Worktree creation stays lazy:** a new session is a DB row; its `mc/<id>` worktree materializes on the first turn (as today). No empty worktrees for unused sessions.

**Out of scope (follow-ups):** deleting/archiving sessions; attaching to an existing branch; mirroring session create/switch into Discord (`/mc new-session`, session-switch in chat).

## Data model

Migration `0008` (next after `0007` discord_bindings):

- `projects.active_session_id text` — nullable, the project's current session. Single source of truth for "the current session."
- `sessions.base_branch text` — nullable, the branch this session forks from / diffs against / merges into. Existing rows are null → callers fall back to `project.default_branch`.

No backfill required; null is handled by fallbacks below.

## Active-session resolution

`getActiveSessionId(projectId)` (in `src/lib/discord-session.ts`, used by Discord + scheduler + web) changes from "newest `updated_at`" to:

1. If `projects.active_session_id` is set **and** that session still exists → return it.
2. Else if the project has any session → return the newest by `updated_at` **and** set it as `active_session_id` (self-heals legacy projects).
3. Else create a default session (as today: title `'Discord'` → keep, `base_branch` = `default_branch`) and set it active.

Switching the active session = `UPDATE projects SET active_session_id = ?`. The pure decision logic (which of the three branches applies, given `{ activeId, existingIds, newestId }`) is extracted into a testable helper `resolveActiveSession(...)`; the db reads/writes stay in the server-only function.

## Per-session base branch

A session's base is `session.base_branch ?? project.default_branch ?? 'dev'`. Thread this single expression through every site that currently hardcodes the project default for a session's base:

- `run-turn.ts`: `ensureWorktree(sessionId, repo_path, base)` — pass the session's base (it already accepts the param).
- `proposals-data.ts` → `collectProposals`: already reads `defaultBranch` per row; change the row to carry the session's effective base (select `sessions.base_branch`, coalesce with `projects.default_branch`).
- `proposals/[sessionId]/merge` + `discard` routes and the Discord button handler (`discord-bot.ts handleButton`): use the session's effective base for `mergeWorktree`.

The session's own working branch stays `mc/<id>` (unchanged); only the **base** becomes per-session.

## API

- `GET /api/sessions?projectId=<id>` → `{ sessions: Array<{ id, title, baseBranch, hasChanges, isActive, updatedAt }> }`, newest first. `hasChanges` = `worktree_path != null`. `isActive` = matches `projects.active_session_id`.
- `POST /api/sessions` `{ projectId, title?, baseBranch? }` → creates a session: id `sess_<hex>`, `title` (or auto-fallback `'New session'`), `branch` = `mc/<id>`, `base_branch` = `baseBranch ?? default_branch`, `status` `'active'`, `worktree_path` null. Sets it as the project's `active_session_id`. Returns `{ id }`.
- `GET /api/projects/[id]/branches` → `{ branches: string[], default: string }` — the repo's branches for the base picker (local + de-duped remote-tracking, project default first). Backed by a pure parser over `git branch` output.
- `POST /api/sessions/[id]/active` (repurposed) → set `projects.active_session_id = id` (+ keep setting the `ACTIVE_PROJECT_COOKIE` to the session's project). No longer bumps `updated_at`.

All routes require the auth cookie (mirror the existing routes' `verifySession` guard).

## UI

- **`SessionSwitcher`** (`src/components/session-switcher.tsx`, mirrors `project-switcher.tsx`): a header dropdown listing the active project's sessions (active checkmark, "has changes" dot), a "+ New session" entry that opens a small create dialog, and switch-on-click (`POST /api/sessions/[id]/active` → `router.refresh()`).
- **Create dialog** (`src/components/new-session-dialog.tsx`, mirrors `add-project-dialog.tsx`): an optional title input + a base-branch `<select>` populated from `GET /api/projects/[id]/branches` (default branch preselected). Submit → `POST /api/sessions` → switch to it → refresh.
- **Breadcrumb:** in the top bar next to `ProjectSwitcher`, show **Project ▸ Session ▸ base-branch** for the active context (read on the server in `page.tsx`/layout and passed down).
- **Project switcher:** confirm `switchTo`/`remove` still work end-to-end; fix only if broken (no redesign).

## Error handling

- Create with a `baseBranch` not in the repo → `400 { error }` (validated against the branches list).
- Switching to a session that doesn't exist / isn't in the active project → `404`.
- The branches endpoint on a missing/non-git `repo_path` → `{ branches: [], default }` (never 500; the picker shows just the default).
- Unauthorized on any route → `401` (existing pattern).

## Testing

- **Pure unit tests (`node:test` via tsx):**
  - Branch-list parser: raw `git branch -a` / `--format` output → ordered, de-duped `string[]` with the default first; handles `* current`, `remotes/origin/x`, detached HEAD lines.
  - `resolveActiveSession({ activeId, existingIds, newestId })` → returns the right choice for: valid active id; stale active id (not in existing) → newest; no sessions → "create".
  - Session-create input: title fallback + base-branch defaulting + validation against an allowed-branches list.
- **Effectful (verified by `tsc --noEmit` + full suite + runtime):** migration `0008`, the db reads/writes in `getActiveSessionId`, the four routes, base_branch threading, and the React components. Runtime check on the Mini after deploy: create a session on a chosen base → switch to it → run a turn → the proposal diffs/merges against that base; Discord chat for the project continues the same session.

## Rollout

Subagent-driven or inline TDD on a worktree off `dev` → merge → release (**v1.9.0**, a feature bump) → deploy to the Mini (migration `0008` runs via `pnpm db:migrate`; no new deps) → runtime verification above.
