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

- **Parser** (`plan-events.ts`) — already covered by `plan-events.test.ts`;
  untouched.
- **`src/lib/plans.test.ts`** (new; `node:test` via `tsx`, a temp/in-memory
  SQLite DB seeded with the schema):
  - round-trip: `savePlanSnapshot` then `getLatestPlanForSession` returns the
    same snapshot;
  - **upsert, not append**: save snapshot A, then snapshot B for the same
    session → latest is B and exactly **one** `type='plan'` row exists for that
    session;
  - empty: `getLatestPlanForSession` on a session with no plan returns `null`.
- **Manual:** start a planning task (e.g. "Plan a footer, then build it");
  reload mid-turn and after the turn — the checklist persists under the right
  owner; a new turn's `TodoWrite` overwrites it; dispatched specialist plans
  also persist (latest writer wins).

## Files touched

- `src/lib/plans.ts` — finish + trim (upsert + getter; drop history helper).
- `src/lib/plans.test.ts` — new unit tests.
- `src/app/api/sessions/[id]/stream/route.ts` — primary-agent save + wire the
  dispatch `savePlanSnapshot` callback.
- `src/lib/dispatch.ts` — add `savePlanSnapshot?` to `DispatchContext`; call it
  from the `dispatch_activity` branch.
- `src/app/page.tsx` — load `initialPlan`, pass it as a prop.
- `src/components/mission-control.tsx` — accept `initialPlan`, seed `plan` state.

No DB migration. No new API endpoint.
