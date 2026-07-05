# AKIRA Long-Term Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AKIRA a persistent Obsidian-style Markdown memory vault (a private git repo) she reads into her prompt and writes to via scoped `remember`/`forget` tools, browsable through a PIN-locked Settings section on the front door.

**Architecture:** A `data/akira-memory/` git checkout on the Mini is the source of truth. Pure `note.ts`/`pin.ts` + an fs/git `store.ts` back it. AKIRA gets two scoped MCP tools (vault-only writes, no generic Write). Her prompt gets a `## MEMORY` index each turn. A PIN-gated `/api/memory` pair feeds a front-door Settings panel.

**Tech Stack:** TypeScript (ESM), Next.js (this repo's build — read `node_modules/next/dist/docs/` before touching routes), `node:test` via `tsx`, `@anthropic-ai/claude-agent-sdk` tools, git via `child_process`.

## Global Constraints

- **Package manager `pnpm`**; `.npmrc` has `ignore-scripts=true` — leave it. **No new runtime dependency** (frontmatter parsed by hand; git via `node:child_process`).
- **Branch:** `feat/akira-long-term-memory` (already created off `dev`). Merge to `dev` when green; release as a **minor** via ship-mc-feature. **No DB migration.**
- **Work in the main checkout** on the feature branch — no linked worktree (Turbopack breaks on the junctioned `node_modules`).
- **Tests:** `node:test` + `node:assert/strict`, run by `tsx --test`. New `src/lib/akira/memory/*.test.ts` are picked up by the root `pnpm test` glob (`src/lib/akira/*.test.ts` does NOT match nested — see Task 1 Step 5 for the glob update).
- **Extensionless** relative TS imports (`./note`, not `./note.ts`).
- **Security:** AKIRA never gets the generic `Write`/`Edit` tool. `remember`/`forget` write only inside the vault (slug is path-guarded). Memory API routes require the session cookie AND the PIN. AKIRA is told never to store secrets.
- **Vault format:** one note per fact, `<slug>.md` with flat frontmatter `title / description / type / created / updated` + Markdown body; `INDEX.md` regenerated from notes on every write.

---

### Task 1: Pure note model (`memory/note.ts`)

**Files:**
- Create: `src/lib/akira/memory/note.ts`
- Test: `src/lib/akira/memory/note.test.ts`
- Modify: `package.json` (test glob) — Step 5

**Interfaces — Produces:**
- `type Note = { slug: string; title: string; description: string; type: string; created: string; updated: string; body: string }`
- `slugify(s: string): string`
- `safeSlug(s: string): string | null`
- `serializeNote(n: Note): string`
- `parseNote(slug: string, md: string): Note`
- `buildIndex(notes: Note[]): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/memory/note.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, safeSlug, serializeNote, parseNote, buildIndex, type Note } from './note';

const note = (p: Partial<Note>): Note => ({
  slug: 'x', title: 'X', description: 'a note', type: 'fact',
  created: '2026-07-03T00:00:00.000Z', updated: '2026-07-03T00:00:00.000Z', body: 'body', ...p,
});

test('slugify lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugify('Operator prefers X!'), 'operator-prefers-x');
  assert.equal(slugify('  Multiple   spaces  '), 'multiple-spaces');
});

test('safeSlug sanitizes and rejects traversal/empty (no slashes or dots survive)', () => {
  assert.equal(safeSlug('good-slug'), 'good-slug');
  assert.equal(safeSlug('../etc/passwd'), 'etc-passwd');
  assert.equal(safeSlug('..'), null);
  assert.equal(safeSlug('///'), null);
  assert.equal(safeSlug(''), null);
});

test('serializeNote/parseNote round-trip (slug is supplied, not stored)', () => {
  const n = note({ slug: 'obsidian', title: 'Obsidian memory', description: 'git-synced vault', type: 'project', body: 'Body [[link]].\n\nSecond para.' });
  const parsed = parseNote('obsidian', serializeNote(n));
  assert.deepEqual(parsed, n);
});

test('parseNote tolerates a file with no frontmatter', () => {
  const parsed = parseNote('loose', 'just body');
  assert.equal(parsed.body, 'just body');
  assert.equal(parsed.title, 'loose');
});

test('buildIndex lists notes newest-first as wikilinks', () => {
  const idx = buildIndex([
    note({ slug: 'old', description: 'older', updated: '2026-07-01T00:00:00.000Z' }),
    note({ slug: 'new', description: 'newer', updated: '2026-07-03T00:00:00.000Z' }),
  ]);
  assert.equal(idx, '- [[new]] — newer\n- [[old]] — older');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/note.test.ts`
Expected: FAIL — `Cannot find module './note'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/akira/memory/note.ts`:

```ts
// Pure note model for AKIRA's memory vault. Flat frontmatter (title/description/
// type/created/updated) + Markdown body. No I/O — unit-tested.

export interface Note {
  slug: string;
  title: string;
  description: string;
  type: string; // fact | preference | project | decision | reference (tolerant)
  created: string; // ISO
  updated: string; // ISO
  body: string;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** A slug safe as a single filename inside the vault (no slashes/dots survive). */
export function safeSlug(s: string): string | null {
  const x = slugify(s);
  return x.length ? x : null;
}

export function serializeNote(n: Note): string {
  return [
    '---',
    `title: ${n.title}`,
    `description: ${n.description}`,
    `type: ${n.type}`,
    `created: ${n.created}`,
    `updated: ${n.updated}`,
    '---',
    n.body,
  ].join('\n');
}

export function parseNote(slug: string, md: string): Note {
  const lines = md.split('\n');
  const fm: Record<string, string> = {};
  let body = md;
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close > 0) {
      for (const line of lines.slice(1, close)) {
        const i = line.indexOf(':');
        if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      body = lines.slice(close + 1).join('\n');
    }
  }
  return {
    slug,
    title: fm.title ?? slug,
    description: fm.description ?? '',
    type: fm.type ?? 'fact',
    created: fm.created ?? '',
    updated: fm.updated ?? '',
    body,
  };
}

export function buildIndex(notes: Note[]): string {
  return [...notes]
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0))
    .map((n) => `- [[${n.slug}]] — ${n.description}`)
    .join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/akira/memory/note.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Make the root test glob pick up nested memory tests, then commit**

The root `test` script only globs `src/lib/akira/*.test.ts` (one level). Edit `package.json`'s `test` script to add `src/lib/akira/memory/*.test.ts`:

```json
"test": "tsx --test src/lib/*.test.ts src/lib/akira/*.test.ts src/lib/akira/memory/*.test.ts src/lib/voice/*.test.ts src/lib/companion/*.test.ts companion/src/*.test.ts",
```

Run: `pnpm test` — Expected: the whole suite passes, including the new `note` tests.

```bash
git add src/lib/akira/memory/note.ts src/lib/akira/memory/note.test.ts package.json
git commit -m "feat(memory): pure note model — parse/serialize/slug/index"
```

---

### Task 2: Pure PIN verify + attempt limiter (`memory/pin.ts`)

**Files:**
- Create: `src/lib/akira/memory/pin.ts`
- Test: `src/lib/akira/memory/pin.test.ts`

**Interfaces — Produces:**
- `verifyPin(input: string, secret: string): boolean` (constant-time; false if `secret` empty)
- `type Limiter = { allowed(now: number): boolean; recordFailure(now: number): void; recordSuccess(): void }`
- `createLimiter(max: number, windowMs: number): Limiter`

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/memory/pin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPin, createLimiter } from './pin';

test('verifyPin matches only the exact PIN and rejects an empty secret', () => {
  assert.equal(verifyPin('4821', '4821'), true);
  assert.equal(verifyPin('4821', '0000'), false);
  assert.equal(verifyPin('anything', ''), false);
});

test('createLimiter blocks after max failures in the window, then recovers', () => {
  const lim = createLimiter(3, 1000);
  assert.equal(lim.allowed(0), true);
  lim.recordFailure(0); lim.recordFailure(0); lim.recordFailure(0);
  assert.equal(lim.allowed(0), false);
  assert.equal(lim.allowed(1001), true);
});

test('recordSuccess clears the failure count', () => {
  const lim = createLimiter(2, 1000);
  lim.recordFailure(0); lim.recordFailure(0);
  assert.equal(lim.allowed(0), false);
  lim.recordSuccess();
  assert.equal(lim.allowed(0), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/pin.test.ts`
Expected: FAIL — `Cannot find module './pin'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/akira/memory/pin.ts`:

```ts
// Pure PIN verification (constant-time) + a small failed-attempt limiter for the
// memory unlock. No I/O — unit-tested.
import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyPin(input: string, secret: string): boolean {
  if (!secret) return false;
  const a = createHash('sha256').update(String(input)).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

export interface Limiter {
  allowed(now: number): boolean;
  recordFailure(now: number): void;
  recordSuccess(): void;
}

export function createLimiter(max: number, windowMs: number): Limiter {
  let fails: number[] = [];
  return {
    allowed(now) {
      fails = fails.filter((t) => now - t < windowMs);
      return fails.length < max;
    },
    recordFailure(now) {
      fails.push(now);
    },
    recordSuccess() {
      fails = [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/akira/memory/pin.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/memory/pin.ts src/lib/akira/memory/pin.test.ts
git commit -m "feat(memory): constant-time PIN verify + attempt limiter"
```

---

### Task 3: Vault store (`memory/store.ts`) — fs + git

**Files:**
- Create: `src/lib/akira/memory/store.ts`
- Test: `src/lib/akira/memory/store.test.ts`

**Interfaces:**
- Consumes: `Note`, `parseNote`, `serializeNote`, `buildIndex`, `safeSlug` from `./note`.
- Produces:
  - `vaultDir(): string` · `vaultReady(dir?): boolean`
  - `listNotes(dir?): Note[]` · `readNote(slug, dir?): Note | null`
  - `writeNote({ title; description; type; body; slug? }, dir?): Note` (upsert)
  - `deleteNote(slug, dir?): boolean` · `writeIndex(dir?): void` · `indexText(dir?): string`
  - `gitCommitPush(message, dir?): void` · `gitPullDebounced(dir?): void` (best-effort, never throw)

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/memory/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listNotes, readNote, writeNote, deleteNote, indexText } from './store';

const vault = () => mkdtempSync(join(tmpdir(), 'akira-mem-'));

test('writeNote then listNotes/readNote round-trips', () => {
  const dir = vault();
  try {
    const n = writeNote({ title: 'Obsidian memory', description: 'git-synced vault', type: 'project', body: 'Body.' }, dir);
    assert.equal(n.slug, 'obsidian-memory');
    assert.equal(listNotes(dir).length, 1);
    assert.equal(readNote('obsidian-memory', dir)?.body, 'Body.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeNote upsert preserves created and does not duplicate', () => {
  const dir = vault();
  try {
    const a = writeNote({ title: 'X', description: 'first', type: 'fact', body: 'one' }, dir);
    const b = writeNote({ slug: a.slug, title: 'X', description: 'second', type: 'fact', body: 'two' }, dir);
    assert.equal(b.created, a.created);
    assert.equal(b.description, 'second');
    assert.equal(listNotes(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteNote removes the note and refreshes the index', () => {
  const dir = vault();
  try {
    writeNote({ title: 'Keep', description: 'k', type: 'fact', body: 'k' }, dir);
    const g = writeNote({ title: 'Gone', description: 'g', type: 'fact', body: 'g' }, dir);
    assert.equal(deleteNote(g.slug, dir), true);
    assert.equal(deleteNote('nope', dir), false);
    assert.equal(listNotes(dir).length, 1);
    assert.match(indexText(dir), /\[\[keep\]\]/);
    assert.doesNotMatch(indexText(dir), /\[\[gone\]\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts`
Expected: FAIL — `Cannot find module './store'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/akira/memory/store.ts`:

```ts
// Vault I/O for AKIRA's memory: note files + INDEX.md + best-effort git. Not
// server-only (uses only node fs/child_process), so the fs paths are unit-tested
// against a temp dir. Only server code imports it (routes, akira-turn, tools).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseNote, serializeNote, buildIndex, safeSlug, type Note } from './note';

export function vaultDir(): string {
  return process.env.AKIRA_MEMORY_DIR || join(process.cwd(), 'data', 'akira-memory');
}
export function vaultReady(dir = vaultDir()): boolean {
  return existsSync(dir);
}
function notePath(dir: string, slug: string): string {
  const p = resolve(dir, `${slug}.md`);
  if (!p.startsWith(resolve(dir))) throw new Error('unsafe slug'); // belt + suspenders
  return p;
}
export function listNotes(dir = vaultDir()): Note[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md')
    .map((f) => parseNote(f.replace(/\.md$/, ''), readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
}
export function readNote(slug: string, dir = vaultDir()): Note | null {
  const s = safeSlug(slug);
  if (!s) return null;
  const p = notePath(dir, s);
  return existsSync(p) ? parseNote(s, readFileSync(p, 'utf8')) : null;
}
export function writeNote(
  input: { title: string; description: string; type: string; body: string; slug?: string },
  dir = vaultDir(),
): Note {
  const slug = safeSlug(input.slug || input.title);
  if (!slug) throw new Error('could not derive a safe slug from the title');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const existing = readNote(slug, dir);
  const note: Note = {
    slug,
    title: input.title,
    description: input.description,
    type: input.type,
    created: existing?.created || now,
    updated: now,
    body: input.body,
  };
  writeFileSync(notePath(dir, slug), serializeNote(note));
  writeIndex(dir);
  return note;
}
export function deleteNote(slug: string, dir = vaultDir()): boolean {
  const s = safeSlug(slug);
  if (!s) return false;
  const p = notePath(dir, s);
  if (!existsSync(p)) return false;
  rmSync(p);
  writeIndex(dir);
  return true;
}
export function writeIndex(dir = vaultDir()): void {
  if (!existsSync(dir)) return;
  writeFileSync(join(dir, 'INDEX.md'), buildIndex(listNotes(dir)) + '\n');
}
export function indexText(dir = vaultDir()): string {
  return buildIndex(listNotes(dir));
}

// --- git: best-effort, never throws into a turn ---
function git(dir: string, args: string[]): void {
  try {
    execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore', timeout: 15_000 });
  } catch {
    /* offline / no remote / no repo — non-fatal */
  }
}
export function gitCommitPush(message: string, dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=AKIRA', '-c', 'user.email=akira@axod', 'commit', '-m', message]);
  git(dir, ['push']);
}
let lastPull = 0;
export function gitPullDebounced(dir = vaultDir()): void {
  if (!existsSync(join(dir, '.git'))) return;
  const ms = Number(process.env.AKIRA_MEMORY_PULL_MS ?? 60_000);
  if (Date.now() - lastPull < ms) return;
  lastPull = Date.now();
  git(dir, ['pull', '--ff-only']);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/memory/store.ts src/lib/akira/memory/store.test.ts
git commit -m "feat(memory): vault store — notes, index, best-effort git"
```

---

### Task 4: Scoped `remember` / `forget` tools

**Files:**
- Modify: `src/lib/akira/tool-actions.ts` (add the two tool-name constants)
- Modify: `src/lib/akira/tools.ts` (add the two tool definitions + include in `base`)
- Modify: `src/lib/akira-turn.ts` (add both to `extraAllowedTools`)

**Interfaces:**
- Consumes: `writeNote`, `deleteNote`, `gitCommitPush`, `vaultReady` from `@/lib/akira/memory/store`; `ok`, `err`, `tool`, `z`.
- Produces: `AKIRA_REMEMBER`, `AKIRA_FORGET` constants; two MCP tools named `remember` / `forget`.

- [ ] **Step 1: Add the tool-name constants**

In `src/lib/akira/tool-actions.ts`, after the existing `AKIRA_GET_SESSION` constant:

```ts
export const AKIRA_REMEMBER = 'mcp__akira__remember';
export const AKIRA_FORGET = 'mcp__akira__forget';
```

- [ ] **Step 2: Add the tool definitions in `tools.ts`**

In `src/lib/akira/tools.ts`, add an import near the other imports:

```ts
import { writeNote, deleteNote, gitCommitPush, vaultReady } from '@/lib/akira/memory/store';
```

Inside `createAkiraServer`, after the `getSession` tool and before `const base = [...]`, add:

```ts
  const remember = tool(
    'remember',
    "Save a durable fact/decision/preference to your long-term memory so you recall it in future sessions. Use for things worth keeping — not transient chatter. NEVER store secrets, passwords, or tokens. Updates the note if the slug already exists.",
    {
      title: z.string().min(1).describe('Short title (also the default slug).'),
      description: z.string().min(1).describe('One-line summary shown in your memory index.'),
      type: z.enum(['fact', 'preference', 'project', 'decision', 'reference']),
      body: z.string().min(1).describe('The note in Markdown. Link related notes with [[slug]].'),
      slug: z.string().optional().describe('Optional explicit slug to update an existing note.'),
    },
    async (a) => {
      if (!vaultReady()) return err("Memory isn't configured on this server yet.");
      const note = writeNote(a);
      gitCommitPush(`remember: ${note.title}`);
      return ok(`Remembered "${note.title}" (${note.slug}).`);
    },
  );

  const forget = tool(
    'forget',
    'Delete a note from your long-term memory by its slug.',
    { slug: z.string().min(1).describe('The slug of the note to delete.') },
    async (a) => {
      if (!vaultReady()) return err("Memory isn't configured on this server yet.");
      if (!deleteNote(a.slug)) return err(`No memory note "${a.slug}".`);
      gitCommitPush(`forget: ${a.slug}`);
      return ok(`Forgot "${a.slug}".`);
    },
  );
```

Then change the `base` array to include them:

```ts
  const base = [navigate, open, relay, listSessions, getSession, remember, forget];
```

- [ ] **Step 3: Allow the tools in the turn**

In `src/lib/akira-turn.ts`, update the import from `./akira/tools` to add the two constants:

```ts
import {
  createAkiraServer,
  AKIRA_SERVER_NAME,
  AKIRA_NAVIGATE,
  AKIRA_OPEN,
  AKIRA_RELAY,
  AKIRA_LIST_SESSIONS,
  AKIRA_GET_SESSION,
  AKIRA_REMEMBER,
  AKIRA_FORGET,
} from './akira/tools';
```

(The `tools.ts` barrel re-exports the constants from `tool-actions` — extend that
re-export block in `tools.ts` to include `AKIRA_REMEMBER, AKIRA_FORGET`.)

Then in the `extraAllowedTools` array add them:

```ts
      extraAllowedTools: [
        AKIRA_NAVIGATE,
        AKIRA_OPEN,
        AKIRA_RELAY,
        AKIRA_LIST_SESSIONS,
        AKIRA_GET_SESSION,
        AKIRA_REMEMBER,
        AKIRA_FORGET,
        ...BROWSER_TOOL_NAMES,
      ],
```

- [ ] **Step 4: Type-check + full suite**

Run: `pnpm exec tsc --noEmit` — Expected: clean.
Run: `pnpm test` — Expected: green (no behavior tests here; wiring only).

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/tool-actions.ts src/lib/akira/tools.ts src/lib/akira-turn.ts
git commit -m "feat(memory): scoped remember/forget tools (vault-only writes)"
```

---

### Task 5: Inject memory into AKIRA's prompt + pre-turn pull + guideline

**Files:**
- Modify: `src/lib/akira/prompt.ts` (add the Memory style guideline)
- Modify: `src/lib/akira-turn.ts` (pull + inject `## MEMORY`)

**Interfaces:** Consumes `indexText`, `gitPullDebounced` from `@/lib/akira/memory/store`.

- [ ] **Step 1: Add the memory guideline to the system prompt**

In `src/lib/akira/prompt.ts`, append to `AKIRA_SYSTEM_PROMPT` (after the Formatting paragraph, before the closing backtick):

```ts

Memory: you have a long-term memory (the ## MEMORY list in your context) of notes you've saved across sessions. Read a note's full text with your Read tool at data/akira-memory/<slug>.md. When the operator tells you something durable — a decision, a preference, a fact worth keeping — call the remember tool (one fact per note; update instead of duplicating; link related notes with [[slug]]). Delete stale notes with forget. NEVER store secrets, passwords, or tokens in memory.
```

- [ ] **Step 2: Pull + inject the index in the turn**

In `src/lib/akira-turn.ts`, add an import:

```ts
import { indexText, gitPullDebounced } from './akira/memory/store';
```

Find where `const prompt =` is assembled (it currently concatenates
`buildAkiraPrompt(...)` with the `## LAPTOP COMPANION` section). Just before it, add
the best-effort pull, and build a memory section:

```ts
    gitPullDebounced(); // pick up the operator's Obsidian edits (debounced, best-effort)
    let memoryBlock = '';
    try {
      const idx = indexText();
      memoryBlock = idx
        ? `\n\n## MEMORY\nNotes you've saved (read one with your Read tool at data/akira-memory/<slug>.md):\n${idx}`
        : `\n\n## MEMORY\n(empty — save durable facts with the remember tool)`;
    } catch {
      memoryBlock = '';
    }
```

Then insert `memoryBlock` into the prompt concatenation, after the base prompt and
before the companion section, e.g.:

```ts
    const prompt =
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      memoryBlock +
      `\n\n## LAPTOP COMPANION\n${companionOnline() ? '…' : '…'}`; // (leave the existing companion string intact)
```

- [ ] **Step 3: Type-check + suite**

Run: `pnpm exec tsc --noEmit` — clean.
Run: `pnpm test` — green.

- [ ] **Step 4: Commit**

```bash
git add src/lib/akira/prompt.ts src/lib/akira-turn.ts
git commit -m "feat(memory): inject ## MEMORY index + pre-turn pull; memory guideline"
```

---

### Task 6: PIN-gated memory API routes

**Files:**
- Create: `src/app/api/memory/route.ts` (POST → list)
- Create: `src/app/api/memory/[slug]/route.ts` (DELETE → forget)

**Interfaces:**
- Consumes: `SESSION_COOKIE`, `verifySession` from `@/lib/auth`; `verifyPin`, `createLimiter` from `@/lib/akira/memory/pin`; `listNotes`, `deleteNote`, `gitCommitPush`, `vaultReady` from `@/lib/akira/memory/store`.
- Produces: `POST /api/memory {pin}` → `{ notes: {slug,title,description,type,updated}[] }`; `DELETE /api/memory/[slug] {pin}` → `{ ok }`.

- [ ] **Step 1: Create the list route (POST, session + PIN)**

Create `src/app/api/memory/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin, createLimiter } from '@/lib/akira/memory/pin';
import { listNotes, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One limiter per server process — 5 wrong PINs / minute.
const limiter = createLimiter(5, 60_000);

export async function POST(req: Request) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!limiter.allowed(Date.now())) {
    return Response.json({ error: 'Too many attempts — wait a minute.' }, { status: 429 });
  }
  const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    limiter.recordFailure(Date.now());
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  limiter.recordSuccess();
  if (!vaultReady()) return Response.json({ notes: [] });
  const notes = listNotes().map(({ slug, title, description, type, updated }) => ({
    slug, title, description, type, updated,
  }));
  return Response.json({ notes });
}
```

- [ ] **Step 2: Create the forget route (DELETE, session + PIN)**

Create `src/app/api/memory/[slug]/route.ts`:

```ts
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/auth';
import { verifyPin } from '@/lib/akira/memory/pin';
import { deleteNote, gitCommitPush, vaultReady } from '@/lib/akira/memory/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || !(await verifySession(token))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { pin } = (await req.json().catch(() => ({}))) as { pin?: string };
  if (!verifyPin(String(pin ?? ''), process.env.AKIRA_MEMORY_PIN ?? '')) {
    return Response.json({ error: 'Wrong PIN' }, { status: 401 });
  }
  const { slug } = await params;
  if (!vaultReady() || !deleteNote(slug)) {
    return Response.json({ error: 'No such note' }, { status: 404 });
  }
  gitCommitPush(`forget: ${slug}`);
  return Response.json({ ok: true });
}
```

> **Next note:** confirm the `params: Promise<…>` + `await params` shape against
> `node_modules/next/dist/docs/` for this repo's Next version before finalizing — the
> other dynamic routes (e.g. `src/app/api/sessions/[id]/…`) show the exact signature
> this build expects; match them.

- [ ] **Step 3: Verify build + routes present**

Run: `pnpm build`
Expected: clean; the route table lists `ƒ /api/memory` and `ƒ /api/memory/[slug]`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/memory/route.ts src/app/api/memory/[slug]/route.ts
git commit -m "feat(memory): PIN-gated /api/memory list + forget routes"
```

---

### Task 7: Front-door PIN-locked Settings/Memory panel

**Files:**
- Create: `src/components/akira/memory-panel.tsx`
- Modify: `src/components/akira/hud.tsx` (render it in the Mission Control `<main>`, after the overnight-brief grid)

**Interfaces:** Consumes `POST /api/memory`, `DELETE /api/memory/[slug]`. Self-contained client component (its own locked/unlocked/PIN/notes/relock state).

- [ ] **Step 1: Create the panel component**

Create `src/components/akira/memory-panel.tsx`:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";

type Note = { slug: string; title: string; description: string; type: string; updated: string };

const RELOCK_MS = 120_000; // auto-lock after 2 min idle

const chipColor: Record<string, string> = {
  project: "#37d39b", preference: "#ff5acf", fact: "#7fdcff", decision: "#ffb84d", reference: "#8fb2c9",
};

export function MemoryPanel() {
  const [open, setOpen] = useState(false); // panel expanded (only when unlocked)
  const [notes, setNotes] = useState<Note[] | null>(null); // null = locked
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pinRef = useRef(""); // held only while unlocked, for delete calls
  const relockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function lock() {
    setNotes(null); setOpen(false); setPin(""); setError(""); pinRef.current = "";
    if (relockTimer.current) clearTimeout(relockTimer.current);
  }
  function armRelock() {
    if (relockTimer.current) clearTimeout(relockTimer.current);
    relockTimer.current = setTimeout(lock, RELOCK_MS);
  }
  useEffect(() => () => { if (relockTimer.current) clearTimeout(relockTimer.current); }, []);

  async function unlock() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/memory", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!r.ok) { setError(r.status === 429 ? "Too many attempts." : "Wrong PIN."); return; }
      const { notes } = await r.json();
      pinRef.current = pin; setNotes(notes); setOpen(true); setPin(""); armRelock();
    } catch { setError("Couldn't reach the server."); }
    finally { setBusy(false); }
  }

  async function forget(slug: string) {
    armRelock();
    const r = await fetch(`/api/memory/${encodeURIComponent(slug)}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: pinRef.current }),
    });
    if (r.ok) setNotes((ns) => (ns ?? []).filter((n) => n.slug !== slug));
  }

  const unlocked = notes !== null;
  return (
    <div style={panel} onMouseMove={unlocked ? armRelock : undefined}>
      <div style={head} onClick={() => unlocked && setOpen((o) => !o)}>
        <span style={{ color: unlocked ? "#37d39b" : "#ffb84d" }}>{unlocked ? "🔓" : "🔒"}</span>
        <span style={{ fontWeight: 700, color: "#eaffff" }}>Settings</span>
        <span style={{ marginLeft: "auto", ...meta }}>
          {unlocked ? `Unlocked · ${notes!.length} notes` : "Locked — memory & sensitive info"}
        </span>
      </div>

      {!unlocked && (
        <div style={pinRow}>
          <input
            type="password" inputMode="numeric" value={pin} placeholder="PIN"
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && unlock()}
            style={pinInput} autoComplete="off"
          />
          <button onClick={unlock} disabled={busy || !pin} style={unlockBtn}>Unlock</button>
          {error && <span style={{ ...meta, color: "#ff8fdc" }}>{error}</span>}
        </div>
      )}

      {unlocked && open && (
        <div style={{ padding: "4px 6px 10px" }}>
          <div style={memTop}>
            <span style={{ ...meta, color: "#7fdcff", letterSpacing: 1.5 }}>◉ MEMORY</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <a href="#" style={lnk}>Open in Obsidian ↗</a>
              <button onClick={lock} style={relockBtn}>🔒 Lock</button>
            </div>
          </div>
          {notes!.length === 0 ? (
            <div style={{ ...meta, padding: "8px 8px 4px" }}>No notes yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Type</th><th style={th}>Note</th><th style={th}>Updated</th><th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {notes!.map((n) => (
                  <tr key={n.slug}>
                    <td style={td}>
                      <span style={{ ...chip, color: chipColor[n.type] ?? "#8fb2c9", background: `${chipColor[n.type] ?? "#8fb2c9"}22` }}>{n.type}</span>
                    </td>
                    <td style={td}>
                      <div style={{ color: "#eaffff", fontWeight: 600, fontSize: 13 }}>{n.title}</div>
                      <div style={{ color: "#8494a6", fontSize: 11.5, marginTop: 3 }}>{n.description}</div>
                    </td>
                    <td style={{ ...td, ...meta, whiteSpace: "nowrap" }}>{new Date(n.updated).toLocaleDateString()}</td>
                    <td style={td}>
                      <button onClick={() => forget(n.slug)} title="Forget" style={xBtn}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const meta: React.CSSProperties = { color: "#6b7a8d", fontSize: 12, fontFamily: "ui-monospace, monospace" };
const panel: React.CSSProperties = { border: "1px solid #1c2c3d", borderRadius: 14, background: "rgba(7,13,22,.7)", overflow: "hidden" };
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 11, padding: "14px 16px", cursor: "pointer" };
const pinRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "0 16px 15px", flexWrap: "wrap" };
const pinInput: React.CSSProperties = { width: 120, height: 34, borderRadius: 8, border: "1px solid #1c2c3d", background: "#0a1626", color: "#e6edf3", padding: "0 12px", fontFamily: "ui-monospace, monospace", letterSpacing: 3, outline: "none" };
const unlockBtn: React.CSSProperties = { height: 34, padding: "0 15px", borderRadius: 8, border: 0, background: "#7fdcff", color: "#04121c", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
const memTop: React.CSSProperties = { display: "flex", alignItems: "center", padding: "10px 8px 8px" };
const lnk: React.CSSProperties = { fontSize: 11.5, color: "#7fdcff", textDecoration: "none", border: "1px solid rgba(127,220,255,.28)", borderRadius: 7, padding: "6px 11px" };
const relockBtn: React.CSSProperties = { fontSize: 11.5, color: "#ffb84d", border: "1px solid rgba(255,184,77,.35)", borderRadius: 7, padding: "6px 11px", background: "transparent", cursor: "pointer", fontFamily: "inherit" };
const th: React.CSSProperties = { ...meta, fontSize: 9.5, letterSpacing: 1.2, textTransform: "uppercase", textAlign: "left", padding: "6px 10px", borderBottom: "1px solid #13202e" };
const td: React.CSSProperties = { padding: "10px", borderBottom: "1px solid rgba(19,32,46,.6)", verticalAlign: "top" };
const chip: React.CSSProperties = { fontSize: 9, letterSpacing: 0.8, textTransform: "uppercase", borderRadius: 5, padding: "2px 7px", fontWeight: 700, whiteSpace: "nowrap" };
const xBtn: React.CSSProperties = { background: "transparent", border: 0, color: "#5f7186", cursor: "pointer", fontSize: 16, lineHeight: "16px" };
```

- [ ] **Step 2: Render it in the HUD's Mission Control section**

In `src/components/akira/hud.tsx`, add the import:

```ts
import { MemoryPanel } from "./memory-panel";
```

In the `<main style={mc}>` block, **after** the "AKIRA — overnight brief" grid closes
(the `</div>` ending that grid, before `</main>`), add:

```tsx
        <h3 style={sec}>AKIRA — settings</h3>
        <MemoryPanel />
```

- [ ] **Step 3: Type-check + build**

Run: `pnpm exec tsc --noEmit` — clean.
Run: `pnpm build` — clean.

- [ ] **Step 4: Manual verification (local, no vault needed)**

`pnpm dev`, open `/`, scroll to Mission Control → the **Settings** panel is locked.
- Without `AKIRA_MEMORY_PIN` set, any PIN → "Wrong PIN" (empty secret always fails). Good.
- Set `AKIRA_MEMORY_PIN=1234` in `.env.local`, restart; enter `1234` → unlocks; with no
  vault the grid shows "No notes yet."; **Lock** re-locks; wrong PIN 5× → 429.

- [ ] **Step 5: Commit**

```bash
git add src/components/akira/memory-panel.tsx src/components/akira/hud.tsx
git commit -m "feat(memory): PIN-locked Settings panel on the AKIRA front door"
```

---

### Task 8: Ops setup docs + gitignore

**Files:**
- Modify: `.gitignore` (ignore the vault checkout)
- Create: `docs/runbook-akira-memory.md` (one-time setup)
- Modify: `.env.example` if present (document `AKIRA_MEMORY_PIN` / `AKIRA_MEMORY_DIR`)

- [ ] **Step 1: Ignore the vault checkout**

Add to `.gitignore`:

```
data/akira-memory/
```

- [ ] **Step 2: Write the setup runbook**

Create `docs/runbook-akira-memory.md`:

```markdown
# AKIRA memory vault — setup

AKIRA's long-term memory is a private git repo checked out on the Mini at
`data/akira-memory/`, synced to your laptop Obsidian.

## One-time

1. **Create a private GitHub repo** `akira-memory`. Seed it with an empty `INDEX.md`.
2. **Mini deploy key:** as `mc`,
   `ssh-keygen -t ed25519 -f ~/.ssh/akira-memory -N ""`; add the `.pub` to the repo's
   Deploy keys with **write** access; add a host alias in `~/.ssh/config`
   (`Host github-akira-memory` / `IdentityFile ~/.ssh/akira-memory`).
3. **Clone on the Mini:**
   `sudo -u mc git clone git@github-akira-memory:<you>/akira-memory.git /srv/mission-control/data/akira-memory`
4. **Set the PIN + (optional) paths** in the Mini `.env`:
   `AKIRA_MEMORY_PIN=<your unlock PIN>` (optional `AKIRA_MEMORY_DIR`, `AKIRA_MEMORY_PULL_MS`).
   Restart `mission-control`.
5. **Laptop:** clone the repo, open the folder in Obsidian, enable the **Git plugin**
   (auto pull/commit/push on an interval).

## Notes
- The app repo ignores `data/akira-memory/` — it's a separate repo.
- Memory is plaintext (so Obsidian can read it); privacy = private repo + login + the
  PIN-locked Settings panel. Never store secrets in memory.
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore docs/runbook-akira-memory.md
git commit -m "docs(memory): vault setup runbook + gitignore the checkout"
```

---

## Final verification

- [ ] `pnpm test` — new `note`, `pin`, `store` suites pass alongside the rest.
- [ ] `pnpm exec tsc --noEmit` — clean.
- [ ] `pnpm build` — clean; `/api/memory` and `/api/memory/[slug]` present.
- [ ] Manual (local): Settings panel locks/unlocks with `AKIRA_MEMORY_PIN`, re-locks, 429 on brute force, grid renders, forget removes a row.
- [ ] Manual (with a real vault on the Mini, post-deploy): ask AKIRA to remember
      something → note file appears + pushes → Obsidian pulls it → in a fresh session
      the `## MEMORY` index shows it and she can recall it → forget removes it.
- [ ] Merge `feat/akira-long-term-memory` → `dev`. Release (minor) + deploy per
      ship-mc-feature; **run the memory runbook on the Mini** as part of deploy
      (private repo + deploy key + clone + `AKIRA_MEMORY_PIN`). No DB migration.

## Deploy note (for the human)

This release adds **no npm deps and no migration**, but it DOES need the one-time vault
setup on the Mini (`docs/runbook-akira-memory.md`) — the private repo, the deploy key,
the clone at `data/akira-memory/`, and `AKIRA_MEMORY_PIN` in `.env`. Until that's done,
memory degrades gracefully (tools say "not configured"; the panel shows no notes).
