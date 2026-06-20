# Plan Tab Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Plan tab's latest TodoWrite checklist survive a page reload by persisting it to the `artifacts` table and rehydrating it on load.

**Architecture:** Server-side upsert of one `artifacts` row per session (id `plan_${sessionId}`, `type='plan'`, `content` = the `PlanSnapshot` JSON), written at the two places the server already observes tool calls during a turn (the stream route for the primary agent; a `DispatchContext` callback for specialists). On page load, `page.tsx` reads the saved plan and passes it as an `initialPlan` prop that seeds the existing `plan` React state. No DB migration, no new endpoint.

**Tech Stack:** Next.js (this repo's vendored build), TypeScript, drizzle-orm + better-sqlite3, React client components, `node:test` via `tsx` (`pnpm test`).

**Spec:** `docs/superpowers/specs/2026-06-19-plan-persistence-design.md`.

---

## Notes for the implementer (read first)

- **Isolation:** Do this work in an isolated worktree on a `feature/plan-persistence` branch (this repo is the live app directory — do not branch-switch it in place). Create the worktree via `superpowers:using-git-worktrees` before Task 1. Merge to `dev` when done.
- **Imports are extensionless** (`from "./plan-events"`, `from "@/lib/plans"`). A `.ts` extension breaks `tsc`/`next build` in this repo.
- **Why no new unit tests:** the only pure logic here (`toPlanSnapshot`) is already fully tested in `src/lib/plan-events.test.ts`. The new code is DB access (`plans.ts` imports `@/db/client`, which is `'server-only'` and throws under `node:test`) and UI wiring — neither is unit-tested anywhere in this repo (e.g. `proposals.test.ts` tests the pure `proposals.ts`, never the server-only `proposals-data.ts`). So these tasks are verified by `pnpm build` + `pnpm test` (suite stays green) + the Task 5 manual check, matching the codebase pattern. Do not add a DB round-trip test.
- After **every** task: `pnpm test` must stay green and `pnpm build` must pass before committing.

---

## File Structure

- **Modify** `src/lib/plans.ts` — finish the uncommitted file: `savePlanSnapshot` becomes an upsert keyed by `plan_${sessionId}`; `getLatestPlanForSession` reads that row by id; delete the unused `getAllPlans`.
- **Modify** `src/app/api/sessions/[id]/stream/route.ts` — a best-effort `persistPlan` closure; call it from the primary `tool` branch; wire it into the dispatch context.
- **Modify** `src/lib/dispatch.ts` — add an optional `savePlanSnapshot` callback to `DispatchContext`; call it from the `dispatch_activity` branch.
- **Modify** `src/app/page.tsx` — load the saved plan and pass it as `initialPlan`.
- **Modify** `src/components/mission-control.tsx` — accept `initialPlan`; seed the `plan` state from it.

---

## Task 1: Finish `src/lib/plans.ts` (upsert + getter)

**Files:**
- Modify: `src/lib/plans.ts` (replace whole file)

- [ ] **Step 1: Replace the file contents**

Replace the entire contents of `src/lib/plans.ts` with:

```ts
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { artifacts } from '@/db/schema';
import type { PlanSnapshot } from '@/lib/plan-events';

// One persisted plan per session, stored as a single artifacts row whose id is
// derived from the session id so writes are an upsert (latest writer wins).
function planRowId(sessionId: string): string {
  return `plan_${sessionId}`;
}

/**
 * Persist the latest plan snapshot for a session. Upserts a single
 * `type='plan'` artifacts row (id `plan_${sessionId}`) so each new snapshot
 * overwrites the previous one rather than appending history.
 */
export async function savePlanSnapshot(sessionId: string, snapshot: PlanSnapshot): Promise<void> {
  const id = planRowId(sessionId);
  const content = JSON.stringify(snapshot);
  const now = new Date();
  await db
    .insert(artifacts)
    .values({
      id,
      session_id: sessionId,
      agent_id: snapshot.agentId,
      type: 'plan',
      content,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: artifacts.id,
      set: { agent_id: snapshot.agentId, content, created_at: now },
    });
}

/** Return the persisted plan snapshot for a session, or null if none/unparseable. */
export async function getLatestPlanForSession(sessionId: string): Promise<PlanSnapshot | null> {
  const row = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, planRowId(sessionId)))
    .limit(1)
    .then((r) => r[0]);
  if (!row?.content) return null;
  try {
    return JSON.parse(row.content) as PlanSnapshot;
  } catch {
    return null;
  }
}
```

(Note vs. the old file: `savePlanSnapshot` drops the `agentId` param — the agent id lives in the snapshot — and now upserts; `getLatestPlanForSession` fetches by the deterministic id; the `getAllPlans` history helper is removed.)

- [ ] **Step 2: Typecheck + test**

Run: `pnpm build`
Expected: PASS — compiles, no type errors. In particular `onConflictDoUpdate` and `snapshot.agentId` type-check.

Run: `pnpm test`
Expected: PASS — existing suite (incl. `plan-events.test.ts`) stays green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/plans.ts
git commit -m "feat(plan): persist latest plan snapshot via upserted artifacts row"
```

---

## Task 2: Save on tool calls (stream route + dispatch)

**Files:**
- Modify: `src/lib/dispatch.ts` (add callback to `DispatchContext`; call it)
- Modify: `src/app/api/sessions/[id]/stream/route.ts` (imports; `persistPlan` closure; primary save; wire callback)

- [ ] **Step 1: Add the `savePlanSnapshot` callback to `DispatchContext`**

In `src/lib/dispatch.ts`, add an import for the pure parser near the top (with the other imports):

```ts
import { toPlanSnapshot, type PlanSnapshot } from './plan-events';
```

Then in the `DispatchContext` interface (currently ends around line 47, after `onBeforeDispatch?`), add a new optional member:

```ts
  /** Best-effort: persist a dispatched specialist's latest plan snapshot. */
  savePlanSnapshot?: (snapshot: PlanSnapshot) => Promise<void>;
```

- [ ] **Step 2: Call it from the `dispatch_activity` branch**

In `src/lib/dispatch.ts`, the `dispatch_activity` emit (currently line 128) reads:

```ts
          ctx.emit({ type: 'dispatch_activity', agent_id: agent.id, tool: event.name, input: event.input });
```

Add, immediately after that line:

```ts
          const planSnap = toPlanSnapshot(event.name, event.input, agent.id);
          if (planSnap) await ctx.savePlanSnapshot?.(planSnap);
```

- [ ] **Step 3: Add imports to the stream route**

In `src/app/api/sessions/[id]/stream/route.ts`, add with the other imports at the top:

```ts
import { savePlanSnapshot } from '@/lib/plans';
import { toPlanSnapshot } from '@/lib/plan-events';
```

- [ ] **Step 4: Add a best-effort `persistPlan` closure**

In the stream handler, `sessionId` is already in scope. Directly **above** the `const dispatchServer = ...` declaration (currently line 150), add:

```ts
        // Best-effort plan persistence: never let a DB hiccup break the turn.
        const persistPlan = async (snapshot: PlanSnapshot) => {
          try {
            await savePlanSnapshot(sessionId, snapshot);
          } catch (err) {
            console.error('plan persist failed:', err instanceof Error ? err.message : err);
          }
        };
```

For the `PlanSnapshot` type used in that closure, extend the existing plan-events import to include the type. Change the Step 3 import line to:

```ts
import { toPlanSnapshot, type PlanSnapshot } from '@/lib/plan-events';
```

- [ ] **Step 5: Wire the callback into the dispatch context**

In the `createDispatchServer({ ... })` call (currently lines 152–172), add one line alongside the other callbacks (e.g. after `onBeforeDispatch: () => flushPrimary(),`):

```ts
          savePlanSnapshot: persistPlan,
```

- [ ] **Step 6: Save the primary agent's plan in the `tool` branch**

In the same file, the primary `tool` branch (currently lines 199–203) reads:

```ts
          } else if (event.type === 'tool') {
            // The primary agent's tool activity (Read/Grep/dispatch_agent…) → STATE box.
            controller.enqueue(
              sseEncode({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input }),
            );
          } else if (event.type === 'done') {
```

Insert the save after the `controller.enqueue(...)` call, still inside the `tool` branch:

```ts
          } else if (event.type === 'tool') {
            // The primary agent's tool activity (Read/Grep/dispatch_agent…) → STATE box.
            controller.enqueue(
              sseEncode({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input }),
            );
            const planSnap = toPlanSnapshot(event.name, event.input, primaryId);
            if (planSnap) await persistPlan(planSnap);
          } else if (event.type === 'done') {
```

- [ ] **Step 7: Typecheck + test**

Run: `pnpm build`
Expected: PASS — no type errors; `persistPlan`, the new import, and the `DispatchContext` member all resolve.

Run: `pnpm test`
Expected: PASS — suite stays green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/dispatch.ts "src/app/api/sessions/[id]/stream/route.ts"
git commit -m "feat(plan): persist plan snapshots on primary + dispatched tool calls"
```

---

## Task 3: Rehydrate the Plan tab on load

**Files:**
- Modify: `src/app/page.tsx` (load + pass `initialPlan`)
- Modify: `src/components/mission-control.tsx` (accept prop; seed state)

- [ ] **Step 1: Load the saved plan in `page.tsx`**

In `src/app/page.tsx`, add an import alongside the other `@/lib` imports near the top:

```ts
import { getLatestPlanForSession } from "@/lib/plans";
```

Then, next to the other `initial*` loads (currently lines 186–189, `getLiveFeed()` / `getTaskBoard(...)` / etc.), add:

```ts
  const initialPlan = await getLatestPlanForSession(currentSessionRow.id);
```

- [ ] **Step 2: Pass it as a prop**

In the `<MissionControl ... />` return (currently lines 191–203), add the prop alongside the other `initial*` props:

```tsx
      initialPlan={initialPlan}
```

- [ ] **Step 3: Add `initialPlan` to the props interface**

In `src/components/mission-control.tsx`, the `MissionControlProps` interface (currently lines 54–63) already lists `initialTaskBoard` / `initialProposals` / `initialSkills`. Add:

```ts
  initialPlan: PlanSnapshot | null;
```

(`PlanSnapshot` is already imported in this file — `import { toPlanSnapshot, type PlanSnapshot } from "@/lib/plan-events";`. If for any reason it is type-only-missing, ensure that import includes `type PlanSnapshot`.)

- [ ] **Step 4: Destructure the prop**

In the component signature (currently lines 247–257), add `initialPlan` to the destructured props, alongside `initialSkills`:

```tsx
  initialSkills,
  initialPlan,
}: MissionControlProps) {
```

- [ ] **Step 5: Seed the `plan` state from it**

Find the plan state declaration:

```tsx
  // Live Plan tab: the most recent TodoWrite snapshot (latest writer wins).
  // Ephemeral — gone on full reload, persists across turns, not cleared on Stop.
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
```

Replace it with (seed from the prop; update the comment — it is no longer ephemeral):

```tsx
  // Plan tab: the most recent TodoWrite snapshot (latest writer wins). Seeded
  // from the persisted plan on load, then overwritten live via SSE. Survives
  // reloads; not cleared on Stop or on "Clear session log".
  const [plan, setPlan] = useState<PlanSnapshot | null>(initialPlan ?? null);
```

(Seed only — do **not** add a `useEffect` resync on `initialPlan`. The live SSE-driven `plan` must not be clobbered by a server re-render mid-turn; a full reload remounts the component and re-seeds anyway.)

- [ ] **Step 6: Typecheck + test**

Run: `pnpm build`
Expected: PASS — `page.tsx` passes `initialPlan`, the component accepts it, no type errors.

Run: `pnpm test`
Expected: PASS — suite stays green.

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx src/components/mission-control.tsx
git commit -m "feat(plan): rehydrate Plan tab from persisted snapshot on load"
```

---

## Task 4: Manual verification

**Files:** none (runtime check)

- [ ] **Step 1: Run the app**

Run: `pnpm dev`, open http://localhost:3000, log in, open a session, switch to the **Plan** tab. It should show "No plan yet …" (or a previously-persisted plan if one exists).

- [ ] **Step 2: Generate a plan and reload**

Send the primary agent a planning task (e.g. "Plan out adding a footer to the site, then do it"). As it calls `TodoWrite`, the checklist fills in under its owner with a live `done / total` count.
- **Reload the page mid-turn and again after it finishes** — the checklist persists (it does NOT reset to "No plan yet").
- If the agent dispatches a specialist that writes its own todos, that plan persists too (latest writer wins).

- [ ] **Step 3: Confirm upsert, not append**

With `DATABASE_PATH` pointing at the dev DB, confirm exactly one plan row exists for the session (replace `<SID>` with the session id from the URL/DB):

```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log('plan rows:', db.prepare(\"SELECT count(*) c FROM artifacts WHERE type='plan' AND session_id=?\").get('<SID>').c);db.close();"
```

Expected: `plan rows: 1` (after many `TodoWrite`s in the session — proves overwrite, not append).

---

## Task 5: Update docs / progress

**Files:**
- Modify: `docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md` (add a pointer)
- (Outside repo) the `week-4-progress` auto-memory

- [ ] **Step 1: Cross-link the original Plan tab spec**

At the top or bottom of `docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md`, add a one-line note that the originally-ephemeral plan is now persisted, pointing to `docs/superpowers/specs/2026-06-19-plan-persistence-design.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md
git commit -m "docs(plan): note plan persistence supersedes the ephemeral design"
```

- [ ] **Step 3: Update the progress memory (outside the repo)**

Update the `week-4-progress` memory file: note that the Plan tab is now durable (persisted via upserted `artifacts` row, rehydrated through an `initialPlan` prop), and point to the new spec/plan. This is a memory file, not a repo commit.

---

## Self-Review notes

- **Spec coverage:** upsert one-row-per-session (Task 1 `onConflictDoUpdate` on `plan_${sessionId}`) ✓; persist primary (Task 2 Step 6) + specialists (Task 2 Steps 1–2 via callback) ✓; best-effort/no-throw (Task 2 Step 4 `persistPlan` try/catch) ✓; rehydrate via `initialPlan` prop (Task 3) ✓; Clear keeps the plan (no clear-path changes anywhere) ✓; drop `getAllPlans` (Task 1) ✓; testing = parser already covered + manual incl. row-count (Task 4), per codebase precedent ✓; docs (Task 5) ✓.
- **Type consistency:** `savePlanSnapshot(sessionId: string, snapshot: PlanSnapshot)` and `getLatestPlanForSession(sessionId: string): Promise<PlanSnapshot | null>` used identically in Tasks 1/2/3; `DispatchContext.savePlanSnapshot?: (snapshot: PlanSnapshot) => Promise<void>` matches the `persistPlan` closure passed to it; `PlanSnapshot`/`toPlanSnapshot` come from `@/lib/plan-events` everywhere.
- **Placeholders:** none — every code step shows the full code and exact insertion point.
```
