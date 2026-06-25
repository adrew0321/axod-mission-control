# Discord Phase 2 — proactive notifications (design)

**Date:** 2026-06-25
**Status:** Design approved, pending spec review
**Builds on:** Discord bot Phase 1 (chat) — [2026-06-22-discord-bot-design.md](2026-06-22-discord-bot-design.md)

## Why

Phase 1 shipped two-way chat (the "80% win"). The original Discord design scoped two further
steps that were never built: **notifications** (step 2) and **actions** (step 3). This spec
covers **notifications only** — proactive embeds so the operator learns about background events
without opening the web UI. Action buttons (Approve & Merge / Discard) remain a future Phase 3;
notification embeds are their prerequisite.

## Scope

Three proactive triggers post an embed to the relevant bound Discord channel:

1. **Scheduled task finished** — a schedule's run completed (highlights the nightly
   health-check, esp. a `fail`).
2. **New dream / insight** — the nightly Dreaming pass produced a new dream.
3. **Proposal ready to merge** — a session's worktree diverged from its base branch.

Explicitly NOT a trigger: per-agent-turn-completed (too noisy; the operator is often already in
the chat). No notification on/off config UI (YAGNI; the three are hardcoded).

## Architecture

Mirrors the existing in-process tickers (`startScheduler` / `startDreaming` / `startDiscordBot`).

### File layout

```
src/lib/
  discord-notify.ts        # NEW (effectful): startDiscordNotify() poll loop + cursors + posting
  discord-notify-diff.ts   # NEW (pure, unit-tested): diff polled state vs cursor → new items + next cursor
  discord-format.ts        # extend (pure, unit-tested): scheduleEmbed / dreamEmbed / proposalEmbed
  discord-bot.ts           # extend: module-scoped client ref + getReadyClient(): Client | null
  discord-bindings.ts      # extend: getChannelsForProject(projectId): Promise<string[]>
src/instrumentation.ts     # + startDiscordNotify() alongside the other starters
```

Pure helpers carry all decision logic and are unit-tested. `discord-notify.ts` is thin
orchestration, proven by runtime verification (consistent with how Phase 1's effectful modules
were validated).

### Client sharing

`discord-bot.ts` keeps its `client` in a module-scoped ref set on `ClientReady`, and exports
`getReadyClient(): Client | null` (null until the gateway connects). The notify loop null-checks
each tick and skips until the client is ready, so startup order between `startDiscordBot` and
`startDiscordNotify` does not matter.

### Loop

`startDiscordNotify()` runs inside `register()` only when `DISCORD_BOT_TOKEN` is set (same gate
as the bot), idempotent via a `globalThis.__mcDiscordNotifyStarted` guard. It polls every **~30s**
(not the original design's 10s: `getProposals()` diffs every session worktree, so 30s keeps that
cost modest while staying responsive for nightly/merge-ready events). The whole loop is wrapped in
try/catch: a failure logs `[discord-notify] …` and never affects the web server or other tickers.

## Triggers, sources, routing

| Trigger | Source | Cursor (in-memory) | Posts to | Embed |
|---|---|---|---|---|
| Scheduled task finished | `schedules` rows | `Map<scheduleId, last_run_at ms>` — fires when `last_run_at` advances | channel(s) bound to `schedule.project_id` | title + `last_status`; **red** for `fail`/`error`, green for `ok`; names the schedule |
| New dream / insight | `getDreams()` ([src/lib/dreams-data.ts](../../../src/lib/dreams-data.ts)) | last seen dream `created_at` | channel(s) bound to the **`mission-control`** project (dreams are global → the "home" channel); skip if none bound | dream status + insight count |
| Proposal ready to merge | `getProposals()` ([src/lib/proposals-data.ts](../../../src/lib/proposals-data.ts)) | `Set<sessionId>` already notified | channel(s) bound to `proposal.projectId` | session title, project, `+adds/-dels`, file count |

Channel routing uses a new `getChannelsForProject(projectId): Promise<string[]>` in
`discord-bindings.ts` (the reverse of the existing `getBinding`; a project may have multiple bound
channels — post to each).

## Startup priming (no backfill spam)

On the **first** tick, the loop records current state into all three cursors and posts **nothing**.
Only changes observed *after* priming are posted. Without this, every restart would blast
notifications for all existing proposals, the latest dream, and the last schedule run. Cursors are
in-memory only (YAGNI to persist, per the original design); a restart re-primes silently.

## Dedup & failure handling

- A cursor entry advances only **after** a successful post for that item, so a transient send
  failure retries on the next tick rather than being silently dropped.
- Proposal churn is correct by construction: when a proposal is merged/discarded its `sessionId`
  leaves `getProposals()`, so it drops from the set; if that session later diverges again it
  re-notifies.

## Pure helper interfaces

```
// discord-notify-diff.ts
diffScheduleRuns(prev: Map<string, number>, rows: { id: string; lastRunAtMs: number | null; ... }[])
  : { newRuns: ScheduleRun[]; next: Map<string, number> }
pickNewDreams(lastSeenMs: number | null, rows: DreamRow[])
  : { newDreams: DreamRow[]; next: number | null }
diffProposals(prevIds: Set<string>, currIds: Set<string>)
  : { newIds: string[]; next: Set<string> }

// Each is a pure (prev, curr) -> { new items, next cursor } function. They have NO priming
// concept themselves.
```

**Priming lives entirely in the loop, not the helpers.** The loop holds a `primed` boolean. On
the first tick it calls the diff helpers, stores the returned `next` cursors, and discards the
"new" lists (posts nothing); then sets `primed = true`. Every later tick posts the new items
normally. This keeps the diff functions trivially pure and testable.

## Testing

- **Pure unit (`node:test`/tsx):**
  - `discord-notify-diff.test.ts` — `diffScheduleRuns` (advance detected; unchanged → none;
    priming → none), `pickNewDreams` (new since cursor; none when stale; priming → none),
    `diffProposals` (new sessionId fires; merged-then-reappearing re-fires; priming → none).
  - `discord-format.test.ts` (extend) — `scheduleEmbed` color mapping (`fail`/`error` red, `ok`
    green), `dreamEmbed`, `proposalEmbed` shape/fields.
- **Runtime verification** (`verify` skill) against the test guild: trigger a scheduled run →
  embed in the bound channel; create a divergent session → proposal embed; **restart → no
  re-post of existing items** (priming works); a non-mission-control project's dream target with
  no binding is skipped without error.

## Out of scope (this phase)

Action buttons (Approve & Merge / Discard) and `/mc new-session` — Phase 3. Persisting cursors
across restarts. Per-trigger config. Agent-turn-completed notifications. DM notifications.

## Follow-up note

Once shipped, the Phase 3 action buttons attach to the **proposal** embeds defined here.
