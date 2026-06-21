# Scheduler — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorm)
**Depends on:** the server-side turn runner (`src/lib/run-turn.ts` `runSessionTurn`), 2026-06-20.

## Goal

Let an operator define **recurring agent tasks** that fire on a cadence with no
browser present: a fixed instruction is sent to a project's session on schedule,
running Sage (and any dispatched specialists) through the existing
`runSessionTurn`. This is the first consumer of the server-side turn runner and
makes the "Scheduler" Hermes pillar live.

## Scope (v1)

In scope:
- A `schedules` table (one row per recurring job).
- An in-process ticker that fires due schedules (started at server boot).
- A pure cadence module (`computeNextRun` / `summarizeCadence`), unit-tested.
- CRUD API routes for schedules (cookie-authed, like `/api/tasks`).
- A full **Scheduler** view: create (side panel) + list + enable/disable + delete.
  Flip the nav section `scheduler` from `soon` → `live`.

Out of scope (YAGNI — note for later): cron expressions, per-run output
notifications, multi-tenant timezones, reuse-one-session-per-schedule continuity,
backfill of missed runs, catch-up storms.

## Decisions (locked in brainstorm)

1. **Primary job:** recurring agent task — fixed instruction → project, **fresh
   session each fire** (mirrors task-board dispatch; isolated worktree per run).
2. **Trigger:** in-process ticker via Next's `instrumentation.ts` (single
   self-hosted process; no external cron).
3. **UI:** full view, **create lives in a side panel** beside the list.
4. **Cadence:** friendly presets only — `every_hours`, `daily`, `weekly`.
   Structured model leaves room for a `cron` kind later without rework.
5. **Timezone:** `HH:MM` is **server-local** (the Mac Mini). Acceptable for a
   single-operator self-hosted box; documented here so it isn't a surprise.

## Data model

New table `schedules`:

| field | type | notes |
|---|---|---|
| `id` | text PK | `sched_<hex>` |
| `project_id` | text → projects | notNull; the repo the run targets |
| `title` | text | notNull; operator label |
| `instruction` | text | notNull; the prompt fired each run. May start with `@Atlas`/`@Echo`/`@Nova` to route directly via the existing `parseMention` in `runSessionTurn` — no extra field needed. |
| `cadence_kind` | text | notNull: `every_hours` \| `daily` \| `weekly` |
| `interval_hours` | integer | for `every_hours` (≥ 1) |
| `time_of_day` | text | for `daily`/`weekly`; `"HH:MM"` 24h, server-local |
| `day_of_week` | integer | for `weekly`; 0=Sun … 6=Sat |
| `enabled` | integer | notNull, default 1 (boolean) |
| `next_run_at` | integer (timestamp) | notNull; the column the ticker queries |
| `last_run_at` | integer (timestamp) | nullable |
| `last_status` | text | nullable: `ok` \| `error` \| `skipped` |
| `last_session_id` | text → sessions | nullable; links to the run's session |
| `created_at` / `updated_at` | integer (timestamp) | notNull |

Drizzle migration generated + applied (`pnpm db:generate` / `db:migrate`).
Deleting a schedule does **not** cascade-delete its past sessions.

## Components

### `src/lib/schedule.ts` — pure, unit-tested
No DB, no `server-only` (same pattern as `turn-lease.ts`).

```ts
export type Cadence =
  | { kind: 'every_hours'; intervalHours: number }
  | { kind: 'daily'; timeOfDay: string }            // "HH:MM"
  | { kind: 'weekly'; dayOfWeek: number; timeOfDay: string };

/** Next occurrence strictly after `from`, in the host's local time. */
export function computeNextRun(cadence: Cadence, from: Date): Date;

/** "Every 4 hours" / "Daily at 09:00" / "Weekly on Mon at 09:00" — for the UI. */
export function summarizeCadence(cadence: Cadence): string;
```

Also a small `parseCadence(row): Cadence` to assemble a `Cadence` from the flat
columns (used by both the ticker and the API/UI summary).

### `src/lib/scheduler.ts` — server-only ticker
- `startScheduler()` — idempotent singleton. Guards against dev/HMR
  double-start with a `globalThis.__mcSchedulerStarted` flag; runs `tick()` once
  immediately, then on a 60s `setInterval`.
- `tick()`:
  1. `now = new Date()`
  2. Select `schedules` where `enabled = 1 AND next_run_at <= now`.
  3. For each due schedule (errors caught **per job** — the tick never throws):
     a. **Advance first:** `next_run_at = computeNextRun(cadence, now)` and write
        it immediately, so a slow run or the next tick can't double-fire.
     b. Create a fresh session `sess_<hex>` (project_id, title = schedule title,
        branch = project default, status `active`), mirroring the task-board
        dispatch insert.
     c. `const result = await runSessionTurn(sessionId, { instruction })`.
     d. Write `last_run_at = now`, `last_session_id = sessionId`,
        `last_status = result.status === 'completed' ? 'ok'
                       : result.status === 'skipped' ? 'skipped' : 'error'`.
        A thrown error → `last_status = 'error'`.

### `instrumentation.ts` — server boot hook (repo root)
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./src/lib/scheduler');
    startScheduler();
  }
}
```
Runs once when the Node server process starts. The `globalThis` guard inside
`startScheduler` makes repeated `register()` calls (dev HMR) safe.

### API routes (cookie auth, like `/api/tasks`)
- `GET /api/schedules` — list (newest first).
- `POST /api/schedules` — create: validate cadence (zod), compute initial
  `next_run_at = computeNextRun(cadence, now)`.
- `PATCH /api/schedules/[id]` — toggle `enabled`, or edit fields; recompute
  `next_run_at` when the cadence changes.
- `DELETE /api/schedules/[id]` — delete the row (keeps past sessions).

### UI — Scheduler view
- Flip `nav-sections.ts` `scheduler` status `soon` → `live`.
- **List (hero):** one row per schedule — title, project tag, cadence summary,
  enable toggle, next-run (relative), last-run + status badge (`ok`/`error`/`skipped`),
  "view session ↗" link to `last_session_id`, delete.
- **Create (side panel, right):** title, project dropdown, instruction textarea,
  cadence kind dropdown → conditional fields (interval hours / time / weekday).
- Styling follows existing Task Board / Proposals patterns.

## Data flow (one fire)

```
instrumentation.register() → startScheduler() → setInterval(tick, 60s)
  tick(): SELECT enabled && next_run_at <= now
    for each due:
      advance next_run_at (compute from now)   ← guards against double-fire
      create sess_<hex>
      await runSessionTurn(sessionId, { instruction })   ← worktree + Sage turn
      write last_run_at / last_status / last_session_id
```

## Edge cases

- **Dev double-fire / HMR:** `globalThis.__mcSchedulerStarted` guard.
- **Downtime catch-up:** a past `next_run_at` fires **once**, then advances to the
  next *future* slot (`computeNextRun(cadence, now)`) — no backfill storm.
- **Overlap:** fresh session per fire ⇒ no shared worktree; `next_run_at`
  advanced before the run ⇒ the same schedule won't refire until its next slot.
  (`runSessionTurn`'s per-session lease is a backstop, not the primary guard.)
- **Run failure:** caught per job, `last_status = 'error'`; the tick continues
  to other due jobs.
- **Disabled** schedules are skipped; their `next_run_at` is left as-is and the
  UI shows next-run as "—".

## Testing

- **`schedule.ts`** unit tests via `node:test` + tsx (`pnpm test`), matching the
  project pattern: `computeNextRun` for each kind including hour/day/week
  rollover and "strictly after `from`"; `summarizeCadence` output.
- **Server-only pieces** (`scheduler.ts`, routes, instrumentation) are not
  unit-tested (they import `server-only`). Runtime verification: insert a
  schedule with `next_run_at` in the past → confirm one tick fires it (a session
  is created, the turn runs, `last_status = 'ok'`, `next_run_at` advances to a
  future slot). Same headless style used to verify the turn runner.
- `pnpm build` clean; full suite green before each commit.

## Isolation summary

| Unit | Does | Depends on | Tested |
|---|---|---|---|
| `schedule.ts` | cadence math + summary | nothing (pure) | unit |
| `scheduler.ts` | poll due → fire → record | `schedule.ts`, `run-turn.ts`, db | runtime |
| `instrumentation.ts` | start ticker at boot | `scheduler.ts` | runtime |
| API routes | CRUD schedules | db, `schedule.ts`, auth | runtime |
| Scheduler view | operator create/list/toggle | API routes | manual |
