# Dreaming / Curator — Design

**Date:** 2026-06-22
**Status:** Approved (brainstorm)
**Depends on:** the server-side turn runner / SDK runner (`runClaudeAgent`, `src/lib/agent-runner-sdk.ts`); the in-process boot ticker (`src/instrumentation.ts`, added with the Scheduler).

## Goal

The Hermes "Dreaming" pillar: a background **Curator** that, on a cadence (and on
demand), reviews recent agent/operator conversations and surfaces structured
**insights** — patterns, risks, suggestions, praise — into a **Dreaming** view the
operator reads, stars, or dismisses. **Read-only reflection** in v1: the Curator
never edits prompts, skills, or code; it observes and reports.

## Scope (v1)

In scope:
- Two tables: `dreams` (one per run) + `dream_insights` (the structured findings).
- A pure insight parser (`parseInsights`) and a pure due-check (`isDreamDue`), unit-tested.
- `runDream()` — gather recent conversations → run the Curator via `runClaudeAgent`
  (no worktree) → parse insights → persist. Single-in-flight.
- A manual `POST /api/dream` trigger + a nightly auto-run in the boot ticker.
- `PATCH /api/insights/[id]` for star/dismiss.
- A **Dreaming** view (dreams feed + category-badged insight cards + "Dream now").
  Flip the nav section `dreaming` `soon` → `live`.

Out of scope (YAGNI — note for later): applying changes (editing prompts/skills/
docs), reviewing diffs/proposals/tasks, configurable cadence UI, per-insight
"act on this" actions, cross-session memory beyond the dream window, multiple
Curator personas.

## Decisions (locked in brainstorm)

1. **Curator scope:** read-only reflective journal. No self-mutation in v1.
2. **Trigger:** manual "Dream now" button **+** nightly auto-run via the boot ticker.
3. **Input:** conversations only — recent sessions + their messages since the last
   dream (capped for cost). Not diffs/proposals/tasks in v1.
4. **Output:** structured insights — each `{category, title, detail}` with
   `category ∈ {pattern, risk, suggestion, praise}`; per-insight star/dismiss.
5. **Execution path:** a lighter `runDream()` calling `runClaudeAgent` directly (no
   session/worktree per dream — a dream is a one-shot reflection, not a session turn).
6. **The Curator** is a **code-level config** (system prompt + model constant), not a
   roster agent (it's never dispatched by Sage).

## Data model

New table `dreams`:

| field | type | notes |
|---|---|---|
| `id` | text PK | `dream_<hex>` |
| `created_at` | integer (timestamp) | notNull |
| `covers_since` | integer (timestamp) | notNull; window start (previous dream's `created_at`, or now − 7d for the first) |
| `status` | text | notNull: `ok` \| `empty` \| `error` |
| `insight_count` | integer | notNull, default 0 |
| `error` | text | nullable; message when `status='error'` |

New table `dream_insights`:

| field | type | notes |
|---|---|---|
| `id` | text PK | `insight_<hex>` |
| `dream_id` | text → dreams | notNull |
| `category` | text | notNull: `pattern` \| `risk` \| `suggestion` \| `praise` |
| `title` | text | notNull; one line |
| `detail` | text | notNull |
| `status` | text | notNull: `new` \| `starred` \| `dismissed` (default `new`) |
| `created_at` | integer (timestamp) | notNull |

Drizzle migration generated + applied. No cascade concerns (insights reference a
dream that is never deleted in v1).

## Components

### `src/lib/dream-insights.ts` — pure, unit-tested
No DB, no `server-only`.

```ts
export type InsightCategory = "pattern" | "risk" | "suggestion" | "praise";
export interface Insight { category: InsightCategory; title: string; detail: string; }

/**
 * Tolerant parse of the Curator's output: extract the first JSON array (optionally
 * inside a ```json fence) of {category,title,detail} objects. Invalid/extra items
 * are dropped; unknown categories are dropped. Returns [] when nothing parses
 * (→ the dream is recorded as 'empty', never an error).
 */
export function parseInsights(text: string): Insight[];
```

### `src/lib/dream-due.ts` — pure, unit-tested
```ts
/** Nightly gate: true when now is at/after `hour` (local) AND the last dream is
 *  > 12h old (or there is none). Mirrors the scheduler's testable cadence logic. */
export function isDreamDue(lastDreamAt: Date | null, now: Date, hour: number): boolean;
```

### `src/lib/dream.ts` — server-only
- `runDream(): Promise<{ status: "ok" | "empty" | "error"; dreamId?: string; reason?: string }>`
  1. Single-in-flight guard via `globalThis.__mcDreamInProgress` → returns
     `{status:'error', reason:'already dreaming'}` if held.
  2. `covers_since` = latest dream's `created_at`, else `now − 7d`.
  3. Gather conversations: sessions touched since `covers_since` + their messages,
     formatted into a compact context (reuse `buildOrchestratorPrompt`-style
     labeling from `conversation.ts`), **capped** (e.g. last 200 messages /
     ~40k char budget) to bound token cost.
  4. If the window is empty (no messages) → insert a `dreams` row `status='empty'`,
     return early (no model call).
  5. `runClaudeAgent({ prompt: context, systemPrompt: CURATOR_SYSTEM_PROMPT,
     model: CURATOR_MODEL, allowedTools: [], workingDir: process.cwd() })`,
     collect the `done.fullText`.
  6. `parseInsights(fullText)` → insert the `dreams` row (`status='ok'` if ≥1
     insight else `'empty'`, `insight_count`) + one `dream_insights` row each.
  7. Errors anywhere → insert `dreams` row `status='error'` with the message;
     never throw out of `runDream`.
- `CURATOR_SYSTEM_PROMPT` + `CURATOR_MODEL` constants live here. The prompt: a
  reflective curator reviewing the team's recent work; instructed to return a JSON
  array of `{category,title,detail}` (categories: pattern/risk/suggestion/praise),
  to be specific and grounded in the provided activity, and to return `[]` when
  nothing is worth surfacing.

### `src/instrumentation.ts` — extend the boot hook
Alongside `startScheduler()`, add `startDreaming()`: an interval (e.g. every 15 min)
that calls `runDream()` when `isDreamDue(latestDreamAt, now, NIGHTLY_HOUR)`. Same
`globalThis` start-guard pattern; `runDream`'s own in-flight guard prevents overlap
with a manual trigger.

### `src/lib/dreams-data.ts` — server-only fetch for the view
`getDreams(): Promise<DreamView[]>` — recent dreams (cap, newest first) each with
its insights joined; Dates → ISO strings. `DreamView = { id, createdAt, coversSince,
status, insights: InsightView[] }`, `InsightView = { id, category, title, detail, status }`.

### API routes (cookie auth)
- `POST /api/dream` — manual trigger → `runDream()`; returns its result (`409` when
  already dreaming).
- `PATCH /api/insights/[id]` — body `{ status: 'new'|'starred'|'dismissed' }`.

### UI — Dreaming view
- Flip `nav-sections.ts` `dreaming` `soon` → `live`.
- Header: title + **"Dream now"** button (POST `/api/dream`, spinner, `router.refresh()`).
- **Dreams feed** (reverse-chronological): each dream a group header (timestamp ·
  "covers since…" · insight count) with its **insight cards** below.
- **Insight card:** category badge (⚡ risk / ◈ pattern / ✨ suggestion / ✓ praise,
  color-coded + left border), bold title, detail, **star** toggle + **dismiss**
  (dismissed → greyed, restorable). Star/dismiss → `PATCH /api/insights/[id]` +
  refresh.
- Empty state: "No dreams yet — click Dream now to reflect on recent work."
- Wiring mirrors the Scheduler: `getDreams()` in `page.tsx` → `initialDreams` prop →
  `DreamingView` branch in the `activeSection` switch in `mission-control.tsx`.

## Data flow (one dream)

```
"Dream now" (POST /api/dream)  ── or ──  boot ticker: isDreamDue() → runDream()
  guard (single in-flight)
  covers_since = last dream's created_at | now-7d
  gather sessions+messages since covers_since (capped)     ← conversations only
    empty? → dreams.status='empty', stop
  runClaudeAgent(Curator prompt + context, no worktree)
  parseInsights(fullText)
    → insert dreams row (ok/empty) + dream_insights rows
  Dreaming view renders dreams + insights; star/dismiss per insight
```

## Edge cases

- **Concurrency:** `globalThis.__mcDreamInProgress` — manual trigger during a run
  returns `409 "already dreaming"`; the nightly check respects the same flag.
- **First dream / window:** no prior dream → `covers_since = now − 7d`; context is
  capped (message count + char budget) so cost stays bounded regardless of backlog.
- **Empty window:** no messages since `covers_since` → `status='empty'`, no model call.
- **Parse/model/DB failure:** `parseInsights` → `[]` ⇒ `status='empty'`; a thrown
  error ⇒ `status='error'` with the message stored. `runDream` never throws.
- **Nightly + manual race:** the in-flight guard serializes them; whichever is second
  is skipped.
- **Dev double-fire / HMR:** `startDreaming` uses the same `globalThis` start-guard as
  `startScheduler`.

## Testing

- **`dream-insights.ts`** (`parseInsights`) unit tests: clean JSON array; fenced
  ```json``` block with surrounding prose; unknown category dropped; missing field
  dropped; non-JSON → `[]`.
- **`dream-due.ts`** (`isDreamDue`) unit tests: before hour → false; after hour +
  recent dream (<12h) → false; after hour + stale dream (>12h) → true; no prior
  dream + after hour → true.
- **Server-only pieces** (`dream.ts`, routes, instrumentation) verified at runtime:
  seed a couple of conversations → "Dream now" (or headless `runDream`) → a dream +
  insights persist and render; star/dismiss flips a row's `status`.
- `pnpm test` green + `pnpm build` clean before each commit.

## Isolation summary

| Unit | Does | Depends on | Tested |
|---|---|---|---|
| `dream-insights.ts` | parse Curator output → insights | nothing (pure) | unit |
| `dream-due.ts` | nightly due-gate | nothing (pure) | unit |
| `dream.ts` | gather → reflect → persist | `dream-insights`, `agent-runner-sdk`, `conversation`, db | runtime |
| `instrumentation.ts` | nightly trigger at boot | `dream.ts`, `dream-due.ts` | runtime |
| API routes | manual trigger + star/dismiss | `dream.ts`, db, auth | runtime |
| `dreams-data.ts` / Dreaming view | fetch + render + act | API routes | manual |
