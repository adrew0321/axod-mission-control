# Nightly health-check job + real pass/fail signal

**Date:** 2026-06-25
**Status:** Design approved, pending implementation plan

## Problem

The Scheduler ([src/lib/scheduler.ts](../../../src/lib/scheduler.ts)) runs each due
schedule as an agent turn in a session worktree, then records `last_status` from the
turn's *result* (`completed` → `'ok'`, `skipped` → `'skipped'`, `error` → `'error'`).
That signal reflects whether the **turn** ran, not whether the **work** the turn did
succeeded. A nightly build/test health-check is now viable (session worktrees link
`node_modules` as of 2026-06-24, commit `b85dc2b`, so `pnpm test`/`pnpm build` work
there), but if we scheduled one today a **failing build would still show `'ok'`** —
the agent runs fine and merely *reports* the failure in prose. A health-check whose
red builds look green is worthless.

## Goal

1. A nightly health-check schedule that runs `pnpm test` and `pnpm build` in the
   project worktree and reports a concise pass/fail summary.
2. A **real** pass/fail signal: a failing check surfaces as a distinct red status in
   the Scheduler, not `'ok'`.

## Approach: explicit verdict token, parsed generically

The agent emits a machine-readable verdict at the end of its report; the Scheduler
parses it from the final agent message and adjusts `last_status`.

Considered and rejected:

- **Infer from Bash exit codes** (treat any non-zero `tool_result` as failure):
  too noisy — agents legitimately run commands that exit non-zero (`grep` with no
  match, `test -f`), which would produce false failures.
- **Structured turn result** (agent runner returns typed health data): overkill;
  requires plumbing through the runner. YAGNI.

The explicit token is intentional (the agent *decides* pass/fail from what it ran),
needs no agent-runner changes, and mirrors the existing `VERDICT:` convention Echo
already uses for QA reviews.

**Generic, not health-specific:** the Scheduler tries to parse a verdict from *every*
job's final message. This keeps the schema unchanged and lets any future job opt into
health signaling by emitting the token. Existing jobs (Echo digest, Nova dep audit)
emit no token, so their behavior is unchanged.

## Components

### 1. `src/lib/health-verdict.ts` (pure)

```
parseHealthVerdict(text: string): 'pass' | 'fail' | null
```

- Case-insensitive; matches a line of the form `HEALTH: PASS` or `HEALTH: FAIL`
  (optional surrounding whitespace; tolerant of markdown emphasis/backticks around
  the token).
- If both appear, the **last** occurrence wins (the agent's final verdict).
- Returns `null` when no token is present.
- No `server-only` guard (pure), unit-tested in `src/lib/health-verdict.test.ts`.

### 2. Scheduler integration (`src/lib/scheduler.ts`)

The status mapping is extracted as a **pure** helper so it can be unit-tested without
the DB:

```
healthStatus(result: TurnResult, finalMessage: string | null): 'ok' | 'fail' | 'skipped' | 'error'
```

- `completed` + verdict `'fail'` → `'fail'`
- `completed` + verdict `'pass'` or `null` → `'ok'`
- `skipped` → `'skipped'`; `error` → `'error'`

The Scheduler, after `runSessionTurn` returns, fetches the session's final agent
message via a small DB helper and feeds both into `healthStatus`, then writes the
result to `last_status`:

```
getFinalAgentMessage(sessionId: string): Promise<string | null>
```

(most-recent `messages` row for the session with `role = 'agent'`; content or null).

### 3. UI (`src/components/scheduler-view.tsx`)

One line in `statusColor`: add `'fail'` → red (`text-red-400`). Semantics:
`'error'` = the job/turn crashed (infra); `'fail'` = checks ran and reported failure
(code). `'ok'` = green, anything else = amber (unchanged).

### 4. The health-check schedule

Created the same way the existing jobs were (the `/api/schedules` POST path /
Scheduler UI). Parameters:

- **project:** `mission-control`
- **cadence:** daily at `03:00` (server-local)
- **title:** `Nightly health check`
- **instruction** (Echo-addressed so the turn routes directly to Echo, who has Bash):

  > `@Echo: Nightly health check. In this worktree run \`pnpm test\`, then \`pnpm build\`. Summarize what passed/failed (include the key error lines on any failure). End with EXACTLY one line — \`HEALTH: PASS\` if both succeeded, otherwise \`HEALTH: FAIL\`.`

## Implementation risk to validate first (build-in-worktree spike)

`pnpm test` is **confirmed** to run in a session worktree (134/134 ran there during
the 2026-06-24 worktree-deps task, with no `.env` present). `pnpm build` (Next build)
is heavier and may evaluate server modules that open the SQLite DB; `.env` is
gitignored and therefore **absent** from worktrees, so `DATABASE_PATH` may be unset
there. The agent's Bash subprocess likely inherits the running server's loaded env
(making `DATABASE_PATH` resolve), but this is **unverified**.

**First implementation step is a spike:** run `pnpm build` in a real session worktree.

- If it completes → ship `test` + `build` as designed.
- If it fails on env/data → choose one (decide at spike time, with the operator):
  (a) provision `.env` into worktrees (small, parallels the `node_modules` link), or
  (b) ship **test-only** for v1 and treat build-in-worktree as a fast-follow.

This prevents shipping a health-check that cries wolf on an environment issue rather
than real breakage.

## Out of scope

- No schema changes (`last_status` is free-text; `'fail'` is a new value, not a new column).
- No alerting/Discord notification (a possible future follow-up).
- No per-schedule "type" flag — verdict parsing is generic.
- No change to how turns run or to the agent runner.

## Testing

- **`health-verdict.test.ts`** (pure, `node:test` via `tsx`): PASS token → `'pass'`;
  FAIL token → `'fail'`; both present → last wins; absent → `null`; case-insensitive;
  tolerant of backticks/emphasis around the token; a `HEALTH:` mention mid-sentence
  without a clear PASS/FAIL does not false-positive.
- **Scheduler mapping:** unit-test the status-mapping logic — extract it as a pure
  helper `healthStatus(result, finalMessage)` so it can be tested without the DB
  (completed+FAIL → `'fail'`; completed+PASS → `'ok'`; completed+no-token → `'ok'`;
  error → `'error'`; skipped → `'skipped'`).
- **Manual:** create the schedule, trigger a run (or wait for the nightly), confirm a
  passing run shows green `ok` and an intentionally-broken tree shows red `fail`.
