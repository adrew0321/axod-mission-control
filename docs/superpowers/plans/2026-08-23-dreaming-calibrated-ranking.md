# Dreaming Calibrated Ranking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the nightly Dreaming pass emit fewer, ranked insights, calibrated on the operator's own starred and dismissed history instead of the model's taste.

**Architecture:** One extra input to the pass and one extra field on its output. A pure formatter turns triaged insights into a prompt block; the prompt gains that block, a lower cap, and a `rank` requirement; the parser accepts `rank` with an array-position fallback; a nullable column stores it; `getDreams()` sorts by it. No new service, no second model call, no schedule change.

**Tech Stack:** TypeScript, Next.js 16, Drizzle + SQLite (better-sqlite3), `node:test` via `tsx`, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-08-23-dreaming-calibrated-ranking-design.md`

## Global Constraints

- **The model treats the cap as a target.** The current prompt already says "Quality over quantity: 0 to 6 insights" and produced ~250 insights across 49 dreams — the ceiling, essentially every time. Lowering the number is necessary but is **not** what makes this work; the calibration examples are. Do not "simplify" this slice down to just changing the number.
- **D4 — a missing or malformed `rank` must never discard an insight.** Fall back to array position. This machinery already lost a third of its history to an auth outage; it must not also lose output to a format miss.
- **D5 — the 230 untriaged insights are left alone.** No backfill, no bulk dismiss, no ranking pass over the backlog. The column is nullable precisely so they can stay as they are.
- **Migration must be a pure additive `ALTER TABLE ... ADD COLUMN`.** This repo's `pnpm db:migrate` fails on migrations that recreate a table (drizzle emits `CREATE __new_x → INSERT → DROP x → RENAME`, and FK enforcement inside the transaction trips it). Do not restructure it into anything that drops or renames.
- Tests are `node:test` via `tsx`. Use **extensionless imports** — a `.ts` extension breaks `tsc` and the Next build.
- **When adding tests to an existing test file, MERGE new names into that file's existing import from the same module.** Do not add a second import statement from a module the file already imports.
- `pnpm exec tsc --noEmit` must be clean before any commit.
- Never branch-switch this repo — it is the live app dir. Work in an isolated worktree off `dev`.
- Never push to `main`. Feature branch → `dev`.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## Known repo hazards

- **Two tests flake intermittently and are NOT regressions:** `mini-agent/src/shell-ops.test.ts` and `src/lib/shutdown.test.ts` (both timing/process-sensitive). Re-run either alone before calling anything a failure.
- **Do not run the full suite for every task** — it takes ~90 seconds. Run the covering file(s) plus `tsc`. One full run before the branch is finished is enough.

---

## File Structure

**Created:**
- `drizzle/0016_dream_insight_rank.sql` — additive `ALTER TABLE`
- `src/lib/dream-calibration.ts` — pure prompt-block formatter
- `src/lib/dream-calibration.test.ts`

**Modified:**
- `src/db/schema.ts` — `dream_insights.rank`
- `drizzle/meta/_journal.json` — migration entry
- `src/lib/dream-insights.ts` — `rank` on `Insight`, parsed with fallback
- `src/lib/dream-insights.test.ts` — rank tests
- `src/lib/dreams-data.ts` — `readTriagedInsights`, `InsightView.rank`, sort in `getDreams`
- `src/lib/dream.ts` — prompt (calibration block, cap, rank requirement) and the insert

---

### Task 1: The `rank` column

**Files:**
- Modify: `src/db/schema.ts` (the `dream_insights` table)
- Create: `drizzle/0016_dream_insight_rank.sql`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `dream_insights.rank`, nullable integer.

Nullable is load-bearing: the 230 existing rows have no rank and D5 leaves them alone.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, inside `dream_insights`, after `status`:

```ts
  // 1 = most useful. Nullable: the insights that predate calibrated ranking
  // keep NULL and are left alone (spec D5), and a malformed rank from the model
  // never discards an insight (spec D4) — the parser falls back to array order.
  rank: integer('rank'),
```

`sqliteTable`, `text`, and `integer` are already imported at the top of that file — no import edit needed.

- [ ] **Step 2: Write the migration**

Create `drizzle/0016_dream_insight_rank.sql`:

```sql
ALTER TABLE `dream_insights` ADD `rank` integer;
```

That is the whole file. Do **not** add a `CREATE TABLE`/`INSERT`/`DROP`/`RENAME` sequence — see Global Constraints.

- [ ] **Step 3: Record it in the journal**

Append to the `entries` array in `drizzle/meta/_journal.json`, matching the shape of the `0015_agent_actions` entry immediately above it and keeping the file's existing two-space indentation:

```json
    {
      "idx": 16,
      "version": "6",
      "when": 1787100000000,
      "tag": "0016_dream_insight_rank",
      "breakpoints": true
    }
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

Then check the migration applies to a scratch copy — never the real database:
```bash
cp data/mission-control.db /tmp/d-check.db 2>/dev/null || sqlite3 /tmp/d-check.db "CREATE TABLE dream_insights (id text PRIMARY KEY NOT NULL, dream_id text NOT NULL, category text NOT NULL, title text NOT NULL, detail text NOT NULL, status text NOT NULL, created_at integer NOT NULL);"
sqlite3 /tmp/d-check.db < drizzle/0016_dream_insight_rank.sql && sqlite3 /tmp/d-check.db "pragma table_info(dream_insights);"
```
Expected: the column list ends with a `rank` row of type `integer`, nullable (notnull = 0), and no error.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/0016_dream_insight_rank.sql drizzle/meta/_journal.json
git commit -m "feat(db): rank column on dream_insights

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The parser accepts `rank`, and never drops an insight over it

**Files:**
- Modify: `src/lib/dream-insights.ts`
- Modify: `src/lib/dream-insights.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Insight` gains `rank: number` (always populated — never null on the parsed type; the DB column is nullable only for pre-existing rows).

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/dream-insights.test.ts`. It already has `import { parseInsights } from "./dream-insights";` at line 3 — **merge** any new name into that statement rather than adding a second import.

```ts
test("a valid rank is kept", () => {
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "T", detail: "D", rank: 2 },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].rank, 2);
});

test("a missing rank falls back to array position, 1-based", () => {
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D" },
    { category: "praise", title: "B", detail: "D" },
  ]));
  assert.deepEqual(out.map((i) => i.rank), [1, 2]);
});

test("a malformed rank falls back rather than dropping the insight", () => {
  // The whole point of the fallback (spec D4): a format miss must not lose
  // output from a pass that has already lost a third of its history to an outage.
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D", rank: "first" },
    { category: "risk", title: "B", detail: "D", rank: 0 },
    { category: "risk", title: "C", detail: "D", rank: -3 },
    { category: "risk", title: "E", detail: "D", rank: 1.5 },
  ]));
  assert.equal(out.length, 4, "no insight is dropped for a bad rank");
  assert.deepEqual(out.map((i) => i.rank), [1, 2, 3, 4]);
});

test("fallback positions count parsed insights, not raw array indexes", () => {
  // The middle item is invalid for a reason that DOES drop it (bad category),
  // so the survivors must be ranked 1 and 2 — not 1 and 3.
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D" },
    { category: "nonsense", title: "B", detail: "D" },
    { category: "praise", title: "C", detail: "D" },
  ]));
  assert.deepEqual(out.map((i) => i.title), ["A", "C"]);
  assert.deepEqual(out.map((i) => i.rank), [1, 2]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/dream-insights.test.ts`
Expected: FAIL — `rank` is not a property of `Insight`, so the assertions read `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/dream-insights.ts`, extend the interface:

```ts
export interface Insight {
  category: InsightCategory;
  title: string;
  detail: string;
  /** 1 = most useful. Always populated: a missing or malformed rank from the
   *  model falls back to the insight's position among the parsed results
   *  (spec D4) rather than discarding it. */
  rank: number;
}
```

Then in `parseInsights`, destructure `rank` alongside the others and push with the fallback:

```ts
    const { category, title, detail, rank } = item as Record<string, unknown>;
    if (typeof category !== "string" || !CATEGORIES.has(category as InsightCategory)) continue;
    if (typeof title !== "string" || !title.trim()) continue;
    if (typeof detail !== "string" || !detail.trim()) continue;
    // Position among the insights we are KEEPING, so a dropped item does not
    // leave a gap in the ranking.
    const fallback = out.length + 1;
    const usable = typeof rank === "number" && Number.isInteger(rank) && rank > 0;
    out.push({
      category: category as InsightCategory,
      title: title.trim(),
      detail: detail.trim(),
      rank: usable ? rank : fallback,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/dream-insights.test.ts && pnpm exec tsc --noEmit`
Expected: PASS and a clean typecheck. Every pre-existing test in that file must still pass — they do not assert on `rank`, so they should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dream-insights.ts src/lib/dream-insights.test.ts
git commit -m "feat(dreaming): parse insight rank, falling back to position

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The calibration formatter

**Files:**
- Create: `src/lib/dream-calibration.ts`
- Create: `src/lib/dream-calibration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TriagedInsight { category: string; title: string; detail: string }
  export const MAX_EXAMPLES_PER_SIDE = 10;
  export function formatTriageExamples(starred: TriagedInsight[], dismissed: TriagedInsight[]): string
  ```

This is the part that actually changes behaviour. The model has never been told what this operator values — only how many items to emit.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/dream-calibration.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTriageExamples, MAX_EXAMPLES_PER_SIDE, type TriagedInsight } from './dream-calibration';

const ins = (title: string): TriagedInsight => ({ category: 'risk', title, detail: `detail for ${title}` });

test('both lists empty yields an empty string', () => {
  // A fresh database must produce a prompt identical to today's, not a
  // malformed section with empty headings.
  assert.equal(formatTriageExamples([], []), '');
});

test('starred and dismissed both appear, labelled distinctly', () => {
  const out = formatTriageExamples([ins('kept-one')], [ins('binned-one')]);
  assert.match(out, /kept-one/);
  assert.match(out, /binned-one/);
  // The two groups must be distinguishable, or the examples teach nothing.
  const keptAt = out.indexOf('kept-one');
  const binnedAt = out.indexOf('binned-one');
  assert.notEqual(keptAt, binnedAt);
  assert.ok(keptAt >= 0 && binnedAt >= 0);
});

test('only one side present still produces a usable block', () => {
  const starredOnly = formatTriageExamples([ins('kept-one')], []);
  assert.match(starredOnly, /kept-one/);
  const dismissedOnly = formatTriageExamples([], [ins('binned-one')]);
  assert.match(dismissedOnly, /binned-one/);
});

test('each side is capped so the block cannot grow without bound', () => {
  const many = Array.from({ length: MAX_EXAMPLES_PER_SIDE + 5 }, (_, i) => ins(`s${i}`));
  const out = formatTriageExamples(many, many);
  // Every example is emitted as its own `- [category] title — detail` line, so
  // counting those lines counts examples exactly.
  const exampleLines = out.split('\n').filter((l) => l.startsWith('- ['));
  assert.equal(
    exampleLines.length,
    MAX_EXAMPLES_PER_SIDE * 2,
    'both sides capped: 10 starred + 10 dismissed, not 15 + 15',
  );
  // The last item WITHIN the cap is present and the first item PAST it is not,
  // so an off-by-one in either direction fails.
  assert.ok(out.includes(`s${MAX_EXAMPLES_PER_SIDE - 1} `), 'the 10th item is kept');
  assert.ok(!out.includes(`s${MAX_EXAMPLES_PER_SIDE} `), 'the 11th item is excluded');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec tsx --test src/lib/dream-calibration.test.ts`
Expected: FAIL — `Cannot find module './dream-calibration'`.

- [ ] **Step 3: Implement**

Create `src/lib/dream-calibration.ts`:

```ts
// Turns the operator's own triage history into a prompt block, so the Curator
// ranks against what he actually keeps rather than its own taste (spec D2).
//
// Pure — no db, no server-only — so it unit-tests. The caller supplies the rows.
//
// Measured before this was written: he had starred 6 insights and dismissed 14,
// out of ~250. The signal is thin but it is the only ground truth there is, and
// it compounds every time he triages.

export interface TriagedInsight {
  category: string;
  title: string;
  detail: string;
}

/** Per side. Without a cap this block grows as triage history accumulates and
 *  would eventually crowd out the transcript it exists to inform. */
export const MAX_EXAMPLES_PER_SIDE = 10;

function bullet(i: TriagedInsight): string {
  return `- [${i.category}] ${i.title} — ${i.detail}`;
}

/**
 * Empty in, empty out: a fresh database must yield the prompt as it was before
 * this feature, not a section with two empty headings.
 */
export function formatTriageExamples(
  starred: TriagedInsight[],
  dismissed: TriagedInsight[],
): string {
  const kept = starred.slice(0, MAX_EXAMPLES_PER_SIDE);
  const binned = dismissed.slice(0, MAX_EXAMPLES_PER_SIDE);
  if (kept.length === 0 && binned.length === 0) return '';

  const parts: string[] = [
    'WHAT THIS OPERATOR ACTUALLY VALUES',
    '',
    'These are his real judgements on past insights. Rank by this, not by your own sense of what is interesting.',
  ];
  if (kept.length > 0) {
    parts.push('', 'He KEPT these (starred):', ...kept.map(bullet));
  }
  if (binned.length > 0) {
    parts.push('', 'He THREW AWAY these (dismissed):', ...binned.map(bullet));
  }
  return parts.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/dream-calibration.test.ts && pnpm exec tsc --noEmit`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dream-calibration.ts src/lib/dream-calibration.test.ts
git commit -m "feat(dreaming): format the operator's triage history for the prompt

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Read triaged insights, and order by rank

**Files:**
- Modify: `src/lib/dreams-data.ts`

**Interfaces:**
- Consumes: `TriagedInsight` (Task 3) — structurally; do not import it here if that would create a cycle, the shape is `{ category, title, detail }`.
- Produces:
  ```ts
  export async function readTriagedInsights(limit = 10): Promise<{ starred: TriagedInsight[]; dismissed: TriagedInsight[] }>
  ```
  and `InsightView` gains `rank: number | null`.

`getDreams()` currently selects `dream_insights` with **no `orderBy` at all**, so insights already display in whatever order SQLite returns. There is no ordering to change here — there is ordering to introduce.

- [ ] **Step 1: Add the read**

In `src/lib/dreams-data.ts`, add `eq` and `asc` to the existing `drizzle-orm` import (it currently imports `desc, inArray` — **merge**, do not add a second import statement), and add:

```ts
import type { TriagedInsight } from '@/lib/dream-calibration';

/** The operator's own triage signal, newest first, for calibrating the Curator.
 *  Starred and dismissed are read separately so the prompt can label them. */
export async function readTriagedInsights(
  limit = 10,
): Promise<{ starred: TriagedInsight[]; dismissed: TriagedInsight[] }> {
  const pick = async (status: 'starred' | 'dismissed'): Promise<TriagedInsight[]> => {
    const rows = await db
      .select({ category: dream_insights.category, title: dream_insights.title, detail: dream_insights.detail })
      .from(dream_insights)
      .where(eq(dream_insights.status, status))
      .orderBy(desc(dream_insights.created_at))
      .limit(limit);
    return rows.map((r) => ({ category: r.category, title: r.title, detail: r.detail }));
  };
  return { starred: await pick('starred'), dismissed: await pick('dismissed') };
}
```

- [ ] **Step 2: Expose and sort by rank**

Extend `InsightView`:

```ts
export interface InsightView {
  id: string;
  category: string;
  title: string;
  detail: string;
  status: string;
  /** 1 = most useful. NULL on insights that predate calibrated ranking. */
  rank: number | null;
}
```

In `getDreams()`, carry `rank` into the pushed object:

```ts
    byDream.get(i.dream_id)!.push({ id: i.id, category: i.category, title: i.title, detail: i.detail, status: i.status, rank: i.rank });
```

and sort each dream's array before returning — ranked first, unranked after, so the 230 backlog rows sit below rather than being reordered among themselves:

```ts
  for (const list of byDream.values()) {
    // Nulls last: pre-calibration insights keep their existing relative order
    // beneath the ranked ones (spec D5 leaves the backlog alone).
    list.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER));
  }
```

Place that loop after the grouping loop and before the `return dreamRows.map(...)`.

- [ ] **Step 3: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: clean. If any consumer of `InsightView` fails to compile because it constructs one without `rank`, fix that call site — the field is required on the view type.

This file is `server-only` and cannot be imported by `tsx --test`, so it ships no unit tests; that is expected and consistent with its neighbours. Its behaviour is covered by the pure pieces either side of it and verified on the Mini.

- [ ] **Step 4: Commit**

```bash
git add src/lib/dreams-data.ts
git commit -m "feat(dreaming): read triaged insights and order by rank

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the prompt and persist the rank

**Files:**
- Modify: `src/lib/dream.ts`

**Interfaces:**
- Consumes: `formatTriageExamples` (Task 3), `readTriagedInsights` (Task 4), `Insight.rank` (Task 2), `dream_insights.rank` (Task 1).
- Produces: the running behaviour. No new exports.

- [ ] **Step 1: Change the prompt**

In `src/lib/dream.ts`, in `CURATOR_SYSTEM_PROMPT`:

Replace `Quality over quantity: 0 to 6 insights.` with:

```
Quality over quantity: 0 to 3 insights, and fewer is a good answer.
```

Replace the JSON element line with one that carries the rank:

```
{ "category": "pattern" | "risk" | "suggestion" | "praise", "title": "<one concise line>", "detail": "<1-3 sentences>", "rank": <1 = most useful> }
```

And add, immediately before the `No prose outside the array.` line:

```
Rank what you emit: 1 is the single most useful thing here. In the rank-1 insight's detail, say in one clause why it outranks the others.
```

Mind the backticks — this is a template literal and the existing `\`\`\`json` is already escaped. Do not break the escaping.

- [ ] **Step 2: Inject the calibration block**

Add the imports (merge into existing statements from the same modules where applicable):

```ts
import { formatTriageExamples } from '@/lib/dream-calibration';
import { readTriagedInsights } from '@/lib/dreams-data';
```

In `runDream`, after the transcript `context` is built and truncated to `MAX_CONTEXT_CHARS`, and before the agent call, prepend the calibration block:

```ts
    // The operator's own triage history. Prepended rather than appended so a
    // long transcript cannot push it out of the model's attention, and read
    // best-effort: a failure here must degrade to today's behaviour, not lose
    // the night's dream.
    const triage = await readTriagedInsights(10).catch(() => ({ starred: [], dismissed: [] }));
    const calibration = formatTriageExamples(triage.starred, triage.dismissed);
    if (calibration) context = `${calibration}\n\n---\n\n${context}`;
```

`context` must be declared with `let` for this to compile; it already is (the truncation step reassigns it).

- [ ] **Step 3: Persist the rank**

In the insert loop, add the field:

```ts
      await db.insert(dream_insights).values({
        id: `insight_${bytesToHex(randomBytes(4))}`,
        dream_id: id,
        category: ins.category,
        title: ins.title,
        detail: ins.detail,
        status: 'new',
        rank: ins.rank,
        created_at: new Date(),
      });
```

- [ ] **Step 4: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

Then run the full suite once — this is the last code task, and it touches the module the other four feed:

Run: `pnpm test`
Expected: 0 fail. The 9 skips are expected Windows capability skips. Baseline pass count is whatever `dev` had plus the tests added in Tasks 2 and 3; report the actual numbers rather than reasoning about them.

The pass itself is not unit-testable — it calls a model and writes the database, exactly like its siblings. Do **not** build a mock agent harness to manufacture coverage; it is verified on the Mini after the next nightly run.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dream.ts
git commit -m "feat(dreaming): calibrate the Curator on real triage and rank its output

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Rollout

Follow `ship-mc-feature` for the release. Deploy specifics:

1. `git pull --ff-only origin main && pnpm build` as `mc`. **Skip `pnpm install`** — this slice adds no dependencies, and letting pnpm purge `node_modules` would wipe the hand-compiled `better-sqlite3` binding.
2. **Run the migration:** `sudo -u mc bash -lc "cd /srv/mission-control && set -a; . ./.env; set +a; pnpm db:migrate"`. `0016` is a pure additive `ALTER TABLE`, so the table-rebuild hazard does not apply.
3. `sudo systemctl restart mission-control`.
4. **No reseed.** This changes no agent row in the database — the Curator prompt is a module constant, not a seeded `system_prompt`.
5. Verify: `/api/health` shows the new version and `db:ok`; `systemctl --failed` is clean.
6. **Verify the behaviour after the next nightly run (hour 3).** The newest dream should have **at most 3** insights, each with a non-null `rank`, and the rank-1 insight's detail should say why it outranks the others:
   ```bash
   sudo -u mc sqlite3 /srv/mission-control/data/mission-control.db \
     "select rank, category, title from dream_insights where dream_id = (select id from dreams order by created_at desc limit 1) order by rank;"
   ```
   If ranks come back NULL, the model omitted them and the parser's fallback filled in — which is the designed degradation, not a failure, but worth noting since it means the prompt change did not land.

**The 230 existing insights keep `rank = NULL` and are left alone** (spec D5). They will sort below ranked items in the Dreaming view.
