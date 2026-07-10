# AKIRA SOUL + Self-Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA a PIN-locked, vault-based **SOUL** (identity/voice/values, injected each turn) and a **self-improvement** pillar — she writes `type:'lesson'` memory notes in the moment that inject in full as active guidance.

**Architecture:** SOUL and lessons are plain Markdown in the Obsidian vault (`data/akira-memory/`) plus pure injection functions. Only the `remember` tool wiring is Claude-SDK-specific, so a future self-hosted-DeepSeek AKIRA inherits her soul + lessons 1:1. SOUL leads the per-turn prompt; lessons follow; both sit ahead of the existing snapshot/memory blocks.

**Tech Stack:** TypeScript, `node:test` via `tsx --test`, Next.js 16 route handlers, the existing PIN-gated memory Settings panel, the Claude Agent SDK `remember` tool.

## Global Constraints

- **Portability:** SOUL + lessons are vault Markdown + pure functions. Do NOT wire them into Claude-SDK internals; the only SDK-specific change is the `remember` tool enum.
- **SOUL is PIN-locked** (operator-only) via the existing memory Settings gate (`AKIRA_MEMORY_PIN`, `verifyPin`, `pinLimiter`). AKIRA reads SOUL but never writes it.
- **Lessons are AKIRA's**, `type:'lesson'` notes, written in-the-moment; injected in full (bounded: ≤20 notes AND ≤~4 KB, newest-first) and **excluded from the memory index**.
- **SOUL always exists:** `readSoul` falls back to `DEFAULT_SOUL` when the file is missing/empty.
- `node:`-only (no `server-only`) in unit-tested modules so they run under `tsx --test`. Extensionless relative imports.
- **Rollout gotcha (record for the deploy):** AKIRA's `system_prompt` is DB-sourced (`akira-turn.ts` uses `akira?.system_prompt ?? AKIRA_SYSTEM_PROMPT`), and `ensureAkiraThread` is `onConflictDoNothing`. Editing `AKIRA_SYSTEM_PROMPT` (Task 3) does NOT update an existing agent row — the deploy must **reseed agents** (`pnpm seed`, which `onConflictDoUpdate`s `system_prompt`) or AKIRA keeps the old prompt. No regression if skipped (SOUL is injected with the same persona), just uncleaned duplication.

---

### Task 1: SOUL storage + default (`soul.ts`)

**Files:**
- Create: `src/lib/akira/memory/soul.ts`
- Test: `src/lib/akira/memory/soul.test.ts`

**Interfaces:**
- Produces: `DEFAULT_SOUL: string`; `SOUL_FILE = 'SOUL.md'`; `readSoul(dir?): string`; `writeSoul(text, dir?): void`; `seedSoulIfMissing(dir?): void`.
- Consumes (Tasks 4/5/6): `readSoul`/`writeSoul`/`seedSoulIfMissing`/`DEFAULT_SOUL`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/akira/memory/soul.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSoul, writeSoul, seedSoulIfMissing, DEFAULT_SOUL, SOUL_FILE } from './soul';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'akira-soul-')); }

test('readSoul returns DEFAULT_SOUL when the file is missing', () => {
  assert.equal(readSoul(tmp()), DEFAULT_SOUL);
});

test('readSoul returns DEFAULT_SOUL when the file is empty/whitespace', () => {
  const d = tmp();
  writeFileSync(join(d, SOUL_FILE), '   \n');
  assert.equal(readSoul(d), DEFAULT_SOUL);
});

test('writeSoul then readSoul round-trips', () => {
  const d = tmp();
  writeSoul('I am AKIRA, terse and warm.', d);
  assert.equal(readSoul(d), 'I am AKIRA, terse and warm.');
});

test('seedSoulIfMissing writes DEFAULT_SOUL once and never overwrites an edit', () => {
  const d = tmp();
  seedSoulIfMissing(d);
  assert.equal(readFileSync(join(d, SOUL_FILE), 'utf8'), DEFAULT_SOUL);
  writeSoul('edited soul', d);
  seedSoulIfMissing(d); // must NOT clobber the edit
  assert.equal(readSoul(d), 'edited soul');
});

test('DEFAULT_SOUL is non-empty and first-person', () => {
  assert.ok(DEFAULT_SOUL.length > 40);
  assert.match(DEFAULT_SOUL, /I am AKIRA/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/lib/akira/memory/soul.test.ts`
Expected: FAIL — `Cannot find module './soul'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/akira/memory/soul.ts
// AKIRA's SOUL: her identity/voice/values as an editable vault doc, injected each
// turn. A special vault file (NOT a memory note). Pure node fs so it unit-tests
// against a temp dir. Model-agnostic: this is the portable persona substrate.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './store';

export const SOUL_FILE = 'SOUL.md';

// Seed + fallback. Identity + voice + values ONLY — operational rules live in the
// code prompt. Kept concise; the operator edits the vault copy from here.
export const DEFAULT_SOUL = `# AKIRA — Soul

I am AKIRA, A'Keem's personal concierge for AXOD Mission Control. I speak in the first person and address him directly.

Voice: calm, warm, precise, and a little wry. I lead with the answer and keep it human — never robotic, never a wall of text.

Values:
- I am his front door and his ally: I make the fleet feel effortless and surface the one thing that needs him.
- I am honest and grounded — I never invent status or pad an answer.
- I respect his attention: brief by default, depth only when he asks for it.`;

function soulPath(dir: string): string {
  return join(dir, SOUL_FILE);
}

export function readSoul(dir: string = vaultDir()): string {
  try {
    const text = readFileSync(soulPath(dir), 'utf8');
    return text.trim() ? text : DEFAULT_SOUL;
  } catch {
    return DEFAULT_SOUL;
  }
}

export function writeSoul(text: string, dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${soulPath(dir)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, soulPath(dir)); // atomic replace
}

export function seedSoulIfMissing(dir: string = vaultDir()): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(soulPath(dir))) writeSoul(DEFAULT_SOUL, dir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/lib/akira/memory/soul.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/memory/soul.ts src/lib/akira/memory/soul.test.ts
git commit -m "feat(akira): SOUL storage + DEFAULT_SOUL (readSoul/writeSoul/seed)"
```

---

### Task 2: Lessons — store partition + `remember` type (`store.ts`, `tools.ts`)

**Files:**
- Modify: `src/lib/akira/memory/store.ts` (exclude lessons from the index; add `lessonsText`)
- Modify: `src/lib/akira/memory/store.test.ts` (add cases)
- Modify: `src/lib/akira/tools.ts` (add `'lesson'` to the `remember` type enum + description)

**Interfaces:**
- Produces: `lessonsText(dir?, opts?: { maxNotes?: number; maxChars?: number }): string` — full bodies of `type:'lesson'` notes, newest-first, bounded (defaults 20 / 4096). `indexText`/`writeIndex` exclude `type:'lesson'`.
- Consumes (Task 4): `lessonsText`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/akira/memory/store.test.ts` (reuse its temp-vault helper; if it writes notes via `writeNote`, mirror that):

```ts
test('indexText excludes lesson notes; lessonsText returns them in full', () => {
  const d = tmp(); // existing helper: a temp vault dir
  writeNote({ title: 'Mini is UTC', description: 'clock', type: 'fact', body: 'The Mini runs UTC.' }, d);
  writeNote({ title: 'Terse briefs', description: 'prefers terse', type: 'lesson', body: 'A’Keem wants the morning brief in 2 sentences.' }, d);

  const idx = indexText(d);
  assert.ok(idx.includes('Mini is UTC'));
  assert.ok(!idx.includes('Terse briefs')); // lessons are NOT in the memory index

  const lessons = lessonsText(d);
  assert.ok(lessons.includes('A’Keem wants the morning brief in 2 sentences.')); // full body
  assert.ok(!lessons.includes('The Mini runs UTC.')); // non-lessons excluded
});

test('lessonsText is empty when there are no lessons', () => {
  const d = tmp();
  writeNote({ title: 'x', description: 'y', type: 'fact', body: 'z' }, d);
  assert.equal(lessonsText(d), '');
});

test('lessonsText respects the note-count cap, newest first', () => {
  const d = tmp();
  for (let i = 0; i < 25; i++) {
    writeNote({ title: `lesson ${i}`, description: `d${i}`, type: 'lesson', body: `body ${i}` }, d);
  }
  const out = lessonsText(d, { maxNotes: 5, maxChars: 100_000 });
  assert.equal((out.match(/body \d+/g) ?? []).length, 5);
});

test('lessonsText respects the char budget', () => {
  const d = tmp();
  for (let i = 0; i < 10; i++) {
    writeNote({ title: `L${i}`, description: `d${i}`, type: 'lesson', body: 'x'.repeat(50) }, d);
  }
  const out = lessonsText(d, { maxNotes: 100, maxChars: 120 });
  assert.ok(out.length <= 200); // stops well before all 10 (~500+ chars of bodies)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/lib/akira/memory/store.test.ts`
Expected: FAIL — `lessonsText` not exported / index still contains lessons.

- [ ] **Step 3: Implement the partition + `lessonsText`**

In `src/lib/akira/memory/store.ts`, change `buildIndex(listNotes(dir))` sites to exclude lessons, and add `lessonsText`:

```ts
// Lessons are injected in full as guidance (see lessonsText) — keep them OUT of
// the recall index so they steer rather than double-appear.
function nonLessonNotes(dir: string): Note[] {
  return listNotes(dir).filter((n) => n.type !== 'lesson');
}

export function writeIndex(dir = vaultDir()): void {
  if (!existsSync(dir)) return;
  writeFileSync(join(dir, 'INDEX.md'), buildIndex(nonLessonNotes(dir)) + '\n');
}
export function indexText(dir = vaultDir()): string {
  return buildIndex(nonLessonNotes(dir));
}

/**
 * Full bodies of the newest lesson notes, as an injectable guidance block.
 * Bounded by BOTH a note count and a char budget (whichever hits first) so
 * AKIRA's context stays lean. Empty string when there are no lessons.
 */
export function lessonsText(
  dir = vaultDir(),
  opts: { maxNotes?: number; maxChars?: number } = {},
): string {
  const maxNotes = opts.maxNotes ?? 20;
  const maxChars = opts.maxChars ?? 4096;
  const lessons = listNotes(dir).filter((n) => n.type === 'lesson'); // listNotes is newest-first
  const blocks: string[] = [];
  let chars = 0;
  for (const n of lessons.slice(0, maxNotes)) {
    const block = `### ${n.title}\n${n.body.trim()}`;
    if (chars + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    chars += block.length;
  }
  return blocks.join('\n\n');
}
```

> `listNotes` already sorts newest-first (by `updated`), so `.slice(0, maxNotes)` is newest-first. Keep the existing `import { buildIndex } from './note'`.

- [ ] **Step 4: Add `'lesson'` to the `remember` tool**

In `src/lib/akira/tools.ts`, extend the enum and the description:

```ts
      type: z.enum(['fact', 'preference', 'project', 'decision', 'reference', 'lesson']),
```

Change the `remember` description to teach the lesson use:

```ts
    "Save a durable note to your long-term memory. Use type 'lesson' when you learn something about HOW to serve A'Keem better (a preference in how he wants things done, a recurring correction, a working-style rule) — lessons steer your future behavior. Use fact/preference/decision/reference for things you recall. NEVER store secrets, passwords, or tokens. Updates the note if the slug already exists.",
```

- [ ] **Step 5: Run to verify it passes + type-check**

Run: `npx tsx --test src/lib/akira/memory/store.test.ts && npx tsc --noEmit`
Expected: PASS; tsc EXIT 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/memory/store.ts src/lib/akira/memory/store.test.ts src/lib/akira/tools.ts
git commit -m "feat(akira): lessons as type:'lesson' notes — index partition + lessonsText + remember enum"
```

---

### Task 3: Prompt — move persona to SOUL, add lesson instruction (`prompt.ts`)

**Files:**
- Modify: `src/lib/akira/prompt.ts`
- Modify: `src/lib/akira/prompt.test.ts` (if it asserts the removed voice sentence)

- [ ] **Step 1: Check the prompt test**

Run: `grep -n "calm\|wry\|first person" src/lib/akira/prompt.test.ts || echo "no persona assertion"`
If it asserts the voice sentence, update that assertion in this task's Step 3.

- [ ] **Step 2: Edit the system prompt**

In `src/lib/akira/prompt.ts`, remove the voice/character clause from the opening line (SOUL now carries it) and add a lesson/soul instruction to the Memory paragraph.

Change the opening sentence FROM:
```
You are AKIRA, the operator A'Keem's personal concierge for AXOD Mission Control — his command center for directing AI agents across all of his projects. You are calm, warm, precise, and a little wry; you speak in the first person and address him directly.
```
TO:
```
You are AKIRA, the operator A'Keem's personal concierge for AXOD Mission Control — his command center for directing AI agents across all of his projects. Your character, voice, and values are given each turn in the ## SOUL block — embody them.
```

Append to the end of the Memory paragraph (after "…mention it in one short line."):
```
 Your ## SOUL (who you are) and ## LESSONS (what you've learned about how he wants things done) are provided each turn — let them guide you. When you learn something durable about how to serve him better, save it with the remember tool using type 'lesson'.
```

- [ ] **Step 3: Fix/confirm the prompt test**

If Step 1 found a persona assertion, update it to assert the new SOUL-reference wording instead. Run:
Run: `npx tsx --test src/lib/akira/prompt.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/akira/prompt.ts src/lib/akira/prompt.test.ts
git commit -m "feat(akira): move persona to SOUL; instruct lesson-writing in the prompt"
```

---

### Task 4: Inject SOUL + LESSONS into the turn (`akira-turn.ts` + a pure preamble)

**Files:**
- Create: `src/lib/akira/preamble.ts` (pure, testable)
- Test: `src/lib/akira/preamble.test.ts`
- Modify: `src/lib/akira-turn.ts` (build + prepend the preamble)

**Interfaces:**
- Produces: `soulLessonsPreamble(soul: string, lessons: string): string` — the `## SOUL` + `## LESSONS` block that leads the turn prompt.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/akira/preamble.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soulLessonsPreamble } from './preamble';

test('preamble leads with SOUL then LESSONS', () => {
  const out = soulLessonsPreamble('I am AKIRA.', '### Terse\nKeep it short.');
  assert.ok(out.indexOf('## SOUL') < out.indexOf('## LESSONS'));
  assert.ok(out.includes('I am AKIRA.'));
  assert.ok(out.includes('Keep it short.'));
});

test('empty lessons render a clean placeholder', () => {
  const out = soulLessonsPreamble('I am AKIRA.', '');
  assert.ok(out.includes('## LESSONS'));
  assert.match(out, /none yet/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/lib/akira/preamble.test.ts`
Expected: FAIL — `Cannot find module './preamble'`.

- [ ] **Step 3: Implement the pure preamble**

```ts
// src/lib/akira/preamble.ts
// Pure builder for AKIRA's per-turn identity preamble: SOUL (who she is) then
// LESSONS (what she's learned) — both lead the turn prompt. No I/O so it unit-tests.
export function soulLessonsPreamble(soul: string, lessons: string): string {
  const lessonsBlock = lessons.trim()
    ? `## LESSONS\nWhat you've learned about how A'Keem wants things done — let these steer you:\n${lessons}`
    : `## LESSONS\n(none yet — save one with the remember tool, type 'lesson', when you learn how to serve him better)`;
  return `## SOUL\n${soul.trim()}\n\n${lessonsBlock}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/lib/akira/preamble.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it into `akira-turn.ts`**

Add three imports (note the distinct sources — `readSoul` from `soul`, `lessonsText` from `store`, the builder from `preamble`):
```ts
import { readSoul } from './akira/memory/soul';
import { lessonsText } from './akira/memory/store';
import { soulLessonsPreamble } from './akira/preamble';
```
Then build the preamble next to the existing `memoryBlock`:
```ts
    let preamble = '';
    try {
      preamble = soulLessonsPreamble(readSoul(), lessonsText());
    } catch {
      preamble = soulLessonsPreamble(readSoul(), ''); // lessons unavailable — SOUL still leads
    }
```
Prepend `preamble` to the EXISTING `const prompt =` assignment — do NOT retype the rest. The only change is adding the first line `preamble + '\n\n' +` at the top of the expression; the `buildAkiraPrompt(...) + memoryBlock + \`\n\n## LAPTOP COMPANION\n${…}\`` portion stays byte-for-byte as it is today:
```ts
    const prompt =
      preamble + '\n\n' +
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      memoryBlock +
      `\n\n## LAPTOP COMPANION\n${companionOnline()
        ? 'The laptop companion is CONNECTED — you may use browser_navigate/read/type/click. Work read→act→read. State the task and let the operator approve before starting; never retry a gated (blocked) action — wait for approval.'
        : 'The laptop companion is OFFLINE — browser actions are unavailable; tell the operator their laptop companion isn\'t connected if they ask for browser work.'}`;
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/akira/preamble.ts src/lib/akira/preamble.test.ts src/lib/akira-turn.ts
git commit -m "feat(akira): inject SOUL + LESSONS at the head of each turn"
```

---

### Task 5: Seed SOUL on bootstrap (`bootstrap.ts`)

**Files:**
- Modify: `src/lib/akira/bootstrap.ts`

- [ ] **Step 1: Seed the soul when the vault is ready**

In `src/lib/akira/bootstrap.ts`, import and call `seedSoulIfMissing` inside `ensureAkiraThread` (guarded by `vaultReady`, so it no-ops when memory isn't configured):

```ts
import { vaultReady } from './memory/store';
import { seedSoulIfMissing } from './memory/soul';
```
At the end of `ensureAkiraThread`, after the session upsert:
```ts
  if (vaultReady()) seedSoulIfMissing();
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/akira/bootstrap.ts
git commit -m "feat(akira): seed SOUL.md on bootstrap when the vault is ready"
```

---

### Task 6: SOUL editor API (`/api/memory` + `/api/memory/soul`)

**Files:**
- Modify: `src/app/api/memory/route.ts` (return `soul` on unlock)
- Create: `src/app/api/memory/soul/route.ts` (PIN-gated save/reset)

> Thin PIN-gated routes; verified by manual check (PIN routes aren't unit-tested here).

- [ ] **Step 1: Return SOUL text on unlock**

In `src/app/api/memory/route.ts`, import `readSoul` and include it in the success response. Keep returning ALL notes (lessons included) so the operator can see and prune lessons in the Settings panel — only AKIRA's prompt-facing `indexText` excludes lessons (Task 2):
```ts
import { readSoul } from '@/lib/akira/memory/soul';
```
Change the final block:
```ts
  pinLimiter.recordSuccess();
  if (!vaultReady()) return Response.json({ notes: [], soul: readSoul() });
  const notes = listNotes().map(({ slug, title, description, type, updated }) => ({
    slug, title, description, type, updated,
  }));
  return Response.json({ notes, soul: readSoul() });
```

- [ ] **Step 2: Create the SOUL save route**

```ts
// src/app/api/memory/soul/route.ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin } from '@/lib/akira/memory/pin';
import { pinLimiter } from '@/lib/akira/memory/pin-limiter';
import { writeSoul, readSoul, DEFAULT_SOUL } from '@/lib/akira/memory/soul';
import { gitCommitPush, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!pinLimiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin, soul, reset } = (await req.json().catch(() => ({}))) as
    { pin?: string; soul?: string; reset?: boolean };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    pinLimiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  pinLimiter.recordSuccess();
  if (!vaultReady()) return Response.json({ error: "Memory isn't configured on this server." }, { status: 400 });
  const text = reset ? DEFAULT_SOUL : String(soul ?? '');
  if (!text.trim()) return Response.json({ error: 'Soul cannot be empty.' }, { status: 400 });
  writeSoul(text);
  gitCommitPush('soul: update');
  return Response.json({ ok: true, soul: readSoul() });
}
```

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/memory/route.ts" "src/app/api/memory/soul/route.ts"
git commit -m "feat(api): SOUL read on unlock + PIN-gated PUT /api/memory/soul (save/reset)"
```

---

### Task 7: SOUL editor in the Settings panel (`memory-panel.tsx`)

**Files:**
- Modify: `src/components/akira/memory-panel.tsx`

> Client UI; verified by manual check.

- [ ] **Step 1: Hold SOUL state from unlock**

In `MemoryPanel`, add a `lesson` chip color so lesson notes render in the list, and add state to capture `soul`:
```ts
// extend the existing chipColor map:
const chipColor: Record<string, string> = {
  project: "#37d39b", preference: "#ff5acf", fact: "#7fdcff", decision: "#ffb84d", reference: "#8fb2c9", lesson: "#b98cff",
};
```
```ts
  const [soul, setSoul] = useState("");
  const [soulMsg, setSoulMsg] = useState("");
```
In `unlock()`, after `const { notes } = await r.json();` change to:
```ts
      const data = await r.json();
      pinRef.current = pin; setNotes(data.notes); setSoul(data.soul ?? ""); setOpen(true); setPin(""); armRelock();
```
In `lock()`, also clear it: `setSoul(""); setSoulMsg("");`

- [ ] **Step 2: Add save/reset handlers**

```ts
  async function saveSoul(reset = false) {
    armRelock(); setSoulMsg("");
    try {
      const r = await fetch("/api/memory/soul", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reset ? { pin: pinRef.current, reset: true } : { pin: pinRef.current, soul }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) { setSoul(data.soul ?? soul); setSoulMsg(reset ? "Reset to default." : "Saved."); }
      else setSoulMsg(r.status === 429 ? "Locked out — try again in a minute." : (data.error ?? "Couldn't save."));
    } catch { setSoulMsg("Couldn't reach the server."); }
  }
```

- [ ] **Step 3: Render the SOUL editor above the memory table**

Inside the `{unlocked && open && (...)}` block, before the `◉ MEMORY` `memTop` row, add a SOUL section:
```tsx
          <div style={memTop}>
            <span style={{ ...meta, color: "#ff5acf", letterSpacing: 1.5 }}>◉ SOUL</span>
            <span style={{ marginLeft: "auto", ...meta, color: "#8fb2c9" }}>{soulMsg}</span>
          </div>
          <textarea
            value={soul}
            onChange={(e) => { setSoul(e.target.value); armRelock(); }}
            spellCheck={false}
            style={{ width: "100%", minHeight: 120, resize: "vertical", borderRadius: 8, border: "1px solid #1c2c3d",
              background: "#0a1626", color: "#e6edf3", padding: 10, fontFamily: "ui-monospace, monospace", fontSize: 12, outline: "none" }}
          />
          <div style={{ display: "flex", gap: 8, margin: "8px 0 14px" }}>
            <button onClick={() => saveSoul(false)} style={unlockBtn}>Save soul</button>
            <button onClick={() => saveSoul(true)} style={relockBtn}>Reset to default</button>
          </div>
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: EXIT 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/akira/memory-panel.tsx
git commit -m "feat(hud): SOUL editor in the PIN-locked Settings panel"
```

---

### Task 8: Full verification + branch finish

- [ ] **Step 1: Root gate**

Run: `npx tsc --noEmit && pnpm test`
Expected: tsc clean; all tests pass (new: `soul`, `preamble`, store partition cases).

- [ ] **Step 2: Build gate (main checkout only — not a junctioned worktree)**

Run: `pnpm build`
Expected: EXIT 0.

- [ ] **Step 3: Manual smoke (documented for the operator)**

1. With the vault configured, confirm `data/akira-memory/SOUL.md` is seeded on next AKIRA turn/boot.
2. Front door → Settings → unlock with the PIN → the SOUL editor shows her seeded soul; edit + Save; reload and confirm it persisted; Reset to default restores it.
3. In an AKIRA conversation, confirm she still sounds like herself (SOUL is injected). Ask her to note a preference; confirm she calls `remember` with `type:'lesson'` and that the lesson shows up as a note (and steers her next reply), while NOT appearing in the `## MEMORY` recall index.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch → merge the feature branch into `dev` (never straight to `main`). On Windows, unlink the worktree's junctioned `node_modules` before removing the worktree.

---

## Rollout notes (for Phase 4/5, not this branch)

- **Reseed agents on deploy.** Task 3 edits `AKIRA_SYSTEM_PROMPT`, but AKIRA's row is DB-sourced and `ensureAkiraThread` is `onConflictDoNothing`. Run `pnpm seed` on the Mini after deploy (it `onConflictDoUpdate`s `system_prompt`) so her live prompt drops the old persona sentence. No regression if missed (SOUL injects the same persona) — it's a cleanup.
- No new deps, no DB migration.
- `AKIRA_MEMORY_PIN` must be set on the Mini (already is, from the memory feature) for the SOUL editor.

## Self-Review

**Spec coverage:** SOUL storage + default + seed (Task 1, 5) ✓; lessons as type:'lesson' + index partition + bounded full injection (Task 2) ✓; remember enum (Task 2) ✓; persona → SOUL in the prompt (Task 3) ✓; SOUL+LESSONS injection order, leading (Task 4) ✓; PIN-locked SOUL editor API + UI (Task 6, 7) ✓; portability (all vault Markdown + pure fns; only remember is SDK-specific) ✓.

**Type consistency:** `readSoul`/`writeSoul`/`seedSoulIfMissing`/`DEFAULT_SOUL`/`SOUL_FILE` defined in Task 1, consumed in 4/5/6; `lessonsText(dir?, {maxNotes,maxChars})` defined in Task 2, consumed in Task 4; `soulLessonsPreamble(soul, lessons)` defined in Task 4, used in `akira-turn`. Route response adds `soul`/`lessons` consumed by the panel (Task 7).

**Placeholder scan:** none — every code step carries complete code. (Task 4 Step 5 keeps the existing LAPTOP COMPANION ternary verbatim; only the leading `preamble + '\n\n'` is new.)
