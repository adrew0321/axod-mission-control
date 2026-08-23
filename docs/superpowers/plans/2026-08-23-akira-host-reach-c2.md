# AKIRA Host Reach — Slice C2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AKIRA's actions reach the operator when he is away from the HUD — an `agent_actions` table fed by the existing action log, and a Discord contributor that posts each completed action.

**Architecture:** `action-log.ts` stays pure and file-based (it is unit-tested and must not become `server-only`); it gains a pluggable sink list. A new `server-only` module registers a sink that also inserts a row into `agent_actions`. `discord-notify.ts`'s existing 30s tick gains a fifth contributor that diffs that table on a cursor, exactly like schedules, dreams, proposals, and room drops already do.

**Tech Stack:** TypeScript, Next.js 16, Drizzle + SQLite (better-sqlite3), discord.js, `node:test` via `tsx`.

**Spec:** `docs/superpowers/specs/2026-08-22-akira-host-reach-design.md`

## Global Constraints

- **D7 is a security property, not a preference.** The Discord embed carries target, command, cwd, exit code and status — **never command output.** AKIRA can `cat .env`; an embed with stdout would ship `SESSION_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`, `COMPANION_TOKEN` and `AKIRA_MEMORY_PIN` to a third party. There is a test whose only job is to fail if anyone adds an output field later. Do not weaken it.
- **D2:** the operator gets awareness, not a veto. The feed is the control. A dropped or delayed post is a real defect, not cosmetic.
- **`src/lib/akira/action-log.ts` must NOT become `server-only`.** It is unit-tested by `pnpm test`, and `server-only` throws on import outside the react-server resolve condition. This is why the DB write goes through a sink rather than a direct import.
- **Logging must never break a turn.** Every sink call is best-effort and wrapped; a failing sink logs and returns.
- Tests are `node:test` via `tsx`. Use **extensionless imports** — a `.ts` extension breaks `tsc` and the Next build.
- `pnpm exec tsc --noEmit` must be clean before any commit.
- Never branch-switch this repo — it is the live app dir. Work in an isolated worktree off `dev`.
- Never push to `main`. Feature branch → `dev`.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

## Known repo hazards

- **Two tests flake intermittently and are NOT regressions:** `mini-agent/src/shell-ops.test.ts` and `src/lib/shutdown.test.ts` (both timing/process-sensitive). Re-run either alone before calling anything a failure.
- **Migration runner:** `pnpm db:migrate` fails on migrations that *recreate* a table (drizzle emits `CREATE __new_x → INSERT → DROP x → RENAME`, and FK enforcement inside the transaction trips it). **This slice's migration is a pure `CREATE TABLE`, so it is safe** — do not restructure it into anything that drops or renames.

---

## File Structure

**Created:**
- `drizzle/0015_agent_actions.sql` — pure `CREATE TABLE`
- `src/lib/akira/action-feed.ts` — `server-only`; the DB sink and the read query
- `src/lib/akira/action-feed-diff.ts` — pure cursor diff; unit-tested
- `src/lib/akira/action-feed-diff.test.ts`

**Modified:**
- `src/db/schema.ts` — the `agent_actions` table
- `drizzle/meta/_journal.json` — the migration entry
- `src/lib/akira/action-log.ts` — pluggable sinks
- `src/lib/akira/action-log.test.ts` — sink tests
- `src/lib/discord-format.ts` — `actionEmbed`
- `src/lib/discord-format.test.ts` — the D7 no-output test
- `src/lib/discord-notify.ts` — the fifth contributor
- `src/instrumentation.ts` — register the sink at boot

---

### Task 1: The `agent_actions` table

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0015_agent_actions.sql`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `agent_actions` with columns `id` (text PK), `at` (integer timestamp), `target` (text), `event` (text), `command` (text), `cwd` (text nullable), `exit_code` (integer nullable), `status` (text nullable), `reason` (text nullable).

Note there is deliberately **no output/stdout column**. The action log has never stored command output, and D7 depends on that staying true.

- [ ] **Step 1: Add the table to the schema**

Append to `src/db/schema.ts`, following the style of `dreams` above it:

```ts
// One row per AKIRA action that reached a terminal state. Fed by action-log.ts's
// sink (see action-feed.ts) and read by the Discord poller.
//
// There is NO output column, and there must never be one: spec D7 keeps command
// output out of the feed because she can read .env, and Discord is a third party.
export const agent_actions = sqliteTable('agent_actions', {
  id: text('id').primaryKey(),
  at: integer('at', { mode: 'timestamp' }).notNull(),
  target: text('target').notNull(), // 'laptop' | 'room' | 'host'
  event: text('event').notNull(), // 'result' | 'intent' | 'denied'
  command: text('command').notNull(),
  cwd: text('cwd'),
  exit_code: integer('exit_code'),
  status: text('status'),
  reason: text('reason'),
});
```

- [ ] **Step 2: Write the migration**

Create `drizzle/0015_agent_actions.sql`, matching the tab-indented style of `drizzle/0014_room_proposals.sql`:

```sql
CREATE TABLE `agent_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`target` text NOT NULL,
	`event` text NOT NULL,
	`command` text NOT NULL,
	`cwd` text,
	`exit_code` integer,
	`status` text,
	`reason` text
);
```

- [ ] **Step 3: Record it in the journal**

Append an entry to the `entries` array in `drizzle/meta/_journal.json`, matching the shape of the `0014_room_proposals` entry immediately above it:

```json
    {
      "idx": 15,
      "version": "6",
      "when": 1787000000000,
      "tag": "0015_agent_actions",
      "breakpoints": true
    }
```

Keep the array's existing formatting (two-space indent, trailing `]` and `}` unchanged).

- [ ] **Step 4: Verify it applies**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

Then apply it against a scratch copy rather than the real dev database:
```bash
cp data/mission-control.db /tmp/c2-check.db 2>/dev/null || true
sqlite3 /tmp/c2-check.db < drizzle/0015_agent_actions.sql && sqlite3 /tmp/c2-check.db ".schema agent_actions"
```
Expected: the schema prints back with all nine columns and no error. If `data/mission-control.db` does not exist locally, create an empty scratch db instead: `sqlite3 /tmp/c2-check.db < drizzle/0015_agent_actions.sql`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/0015_agent_actions.sql drizzle/meta/_journal.json
git commit -m "feat(db): agent_actions table for the action feed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `action-log.ts` gains pluggable sinks

**Files:**
- Modify: `src/lib/akira/action-log.ts`
- Modify: `src/lib/akira/action-log.test.ts`

**Interfaces:**
- Consumes: the existing `ActionLogEvent` type.
- Produces: `registerActionSink(fn: (e: ActionLogEvent) => void): () => void` (returns an unregister function) and `clearActionSinks(): void` for tests. `appendActionLog` additionally calls every registered sink.

Why a sink rather than a direct DB import: `action-log.ts` is exercised by `pnpm test`, and importing the db client would pull in `server-only`, which throws outside the react-server resolve condition. The sink keeps this module pure and leaves the DB write to a `server-only` module that registers itself at boot.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/akira/action-log.test.ts`:

```ts
import { registerActionSink, clearActionSinks, appendActionLog } from './action-log';

test('a registered sink receives every event, and unregister stops it', () => {
  clearActionSinks();
  const seen: string[] = [];
  const unregister = registerActionSink((e) => seen.push(e.event));
  try {
    appendActionLog({ at: new Date(), target: 'host', event: 'dispatch', command: 'echo one' });
    appendActionLog({ at: new Date(), target: 'host', event: 'result', command: 'echo one', status: 'ok' });
    assert.deepEqual(seen, ['dispatch', 'result']);
    unregister();
    appendActionLog({ at: new Date(), target: 'host', event: 'result', command: 'echo two', status: 'ok' });
    assert.deepEqual(seen, ['dispatch', 'result'], 'no events after unregister');
  } finally { clearActionSinks(); }
});

test('a throwing sink never breaks the caller and never blocks other sinks', () => {
  clearActionSinks();
  const seen: string[] = [];
  try {
    registerActionSink(() => { throw new Error('sink exploded'); });
    registerActionSink((e) => seen.push(e.command));
    // Must not throw: logging is best-effort and a turn must survive it.
    appendActionLog({ at: new Date(), target: 'host', event: 'result', command: 'still logged', status: 'ok' });
    assert.deepEqual(seen, ['still logged'], 'the second sink still ran');
  } finally { clearActionSinks(); }
});

test('the file log is still written when a sink throws', () => {
  clearActionSinks();
  try {
    registerActionSink(() => { throw new Error('sink exploded'); });
    const before = readLogLines().length;
    appendActionLog({ at: new Date(), target: 'room', event: 'result', command: 'file still written', status: 'ok' });
    assert.equal(readLogLines().length, before + 1);
  } finally { clearActionSinks(); }
});
```

`action-log.test.ts` has **no** `readLogLines()` helper — verified. Add this one near the top of the file, after the imports (it mirrors the helper in `src/lib/akira/agent-shell.test.ts`):

```ts
import { readFileSync, existsSync } from 'node:fs';
import { actionLogPath } from './action-log';

function readLogLines(): Record<string, unknown>[] {
  const p = actionLogPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('
').filter(Boolean).map((l) => JSON.parse(l));
}
```

Note the third test asserts a *delta* (`before + 1`) rather than an absolute count, so it does not care what other tests in the file already wrote.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/akira/action-log.test.ts`
Expected: FAIL — `registerActionSink` is not exported.

- [ ] **Step 3: Implement**

In `src/lib/akira/action-log.ts`, add above `appendActionLog`:

```ts
/**
 * Extra destinations for action events. The DB write lives here rather than in
 * a direct import because this module is unit-tested by `pnpm test`, and pulling
 * in the db client would drag `server-only` with it — which throws outside the
 * react-server resolve condition. A server-only module registers its sink at
 * boot (see action-feed.ts, wired in instrumentation.ts).
 */
type ActionSink = (e: ActionLogEvent) => void;
const sinks: ActionSink[] = [];

/** Register a sink. Returns an unregister function. */
export function registerActionSink(fn: ActionSink): () => void {
  sinks.push(fn);
  return () => {
    const i = sinks.indexOf(fn);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** Drop every sink. For tests. */
export function clearActionSinks(): void {
  sinks.length = 0;
}
```

Then, at the END of `appendActionLog` (after the existing file-write try/catch, so the durable file record is written first):

```ts
  // Sinks are best-effort and independent: one throwing must neither break the
  // turn nor stop the others. The file write above already happened.
  for (const sink of sinks) {
    try {
      sink(e);
    } catch (err) {
      console.warn('[akira-action] sink failed:', err instanceof Error ? err.message : err);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/action-log.test.ts && pnpm exec tsc --noEmit`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/lib/akira/action-log.ts src/lib/akira/action-log.test.ts
git commit -m "feat(akira): action-log gains pluggable sinks

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The DB sink and the read query

**Files:**
- Create: `src/lib/akira/action-feed.ts`
- Modify: `src/instrumentation.ts`

**Interfaces:**
- Consumes: `registerActionSink` (Task 2), `agent_actions` (Task 1).
- Produces: `startActionFeed(): void` (idempotent; registers the DB sink) and `readRecentActions(limit?: number): Promise<ActionRow[]>` where `ActionRow = { id: string; atMs: number; target: string; event: string; command: string; cwd: string | null; exitCode: number | null; status: string | null; reason: string | null }`.

Only **terminal** events are persisted: `result`, `intent`, and `denied`. `dispatch` is deliberately excluded — it is written before every command, so persisting it would post each action to Discord twice. `intent` IS persisted because per D5 no result ever follows a Mission-Control restart, so it is that action's only terminal record.

- [ ] **Step 1: Create the module**

Create `src/lib/akira/action-feed.ts`:

```ts
import 'server-only';
import { desc } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '@/db/client';
import { agent_actions } from '@/db/schema';
import { registerActionSink, type ActionLogEvent } from './action-log';

/**
 * The DB half of the action log. The file log (action-log.ts) is the durable,
 * synchronous record; this table exists so the Discord poller has something with
 * a cursor to diff, the same shape schedules/dreams/proposals already use.
 *
 * There is NO output column here and must never be one — spec D7.
 */

export interface ActionRow {
  id: string;
  atMs: number;
  target: string;
  event: string;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  status: string | null;
  reason: string | null;
}

/** Events that end an action. `dispatch` is excluded: it precedes every command,
 *  so persisting it would post each action to the feed twice. `intent` is
 *  included because per D5 no result follows a Mission Control restart. */
const TERMINAL_EVENTS = new Set(['result', 'intent', 'denied']);

let started = false;

/** Register the DB sink. Idempotent — safe to call more than once at boot. */
export function startActionFeed(): void {
  if (started) return;
  started = true;
  registerActionSink((e: ActionLogEvent) => {
    if (!TERMINAL_EVENTS.has(e.event)) return;
    // Fire-and-forget: a feed insert must never delay or break a turn. The file
    // log has already recorded this event synchronously.
    void db
      .insert(agent_actions)
      .values({
        id: `act_${randomBytes(6).toString('hex')}`,
        at: e.at,
        target: e.target,
        event: e.event,
        command: e.command,
        cwd: e.cwd ?? null,
        exit_code: e.exitCode ?? null,
        status: e.status ?? null,
        reason: e.reason ?? null,
      })
      .catch((err: unknown) => {
        console.warn('[action-feed] insert failed:', err instanceof Error ? err.message : err);
      });
  });
  console.log('[action-feed] started');
}

/** Most recent actions, newest first. */
export async function readRecentActions(limit = 50): Promise<ActionRow[]> {
  const rows = await db.select().from(agent_actions).orderBy(desc(agent_actions.at)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    atMs: r.at.getTime(),
    target: r.target,
    event: r.event,
    command: r.command,
    cwd: r.cwd,
    exitCode: r.exit_code,
    status: r.status,
    reason: r.reason,
  }));
}
```

- [ ] **Step 2: Register it at boot**

`src/instrumentation.ts` already dynamically imports and starts the tickers. Add the feed alongside them, in the same `register()` body and the same style as the existing `startDiscordNotify()` lines:

```ts
    const { startActionFeed } = await import('@/lib/akira/action-feed');
    startActionFeed();
```

Place it **before** the `startDiscordNotify()` lines, so the sink is live before the poller's first tick. Read the surrounding lines first and match the file's existing import/await style exactly.

- [ ] **Step 3: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: clean typecheck; suite unchanged from baseline (this task adds no tests — `action-feed.ts` is `server-only` and cannot be imported by `tsx --test`; its behaviour is covered by Task 2's sink tests and by the Task 5 wiring).

- [ ] **Step 4: Commit**

```bash
git add src/lib/akira/action-feed.ts src/instrumentation.ts
git commit -m "feat(akira): persist terminal actions for the feed

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The cursor diff and the embed

**Files:**
- Create: `src/lib/akira/action-feed-diff.ts`
- Create: `src/lib/akira/action-feed-diff.test.ts`
- Modify: `src/lib/discord-format.ts`
- Modify: `src/lib/discord-format.test.ts`

**Interfaces:**
- Consumes: `ActionRow` (Task 3) — but re-declare the minimal shape locally so this pure module does not import the `server-only` one.
- Produces: `pickNewActions(lastSeenMs, rows)` returning `{ newActions, next }`, and `actionEmbed(a): APIEmbed`.

- [ ] **Step 1: Write the failing diff test**

Create `src/lib/akira/action-feed-diff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNewActions, type ActionLite } from './action-feed-diff';

const row = (id: string, atMs: number): ActionLite => ({
  id, atMs, target: 'host', event: 'result', command: `cmd-${id}`,
  cwd: null, exitCode: 0, status: 'ok', reason: null,
});

test('a null cursor takes everything and advances to the newest', () => {
  const out = pickNewActions(null, [row('a', 100), row('b', 200)]);
  assert.deepEqual(out.newActions.map((a) => a.id), ['a', 'b']);
  assert.equal(out.next, 200);
});

test('only rows strictly newer than the cursor are new', () => {
  const out = pickNewActions(150, [row('a', 100), row('b', 200)]);
  assert.deepEqual(out.newActions.map((a) => a.id), ['b']);
  assert.equal(out.next, 200);
});

test('an empty batch leaves the cursor untouched', () => {
  assert.deepEqual(pickNewActions(150, []), { newActions: [], next: 150 });
});

test('a row exactly at the cursor is not re-posted', () => {
  const out = pickNewActions(200, [row('b', 200)]);
  assert.deepEqual(out.newActions, []);
  assert.equal(out.next, 200);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/akira/action-feed-diff.test.ts`
Expected: FAIL — `Cannot find module './action-feed-diff'`.

- [ ] **Step 3: Implement the diff**

Create `src/lib/akira/action-feed-diff.ts`:

```ts
// Pure cursor diff for the action feed, mirroring pickNewDreams in
// discord-notify-diff.ts. Kept separate from action-feed.ts because that module
// is 'server-only' and this one must be unit-testable.

/** The subset of an action row the feed needs. Structurally compatible with
 *  ActionRow from action-feed.ts, without importing that server-only module. */
export interface ActionLite {
  id: string;
  atMs: number;
  target: string;
  event: string;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  status: string | null;
  reason: string | null;
}

/** Rows strictly newer than the cursor are new. next = the newest timestamp seen. */
export function pickNewActions(
  lastSeenMs: number | null,
  rows: ActionLite[],
): { newActions: ActionLite[]; next: number | null } {
  const newActions = rows.filter((a) => lastSeenMs == null || a.atMs > lastSeenMs);
  const maxMs = rows.reduce((m, a) => Math.max(m, a.atMs), lastSeenMs ?? -Infinity);
  const next = maxMs === -Infinity ? lastSeenMs : maxMs;
  return { newActions, next };
}
```

- [ ] **Step 4: Write the failing embed test — this is the D7 guard**

Append to `src/lib/discord-format.test.ts`:

```ts
import { actionEmbed } from './discord-format';

test('actionEmbed carries the metadata the operator needs', () => {
  const e = actionEmbed({
    id: 'act_1', atMs: 1, target: 'host', event: 'result',
    command: 'systemctl status mission-control', cwd: '/srv/mission-control',
    exitCode: 0, status: 'ok', reason: null,
  });
  assert.match(JSON.stringify(e), /systemctl status mission-control/);
  assert.match(JSON.stringify(e), /host/);
});

// SPEC D7 — this test exists to fail if anyone ever adds command output to the
// embed. AKIRA can `cat .env`; Discord is a third party. Do not relax it.
test('actionEmbed NEVER carries command output', () => {
  const secret = 'SESSION_SECRET=hunter2-do-not-ship-this';
  const e = actionEmbed({
    id: 'act_2', atMs: 1, target: 'host', event: 'result',
    // A field that does not exist on ActionLite today. If someone widens the type
    // and pipes stdout through, this cast is what makes the test still catch it.
    command: 'cat .env', cwd: null, exitCode: 0, status: 'ok', reason: null,
    ...({ text: secret, output: secret, stdout: secret } as unknown as object),
  } as never);
  assert.doesNotMatch(
    JSON.stringify(e),
    /hunter2-do-not-ship-this/,
    'command output must never reach the Discord embed (spec D7)',
  );
});

test('actionEmbed marks an intent as having no result to follow', () => {
  const e = actionEmbed({
    id: 'act_3', atMs: 1, target: 'host', event: 'intent',
    command: 'systemctl restart mission-control', cwd: null,
    exitCode: null, status: null, reason: null,
  });
  assert.match(JSON.stringify(e), /no result/i);
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: FAIL — `actionEmbed` is not exported.

- [ ] **Step 6: Implement the embed**

Add to `src/lib/discord-format.ts`, following the style of `dreamEmbed` and `roomProposalEmbed`:

```ts
import type { ActionLite } from '@/lib/akira/action-feed-diff';

/**
 * One completed AKIRA action. SPEC D7: metadata only — target, command, cwd,
 * exit code, status. NEVER command output: she can read .env, and Discord is a
 * third party. `discord-format.test.ts` has a test whose only job is to fail if
 * an output field is ever added here.
 */
export function actionEmbed(a: ActionLite): APIEmbed {
  const ok = a.event === 'result' && a.status === 'ok' && (a.exitCode ?? 0) === 0;
  const lines = [`\`${a.command}\``];
  if (a.cwd) lines.push(`in \`${a.cwd}\``);
  if (a.event === 'intent') {
    lines.push('_Started — this restarts Mission Control, so no result will follow._');
  } else {
    if (a.exitCode !== null) lines.push(`exit ${a.exitCode}`);
    if (a.reason) lines.push(a.reason);
  }
  return {
    title: `AKIRA · ${a.target}`,
    description: lines.join('\n').slice(0, 4000),
    color: ok ? GREEN : RED,
  };
}
```

`GREEN` (`0x10b981`) and `RED` (`0xef4444`) are already defined at `discord-format.ts:6-7` — verified. Use them as written above. Do not add new colour constants.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/akira/action-feed-diff.test.ts src/lib/discord-format.test.ts && pnpm exec tsc --noEmit`
Expected: PASS and a clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add src/lib/akira/action-feed-diff.ts src/lib/akira/action-feed-diff.test.ts src/lib/discord-format.ts src/lib/discord-format.test.ts
git commit -m "feat(discord): action embed with the D7 no-output guard

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the contributor into the tick

**Files:**
- Modify: `src/lib/discord-notify.ts`

**Interfaces:**
- Consumes: `readRecentActions` (Task 3), `pickNewActions` (Task 4), `actionEmbed` (Task 4).
- Produces: actions posted to the home project channel on each tick.

Actions are not project-scoped, so they route to `DREAM_PROJECT_ID` — the same home channel dreams and room drops already use. That constant is already defined at the top of this file.

- [ ] **Step 1: Add the imports and the cursor**

At the top of `src/lib/discord-notify.ts`, alongside the existing imports:

```ts
import { readRecentActions } from './akira/action-feed';
import { pickNewActions } from './akira/action-feed-diff';
```

Add `actionEmbed` to the existing import from `./discord-format`.

Beside the other module-level cursors (`scheduleCursor`, `dreamCursor`, `proposalCursor`, `roomProposalCursor`), add:

```ts
let actionCursor: number | null = null;
```

- [ ] **Step 2: Gather, guarded like the room gather**

The room-proposal gather already wraps its query in `.catch()` so one failing source cannot take down the whole tick. Do the same for actions — add beside it:

```ts
  const actionRows = await readRecentActions(50).catch((err) => {
    console.error('[discord-notify] action gather failed:', err instanceof Error ? err.message : err);
    return null;
  });
```

- [ ] **Step 3: Prime on the first tick**

Inside the existing `if (!primed) { ... }` block, before `primed = true;`, add:

```ts
    if (actionRows) actionCursor = pickNewActions(actionCursor, actionRows).next;
```

This matters: without priming, the very first tick after a deploy would post every historical action at once.

- [ ] **Step 4: Post and advance**

After the room-proposal section near the end of `tick()`, add:

```ts
  // --- AKIRA's actions: route to the home project channel (not project-scoped) ---
  if (actionRows) {
    // Oldest first, so the feed reads in the order things happened.
    const fresh = pickNewActions(actionCursor, actionRows).newActions.slice().sort((a, b) => a.atMs - b.atMs);
    for (const a of fresh) {
      if (await postToProject(client, DREAM_PROJECT_ID, actionEmbed(a))) {
        actionCursor = Math.max(actionCursor ?? 0, a.atMs);
      }
    }
  }
```

Advancing the cursor only on a successful post is deliberate and matches the other contributors: a failed send leaves the cursor behind so the next tick retries rather than dropping the action silently. Under D2 a dropped post is a real defect.

- [ ] **Step 5: Verify**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: clean typecheck, suite green.

The full loop needs a live Discord bot and cannot be unit-tested here; it is verified on the Mini at deploy (see Rollout).

- [ ] **Step 6: Commit**

```bash
git add src/lib/discord-notify.ts
git commit -m "feat(discord): post AKIRA's actions to the home channel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Rollout

This slice **does** add a migration, unlike C1. Order matters:

1. Merge to `dev`, release, deploy per `ship-mc-feature`.
2. On the Mini: `git pull --ff-only origin main && pnpm build`. **Skip `pnpm install`** — this slice adds no dependencies, and letting pnpm purge `node_modules` would wipe the hand-compiled `better-sqlite3` binding.
3. **Run the migration:** `sudo -u mc bash -lc "cd /srv/mission-control && set -a; . ./.env; set +a; pnpm db:migrate"`. This one is a pure `CREATE TABLE`, so the table-rebuild hazard does not apply and it should apply cleanly.
4. `sudo systemctl restart mission-control`.
5. Verify: `curl -s 127.0.0.1:3000/api/health` shows the new version and `db:ok`; the journal shows `[action-feed] started`; `systemctl --failed` is clean.
6. **Prove the loop end to end.** This is the only step that proves C2 works: with the host agent installed, ask AKIRA to run something harmless on target `host` (e.g. `systemctl is-active mission-control`), then confirm within ~30s that an embed appears in the home Discord channel — and that it shows the command and exit code but **no command output**.

**No reseed is needed** — this slice changes no agent prompt.

**Depends on C1's host agent being installed.** Until the operator installs `deploy/akira-host-agent.service` and mints `HOST_COMPANION_TOKEN`, no host action can occur, so step 6 can only be proven with room actions. Room actions do flow through the same path, so the feed is still verifiable — just not the host half.
