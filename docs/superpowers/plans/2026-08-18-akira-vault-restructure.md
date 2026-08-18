# AKIRA Vault Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split AKIRA's vault into an AKIRA-owned `memory/` zone that keeps the existing one-fact note model, and a shared document tree she and A'Keem both work in, with the vault's map living in the vault instead of in code.

**Architecture:** `vaultDir()` stays the vault root and keeps serving `SOUL.md`, the root `CLAUDE.md`, and the document tree. A new `memoryDir()` = `vaultDir()/memory` becomes the default for every note function, falling back to the root when `memory/` does not exist so the code deploy and the data migration are order-independent. A new pure `vault-map` module reads the root `CLAUDE.md` and injects it as a `## VAULT` block each turn. Documents are plain files navigated with the Read/Glob/Grep tools AKIRA already has — no new tool, no new store.

**Tech Stack:** TypeScript, Next.js, `node:test` via `tsx`, `node:fs`, Drizzle (not touched here), React (memory panel).

**Spec:** `docs/superpowers/specs/2026-08-18-akira-vault-restructure-design.md`

## Global Constraints

- **Imports are extensionless.** `import { x } from './store'` — a `.ts` extension breaks `tsc` and the Next build.
- **Tests are `node:test` run through `tsx`.** No test-runner dependency. Full suite: `pnpm test`. Single file: `pnpm exec tsx --test <path>`.
- **File-system tests use temp dirs** via `mkdtempSync(join(tmpdir(), 'akira-mem-'))` with `rmSync(dir, { recursive: true, force: true })` in a `finally`. Follow the existing pattern in `src/lib/akira/memory/store.test.ts`.
- **The note model does not change.** Frontmatter fields, `safeSlug`, `serializeNote`/`parseNote`, `remember`/`forget`, and one-fact-per-note stay exactly as they are.
- **`memoryDir()` must fall back to `vaultDir()`** whenever `memory/` is absent. This is what makes deploy-before-migrate and migrate-before-deploy both safe.
- **Commits are Conventional Commits** and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Never commit a real vault path's contents.** All tests operate on temp dirs; the live vault lives on the Mini at `/srv/mission-control/data/akira-memory`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/akira/memory/store.ts` (modify) | Add `memoryDir()`; repoint note-function defaults; change `lessonsText` return type and cap |
| `src/lib/akira/memory/store.test.ts` (modify) | Cover `memoryDir()` resolution and the new `lessonsText` shape |
| `src/lib/akira/memory/vault-map.ts` (create) | Read the root `CLAUDE.md`; build the injectable `## VAULT` block |
| `src/lib/akira/memory/vault-map.test.ts` (create) | Cover present / absent / over-cap |
| `src/lib/akira-turn.ts` (modify) | Inject the `## VAULT` block; fix the note path in the `## MEMORY` block; adapt to the new `lessonsText` shape |
| `src/app/api/memory/route.ts` (modify) | Return `lessonsDropped` so truncation is visible |
| `src/components/akira/memory-panel.tsx` (modify) | Render the dropped-lesson warning |
| `scripts/migrate-vault.ts` (create) | Idempotent migration: create zones, move notes, seed `CLAUDE.md` and indexes |
| `scripts/migrate-vault.test.ts` (create) | Cover the migration against a temp vault, including a second no-op run |
| `package.json` (modify) | Add `vault:migrate` script; add the new test path to `test` |

---

### Task 1: `memoryDir()` and scoping the note functions to it

**Files:**
- Modify: `src/lib/akira/memory/store.ts:9-20`
- Test: `src/lib/akira/memory/store.test.ts`

**Interfaces:**
- Consumes: `vaultDir()` (existing, unchanged).
- Produces: `memoryDir(dir?: string): string` — returns `join(vaultDir(), 'memory')` when that directory exists, otherwise `vaultDir()`. Every note function (`listNotes`, `readNote`, `writeNote`, `deleteNote`, `writeIndex`, `indexText`, `lessonsText`) takes `dir = memoryDir()` as its default.

- [ ] **Step 1: Write the failing test**

In `src/lib/akira/memory/store.test.ts`, **extend the two existing import statements** rather than adding new ones — the file already imports from `node:fs` and from `./store`, and duplicate imports fail lint:

```typescript
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { listNotes, readNote, writeNote, deleteNote, indexText, lessonsText, memoryDir } from './store';
```

Then append these tests:

```typescript
test('memoryDir returns the memory/ subfolder when it exists', () => {
  const dir = vault();
  try {
    mkdirSync(join(dir, 'memory'));
    assert.equal(memoryDir(dir), join(dir, 'memory'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('memoryDir falls back to the vault root before the migration', () => {
  const dir = vault();
  try {
    assert.equal(memoryDir(dir), dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('notes written after the migration land in memory/, not the root', () => {
  const dir = vault();
  try {
    mkdirSync(join(dir, 'memory'));
    writeNote({ title: 'Zoned', description: 'd', type: 'fact', body: 'b' }, memoryDir(dir));
    assert.equal(readNote('zoned', memoryDir(dir))?.body, 'b');
    assert.equal(readNote('zoned', dir), null); // not at the root
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts`
Expected: FAIL — `memoryDir` is not exported from `./store`.

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/akira/memory/store.ts`, directly below `vaultReady`:

```typescript
/**
 * The notes zone. Falls back to the vault root when memory/ is absent so the
 * code deploy and the data migration are order-independent — a pre-migration
 * vault keeps reading and writing exactly where it always did.
 */
export function memoryDir(dir = vaultDir()): string {
  const sub = join(dir, 'memory');
  return existsSync(sub) ? sub : dir;
}
```

Then change the default parameter on each note function from `vaultDir()` to `memoryDir()`:

```typescript
export function listNotes(dir = memoryDir()): Note[] {
export function readNote(slug: string, dir = memoryDir()): Note | null {
export function writeNote(input: { /* unchanged */ }, dir = memoryDir()): Note {
export function deleteNote(slug: string, dir = memoryDir()): boolean {
export function writeIndex(dir = memoryDir()): void {
export function indexText(dir = memoryDir()): string {
export function lessonsText(dir = memoryDir(), opts: { /* unchanged */ } = {}): string {
```

Leave `nonLessonNotes(dir: string)` alone — it always receives an explicit dir.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts`
Expected: PASS, including all pre-existing tests. They pass `dir` explicitly, so repointing the defaults cannot affect them.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/memory/store.ts src/lib/akira/memory/store.test.ts
git commit -m "feat(memory): scope notes to a memory/ zone with a root fallback

memoryDir() resolves to vault/memory when it exists and to the vault root
otherwise, so the code deploy and the vault migration can happen in either
order without breaking reads.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Make lesson truncation visible

**Files:**
- Modify: `src/lib/akira/memory/store.ts:83-107`
- Modify: `src/lib/akira-turn.ts:95`
- Test: `src/lib/akira/memory/store.test.ts`

**Interfaces:**
- Consumes: `memoryDir()` from Task 1.
- Produces: `lessonsText(dir?, opts?): { text: string; included: number; dropped: number }` — was a bare `string`. Default `maxChars` rises from `4096` to `8192`; `maxNotes` stays `20`.

**Why:** measured on the Mini, the 15 live lesson bodies total roughly 6.8k chars against the old 4096 cap, so about six of the oldest were dropped from every turn with no signal.

- [ ] **Step 1: Write the failing test**

Replace the two existing cap tests in `src/lib/akira/memory/store.test.ts` (`'lessonsText respects the note-count cap, newest first'` and `'lessonsText respects the char budget'`) with:

```typescript
test('lessonsText reports what it included and what it dropped', () => {
  const d = vault();
  try {
    for (let i = 0; i < 6; i++) {
      writeNote({ title: `L${i}`, description: 'd', type: 'lesson', body: 'x'.repeat(50) }, d);
    }
    const out = lessonsText(d, { maxNotes: 100, maxChars: 120 });
    assert.ok(out.included >= 1, 'at least one lesson always makes it in');
    assert.equal(out.included + out.dropped, 6);
    assert.ok(out.dropped > 0, 'the budget is too small for all six');
    assert.ok(out.text.length > 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText drops nothing when everything fits', () => {
  const d = vault();
  try {
    writeNote({ title: 'Only', description: 'd', type: 'lesson', body: 'short' }, d);
    const out = lessonsText(d, { maxNotes: 100, maxChars: 8192 });
    assert.equal(out.dropped, 0);
    assert.equal(out.included, 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText respects the note-count cap, newest first', () => {
  const d = vault();
  try {
    for (let i = 0; i < 8; i++) {
      writeNote({ title: `N${i}`, description: 'd', type: 'lesson', body: 'body' }, d);
    }
    const out = lessonsText(d, { maxNotes: 5, maxChars: 100_000 });
    assert.equal(out.included, 5);
    assert.equal(out.dropped, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText is empty when there are no lessons', () => {
  const d = vault();
  try {
    assert.equal(lessonsText(d).text, '');
    assert.equal(lessonsText(d).included, 0);
    assert.equal(lessonsText(d).dropped, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

Also update the existing `'indexText excludes lesson notes; lessonsText returns them in full'` test — its `const lessons = lessonsText(d);` becomes `const lessons = lessonsText(d).text;`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts`
Expected: FAIL — `out.included` is `undefined` because `lessonsText` still returns a string.

- [ ] **Step 3: Write the minimal implementation**

Replace the body of `lessonsText` in `src/lib/akira/memory/store.ts`:

```typescript
export interface LessonsResult {
  text: string;
  included: number;
  dropped: number;
}

/**
 * Full bodies of the newest lesson notes, as an injectable guidance block.
 * Bounded by BOTH a note count and a char budget (whichever hits first). The
 * counts are returned so truncation surfaces in the UI instead of happening
 * silently — pruning is a judgement call for A'Keem and AKIRA, not the code's.
 */
export function lessonsText(
  dir = memoryDir(),
  opts: { maxNotes?: number; maxChars?: number } = {},
): LessonsResult {
  const maxNotes = opts.maxNotes ?? 20;
  const maxChars = opts.maxChars ?? 8192;
  const lessons = listNotes(dir).filter((n) => n.type === 'lesson'); // newest-first
  const blocks: string[] = [];
  let chars = 0;
  for (const n of lessons.slice(0, maxNotes)) {
    const block = `### ${n.title}\n${n.body.trim()}`;
    if (chars + block.length > maxChars && blocks.length > 0) break;
    blocks.push(block);
    chars += block.length;
  }
  return { text: blocks.join('\n\n'), included: blocks.length, dropped: lessons.length - blocks.length };
}
```

- [ ] **Step 4: Update the single caller**

In `src/lib/akira-turn.ts`, line 95:

```typescript
      preamble = soulLessonsPreamble(readSoul(), lessonsText().text);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/memory/store.test.ts` — expected PASS.
Then `pnpm exec tsc --noEmit` — expected no errors, confirming no other caller relied on the string return.

- [ ] **Step 6: Commit**

```bash
git add src/lib/akira/memory/store.ts src/lib/akira/memory/store.test.ts src/lib/akira-turn.ts
git commit -m "fix(memory): stop dropping lessons silently

lessonsText returns { text, included, dropped } and the char budget rises
from 4096 to 8192. The 15 live lessons total ~6.8k chars, so roughly six of
the oldest were being cut from every turn with no signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The `vault-map` module

**Files:**
- Create: `src/lib/akira/memory/vault-map.ts`
- Create: `src/lib/akira/memory/vault-map.test.ts`

**Interfaces:**
- Consumes: `vaultDir()` from `./store`.
- Produces:
  - `readVaultMap(dir?: string, maxChars?: number): string` — the root `CLAUDE.md`, trimmed and truncated; `''` when absent or unreadable.
  - `vaultBlock(map: string): string` — pure; `''` for empty input, otherwise `## VAULT\n<map>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/akira/memory/vault-map.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVaultMap, vaultBlock } from './vault-map';

const vault = () => mkdtempSync(join(tmpdir(), 'akira-map-'));

test('readVaultMap returns the root CLAUDE.md', () => {
  const d = vault();
  try {
    writeFileSync(join(d, 'CLAUDE.md'), '# Vault\nNavigate via INDEX.md.\n');
    assert.match(readVaultMap(d), /Navigate via INDEX\.md/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readVaultMap is empty when there is no CLAUDE.md', () => {
  const d = vault();
  try {
    assert.equal(readVaultMap(d), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readVaultMap truncates an oversized map', () => {
  const d = vault();
  try {
    writeFileSync(join(d, 'CLAUDE.md'), 'y'.repeat(9000));
    assert.equal(readVaultMap(d, 4096).length, 4096);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultBlock wraps a map and stays empty for none', () => {
  assert.equal(vaultBlock(''), '');
  assert.equal(vaultBlock('   '), '');
  assert.equal(vaultBlock('# Vault'), '## VAULT\n# Vault');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/memory/vault-map.test.ts`
Expected: FAIL — cannot find module `./vault-map`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/akira/memory/vault-map.ts`:

```typescript
// The vault's own map: conventions and navigation pattern, authored as
// CLAUDE.md at the vault root so it is editable in Obsidian and present for any
// Claude Code opened directly in the vault. Injected into AKIRA's turn because
// she runs with cwd at Mission Control, where a vault CLAUDE.md never auto-loads.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './store';

export const VAULT_MAP_FILE = 'CLAUDE.md';
const DEFAULT_MAX_CHARS = 6144;

export function readVaultMap(dir: string = vaultDir(), maxChars = DEFAULT_MAX_CHARS): string {
  const p = join(dir, VAULT_MAP_FILE);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim().slice(0, maxChars);
  } catch {
    return ''; // unreadable map must never break a turn
  }
}

/** Pure: wrap the map as an injectable block. Empty in, empty out. */
export function vaultBlock(map: string): string {
  const m = map.trim();
  return m ? `## VAULT\n${m}` : '';
}
```

- [ ] **Step 4: Register the test path and run**

`src/lib/akira/memory/*.test.ts` is already covered by the `test` script in `package.json`, so no change is needed there.

Run: `pnpm exec tsx --test src/lib/akira/memory/vault-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/memory/vault-map.ts src/lib/akira/memory/vault-map.test.ts
git commit -m "feat(memory): read the vault map from the vault, not the code

The conventions and navigation pattern move to a CLAUDE.md at the vault
root so they can be edited in Obsidian.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Inject the map and fix the note path in the turn prompt

**Files:**
- Modify: `src/lib/akira-turn.ts:83-104`
- Modify: `src/lib/akira/prompt.ts:5` (the memory paragraph)

**Interfaces:**
- Consumes: `readVaultMap`, `vaultBlock` from Task 3.
- Produces: no new exports. The assembled prompt gains a `## VAULT` section, and the `## MEMORY` block points at `memory/<slug>.md`.

- [ ] **Step 1: Update the memory block and add the vault block**

In `src/lib/akira-turn.ts`, add the import alongside the existing store import:

```typescript
import { readVaultMap, vaultBlock } from './akira/memory/vault-map';
```

Replace the `memoryBlock` assignment (currently lines 83-92) with:

```typescript
    let memoryBlock = '';
    try {
      const idx = indexText();
      memoryBlock = idx
        ? `\n\n## MEMORY\nNotes you've saved (read one with your Read tool at data/akira-memory/memory/<slug>.md):\n${idx}`
        : `\n\n## MEMORY\n(empty — save durable facts with the remember tool)`;
    } catch {
      memoryBlock = '';
    }

    let vaultMapBlock = '';
    try {
      const block = vaultBlock(readVaultMap());
      vaultMapBlock = block ? `\n\n${block}` : '';
    } catch {
      vaultMapBlock = ''; // an unreadable map must never break a turn
    }
```

- [ ] **Step 2: Add the block to the assembled prompt**

In the same file, extend the `const prompt = ...` expression so `vaultMapBlock` follows `memoryBlock`:

```typescript
    const prompt =
      preamble + '\n\n' +
      buildAkiraPrompt(snapshot, roster, transcript, agentLabels) +
      memoryBlock +
      vaultMapBlock +
```

Leave the rest of the concatenation (the `## LAPTOP COMPANION` section onward) untouched.

- [ ] **Step 3: Update the system prompt's memory paragraph**

In `src/lib/akira/prompt.ts`, inside `AKIRA_SYSTEM_PROMPT`, change:

> `Read a note's full text with your Read tool at data/akira-memory/<slug>.md.`

to:

> `Read a note's full text with your Read tool at data/akira-memory/memory/<slug>.md. The rest of the vault is a document tree you navigate with Read/Glob/Grep — the ## VAULT block gives you its map and its conventions. Follow that map: read the INDEX.md at each level rather than globbing blindly.`

- [ ] **Step 4: Verify the build typechecks**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm test`
Expected: the full suite passes — this task changes prompt assembly, which has no unit test of its own; the gate is the typecheck plus no regression elsewhere.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira-turn.ts src/lib/akira/prompt.ts
git commit -m "feat(akira): inject the vault map into every turn

Adds the ## VAULT block from the vault's CLAUDE.md and repoints the
## MEMORY note path at the memory/ zone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Surface dropped lessons in the memory panel

**Files:**
- Modify: `src/app/api/memory/route.ts:26-30`
- Modify: `src/components/akira/memory-panel.tsx:15-23,48-49,109`

**Interfaces:**
- Consumes: `lessonsText` from Task 2.
- Produces: the `POST /api/memory` response gains `lessonsDropped: number`.

- [ ] **Step 1: Return the count from the API**

In `src/app/api/memory/route.ts`, add `lessonsText` to the store import:

```typescript
import { listNotes, lessonsText, vaultReady } from '@/lib/akira/memory/store';
```

Change the unready early return and the success return:

```typescript
  if (!vaultReady()) {
    return Response.json({ notes: [], soul: readSoul(), soulProposal: null, lessonsDropped: 0 });
  }
  const notes = listNotes().map(({ slug, title, description, type, updated }) => ({
    slug, title, description, type, updated,
  }));
  return Response.json({
    notes,
    soul: readSoul(),
    soulProposal: readSoulProposal(),
    lessonsDropped: lessonsText().dropped,
  });
```

- [ ] **Step 2: Hold the count in the panel**

In `src/components/akira/memory-panel.tsx`, add the state beside the others (near line 23):

```typescript
  const [lessonsDropped, setLessonsDropped] = useState(0);
```

In the unlock handler beside `setSoulProposal(...)` (near line 49):

```typescript
      setLessonsDropped(data.lessonsDropped ?? 0);
```

- [ ] **Step 3: Render the warning**

Replace the header label at line 109:

```tsx
          {unlocked ? `Unlocked · ${notes!.length} notes` : "Locked — memory & sensitive info"}
```

with:

```tsx
          {unlocked
            ? `Unlocked · ${notes!.length} notes${lessonsDropped > 0 ? ` · ${lessonsDropped} lessons over budget` : ""}`
            : "Locked — memory & sensitive info"}
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/memory/route.ts src/components/akira/memory-panel.tsx
git commit -m "feat(memory): show when lessons exceed the injection budget

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The migration script

**Files:**
- Create: `scripts/migrate-vault.ts`
- Create: `scripts/migrate-vault.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `vaultDir`, `writeIndex`, `memoryDir` from `../src/lib/akira/memory/store`.
- Produces: `migrateVault(dir: string): { moved: number; created: string[] }` — exported so it is testable; the script's CLI entry calls it with `vaultDir()`.

**Spec deviation to note in the commit:** the spec said the migration leaves `INDEX.md` at the root. That is wrong as written — the root `INDEX.md` today *is* the generated recall index. The migration must let it be regenerated under `memory/` and write a fresh zone map at the root instead.

- [ ] **Step 1: Write the failing test**

Create `scripts/migrate-vault.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateVault, ZONES } from './migrate-vault';

const note = (title: string, type: string) =>
  `---\ntitle: ${title}\ndescription: d\ntype: ${type}\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\nBody of ${title}.`;

function seeded() {
  const d = mkdtempSync(join(tmpdir(), 'akira-mig-'));
  writeFileSync(join(d, 'hold-when-told.md'), note('Hold when told', 'lesson'));
  writeFileSync(join(d, 'forge-mc-designs.md'), note('Forge MC designs', 'fact'));
  writeFileSync(join(d, 'SOUL.md'), '# AKIRA — Soul\nVoice.');
  writeFileSync(join(d, 'INDEX.md'), '- [[forge-mc-designs]] — d');
  return d;
}

test('migrateVault moves notes into memory/ and leaves SOUL at the root', () => {
  const d = seeded();
  try {
    const out = migrateVault(d);
    assert.equal(out.moved, 2);
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
    assert.ok(existsSync(join(d, 'memory', 'forge-mc-designs.md')));
    assert.ok(!existsSync(join(d, 'hold-when-told.md')));
    assert.ok(existsSync(join(d, 'SOUL.md')), 'SOUL stays at the root');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault creates every zone with a stub INDEX.md', () => {
  const d = seeded();
  try {
    migrateVault(d);
    for (const z of ZONES) {
      assert.ok(existsSync(join(d, z, 'INDEX.md')), `${z}/INDEX.md missing`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault writes a root CLAUDE.md map and a root INDEX.md that is not the recall index', () => {
  const d = seeded();
  try {
    migrateVault(d);
    assert.match(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), /INDEX\.md/);
    const rootIndex = readFileSync(join(d, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(rootIndex, /forge-mc-designs/, 'root index is a zone map, not the recall index');
    assert.match(rootIndex, /memory/);
    assert.match(readFileSync(join(d, 'memory', 'INDEX.md'), 'utf8'), /forge-mc-designs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault is idempotent', () => {
  const d = seeded();
  try {
    migrateVault(d);
    const second = migrateVault(d);
    assert.equal(second.moved, 0);
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test scripts/migrate-vault.test.ts`
Expected: FAIL — cannot find module `./migrate-vault`.

- [ ] **Step 3: Write the minimal implementation**

> **Superseded by `d833059`, and again by the final-review fix wave — see the
> shipped file, not this snippet.** The `writeFileSync` calls for the root
> `CLAUDE.md` and `INDEX.md` shown below are unconditional; the shipped code
> guards both with an `alreadyMigrated` check captured *before any mkdir* so a
> re-run never clobbers an operator's hand-edited root files. The shipped
> `scripts/migrate-vault.ts` also adds stranded-note detection and a
> synchronous git commit in the CLI entry that this snippet predates.
> Re-executing this exact snippet reintroduces the operator-edit clobber the
> later fix removed. Read `scripts/migrate-vault.ts` for the real
> implementation.

Create `scripts/migrate-vault.ts`:

```typescript
// One-time, idempotent vault migration: flat notes -> memory/ zone, plus the
// shared document tree and the vault's own map. Safe to run twice.
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir, writeIndex } from '../src/lib/akira/memory/store';
import { isNoteFile } from '../src/lib/akira/memory/note';

export const ZONES = ['memory', 'projects', 'ops', 'research', 'outputs', 'personal'] as const;

const ROOT_KEEP = new Set(['SOUL.md', 'SOUL.proposed.md', 'CLAUDE.md', 'INDEX.md']);

const ZONE_BLURB: Record<string, string> = {
  memory: "AKIRA's own notes. Written only through the remember/forget tools. Do not hand-edit.",
  projects: 'Per-project knowledge, one folder per projects.id. Title lives in each folder INDEX.md.',
  ops: 'Runbooks, machine topology, the backup chain, incident write-ups.',
  research: 'Raw captures distilled into durable pages.',
  outputs: 'Specs, plans, and reports worth finding again.',
  personal: 'Goals, journals, reviews.',
};

const CLAUDE_MD = `# AKIRA's vault

The directory is named \`akira-memory\` for historical reasons — it holds the whole
knowledge base now, not only her memory.

## Zones

${ZONES.map((z) => `- \`${z}/\` — ${ZONE_BLURB[z]}`).join('\n')}

## Navigation pattern

Read the \`INDEX.md\` at each level before globbing. Every folder's INDEX.md lists
what is in it, one line per entry, with a summary worth reading. Descend only
into the folder the index points at.

## Conventions

- \`memory/INDEX.md\` is generated by the code. Never hand-edit it.
- Every other \`INDEX.md\` is maintained by AKIRA. When you add a document to a
  folder, add its line to that folder's INDEX.md in the same turn.
- Link related pages with \`[[slug]]\`. Slugs are unique filenames, so links work
  regardless of folder depth.
- One fact per note in \`memory/\`. Documents elsewhere may be any length.
`;

const ROOT_INDEX = `# Vault map

${ZONES.map((z) => `- [[${z}]] — ${ZONE_BLURB[z]}`).join('\n')}

See CLAUDE.md for the navigation pattern.
`;

export function migrateVault(dir: string = vaultDir()): { moved: number; created: string[] } {
  const created: string[] = [];
  for (const z of ZONES) {
    const p = join(dir, z);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created.push(z);
    }
  }

  let moved = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || ROOT_KEEP.has(f)) continue;
    const src = join(dir, f);
    let md = '';
    try {
      md = readFileSync(src, 'utf8');
    } catch {
      continue; // a directory entry ending in .md, or unreadable — leave it alone
    }
    if (!isNoteFile(md)) continue; // stray file, not a memory note
    renameSync(src, join(dir, 'memory', f));
    moved++;
  }

  writeFileSync(join(dir, 'CLAUDE.md'), CLAUDE_MD);
  writeFileSync(join(dir, 'INDEX.md'), ROOT_INDEX);
  for (const z of ZONES) {
    if (z === 'memory') continue; // generated below
    const p = join(dir, z, 'INDEX.md');
    if (!existsSync(p)) writeFileSync(p, `# ${z}\n\n${ZONE_BLURB[z]}\n\n(empty)\n`);
  }
  writeIndex(join(dir, 'memory'));

  return { moved, created };
}

// CLI entry: `pnpm vault:migrate`
if (process.argv[1]?.endsWith('migrate-vault.ts')) {
  const dir = vaultDir();
  if (!existsSync(dir)) {
    console.error(`No vault at ${dir}`);
    process.exit(1);
  }
  const { moved, created } = migrateVault(dir);
  console.log(`Vault migrated at ${dir}: ${moved} notes moved, zones created: ${created.join(', ') || 'none'}`);
}
```

- [ ] **Step 4: Register the script and its test**

In `package.json`, add to `scripts`:

```json
    "vault:migrate": "tsx scripts/migrate-vault.ts",
```

and extend the `test` script with `scripts/*.test.ts`:

```json
    "test": "tsx --test src/lib/*.test.ts src/lib/akira/*.test.ts src/lib/akira/memory/*.test.ts src/lib/voice/*.test.ts src/lib/companion/*.test.ts companion/src/*.test.ts src/lib/routing/*.test.ts room-agent/src/*.test.ts scripts/*.test.ts",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec tsx --test scripts/migrate-vault.test.ts`
Expected: PASS, all four tests.

Run: `pnpm test`
Expected: the full suite passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-vault.ts scripts/migrate-vault.test.ts package.json
git commit -m "feat(memory): add the idempotent vault migration

Moves flat notes into memory/, creates the shared document tree, and seeds
the vault CLAUDE.md map plus a per-zone INDEX.md.

Deviates from the spec on one point: the spec said to leave INDEX.md at the
root, but the root INDEX.md today IS the generated recall index. It is
regenerated under memory/ and the root gets a fresh zone map instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify end to end against a copy of the real vault

**Files:** none modified — this is a verification gate before release.

- [ ] **Step 1: Copy the live vault to the scratchpad**

```bash
ssh akeem@10.0.0.219 'sudo -n -u mc tar -C /srv/mission-control/data -cf - akira-memory' > /tmp/vault.tar
mkdir -p /tmp/vaultcheck && tar -C /tmp/vaultcheck -xf /tmp/vault.tar
```

- [ ] **Step 2: Run the migration against the copy**

```bash
AKIRA_MEMORY_DIR=/tmp/vaultcheck/akira-memory pnpm vault:migrate
```

Expected output: `17 notes moved, zones created: memory, projects, ops, research, outputs, personal`.

- [ ] **Step 3: Assert the shape**

```bash
ls /tmp/vaultcheck/akira-memory
ls /tmp/vaultcheck/akira-memory/memory | wc -l
```

Expected: the root holds `CLAUDE.md`, `INDEX.md`, `SOUL.md`, and the six zone folders. `memory/` holds 18 files — the 17 notes plus the regenerated `INDEX.md`.

- [ ] **Step 4: Confirm the lesson budget now fits**

```bash
AKIRA_MEMORY_DIR=/tmp/vaultcheck/akira-memory pnpm exec tsx -e "import('./src/lib/akira/memory/store').then(m => { const r = m.lessonsText(); console.log('included', r.included, 'dropped', r.dropped, 'chars', r.text.length); })"
```

Expected: `dropped 0` — the point of raising the cap to 8192. If `dropped` is above zero, the 8192 figure was too low; raise it and rerun rather than shipping a still-silent truncation.

- [ ] **Step 5: Clean up and commit nothing**

```bash
rm -rf /tmp/vaultcheck /tmp/vault.tar
```

This task produces no commit. It gates the release.

---

## Rollout (after all tasks land)

Follow the `ship-mc-feature` workflow for the release itself. Vault-specific steps:

1. Merge to `dev`, release, deploy to the Mini.
2. On the Mini: `cd /srv/mission-control && sudo -n -u mc pnpm vault:migrate`.
3. **Reseed agents** — AKIRA's system prompt changed in Task 4, and a stale seeded prompt is a known trap in this repo.
4. `systemctl --failed`.
5. Confirm in the HUD that the memory panel no longer reports lessons over budget.
6. Ops, not code: install Obsidian on the Mini and open `/srv/mission-control/data/akira-memory` as a vault.

The `memoryDir()` fallback from Task 1 makes deploy-before-migrate (steps 1
then 2, as listed) safe. Migrate-before-restart is **not** safe — a
still-running old build reads `vaultDir()` for notes, finds the root empty
after migration, and a `remember` call in that window writes to a root the new
build will never look at again. Always restart the new build first, then
migrate.
