# Dreaming / Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Curator that, on demand and nightly, reviews recent conversations and surfaces structured insights into a Dreaming view.

**Architecture:** Two pure helpers (`parseInsights`, `isDreamDue`) feed a server-only `runDream()` that gathers recent sessions+messages, runs the Curator via `runClaudeAgent` (no worktree), parses a JSON insight array, and persists `dreams` + `dream_insights`. A manual `POST /api/dream` and a nightly check in `src/instrumentation.ts` trigger it; a Dreaming view renders the feed with per-insight star/dismiss.

**Tech Stack:** Next.js 16 (vendored, Turbopack), TypeScript, drizzle-orm + better-sqlite3, the Claude Agent SDK (`runClaudeAgent`), `node:test` via `tsx`, zod, Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-22-dreaming-curator-design.md`.

## Global Constraints

- **Imports are extensionless** (`from '@/lib/...'`); a `.ts` extension breaks `tsc`/`next build`.
- **Server-only modules** (`dream.ts`, `dreams-data.ts`, routes) import `'server-only'` and are NOT unit-tested. Only the pure `dream-insights.ts` + `dream-due.ts` get unit tests.
- **Tests:** `pnpm test` runs `tsx --test src/lib/*.test.ts`. After every task: `pnpm test` green AND `pnpm build` passes before committing.
- **IDs:** `dream_${bytesToHex(randomBytes(4))}` / `insight_${bytesToHex(randomBytes(4))}` via `@noble/hashes/utils.js`.
- **Cookie auth** on every route: the `SESSION_COOKIE` + `verifySession` pattern from `src/app/api/schedules/route.ts`.
- **Categories** are exactly `pattern | risk | suggestion | praise`. **Insight status** is `new | starred | dismissed`. **Dream status** is `ok | empty | error`.
- **Curator model** is `claude-opus-4-7` (matches Sage / the app's convention). Local time for the nightly hour.

## Notes for the implementer (read first)

- **Isolation:** Work in an isolated worktree on a `feature/dreaming` branch (this repo is the live app dir — don't branch-switch it in place). Create it via `superpowers:using-git-worktrees` before Task 1; base it on current `dev` HEAD (which already includes the Scheduler — `instrumentation.ts`, the nav `scheduler` entry, `initialSchedules` on the page). Merge to `dev` when done.
- **Fresh-worktree env gotchas:** after `pnpm install`, copy the main repo's `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node` into the same path in the worktree, and `mkdir -p data/worktrees` before `pnpm build`/`db:migrate`. Do NOT run `pnpm approve-builds`. Revert any `pnpm-workspace.yaml` change `pnpm install` auto-writes.

## File Structure

- **Create** `src/lib/dream-insights.ts` — `Insight`, `InsightCategory`, `parseInsights`. Pure, unit-tested.
- **Create** `src/lib/dream-insights.test.ts`.
- **Create** `src/lib/dream-due.ts` — `isDreamDue`. Pure, unit-tested.
- **Create** `src/lib/dream-due.test.ts`.
- **Modify** `src/db/schema.ts` — add `dreams` + `dream_insights` (+ migration).
- **Create** `src/lib/dream.ts` — `runDream`, `startDreaming`, Curator constants (server-only).
- **Modify** `src/instrumentation.ts` — also `startDreaming()`.
- **Create** `src/app/api/dream/route.ts` — `POST` manual trigger.
- **Create** `src/app/api/insights/[id]/route.ts` — `PATCH` star/dismiss.
- **Create** `src/lib/dreams-data.ts` — `getDreams()` + `DreamView`/`InsightView`.
- **Create** `src/components/dreaming-view.tsx` — the UI.
- **Modify** `src/lib/nav-sections.ts` + `src/lib/nav-sections.test.ts` — flip `dreaming` to live.
- **Modify** `src/app/page.tsx` — `getDreams()` → `initialDreams`.
- **Modify** `src/components/mission-control.tsx` — render `DreamingView`.

---

## Task 1: Pure helpers (TDD)

**Files:**
- Create: `src/lib/dream-insights.ts`, `src/lib/dream-due.ts`
- Test: `src/lib/dream-insights.test.ts`, `src/lib/dream-due.test.ts`

**Interfaces:**
- Produces: `InsightCategory`, `Insight {category,title,detail}`, `parseInsights(text: string): Insight[]`, `isDreamDue(lastDreamAt: Date | null, now: Date, hour: number): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dream-insights.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInsights } from "./dream-insights";

test("parses a clean JSON array", () => {
  const text = '[{"category":"risk","title":"T","detail":"D"}]';
  assert.deepEqual(parseInsights(text), [{ category: "risk", title: "T", detail: "D" }]);
});

test("parses a fenced ```json block with surrounding prose", () => {
  const text = 'Here are my insights:\n```json\n[{"category":"pattern","title":"P","detail":"d"}]\n```\nDone.';
  assert.deepEqual(parseInsights(text), [{ category: "pattern", title: "P", detail: "d" }]);
});

test("drops items with an unknown category", () => {
  const text = '[{"category":"bogus","title":"x","detail":"y"},{"category":"praise","title":"ok","detail":"good"}]';
  assert.deepEqual(parseInsights(text), [{ category: "praise", title: "ok", detail: "good" }]);
});

test("drops items missing a field or with empty strings", () => {
  const text = '[{"category":"risk","title":"x"},{"category":"risk","title":" ","detail":"y"},{"category":"suggestion","title":"keep","detail":"this"}]';
  assert.deepEqual(parseInsights(text), [{ category: "suggestion", title: "keep", detail: "this" }]);
});

test("trims title and detail", () => {
  assert.deepEqual(parseInsights('[{"category":"risk","title":"  T  ","detail":"  D  "}]'), [
    { category: "risk", title: "T", detail: "D" },
  ]);
});

test("returns [] for non-JSON / no array", () => {
  assert.deepEqual(parseInsights("I could not find anything notable."), []);
  assert.deepEqual(parseInsights(""), []);
});
```

Create `src/lib/dream-due.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDreamDue } from "./dream-due";

const at = (h: number) => { const d = new Date(2026, 5, 22, h, 0, 0, 0); return d; };

test("not due before the nightly hour", () => {
  assert.equal(isDreamDue(null, at(1), 3), false);
});

test("due after the hour with no prior dream", () => {
  assert.equal(isDreamDue(null, at(4), 3), true);
});

test("not due after the hour when last dream was recent (<12h)", () => {
  const now = at(4);
  const recent = new Date(now.getTime() - 2 * 3_600_000);
  assert.equal(isDreamDue(recent, now, 3), false);
});

test("due after the hour when last dream is stale (>12h)", () => {
  const now = at(4);
  const stale = new Date(now.getTime() - 26 * 3_600_000);
  assert.equal(isDreamDue(stale, now, 3), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test`
Expected: FAIL — `./dream-insights` / `./dream-due` not found.

- [ ] **Step 3: Write the modules**

Create `src/lib/dream-insights.ts`:

```ts
// Pure parser for the Curator's output → structured insights. Tolerant of a
// fenced ```json block or a bare [...] array embedded in prose. No DB, no
// server-only — unit-testable.

export type InsightCategory = "pattern" | "risk" | "suggestion" | "praise";
export interface Insight {
  category: InsightCategory;
  title: string;
  detail: string;
}

const CATEGORIES = new Set<InsightCategory>(["pattern", "risk", "suggestion", "praise"]);

function extractJsonArray(text: string): unknown {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export function parseInsights(text: string): Insight[] {
  const arr = extractJsonArray(text);
  if (!Array.isArray(arr)) return [];
  const out: Insight[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { category, title, detail } = item as Record<string, unknown>;
    if (typeof category !== "string" || !CATEGORIES.has(category as InsightCategory)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof detail !== "string" || !detail.trim()) continue;
    out.push({ category: category as InsightCategory, title: title.trim(), detail: detail.trim() });
  }
  return out;
}
```

Create `src/lib/dream-due.ts`:

```ts
// Pure nightly gate for the Dreaming ticker. No DB, no server-only — unit-testable.

const TWELVE_HOURS_MS = 12 * 3_600_000;

/**
 * True when it's time for a nightly dream: the local hour is at/after `hour`
 * AND the last dream is either absent or older than 12h. The 12h floor stops
 * re-firing across the same night and absorbs a downtime catch-up to one run.
 */
export function isDreamDue(lastDreamAt: Date | null, now: Date, hour: number): boolean {
  if (now.getHours() < hour) return false;
  if (!lastDreamAt) return true;
  return now.getTime() - lastDreamAt.getTime() > TWELVE_HOURS_MS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — new tests green; existing suite unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dream-insights.ts src/lib/dream-insights.test.ts src/lib/dream-due.ts src/lib/dream-due.test.ts
git commit -m "feat(dreaming): pure insight parser + nightly due-gate"
```

---

## Task 2: `dreams` + `dream_insights` tables + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: a generated migration under `drizzle/`

**Interfaces:**
- Produces: the `dreams` and `dream_insights` drizzle tables.

- [ ] **Step 1: Add the tables**

In `src/db/schema.ts`, after the `schedules` table definition (added by the Scheduler) and before `export const auth_users`, add:

```ts
export const dreams = sqliteTable('dreams', {
  id: text('id').primaryKey(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  // Window start this dream reflected on: previous dream's created_at, or now-7d.
  covers_since: integer('covers_since', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(), // 'ok' | 'empty' | 'error'
  insight_count: integer('insight_count').notNull().default(0),
  error: text('error'),
});

export const dream_insights = sqliteTable('dream_insights', {
  id: text('id').primaryKey(),
  dream_id: text('dream_id').references(() => dreams.id).notNull(),
  category: text('category').notNull(), // 'pattern' | 'risk' | 'suggestion' | 'praise'
  title: text('title').notNull(),
  detail: text('detail').notNull(),
  status: text('status').notNull().default('new'), // 'new' | 'starred' | 'dismissed'
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 2: Generate + apply the migration**

Run: `pnpm db:generate`
Expected: a new `drizzle/0006_*.sql` (number may differ) with `CREATE TABLE \`dreams\`` and `CREATE TABLE \`dream_insights\``.

Run: `pnpm db:migrate`
Expected: "migrations applied successfully".

- [ ] **Step 3: Verify + build**

Run:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');console.log('dreams:',db.prepare('PRAGMA table_info(dreams)').all().map(c=>c.name).join(','));console.log('insights:',db.prepare('PRAGMA table_info(dream_insights)').all().map(c=>c.name).join(','));db.close();"
```
Expected: `dreams: id,created_at,covers_since,status,insight_count,error` and `insights: id,dream_id,category,title,detail,status,created_at`.

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(dreaming): dreams + dream_insights tables + migration"
```

---

## Task 3: The Curator runner — `runDream` + `startDreaming`

**Files:**
- Create: `src/lib/dream.ts`

**Interfaces:**
- Consumes: `dreams`, `dream_insights`, `sessions`, `messages`, `agents` tables; `runClaudeAgent` (`@/lib/agent-runner-sdk`); `parseInsights` (Task 1); `isDreamDue` (Task 1).
- Produces: `runDream(): Promise<RunDreamResult>` where `RunDreamResult = { status: 'ok'|'empty'|'error'; dreamId?: string; reason?: string }`; `startDreaming(): void`; `CURATOR_MODEL`, `CURATOR_SYSTEM_PROMPT`.

- [ ] **Step 1: Create the file**

Create `src/lib/dream.ts`:

```ts
import 'server-only';
import { asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { dreams, dream_insights, sessions, messages, agents } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { parseInsights } from '@/lib/dream-insights';
import { isDreamDue } from '@/lib/dream-due';

export const CURATOR_MODEL = 'claude-opus-4-7';

export const CURATOR_SYSTEM_PROMPT = `You are the Curator of AXOD Mission Control — a reflective observer of an AI agent team (Sage the orchestrator plus specialists) working for a single operator on real code.

You are given a transcript of the team's RECENT activity (sessions and messages since the last time you reflected). Your job is to surface a small number of genuinely useful insights about how the work is going — patterns worth noticing, risks worth flagging, concrete suggestions, and earned praise. Be specific and ground every insight in what the transcript actually shows. Do not invent activity that isn't there. Quality over quantity: 0 to 6 insights. If nothing is worth surfacing, return an empty array.

Respond with ONLY a JSON array (optionally inside a \`\`\`json fence), each element:
{ "category": "pattern" | "risk" | "suggestion" | "praise", "title": "<one concise line>", "detail": "<1-3 sentences>" }

No prose outside the array.`;

const DEFAULT_LOOKBACK_MS = 7 * 24 * 3_600_000;
const MAX_MESSAGES = 200;
const MAX_CONTEXT_CHARS = 40_000;
const DREAM_TICK_MS = 15 * 60_000;
const NIGHTLY_HOUR = 3;

export interface RunDreamResult {
  status: 'ok' | 'empty' | 'error';
  dreamId?: string;
  reason?: string;
}

function formatContext(
  rows: Array<{ sessionId: string; sessionTitle: string | null; role: string; agentId: string | null; content: string }>,
  nameFor: (agentId: string | null, role: string) => string,
): string {
  const bySession = new Map<string, { title: string; lines: string[] }>();
  for (const r of rows) {
    if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, { title: r.sessionTitle ?? '(untitled)', lines: [] });
    bySession.get(r.sessionId)!.lines.push(`${nameFor(r.agentId, r.role)}: ${r.content}`);
  }
  const blocks: string[] = [];
  for (const [, s] of bySession) blocks.push(`## Session: ${s.title}\n${s.lines.join('\n')}`);
  return `# Recent team activity to reflect on\n\n${blocks.join('\n\n')}`;
}

/**
 * Run one Curator reflection: gather conversations since the last dream, ask the
 * Curator for structured insights, persist them. Single-in-flight via a globalThis
 * flag. Never throws — failures land as a 'error' dream row.
 */
export async function runDream(): Promise<RunDreamResult> {
  const g = globalThis as unknown as { __mcDreamInProgress?: boolean };
  if (g.__mcDreamInProgress) return { status: 'error', reason: 'already dreaming' };
  g.__mcDreamInProgress = true;
  const now = new Date();
  try {
    const last = await db
      .select({ created_at: dreams.created_at })
      .from(dreams)
      .orderBy(desc(dreams.created_at))
      .limit(1)
      .then((r) => r[0]);
    const coversSince = last?.created_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);

    const rows = await db
      .select({
        sessionId: messages.session_id,
        sessionTitle: sessions.title,
        role: messages.role,
        agentId: messages.agent_id,
        content: messages.content,
      })
      .from(messages)
      .innerJoin(sessions, eq(messages.session_id, sessions.id))
      .where(gt(messages.created_at, coversSince))
      .orderBy(asc(messages.created_at))
      .limit(MAX_MESSAGES);

    if (rows.length === 0) {
      const id = `dream_${bytesToHex(randomBytes(4))}`;
      await db.insert(dreams).values({ id, created_at: now, covers_since: coversSince, status: 'empty', insight_count: 0 });
      return { status: 'empty', dreamId: id };
    }

    const allAgents = await db.select({ id: agents.id, name: agents.name }).from(agents);
    const nameFor = (agentId: string | null, role: string) =>
      role === 'user' ? 'Operator' : allAgents.find((a) => a.id === agentId)?.name ?? agentId ?? 'System';

    let context = formatContext(rows, nameFor);
    if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS);

    let fullText = '';
    for await (const ev of runClaudeAgent({
      prompt: context,
      workingDir: process.cwd(),
      model: CURATOR_MODEL,
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'], // read-only; the Curator works from the provided context
    })) {
      if (ev.type === 'done') fullText = ev.fullText;
      else if (ev.type === 'error') throw new Error(ev.message);
    }

    const insights = parseInsights(fullText);
    const id = `dream_${bytesToHex(randomBytes(4))}`;
    await db.insert(dreams).values({
      id,
      created_at: now,
      covers_since: coversSince,
      status: insights.length > 0 ? 'ok' : 'empty',
      insight_count: insights.length,
    });
    for (const ins of insights) {
      await db.insert(dream_insights).values({
        id: `insight_${bytesToHex(randomBytes(4))}`,
        dream_id: id,
        category: ins.category,
        title: ins.title,
        detail: ins.detail,
        status: 'new',
        created_at: new Date(),
      });
    }
    return { status: insights.length > 0 ? 'ok' : 'empty', dreamId: id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.insert(dreams).values({
        id: `dream_${bytesToHex(randomBytes(4))}`,
        created_at: now,
        covers_since: now,
        status: 'error',
        insight_count: 0,
        error: message,
      });
    } catch {
      /* best-effort */
    }
    return { status: 'error', reason: message };
  } finally {
    g.__mcDreamInProgress = false;
  }
}

/**
 * Start the nightly Dreaming ticker. Idempotent (globalThis flag). Every 15 min it
 * checks isDreamDue against the latest dream; runDream's own in-flight guard
 * prevents overlap with a manual trigger.
 */
export function startDreaming(): void {
  const g = globalThis as unknown as { __mcDreamingStarted?: boolean };
  if (g.__mcDreamingStarted) return;
  g.__mcDreamingStarted = true;
  const check = async () => {
    try {
      const last = await db
        .select({ created_at: dreams.created_at })
        .from(dreams)
        .orderBy(desc(dreams.created_at))
        .limit(1)
        .then((r) => r[0]);
      if (isDreamDue(last?.created_at ?? null, new Date(), NIGHTLY_HOUR)) await runDream();
    } catch (err) {
      console.error('[dreaming] check failed:', err instanceof Error ? err.message : err);
    }
  };
  void check();
  setInterval(() => void check(), DREAM_TICK_MS);
  console.log(`[dreaming] started (nightly hour ${NIGHTLY_HOUR})`);
}
```

- [ ] **Step 2: Typecheck / build**

Run: `pnpm build`
Expected: PASS. (`runClaudeAgent`'s `AgentEvent` union includes `{type:'done', fullText}` and `{type:'error', message}` — the loop above matches those.)

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/lib/dream.ts
git commit -m "feat(dreaming): runDream curator runner + nightly startDreaming"
```

---

## Task 4: Boot hook — start the Dreaming ticker

**Files:**
- Modify: `src/instrumentation.ts`

**Interfaces:**
- Consumes: `startDreaming` (Task 3); existing `startScheduler`.

- [ ] **Step 1: Add startDreaming to register()**

Replace the contents of `src/instrumentation.ts` with:

```ts
// Next.js startup hook (runs once per server process). Starts the in-process
// background tickers: the Scheduler and the Dreaming Curator. Guarded to the Node
// runtime (not Edge); each starter is itself idempotent so dev/HMR re-registration
// is safe.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
    const { startDreaming } = await import('@/lib/dream');
    startDreaming();
  }
}
```

- [ ] **Step 2: Build + test**

Run: `pnpm build`
Expected: PASS.

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat(dreaming): start the Dreaming ticker at boot"
```

---

## Task 5: API routes — trigger + star/dismiss

**Files:**
- Create: `src/app/api/dream/route.ts`
- Create: `src/app/api/insights/[id]/route.ts`

**Interfaces:**
- Consumes: `runDream` (Task 3); `dream_insights` table; `SESSION_COOKIE`, `verifySession` (`@/lib/auth`).
- Produces: `POST /api/dream`, `PATCH /api/insights/[id]`.

- [ ] **Step 1: Create the trigger route**

Create `src/app/api/dream/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { runDream } from '@/lib/dream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function authed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && !!(await verifySession(token));
}

export async function POST() {
  if (!(await authed())) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const result = await runDream();
  if (result.status === 'error' && result.reason === 'already dreaming') {
    return Response.json(result, { status: 409 });
  }
  return Response.json(result);
}
```

- [ ] **Step 2: Create the insight route**

Create `src/app/api/insights/[id]/route.ts`:

```ts
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { dream_insights } from '@/db/schema';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z.object({ status: z.enum(['new', 'starred', 'dismissed']) });

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
  await db.update(dream_insights).set({ status: parsed.data.status }).where(eq(dream_insights.id, id));
  return Response.json({ ok: true });
}
```

- [ ] **Step 3: Build + test**

Run: `pnpm build`
Expected: PASS — routes `/api/dream` and `/api/insights/[id]` listed, no unused-import errors.

Run: `pnpm test`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/dream/route.ts" "src/app/api/insights/[id]/route.ts"
git commit -m "feat(dreaming): dream trigger + insight star/dismiss routes"
```

---

## Task 6: Dreaming view + wiring

**Files:**
- Create: `src/lib/dreams-data.ts`, `src/components/dreaming-view.tsx`
- Modify: `src/lib/nav-sections.ts`, `src/lib/nav-sections.test.ts`, `src/app/page.tsx`, `src/components/mission-control.tsx`

**Interfaces:**
- Consumes: `dreams`, `dream_insights` tables; the API routes (Task 5).
- Produces: `getDreams()`, `DreamView`/`InsightView`; `DreamingView` default export; `initialDreams` prop on `MissionControl`.

- [ ] **Step 1: Create the fetch helper**

Create `src/lib/dreams-data.ts`:

```ts
import 'server-only';
import { desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { dreams, dream_insights } from '@/db/schema';

export interface InsightView {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
}
export interface DreamView {
  id: string;
  createdAt: string;
  coversSince: string;
  status: string;
  insights: InsightView[];
}

const MAX_DREAMS = 30;

export async function getDreams(): Promise<DreamView[]> {
  const dreamRows = await db.select().from(dreams).orderBy(desc(dreams.created_at)).limit(MAX_DREAMS);
  if (dreamRows.length === 0) return [];
  const ids = dreamRows.map((d) => d.id);
  const insightRows = await db.select().from(dream_insights).where(inArray(dream_insights.dream_id, ids));
  const byDream = new Map<string, InsightView[]>();
  for (const i of insightRows) {
    if (!byDream.has(i.dream_id)) byDream.set(i.dream_id, []);
    byDream.get(i.dream_id)!.push({ id: i.id, category: i.category, title: i.title, detail: i.detail, status: i.status });
  }
  return dreamRows.map((d) => ({
    id: d.id,
    createdAt: d.created_at.toISOString(),
    coversSince: d.covers_since.toISOString(),
    status: d.status,
    insights: byDream.get(d.id) ?? [],
  }));
}
```

- [ ] **Step 2: Create the view component**

Create `src/components/dreaming-view.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DreamView } from "@/lib/dreams-data";

const CAT: Record<string, { icon: string; color: string }> = {
  risk: { icon: "⚡", color: "#f87171" },
  pattern: { icon: "◈", color: "#60a5fa" },
  suggestion: { icon: "✨", color: "#22d3ee" },
  praise: { icon: "✓", color: "#34d399" },
};

interface Props {
  dreams: DreamView[];
}

export default function DreamingView({ dreams }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function dreamNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dream", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { status?: string; reason?: string };
      if (!res.ok) throw new Error(body.reason ?? "Dream failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Dream failed");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: "new" | "starred" | "dismissed") {
    await fetch(`/api/insights/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    router.refresh();
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="flex-1 overflow-y-auto p-6 bg-[#060810] text-[#e2e8f0]">
      <div className="flex items-center mb-5">
        <div>
          <h1 className="text-lg font-semibold">Dreaming</h1>
          <p className="text-xs text-[#7c8794]">
            The Curator reviews recent work and surfaces patterns, risks, and ideas. Nightly — or on demand.
          </p>
        </div>
        <button
          onClick={dreamNow}
          disabled={busy}
          className="ml-auto flex items-center gap-2 bg-gradient-to-r from-violet-400 to-indigo-500 text-[#0a0716] font-semibold rounded-lg px-4 py-2 text-[13px] disabled:opacity-50"
        >
          🌙 {busy ? "Dreaming…" : "Dream now"}
        </button>
      </div>
      {error && <div className="text-[11px] text-red-400 mb-3">{error}</div>}

      {dreams.length === 0 ? (
        <div className="text-sm text-[#7c8794] border border-[#232c3a] rounded-lg p-6 text-center">
          No dreams yet — click Dream now to reflect on recent work.
        </div>
      ) : (
        dreams.map((d) => (
          <div key={d.id} className="mb-6">
            <div className="flex items-center gap-2.5 mb-2.5">
              <span className="text-[13px] font-semibold text-[#c4b5fd]">Dream · {fmt(d.createdAt)}</span>
              <span className="text-[11px] text-[#5b6675]">covers since {fmt(d.coversSince)}</span>
              <span className="text-[11px] text-[#7c8794] ml-auto">
                {d.status === "error" ? "error" : `${d.insights.length} insight${d.insights.length === 1 ? "" : "s"}`}
              </span>
            </div>
            {d.insights.length === 0 ? (
              <div className="text-[12px] text-[#5b6675] italic pl-1">Nothing notable this window.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {d.insights.map((ins) => {
                  const c = CAT[ins.category] ?? { icon: "•", color: "#7c8794" };
                  const dismissed = ins.status === "dismissed";
                  return (
                    <div
                      key={ins.id}
                      className={`flex gap-3 bg-[#131a24] border border-[#232c3a] rounded-lg p-3 ${dismissed ? "opacity-50" : ""}`}
                      style={{ borderLeft: `3px solid ${c.color}` }}
                    >
                      <div className="text-[15px] leading-tight">{c.icon}</div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="text-[10px] uppercase tracking-wide font-semibold"
                            style={{ color: c.color }}
                          >
                            {ins.category}
                          </span>
                          <span className={`font-semibold text-[13.5px] ${dismissed ? "line-through" : ""}`}>
                            {ins.title}
                          </span>
                        </div>
                        <div className="text-[12.5px] text-[#aab4c0] mt-1">{ins.detail}</div>
                      </div>
                      <div className="flex flex-col gap-1.5 items-center text-[#5b6675]">
                        {dismissed ? (
                          <button onClick={() => setStatus(ins.id, "new")} title="restore">⟲</button>
                        ) : (
                          <>
                            <button
                              onClick={() => setStatus(ins.id, ins.status === "starred" ? "new" : "starred")}
                              title="star"
                              style={ins.status === "starred" ? { color: "#fbbf24" } : undefined}
                            >
                              {ins.status === "starred" ? "★" : "☆"}
                            </button>
                            <button onClick={() => setStatus(ins.id, "dismissed")} title="dismiss">✕</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 3: Flip the nav section + update its test**

In `src/lib/nav-sections.ts`, change the `dreaming` entry's status to `live`:
```ts
  { id: "dreaming", label: "Dreaming", icon: "Moon", group: "system", status: "live" },
```

In `src/lib/nav-sections.test.ts`, add `'dreaming'` to the expected live list. The list is currently:
```ts
  assert.deepEqual(live, ['agent-team', 'live-feed', 'task-board', 'proposals', 'skills', 'memory', 'scheduler']);
```
`dreaming` precedes `scheduler` in `NAV_SECTIONS`, so the filtered live order places it before `scheduler`:
```ts
  assert.deepEqual(live, ['agent-team', 'live-feed', 'task-board', 'proposals', 'skills', 'memory', 'dreaming', 'scheduler']);
```

- [ ] **Step 4: Wire the page data**

In `src/app/page.tsx`:

Add the import next to `import { getSchedules } from "@/lib/schedules-data";`:
```ts
import { getDreams } from "@/lib/dreams-data";
```

Add the fetch next to `const initialSchedules = await getSchedules();`:
```ts
  const initialDreams = await getDreams();
```

Pass the prop in the `<MissionControl ... />` JSX, next to `initialSchedules={initialSchedules}`:
```tsx
        initialDreams={initialDreams}
```

- [ ] **Step 5: Wire the view into MissionControl**

In `src/components/mission-control.tsx`:

Add imports next to `import SchedulerView from "@/components/scheduler-view";`:
```ts
import DreamingView from "@/components/dreaming-view";
import type { DreamView } from "@/lib/dreams-data";
```

Add to the props interface next to `initialSchedules: ScheduleRow[];`:
```ts
  initialDreams: DreamView[];
```

Add to the destructured props next to `initialSchedules,`:
```ts
  initialDreams,
```

Add a branch to the view-switch ternary, right after the `activeSection === "scheduler" ? ( <SchedulerView ... /> )` branch:
```tsx
        ) : activeSection === "dreaming" ? (
          <DreamingView dreams={initialDreams} />
```

- [ ] **Step 6: Build + test**

Run: `pnpm build`
Expected: PASS, no unused-import / missing-prop errors.

Run: `pnpm test`
Expected: PASS — including the updated `nav-sections` test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/dreams-data.ts src/components/dreaming-view.tsx src/lib/nav-sections.ts src/lib/nav-sections.test.ts src/app/page.tsx src/components/mission-control.tsx
git commit -m "feat(dreaming): Dreaming view + getDreams + nav/page/mission-control wiring"
```

---

## Task 7: Runtime verification

**Files:** none (runtime).

- [ ] **Step 1: Pure logic is proven by unit tests**

Run: `pnpm test`
Expected: PASS — `parseInsights` + `isDreamDue` cover the parse/due cases.

- [ ] **Step 2: End-to-end — a dream produces insights**

Ensure the DB has some recent conversations to reflect on (the dev DB does; or run `pnpm seed` then send a message or two in the app). Trigger a dream headlessly (real Curator turn — Pro login if no `ANTHROPIC_API_KEY`):
```bash
NODE_OPTIONS=--conditions=react-server node_modules/.bin/tsx -e "import('@/lib/dream').then(m=>m.runDream()).then(r=>{console.log(r);process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: prints `{ status: 'ok', dreamId: 'dream_...' }` (or `'empty'` if there was nothing notable). Then confirm persistence:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'./data/mission-control.db');const d=db.prepare('SELECT id,status,insight_count FROM dreams ORDER BY created_at DESC LIMIT 1').get();console.log('dream:',d);console.log('insights:',db.prepare('SELECT category,substr(title,1,50) t,status FROM dream_insights WHERE dream_id=?').all(d.id));db.close();"
```
Expected: a `dreams` row (`ok`/`empty`) and, for `ok`, one `dream_insights` row per insight with `status='new'`.

- [ ] **Step 3: UI — Dream now + star/dismiss**

Start the app: `pnpm dev`, log in, open the **Dreaming** section. Confirm prior dreams render grouped with category-badged cards. Click **Dream now** → a new dream group appears after the spinner. Star an insight (☆→★) and dismiss another (greys out, restore ⟲ shows) — each persists across a reload.

- [ ] **Step 4: Concurrency guard**

While one dream is running (or by calling the headless trigger twice in quick succession), confirm the second returns `{ status: 'error', reason: 'already dreaming' }` (the `POST /api/dream` route maps it to HTTP 409).

---

## Task 8: Docs / progress

**Files:**
- Modify: `README.md` (project layout) — optional

- [ ] **Step 1: Note Dreaming in the layout**

In `README.md`'s `## Project layout` block, under `lib/` add:
```
    dream.ts                              # Curator: gather conversations → runClaudeAgent → insights (+ nightly ticker)
    dream-insights.ts                     # pure parser: Curator output → structured insights (unit-tested)
    dream-due.ts                          # pure nightly due-gate (unit-tested)
    dreams-data.ts                        # getDreams server fetch for the Dreaming view
```
and under `components/` add `dreaming-view.tsx                      # Dreaming feed: dreams + insight cards (star/dismiss)`. Keep it terse; skip if it drifts from the actual block.

- [ ] **Step 2: Commit (if README changed)**

```bash
git add README.md
git commit -m "docs(dreaming): note Dreaming/Curator in project layout"
```

---

## Self-Review notes

- **Spec coverage:** `dreams` + `dream_insights` tables (Task 2) ✓; pure `parseInsights` + `isDreamDue` (Task 1) ✓; lighter `runDream` via `runClaudeAgent`, no worktree, single-in-flight, conversations-since-last-dream capped, empty/error handling (Task 3) ✓; Curator as code constant — `CURATOR_SYSTEM_PROMPT`/`CURATOR_MODEL` in `dream.ts`, no roster agent (Task 3) ✓; nightly via `startDreaming` in the boot ticker (Tasks 3/4) ✓; manual `POST /api/dream` (409 when dreaming) + `PATCH /api/insights/[id]` (Task 5) ✓; Dreaming view with grouped dreams, category badges, star/dismiss, "Dream now", nav flip to live (Task 6) ✓; unit tests on pure modules + runtime verification for the rest (Tasks 1/7) ✓.
- **Type consistency:** `Insight`/`InsightCategory` (Task 1) → consumed by `runDream` (Task 3); `RunDreamResult` (Task 3) → returned by `POST /api/dream` (Task 5); `DreamView`/`InsightView` (Task 6 `dreams-data.ts`) → consumed by `DreamingView` (Task 6) and `initialDreams` on `MissionControl`; categories `pattern|risk|suggestion|praise` and statuses `new|starred|dismissed` / `ok|empty|error` are used identically across schema (Task 2), parser (Task 1), runner (Task 3), and view (Task 6).
- **Placeholders:** none — every code step shows the full file/snippet and exact anchor; numeric bounds (`MAX_MESSAGES`, `MAX_CONTEXT_CHARS`, `NIGHTLY_HOUR`, `DREAM_TICK_MS`, `DEFAULT_LOOKBACK_MS`) are concrete.
```
