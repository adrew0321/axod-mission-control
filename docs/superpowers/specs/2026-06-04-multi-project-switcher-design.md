# Multi-Project Switcher (v1.4) — Design

**Date:** 2026-06-04
**Branch:** `feature/multi-project-switcher` (off `dev`)
**Scope:** Make Mission Control work across **multiple projects** (repos): a functional project switcher in the header + an in-app "Add project" form, so the operator can point the agent team at AXOD Creative, Mission Control's own repo, or any local client repo — and switch the active one. Roadmap item **v1.4**.

---

## Current state (what exists)

- `projects` table exists (`id, name, repo_path, github_url, default_branch, created_at`); one row seeded (`axod-creative` → the `landing` repo).
- `sessions` belong to a project (`sessions.project_id`). `messages`/`approvals`/`artifacts` belong to a session.
- `HomePage` (`src/app/page.tsx`) loads the **most-recently-updated session** and derives the project from it. There is no notion of an explicitly "active project."
- The header `PROJECT <name> ▾` ([mission-control.tsx:765-767](src/components/mission-control.tsx#L765-L767)) is a **cosmetic placeholder** — it renders `session.project` with a chevron but has no menu and no behavior.
- Each session runs in its own git worktree created off `project.repo_path` (the stream route's `ensureWorktree`). So switching the active session to a different project automatically targets that project's repo — no runner change needed.

## MVP scope (decided)

**In:** switch between projects (functional dropdown) + add a project in-app + seed Mission Control's own repo as a 2nd project. **One active session per project** (auto-created when missing).

**Out:** per-project session *lists*/history, editing/removing projects, cloning remote repos (the repo must already exist locally), per-project `tool_permissions` seeding (the approval gate is dormant on SDK 0.3.x; `tools_allowlist` is what constrains agents at runtime).

## 1. Active-project persistence — a cookie

The active project is stored in an `mc_active_project` cookie (the project id). Chosen over (a) "touch the latest session so the most-recent query picks it" (fragile — any agent activity changes "most recent", and it doesn't model an explicit selection) and (b) a URL param (adds routing to a single-page app for little gain). The cookie is explicit, survives reloads/restarts, and `HomePage` runs server-side so it can read it directly.

## 2. Active-project resolution (`src/app/page.tsx`)

`HomePage` resolves the active project in this order (via the pure `resolveActiveProject` helper):
1. the cookie's project id, if that project exists;
2. else the project of the most-recently-updated session (today's behavior);
3. else the first project (so a fresh DB still renders).

It then loads that project's most-recently-updated session, **creating one if the project has none** (a server helper `getOrCreateActiveSession(projectId)` inserts a session: `id`, `title: "(new session)"`, `branch: project.default_branch`, `status: "active"`, timestamps). The full `projects` list and the active project are passed into `MissionControl` (new props) for the dropdown.

## 3. Switch project (`POST /api/projects/active`)

Body `{ projectId }`. Verifies the project exists, sets the `mc_active_project` cookie (httpOnly, sameSite=lax, path=/), returns 200 (400 if unknown). Client: the header `PROJECT … ▾` becomes a real menu listing all projects (active one marked), each calling `POST /api/projects/active` then `router.refresh()`. A trailing **"+ Add project"** item opens the add-project modal.

## 4. Add project (`POST /api/projects` + modal form)

Form fields: **Name** (required), **Repo path** (required, absolute local path), **Default branch** (default `dev`), **GitHub URL** (optional).

Route behavior:
1. Validate input shape with the pure `validateNewProjectInput` (name non-empty; repo_path non-empty).
2. Validate on disk: the repo_path **exists, is a directory, and contains a `.git`** entry (a real local git repo). Reject with 400 + message otherwise.
3. `id = slugifyProjectId(name)`; if it collides with an existing id, append `-2`, `-3`, … .
4. Insert the project; create its initial session (`getOrCreateActiveSession`); set the `mc_active_project` cookie to it; return the new project.

Client: a small modal opened from "+ Add project" (own component, e.g. `src/components/add-project-dialog.tsx`). On success → `router.refresh()` (now on the new project). Validation/again errors render inline.

## 5. Seed Mission Control as a 2nd project (`scripts/seed.ts`)

Add a project row alongside `axod-creative`:
```ts
{
  id: 'mission-control',
  name: 'AXOD Mission Control',
  repo_path: process.cwd(),            // seed runs from the repo root
  github_url: 'https://github.com/adrew0321/axod-mission-control',
  default_branch: 'dev',
  created_at: now,
}
```
Gives an out-of-box 2nd project to switch to, and enables dogfooding (dispatch agents to build Mission Control features from inside Mission Control — changes stay isolated on throwaway worktree branches). No `tool_permissions` rows are seeded for it (dormant gate).

## 6. Pure helpers (`src/lib/projects.ts` + `src/lib/projects.test.ts`)

Pure (no DB/fs), unit-tested under `tsx --test`:
- `resolveActiveProject(projects, cookieId, recentSessionProjectId)` → the active project id, applying the fallback order above (returns `undefined` only if `projects` is empty).
- `slugifyProjectId(name)` → lowercase, non-alphanumerics → `-`, trimmed/collapsed.
- `validateNewProjectInput({ name, repoPath, ... })` → `{ ok: true } | { ok: false, error }` (shape only; the filesystem check lives in the route).

## Data flow

- **Switch:** dropdown click → `POST /api/projects/active` (cookie) → `router.refresh()` → `HomePage` resolves the active project from the cookie → loads its session → renders. The next agent run uses that session's worktree (off the new repo).
- **Add:** modal submit → `POST /api/projects` (validate → insert → session → cookie) → `router.refresh()` → new project active.

## Error handling

- Add: invalid input or non-existent/non-git repo path → 400 with a message shown inline in the modal. Duplicate name → id de-duplicated automatically.
- Switch: unknown project id → 400 (the dropdown only offers known ids, so this is a guard).

## Testing

- **Unit (node:test):** `resolveActiveProject` (each fallback branch + empty), `slugifyProjectId` (spaces/punctuation/case/collapse), `validateNewProjectInput` (missing name, missing path, ok).
- **Build + manual:** `pnpm build` clean; `pnpm test` green (existing 54 + new). Manual: switch AXOD Creative ↔ Mission Control (header reflects it, persists across reload); add a project pointing at a real local repo and confirm it becomes active; add with a bad path and confirm the inline error; dispatch an agent and confirm it operates in the switched project's repo.
