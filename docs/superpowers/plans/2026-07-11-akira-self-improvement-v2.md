# AKIRA Self-Improvement v2 (Nightly Reflection) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A nightly Opus reflector that auto-distills AKIRA's lessons (git-tracked) and proposes SOUL edits the operator approves in the PIN-locked Settings panel.

**Architecture:** A `dream.ts`-style nightly pass (`reflect.ts`) reads AKIRA's recent conversation + current lessons + SOUL, calls an Opus Reflector for structured JSON, applies the consolidated lesson set, writes a single pending `SOUL.proposed.md`, and records a `reflections` row. A snapshot flag makes AKIRA mention a pending proposal. Pure logic (parser, planner, proposal helpers) is TDD'd; the job/routes/UI are manual, matching the Dreaming convention.

**Tech Stack:** TypeScript, Claude Agent SDK (`runClaudeAgent`), Drizzle/SQLite, `node:test` via `tsx --test`, the existing memory vault + PIN-gated Settings.

## Global Constraints

- **Asymmetry:** lessons are **auto-applied** (AKIRA's own, git-tracked); SOUL is **proposed → operator approves** in PIN-locked Settings. SOUL is never auto-edited.
- **Safety floor:** a bad/empty reflector parse must never wipe all lessons (empty distilled + non-empty current = no-op).
- **Portability:** reflector is server infrastructure; lessons/SOUL/proposal are vault Markdown + pure functions ([[akira-sovereignty-self-host-target]]).
- `node:`-only in unit-tested modules. Extensionless relative imports. `git` via the existing `gitCommitPush` (async, best-effort).
- Additive `reflections` table only (a plain `CREATE TABLE`, NOT a table rebuild → safe under `pnpm db:migrate`; not the [[drizzle-table-rebuild-migration-gotcha]] case).
- No agent reseed needed for this slice (it does not change `AKIRA_SYSTEM_PROMPT`; `renderSnapshot` is built per-turn).

---

### Task 1: `reflections` table + migration

**Files:**
- Modify: `src/db/schema.ts` (append the table)
- Generate: a new `drizzle/NNNN_*.sql`

**Interfaces:**
- Produces: the `reflections` Drizzle table (consumed by Task 5).

- [ ] **Step 1: Append the table to the schema**

In `src/db/schema.ts`:

```ts
export const reflections = sqliteTable('reflections', {
  id: text('id').primaryKey(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(),               // 'ok' | 'empty' | 'error'
  lessons_before: integer('lessons_before').notNull().default(0),
  lessons_after: integer('lessons_after').notNull().default(0),
  soul_proposed: integer('soul_proposed').notNull().default(0), // 0/1
  error: text('error'),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate` (drizzle-kit) — it emits a new `drizzle/NNNN_*.sql`.
Open it and CONFIRM it is a single additive `CREATE TABLE reflections (...)` with NO `DROP`/`__new_`/`RENAME` (a rebuild would trip the FK-in-transaction gotcha). If drizzle bundled unrelated changes, keep only the `reflections` CREATE.

- [ ] **Step 3: Apply locally + type-check**

Run: `pnpm db:migrate && npx tsc --noEmit`
Expected: migrate succeeds; tsc EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): reflections table (nightly reflection runs)"
```

---

### Task 2: Reflector output parser (pure)

**Files:**
- Create: `src/lib/akira/reflect-parse.ts`
- Test: `src/lib/akira/reflect-parse.test.ts`

**Interfaces:**
- Produces: `interface DistilledLesson { title: string; description: string; body: string }`;
  `interface ReflectionOutput { lessons: DistilledLesson[]; soulProposal: { text: string; reason: string } | null }`;
  `parseReflection(raw: string): ReflectionOutput`.
- Consumes (Task 5): `parseReflection`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/akira/reflect-parse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReflection } from './reflect-parse';

test('parses a clean object', () => {
  const out = parseReflection(JSON.stringify({
    lessons: [{ title: 'Terse briefs', description: 'prefers terse', body: 'Keep briefs to 2 sentences.' }],
    soulProposal: { text: 'I am AKIRA, warmer and terser.', reason: 'he values brevity' },
  }));
  assert.equal(out.lessons.length, 1);
  assert.equal(out.lessons[0].title, 'Terse briefs');
  assert.equal(out.soulProposal?.reason, 'he values brevity');
});

test('parses inside a ```json fence', () => {
  const out = parseReflection('```json\n{ "lessons": [], "soulProposal": null }\n```');
  assert.deepEqual(out, { lessons: [], soulProposal: null });
});

test('missing/absent soulProposal → null', () => {
  assert.equal(parseReflection('{ "lessons": [] }').soulProposal, null);
  assert.equal(parseReflection('{ "lessons": [], "soulProposal": {} }').soulProposal, null); // no text
});

test('drops malformed lesson entries', () => {
  const out = parseReflection(JSON.stringify({ lessons: [{ title: 'ok', description: 'd', body: 'b' }, { title: 'x' }] }));
  assert.equal(out.lessons.length, 1);
});

test('garbage → safe empty default', () => {
  assert.deepEqual(parseReflection('not json at all'), { lessons: [], soulProposal: null });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/lib/akira/reflect-parse.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/akira/reflect-parse.ts
// Parse the Reflector's JSON output tolerantly (optional ```json fence, partial/garbled
// content). Pure — unit-tested. A parse failure yields a safe empty result so the caller
// never mutates the vault on bad output.
export interface DistilledLesson { title: string; description: string; body: string }
export interface ReflectionOutput {
  lessons: DistilledLesson[];
  soulProposal: { text: string; reason: string } | null;
}

export function parseReflection(raw: string): ReflectionOutput {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : raw).trim();
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    const rawLessons = Array.isArray(o.lessons) ? o.lessons : [];
    const lessons: DistilledLesson[] = rawLessons
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .filter((l) => typeof l.title === 'string' && typeof l.description === 'string' && typeof l.body === 'string')
      .map((l) => ({ title: l.title as string, description: l.description as string, body: l.body as string }));
    const sp = o.soulProposal as Record<string, unknown> | null | undefined;
    const soulProposal =
      sp && typeof sp.text === 'string' && sp.text.trim()
        ? { text: sp.text, reason: typeof sp.reason === 'string' ? sp.reason : '' }
        : null;
    return { lessons, soulProposal };
  } catch {
    return { lessons: [], soulProposal: null };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/lib/akira/reflect-parse.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/reflect-parse.ts src/lib/akira/reflect-parse.test.ts
git commit -m "feat(akira): tolerant Reflector output parser"
```

---

### Task 3: Lesson-replace planner (pure, with safety floor)

**Files:**
- Create: `src/lib/akira/reflect-plan.ts`
- Test: `src/lib/akira/reflect-plan.test.ts`

**Interfaces:**
- Produces: `interface LessonNote { slug: string; title: string; description: string; body: string }`;
  `interface LessonOps { deletes: string[]; writes: DistilledLesson[] }`;
  `planLessonReplace(current: LessonNote[], distilled: DistilledLesson[]): LessonOps | null`.
- Consumes (Task 5): `planLessonReplace`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/akira/reflect-plan.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planLessonReplace, type LessonNote } from './reflect-plan';

const note = (slug: string, body: string): LessonNote => ({ slug, title: slug, description: slug, body });

test('identical sets → null (no-op, no git churn)', () => {
  const cur = [note('terse-briefs', 'keep briefs short')];
  const dist = [{ title: 'terse-briefs', description: 'terse-briefs', body: 'keep briefs short' }];
  assert.equal(planLessonReplace(cur, dist), null);
});

test('a merged/dropped lesson produces a delete', () => {
  const cur = [note('a', 'x'), note('b', 'y')];
  const dist = [{ title: 'a', description: 'a', body: 'x' }]; // b dropped
  const ops = planLessonReplace(cur, dist)!;
  assert.deepEqual(ops.deletes, ['b']);
  assert.equal(ops.writes.length, 0);
});

test('a new/changed lesson produces a write', () => {
  const cur = [note('a', 'old')];
  const dist = [{ title: 'a', description: 'a', body: 'new' }, { title: 'c', description: 'c', body: 'z' }];
  const ops = planLessonReplace(cur, dist)!;
  assert.equal(ops.deletes.length, 0);
  assert.deepEqual(ops.writes.map((w) => w.title).sort(), ['a', 'c']);
});

test('SAFETY FLOOR: empty distilled + non-empty current → null (never wipe all)', () => {
  assert.equal(planLessonReplace([note('a', 'x')], []), null);
});

test('empty current + new distilled → all writes', () => {
  const ops = planLessonReplace([], [{ title: 'a', description: 'a', body: 'x' }])!;
  assert.equal(ops.writes.length, 1);
  assert.equal(ops.deletes.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/lib/akira/reflect-plan.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/lib/akira/reflect-plan.ts
// Pure planner: turn a distilled lesson set into the note ops needed to make the vault
// match it. Matches by slug (safeSlug of the title). Safety floor: an empty distilled set
// against a non-empty current set is treated as a no-op — a bad parse can never wipe all
// lessons.
import { safeSlug } from './memory/note';
import type { DistilledLesson } from './reflect-parse';

export interface LessonNote { slug: string; title: string; description: string; body: string }
export interface LessonOps { deletes: string[]; writes: DistilledLesson[] }

export function planLessonReplace(current: LessonNote[], distilled: DistilledLesson[]): LessonOps | null {
  if (distilled.length === 0 && current.length > 0) return null; // safety floor

  const distilledSlugs = new Set(distilled.map((d) => safeSlug(d.title) ?? ''));
  const currentBySlug = new Map(current.map((c) => [c.slug, c]));

  const deletes = current.filter((c) => !distilledSlugs.has(c.slug)).map((c) => c.slug);
  const writes = distilled.filter((d) => {
    const c = currentBySlug.get(safeSlug(d.title) ?? '');
    return !c || c.title !== d.title || c.description !== d.description || c.body.trim() !== d.body.trim();
  });

  if (deletes.length === 0 && writes.length === 0) return null; // already equivalent
  return { deletes, writes };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/lib/akira/reflect-plan.test.ts`
Expected: PASS (5).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/reflect-plan.ts src/lib/akira/reflect-plan.test.ts
git commit -m "feat(akira): lesson-replace planner with empty-distilled safety floor"
```

---

### Task 4: SOUL proposal storage + exclude from note scan

**Files:**
- Modify: `src/lib/akira/memory/soul.ts` (proposal helpers)
- Modify: `src/lib/akira/memory/store.ts` (exclude SOUL.md + SOUL.proposed.md from `listNotes`)
- Test: `src/lib/akira/memory/soul.test.ts` (add proposal cases)

**Interfaces:**
- Produces: `SOUL_PROPOSAL_FILE`; `writeSoulProposal(text, reason, dir?)`;
  `readSoulProposal(dir?): { text: string; reason: string; created: string } | null`; `clearSoulProposal(dir?)`.
- Consumes (Tasks 5/7/8): the proposal helpers.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/akira/memory/soul.test.ts`:

```ts
import { writeSoulProposal, readSoulProposal, clearSoulProposal } from './soul';

test('writeSoulProposal then readSoulProposal round-trips text + reason', () => {
  const d = tmp();
  writeSoulProposal('I am AKIRA, terser.', 'he values brevity', d);
  const p = readSoulProposal(d);
  assert.equal(p?.text, 'I am AKIRA, terser.');
  assert.equal(p?.reason, 'he values brevity');
});

test('readSoulProposal is null when none exists', () => {
  assert.equal(readSoulProposal(tmp()), null);
});

test('a fresh proposal overwrites the prior (freshest wins)', () => {
  const d = tmp();
  writeSoulProposal('first', 'r1', d);
  writeSoulProposal('second', 'r2', d);
  assert.equal(readSoulProposal(d)?.text, 'second');
});

test('clearSoulProposal removes it', () => {
  const d = tmp();
  writeSoulProposal('x', 'y', d);
  clearSoulProposal(d);
  assert.equal(readSoulProposal(d), null);
});
```

> `tmp()` is `soul.test.ts`'s existing temp-dir helper.

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/lib/akira/memory/soul.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the proposal helpers in `soul.ts`**

Add to `src/lib/akira/memory/soul.ts`:

```ts
export const SOUL_PROPOSAL_FILE = 'SOUL.proposed.md';

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export function writeSoulProposal(text: string, reason: string, dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const doc = ['---', `reason: ${oneLine(reason)}`, `created: ${new Date().toISOString()}`, '---', text].join('\n');
  const p = join(dir, SOUL_PROPOSAL_FILE);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, doc);
  renameSync(tmp, p);
}

export function readSoulProposal(dir: string = vaultDir()): { text: string; reason: string; created: string } | null {
  try {
    const md = readFileSync(join(dir, SOUL_PROPOSAL_FILE), 'utf8');
    const lines = md.split('\n');
    if (lines[0] !== '---') return null;
    const close = lines.indexOf('---', 1);
    if (close < 0) return null;
    const fm: Record<string, string> = {};
    for (const l of lines.slice(1, close)) {
      const i = l.indexOf(':');
      if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    const text = lines.slice(close + 1).join('\n');
    return text.trim() ? { text, reason: fm.reason ?? '', created: fm.created ?? '' } : null;
  } catch {
    return null;
  }
}

export function clearSoulProposal(dir: string = vaultDir()): void {
  try { rmSync(join(dir, SOUL_PROPOSAL_FILE)); } catch { /* already gone */ }
}
```

Add `readFileSync`, `renameSync`, `rmSync`, `mkdirSync` to the existing `node:fs` import in `soul.ts` as needed (some are already imported).

- [ ] **Step 4: Exclude SOUL files from the note scan**

In `src/lib/akira/memory/store.ts`, `listNotes` currently skips only `INDEX.md`. `SOUL.proposed.md` has frontmatter and WOULD be mis-parsed as a memory note. Exclude both SOUL files:

```ts
    if (!f.endsWith('.md') || f === 'INDEX.md' || f === 'SOUL.md' || f === 'SOUL.proposed.md') continue;
```

- [ ] **Step 5: Run to verify it passes + type-check**

Run: `npx tsx --test src/lib/akira/memory/soul.test.ts && npx tsc --noEmit`
Expected: PASS; tsc EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/memory/soul.ts src/lib/akira/memory/soul.test.ts src/lib/akira/memory/store.ts
git commit -m "feat(akira): SOUL proposal storage (write/read/clear) + exclude SOUL files from note scan"
```

---

### Task 5: The reflection pass (`reflect.ts`)

**Files:**
- Create: `src/lib/akira/reflect.ts`

**Interfaces:**
- Consumes: `parseReflection` (T2), `planLessonReplace` (T3), soul proposal helpers (T4), `readSoul`/`lessonsText`/`listNotes`/`writeNote`/`deleteNote`/`gitCommitPush` (store), `isDreamDue` (reuse as the nightly gate), `runClaudeAgent`, the `reflections` table.
- Produces: `runReflection()`, `startReflecting()`.

> Server pass; verified manually (mirrors `dream.ts`, which is not unit-tested).

- [ ] **Step 1: Write `reflect.ts`**

```ts
// src/lib/akira/reflect.ts
import 'server-only';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { reflections, messages } from '@/db/schema';
import { runClaudeAgent } from '@/lib/agent-runner-sdk';
import { isDreamDue } from '@/lib/dream-due';
import { AKIRA_SESSION_ID } from './agent';
import { readSoul } from './memory/soul';
import { writeSoulProposal } from './memory/soul';
import { listNotes, writeNote, deleteNote, gitCommitPush } from './memory/store';
import { parseReflection } from './reflect-parse';
import { planLessonReplace, type LessonNote } from './reflect-plan';

export const REFLECTOR_MODEL = 'claude-opus-4-7';
export const REFLECTION_HOUR = 4; // staggered after Dreaming (hour 3)
const TICK_MS = 15 * 60_000;
const MAX_MESSAGES = 200;
const MAX_CONTEXT_CHARS = 40_000;
const DEFAULT_LOOKBACK_MS = 7 * 24 * 3_600_000;

export const REFLECTOR_SYSTEM_PROMPT = `You are AKIRA's private reflector — a careful reviewer of AKIRA's OWN recent conduct as A'Keem's concierge. You are given her recent conversation, her current LESSONS (durable notes about how to serve him), and her current SOUL (identity/voice/values).

Do two things, grounded strictly in what the transcript shows:
1. Produce a CONSOLIDATED lesson set: merge duplicates, sharpen wording, drop the obsolete or contradicted. Return the FULL set you want to keep (not a diff). Keep only genuinely durable, behavior-shaping lessons. If the current lessons are already clean, return them unchanged.
2. ONLY if the transcript clearly warrants it, propose a small SOUL refinement (the full proposed SOUL text + a one-line reason). Most nights this is null. Never propose churn.

Respond with ONLY a JSON object (optionally in a \`\`\`json fence), no prose:
{ "lessons": [ { "title": "...", "description": "one line", "body": "markdown" } ],
  "soulProposal": { "text": "<full proposed SOUL>", "reason": "<one line>" } | null }`;

export interface RunReflectionResult { status: 'ok' | 'empty' | 'error'; reflectionId?: string; reason?: string }

function currentLessons(): LessonNote[] {
  return listNotes()
    .filter((n) => n.type === 'lesson')
    .map((n) => ({ slug: n.slug, title: n.title, description: n.description, body: n.body }));
}

export async function runReflection(): Promise<RunReflectionResult> {
  const g = globalThis as unknown as { __mcReflectInProgress?: boolean };
  if (g.__mcReflectInProgress) return { status: 'error', reason: 'already reflecting' };
  g.__mcReflectInProgress = true;
  const now = new Date();
  try {
    const last = await db.select({ created_at: reflections.created_at }).from(reflections)
      .orderBy(desc(reflections.created_at)).limit(1).then((r) => r[0]);
    const since = last?.created_at ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);

    const recent = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.session_id, AKIRA_SESSION_ID), gt(messages.created_at, since)))
      .orderBy(asc(messages.created_at))
      .limit(MAX_MESSAGES);
    const convoText = recent
      .map((r) => `${r.role === 'user' ? "A'Keem" : 'AKIRA'}: ${r.content}`)
      .join('\n');

    const lessons = currentLessons();
    if (!convoText.trim() && lessons.length === 0) {
      const id = `refl_${bytesToHex(randomBytes(4))}`;
      await db.insert(reflections).values({ id, created_at: now, status: 'empty', lessons_before: 0, lessons_after: 0, soul_proposed: 0 });
      return { status: 'empty', reflectionId: id };
    }

    const lessonsBlock = lessons.map((l) => `### ${l.title}\n${l.body}`).join('\n\n') || '(none)';
    let context = `# AKIRA's recent conversation\n${convoText || '(none)'}\n\n# Current LESSONS\n${lessonsBlock}\n\n# Current SOUL\n${readSoul()}`;
    if (context.length > MAX_CONTEXT_CHARS) context = context.slice(0, MAX_CONTEXT_CHARS);

    let fullText = '';
    for await (const ev of runClaudeAgent({
      prompt: context,
      workingDir: process.cwd(),
      model: REFLECTOR_MODEL,
      systemPrompt: REFLECTOR_SYSTEM_PROMPT,
      allowedTools: ['Read', 'Glob', 'Grep'],
    })) {
      if (ev.type === 'done') fullText = ev.fullText;
      else if (ev.type === 'error' && ev.fatal) throw new Error(ev.message);
    }

    const out = parseReflection(fullText);

    // Lessons: auto-apply the consolidated set (safety floor lives in the planner).
    const ops = planLessonReplace(lessons, out.lessons);
    if (ops) {
      for (const slug of ops.deletes) deleteNote(slug);
      for (const w of ops.writes) writeNote({ title: w.title, description: w.description, type: 'lesson', body: w.body });
      gitCommitPush(`reflect: distilled ${lessons.length}→${out.lessons.length} lessons`);
    }

    // SOUL: propose only (operator approves in Settings).
    if (out.soulProposal) {
      writeSoulProposal(out.soulProposal.text, out.soulProposal.reason);
      gitCommitPush('reflect: proposed a soul edit');
    }

    const id = `refl_${bytesToHex(randomBytes(4))}`;
    await db.insert(reflections).values({
      id, created_at: now, status: 'ok',
      lessons_before: lessons.length, lessons_after: out.lessons.length,
      soul_proposed: out.soulProposal ? 1 : 0,
    });
    return { status: 'ok', reflectionId: id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await db.insert(reflections).values({ id: `refl_${bytesToHex(randomBytes(4))}`, created_at: now, status: 'error', lessons_before: 0, lessons_after: 0, soul_proposed: 0, error: message });
    } catch { /* best-effort */ }
    return { status: 'error', reason: message };
  } finally {
    g.__mcReflectInProgress = false;
  }
}

export function startReflecting(): void {
  const g = globalThis as unknown as { __mcReflectingStarted?: boolean };
  if (g.__mcReflectingStarted) return;
  g.__mcReflectingStarted = true;
  const check = async () => {
    try {
      const last = await db.select({ created_at: reflections.created_at }).from(reflections)
        .orderBy(desc(reflections.created_at)).limit(1).then((r) => r[0]);
      if (isDreamDue(last?.created_at ?? null, new Date(), REFLECTION_HOUR)) await runReflection();
    } catch (err) {
      console.error('[reflect] check failed:', err instanceof Error ? err.message : err);
    }
  };
  void check();
  setInterval(() => void check(), TICK_MS);
  console.log(`[reflect] started (nightly hour ${REFLECTION_HOUR})`);
}
```

> Clean up the small redundancy: the `convo`/`void convo` scaffolding above is illustrative — in the final code, keep ONLY the `recent` query + `convoText`. (Reviewer: delete the `convo` block.)

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/akira/reflect.ts
git commit -m "feat(akira): nightly reflection pass (distill lessons + propose SOUL)"
```

---

### Task 6: Start the reflection ticker

**Files:**
- Modify: `src/instrumentation.ts`

- [ ] **Step 1: Register `startReflecting`**

In `src/instrumentation.ts`, after `startDreaming()`:

```ts
    const { startReflecting } = await import('@/lib/akira/reflect');
    startReflecting();
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit`
```bash
git add src/instrumentation.ts
git commit -m "feat(akira): start the nightly reflection ticker on boot"
```

---

### Task 7: Snapshot flag so AKIRA surfaces a pending proposal

**Files:**
- Modify: `src/lib/fleet-snapshot.ts` (type + emptySnapshot)
- Modify: `src/lib/fleet-contributors.ts` (contributor)
- Modify: `src/lib/akira/prompt.ts` (`renderSnapshot` line)

- [ ] **Step 1: Extend the snapshot type**

In `src/lib/fleet-snapshot.ts`, add to `FleetSnapshot`:
```ts
  soulProposal: { reason: string } | null;
```
and to `emptySnapshot()`:
```ts
    soulProposal: null,
```

- [ ] **Step 2: Add a contributor**

In `src/lib/fleet-contributors.ts` (follow the existing contributor pattern), add one that reads the proposal:
```ts
import { readSoulProposal } from '@/lib/akira/memory/soul';
// …register alongside the others:
{ key: 'soulProposal', collect: async () => {
    const p = readSoulProposal();
    return { soulProposal: p ? { reason: p.reason } : null };
  } },
```

- [ ] **Step 3: Render it in the snapshot**

In `renderSnapshot` (`src/lib/akira/prompt.ts`), before the final `errors` line:
```ts
  if (s.soulProposal) lines.push(`Soul proposal awaiting your review in Settings — reason: ${s.soulProposal.reason}`);
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit`
```bash
git add src/lib/fleet-snapshot.ts src/lib/fleet-contributors.ts src/lib/akira/prompt.ts
git commit -m "feat(akira): surface a pending SOUL proposal in the fleet snapshot"
```

> Note: this touches `renderSnapshot` (per-turn), NOT `AKIRA_SYSTEM_PROMPT` — no reseed needed.

---

### Task 8: Settings review — approve/reject the SOUL proposal

**Files:**
- Modify: `src/app/api/memory/route.ts` (return the proposal on unlock)
- Modify: `src/app/api/memory/soul/route.ts` (add `POST` approve/reject)
- Modify: `src/components/akira/memory-panel.tsx` (proposal UI)

> PIN-gated route + client UI; manual verify.

- [ ] **Step 1: Return the proposal on unlock**

In `src/app/api/memory/route.ts`, import `readSoulProposal` and add it to the success response (alongside `notes`, `soul`):
```ts
import { readSoulProposal } from '@/lib/akira/memory/soul';
// …
  return Response.json({ notes, soul: readSoul(), soulProposal: readSoulProposal() });
```
(Also include `soulProposal: null` in the `!vaultReady()` early return object.)

- [ ] **Step 2: Add approve/reject to the soul route**

In `src/app/api/memory/soul/route.ts`, add a `POST` (the PIN + limiter guard mirrors the existing `PUT`):
```ts
import { writeSoul, DEFAULT_SOUL } from '@/lib/akira/memory/soul';
import { readSoulProposal, clearSoulProposal } from '@/lib/akira/memory/soul';
// …existing imports/PUT stay…

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!pinLimiter.allowed(Date.now())) return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  const { pin, action } = (await req.json().catch(() => ({}))) as { pin?: string; action?: 'approve' | 'reject' };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    pinLimiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  pinLimiter.recordSuccess();
  const proposal = readSoulProposal();
  if (!proposal) return Response.json({ error: 'No pending proposal.' }, { status: 404 });
  if (action === 'approve') {
    writeSoul(proposal.text);
    clearSoulProposal();
    gitCommitPush('soul: approved proposal');
    return Response.json({ ok: true, soul: proposal.text });
  }
  clearSoulProposal();
  gitCommitPush('soul: rejected proposal');
  return Response.json({ ok: true });
}
```
Ensure `verifyPin`, `pinLimiter`, `SESSION_COOKIE`, `verifySession`, `cookies`, `gitCommitPush` are imported (some already are for the `PUT`).

- [ ] **Step 3: Proposal UI in the panel**

In `src/components/akira/memory-panel.tsx`: capture `soulProposal` from the unlock response into state; when present, render a **SOUL PROPOSAL** block above the SOUL editor — the reason, a before/after (`proposal` vs current `soul`), and **Approve** / **Reject** buttons that `POST /api/memory/soul` with `{ pin: pinRef.current, action }`. On success: clear the proposal from state, and on approve set `soul` to the approved text. Reuse the existing `unlockBtn`/`relockBtn` styles + `soulMsg`-style status line.

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit`
```bash
git add "src/app/api/memory/route.ts" "src/app/api/memory/soul/route.ts" src/components/akira/memory-panel.tsx
git commit -m "feat(akira): review + approve/reject SOUL proposals in the PIN-locked Settings panel"
```

---

### Task 9: Full verification + finish

- [ ] **Step 1: Gate**

Run: `npx tsc --noEmit && pnpm test`
Expected: tsc clean; all tests pass (new: `reflect-parse`, `reflect-plan`, soul proposal cases).

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: EXIT 0.

- [ ] **Step 3: Manual E2E (documented)**

1. Trigger a reflection (temporarily lower `REFLECTION_HOUR` or call `runReflection()` via a scratch script) with a couple of duplicate lessons present → confirm the lesson set consolidates and a `reflect: distilled …` commit lands in the vault; a bad/empty parse leaves lessons intact (safety floor).
2. Have the reflector propose a SOUL edit → `SOUL.proposed.md` appears; AKIRA's next brief mentions a pending proposal.
3. In Settings, unlock → see the proposal (reason + before/after) → **Approve** writes SOUL + clears the proposal + the snapshot flag clears; **Reject** just clears it.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch → merge into `dev`. On Windows unlink the worktree's junctioned `node_modules` before removing it.

---

## Rollout notes

- One **additive migration** (`reflections` table) — runs under `pnpm db:migrate` on deploy (verify it's a plain CREATE, not a rebuild). No new deps. The ticker needs a server restart. **No agent reseed** for this slice.

## Self-Review

**Spec coverage:** reflector pass + Opus + nightly hour 4 (T5) ✓; reflections table (T1) ✓; parser (T2) ✓; planner + safety floor (T3) ✓; SOUL proposal storage + note-scan exclusion (T4) ✓; ticker (T6) ✓; snapshot flag (T7) ✓; Settings review/approve/reject (T8) ✓; lessons auto-applied vs SOUL proposed asymmetry ✓.

**Type consistency:** `DistilledLesson`/`ReflectionOutput` (T2) consumed by planner (T3) + reflect (T5); `LessonNote`/`LessonOps` (T3) consumed by T5; soul proposal helpers (T4) consumed by T5/T7/T8; `soulProposal` snapshot field (T7) consistent shape `{ reason }`; `reflections` columns (T1) match the inserts in T5.

**Placeholder scan:** none — every step carries complete, final code (Task 8 Step 3's panel UI is described prose-style per the repo's manual-UI convention, consistent with the v1 SOUL-editor task).
