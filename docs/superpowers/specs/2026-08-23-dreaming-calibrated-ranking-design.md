# Dreaming — calibrated ranking (sub-project D)

Sub-project D of the AKIRA agentic-OS program.

## Problem

The nightly Dreaming pass works. Its output is not read.

Measured on the Mini, 2026-08-23:

| Signal | Value |
|---|---|
| `dream_insights` still `new` (never triaged) | **230** |
| starred | 6 |
| dismissed | 14 |
| dreams `ok` / `empty` / `error` | 49 / 19 / 37 |
| reflections that changed the lesson set | 13 of 65 |
| reflections that proposed a SOUL change | **0** of 65 |

So the operator triages roughly 8% of what Dreaming produces. The rest accumulates.

Two things that look like problems and are not, recorded so nobody re-investigates
them:

- **The 37 dream errors and 37 reflection errors are one historical cause,** not a
  logic bug: `oauth_org_not_allowed` — "your organization has disabled Claude
  subscription access for Claude Code" — accounts for 26 of 37 and 32 of 37
  respectively, with the rest rate limits and transient API errors. The most
  recent five runs of each are green. Roughly a third of this machinery's history
  is simply missing, which matters when reading any historical average.
- **The prompt already asks for restraint.** It says "Quality over quantity: 0 to 6
  insights. If nothing is worth surfacing, return an empty array." Across 49
  successful dreams it emitted ~250 insights — at the ceiling essentially every
  time. **The model treats the cap as a target.** Lowering the number alone will
  not work; that is the central design constraint here.

## What this is not

D was originally described as "extend the nightly reflect pass to score skill and
automation outcomes." That was written before sub-project C existed and assumed
skills would be running by now. They are not: `agent_actions` holds **0** rows,
`task_classifications` holds **0**, the two vault skills only became runnable on
2026-08-23, and two of the three still need host reach — which is blocked on the
host agent not being installed.

Scoring skill outcomes is therefore deferred until `agent_actions` has real
history. The action feed shipped in C2 already records exactly what that scorer
would need, so the data will accrue on its own.

This slice addresses the half that has data today, and it is not a measurement
subsystem: the measurement above already answered the question in four queries.
It is a change to what the pass *produces*.

## Decisions

Taken during brainstorming on 2026-08-23.

**D1 — Produce less and rank, rather than deliver more.** Routing insights to
Discord was considered and rejected: the action feed from C2 now posts AKIRA's
root commands to that channel, and adding a stream of insights would drown the
safety signal D2 of the host-reach spec exists to provide.

**D2 — Rank against the operator's real triage history, not the model's taste.**
The prompt is given his actual starred and dismissed insights as labelled
examples. This is the only ground-truth signal available, and it compounds: every
triage sharpens the next night's ranking. A model asked to grade its own output
is exactly what already ignores the "quality over quantity" instruction.

**D3 — Cap drops from 0–6 to 0–3, and every emitted insight carries a rank.**
The cap alone is not expected to do the work (see the ceiling behaviour above);
the calibration examples are. The lower cap makes the ranking meaningful rather
than decorative.

**D4 — A missing or malformed `rank` must not discard the insight.** The parser
falls back to array position. This machinery has already lost a third of its
history to an outage; it must not also lose output to a format miss.

**D5 — The 230 untriaged insights are left alone.** No backfill, no bulk dismiss,
no ranking pass over the backlog. Re-presenting items the operator has already
passed over for months would mostly waste the one triage session it would buy.
New behaviour applies going forward only.

**D6 — One model call, not two.** A separate pruning pass would judge the first
pass's output with a fresh context, which is genuinely stronger, but it doubles
the nightly cost and adds a second failure point to machinery whose reliability
history is the reason this slice exists.

## Architecture

One extra input to the nightly pass, one extra field on its output. No new
service, no second model call, no change to the schedule (nightly, hour 3).

```
dream_insights (starred + dismissed)
        │
        ▼
dream-calibration.ts  ── pure, capped, unit-tested
        │  "He starred these … He dismissed these …"
        ▼
   dream.ts prompt  ──►  model  ──►  JSON with rank
        │                                │
        │                                ▼
        │                    dream-insights.ts (parser)
        │                    rank validated, else array position
        ▼                                │
   dream_insights.rank ◄─────────────────┘
        │
        ▼
   Dreaming view, sorted by rank
```

## Components

### 1. `src/lib/dream-calibration.ts` — new, pure

Turns triaged insights into a prompt block.

```ts
export interface TriagedInsight { category: string; title: string; detail: string }
export function formatTriageExamples(
  starred: TriagedInsight[],
  dismissed: TriagedInsight[],
): string
```

Returns `''` when both lists are empty, so the first run on a fresh database
behaves exactly as today rather than emitting a malformed prompt section.

**Capped at the 10 most recent of each.** Without a cap this block grows without
bound as triage history accumulates and would eventually crowd out the transcript
it is meant to inform. Ten each is a judgement, not a measurement — there are only
20 labelled examples in total today.

### 2. A read in `src/lib/dreams-data.ts`

`readTriagedInsights(limit = 10)` returning `{ starred, dismissed }`, most recent
first, `server-only` like its neighbours in that file.

### 3. `src/lib/dream.ts` — prompt and cap

- Inject the calibration block ahead of the transcript, under a heading that says
  plainly what it is: examples of what this operator found worth keeping and what
  he threw away.
- Change "0 to 6 insights" to "0 to 3".
- Require a `rank` on every emitted insight, 1 = most useful.
- Require the top-ranked insight's `detail` to say why it outranks the others.
  This is the cheapest available check on whether the ranking is considered or
  arbitrary — an unjustifiable ordering tends to produce visibly empty
  justifications.

### 4. `src/lib/dream-insights.ts` — parser

`Insight` gains `rank: number`. Validation accepts a positive integer; anything
missing, non-numeric, or out of range falls back to the item's array position
(1-based). Per D4 an insight is never dropped for a bad rank.

### 5. Schema and migration `0016`

`dream_insights.rank`, `integer`, nullable — nullable because the 230 existing
rows have no rank and D5 leaves them alone.

Pure `ALTER TABLE ... ADD COLUMN`. **Not** a table rebuild: this repo's
`pnpm db:migrate` fails on migrations that recreate a table (drizzle emits
`CREATE __new_x → INSERT → DROP x → RENAME`, and FK enforcement inside the
transaction trips it). An additive nullable column is safe.

### 6. Ordering, in `getDreams()` — not in the view

`getDreams()` currently selects `dream_insights` with **no `orderBy` at all** and
groups the rows per dream, so insights are already displayed in whatever order
SQLite happens to return. There is no ordering to change — there is ordering to
introduce.

- `InsightView` gains `rank: number | null`.
- `getDreams()` selects the column and sorts each dream's array by rank
  ascending, **nulls last**, so ranked items lead and the 230 unranked backlog
  rows sit below, undisturbed per D5.

The sort belongs here rather than in the page component: `getDreams()` is the
seam every consumer already goes through, and the Discord `dreamEmbed` path
reads from the same shape.

## Testing

Following the repo convention — `node:test` via `tsx`, extensionless imports:

- **Pure and unit-testable:** `formatTriageExamples` (both lists empty → empty
  string; capping at 10; both lists present); the parser's rank handling —
  valid rank kept, missing rank → array position, malformed rank → array
  position, and an insight is **never** dropped for a rank problem.
- **Not unit-testable, verify on the Mini:** the pass itself, as with its
  siblings. Watch one night's run and confirm it emits at most 3, that they carry
  ranks, and that the top item's detail actually justifies its position.

## Rollout

1. Merge, release, deploy per `ship-mc-feature`.
2. **Run the migration** — `0016` is additive and safe, unlike the table-rebuild
   case documented above.
3. Restart. **No reseed** — this changes no agent prompt in the database; the
   Dreaming prompt is a module constant.
4. Verify after the next nightly run (hour 3): the newest dream has ≤3 insights,
   each with a rank, and the Dreaming view orders them correctly.

## Known weakness, stated rather than hidden

The ranking rests on **20 labelled examples** — 6 starred, 14 dismissed. That is
thin. If those six stars skew toward one category, the ranking inherits the skew,
and it will be months of triage before there is enough signal to notice. This is
accepted because it is the only ground truth available and it compounds with use,
but it is a real limitation and not a solved problem. If the operator's triage
rate stays near 8%, the calibration set will grow slowly enough that this slice's
effect may be hard to distinguish from noise for some time.

## Open questions

- Should a dream that produces **zero** insights be reported differently from one
  that errored? Today both leave the operator with nothing, and `empty` (19
  occurrences) is indistinguishable from `error` (37) at a glance in the view.
  Out of scope here; worth a follow-up.
- Does the reflector deserve the same treatment? It changed the lesson set in 13
  of 65 runs and has never proposed a SOUL change. That may be correct restraint
  or may be the same unread-output problem in a different shape — it needs its own
  measurement before anyone designs for it.
