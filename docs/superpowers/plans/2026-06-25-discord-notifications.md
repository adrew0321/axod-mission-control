# Discord Phase 2 — Proactive Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-process poller that posts Discord embeds when a scheduled task finishes, a new dream lands, or a proposal becomes ready to merge — routed to the bound channel(s).

**Architecture:** Pure diff helpers (`discord-notify-diff.ts`) and pure embed builders (extend `discord-format.ts`) carry all logic and are unit-tested. A thin effectful loop (`discord-notify.ts`, started in `instrumentation.ts`) polls three sources every ~30s, diffs against in-memory cursors, and posts via the shared discord.js client. Startup priming means the first tick records state and posts nothing.

**Tech Stack:** TypeScript, discord.js v14, Drizzle + better-sqlite3, `node:test` via `tsx`.

## Global Constraints

- Tests use `node:test` + `node:assert/strict` via `pnpm test` (`tsx --test src/lib/*.test.ts`); local imports WITHOUT file extensions.
- The test runner CANNOT load `server-only` modules (`db/client`, anything importing it) — so `discord-notify.ts`, `discord-bindings.ts`, `discord-bot.ts` are NOT unit-tested; they are verified by `tsc --noEmit` + the full suite + runtime. Only PURE modules get unit tests.
- `discord-notify-diff.ts` and the embed builders in `discord-format.ts` MUST stay pure (no `server-only`, no DB, no live discord.js client). They may `import type` from discord.js (erased at runtime).
- Cursors are IN-MEMORY only (no persistence). First tick primes (posts nothing).
- Poll interval ~30s. Loop wrapped in try/catch; failures log `[discord-notify] …` and never throw into the server.
- Embed colors: `ok` → green `0x10B981`; `fail`/`error` → red `0xEF4444`; other/unknown → amber `0xF59E0B`; dream/proposal → blue `0x3B82F6`.
- Implementation runs in an isolated git worktree off `dev` (the repo is the live app dir — never branch-switch it).

---

### Task 1: Pure diff helpers (`discord-notify-diff.ts`)

**Files:**
- Create: `src/lib/discord-notify-diff.ts`
- Test: `src/lib/discord-notify-diff.test.ts`

**Interfaces:**
- Produces:
  - `type ScheduleRunRow = { id: string; projectId: string; title: string; lastRunAtMs: number | null; lastStatus: string | null }`
  - `type DreamRowLite = { id: string; createdAtMs: number; status: string; insightCount: number }`
  - `diffScheduleRuns(prev: Map<string, number>, rows: ScheduleRunRow[]): { newRuns: ScheduleRunRow[]; next: Map<string, number> }`
  - `pickNewDreams(lastSeenMs: number | null, rows: DreamRowLite[]): { newDreams: DreamRowLite[]; next: number | null }`
  - `diffProposals(prev: Set<string>, curr: Set<string>): { newIds: string[]; next: Set<string> }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/discord-notify-diff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScheduleRuns, pickNewDreams, diffProposals } from './discord-notify-diff';

const sched = (id: string, lastRunAtMs: number | null, lastStatus: string | null = 'ok') =>
  ({ id, projectId: 'p', title: 't', lastRunAtMs, lastStatus });

test('diffScheduleRuns: advanced last_run_at is new; unchanged is not', () => {
  const prev = new Map([['a', 100]]);
  const { newRuns, next } = diffScheduleRuns(prev, [sched('a', 200), sched('b', 50)]);
  assert.deepEqual(newRuns.map((r) => r.id).sort(), ['a', 'b']); // a advanced, b is brand new
  assert.equal(next.get('a'), 200);
  assert.equal(next.get('b'), 50);

  const second = diffScheduleRuns(next, [sched('a', 200), sched('b', 50)]);
  assert.deepEqual(second.newRuns, []); // nothing advanced
});

test('diffScheduleRuns: null last_run_at (never ran) is never new and not in next', () => {
  const { newRuns, next } = diffScheduleRuns(new Map(), [sched('a', null)]);
  assert.deepEqual(newRuns, []);
  assert.equal(next.has('a'), false);
});

test('pickNewDreams: new since cursor; none when stale', () => {
  const rows = [
    { id: 'd2', createdAtMs: 200, status: 'ok', insightCount: 3 },
    { id: 'd1', createdAtMs: 100, status: 'ok', insightCount: 1 },
  ];
  const a = pickNewDreams(150, rows);
  assert.deepEqual(a.newDreams.map((d) => d.id), ['d2']);
  assert.equal(a.next, 200);

  const b = pickNewDreams(200, rows);
  assert.deepEqual(b.newDreams, []);
  assert.equal(b.next, 200);
});

test('pickNewDreams: null cursor treats all as new (loop discards on prime)', () => {
  const rows = [{ id: 'd1', createdAtMs: 100, status: 'ok', insightCount: 0 }];
  const r = pickNewDreams(null, rows);
  assert.deepEqual(r.newDreams.map((d) => d.id), ['d1']);
  assert.equal(r.next, 100);
});

test('diffProposals: new id fires; merged-then-reappearing re-fires', () => {
  const a = diffProposals(new Set(), new Set(['s1']));
  assert.deepEqual(a.newIds, ['s1']);
  assert.deepEqual([...a.next], ['s1']);

  const b = diffProposals(new Set(['s1']), new Set(['s1'])); // still present, not new
  assert.deepEqual(b.newIds, []);

  const c = diffProposals(new Set(['s1']), new Set()); // merged/discarded — gone
  assert.deepEqual(c.newIds, []);
  assert.deepEqual([...c.next], []);

  const d = diffProposals(new Set(), new Set(['s1'])); // reappears → fires again
  assert.deepEqual(d.newIds, ['s1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/discord-notify-diff.test.ts`
Expected: FAIL — cannot find module `./discord-notify-diff`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/discord-notify-diff.ts`:

```ts
// Pure diff helpers for Discord notifications. No DB, no server-only, no live
// discord.js client — unit-testable under `tsx --test`. Each takes the prior
// cursor + current rows and returns BOTH the new items and the next cursor.
// Priming (ignoring the first tick's "new" items) is the loop's job, not these.

export type ScheduleRunRow = {
  id: string;
  projectId: string;
  title: string;
  lastRunAtMs: number | null;
  lastStatus: string | null;
};

export type DreamRowLite = {
  id: string;
  createdAtMs: number;
  status: string;
  insightCount: number;
};

/** A schedule whose last_run_at advanced past the cursor (or first-seen) is "new". */
export function diffScheduleRuns(
  prev: Map<string, number>,
  rows: ScheduleRunRow[],
): { newRuns: ScheduleRunRow[]; next: Map<string, number> } {
  const next = new Map<string, number>();
  const newRuns: ScheduleRunRow[] = [];
  for (const r of rows) {
    if (r.lastRunAtMs == null) continue; // never ran → ignore, keep out of cursor
    next.set(r.id, r.lastRunAtMs);
    const before = prev.get(r.id);
    if (before === undefined || before < r.lastRunAtMs) newRuns.push(r);
  }
  return { newRuns, next };
}

/** Dreams created strictly after the cursor are new. next = newest createdAtMs seen. */
export function pickNewDreams(
  lastSeenMs: number | null,
  rows: DreamRowLite[],
): { newDreams: DreamRowLite[]; next: number | null } {
  const newDreams = rows.filter((d) => lastSeenMs == null || d.createdAtMs > lastSeenMs);
  const maxMs = rows.reduce((m, d) => Math.max(m, d.createdAtMs), lastSeenMs ?? -Infinity);
  const next = maxMs === -Infinity ? lastSeenMs : maxMs;
  return { newDreams, next };
}

/** Proposals (by sessionId) present now but not before are new. next = current set. */
export function diffProposals(
  prev: Set<string>,
  curr: Set<string>,
): { newIds: string[]; next: Set<string> } {
  const newIds = [...curr].filter((id) => !prev.has(id));
  return { newIds, next: new Set(curr) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/discord-notify-diff.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-notify-diff.ts src/lib/discord-notify-diff.test.ts
git commit -m "feat(discord): pure diff helpers for notification cursors"
```

---

### Task 2: Pure embed builders (extend `discord-format.ts`)

**Files:**
- Modify: `src/lib/discord-format.ts` (add `scheduleEmbed`, `dreamEmbed`, `proposalEmbed`)
- Modify: `src/lib/discord-format.test.ts` (add embed tests)

**Interfaces:**
- Consumes: `ScheduleRunRow`, `DreamRowLite` (Task 1); `Proposal` (from `./proposals`).
- Produces (all return `APIEmbed` from discord.js, type-only import):
  - `scheduleEmbed(run: ScheduleRunRow): APIEmbed`
  - `dreamEmbed(dream: DreamRowLite): APIEmbed`
  - `proposalEmbed(p: Proposal): APIEmbed`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/discord-format.test.ts`:

```ts
import { scheduleEmbed, dreamEmbed, proposalEmbed } from './discord-format';

const run = (lastStatus: string | null) => ({
  id: 's', projectId: 'p', title: 'Nightly health check', lastRunAtMs: 1, lastStatus,
});

test('scheduleEmbed: color reflects status', () => {
  assert.equal(scheduleEmbed(run('ok')).color, 0x10b981);
  assert.equal(scheduleEmbed(run('fail')).color, 0xef4444);
  assert.equal(scheduleEmbed(run('error')).color, 0xef4444);
  assert.equal(scheduleEmbed(run(null)).color, 0xf59e0b);
  assert.match(String(scheduleEmbed(run('ok')).title), /Nightly health check/);
});

test('dreamEmbed: blue, shows status + insight count', () => {
  const e = dreamEmbed({ id: 'd', createdAtMs: 1, status: 'ok', insightCount: 3 });
  assert.equal(e.color, 0x3b82f6);
  assert.match(String(e.description), /3/);
});

test('proposalEmbed: blue, shows project + change counts + file count', () => {
  const e = proposalEmbed({
    sessionId: 's', sessionTitle: 'Add widget', projectId: 'p', projectName: 'AXOD MC',
    branch: 'mc/s', baseBranch: 'dev',
    files: [{ status: 'M', path: 'a.ts' }, { status: 'A', path: 'b.ts' }],
    additions: 10, deletions: 2, ts: '2026-06-25T00:00:00Z',
  });
  assert.equal(e.color, 0x3b82f6);
  const blob = JSON.stringify(e);
  assert.match(blob, /AXOD MC/);
  assert.match(blob, /\+10/);
  assert.match(blob, /-2/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: FAIL — `scheduleEmbed` etc. not exported.

- [ ] **Step 3: Write the implementation**

Add to the top of `src/lib/discord-format.ts`:

```ts
import type { APIEmbed } from 'discord.js'; // type-only: erased at runtime, keeps this module pure
import type { ScheduleRunRow, DreamRowLite } from './discord-notify-diff';
import type { Proposal } from './proposals';

const GREEN = 0x10b981;
const RED = 0xef4444;
const AMBER = 0xf59e0b;
const BLUE = 0x3b82f6;
```

Append these builders to `src/lib/discord-format.ts`:

```ts
/** Embed for a finished scheduled task; color reflects last_status. Pure. */
export function scheduleEmbed(run: ScheduleRunRow): APIEmbed {
  const status = run.lastStatus ?? 'unknown';
  const color = status === 'ok' ? GREEN : status === 'fail' || status === 'error' ? RED : AMBER;
  return {
    title: `Scheduled task: ${run.title}`,
    description: `Status: **${status}**`,
    color,
  };
}

/** Embed for a new dream. Pure. */
export function dreamEmbed(dream: DreamRowLite): APIEmbed {
  return {
    title: 'New dream',
    description: `${dream.status} · ${dream.insightCount} insight${dream.insightCount === 1 ? '' : 's'}`,
    color: BLUE,
  };
}

/** Embed for a proposal ready to merge. Pure. */
export function proposalEmbed(p: Proposal): APIEmbed {
  return {
    title: `Proposal ready: ${p.sessionTitle}`,
    color: BLUE,
    fields: [
      { name: 'Project', value: p.projectName, inline: true },
      { name: 'Changes', value: `+${p.additions} / -${p.deletions}`, inline: true },
      { name: 'Files', value: String(p.files.length), inline: true },
    ],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: PASS (existing chunkReply tests + the 3 new embed tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-format.ts src/lib/discord-format.test.ts
git commit -m "feat(discord): pure embed builders for notifications"
```

---

### Task 3: Effectful loop + client/channel wiring (`discord-notify.ts`)

No new unit test: this touches `server-only` (DB) and the live discord.js client, which the `tsx --test` runner cannot load. Logic lives in the Task 1/2 pure helpers. Verification: `tsc --noEmit` + full suite green, plus runtime check.

**Files:**
- Modify: `src/lib/discord-bot.ts` (expose `getReadyClient`)
- Modify: `src/lib/discord-bindings.ts` (add `getChannelsForProject`)
- Create: `src/lib/discord-notify.ts` (`startDiscordNotify` + poll loop)
- Modify: `src/instrumentation.ts` (call `startDiscordNotify`)

**Interfaces:**
- Consumes: `diffScheduleRuns`, `pickNewDreams`, `diffProposals`, `ScheduleRunRow`, `DreamRowLite` (Task 1); `scheduleEmbed`, `dreamEmbed`, `proposalEmbed` (Task 2); `getProposals` (`./proposals-data`); `getDreams` (`./dreams-data`).
- Produces: `getReadyClient(): Client | null`; `getChannelsForProject(projectId: string): Promise<string[]>`; `startDiscordNotify(): void`.

- [ ] **Step 1: Expose the ready client from `discord-bot.ts`**

In `src/lib/discord-bot.ts`, add a module-scoped ref and getter (near the top, after imports):

```ts
let readyClient: Client | null = null;
export function getReadyClient(): Client | null {
  return readyClient;
}
```

In the existing `client.once(Events.ClientReady, async (c) => { … })` handler, set it as the first line of the callback body:

```ts
  client.once(Events.ClientReady, async (c) => {
    readyClient = c;
    console.log(`[discord] logged in as ${c.user.tag}`);
    // …existing command-registration code unchanged…
  });
```

- [ ] **Step 2: Add `getChannelsForProject` to `discord-bindings.ts`**

In `src/lib/discord-bindings.ts`, add:

```ts
/** All channel ids bound to a project (reverse of getBinding). A project may bind several. */
export async function getChannelsForProject(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ channel_id: discord_bindings.channel_id })
    .from(discord_bindings)
    .where(eq(discord_bindings.project_id, projectId));
  return rows.map((r) => r.channel_id);
}
```

(`eq`, `db`, `discord_bindings` are already imported in that file.)

- [ ] **Step 3: Create the poll loop `src/lib/discord-notify.ts`**

```ts
import 'server-only';
import { db } from '@/db/client';
import { schedules } from '@/db/schema';
import type { Client } from 'discord.js';
import { getReadyClient } from './discord-bot';
import { getChannelsForProject } from './discord-bindings';
import { getProposals } from './proposals-data';
import { getDreams } from './dreams-data';
import {
  diffScheduleRuns,
  pickNewDreams,
  diffProposals,
  type ScheduleRunRow,
  type DreamRowLite,
} from './discord-notify-diff';
import { scheduleEmbed, dreamEmbed, proposalEmbed } from './discord-format';
import type { APIEmbed } from 'discord.js';

const POLL_MS = 30_000;
// Dreams are global (not project-scoped) → route to the operator's "home" project channel.
const DREAM_PROJECT_ID = 'mission-control';

let scheduleCursor = new Map<string, number>();
let dreamCursor: number | null = null;
let proposalCursor = new Set<string>();
let primed = false;

/** Send an embed to every channel bound to a project. Returns false on send failure
 *  (so the caller can leave the cursor unadvanced and retry). No bound channel → true
 *  (nothing to do; don't retry forever). */
async function postToProject(client: Client, projectId: string, embed: APIEmbed): Promise<boolean> {
  try {
    const channelIds = await getChannelsForProject(projectId);
    for (const id of channelIds) {
      const ch = await client.channels.fetch(id);
      if (ch && 'send' in ch && typeof ch.send === 'function') {
        await ch.send({ embeds: [embed] });
      }
    }
    return true;
  } catch (err) {
    console.error('[discord-notify] post failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

async function tick(): Promise<void> {
  const client = getReadyClient();
  if (!client) return; // gateway not connected yet

  // --- gather current state ---
  const schedRows: ScheduleRunRow[] = (
    await db
      .select({
        id: schedules.id,
        projectId: schedules.project_id,
        title: schedules.title,
        lastRunAt: schedules.last_run_at,
        lastStatus: schedules.last_status,
      })
      .from(schedules)
  ).map((s) => ({
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    lastRunAtMs: s.lastRunAt ? s.lastRunAt.getTime() : null,
    lastStatus: s.lastStatus,
  }));

  const dreamRows: DreamRowLite[] = (await getDreams()).map((d) => ({
    id: d.id,
    createdAtMs: new Date(d.createdAt).getTime(),
    status: d.status,
    insightCount: d.insights.length,
  }));

  const proposals = await getProposals();
  const currIds = new Set(proposals.map((p) => p.sessionId));

  const sched = diffScheduleRuns(scheduleCursor, schedRows);
  const dreamD = pickNewDreams(dreamCursor, dreamRows);
  const prop = diffProposals(proposalCursor, currIds);

  // --- first tick: prime cursors, post nothing ---
  if (!primed) {
    scheduleCursor = sched.next;
    dreamCursor = dreamD.next;
    proposalCursor = prop.next;
    primed = true;
    return;
  }

  // --- schedules: advance per-id on successful post ---
  for (const run of sched.newRuns) {
    if (await postToProject(client, run.projectId, scheduleEmbed(run))) {
      scheduleCursor.set(run.id, run.lastRunAtMs as number);
    }
  }

  // --- dreams: route to the home project channel ---
  for (const d of dreamD.newDreams) {
    if (await postToProject(client, DREAM_PROJECT_ID, dreamEmbed(d))) {
      dreamCursor = Math.max(dreamCursor ?? 0, d.createdAtMs);
    }
  }

  // --- proposals: add on success, then drop any that are no longer present ---
  for (const id of prop.newIds) {
    const p = proposals.find((x) => x.sessionId === id);
    if (p && (await postToProject(client, p.projectId, proposalEmbed(p)))) {
      proposalCursor.add(id);
    }
  }
  proposalCursor = new Set([...proposalCursor].filter((id) => currIds.has(id)));
}

/** Start the notification poller. Idempotent; only when the bot token is set. */
export function startDiscordNotify(): void {
  if (!process.env.DISCORD_BOT_TOKEN) return;
  const g = globalThis as unknown as { __mcDiscordNotifyStarted?: boolean };
  if (g.__mcDiscordNotifyStarted) return;
  g.__mcDiscordNotifyStarted = true;
  setInterval(() => {
    void tick().catch((err) =>
      console.error('[discord-notify] tick failed:', err instanceof Error ? err.message : err),
    );
  }, POLL_MS);
  console.log('[discord-notify] started (30s poll)');
}
```

- [ ] **Step 4: Wire it into `instrumentation.ts`**

In `src/instrumentation.ts`, after the existing `startDiscordBot()` call, add:

```ts
    const { startDiscordNotify } = await import('@/lib/discord-notify');
    startDiscordNotify();
```

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Full suite — no regressions**

Run: `pnpm test`
Expected: all pure tests pass (Task 1 + Task 2 included); 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/lib/discord-bot.ts src/lib/discord-bindings.ts src/lib/discord-notify.ts src/instrumentation.ts
git commit -m "feat(discord): proactive notification poller (schedules, dreams, proposals)"
```

---

## Self-Review

**Spec coverage:**
- Three triggers (scheduled finished / new dream / proposal ready) → Task 1 diffs + Task 2 embeds + Task 3 loop. ✓
- Sources: `schedules` table, `getDreams`, `getProposals` → Task 3 gather. ✓
- Cursors in-memory (Map / number / Set) → Task 1 types + Task 3 module state. ✓
- Channel routing via `getChannelsForProject` (reverse of getBinding) → Task 3 Step 2. ✓
- Dreams → mission-control channel → Task 3 `DREAM_PROJECT_ID`. ✓
- Client sharing via `getReadyClient` (null until connected) → Task 3 Step 1. ✓
- Startup priming (first tick records, posts nothing) → Task 3 `primed` flag. ✓
- Advance cursor only on successful post (retry) → Task 3 per-item advance + `postToProject` boolean. ✓
- Proposal churn re-notifies → `diffProposals` test + loop intersect with `currIds`. ✓
- ~30s poll; try/catch; `DISCORD_BOT_TOKEN` gate; idempotent guard → Task 3 `startDiscordNotify`. ✓
- Embed colors (ok green / fail+error red / else amber / dream+proposal blue) → Task 2 + tested. ✓
- Pure helpers unit-tested; effectful loop verified by tsc + suite + runtime → Tasks 1/2 tests, Task 3 steps 5-6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — full code and exact commands throughout. ✓

**Type consistency:** `ScheduleRunRow`/`DreamRowLite` defined in Task 1 and imported by Tasks 2-3; `Proposal` from `./proposals` matches its definition (sessionTitle, projectName, additions, deletions, files[]); `DreamView.createdAt` is an ISO string (converted via `new Date().getTime()`); `schedules.last_run_at` is a `Date | null` (timestamp mode) → `.getTime()`. Embed builders return `APIEmbed`; `postToProject` sends `{ embeds: [embed] }`. Signatures match across tasks. ✓
