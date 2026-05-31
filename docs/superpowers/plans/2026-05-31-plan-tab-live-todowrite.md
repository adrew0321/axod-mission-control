# Plan Tab — Live TodoWrite Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static mock "Dynamic Plan" markdown in the Plan tab with a live checklist driven by the agents' `TodoWrite` calls, which already stream over SSE.

**Architecture:** Pure client-side consumer of events already on the wire. A pure parser (`src/lib/plan-events.ts`) turns a `TodoWrite` tool input into a `PlanSnapshot`; a presentational component (`src/components/plan-view.tsx`) renders it; `mission-control.tsx` holds the latest snapshot in React state and feeds the component. No server or DB changes. Mirrors the Day 3 Terminal tab shape (pure lib + view + state).

**Tech Stack:** Next.js (this repo's vendored build), React client components, TypeScript, Tailwind, `node:test` via `tsx` (`pnpm test`).

---

## File Structure

- **Create** `src/lib/plan-events.ts` — pure `toPlanSnapshot(tool, input, agentId)` + `TodoItem` / `PlanSnapshot` / `TodoStatus` types. No React, no `server-only`. (Mirrors `src/lib/terminal-events.ts`.)
- **Create** `src/lib/plan-events.test.ts` — `node:test` unit tests for the parser. (Mirrors `src/lib/terminal-events.test.ts`.)
- **Create** `src/components/plan-view.tsx` — presentational `PlanView` client component. (Mirrors `src/components/terminal-view.tsx`.)
- **Modify** `src/components/mission-control.tsx` — import the parser + component, add `plan` state, feed `toPlanSnapshot` from the `activity`/`dispatch_activity` branches, replace the Plan tab JSX (~lines 1090–1106).

Spec: `docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md`.

---

## Task 1: Pure parser `toPlanSnapshot` (with tests)

**Files:**
- Create: `src/lib/plan-events.ts`
- Test: `src/lib/plan-events.test.ts`

Note on imports: tests and lib use **extensionless** relative imports (e.g. `from "./plan-events"`) — the `.ts` extension breaks `tsc`/`next build` in this repo.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/plan-events.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlanSnapshot } from "./plan-events";

test("a TodoWrite tool input becomes a plan snapshot", () => {
  const out = toPlanSnapshot(
    "TodoWrite",
    {
      todos: [
        { content: "Read the file", status: "completed", activeForm: "Reading the file" },
        { content: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
        { content: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
    },
    "sage",
  );
  assert.deepEqual(out, {
    agentId: "sage",
    todos: [
      { content: "Read the file", status: "completed", activeForm: "Reading the file" },
      { content: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
    ],
  });
});

test("activeForm is optional and omitted when absent", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "Solo", status: "pending" }] }, "atlas");
  assert.deepEqual(out, { agentId: "atlas", todos: [{ content: "Solo", status: "pending" }] });
});

test("an unknown status is coerced to pending", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "X", status: "blocked" }] }, "sage");
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "X", status: "pending" }] });
});

test("a missing status defaults to pending", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "X" }] }, "sage");
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "X", status: "pending" }] });
});

test("todos without usable content are dropped", () => {
  const out = toPlanSnapshot(
    "TodoWrite",
    { todos: [{ content: "Keep", status: "pending" }, { content: "" }, { status: "pending" }] },
    "sage",
  );
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "Keep", status: "pending" }] });
});

test("non-TodoWrite tools are ignored", () => {
  assert.equal(toPlanSnapshot("Read", { file_path: "x" }, "sage"), null);
  assert.equal(toPlanSnapshot("Bash", { command: "ls" }, "atlas"), null);
});

test("malformed TodoWrite input yields null", () => {
  assert.equal(toPlanSnapshot("TodoWrite", undefined, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", {}, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", { todos: "nope" }, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", { todos: [] }, "sage"), null);
});

test("a TodoWrite with only unusable todos yields null", () => {
  assert.equal(toPlanSnapshot("TodoWrite", { todos: [{ content: "" }, {}] }, "sage"), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `toPlanSnapshot` is not exported / module not found.

- [ ] **Step 3: Write the parser**

Create `src/lib/plan-events.ts`:

```ts
// A live "plan" is the most recent TodoWrite snapshot an agent has written.
// Pure + client-safe (no server-only, no React) so the SSE handler and tests
// can both use it. Mirrors src/lib/terminal-events.ts.

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface PlanSnapshot {
  agentId: string;
  todos: TodoItem[];
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

// Turn a TodoWrite tool input into a plan snapshot, or null if this is not a
// usable TodoWrite call. Defensive: the input crosses the SSE boundary as
// untyped JSON, so every field is validated/coerced.
export function toPlanSnapshot(
  tool: string,
  input: unknown,
  agentId: string,
): PlanSnapshot | null {
  if (tool !== "TodoWrite") return null;
  if (!input || typeof input !== "object") return null;

  const rawTodos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(rawTodos)) return null;

  const todos: TodoItem[] = [];
  for (const raw of rawTodos) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { content?: unknown; status?: unknown; activeForm?: unknown };
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!content) continue;

    const status: TodoStatus =
      typeof r.status === "string" && KNOWN_STATUSES.has(r.status)
        ? (r.status as TodoStatus)
        : "pending";

    const todo: TodoItem = { content, status };
    if (typeof r.activeForm === "string" && r.activeForm.trim()) {
      todo.activeForm = r.activeForm;
    }
    todos.push(todo);
  }

  if (todos.length === 0) return null;
  return { agentId, todos };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — all `plan-events` tests green (existing tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/plan-events.ts src/lib/plan-events.test.ts
git commit -m "feat(plan): toPlanSnapshot parser for TodoWrite -> plan snapshot"
```

---

## Task 2: `PlanView` presentational component

**Files:**
- Create: `src/components/plan-view.tsx`

This is a pure presentational component (no tests — it has no logic beyond rendering; behavior is covered by the Task 1 parser and the Task 3 manual check). It mirrors `src/components/terminal-view.tsx`: a `"use client"` component taking a single prop.

- [ ] **Step 1: Write the component**

Create `src/components/plan-view.tsx`:

```tsx
"use client";

import type { PlanSnapshot, TodoItem } from "@/lib/plan-events";

// Map an agent id to a display name for the plan header. Falls back to a
// capitalized id for any agent not explicitly named.
function ownerLabel(agentId: string): string {
  const known: Record<string, string> = { sage: "Sage", atlas: "Atlas" };
  const name = known[agentId] ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
  return `${name}'s plan`;
}

// One checklist row. Pending = hollow circle, in-progress = half circle (cyan,
// uses activeForm), completed = check (green, struck through).
function Row({ todo }: { todo: TodoItem }) {
  if (todo.status === "completed") {
    return (
      <li className="flex items-start gap-2.5 py-1">
        <span className="select-none text-green-400 mt-0.5">✓</span>
        <span className="text-[#5c6470] line-through">{todo.content}</span>
      </li>
    );
  }
  if (todo.status === "in_progress") {
    return (
      <li className="flex items-start gap-2.5 py-1">
        <span className="select-none text-cyan-400 mt-0.5">◐</span>
        <span className="text-[#e6edf3] font-medium">{todo.activeForm ?? todo.content}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2.5 py-1">
      <span className="select-none text-[#5c6470] mt-0.5">○</span>
      <span className="text-[#8b949e]">{todo.content}</span>
    </li>
  );
}

// Live plan checklist. Renders the most recent TodoWrite snapshot (latest writer
// wins, managed by the parent). Shows a quiet placeholder until the first plan
// arrives this session. Ephemeral — gone on a full reload.
export default function PlanView({ snapshot }: { snapshot: PlanSnapshot | null }) {
  if (!snapshot || snapshot.todos.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#11161d] border border-[#1e2632] rounded-lg p-5">
        <p className="text-[11px] text-[#5c6470]">
          No plan yet — Sage will chart the course when work begins.
        </p>
      </div>
    );
  }

  const total = snapshot.todos.length;
  const done = snapshot.todos.filter((t) => t.status === "completed").length;

  return (
    <div className="h-full flex flex-col bg-[#11161d] border border-[#1e2632] rounded-lg p-5 overflow-hidden">
      <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#2a3441] shrink-0">
        <h2 className="text-sm font-bold text-[#e6edf3] font-heading uppercase tracking-wide">
          {ownerLabel(snapshot.agentId)}
        </h2>
        <span className="bg-[#161c25] border border-[#2a3441] px-2 py-0.5 rounded text-[10px] text-cyan-400">
          {done} / {total}
        </span>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto text-xs font-sans leading-relaxed pr-1">
        {snapshot.todos.map((todo, i) => (
          <Row key={i} todo={todo} />
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no type errors. (If the repo has no standalone `tsc` script, this is fine; Task 3's build/typecheck will catch any error.)

- [ ] **Step 3: Commit**

```bash
git add src/components/plan-view.tsx
git commit -m "feat(plan): PlanView checklist component"
```

---

## Task 3: Wire the live plan into mission-control

**Files:**
- Modify: `src/components/mission-control.tsx`

- [ ] **Step 1: Add the imports**

Near the other component/lib imports at the top of `src/components/mission-control.tsx`, add:

```tsx
import PlanView from "@/components/plan-view";
import { toPlanSnapshot, type PlanSnapshot } from "@/lib/plan-events";
```

(Match the existing import style — the file already imports `TerminalView` and `@/lib` modules; place these alongside them.)

- [ ] **Step 2: Add the `plan` state**

Find the Terminal-tab state declaration (`const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);`, ~line 195) and add directly below it:

```tsx
  // Live Plan tab: the most recent TodoWrite snapshot (latest writer wins).
  // Ephemeral — gone on full reload, persists across turns, not cleared on Stop.
  const [plan, setPlan] = useState<PlanSnapshot | null>(null);
```

- [ ] **Step 3: Feed `toPlanSnapshot` from the activity branch**

In the `es.onmessage` handler, the `activity` branch currently reads (~line 355):

```tsx
          if (evt.type === "activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
          } else if (evt.type === "terminal" && typeof evt.content === "string" && evt.stream) {
```

Add the snapshot feed inside the `activity` branch, after the `setAgentActivity` line:

```tsx
          if (evt.type === "activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
            const snap = toPlanSnapshot(evt.tool, evt.input, agentId);
            if (snap) setPlan(snap);
          } else if (evt.type === "terminal" && typeof evt.content === "string" && evt.stream) {
```

- [ ] **Step 4: Feed `toPlanSnapshot` from the dispatch_activity branch**

The `dispatch_activity` branch currently reads (~line 374):

```tsx
          } else if (evt.type === "dispatch_activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
          } else if (evt.type === "token" && typeof evt.content === "string") {
```

Add the same feed, after the `setAgentActivity` line:

```tsx
          } else if (evt.type === "dispatch_activity" && evt.agent_id && evt.tool) {
            const agentId = evt.agent_id;
            const label = friendlyActivity(agentId, evt.tool, evt.input);
            setAgentActivity((prev) => ({ ...prev, [agentId]: label }));
            const snap = toPlanSnapshot(evt.tool, evt.input, agentId);
            if (snap) setPlan(snap);
          } else if (evt.type === "token" && typeof evt.content === "string") {
```

- [ ] **Step 5: Replace the Plan tab JSX with `PlanView`**

Replace the entire current Plan tab block (~lines 1090–1106):

```tsx
            {activeTab === "plan" && (
              <ScrollArea className="h-full bg-[#11161d] border border-[#1e2632] rounded-lg p-5">
                <div className="prose prose-invert max-w-none text-xs text-[#8b949e] font-mono">
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-[#2a3441]">
                    <h2 className="text-sm font-bold text-[#e6edf3] font-heading uppercase tracking-wide">
                      Dynamic Plan
                    </h2>
                    <span className="bg-[#161c25] border border-[#2a3441] px-2 py-0.5 rounded text-[10px] text-cyan-400">
                      UPDATED
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap leading-relaxed text-xs font-sans text-[#8b949e]">
                    {artifacts.find((a) => a.type === "plan")?.content}
                  </pre>
                </div>
              </ScrollArea>
            )}
```

with:

```tsx
            {activeTab === "plan" && <PlanView snapshot={plan} />}
```

- [ ] **Step 6: Confirm the `plan` artifact lookup is gone, but the type stays**

Run: `git grep -n "type === \"plan\"" src/components/mission-control.tsx`
Expected: no matches (the only lookup was the one removed in Step 5).

Do **not** touch the `'plan'` member of the `Artifact` type union in `src/lib/mock-data.ts` — it is still a valid artifact type; the dead `art_plan` mock row is swept up in the Day 5 cleanup.

- [ ] **Step 7: Typecheck / build**

Run: `pnpm build`
Expected: PASS — compiles with no type errors and no unused-import warnings for `ScrollArea` (verify `ScrollArea` is still used elsewhere in the file; if Step 5 removed its last use, also remove its now-unused import).

- [ ] **Step 8: Manual verification**

Run: `pnpm dev` → open http://localhost:3000 (log in), open a session, switch to the **Plan** tab.
- Before sending anything: the empty placeholder shows ("No plan yet …").
- Send Sage a task that warrants planning (e.g. "Plan out adding a footer to the site, then do it"). As Sage calls `TodoWrite`, the checklist appears under "Sage's plan", with a live `done / total` count and rows checking off (○ → ◐ → ✓).
- If Sage dispatches a specialist that writes its own todos, the tab switches to that agent's plan (latest writer wins).

- [ ] **Step 9: Commit**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(plan): live TodoWrite-driven Plan tab, drop mock plan render"
```

---

## Task 4: Update project docs (Day 4 done)

**Files:**
- Modify: `docs/plans/week-4-workspace-tabs.md`

- [ ] **Step 1: Check off Day 4 in the week plan**

Open `docs/plans/week-4-workspace-tabs.md`, find the Day 4 line/section for the Plan tab, and mark it complete (match the file's existing convention for marking days done — e.g. checkbox or a "done" note). Add a one-line pointer to the spec/plan: `docs/superpowers/specs/2026-05-31-plan-tab-live-todowrite-design.md`.

- [ ] **Step 2: Commit**

```bash
git add docs/plans/week-4-workspace-tabs.md
git commit -m "docs(week-4): mark Day 4 (live Plan tab) complete"
```

- [ ] **Step 3: Update the progress memory (outside the repo)**

Update the `week-4-progress` auto-memory file: move Day 4 into "Done" with a short note (parser `src/lib/plan-events.ts`, `PlanView`, `plan` state in `mission-control.tsx`, latest-writer-wins, ephemeral), and set "Next" to Day 5 (mock-data cleanup incl. `art_plan` + `art_terminal`, tab badges, mobile-responsive check, write `docs/plans/week-5-deploy.md`, `dev` → `main` merge + first push). This is a memory file, not a repo commit.

---

## Self-Review notes

- **Spec coverage:** ephemeral state (Task 3 Step 2) ✓; latest-writer-wins (Task 3 Steps 3–4, `setPlan` replace) ✓; empty placeholder (Task 2 component) ✓; both Sage `activity` + specialist `dispatch_activity` sources (Task 3 Steps 3–4) ✓; parser defensiveness incl. status coercion + dropping empty todos (Task 1) ✓; `'plan'` type union kept, mock render removed, `art_plan` deferred (Task 3 Step 6) ✓; docs update (Task 4) ✓.
- **Type consistency:** `toPlanSnapshot(tool, input, agentId)` and `PlanSnapshot { agentId, todos }` / `TodoItem { content, status, activeForm? }` used identically across Tasks 1–3.
- **Placeholders:** none — all code steps show full code.
