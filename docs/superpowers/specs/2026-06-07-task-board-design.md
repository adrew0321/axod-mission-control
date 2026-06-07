# Task Board — design

**Date:** 2026-06-07
**Status:** approved (design)
**Nav section:** `task-board` (currently `soon` → flip to `live`)

## Summary

A hybrid Kanban board for Mission Control, mounted as the **Task Board** view in the
nav rail (the third live view after Agent Team and Live Feed). It combines two card
origins on one board:

- **Manual cards (yours):** tasks you create, drag between columns, and dispatch.
  Dragging a card into **In-Progress** dispatches it **through Sage**, who decides which
  specialist(s) to run. Backed by a new `tasks` table.
- **Auto cards (theirs):** read-only roll-ups of what agents are already doing,
  derived from `sessions` at **session-level** granularity (one card per session).

The board is the point where Mission Control stops being a dashboard you watch and
becomes a surface you direct work from.

## Decisions (locked during brainstorm)

1. **Dispatch routing = through Sage.** A dispatched card seeds a normal user message
   to Sage; Sage picks/coordinates specialists. (So manual cards have **no assignee** —
   dropped from the original mock.)
2. **Auto cards = session-level.** Active session → In-Progress, completed → Done.
   Sessions have no "todo" state, so **auto cards never appear in To-Do**; To-Do is
   purely your backlog.
3. **Done is operator-confirmed.** Session completion marks a card "ready for review"
   (derived, not stored); you drag In-Progress → Done after checking the diff. Fits the
   worktree + diff-review safety model.
4. **Data model = a dedicated `tasks` table** (Approach 1), not artifacts-reuse and not
   dispatch-on-create.

## 1. Data model — new `tasks` table

```
tasks
  id           text PK            task_<hex>
  project_id   text  → projects   NOT NULL   a card always belongs to a project
  title        text               NOT NULL   becomes the Sage prompt
  description  text  nullable                 extra context appended to the prompt
  status       text               NOT NULL    'todo' | 'in_progress' | 'done'  (= column)
  session_id   text  → sessions   nullable    set when dispatched; links card ↔ run
  created_at   integer(ts)        NOT NULL
  updated_at   integer(ts)        NOT NULL
```

- **No assignee column** (dispatch goes through Sage).
- **No stored "review" status** — "ready for review" is derived: `status='in_progress'`
  AND the linked session has finished.
- Tags/labels and within-column drag-reordering are **out of v1** (YAGNI). Ordering
  within a column is by `created_at`.
- Project deletion already cascades manually (no `ON DELETE CASCADE` in this DB); extend
  that cleanup to delete a project's `tasks` first (FK-safe).

## 2. Board query — `src/lib/task-board.ts` (server-only)

`getTaskBoard(projectId?)` returns `{ todo: TaskCard[], in_progress: TaskCard[], done: TaskCard[] }`.

```ts
interface TaskCard {
  id: string;
  origin: 'manual' | 'auto';
  title: string;
  description?: string;
  column: 'todo' | 'in_progress' | 'done';
  ready?: boolean;          // derived: manual, in_progress, session done
  projectId: string;
  projectName: string;
  sessionId?: string;       // manual: when dispatched; auto: the session itself
  sessionTitle?: string;
  sessionStatus?: string;
  agentId?: string;         // auto: the agent on the session, if any
  agentColor?: string;
  ts: Date;                 // created_at (manual) / session updated_at (auto)
}
```

- **Manual cards:** `tasks` rows (filtered by `projectId` when given) → placed by `status`.
  `ready=true` when `status='in_progress'` and the linked session's status is done.
- **Auto cards:** sessions **not referenced by any `task.session_id`** (dedup, so a
  dispatched card is never also an auto card). `active`→`in_progress`, `done`→`done`.
- **Pure core:** the column-composition logic lives in a DB-free helper
  `composeBoard(tasks, sessions)` so it is unit-testable (the repo's pure-helper pattern).
  `getTaskBoard` just does the queries and calls `composeBoard`.

## 3. Dispatch flow + lifecycle — `/api/tasks` routes

All routes are `verifySession`-gated (cookie auth, like the rest of the app).

- `POST /api/tasks` — create a card in **To-Do**. Body `{ project_id, title, description? }`.
- `PATCH /api/tasks/:id` — drag/update. Status transition rules:
  - **To-Do → In-Progress (dispatch):** (a) create a `sessions` row (`status='active'`,
    title from the card, the card's `project_id`); (b) insert a **user** `messages` row
    seeded for Sage via `buildTaskPrompt(task)` (title + optional description); (c) set
    the task's `session_id` and `status='in_progress'`; (d) return `{ sessionId }`. The
    actual agent run happens through the **existing** `GET /api/sessions/:id/stream` route
    when the client connects — no new runner code.
  - **In-Progress → Done:** `status='done'` (operator confirm).
  - **Back-transitions** (Done→In-Progress, In-Progress→To-Do) allowed; the `session_id`
    link is retained for history.
- `DELETE /api/tasks/:id` — remove a card; the linked session (if any) is kept.

**Guards:**
- A card with a live (non-done) `session_id` cannot be re-dispatched.
- Auto cards are read-only — reject PATCH/DELETE for non-`tasks` ids.
- New tasks can only be created in **To-Do** (creating directly in In-Progress would
  require a dispatch; keep the entry point single).

`buildTaskPrompt(task)` is a pure helper: `title` alone, or `title` + `\n\n<description>`.

## 4. UI — `src/components/task-board-view.tsx`

- Rendered when `activeSection === 'task-board'`, a third branch alongside the existing
  Live Feed / Agent Team switch in `mission-control.tsx`. Flip `task-board` to
  `status: 'live'` in `src/lib/nav-sections.ts`.
- **Three columns** (To-Do / In-Progress / Done), themed to match the approved hybrid
  mock: mono + Georgia headings, cyan/amber accents, `h-11` column headers consistent
  with Session Logs / workspace tabs.
- **Drag-and-drop: native HTML5** (`draggable`, `onDragStart`/`onDragOver`/`onDrop`) —
  **no new dependency**. Only `origin:'manual'` cards are draggable; auto cards render
  locked ("driven by agent").
- **`+ New task`:** inline composer in the To-Do column (title + optional description);
  `POST` then optimistic insert.
- Cards reuse `AgentIcon` / agent colors from `mission-control-bits`. Auto cards (and
  dispatched manual cards) show their session + status; clicking opens the session via
  the existing `onSelectSession` handler. A dispatch focuses the new session in the
  Agent Team view, which runs the stream.
- **Live refresh:** board data is provided to `mission-control` like `liveFeedEvents` is
  today; the view refetches on mount, after each mutation (optimistic + reconcile), and
  on a light interval while visible. (SSE for the board is a later enhancement.)
- **Mobile:** desktop-first (the rail is `hidden md:flex`); on mobile the board is
  viewable and DnD degrades to a per-card status `▾` menu.

## 5. Error handling + testing

**Errors / guards:**
- Dispatch failure (session/message insert throws) → `500`; card **stays in To-Do**;
  no orphaned session; inline error surfaced.
- Re-dispatch guard and auto-card read-only guard (above).
- Bad input (empty title, unknown status, missing/nonexistent project) → `400`.
- Project-delete cascade extended to `tasks`.

**Testing** (`node:test` via `tsx`, extensionless imports, pure helpers only):
- `composeBoard(tasks, sessions)` — status→column mapping; dedup of sessions linked to a
  manual task; derived `ready` flag; auto cards never in To-Do.
- `buildTaskPrompt(task)` — seed-message string with/without description.
- DB and route layers stay integration-level (untested), per the repo's convention.

## Out of scope (later)

Assignee/direct-to-specialist routing · per-card tags/labels · within-column reordering ·
SSE-driven live board · cross-project "all projects" aggregation toggle (v1 scopes to the
active project) · bulk actions.
