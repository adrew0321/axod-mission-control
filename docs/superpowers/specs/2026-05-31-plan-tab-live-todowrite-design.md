# Plan tab — live TodoWrite checklist (Week 4, Day 4)

**Date:** 2026-05-31
**Branch:** `feature/week-4-workspace-tabs`
**Status:** Approved design, ready for implementation plan.

> **Update (2026-06-19):** the Plan tab's "ephemeral, gone on reload" behavior
> described here is now superseded — the latest snapshot is persisted and
> rehydrated on load. See `docs/superpowers/specs/2026-06-19-plan-persistence-design.md`.

## Goal

Replace the static mock "Dynamic Plan" markdown in the Plan tab with a live
checklist driven by the agents' `TodoWrite` calls. When Sage (or a dispatched
specialist) charts a plan, the operator watches it appear and check off in real
time.

## Key constraints / decisions

- **Ephemeral** — the plan lives in React state, rebuilt from events on the SSE
  wire. No server or DB changes. Cleared on a full page reload. Mirrors the
  Terminal tab (Day 3).
- **Latest writer wins** — show the single most recent `TodoWrite` snapshot,
  whoever wrote it (Sage or a dispatched specialist). One clean list, tagged
  with its owning agent.
- **Empty placeholder** — before any `TodoWrite` fires this session, show a
  quiet "no plan yet" message. This drops the mock-data coupling now rather
  than Day 5.

## Why no server changes are needed

The streaming route already forwards what we need:

- Sage's tool calls are emitted as `activity` events carrying `tool` + `input`
  (`src/app/api/sessions/[id]/stream/route.ts`, ~line 169).
- Dispatched specialists' tool calls are emitted as `dispatch_activity` events,
  also carrying `tool` + `input` (consumed in `mission-control.tsx`, ~line 374).

For a `TodoWrite` call, `input` is `{ todos: [{ content, status, activeForm }] }`.
So the full todo list is already on the wire for both Sage and specialists; the
feature is a pure client-side consumer.

## Components

### 1. `src/lib/plan-events.ts` (pure, testable)

Mirrors `src/lib/terminal-events.ts`. No React, no `server-only`.

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface PlanSnapshot {
  agentId: string;
  todos: TodoItem[];
}

// Returns a snapshot for a TodoWrite call with a valid todos array, else null.
export function toPlanSnapshot(
  tool: string,
  input: unknown,
  agentId: string,
): PlanSnapshot | null;
```

Behaviour:
- `tool !== 'TodoWrite'` → `null`.
- `input` missing / not an object / `todos` not an array → `null`.
- Each todo is defensively coerced: `content` must be a non-empty string;
  `status` defaults to `'pending'` if it is not one of the three known values;
  `activeForm` is carried through when it is a string. Todos that have no usable
  `content` are dropped. If nothing usable remains → `null`.

### 2. `src/components/plan-view.tsx`

Props: `{ snapshot: PlanSnapshot | null }`.

- **Empty state** (snapshot null or no todos): centered, muted message —
  "No plan yet — Sage will chart the course when work begins."
- **Header**: owner label derived from `agentId` (e.g. "Sage's plan",
  "Atlas's plan"; fall back to the raw id capitalized) and a progress count
  `completed / total` (e.g. `3 / 7`).
- **Rows**: one per todo, with a status glyph:
  - `pending` → ○ (muted)
  - `in_progress` → ◐ (accent/cyan), label uses `activeForm` when present
  - `completed` → ✓ (green), content with a strikethrough / dimmed treatment
- Styling matches the existing dark panel used by the other tabs
  (`bg-[#11161d]`, `border-[#1e2632]`, etc.).

### 3. `mission-control.tsx` wiring

- Add state: `const [plan, setPlan] = useState<PlanSnapshot | null>(null);`
- In the `es.onmessage` handler, after the existing `activity` and
  `dispatch_activity` branches resolve `agentId` + `tool` + `input`, run them
  through `toPlanSnapshot`. On a non-null result, `setPlan(snapshot)`
  (latest-writer-wins — a later snapshot fully replaces the earlier one).
- Replace the Plan tab JSX (current lines ~1090–1106, the
  `artifacts.find((a) => a.type === 'plan')?.content` block) with
  `<PlanView snapshot={plan} />`.
- Remove the `artifacts.find(a => a.type === 'plan')` lookup from render.

## Lifecycle

- Lives entirely in React state; gone on full reload.
- Persists across conversation turns within the session.
- **Not** cleared on Stop — the last plan stays visible until the next
  `TodoWrite` replaces it.

## Out of scope (deferred to Day 5)

- The `'plan'` member of the `Artifact` type union stays (it is still a valid
  artifact type); only the mock-render coupling is removed now.
- The dead `art_plan` mock row in `src/lib/mock-data.ts` is swept up in the
  Day 5 mock-data cleanup, alongside `art_terminal`.

## Testing

- **Unit** (`src/lib/plan-events.test.ts`, run via `pnpm test`):
  - `TodoWrite` with a valid todos array → expected snapshot (agentId + todos).
  - Non-`TodoWrite` tool → `null`.
  - Malformed input (no `todos`, `todos` not an array, empty after coercion) →
    `null`.
  - Unknown `status` value → coerced to `'pending'`.
- **Manual**: `pnpm dev` → http://localhost:3000, give Sage a task that makes
  it chart todos, confirm the Plan tab fills in and checks off live, and that a
  dispatched specialist's later `TodoWrite` takes over the tab.

## Docs to update on completion

- Check off Day 4 in `docs/plans/week-4-workspace-tabs.md`.
- Update the `week-4-progress` auto-memory.
