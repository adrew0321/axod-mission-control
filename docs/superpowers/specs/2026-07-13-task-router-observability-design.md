# Task Router + Fleet Health — Design

**Date:** 2026-07-13
**Status:** Approved brainstorm (design doc). No implementation yet.
**Depends on:** server-side turn runner (`docs/superpowers/specs/2026-07-08-turn-decoupling-design.md`) — hard blocker for Phase 3 only. Phases 1 & 2 do not need it.
**Related backlog:** `docs/superpowers/plans/2026-06-07-nav-sections-backlog.md` (this spec becomes the basis for a new item there — that entry will be logged separately).

## Goal

Give the operator a live view of fleet health and, progressively, an intelligent router
that proposes which session and which specialist should handle incoming work. These two
concerns are complements, not alternatives: routing without observability is un-tunable
(you build the dashboard anyway just to debug it), and observability without routing has
independent value (the aging-proposal detector alone pays for Phase 1).

Two routing problems exist at different layers — AKIRA-level (which project/session gets
the work) and Sage-level (which specialist runs it) — and they need different data. Both
are in scope, but in different phases. The Sage-level router is where the real
specialization signal lives.

## Non-goals

- Autonomous dispatch in v1/Phase 1–2. The router proposes; the operator confirms. The
  same trust model as `relay` today.
- Surviving a server restart mid-task (that's the turn-runner's concern).
- Editing agent prompts or skills based on routing signal (out of scope for this spec).
- Multi-tenant / cross-operator routing.

## Hard constraints

- `runSessionTurn`'s signature and `sessions.running_since` lease behavior are
  untouched. The dispatcher never dispatches a turn for a session whose `running_since`
  is set.
- Classifier and scorer live in modules without `server-only` (mirrors the
  `tool-actions.ts` split) so they run under `tsx --test`.
- Every router decision returns `{ decision, alternatives, rationale, confidence }` and
  is persisted. If the operator can't audit why Atlas ran instead of Nova, the learning
  system will drift silently.
- If the router errors, produces low confidence, or is disabled by a project flag, fall
  through to the existing "operator picks" path. Never a hard blocker.
- Extensionless relative imports; `node:` prefix for node stdlib; no `server-only` in
  pure modules.

## Scope (v1 — Phases 1 & 2)

**In scope:**
- Four new tables: `task_classifications`, `routing_decisions`, `routed_tasks`,
  `bottleneck_events` (only `task_classifications` and `routing_decisions` are needed
  for Phases 1 & 2; the queue tables ship in Phase 3).
- Rule-based content classifier (`kw-v1`), LLM classifier (`llm-haiku-v1`), and hybrid
  mode — all behind `ROUTER_ENABLED=true`.
- Historical-performance scorer with Bayesian smoothing (Phase 2).
- Seven bottleneck detectors running in the dispatcher tick.
- **Fleet Health** nav section (under `operational`, next to Proposals) with three
  panes: Blockers, Router decisions, Fleet metrics.
- AKIRA relay v2 (optional `sessionId`; router picks when omitted) — Phase 2.
- Sage `dispatch_agent` gains optional `agent_id` path (router picks when omitted) —
  Phase 2.
- Discord + AKIRA integration for critical bottleneck events.

**Out of scope (YAGNI — note for later):**
- Priority queue and autonomous dispatcher tick (Phase 3 — needs turn-decoupling).
- DAG dependency resolution and parallel fan-out (Phase 4).
- Hybrid classifier and multi-session fan-out from a single relay call (Phase 4).
- Per-agent skill files; this spec uses the existing `agents` table + dispatch history.

## Decisions (locked)

1. **Observability ships first** inside the bundle. Never ship a router without its
   dashboard.
2. **Router proposes, operator confirms.** Same trust model as `relay` today. Autonomous
   dispatch (Phase 3) requires a per-project opt-in flag, default off.
3. **Two-layer architecture.** AKIRA relay-router picks `{projectId, sessionId}`;
   Sage dispatch-router picks `agent_id`. They share the classifier and scorer but
   solve different problems with different data.
4. **Explainability is non-negotiable.** `rationale` field on every `routing_decisions`
   row; rendered in the Fleet Health UI. If the UI can't show why a decision was made,
   the learning signal is lost.
5. **Fallback is always available.** A feature flag (`ROUTER_ENABLED`), a per-project
   opt-out, and a confidence floor all gate the router. Operator override is always one
   click.
6. **Cold start handled by category priors.** Until each `(agent, category)` pair has
   ≥ 5 samples, fall back to `category_affinity` alone (static hand-tuned priors).
7. **Rework rate needs Echo verdict extension.** Echo's output schema must land a
   machine-readable `PASS | CONCERNS | FAIL` verdict on `messages` before the
   learning scorer can use it. That extension is a Phase 2 prerequisite.
8. **Global concurrency cap = 3, per-project cap = 2.** Preserved from the existing
   `running_since` lease model.

## Architecture

```
Operator request (relay or dispatch)
        │
        ▼
┌───────────────────────────────────────────────────┐
│           Content Classifier                       │
│  kw-v1 (keyword rules) → category + confidence   │
│  llm-haiku-v1 (one Haiku call, structured output) │
│  hybrid-v1 (kw first; LLM if confidence < 0.7)   │
└─────────────────────┬─────────────────────────────┘
                      │ TaskCategory + confidence
         ┌────────────┴──────────────┐
         │                           │
         ▼                           ▼
┌─────────────────┐         ┌──────────────────────┐
│  Layer 1 Router │         │  Layer 2 Router       │
│  (AKIRA-level)  │         │  (Sage-level)         │
│  picks          │         │  picks agent_id       │
│  {projectId,    │         │  from historical-     │
│   sessionId}    │         │  performance scorer   │
└────────┬────────┘         └──────────┬───────────┘
         │ relay_proposal               │ dispatch_proposal
         │ {target, rationale,          │ {agent_id, rationale,
         │  alternatives}               │  alternatives, confidence}
         └─────────────────┬────────────┘
                           ▼
                  Operator confirms
                  (optionally overrides)
                           │
                  routing_decisions row logged
                           │
                           ▼
              turn runs → outcome persisted
                           │
                  routing_decisions.outcome updated
```

Both layers share: the content classifier and the historical-performance scorer.
The fleet health detectors run in the same dispatcher tick (cheap SQL) and emit
`bottleneck_events` rows consumed by the Fleet Health view and Discord/AKIRA.

## Data model

No existing schema changes for Phase 1's core telemetry — `messages.dispatched_via`,
`cost_usd`, `token_count_in`, `token_count_out`, join to `approvals.decided_at` and
`artifacts`, and `sessions.running_since` already cover the historical-performance
signal. The four new tables below are additive.

### `task_classifications`

| field | type | notes |
|---|---|---|
| `id` | text PK | `cls_<hex>` |
| `source_type` | text | notNull: `relay` \| `dispatch` |
| `source_ref` | text | nullable; e.g. approval or message id |
| `session_id` | text → sessions | nullable |
| `instruction` | text | notNull; the raw instruction text |
| `category` | text | notNull: `research` \| `implement` \| `review` \| `design` \| `devops` |
| `confidence` | real | notNull; 0–1 |
| `classifier_version` | text | notNull: `kw-v1` \| `llm-haiku-v1` \| `hybrid-v1` |
| `created_at` | integer (timestamp) | notNull |

`classifier_version` is the A/B and rollback handle: swap the classifier, keep the
history, compare accuracy retrospectively.

### `routing_decisions`

| field | type | notes |
|---|---|---|
| `id` | text PK | `rd_<hex>` |
| `classification_id` | text → task_classifications | notNull |
| `layer` | text | notNull: `akira` \| `sage` |
| `chosen_agent_id` | text | nullable; null for layer=akira when only session is chosen |
| `chosen_session_id` | text | nullable |
| `alternatives` | text (JSON) | notNull; `{agentId, score}[]` |
| `rationale` | text | notNull |
| `score` | real | nullable; null until history exists |
| `operator_override` | integer (boolean) | notNull default false |
| `outcome` | text | nullable: `success` \| `failure` \| `skipped` |
| `outcome_at` | integer (timestamp) | nullable |
| `created_at` | integer (timestamp) | notNull |

### `routed_tasks` (Phase 3)

| field | type | notes |
|---|---|---|
| `id` | text PK | `rtask_<hex>` |
| `project_id` | text → projects | notNull |
| `target_session_id` | text → sessions | notNull |
| `instruction` | text | notNull |
| `tier` | text | notNull: `urgent` \| `scheduled` \| `backlog` |
| `priority` | integer | notNull; lower = higher priority within tier |
| `source_type` | text | notNull: `relay` \| `schedule` \| `dream` \| `router_followup` |
| `source_ref` | text | nullable |
| `depends_on` | text (JSON) | notNull default `[]`; `string[]` of routed_task ids |
| `status` | text | notNull: `pending` \| `running` \| `completed` \| `failed` |
| `attempts` | integer | notNull default 0 |
| `last_error` | text | nullable |
| `enqueued_at` | integer (timestamp) | notNull |
| `started_at` | integer (timestamp) | nullable |
| `finished_at` | integer (timestamp) | nullable |

### `bottleneck_events`

| field | type | notes |
|---|---|---|
| `id` | text PK | `be_<hex>` |
| `kind` | text | notNull; detector name (see Detectors) |
| `project_id` | text → projects | nullable |
| `session_id` | text → sessions | nullable |
| `detail` | text (JSON) | notNull; detector-specific payload |
| `severity` | text | notNull: `warn` \| `critical` |
| `status` | text | notNull: `open` \| `resolved` |
| `opened_at` | integer (timestamp) | notNull |
| `resolved_at` | integer (timestamp) | nullable |

## Components

### `src/lib/routing/classify.ts` — pure, unit-tested

No DB, no `server-only`.

```ts
export type TaskCategory = 'research' | 'implement' | 'review' | 'design' | 'devops';
export type ClassifierVersion = 'kw-v1' | 'llm-haiku-v1' | 'hybrid-v1';

export interface Classification {
  category: TaskCategory;
  confidence: number;
  classifierVersion: ClassifierVersion;
  keywords: string[];
}

/** Rule-based: ~30 keyword rules → category. 60–70 % accuracy expected. */
export function classifyKeyword(instruction: string): Classification;
```

Three classifier versions:

1. **`kw-v1`** — keyword rules. Research/investigate/audit/study → `research`;
   implement/build/fix/refactor → `implement`; review/verdict/critique → `review`;
   design/mockup/UI/component → `design`; deploy/build/CI/lint/test → `devops`.
   Cheap, deterministic, ~60–70 % accuracy.
2. **`llm-haiku-v1`** — one `claude-haiku-4-5-20251001` call, structured output
   `{ category, specialist_hint, confidence, keywords[] }`. ~$0.0001 / call, 85–90 %
   accuracy.
3. **`hybrid-v1`** — run `kw-v1` first; if `confidence < 0.7`, call the LLM. Best
   cost / accuracy tradeoff and the recommended default for Phase 2+.

### `src/lib/routing/score.ts` — pure, unit-tested

No DB, no `server-only`.

```ts
export interface AgentHistory {
  agentId: string;
  completionRate: number;   // sampled from messages/approvals join
  normalizedCost: number;   // relative to fleet avg for this category
  normalizedLatency: number;
  reworkRate: number;       // Echo FAIL / total verdicts for this agent+category
  sampleCount: number;
}

export interface RouterDecision {
  decision: { agentId: string; sessionId?: string };
  alternatives: { agentId: string; score: number }[];
  rationale: string;
  confidence: number;
}

/**
 * score(a, c) = 0.4 * completionRate(a,c)
 *             + 0.2 * (1 - normalizedCost(a,c))
 *             + 0.2 * (1 - normalizedLatency(a,c))
 *             + 0.1 * (1 - reworkRate(a,c))
 *             + 0.1 * categoryAffinity(a,c)
 *
 * Bayesian smoothing: Beta(2,2) prior on completionRate prevents cold-start
 * overconfidence. Cold start: if sampleCount < 5, score reduces to categoryAffinity
 * alone (static hand-tuned prior; nova=1.0 for research, atlas=0.2 for research, etc.)
 */
export function scoreAgents(
  category: TaskCategory,
  history: AgentHistory[],
): RouterDecision;
```

**Data source for `AgentHistory`** — a join on `messages`, `approvals`, `artifacts`,
and `task_classifications` (once Phase 1 classifies historical turns retroactively):

```sql
-- Per (agent_id, category): completion_rate, avg cost_usd, avg latency
SELECT
  m.agent_id,
  tc.category,
  COUNT(*) AS turns,
  AVG(CASE WHEN ap.status = 'approved' THEN 1.0 ELSE 0.0 END) AS completion_rate,
  AVG(m.cost_usd) AS avg_cost,
  AVG(CAST((m.created_at - s.updated_at) AS REAL) / 60) AS avg_latency_min
FROM messages m
JOIN sessions s ON m.session_id = s.id
LEFT JOIN approvals ap ON ap.session_id = m.session_id
LEFT JOIN task_classifications tc ON tc.session_id = m.session_id
WHERE m.role = 'agent'
  AND m.dispatched_via IS NOT NULL
GROUP BY m.agent_id, tc.category;
```

`rework_rate` requires the Echo verdict extension (Phase 2 prerequisite): Echo's
output schema gains a machine-readable `verdict: 'PASS' | 'CONCERNS' | 'FAIL'` field
persisted on the specialist's `messages` row. Until that lands, `rework_rate` defaults
to `0`.

### `src/lib/routing/detectors.ts` — pure, unit-tested

Seven detectors, each a pure function emitting `BottleneckEvent[]`. No DB, no
`server-only` — the server-side collector calls them with pre-fetched data.

```ts
export type BottleneckKind =
  | 'proposal_aging'
  | 'turn_failure_cluster'
  | 'blocker_repeat'
  | 'cost_spike'
  | 'schedule_failing'
  | 'idle_session'
  | 'router_drift';

export interface BottleneckEvent {
  kind: BottleneckKind;
  projectId?: string;
  sessionId?: string;
  detail: Record<string, unknown>;
  severity: 'warn' | 'critical';
}
```

Detector logic:

| Detector | Trigger | Severity |
|---|---|---|
| `proposal_aging` | pending `approvals` row age > 4 h | warn |
| `proposal_aging` | pending `approvals` row age > 24 h | critical |
| `turn_failure_cluster` | ≥ 3 error messages in same session within 1 h | critical |
| `blocker_repeat` | Echo FAIL verdict ≥ 2 on the same session | critical |
| `cost_spike` | project daily `cost_usd` > 2× its 7-day average | warn |
| `schedule_failing` | `schedules.last_status = 'fail'` ≥ 3 consecutive | critical |
| `idle_session` | no turns in 7 days, not archived | warn |
| `router_drift` | rolling 3-day: `operator_override / total > 30 %` | warn |

`schedule_failing` uses `schedules.last_status` (confirmed in `src/db/schema.ts`).
`proposal_aging` uses `approvals.decided_at IS NULL` to identify pending rows.

### `src/lib/routing/router.ts` — server-only

Orchestrates classify → score → persist → emit. Calls the pure modules above plus the
DB. Returns a `RouterDecision` for the caller (relay confirm route or dispatch handler)
to surface to the operator.

### AKIRA relay v2 — `src/lib/akira/tool-actions.ts`

Current `relayHandler` requires `sessionId` (enforced by the `if (!args.sessionId …)`
guard at line 49).[^relay-required] v2 relaxes it:

```ts
// relay v2: sessionId is optional — router picks when omitted
export async function relayHandler(
  args: {
    projectId: string;
    sessionId?: string;
    instruction: string;
    hint?: string;
    tier?: 'urgent' | 'scheduled' | 'backlog';
  },
  ctx: AkiraToolContext,
): Promise<ToolResult>;
```

When `sessionId` is omitted and `ROUTER_ENABLED=true`, the handler classifies
`instruction`, scores sessions in the project, and emits:

```ts
ctx.emit({
  type: 'relay_proposal',
  projectId: args.projectId,
  sessionId: chosenSessionId,       // router's pick
  instruction: args.instruction,
  routerDecision: { rationale, alternatives, confidence },
});
```

When `sessionId` is supplied, the existing `relay_proposal` path runs unchanged.

[^relay-required]: Correction from source design: `relayHandler` currently requires
`sessionId` — the function returns an error if it is absent. The v2 change described
here makes it optional. The source design implied it was already optional.

### Sage `dispatch_agent` v2 — `src/lib/dispatch.ts`

Current `agent_id` is `z.enum(DISPATCHABLE)` (required). Phase 2 makes it optional:
when omitted and `ROUTER_ENABLED=true`, the router picks based on the classified
`task` content. System prompt update: "omit `agent_id` and let the router pick unless
you have a specific reason to name a specialist."

### Fleet Health view — `src/app/(views)/fleet-health/`

New nav section `Fleet Health` under `operational`, next to Proposals. Flip the nav
entry in `src/lib/nav-sections.ts` from `soon` → `live`.

Server data via a new contributor added to `CONTRIBUTORS` in
`src/lib/fleet-contributors.ts` (which already exports `getFleetSnapshotLive`):

```ts
// fleet-contributors.ts (extend the existing CONTRIBUTORS array)
const bottlenecksContributor: SnapshotContributor = {
  key: 'bottlenecks',
  collect: async () => {
    // fetch open bottleneck_events rows; return { bottlenecks: [...] }
  },
};
```

Three UI panes:

1. **Blockers** — open `bottleneck_events` grouped by severity. Critical first;
   resolved events collapsible. Each card shows `kind`, `detail`, age, and a "Resolve"
   action (sets `resolved_at`).
2. **Router decisions** — recent `routing_decisions` rows with `chosen_agent_id`,
   `rationale`, `confidence`, `alternatives`, and whether the operator overrode. This
   is the feedback loop that keeps the router honest.
3. **Fleet metrics** — per-project cost trend (sparkline from `messages.cost_usd`),
   throughput (turns / day from `messages.created_at`), proposal-latency histogram
   (time from `approvals` created to `decided_at`). All derived from existing columns.

### Discord + AKIRA integration

Critical `bottleneck_events` → Discord notification via the existing notification
pipeline. AKIRA's fleet snapshot prompt gains a compact `## BOTTLENECKS` block below
the existing fleet snapshot, populated from open critical events.

## Implementation phases

### Phase 1 — Observability + rule-based router in shadow mode (~10 days, M)

- Drizzle migration: `task_classifications`, `routing_decisions`, `bottleneck_events`.
- `src/lib/routing/classify.ts` (`kw-v1`) + unit tests.
- `src/lib/routing/detectors.ts` (all seven detectors) + unit tests.
- Metrics rollup (server-side collector runs detectors, persists `bottleneck_events`).
- Fleet Health nav section + three-pane view (Blockers, Router decisions stub, Fleet
  metrics).
- `ROUTER_ENABLED=true` flag: Sage `dispatch_agent` classifies + logs to
  `routing_decisions` but does **not** change which agent is picked (shadow mode).
- AKIRA relay unchanged.
- Discord integration for critical events.

**Success criteria:** operator sees aging proposals and turn-failure clusters in Fleet
Health. `routing_decisions` accumulates shadow log. No operator action required.

### Phase 2 — Learning + AKIRA integration (~7 days, M)

**Prerequisite:** Echo verdict schema extension (machine-readable `PASS|CONCERNS|FAIL`
on `messages`).

- `src/lib/routing/score.ts` + unit tests, wired to `AgentHistory` DB query.
- `router_drift` detector active (needs `operator_override` data from Phase 1).
- AKIRA relay v2 (`sessionId` optional; router picks + operator confirms via existing
  confirm endpoint).
- `dispatch_agent` v2 (`agent_id` optional; router picks).
- LLM classifier (`llm-haiku-v1`) added as fallback; `hybrid-v1` enabled.
- Router decisions pane goes live in Fleet Health.

**Success criteria:** operator override rate drops below 20 % over two weeks (measured
via `routing_decisions.operator_override`).

### Phase 3 — Priority queue + parallel execution (~10 days, L)

**Hard prerequisite:** server-side turn runner
(`docs/superpowers/specs/2026-07-08-turn-decoupling-design.md`).

- Drizzle migration: `routed_tasks`.
- Dispatcher tick (every 5 s via boot ticker): promote critical `bottleneck_events` →
  `urgent`; materialize due `schedules` → `scheduled`; while `running < global_cap`,
  pick highest-priority runnable task (deps satisfied, target session not running);
  claim (`status='running'`); call `runSessionTurn`; mark `completed|failed`; cascade.
- Session concurrency contract: never dispatch if `sessions.running_since` is set.
  Add stale-lease reclaim before enabling autonomous dispatch.
- DAG via `depends_on` (cycle detection at enqueue).
- Task Board integration (backlog tier).
- Per-project autonomous dispatch opt-in flag, default off.

**Success criteria:** operator queues five tasks and walks away; they complete in
dependency order.

### Phase 4 — Advanced routing (~5 days, M)

- `hybrid-v1` classifier as default.
- Multi-session fan-out: a single `relay` call with multiple `instruction` items fans
  out across sessions (e.g., "have Nova research X and Atlas prototype Y in parallel").
- `parallel_group_id` on `routed_tasks` for reporting.

**Success criteria:** one relay call produces two simultaneous specialist turns in
separate sessions with results surfaced together.

**Total:** XL, ~4–5 weeks focused work.

## Dependencies

| Dependency | Phase | Type |
|---|---|---|
| Server-side turn runner (`2026-07-08-turn-decoupling-design.md`) | Phase 3 | Hard |
| Echo verdict schema extension (machine-readable PASS/CONCERNS/FAIL) | Phase 2 | Hard |
| Discord notifications (already shipped) | Phase 1 | Reused |
| Dreaming / dream insights (backlog tier input) | Phase 3 | Soft |
| `schedules.last_status` column (already in schema) | Phase 1 | Already exists |

## Risks

**Cold-start bad decisions.** The scorer has no history when the router first runs.
Mitigation: static `category_affinity` priors (e.g., nova=1.0 for research,
atlas=0.2 for research) prevent pathological first picks. Shadow mode in Phase 1
means no real decisions are made until the log has depth.

**Learning drift toward most-used agent.** If Atlas always runs, the scorer's
completion-rate data skews toward Atlas regardless of task fit. Mitigation: Bayesian
Beta(2, 2) prior on `completionRate`, plus category priors, plus the `router_drift`
detector (fires when override rate drops too low, signaling the router is being trusted
without being accurate).

**Queue-runner concurrency bugs.** The `running_since` lease is the safety net for
Phase 3. A bug that double-dispatches could produce concurrent turns on the same
session. Mitigation: stale-lease reclaim with explicit TTL; load test with Forge before
enabling autonomous dispatch; per-project opt-in default off.

**Explainability decay.** If the `rationale` field is populated lazily or truncated,
the Fleet Health "Router decisions" pane becomes useless and drift goes undetected.
Mitigation: `rationale` is non-nullable in the schema; the scorer must always produce
a human-readable string. Failing to do so is a classifier bug, not a UI bug.

**Trust boundary re-emergence.** Phase 3 autonomous dispatch crosses a line similar to
the Local Bridge — the system acts without explicit per-action operator confirmation.
Mitigation: per-project consent flag (`autonomous_dispatch_enabled`, default false);
Phase 3 never ships without this gate; document it as a deliberate operator decision.

## Recommendation on bundling

Bundle, but observability ships first inside the bundle.

- Routing without observability is un-tunable. You will build the dashboard anyway just
  to debug the router's decisions.
- Observability without routing has immediate standalone value. The aging-proposal
  detector alone is worth Phase 1 regardless of whether routing ever ships.
- Never ship a router without its dashboard. If Phase 2 slips, the Phase 1 dashboard
  still stands on its own.

## Open questions

1. **AKIRA-level routing in v1 or Phase 2?** Currently proposed Phase 2. The argument
   for v1 is that AKIRA already proposes sessions; the counter-argument is that Phase 1
   shadow data is needed to validate the session-score model.
2. **Operator tolerance for classifier LLM cost?** Trivial at Haiku prices (~$0.0001 /
   call), but confirm before enabling `llm-haiku-v1` in production.
3. **`routed_tasks` per-project or global?** Proposed: per-project rows, global cap
   enforced at dispatch time (cap = 3 running across all projects, 2 per project).
4. **Task Board as backlog front-door, or a dedicated Queue view?** Proposed: Task
   Board integration (existing `tasks` table gains a routing path), no separate view.

## Success criteria (summary)

| Phase | Measurable outcome |
|---|---|
| 1 | Aging proposals and turn-failure clusters appear in Fleet Health within 15 min of occurring. Shadow routing log accumulates. |
| 2 | Operator override rate < 20 % over a rolling 2-week window. `router_drift` detector stays quiet. |
| 3 | 5-task DAG queue completes unattended in dependency order. No double-dispatch events. |
| 4 | Single `relay` call fans out to two simultaneous specialist sessions and surfaces combined results. |
