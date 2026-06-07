# Task Board Implementation Plan

> **STATUS: ✅ Shipped 2026-06-07** on `feature/task-board` (build clean, 84/84 tests). See the spec's "What actually happened" for the one runtime deviation (dispatch returns the prompt for the client to stream, rather than seeding it server-side).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hybrid Kanban **Task Board** view to Mission Control: operator-created cards that dispatch through Sage, alongside read-only session-level cards that mirror agent work.

**Architecture:** A new `tasks` table holds manual cards. A pure `composeBoard()` helper merges those rows with project sessions into three columns (To-Do / In-Progress / Done); dispatched manual cards dedupe their linked session. Dragging a manual card to In-Progress creates a session + seeds a Sage user message, reusing the existing stream route — no new agent runner. A new `task-board-view.tsx` renders as the third nav view (Task Board is already `live` in the nav config).

**Tech Stack:** Next.js 16 (App Router, route handlers), Drizzle ORM + SQLite, drizzle-kit migrations, zod validation, `@noble/hashes` ids, React client component with native HTML5 drag-and-drop, node:test via tsx.

**Spec:** `docs/superpowers/specs/2026-06-07-task-board-design.md`

---

## File Structure

- **Modify** `src/lib/nav-sections.test.ts` — fix the stale "only live section" assertion (currently failing on `dev`).
- **Modify** `src/db/schema.ts` — add the `tasks` table.
- **Generate** `drizzle/0003_*.sql` — migration for `tasks` (via `pnpm db:generate`).
- **Create** `src/lib/task-board.ts` — pure: types, `composeBoard()`, `buildTaskPrompt()`, `isSessionDone()`. No db / no `server-only` (so it's unit-testable).
- **Create** `src/lib/task-board.test.ts` — unit tests for the pure helpers.
- **Create** `src/lib/task-board-data.ts` — `server-only`: `getTaskBoard(projectId)` (db queries → `composeBoard`).
- **Create** `src/app/api/tasks/route.ts` — `POST` (create card), `GET` (board refresh).
- **Create** `src/app/api/tasks/[id]/route.ts` — `PATCH` (drag / dispatch), `DELETE`.
- **Modify** `src/app/api/projects/[id]/route.ts` — extend the delete cascade to `tasks`.
- **Modify** `src/app/page.tsx` — load `getTaskBoard(project.id)`, pass `initialTaskBoard`.
- **Modify** `src/components/mission-control.tsx` — `initialTaskBoard` prop, board state + refresh, `task-board` view branch.
- **Create** `src/components/task-board-view.tsx` — the Kanban UI.

---

## Task 1: Fix the stale nav-sections test (restore green baseline)

**Files:**
- Modify: `src/lib/nav-sections.test.ts:15-18`

`task-board` and `live-feed` are already `live` in `nav-sections.ts`, but the test still asserts agent-team is the only live section, so `pnpm test` is red. Fix the test to assert agent-team is *among* the live sections and that the live set matches the config, without hard-coding a brittle list.

- [ ] **Step 1: Run the suite to see the existing failure**

Run: `pnpm test`
Expected: FAIL — `✖ Agent Team is the only live section`, `fail 1`.

- [ ] **Step 2: Replace the stale assertion**

Replace lines 15-18 (the `'Agent Team is the only live section'` test) with:

```ts
test('agent-team is live and every soon section stays soon', () => {
  const live = NAV_SECTIONS.filter((s) => s.status === 'live').map((s) => s.id);
  assert.ok(live.includes('agent-team'), 'agent-team is live');
  // Live sections are the ones with a real view wired up.
  assert.deepEqual(live, ['agent-team', 'live-feed', 'task-board']);
});
```

- [ ] **Step 3: Run the suite to verify green**

Run: `pnpm test`
Expected: PASS — `pass 74`, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nav-sections.test.ts
git commit -m "test(nav): live set now includes live-feed + task-board"
```

---

## Task 2: Add the `tasks` table + migration

**Files:**
- Modify: `src/db/schema.ts` (add after the `artifacts` table, before `auth_users`)
- Generate: `drizzle/0003_*.sql`

- [ ] **Step 1: Add the table definition**

In `src/db/schema.ts`, after the `artifacts` table block, add:

```ts
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  // 'todo' | 'in_progress' | 'done' (the board column)
  status: text('status').notNull(),
  // Set when the card is dispatched; links the card to its session run.
  session_id: text('session_id').references(() => sessions.id),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: drizzle-kit prints a new migration file `drizzle/0003_<name>.sql` containing `CREATE TABLE tasks`.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies `0003` with no error (existing data untouched).

- [ ] **Step 4: Verify the build still typechecks**

Run: `pnpm build`
Expected: build completes (the new export is unused so far, which is fine).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(task-board): tasks table + migration"
```

---

## Task 3: Pure board logic (`composeBoard`, `buildTaskPrompt`) — TDD

**Files:**
- Create: `src/lib/task-board.ts`
- Test: `src/lib/task-board.test.ts`

This module is pure (no db, no `server-only`) so the tsx test runner can import it. `ts` fields are emitted as ISO strings so the initial server props and the GET-refresh payload have identical shapes.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/task-board.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBoard, buildTaskPrompt, type TaskRow, type BoardSessionRow } from './task-board';

const D = (s: string) => new Date(s);

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 't1', project_id: 'p1', title: 'A task', description: null,
    status: 'todo', session_id: null,
    created_at: D('2026-06-07T00:00:00Z'), updated_at: D('2026-06-07T00:00:00Z'),
    ...over,
  };
}
function sess(over: Partial<BoardSessionRow>): BoardSessionRow {
  return {
    id: 's1', title: 'A session', status: 'active', project_id: 'p1',
    projectName: 'Proj', updated_at: D('2026-06-07T00:00:00Z'), hasActivity: true,
    ...over,
  };
}

test('a todo task lands in the todo column as a manual card', () => {
  const b = composeBoard([task({ status: 'todo' })], [], 'Proj');
  assert.equal(b.todo.length, 1);
  assert.equal(b.todo[0].origin, 'manual');
  assert.equal(b.todo[0].column, 'todo');
  assert.equal(b.todo[0].ts, '2026-06-07T00:00:00.000Z');
});

test('an in_progress task with no finished session is not ready', () => {
  const b = composeBoard([task({ id: 't2', status: 'in_progress', session_id: 's9' })],
    [sess({ id: 's9', status: 'active' })], 'Proj');
  assert.equal(b.in_progress.length, 1);
  assert.notEqual(b.in_progress[0].ready, true);
});

test('an in_progress task whose session is done is ready for review', () => {
  const b = composeBoard([task({ id: 't3', status: 'in_progress', session_id: 's8' })],
    [sess({ id: 's8', status: 'done' })], 'Proj');
  assert.equal(b.in_progress[0].ready, true);
});

test('a done task lands in the done column', () => {
  const b = composeBoard([task({ id: 't4', status: 'done' })], [], 'Proj');
  assert.equal(b.done.length, 1);
});

test('an unlinked finished session becomes an auto done card', () => {
  const b = composeBoard([], [sess({ id: 'sa', status: 'done' })], 'Proj');
  assert.equal(b.done.length, 1);
  assert.equal(b.done[0].origin, 'auto');
  assert.equal(b.done[0].sessionId, 'sa');
});

test('an unlinked active session with activity becomes an auto in_progress card', () => {
  const b = composeBoard([], [sess({ id: 'sb', status: 'active', hasActivity: true })], 'Proj');
  assert.equal(b.in_progress.length, 1);
  assert.equal(b.in_progress[0].origin, 'auto');
});

test('an idle active session (no activity) is not shown', () => {
  const b = composeBoard([], [sess({ id: 'sc', status: 'active', hasActivity: false })], 'Proj');
  assert.equal(b.in_progress.length, 0);
});

test('a session linked to a manual task is not also an auto card', () => {
  const b = composeBoard(
    [task({ id: 't5', status: 'in_progress', session_id: 'sd' })],
    [sess({ id: 'sd', status: 'active', hasActivity: true })],
    'Proj',
  );
  assert.equal(b.in_progress.length, 1);
  assert.equal(b.in_progress[0].origin, 'manual');
});

test('auto cards never land in the todo column', () => {
  const b = composeBoard([], [
    sess({ id: 'se', status: 'active', hasActivity: true }),
    sess({ id: 'sf', status: 'done' }),
  ], 'Proj');
  assert.equal(b.todo.length, 0);
});

test('buildTaskPrompt appends description when present', () => {
  assert.equal(buildTaskPrompt({ title: 'Do X' }), 'Do X');
  assert.equal(buildTaskPrompt({ title: 'Do X', description: 'with care' }), 'Do X\n\nwith care');
  assert.equal(buildTaskPrompt({ title: '  Do X  ', description: '   ' }), 'Do X');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — cannot find module `./task-board` / `composeBoard is not a function`.

- [ ] **Step 3: Implement the pure module**

Create `src/lib/task-board.ts`:

```ts
// Pure board logic — no db, no server-only, so the tsx test runner can import it.
// `ts` is emitted as an ISO string so initial server props and the GET-refresh
// payload share one shape.

export type TaskColumn = 'todo' | 'in_progress' | 'done';

/** A `tasks` row, as returned by drizzle (timestamps are Date). */
export interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskColumn;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A session reduced to what the board needs, plus a precomputed activity flag. */
export interface BoardSessionRow {
  id: string;
  title: string | null;
  status: string;
  project_id: string;
  projectName: string;
  updated_at: Date;
  hasActivity: boolean; // has at least one agent message
}

export interface TaskCard {
  id: string;
  origin: 'manual' | 'auto';
  title: string;
  description?: string;
  column: TaskColumn;
  ready?: boolean; // manual + in_progress + linked session finished
  projectId: string;
  projectName: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionStatus?: string;
  ts: string; // ISO
}

export interface BoardColumns {
  todo: TaskCard[];
  in_progress: TaskCard[];
  done: TaskCard[];
}

/** Session statuses that count as finished. */
export function isSessionDone(status: string): boolean {
  return status === 'done' || status === 'completed';
}

/** Build the Sage seed prompt for a dispatched card. */
export function buildTaskPrompt(task: { title: string; description?: string | null }): string {
  const title = task.title.trim();
  const desc = task.description?.trim();
  return desc ? `${title}\n\n${desc}` : title;
}

/**
 * Merge manual task rows and project sessions into three columns.
 * - Manual cards are placed by their `status`; `ready` is derived from the linked session.
 * - Auto cards are sessions NOT linked to a manual task that are either finished or active-with-activity.
 *   Active → in_progress, finished → done. Sessions have no todo state, so autos never land in todo.
 */
export function composeBoard(
  tasks: TaskRow[],
  sessions: BoardSessionRow[],
  projectName: string,
): BoardColumns {
  const board: BoardColumns = { todo: [], in_progress: [], done: [] };
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const linkedSessionIds = new Set(tasks.map((t) => t.session_id).filter((id): id is string => !!id));

  for (const t of tasks) {
    const linked = t.session_id ? sessionById.get(t.session_id) : undefined;
    const ready = t.status === 'in_progress' && !!linked && isSessionDone(linked.status);
    board[t.status].push({
      id: t.id,
      origin: 'manual',
      title: t.title,
      description: t.description ?? undefined,
      column: t.status,
      ready: ready || undefined,
      projectId: t.project_id,
      projectName,
      sessionId: t.session_id ?? undefined,
      sessionTitle: linked?.title ?? undefined,
      sessionStatus: linked?.status,
      ts: t.created_at.toISOString(),
    });
  }

  for (const s of sessions) {
    if (linkedSessionIds.has(s.id)) continue;
    const done = isSessionDone(s.status);
    if (!done && !s.hasActivity) continue;
    const column: TaskColumn = done ? 'done' : 'in_progress';
    board[column].push({
      id: `session:${s.id}`,
      origin: 'auto',
      title: s.title || '(untitled session)',
      column,
      projectId: s.project_id,
      projectName: s.projectName,
      sessionId: s.id,
      sessionTitle: s.title ?? undefined,
      sessionStatus: s.status,
      ts: s.updated_at.toISOString(),
    });
  }

  // Newest first within each column.
  for (const key of ['todo', 'in_progress', 'done'] as const) {
    board[key].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  }
  return board;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all new `task-board` tests green, total `pass` increased.

- [ ] **Step 5: Commit**

```bash
git add src/lib/task-board.ts src/lib/task-board.test.ts
git commit -m "feat(task-board): pure composeBoard + buildTaskPrompt with tests"
```

---

## Task 4: Server query `getTaskBoard`

**Files:**
- Create: `src/lib/task-board-data.ts`

- [ ] **Step 1: Implement the server query**

Create `src/lib/task-board-data.ts`:

```ts
import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { tasks, sessions, projects, messages } from '@/db/schema';
import { composeBoard, type TaskRow, type BoardSessionRow, type BoardColumns } from './task-board';

/** Compose the board for one project (v1 scopes to the active project). */
export async function getTaskBoard(projectId: string): Promise<BoardColumns> {
  const project = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);
  const projectName = project?.name ?? projectId;

  const taskRows = (await db.select().from(tasks).where(eq(tasks.project_id, projectId))) as TaskRow[];

  const sessRows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      project_id: sessions.project_id,
      updated_at: sessions.updated_at,
      agentMsgs: sql<number>`(SELECT COUNT(*) FROM ${messages} WHERE ${messages.session_id} = ${sessions.id} AND ${messages.role} = 'agent')`,
    })
    .from(sessions)
    .where(eq(sessions.project_id, projectId));

  const boardSessions: BoardSessionRow[] = sessRows.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    project_id: s.project_id,
    projectName,
    updated_at: s.updated_at,
    hasActivity: Number(s.agentMsgs) > 0,
  }));

  return composeBoard(taskRows, boardSessions, projectName);
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm build`
Expected: build completes (function still unused — fine).

- [ ] **Step 3: Commit**

```bash
git add src/lib/task-board-data.ts
git commit -m "feat(task-board): getTaskBoard server query"
```

---

## Task 5: API routes — create / refresh / drag-dispatch / delete

**Files:**
- Create: `src/app/api/tasks/route.ts`
- Create: `src/app/api/tasks/[id]/route.ts`
- Modify: `src/app/api/projects/[id]/route.ts`

- [ ] **Step 1: Create the collection route (POST + GET)**

Create `src/app/api/tasks/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { tasks, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { getTaskBoard } from '@/lib/task-board-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  project_id: z.string().min(1),
  title: z.string().min(1).max(500),
  description: z.string().max(20_000).optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && (await verifySession(token));
}

export async function GET(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const projectId = new URL(req.url).searchParams.get('project_id');
  if (!projectId) return Response.json({ error: 'project_id required' }, { status: 400 });
  return Response.json(await getTaskBoard(projectId));
}

export async function POST(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid task body' }, { status: 400 });

  const project = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, parsed.data.project_id))
    .limit(1)
    .then((r) => r[0]);
  if (!project) return Response.json({ error: 'Project not found' }, { status: 400 });

  const now = new Date();
  const id = `task_${bytesToHex(randomBytes(8))}`;
  await db.insert(tasks).values({
    id,
    project_id: parsed.data.project_id,
    title: parsed.data.title.trim(),
    description: parsed.data.description?.trim() || null,
    status: 'todo',
    session_id: null,
    created_at: now,
    updated_at: now,
  });
  return Response.json({ ok: true, id });
}
```

- [ ] **Step 2: Create the item route (PATCH + DELETE)**

Create `src/app/api/tasks/[id]/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { tasks, sessions, messages, projects } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { buildTaskPrompt, isSessionDone, type TaskColumn } from '@/lib/task-board';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z.object({
  status: z.enum(['todo', 'in_progress', 'done']).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20_000).optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && (await verifySession(token));
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const task = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1).then((r) => r[0]);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });

  const now = new Date();
  const nextStatus = (parsed.data.status ?? task.status) as TaskColumn;

  // Dispatch trigger: moving into In-Progress with no session yet → create a
  // session + seed a user message for Sage; the existing stream route runs it.
  const shouldDispatch = nextStatus === 'in_progress' && task.status !== 'in_progress' && !task.session_id;

  if (shouldDispatch) {
    try {
      const project = await db
        .select({ default_branch: projects.default_branch })
        .from(projects)
        .where(eq(projects.id, task.project_id))
        .limit(1)
        .then((r) => r[0]);

      const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
      await db.insert(sessions).values({
        id: sessionId,
        project_id: task.project_id,
        title: task.title,
        branch: project?.default_branch ?? 'dev',
        worktree_path: null,
        status: 'active',
        cleared_at: null,
        created_at: now,
        updated_at: now,
      });
      await db.insert(messages).values({
        id: `msg_${bytesToHex(randomBytes(8))}`,
        session_id: sessionId,
        agent_id: null,
        role: 'user',
        content: buildTaskPrompt(task),
        created_at: now,
      });
      await db
        .update(tasks)
        .set({ status: 'in_progress', session_id: sessionId, updated_at: now })
        .where(eq(tasks.id, id));
      return Response.json({ ok: true, sessionId });
    } catch (e) {
      return Response.json(
        { error: `Could not dispatch task: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      );
    }
  }

  // Plain update (drag between columns without a fresh dispatch, or edit fields).
  await db
    .update(tasks)
    .set({
      status: nextStatus,
      title: parsed.data.title?.trim() ?? task.title,
      description:
        parsed.data.description !== undefined ? parsed.data.description.trim() || null : task.description,
      updated_at: now,
    })
    .where(eq(tasks.id, id));

  // Acknowledge whether the linked session is finished (drives "ready for review").
  let sessionDone: boolean | undefined;
  if (task.session_id) {
    const s = await db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, task.session_id))
      .limit(1)
      .then((r) => r[0]);
    sessionDone = s ? isSessionDone(s.status) : undefined;
  }
  return Response.json({ ok: true, sessionDone });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const task = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).limit(1).then((r) => r[0]);
  if (!task) return Response.json({ error: 'Task not found' }, { status: 404 });
  await db.delete(tasks).where(eq(tasks.id, id)); // linked session is kept
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Extend the project-delete cascade to tasks**

In `src/app/api/projects/[id]/route.ts`, add `tasks` to the schema import (line 4) and delete a project's tasks inside the cascade `try` block. Change the import:

```ts
import { projects, sessions, messages, approvals, artifacts, tool_permissions, tasks } from '@/db/schema';
```

Then, inside the `try { ... }` block, before `await db.delete(tool_permissions)...`, add:

```ts
    await db.delete(tasks).where(eq(tasks.project_id, id));
```

- [ ] **Step 4: Verify build + typecheck**

Run: `pnpm build`
Expected: build completes with no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/tasks src/app/api/projects/[id]/route.ts
git commit -m "feat(task-board): tasks API (create/refresh/dispatch/delete) + project cascade"
```

---

## Task 6: Wire the board into the page + mission-control

**Files:**
- Modify: `src/app/page.tsx` (import + load + prop, near lines 10 / 182 / 191)
- Modify: `src/components/mission-control.tsx` (prop, state+helpers, view branch near line 811)

- [ ] **Step 1: Load the board in the page**

In `src/app/page.tsx`, add the import next to the live-feed import (line 10):

```ts
import { getTaskBoard } from "@/lib/task-board-data";
```

After `const liveFeedEvents = await getLiveFeed();` (line 182), add:

```ts
  const initialTaskBoard = await getTaskBoard(project.id);
```

In the `<MissionControl ... />` props (after `initialLiveFeedEvents={liveFeedEvents}`), add:

```tsx
      initialTaskBoard={initialTaskBoard}
```

- [ ] **Step 2: Add the prop + import to mission-control**

In `src/components/mission-control.tsx`, add the imports near the other component/lib imports (e.g., after the `LiveFeedView` import, line 45):

```ts
import TaskBoardView from "@/components/task-board-view";
import type { BoardColumns } from "@/lib/task-board";
```

Add `initialTaskBoard` to the component's props type and destructuring (alongside the existing `initialLiveFeedEvents`):

```ts
  initialTaskBoard,
```
and in the props interface/type:
```ts
  initialTaskBoard: BoardColumns;
```

- [ ] **Step 3: Add board state + refresh + dispatch handlers**

Near the other `useState` hooks (e.g., after `activeSection` at line ~249), add:

```ts
  const [taskBoard, setTaskBoard] = useState<BoardColumns>(initialTaskBoard);

  const refreshTaskBoard = async () => {
    const res = await fetch(`/api/tasks?project_id=${encodeURIComponent(activeProjectId)}`);
    if (res.ok) setTaskBoard((await res.json()) as BoardColumns);
  };

  // A dispatched card focuses its new session in the Agent Team view.
  const handleTaskDispatched = async (sessionId: string) => {
    setActiveSection("agent-team");
    await handleSelectSession(sessionId);
    await refreshTaskBoard();
  };
```

(`activeProjectId` is already a prop; `handleSelectSession` already exists — it's passed to `LiveFeedView`.)

- [ ] **Step 4: Add the view branch**

In `src/components/mission-control.tsx`, replace the existing two-way switch at line 811:

```tsx
        {activeSection === "live-feed" ? (
          <LiveFeedView
```

…by inserting a `task-board` branch immediately before the `live-feed` branch, so the structure becomes:

```tsx
        {activeSection === "task-board" ? (
          <TaskBoardView
            board={taskBoard}
            projectId={activeProjectId}
            onSelectSession={handleSelectSession}
            onDispatched={handleTaskDispatched}
            onRefresh={refreshTaskBoard}
          />
        ) : activeSection === "live-feed" ? (
          <LiveFeedView
            events={liveFeedEvents}
            team={team}
            workingAgents={workingAgents}
            agentActivity={agentActivity}
            onSelectSession={handleSelectSession}
            onApprovalDecision={handleApproval}
          />
        ) : (
          <>
```

(The `: (` and `<>` opening the Agent Team branch stay exactly as they are now — you are only adding the `task-board` ternary in front and keeping the existing `live-feed` block and its props unchanged.)

- [ ] **Step 5: Verify build (will fail until Task 7 creates the component)**

Run: `pnpm build`
Expected: FAIL — `Cannot find module '@/components/task-board-view'`. This is expected; Task 7 creates it. (Do not commit yet.)

---

## Task 7: The Task Board view component

**Files:**
- Create: `src/components/task-board-view.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/task-board-view.tsx`:

```tsx
"use client";

import { useState, type DragEvent } from "react";
import { Plus, Loader2, X, Lock, CircleCheck } from "lucide-react";
import type { BoardColumns, TaskCard, TaskColumn } from "@/lib/task-board";

interface TaskBoardViewProps {
  board: BoardColumns;
  projectId: string;
  onSelectSession: (sessionId: string) => Promise<void>;
  onDispatched: (sessionId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const COLUMNS: { key: TaskColumn; label: string; dot: string }[] = [
  { key: "todo", label: "To-Do", dot: "bg-[#5c6470]" },
  { key: "in_progress", label: "In-Progress", dot: "bg-[#f0a020]" },
  { key: "done", label: "Done", dot: "bg-[#3fb950]" },
];

export default function TaskBoardView({
  board,
  projectId,
  onSelectSession,
  onDispatched,
  onRefresh,
}: TaskBoardViewProps) {
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [overCol, setOverCol] = useState<TaskColumn | null>(null);

  const allCards = [...board.todo, ...board.in_progress, ...board.done];

  async function createTask() {
    const title = newTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, title, description: newDesc.trim() || undefined }),
      });
      setNewTitle("");
      setNewDesc("");
      setAdding(false);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function moveTask(card: TaskCard, to: TaskColumn) {
    if (card.origin !== "manual" || card.column === to) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${card.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      const data = (await res.json().catch(() => ({}))) as { sessionId?: string };
      if (data.sessionId) {
        await onDispatched(data.sessionId);
        return;
      }
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent, to: TaskColumn) {
    e.preventDefault();
    setOverCol(null);
    const id = e.dataTransfer.getData("text/plain");
    const card = allCards.find((c) => c.id === id);
    if (card) void moveTask(card, to);
  }

  return (
    <section className="flex-1 flex flex-col min-w-0 bg-[#0a0e14]">
      <div className="h-11 shrink-0 bg-[#11161d] border-b border-[#1e2632] px-4 flex items-center gap-2 select-none">
        <span className="font-semibold text-xs text-[#e6edf3] font-heading">Task Board</span>
        <span className="text-[10px] font-mono text-[#5c6470]">your cards + live agent work</span>
        {busy && <Loader2 className="w-3.5 h-3.5 text-[#00e0ff] animate-spin ml-1" />}
      </div>

      <div className="flex-1 min-h-0 flex gap-3 p-4 overflow-x-auto">
        {COLUMNS.map((col) => {
          const cards = board[col.key];
          return (
            <div
              key={col.key}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCol(col.key);
              }}
              onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
              onDrop={(e) => onDrop(e, col.key)}
              className={`flex-1 min-w-[260px] max-w-[360px] flex flex-col bg-[#11161d] border rounded-lg ${
                overCol === col.key ? "border-[#00e0ff]/50" : "border-[#1e2632]"
              }`}
            >
              <div className="h-11 px-3 border-b border-[#1e2632] flex items-center gap-2 shrink-0">
                <span className={`w-1.5 h-1.5 rounded-full ${col.dot}`} />
                <span className="text-[10px] font-mono tracking-widest uppercase text-[#8b949e]">{col.label}</span>
                <span className="ml-auto text-[9px] font-mono text-[#5c6470] bg-[#161c25] border border-[#2a3441] rounded px-1.5">
                  {cards.length}
                </span>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2">
                {col.key === "todo" && (
                  <div>
                    {adding ? (
                      <div className="bg-[#161c25] border border-[#2a3441] rounded-lg p-2 flex flex-col gap-2">
                        <input
                          autoFocus
                          value={newTitle}
                          onChange={(e) => setNewTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void createTask();
                            if (e.key === "Escape") setAdding(false);
                          }}
                          placeholder="Task title…"
                          className="bg-[#0a0e14] border border-[#1e2632] rounded px-2 py-1 text-xs text-[#e6edf3] outline-none focus:border-[#00e0ff]/50"
                        />
                        <textarea
                          value={newDesc}
                          onChange={(e) => setNewDesc(e.target.value)}
                          placeholder="Context for Sage (optional)…"
                          rows={2}
                          className="bg-[#0a0e14] border border-[#1e2632] rounded px-2 py-1 text-[11px] text-[#8b949e] outline-none focus:border-[#00e0ff]/50 resize-none"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => void createTask()}
                            disabled={!newTitle.trim() || busy}
                            className="text-[10px] font-mono px-2 py-1 rounded bg-[#00e0ff] text-black font-bold disabled:opacity-40"
                          >
                            Add
                          </button>
                          <button
                            onClick={() => setAdding(false)}
                            className="text-[10px] font-mono px-2 py-1 rounded text-[#8b949e] hover:text-[#e6edf3]"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAdding(true)}
                        className="w-full flex items-center justify-center gap-1 text-[11px] font-mono text-[#5c6470] hover:text-[#00e0ff] border border-dashed border-[#2a3441] hover:border-[#00e0ff]/40 rounded-lg py-2 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" /> New task
                      </button>
                    )}
                  </div>
                )}

                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", card.id)}
                    onOpen={() => card.sessionId && void onSelectSession(card.sessionId)}
                    onDelete={() => void deleteTask(card.id)}
                  />
                ))}

                {cards.length === 0 && col.key !== "todo" && (
                  <div className="text-[10px] font-mono text-[#3a424d] text-center py-6">— empty —</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Card({
  card,
  onDragStart,
  onOpen,
  onDelete,
}: {
  card: TaskCard;
  onDragStart: (e: DragEvent) => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const manual = card.origin === "manual";
  return (
    <div
      draggable={manual}
      onDragStart={manual ? onDragStart : undefined}
      onClick={card.sessionId ? onOpen : undefined}
      className={`group relative rounded-lg border p-2.5 text-xs ${
        manual ? "bg-[#161c25] border-[#2a3441] cursor-grab" : "bg-[#0f141b] border-[#1e2632]"
      } ${card.sessionId ? "hover:border-[#00e0ff]/40" : ""}`}
    >
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[#e6edf3] leading-snug pr-4">{card.title}</span>
        {manual ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete task"
            className="absolute top-2 right-2 text-[#3a424d] hover:text-[#f85149] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : (
          <Lock className="w-3 h-3 text-[#3a424d] shrink-0" />
        )}
      </div>

      {card.description && manual && (
        <p className="mt-1 text-[10px] text-[#8b949e] line-clamp-2">{card.description}</p>
      )}

      <div className="mt-2 flex items-center gap-2 text-[9px] font-mono text-[#5c6470]">
        {card.ready && (
          <span className="flex items-center gap-1 text-[#3fb950]">
            <CircleCheck className="w-3 h-3" /> ready for review
          </span>
        )}
        {!manual && card.sessionStatus && <span>session · {card.sessionStatus}</span>}
        <span className="ml-auto">{manual ? "you" : "auto"}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build + lint + tests**

Run: `pnpm build && pnpm test`
Expected: build completes; `pnpm test` PASS (no new unit tests here; existing suite stays green).

- [ ] **Step 3: Commit (Tasks 6 + 7 together — they compile as a unit)**

```bash
git add src/app/page.tsx src/components/mission-control.tsx src/components/task-board-view.tsx
git commit -m "feat(task-board): Task Board view wired into the nav rail"
```

---

## Task 8: Manual smoke test + gate

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev` (background) and open http://localhost:3000.

- [ ] **Step 2: Walk the flow**

Verify in the browser:
1. Click **Task Board** in the nav rail → the three-column board renders.
2. **+ New task** in To-Do → enter a title (+ optional context) → Add → card appears in To-Do.
3. Drag the card to **In-Progress** → the app switches to the **Agent Team** view focused on a new session whose first message is your task; Sage starts responding.
4. Return to Task Board → the card is in In-Progress and shows the session; other running/done sessions appear as **auto** (locked) cards. The idle default session does NOT show.
5. When the session finishes, the card shows **✓ ready for review**; drag it to **Done**.
6. Hover a manual card → **X** deletes it; auto cards have no delete and open their session on click.

- [ ] **Step 3: Final gate**

Run: `pnpm build && pnpm test`
Expected: build clean; `pnpm test` all green.

- [ ] **Step 4: Commit any smoke-fix follow-ups (if needed), then stop here**

The branch is ready to merge to `dev` per the project's branch workflow.

---

## Self-Review notes (for the executor)

- **Spec coverage:** data model (Task 2) · pure `composeBoard`/`buildTaskPrompt` + tests (Task 3) · `getTaskBoard` (Task 4) · routes incl. dispatch-through-Sage + operator-confirmed Done + guards + project cascade (Task 5) · page/mission-control wiring (Task 6) · view with native DnD, new-task composer, auto vs manual cards, ready-for-review (Task 7) · errors & tests covered in Tasks 3/5/8.
- **Out of scope (do NOT build):** assignee/direct routing, tags, within-column reordering, SSE live board, all-projects toggle.
- **Type consistency:** `TaskColumn`, `TaskRow`, `BoardSessionRow`, `TaskCard` (`ts: string`), `BoardColumns`, `composeBoard`, `buildTaskPrompt`, `isSessionDone`, `getTaskBoard` are used identically across tasks. `hasActivity` is computed in `getTaskBoard` and consumed by `composeBoard`.
</content>
