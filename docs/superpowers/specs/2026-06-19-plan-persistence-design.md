# Plan Tab Persistence — Design

**Date:** 2026-06-19
**Status:** Approved (design); pending implementation plan.

## Problem

The Plan tab is a live, **ephemeral** TodoWrite-driven checklist (see
`2026-05-31-plan-tab-live-todowrite-design.md`). The most recent `TodoWrite`
snapshot is held in React state in `mission-control.tsx` and rendered by
`PlanView`. On a full page reload the state resets to `null`, so the tab shows
"No plan yet" even when an agent has an active plan. We want the last plan to
**survive reloads**.

The original Plan tab was ephemeral *by design*. This is a deliberate,
additive enhancement to make it durable — not a bug fix.

## Scope (decisions locked during brainstorming)

- **Latest only.** Restore the single most-recent plan snapshot for the
  session — the same "latest writer wins" view shown live. No per-agent split,
  no history timeline.
- **One row per session, upserted.** Storage holds exactly one plan per
  session; each new snapshot overwrites it.
- **Persist whatever shows live.** Both the primary agent (Sage) and dispatched
  specialists feed the live view, so both persist.
- **Clear keeps the plan.** The operator "Clear session log" action (sets
  `cleared_at`, archives messages) does **not** touch the persisted plan. The
  next `TodoWrite` overwrites it naturally.
- **Best-effort.** A persistence failure must never break an agent turn.

Out of scope (YAGNI): plan history/audit trail, per-agent plan selection, a
dedicated DB table, any new API endpoint.

## Architecture (Approach A: server-side upsert + initial-prop hydration)

Saves happen on the server, at the two points that already observe tool calls
during a turn; restore happens on the server at page load via an `initialPlan`
prop, matching the existing `initial*` prop pattern.

### Data model

Reuse the existing `artifacts` table — **no migration**.

| column      | value                                   |
|-------------|-----------------------------------------|
| `id`        | `plan_${sessionId}` (deterministic)     |
| `session_id`| the session id                          |
| `agent_id`  | `snapshot.agentId` (a real agent id; satisfies the NOT NULL FK) |
| `type`      | `'plan'`                                |
| `content`   | `JSON.stringify(snapshot)` (a `PlanSnapshot`) |
| `created_at`| write time                              |

Writes are an upsert via drizzle `onConflictDoUpdate` on the `id` primary key,
updating `content`, `agent_id`, and `created_at`. The deterministic id
guarantees one plan row per session. Nothing else writes `type='plan'`, so
there are no collisions.

### `src/lib/plans.ts` (finish + trim the uncommitted file)

- `savePlanSnapshot(sessionId: string, snapshot: PlanSnapshot): Promise<void>`
  — the upsert above. (Drops the current `agentId` parameter; the agent id is
  already inside the snapshot.)
- `getLatestPlanForSession(sessionId: string): Promise<PlanSnapshot | null>`
  — reads the `plan_${sessionId}` row and `JSON.parse`s its content; returns
  `null` if absent or unparseable.
- **Remove** the unused `getPlansForSession` (history) helper — out of scope.

### Save path (two server-side call sites)

1. **Primary agent** — `src/app/api/sessions/[id]/stream/route.ts`, in the
   `event.type === 'tool'` branch (where it already emits the `activity` SSE
   event):
   ```ts
   const snap = toPlanSnapshot(event.name, event.input, primaryId);
   if (snap) await savePlanSnapshot(sessionId, snap); // best-effort (see below)
   ```
2. **Specialists** — add an optional callback to `DispatchContext`
   (`src/lib/dispatch.ts`), mirroring the existing `persistMessage` callback:
   ```ts
   savePlanSnapshot?: (snapshot: PlanSnapshot) => Promise<void>;
   ```
   The stream route supplies it with `sessionId` bound. In `dispatch.ts`'s
   `dispatch_activity` branch, compute the snapshot with the **pure**
   `toPlanSnapshot` and call `await ctx.savePlanSnapshot?.(snap)`. This keeps the
   plan **write** behind the context callback, exactly like `persistMessage` —
   `dispatch.ts` adds no new DB access and does not import `@/lib/plans`. (It
   keeps its pre-existing `@/db/client` import, which it uses only to load the
   specialist agent — unrelated to plan persistence.)

### Restore path (hydration)

- `src/app/page.tsx`:
  ```ts
  const initialPlan = await getLatestPlanForSession(currentSessionRow.id);
  // ...
  <MissionControl ... initialPlan={initialPlan} />
  ```
  Same shape/placement as `initialTaskBoard`, `initialProposals`, etc.
- `src/components/mission-control.tsx`: accept the `initialPlan` prop and seed
  state with it:
  ```ts
  const [plan, setPlan] = useState<PlanSnapshot | null>(initialPlan ?? null);
  ```
  Live SSE updates overwrite it exactly as today. No change to Clear handling.

## Error handling

Persistence is best-effort and must not break a turn. Each save is wrapped so a
DB error is caught, logged, and swallowed, and streaming continues. A failed
save just means that one snapshot is not durable; the next `TodoWrite` upserts
over it. (Concretely: wrap the `await savePlanSnapshot(...)` in a try/catch — or
a single internal helper that does the try/catch — at both call sites.)

## Testing

This repo deliberately splits **pure logic (unit-tested)** from **DB access
(not unit-tested)**: every DB module imports `'server-only'`, which throws when
imported from a `node:test` run, so no test touches the database (e.g.
`proposals.test.ts` covers the pure `proposals.ts`, never the server-only
`proposals-data.ts`). `plans.ts` is a DB module (imports `@/db/client`), so it
follows that precedent — no `plans.test.ts`. (Originally the spec proposed a
temp-SQLite round-trip test for `plans.ts`; that is dropped to match the
codebase pattern rather than introduce a DI refactor nothing else uses.)

- **Parser** (`plan-events.ts`) — the only pure logic here — is already covered
  by `plan-events.test.ts`; untouched. The full `pnpm test` suite must stay
  green.
- **Manual verification** (the upsert + restore behavior):
  - start a planning task (e.g. "Plan a footer, then build it"); the checklist
    fills in live under the right owner;
  - reload mid-turn and after the turn — the plan persists (not "No plan yet");
  - a new turn's `TodoWrite` overwrites it (latest writer wins); a dispatched
    specialist's plan also persists;
  - confirm **upsert, not append**: after several `TodoWrite`s, exactly one
    `type='plan'` row exists for the session — verify with a one-off query
    (`SELECT count(*) FROM artifacts WHERE session_id=? AND type='plan'` → 1).

## Files touched

- `src/lib/plans.ts` — finish + trim (upsert + getter; drop the unused
  `getAllPlans` history helper).
- `src/app/api/sessions/[id]/stream/route.ts` — primary-agent save + wire the
  dispatch `savePlanSnapshot` callback.
- `src/lib/dispatch.ts` — add `savePlanSnapshot?` to `DispatchContext`; call it
  from the `dispatch_activity` branch.
- `src/app/page.tsx` — load `initialPlan`, pass it as a prop.
- `src/components/mission-control.tsx` — accept `initialPlan`, seed `plan` state.

No DB migration. No new API endpoint.
