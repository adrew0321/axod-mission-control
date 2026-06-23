# Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator define recurring agent tasks that fire on a cadence with no browser, by polling due `schedules` in-process and running each through `runSessionTurn`.

**Architecture:** A pure cadence module (`schedule.ts`) computes next-run times. A server-only ticker (`scheduler.ts`), started at server boot via `src/instrumentation.ts`, polls the `schedules` table every 60s and fires due rows through the existing `runSessionTurn` (fresh session per fire). CRUD API routes + a `SchedulerView` give the operator a full create/list/toggle/delete UI.

**Tech Stack:** Next.js 16 (vendored, Turbopack), TypeScript, drizzle-orm + better-sqlite3, the Claude Agent SDK (via `runSessionTurn`), `node:test` via `tsx`, zod, Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-21-scheduler-design.md`.

## Global Constraints

- **Imports are extensionless** (`from '@/lib/...'`, `from './schedule'`); a `.ts` extension breaks `tsc`/`next build`.
- **Server-only modules** (`scheduler.ts`, `schedules-data.ts`, route handlers, `run-turn.ts`) import `'server-only'` and are NOT unit-tested (it throws under `node:test`). Only pure `schedule.ts` gets unit tests.
- **Tests:** `pnpm test` runs `tsx --test src/lib/*.test.ts`. After every task: `pnpm test` stays green AND `pnpm build` passes before committing.
- **Timezone:** all `HH:MM` cadence times are interpreted in the host's **local** time (server-local). Tests must construct and assert with local-time `Date`s so they're tz-independent.
- **IDs:** `sched_${bytesToHex(randomBytes(4))}` and `sess_${bytesToHex(randomBytes(4))}` via `@noble/hashes/utils.js` (matches existing code).
- **Cookie auth** on every route: reuse the `SESSION_COOKIE` + `verifySession` pattern from `src/app/api/tasks/[id]/route.ts`.

## Notes for the implementer (read first)

- **Isolation:** Work in an isolated worktree on a `feature/scheduler` branch (this repo is the live app dir — don't branch-switch it in place). Create it via `superpowers:using-git-worktrees` before Task 1; base it on current `dev` HEAD. Merge to `dev` when done.
- **Fresh-worktree env gotchas (seen on the last two features):** after `pnpm install`, copy the better-sqlite3 native binding into the worktree — `cp` the main repo's `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node` into the same path in the worktree — and `mkdir -p data/worktrees` before `pnpm build`/`db:migrate`. Do NOT run `pnpm approve-builds` (`.npmrc` `ignore-scripts=true` is intentional). Revert any `pnpm-workspace.yaml` change `pnpm install` auto-writes.

## File Structure

- **Create** `src/lib/schedule.ts` — pure: `Cadence` type, `computeNextRun`, `summarizeCadence`, `parseCadence`, `cadenceColumns`. No DB, no `server-only`. Unit-tested.
- **Create** `src/lib/schedule.test.ts` — `node:test` unit tests.
- **Modify** `src/db/schema.ts` — add the `schedules` table (+ generated migration under `drizzle/`).
- **Create** `src/lib/schedules-data.ts` — `getSchedules()` (server-only) → serializable `ScheduleRow[]` for the page.
- **Create** `src/lib/scheduler.ts` — `startScheduler()` + `tick()` (server-only).
- **Create** `src/instrumentation.ts` — Next boot hook → `startScheduler()`.
- **Create** `src/app/api/schedules/route.ts` — `GET` (list) + `POST` (create).
- **Create** `src/app/api/schedules/[id]/route.ts` — `PATCH` (toggle/edit) + `DELETE`.
- **Create** `src/components/scheduler-view.tsx` — the operator UI.
- **Modify** `src/lib/nav-sections.ts` — flip `scheduler` `soon` → `live`.
- **Modify** `src/app/page.tsx` — fetch `getSchedules()`, pass `initialSchedules`.
- **Modify** `src/components/mission-control.tsx` — import + render `SchedulerView` for `activeSection === "scheduler"`.

---

## Task 1: Pure cadence module (TDD)

**Files:**
- Create: `src/lib/schedule.ts`
- Test: `src/lib/schedule.test.ts`

**Interfaces:**
- Produces: `Cadence` (discriminated union), `computeNextRun(cadence: Cadence, from: Date): Date`, `summarizeCadence(cadence: Cadence): string`, `parseCadence(row): Cadence`, `cadenceColumns(cadence: Cadence): { cadence_kind: string; interval_hours: number | null; time_of_day: string | null; day_of_week: number | null }`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/schedule.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRun,
  summarizeCadence,
  parseCadence,
  cadenceColumns,
  type Cadence,
} from "./schedule";

// All local-time Dates so the asserts are timezone-independent.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0, 0);

test("every_hours: from + N hours", () => {
  const next = computeNextRun({ kind: "every_hours", intervalHours: 4 }, at(2026, 5, 21, 10, 0));
  assert.equal(next.getTime(), at(2026, 5, 21, 14, 0).getTime());
});

test("daily: later today when time is still ahead", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 1, 30));
  assert.equal(next.getTime(), at(2026, 5, 21, 9, 0).getTime());
});

test("daily: rolls to tomorrow when time already passed", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 10, 0));
  assert.equal(next.getTime(), at(2026, 5, 22, 9, 0).getTime());
});

test("daily: equal time rolls forward (strictly after)", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 9, 0));
  assert.equal(next.getTime(), at(2026, 5, 22, 9, 0).getTime());
});

test("weekly: advances to the right weekday at the time", () => {
  // 2026-06-21 is a Sunday (getDay()===0). Target Wednesday (3) at 09:00.
  const next = computeNextRun({ kind: "weekly", dayOfWeek: 3, timeOfDay: "09:00" }, at(2026, 5, 21, 12, 0));
  assert.equal(next.getDay(), 3);
  assert.equal(next.getTime(), at(2026, 5, 24, 9, 0).getTime());
});

test("weekly: same weekday but time passed → next week", () => {
  // Sunday target, from is Sunday 12:00 with 09:00 time → +7 days.
  const next = computeNextRun({ kind: "weekly", dayOfWeek: 0, timeOfDay: "09:00" }, at(2026, 5, 21, 12, 0));
  assert.equal(next.getTime(), at(2026, 5, 28, 9, 0).getTime());
});

test("summarizeCadence renders each kind", () => {
  assert.equal(summarizeCadence({ kind: "every_hours", intervalHours: 1 }), "Every 1 hour");
  assert.equal(summarizeCadence({ kind: "every_hours", intervalHours: 4 }), "Every 4 hours");
  assert.equal(summarizeCadence({ kind: "daily", timeOfDay: "09:00" }), "Daily at 09:00");
  assert.equal(summarizeCadence({ kind: "weekly", dayOfWeek: 1, timeOfDay: "09:00" }), "Weekly on Mon at 09:00");
});

test("parseCadence ↔ cadenceColumns round-trip", () => {
  const cases: Cadence[] = [
    { kind: "every_hours", intervalHours: 6 },
    { kind: "daily", timeOfDay: "23:30" },
    { kind: "weekly", dayOfWeek: 5, timeOfDay: "08:15" },
  ];
  for (const c of cases) {
    const cols = cadenceColumns(c);
    assert.deepEqual(parseCadence(cols), c);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `./schedule` not found / exports missing.

- [ ] **Step 3: Write the module**

Create `src/lib/schedule.ts`:

```ts
// Pure cadence helpers for the Scheduler: next-run math, UI summary, and
// flat-column <-> Cadence conversion. No DB, no server-only — unit-testable.
// All HH:MM times are interpreted in the host's LOCAL timezone.

export type Cadence =
  | { kind: "every_hours"; intervalHours: number }
  | { kind: "daily"; timeOfDay: string } // "HH:MM"
  | { kind: "weekly"; dayOfWeek: number; timeOfDay: string }; // 0=Sun..6=Sat

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Next occurrence strictly after `from`, in the host's local time. */
export function computeNextRun(cadence: Cadence, from: Date): Date {
  if (cadence.kind === "every_hours") {
    return new Date(from.getTime() + cadence.intervalHours * 3_600_000);
  }
  const [h, m] = cadence.timeOfDay.split(":").map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0); // local time; setHours/setDate are DST-safe
  if (cadence.kind === "daily") {
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  const dayDiff = (cadence.dayOfWeek - next.getDay() + 7) % 7;
  if (dayDiff > 0) next.setDate(next.getDate() + dayDiff);
  if (next <= from) next.setDate(next.getDate() + 7);
  return next;
}

/** Human label for the UI, e.g. "Daily at 09:00". */
export function summarizeCadence(cadence: Cadence): string {
  if (cadence.kind === "every_hours") {
    return `Every ${cadence.intervalHours} hour${cadence.intervalHours === 1 ? "" : "s"}`;
  }
  if (cadence.kind === "daily") return `Daily at ${cadence.timeOfDay}`;
  return `Weekly on ${DAYS[cadence.dayOfWeek]} at ${cadence.timeOfDay}`;
}

/** Build a Cadence from the flat DB columns. */
export function parseCadence(row: {
  cadence_kind: string;
  interval_hours: number | null;
  time_of_day: string | null;
  day_of_week: number | null;
}): Cadence {
  if (row.cadence_kind === "every_hours") {
    return { kind: "every_hours", intervalHours: row.interval_hours ?? 1 };
  }
  if (row.cadence_kind === "daily") {
    return { kind: "daily", timeOfDay: row.time_of_day ?? "09:00" };
  }
  return { kind: "weekly", dayOfWeek: row.day_of_week ?? 1, timeOfDay: row.time_of_day ?? "09:00" };
}

/** Flatten a Cadence into the DB columns. */
export function cadenceColumns(cadence: Cadence): {
  cadence_kind: string;
  interval_hours: number | null;
  time_of_day: string | null;
  day_of_week: number | null;
} {
  return {
    cadence_kind: cadence.kind,
    interval_hours: cadence.kind === "every_hours" ? cadence.intervalHours : null,
    time_of_day: cadence.kind === "every_hours" ? null : cadence.timeOfDay,
    day_of_week: cadence.kind === "weekly" ? cadence.dayOfWeek : null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all `schedule` tests green; existing suite unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule.ts src/lib/schedule.test.ts
git commit -m "feat(scheduler): pure cadence module (next-run, summary, columns)"
```

---

## Task 2: `schedules` table + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: a generated migration under `drizzle/`

**Interfaces:**
- Produces: the `schedules` drizzle table (columns per the spec).

- [ ] **Step 1: Add the table**

In `src/db/schema.ts`, after the `tasks` table definition (it already imports `sqliteTable, text, integer`), add:

```ts
export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  title: text('title').notNull(),
  instruction: text('instruction').notNull(),
  // Cadence (friendly presets). cadence_kind: 'every_hours' | 'daily' | 'weekly'.
  cadence_kind: text('cadence_kind').notNull(),
  interval_hours: integer('interval_hours'), // every_hours
  time_of_day: text('time_of_day'), // 'HH:MM' (daily/weekly), server-local
  day_of_week: integer('day_of_week'), // 0=Sun..6=Sat (weekly)
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // The column the ticker queries: when this schedule next becomes due.
  next_run_at: integer('next_run_at', { mode: 'timestamp' }).notNull(),
  last_run_at: integer('last_run_at', { mode: 'timestamp' }),
  last_status: text('last_status'), // 'ok' | 'error' | 'skipped'
  last_session_id: text('last_session_id').references(() => sessions.id),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0005_*.sql` (number may differ) with `CREATE TABLE \`schedules\``.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: "migrations applied successfully".

- [ ] **Step 4: Verify the table + build**

Run:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log(db.prepare('PRAGMA table_info(schedules)').all().map(c=>c.name).join(', '));db.close();"
```
Expected: lists `id, project_id, title, instruction, cadence_kind, interval_hours, time_of_day, day_of_week, enabled, next_run_at, last_run_at, last_status, last_session_id, created_at, updated_at`.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(scheduler): schedules table + migration"
```

---

## Task 3: Server fetch helper `getSchedules`

**Files:**
- Create: `src/lib/schedules-data.ts`

**Interfaces:**
- Consumes: `schedules` table (Task 2); `parseCadence`, `summarizeCadence` (Task 1).
- Produces: `ScheduleRow` interface + `getSchedules(): Promise<ScheduleRow[]>`.

- [ ] **Step 1: Create the file**

Create `src/lib/schedules-data.ts`:

```ts
import 'server-only';
import { desc } from 'drizzle-orm';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import { parseCadence, summarizeCadence } from '@/lib/schedule';

/** Serializable schedule shape for the client (Dates → ISO strings). */
export interface ScheduleRow {
  id: string;
  projectId: string;
  title: string;
  instruction: string;
  cadenceKind: string;
  intervalHours: number | null;
  timeOfDay: string | null;
  dayOfWeek: number | null;
  cadenceSummary: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastSessionId: string | null;
}

export async function getSchedules(): Promise<ScheduleRow[]> {
  const rows = await db.select().from(schedules).orderBy(desc(schedules.created_at));
  return rows.map((s) => ({
    id: s.id,
    projectId: s.project_id,
    title: s.title,
    instruction: s.instruction,
    cadenceKind: s.cadence_kind,
    intervalHours: s.interval_hours,
    timeOfDay: s.time_of_day,
    dayOfWeek: s.day_of_week,
    cadenceSummary: summarizeCadence(parseCadence(s)),
    enabled: s.enabled,
    nextRunAt: s.next_run_at ? s.next_run_at.toISOString() : null,
    lastRunAt: s.last_run_at ? s.last_run_at.toISOString() : null,
    lastStatus: s.last_status,
    lastSessionId: s.last_session_id,
  }));
}
```

- [ ] **Step 2: Typecheck / build**

Run: `pnpm build`
Expected: PASS.

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/lib/schedules-data.ts
git commit -m "feat(scheduler): getSchedules server fetch helper"
```

---

## Task 4: The ticker + boot hook

**Files:**
- Create: `src/lib/scheduler.ts`
- Create: `src/instrumentation.ts`

**Interfaces:**
- Consumes: `schedules`, `sessions`, `projects` tables; `computeNextRun`, `parseCadence` (Task 1); `runSessionTurn` (existing `src/lib/run-turn.ts`).
- Produces: `startScheduler(): void`, `tick(): Promise<void>`.

- [ ] **Step 1: Create the ticker**

Create `src/lib/scheduler.ts`:

```ts
import 'server-only';
import { and, eq, lte } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { schedules, sessions, projects } from '@/db/schema';
import { runSessionTurn } from '@/lib/run-turn';
import { computeNextRun, parseCadence } from '@/lib/schedule';

const TICK_MS = 60_000;

/**
 * Start the in-process scheduler. Idempotent: a globalThis flag survives Next's
 * dev/HMR re-imports so the ticker is only ever started once per process.
 */
export function startScheduler(): void {
  const g = globalThis as unknown as { __mcSchedulerStarted?: boolean };
  if (g.__mcSchedulerStarted) return;
  g.__mcSchedulerStarted = true;
  void tick(); // run once at boot, then on the interval
  setInterval(() => void tick(), TICK_MS);
  console.log('[scheduler] started (60s tick)');
}

/**
 * One poll: fire every enabled schedule whose next_run_at has passed. Each job's
 * next_run_at is advanced BEFORE it runs so a slow run / the next tick can't
 * double-fire it. Errors are caught per-job; the tick itself never throws.
 */
export async function tick(): Promise<void> {
  const now = new Date();
  let due: typeof schedules.$inferSelect[];
  try {
    due = await db
      .select()
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.next_run_at, now)));
  } catch (err) {
    console.error('[scheduler] due query failed:', err instanceof Error ? err.message : err);
    return;
  }

  for (const s of due) {
    try {
      const cadence = parseCadence(s);
      // Advance first — guards against double-fire on a slow run / next tick.
      await db
        .update(schedules)
        .set({ next_run_at: computeNextRun(cadence, now), updated_at: new Date() })
        .where(eq(schedules.id, s.id));

      const project = await db
        .select({ default_branch: projects.default_branch })
        .from(projects)
        .where(eq(projects.id, s.project_id))
        .limit(1)
        .then((r) => r[0]);

      const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
      const ts = new Date();
      await db.insert(sessions).values({
        id: sessionId,
        project_id: s.project_id,
        title: s.title,
        branch: project?.default_branch ?? 'dev',
        worktree_path: null,
        status: 'active',
        cleared_at: null,
        created_at: ts,
        updated_at: ts,
      });

      const result = await runSessionTurn(sessionId, { instruction: s.instruction });
      const last_status =
        result.status === 'completed' ? 'ok' : result.status === 'skipped' ? 'skipped' : 'error';
      await db
        .update(schedules)
        .set({ last_run_at: new Date(), last_session_id: sessionId, last_status, updated_at: new Date() })
        .where(eq(schedules.id, s.id));
    } catch (err) {
      console.error(`[scheduler] schedule ${s.id} failed:`, err instanceof Error ? err.message : err);
      try {
        await db
          .update(schedules)
          .set({ last_run_at: new Date(), last_status: 'error', updated_at: new Date() })
          .where(eq(schedules.id, s.id));
      } catch {
        /* best-effort */
      }
    }
  }
}
```

- [ ] **Step 2: Create the boot hook**

Create `src/instrumentation.ts`:

```ts
// Next.js startup hook (runs once per server process). Starts the in-process
// Scheduler ticker. Guarded to the Node runtime (not Edge); startScheduler is
// itself idempotent so dev/HMR re-registration is safe.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
  }
}
```

- [ ] **Step 3: Typecheck / build**

Run: `pnpm build`
Expected: PASS. (If `typeof schedules.$inferSelect[]` is flagged by the linter as needing `Array<...>`, change the annotation to `(typeof schedules.$inferSelect)[]`.)

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/lib/scheduler.ts src/instrumentation.ts
git commit -m "feat(scheduler): in-process ticker + instrumentation boot hook"
```

---

## Task 5: CRUD API routes

**Files:**
- Create: `src/app/api/schedules/route.ts`
- Create: `src/app/api/schedules/[id]/route.ts`

**Interfaces:**
- Consumes: `schedules` table; `computeNextRun`, `cadenceColumns`, `type Cadence` (Task 1); `SESSION_COOKIE`, `verifySession` (existing `@/lib/auth`).
- Produces: `GET/POST /api/schedules`, `PATCH/DELETE /api/schedules/[id]`.

- [ ] **Step 1: Create the collection route**

Create `src/app/api/schedules/route.ts`:

```ts
import { cookies } from 'next/headers';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { cadenceColumns, computeNextRun, type Cadence } from '@/lib/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every_hours'), intervalHours: z.number().int().min(1).max(168) }),
  z.object({ kind: z.literal('daily'), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/) }),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);

const CreateBody = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(20_000),
  cadence: CadenceSchema,
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function GET() {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await db.select().from(schedules).orderBy(desc(schedules.created_at));
  return Response.json({ schedules: rows });
}

export async function POST(req: Request) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const { projectId, title, instruction, cadence } = parsed.data;
  const now = new Date();
  const id = `sched_${bytesToHex(randomBytes(4))}`;
  await db.insert(schedules).values({
    id,
    project_id: projectId,
    title: title.trim(),
    instruction: instruction.trim(),
    ...cadenceColumns(cadence as Cadence),
    enabled: true,
    next_run_at: computeNextRun(cadence as Cadence, now),
    created_at: now,
    updated_at: now,
  });
  return Response.json({ ok: true, id });
}
```

- [ ] **Step 2: Create the item route**

Create `src/app/api/schedules/[id]/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { cadenceColumns, computeNextRun, type Cadence } from '@/lib/schedule';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every_hours'), intervalHours: z.number().int().min(1).max(168) }),
  z.object({ kind: z.literal('daily'), timeOfDay: z.string().regex(/^\d{2}:\d{2}$/) }),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: z.number().int().min(0).max(6),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
  }),
]);

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(),
  instruction: z.string().min(1).max(20_000).optional(),
  cadence: CadenceSchema.optional(),
});

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });

  const existing = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1).then((r) => r[0]);
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

  const now = new Date();
  const set: Record<string, unknown> = { updated_at: now };
  if (parsed.data.enabled !== undefined) set.enabled = parsed.data.enabled;
  if (parsed.data.title !== undefined) set.title = parsed.data.title.trim();
  if (parsed.data.instruction !== undefined) set.instruction = parsed.data.instruction.trim();
  if (parsed.data.cadence) {
    const cadence = parsed.data.cadence as Cadence;
    Object.assign(set, cadenceColumns(cadence));
    set.next_run_at = computeNextRun(cadence, now); // cadence changed → recompute
  }

  await db.update(schedules).set(set).where(eq(schedules.id, id));
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  await db.delete(schedules).where(eq(schedules.id, id)); // linked sessions are kept
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Typecheck / build**

Run: `pnpm build`
Expected: PASS, no unused-import errors.

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/schedules/route.ts" "src/app/api/schedules/[id]/route.ts"
git commit -m "feat(scheduler): schedules CRUD API routes"
```

---

## Task 6: Scheduler view + wiring

**Files:**
- Create: `src/components/scheduler-view.tsx`
- Modify: `src/lib/nav-sections.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/mission-control.tsx`

**Interfaces:**
- Consumes: `ScheduleRow` (Task 3); `getSchedules` (Task 3); the API routes (Task 5).
- Produces: `SchedulerView` default export; `initialSchedules` prop on `MissionControl`.

- [ ] **Step 1: Create the view component**

Create `src/components/scheduler-view.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScheduleRow } from "@/lib/schedules-data";

type CadenceKind = "every_hours" | "daily" | "weekly";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Props {
  schedules: ScheduleRow[];
  projects: { id: string; name: string }[];
}

export default function SchedulerView({ schedules, projects }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<CadenceKind>("daily");
  const [intervalHours, setIntervalHours] = useState(4);
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildCadence() {
    if (kind === "every_hours") return { kind, intervalHours };
    if (kind === "daily") return { kind, timeOfDay };
    return { kind, dayOfWeek, timeOfDay };
  }

  async function createSchedule() {
    if (!title.trim() || !instruction.trim() || !projectId) {
      setError("Title, project, and instruction are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, instruction, cadence: buildCadence() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Create failed");
      }
      setTitle("");
      setInstruction("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    await fetch(`/api/schedules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    router.refresh();
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  const statusColor = (s: string | null) =>
    s === "ok" ? "text-emerald-400" : s === "error" ? "text-red-400" : "text-amber-400";

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#060810] text-[#e2e8f0]">
      <div className="mb-5">
        <h1 className="text-lg font-semibold">Scheduler</h1>
        <p className="text-xs text-[#7c8794]">
          Recurring agent tasks — fire an instruction at a repo on a cadence, no browser needed.
        </p>
      </div>

      <div className="flex gap-4">
        {/* list */}
        <div className="flex-1 flex flex-col gap-2.5">
          {schedules.length === 0 ? (
            <div className="text-sm text-[#7c8794] border border-[#232c3a] rounded-lg p-6 text-center">
              No schedules yet. Create one on the right.
            </div>
          ) : (
            schedules.map((s) => (
              <div
                key={s.id}
                className={`bg-[#131a24] border border-[#232c3a] rounded-lg p-3.5 ${s.enabled ? "" : "opacity-60"}`}
              >
                <div className="flex items-center gap-2.5">
                  <span className="font-semibold">{s.title}</span>
                  <span className="text-[11px] text-[#67e8f9] bg-[#0e2730] border border-[#1d4e5a] rounded px-1.5 py-px">
                    {projects.find((p) => p.id === s.projectId)?.name ?? s.projectId}
                  </span>
                  <button
                    onClick={() => toggle(s.id, !s.enabled)}
                    className={`ml-auto text-[11px] ${s.enabled ? "text-emerald-400" : "text-[#7c8794]"}`}
                  >
                    {s.enabled ? "enabled" : "paused"}
                  </button>
                  <button onClick={() => remove(s.id)} className="text-[#5b6675] hover:text-red-400 text-sm">
                    🗑
                  </button>
                </div>
                <div className="text-[12.5px] text-[#aab4c0] my-2">{s.instruction}</div>
                <div className="flex items-center gap-4 text-[11.5px] text-[#7c8794] flex-wrap">
                  <span>🕒 <b className="text-[#cdd6e0]">{s.cadenceSummary}</b></span>
                  <span>next · {s.enabled ? fmt(s.nextRunAt) : "—"}</span>
                  <span>
                    last · {fmt(s.lastRunAt)}
                    {s.lastStatus && <span className={`ml-1 ${statusColor(s.lastStatus)}`}>{s.lastStatus}</span>}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* create panel */}
        <div className="w-72 bg-[#0e141c] border border-[#232c3a] rounded-lg p-3.5 h-fit">
          <div className="text-sm font-semibold mb-3">New schedule</div>
          {error && <div className="text-[11px] text-red-400 mb-2">{error}</div>}

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none"
          />

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Project</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Instruction</label>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2.5 outline-none resize-none"
          />

          <label className="block text-[10px] uppercase tracking-wide text-[#5b6675] mb-1">Cadence</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as CadenceKind)}
            className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-2 outline-none"
          >
            <option value="every_hours">Every N hours</option>
            <option value="daily">Daily at time</option>
            <option value="weekly">Weekly on day at time</option>
          </select>

          {kind === "every_hours" && (
            <input
              type="number"
              min={1}
              max={168}
              value={intervalHours}
              onChange={(e) => setIntervalHours(Number(e.target.value))}
              className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-3 outline-none"
            />
          )}
          {kind === "daily" && (
            <input
              type="time"
              value={timeOfDay}
              onChange={(e) => setTimeOfDay(e.target.value)}
              className="w-full bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs mb-3 outline-none"
            />
          )}
          {kind === "weekly" && (
            <div className="flex gap-2 mb-3">
              <select
                value={dayOfWeek}
                onChange={(e) => setDayOfWeek(Number(e.target.value))}
                className="flex-1 bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs outline-none"
              >
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
              <input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="w-28 bg-[#0a0e14] border border-[#2a3442] rounded-md px-2.5 py-2 text-xs outline-none"
              />
            </div>
          )}

          <button
            onClick={createSchedule}
            disabled={busy}
            className="w-full bg-gradient-to-r from-cyan-400 to-blue-500 text-[#04121a] font-semibold rounded-md py-2 text-[13px] disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Flip the nav section to live**

In `src/lib/nav-sections.ts`, change the `scheduler` entry's status:

```ts
  { id: "scheduler", label: "Scheduler", icon: "CalendarClock", group: "system", status: "live" },
```

- [ ] **Step 3: Wire the page data**

In `src/app/page.tsx`:

Add the import next to the other `get*` imports (after `import { getSkills } from "@/lib/skills-data";`):
```ts
import { getSchedules } from "@/lib/schedules-data";
```

Add the fetch next to the other `initial*` fetches (after `const initialSkills = await getSkills();`):
```ts
  const initialSchedules = await getSchedules();
```

Pass the prop in the `<MissionControl ... />` JSX (after `initialSkills={initialSkills}`):
```tsx
        initialSchedules={initialSchedules}
```

- [ ] **Step 4: Wire the view into MissionControl**

In `src/components/mission-control.tsx`:

Add the import next to `import SkillsView from "@/components/skills-view";`:
```ts
import SchedulerView from "@/components/scheduler-view";
import type { ScheduleRow } from "@/lib/schedules-data";
```

Add to the props interface next to `initialSkills: AgentSkills[];`:
```ts
  initialSchedules: ScheduleRow[];
```

Add to the destructured props next to `initialSkills,`:
```ts
  initialSchedules,
```

Add a branch to the view-switch ternary. After the `activeSection === "skills" ? ( ... )` branch (the `<SkillsView ... />` block), insert:
```tsx
        ) : activeSection === "scheduler" ? (
          <SchedulerView schedules={initialSchedules} projects={projects} />
```

(`projects` is already a prop on `MissionControl`, of type `{ id: string; name: string }[]`.)

- [ ] **Step 5: Typecheck / build**

Run: `pnpm build`
Expected: PASS, no unused-import / missing-prop errors.

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/components/scheduler-view.tsx src/lib/nav-sections.ts src/app/page.tsx src/components/mission-control.tsx
git commit -m "feat(scheduler): Scheduler view + nav/page/mission-control wiring"
```

---

## Task 7: Runtime verification

**Files:** none (runtime).

- [ ] **Step 1: Cadence math is proven by unit tests**

Run: `pnpm test`
Expected: PASS — the `schedule` tests cover every cadence kind + rollover.

- [ ] **Step 2: End-to-end — a schedule fires unattended**

Start the app: `pnpm dev` (worktree with env gotchas handled, or the main repo), log in (`test@axodcreative.com`). Open the **Scheduler** nav section.

Create a schedule: title "verify", a project whose `repo_path` is a real git repo, instruction "Reply with a one-sentence hello, then stop.", cadence **Daily** at a time **1–2 minutes from now** (server-local). It appears in the list with `next` set.

Force it due now (so you don't wait for the clock) and let the next tick fire it:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');const r=db.prepare('UPDATE schedules SET next_run_at=? WHERE title=?').run(Math.floor(Date.now()/1000)-5,'verify');console.log('rows updated:',r.changes);db.close();"
```
Within ~60s the ticker fires it. Confirm:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');const s=db.prepare(\"SELECT last_status,last_session_id,next_run_at FROM schedules WHERE title='verify'\").get();console.log(s);console.log('session rows:',db.prepare('SELECT COUNT(*) c FROM sessions WHERE id=?').get(s.last_session_id));db.close();"
```
Expected: `last_status = 'ok'`, `last_session_id` set, `next_run_at` advanced to a future time; the linked session exists (and shows Sage's reply in the app's session log). Note: this fires a real turn (your Pro login if no `ANTHROPIC_API_KEY`, else the API key).

- [ ] **Step 3: UI toggle/delete**

In the Scheduler view, toggle the schedule to **paused** (the list shows "paused", `next` becomes "—" after refresh), re-enable it, then delete it. Confirm the row disappears and its past session row is still present (not cascade-deleted):
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log('schedules:',db.prepare('SELECT COUNT(*) c FROM schedules').get());db.close();"
```

---

## Task 8: Docs / progress

**Files:**
- Modify: `README.md` (project layout) — optional one-liner

- [ ] **Step 1: Note the Scheduler in the layout**

In `README.md`'s `## Project layout` block, add under `lib/`:
```
    schedule.ts                           # pure cadence math (next-run, summary) — unit-tested
    scheduler.ts                          # in-process ticker: poll due schedules → runSessionTurn
    schedules-data.ts                     # getSchedules server fetch for the Scheduler view
```
and under `src/` add `instrumentation.ts                          # Next boot hook → startScheduler()`, and under `components/` add `scheduler-view.tsx                     # Scheduler create/list/toggle UI`. Keep it terse; skip if it drifts from the actual block.

- [ ] **Step 2: Commit (if README changed)**

```bash
git add README.md
git commit -m "docs(scheduler): note scheduler in project layout"
```

---

## Self-Review notes

- **Spec coverage:** `schedules` table (Task 2) ✓; pure cadence module incl. catch-up "next future slot" via `computeNextRun(_, now)` (Task 1) ✓; in-process ticker with advance-then-run double-fire guard + per-job error isolation (Task 4) ✓; `instrumentation.ts` boot hook with `globalThis` dev-double-fire guard (Task 4) ✓; fresh session per fire mirroring task-board dispatch (Task 4) ✓; `@mention` direct routing is free (handled inside `runSessionTurn`, no field needed) ✓; CRUD routes with cookie auth + cadence recompute on edit (Task 5) ✓; full Scheduler view with side-panel create, nav flip to live (Task 6) ✓; tests on the pure module + runtime verification for the rest (Tasks 1/7) ✓; timezone = server-local, documented (Task 1 comment + spec) ✓.
- **Type consistency:** `Cadence`, `computeNextRun`, `cadenceColumns`, `parseCadence`, `summarizeCadence` are used identically across Tasks 1/3/4/5; `ScheduleRow` (Task 3) is the single client shape consumed by Task 6; `startScheduler`/`tick` (Task 4) match the instrumentation import.
- **Placeholders:** none — every code step shows the full file/snippet and exact anchor; the one conditional (drizzle `$inferSelect[]` annotation) is spelled out with the concrete alternative.
