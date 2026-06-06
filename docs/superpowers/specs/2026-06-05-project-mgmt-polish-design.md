# Remove Project + Resizable Files Panel — Design

**Date:** 2026-06-05
**Branch:** `feature/project-mgmt-polish` (off `dev`)
**Scope:** Two small enhancements: (A) **remove a project** from the switcher (unregister only — never deletes files on disk), and (B) a **resizable Files panel** (drag the tree/viewer split in the File Explorer). Follow-ups requested after the repo-picker smoke.

---

## A. Remove a project

### Current state
- `ProjectSwitcher` (`src/components/project-switcher.tsx`) renders the `PROJECT ▾` dropdown: a list of projects (active one check-marked), each a switch button, plus an "+ Add project" row. No remove control.
- Schema FKs (`src/db/schema.ts`): `sessions.project_id → projects`, `messages.session_id → sessions`, `approvals.session_id → sessions`, `artifacts.session_id → sessions`, `tool_permissions.project_id → projects`. **No `ON DELETE CASCADE`** — children must be deleted first.
- Active project resolves from the `mc_active_project` cookie (`resolveActiveProject`), falling back to the most-recent session's project, then the first project.

### Server — `DELETE /api/projects/[id]`
A new route handler (`src/app/api/projects/[id]/route.ts`, `DELETE`), auth-gated (`SESSION_COOKIE`/`verifySession`, 401):
1. **Refuse the last project:** if there is only one project, return 400 `{ error: 'Cannot remove the only project.' }` (the app needs ≥1).
2. Verify the project exists (404 otherwise).
3. **Manual cascade**, in FK-safe order: gather the project's session ids → delete `messages`, `approvals`, `artifacts` for those sessions → delete the `sessions` → delete the project's `tool_permissions` → delete the `projects` row.
4. **Never touches the repo on disk** (no fs calls — this only unregisters).
5. If the removed id equals the `mc_active_project` cookie, repoint the cookie to `nextActiveProjectId(remaining, removedId, cookieId)` (the first remaining project); otherwise leave the cookie.
6. Return `{ ok: true }`.

### Client
`ProjectSwitcher`: each project row gets a small **trash icon** (visible on row hover). Clicking it (stopPropagation so it doesn't also switch) opens a confirm — a lightweight inline confirm state on that row ("Remove? · yes / cancel") rather than a separate modal — keeping it in the dropdown. Confirm → `DELETE /api/projects/${id}` → on success close the dropdown + `router.refresh()`. The confirm copy notes files on disk are not deleted.

## B. Resizable Files panel

### Current state
`FileExplorer` (`src/components/file-explorer.tsx`) is a flex row: a fixed `w-60` (240px) tree column + a `flex-1` Monaco viewer.

### Change
- Replace the fixed `w-60` with a **state-driven width** (`treeWidth`, px) and a **draggable vertical handle** between the tree and the viewer.
  - On handle `mousedown`, attach `mousemove`/`mouseup` listeners; set `treeWidth = clampTreeWidth(startWidth + dx)`.
  - **Clamp** to `[160, 560]` px (`clampTreeWidth`).
  - **Persist** to `localStorage` under `mc_files_tree_width`; read it on mount (clamped).
  - **Double-click** the handle resets to the default (260px).
- The viewer stays `flex-1`; Monaco's existing `automaticLayout: true` reflows it as the tree resizes. The handle is a thin (`w-1`) draggable bar with a hover highlight and `cursor-col-resize`.

## Pure helpers + tests (`src/lib/ui-helpers.ts`)

No DOM/DB; unit-tested:
- `clampTreeWidth(px: number): number` → clamps to `[160, 560]` (handles NaN → default 260).
- `nextActiveProjectId(projects: { id: string }[], removedId: string, currentActiveId: string | undefined): string | undefined` → if `currentActiveId === removedId`, the first project whose id ≠ removedId (or undefined if none); otherwise `currentActiveId`.

## Data flow

- **Remove:** trash → confirm → `DELETE /api/projects/[id]` (cascade + maybe repoint cookie) → `router.refresh()` → HomePage re-resolves the active project (the removed one is gone; falls back cleanly).
- **Resize:** drag handle → `clampTreeWidth` → `treeWidth` state + `localStorage`; reload restores the saved width.

## Error handling

- Remove the only project → 400, surfaced as an inline error on the row. Unknown id → 404. Cascade runs in a try; any failure → 500 with a message.
- Resize: corrupt/missing `localStorage` value → `clampTreeWidth(NaN)` → default.

## Testing

- **Unit (node:test):** `clampTreeWidth` (below min, above max, in-range, NaN→default); `nextActiveProjectId` (active removed → first other; non-active removed → unchanged; removing the only/last → undefined).
- **Build + manual:** `pnpm build` clean; `pnpm test` green (existing + new). Manual: remove a non-active project (gone from the dropdown, files on disk untouched); remove the **active** project (view repoints to another); confirm the last project can't be removed; drag the Files tree wider/narrower (long filenames fit), reload → width persists, double-click handle → resets.

## Out of scope

Renaming/editing projects, multi-select removal, undo, resizing other workspace panes, deleting repo files on disk.

## What actually happened (2026-06-06)

Shipped on `feature/project-mgmt-polish` (5 tasks; helpers via a subagent, the route + two component rewrites applied directly for speed). Build clean, `pnpm test` **72/72** (68 + 4 new helper tests).

- Implemented per spec: `clampTreeWidth`/`nextActiveProjectId` (tested); `DELETE /api/projects/[id]` (last-project guard, 404, FK-safe manual cascade, active-cookie repoint, no fs); `ProjectSwitcher` per-row trash + inline confirm ("files on disk are kept"); `FileExplorer` draggable splitter (clamped 160–560, `localStorage` persist, double-click reset).
- Operator smoke confirmed: remove non-active / active (repoints) / last-project guard all work; the Files tree resizes, persists across reload, and double-click resets.
