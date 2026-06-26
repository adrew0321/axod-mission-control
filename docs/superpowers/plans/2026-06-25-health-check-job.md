# Nightly Health-Check Job + Real Pass/Fail Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nightly health-check schedule (runs `pnpm test` + `pnpm build` via Echo) and make the Scheduler surface a failing check as a distinct red `fail` status instead of always `ok`.

**Architecture:** The agent ends its report with `HEALTH: PASS|FAIL`. A pure `parseHealthVerdict` reads that token; a pure `healthStatus` maps `(TurnResult, finalMessage)` → `'ok' | 'fail' | 'skipped' | 'error'`. The Scheduler fetches the session's final agent message after the turn and writes the mapped status to `schedules.last_status`. The Scheduler UI renders `fail` red. Verdict parsing is generic — jobs that emit no token keep their existing status.

**Tech Stack:** TypeScript, Drizzle + better-sqlite3, `node:test` via `tsx`, Next.js (Scheduler UI).

## Global Constraints

- Tests use `node:test` + `node:assert/strict`, run via `pnpm test` (`tsx --test src/lib/*.test.ts`).
- Import local modules WITHOUT file extensions (e.g. `from './health-verdict'`).
- The test runner CANNOT load modules that `import 'server-only'` (e.g. `db/client`, `run-turn`). Therefore: only PURE modules get unit tests; for types from a server-only module use `import type { … }` (erased at runtime, so it never loads the module).
- Verdict token is `HEALTH: PASS` / `HEALTH: FAIL`: case-insensitive, tolerant of surrounding backticks/asterisks, and when multiple appear the LAST occurrence wins. A bare `HEALTH:` with no following `PASS`/`FAIL` must NOT match.
- New `last_status` value is the literal string `'fail'`; it must render red in the Scheduler UI. Existing values (`'ok'` green, `'error'` red, else amber) are unchanged.
- Non-health jobs (no token in their final message) must keep their current status mapping (`completed`→`'ok'`).
- Implementation runs in an isolated git worktree off `dev` (the repo is the live app dir — never branch-switch it).

---

### Task 1: `parseHealthVerdict` (pure)

**Files:**
- Create: `src/lib/health-verdict.ts`
- Test: `src/lib/health-verdict.test.ts`

**Interfaces:**
- Produces: `parseHealthVerdict(text: string): 'pass' | 'fail' | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/health-verdict.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHealthVerdict } from './health-verdict';

test('PASS token → pass', () => {
  assert.equal(parseHealthVerdict('all checks green\nHEALTH: PASS'), 'pass');
});

test('FAIL token → fail', () => {
  assert.equal(parseHealthVerdict('build broke\nHEALTH: FAIL'), 'fail');
});

test('multiple tokens → last occurrence wins', () => {
  assert.equal(parseHealthVerdict('HEALTH: PASS\nwait, no\nHEALTH: FAIL'), 'fail');
});

test('case-insensitive', () => {
  assert.equal(parseHealthVerdict('health: pass'), 'pass');
});

test('tolerant of backticks / emphasis around the token', () => {
  assert.equal(parseHealthVerdict('`HEALTH: FAIL`'), 'fail');
  assert.equal(parseHealthVerdict('**HEALTH: PASS**'), 'pass');
  assert.equal(parseHealthVerdict('HEALTH: `PASS`'), 'pass');
});

test('no token → null', () => {
  assert.equal(parseHealthVerdict('everything looks fine to me'), null);
});

test('bare HEALTH: with no PASS/FAIL does not false-positive', () => {
  assert.equal(parseHealthVerdict('We will check HEALTH: of the system later'), null);
});

test('empty / undefined-ish input → null', () => {
  assert.equal(parseHealthVerdict(''), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/health-verdict.test.ts`
Expected: FAIL — cannot find module `./health-verdict` / `parseHealthVerdict` is not a function.

- [ ] **Step 3: Write the implementation**

Create `src/lib/health-verdict.ts`:

```ts
// Pure helpers for the Scheduler's health signal. No DB, no server-only —
// unit-testable under `tsx --test`.

/**
 * Read a machine-readable health verdict from an agent's report. Matches a
 * `HEALTH: PASS` / `HEALTH: FAIL` token (case-insensitive), tolerating backticks
 * or asterisks around it. When several appear, the LAST one wins — it is the
 * agent's final word. Returns null when no PASS/FAIL verdict is present.
 */
export function parseHealthVerdict(text: string): 'pass' | 'fail' | null {
  if (!text) return null;
  const re = /health:\s*[`*]*\s*(pass|fail)\b/gi;
  let last: 'pass' | 'fail' | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1].toLowerCase() as 'pass' | 'fail';
  }
  return last;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/health-verdict.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/health-verdict.ts src/lib/health-verdict.test.ts
git commit -m "feat(scheduler): parseHealthVerdict — read HEALTH: PASS/FAIL from agent report"
```

---

### Task 2: `healthStatus` mapping (pure)

**Files:**
- Modify: `src/lib/health-verdict.ts` (add `healthStatus`)
- Modify: `src/lib/health-verdict.test.ts` (add mapping tests)

**Interfaces:**
- Consumes: `parseHealthVerdict` (Task 1); `TurnResult` type from `run-turn` (type-only import — `run-turn` is server-only, so a value import would break the test runner; `import type` is erased at runtime).
- Produces: `healthStatus(result: TurnResult, finalMessage: string | null): 'ok' | 'fail' | 'skipped' | 'error'`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/health-verdict.test.ts`:

```ts
import { healthStatus } from './health-verdict';

test('completed + FAIL verdict → fail', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'oops\nHEALTH: FAIL'), 'fail');
});

test('completed + PASS verdict → ok', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'HEALTH: PASS'), 'ok');
});

test('completed + no verdict → ok (non-health jobs unaffected)', () => {
  assert.equal(healthStatus({ status: 'completed' }, 'here is your digest'), 'ok');
  assert.equal(healthStatus({ status: 'completed' }, null), 'ok');
});

test('skipped → skipped, error → error (verdict ignored)', () => {
  assert.equal(healthStatus({ status: 'skipped' }, 'HEALTH: PASS'), 'skipped');
  assert.equal(healthStatus({ status: 'error' }, 'HEALTH: PASS'), 'error');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/health-verdict.test.ts`
Expected: FAIL — `healthStatus` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/lib/health-verdict.ts` (and the type-only import at the top of the file):

```ts
import type { TurnResult } from './run-turn'; // type-only: erased at runtime, never loads the server-only module
```

```ts
/**
 * Map a turn's result + its final agent message to a Scheduler status.
 * A failed turn stays 'error' (infra) and a skipped turn 'skipped'; a completed
 * turn is 'fail' only when the agent emitted HEALTH: FAIL, otherwise 'ok'. So a
 * red build shows red while ordinary jobs (no verdict) stay 'ok'.
 */
export function healthStatus(
  result: TurnResult,
  finalMessage: string | null,
): 'ok' | 'fail' | 'skipped' | 'error' {
  if (result.status === 'skipped') return 'skipped';
  if (result.status === 'error') return 'error';
  return parseHealthVerdict(finalMessage ?? '') === 'fail' ? 'fail' : 'ok';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/health-verdict.test.ts`
Expected: PASS (Task 1 + Task 2 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/health-verdict.ts src/lib/health-verdict.test.ts
git commit -m "feat(scheduler): healthStatus — map turn result + verdict to status"
```

---

### Task 3: Wire the signal into the Scheduler + render `fail` red

No new unit test: this touches `server-only` modules (`scheduler.ts` imports the DB) which the test runner cannot load, and a React component. The decision logic is already covered by Task 2's pure tests. Verification is `tsc --noEmit` + the full suite (no regressions).

**Files:**
- Modify: `src/lib/scheduler.ts` (add `getFinalAgentMessage`; use `healthStatus` for `last_status`)
- Modify: `src/components/scheduler-view.tsx` (`statusColor`: add `fail` → red)

**Interfaces:**
- Consumes: `healthStatus` (Task 2).

- [ ] **Step 1: Add `getFinalAgentMessage` and use `healthStatus` in `scheduler.ts`**

At the top of `src/lib/scheduler.ts`, add to the existing imports:

```ts
import { and, desc, eq, lte } from 'drizzle-orm';
import { schedules, sessions, projects, messages } from '@/db/schema';
import { healthStatus } from '@/lib/health-verdict';
```

(The existing import line is `import { and, eq, lte } from 'drizzle-orm';` — add `desc`. The existing schema import is `import { schedules, sessions, projects } from '@/db/schema';` — add `messages`.)

Add this helper below the imports (before `startScheduler`):

```ts
/** The most recent agent-authored message in a session, or null. */
async function getFinalAgentMessage(sessionId: string): Promise<string | null> {
  const row = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'agent')))
    .orderBy(desc(messages.created_at))
    .limit(1)
    .then((r) => r[0]);
  return row?.content ?? null;
}
```

Replace the current status mapping in `tick()`:

```ts
      const result = await runSessionTurn(sessionId, { instruction: s.instruction });
      const last_status =
        result.status === 'completed' ? 'ok' : result.status === 'skipped' ? 'skipped' : 'error';
```

with:

```ts
      const result = await runSessionTurn(sessionId, { instruction: s.instruction });
      const finalMessage =
        result.status === 'completed' ? await getFinalAgentMessage(sessionId) : null;
      const last_status = healthStatus(result, finalMessage);
```

- [ ] **Step 2: Render `fail` red in the Scheduler UI**

In `src/components/scheduler-view.tsx`, the current `statusColor`:

```ts
  const statusColor = (s: string | null) =>
    s === "ok" ? "text-emerald-400" : s === "error" ? "text-red-400" : "text-amber-400";
```

Replace with:

```ts
  const statusColor = (s: string | null) =>
    s === "ok"
      ? "text-emerald-400"
      : s === "error" || s === "fail"
        ? "text-red-400"
        : "text-amber-400";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Full suite — no regressions**

Run: `pnpm test`
Expected: all pure tests pass (Task 1+2 health-verdict tests included); 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler.ts src/components/scheduler-view.tsx
git commit -m "feat(scheduler): record real health status from agent verdict; render fail red"
```

---

### Task 4: Build-in-worktree spike + create the nightly schedule (post-merge activation)

Run this AFTER Tasks 1-3 are merged to `dev`, in the LIVE app environment (so `.env`/`DATABASE_PATH` are loaded and the build runs against real deps) — NOT inside the isolated implementation worktree. This is operational activation, not code.

- [ ] **Step 1: Spike — confirm `pnpm build` works in a session worktree**

Trigger one agent turn for the `mission-control` project that runs `pnpm build` in its worktree (e.g. send Echo the instruction below as a one-off chat message, or temporarily create the schedule and run it). Observe whether `next build` completes.

- If it COMPLETES → use the test+build instruction in Step 2 as written.
- If it FAILS on env/data (e.g. unset `DATABASE_PATH`, missing `data/` dir) → decide with the operator: either (a) provision `.env` into worktrees (a small follow-up paralleling the `node_modules` link in `worktree.ts`), or (b) drop `pnpm build` from the instruction and ship test-only for v1. Record the decision in this plan file before continuing.

**OUTCOME (2026-06-25): SHIPPED TEST-ONLY.** The spike failed, but not on env/data — Next 16's **Turbopack rejects the linked `node_modules`**: `TurbopackInternalError: Symlink [project]/node_modules is invalid, it points out of the filesystem root`. The junction (which makes `pnpm test` work) points outside the worktree root, and Turbopack refuses it. So `build`-in-worktree is incompatible with the link approach; option (a) doesn't help (not an env issue). Per option (b), the schedule was created with a **test-only** instruction. FOLLOW-UP to enable build later: build jobs need a real (copied) `node_modules` inside the worktree, not a junction — a separate, larger piece.

- [ ] **Step 2: Create the schedule**

Create it via the Scheduler UI (the "new schedule" form) OR the authenticated `POST /api/schedules` endpoint, with:

- **project:** `mission-control`
- **title:** `Nightly health check`
- **cadence:** daily at `03:00` (kind `daily`, `timeOfDay: "03:00"`)
- **instruction** (use the test-only variant instead if Step 1 chose (b)):

  ```
  @Echo: Nightly health check for AXOD Mission Control. In this worktree run `pnpm test`, then `pnpm build`. Summarize what passed and what failed, including the key error lines for any failure. End your message with EXACTLY one line — `HEALTH: PASS` if BOTH succeeded, otherwise `HEALTH: FAIL`.
  ```

- [ ] **Step 3: Verify the signal end-to-end**

Run the schedule once (UI run button or wait for 03:00). Confirm:
- A green tree shows `last · <time> ok` (green) in the Scheduler.
- An intentionally broken tree (or a manual `HEALTH: FAIL` test) shows `fail` (red).

This step has no commit (it creates a DB row + observes behavior).

---

## Self-Review

**Spec coverage:**
- Explicit verdict token, parsed → Task 1 `parseHealthVerdict`. ✓
- Generic (non-health jobs unaffected) → Task 2 `healthStatus` returns `'ok'` on no token; tested. ✓
- Pure `healthStatus(result, finalMessage)` mapping → Task 2. ✓
- `getFinalAgentMessage` + scheduler wiring → Task 3. ✓
- UI `fail` → red → Task 3 Step 2. ✓
- No schema change (`'fail'` is a new free-text value) → confirmed; no migration task. ✓
- Nightly schedule (Echo, test+build, 03:00, mission-control) → Task 4. ✓
- Build-in-worktree spike first → Task 4 Step 1. ✓
- Testing (verdict cases incl. last-wins/case-insensitive/no-false-positive; mapping cases) → Tasks 1-2. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". Task 4's (a)/(b) branch is a real, documented decision point with concrete options, not a placeholder. ✓

**Type consistency:** `parseHealthVerdict(text): 'pass'|'fail'|null` and `healthStatus(result: TurnResult, finalMessage: string|null): 'ok'|'fail'|'skipped'|'error'` are used identically across tasks. `TurnResult` matches `run-turn.ts` (`{ status: 'completed'|'skipped'|'error'; reason?: string }`) and is imported type-only. `messages` columns (`session_id`, `role`, `content`, `created_at`) match the schema. `last_status` string `'fail'` matches the UI check. ✓
