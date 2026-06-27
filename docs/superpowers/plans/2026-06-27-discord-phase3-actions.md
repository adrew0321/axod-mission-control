# Discord Phase 3 — Approve & Merge / Discard buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Discord proposal-ready embeds actionable with **Approve & Merge** / **Discard** buttons that run `mergeWorktree`/`discardWorktree` (the same actions as the web Proposals view).

**Architecture:** Pure helpers (`discord-format.ts`) build the button custom_ids, the action row, and the result embed (unit-tested). The Phase-2 notifier attaches the action row to proposal embeds. A new button branch in `discord-bot.ts`'s interaction handler re-checks the allowlist, defers, runs the action, and edits the message to its resolved state.

**Tech Stack:** TypeScript, discord.js v14, Drizzle + better-sqlite3, `node:test` via `tsx`.

## Global Constraints

- Tests use `node:test` + `node:assert/strict` via `pnpm test` (`tsx --test src/lib/*.test.ts`); local imports WITHOUT file extensions.
- Pure modules (`discord-format.ts`) must NOT import discord.js at runtime — use `import type` only, and use Discord component **literal numbers** (ActionRow `1`, Button `2`; ButtonStyle Success `3` / Danger `4`) instead of the runtime enums, so the module loads under `tsx --test`.
- `discord-notify.ts` and `discord-bot.ts` are `server-only` / live discord.js → NOT unit-tested; verify by `tsc --noEmit` + full suite + runtime.
- custom_id format: `mc:merge:<sessionId>` / `mc:discard:<sessionId>` (well under Discord's 100-char limit).
- Every button click re-checks the allowlist (`isAllowed`); not-allowed → ephemeral "Not authorized.".
- Button handler `deferUpdate()` first (merge takes seconds), then edits the message and removes the buttons (`components: []`) on resolution.
- Merge mirrors the web route: `mergeWorktree(sessionId, project.repo_path, project.default_branch ?? 'dev')`; on `{ok:true}` clear `sessions.worktree_path`; on `{ok:false, conflict}` show the conflict message.
- Implementation runs in an isolated git worktree off `dev`.

---

### Task 1: Pure button/action helpers (`discord-format.ts`)

**Files:**
- Modify: `src/lib/discord-format.ts`
- Modify: `src/lib/discord-format.test.ts`

**Interfaces (produced):**
- `buildActionId(action: 'merge' | 'discard', sessionId: string): string`
- `parseActionId(customId: string): { action: 'merge' | 'discard'; sessionId: string } | null`
- `proposalActionRow(sessionId: string): APIActionRowComponent<APIMessageActionRowComponent>`
- `proposalResultEmbed(kind: 'merged' | 'discarded' | 'conflict' | 'stale', opts?: { baseBranch?: string; sessionTitle?: string }): APIEmbed`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/discord-format.test.ts`:

```ts
import { buildActionId, parseActionId, proposalActionRow, proposalResultEmbed } from './discord-format';

test('buildActionId / parseActionId round-trip both actions', () => {
  assert.deepEqual(parseActionId(buildActionId('merge', 'sess_ab12')), { action: 'merge', sessionId: 'sess_ab12' });
  assert.deepEqual(parseActionId(buildActionId('discard', 'sess_ab12')), { action: 'discard', sessionId: 'sess_ab12' });
});

test('parseActionId returns null for foreign / malformed ids', () => {
  assert.equal(parseActionId('other:merge:x'), null);
  assert.equal(parseActionId('mc:bogus:x'), null);
  assert.equal(parseActionId('mc:merge'), null);
  assert.equal(parseActionId(''), null);
});

test('proposalActionRow has merge + discard buttons with correct ids/styles/labels', () => {
  const row = proposalActionRow('sess_ab12');
  assert.equal(row.type, 1);
  const btns = row.components as Array<{ type: number; style: number; label: string; custom_id: string }>;
  assert.equal(btns.length, 2);
  assert.deepEqual(
    { style: btns[0].style, label: btns[0].label, id: btns[0].custom_id },
    { style: 3, label: 'Approve & Merge', id: 'mc:merge:sess_ab12' },
  );
  assert.deepEqual(
    { style: btns[1].style, label: btns[1].label, id: btns[1].custom_id },
    { style: 4, label: 'Discard', id: 'mc:discard:sess_ab12' },
  );
});

test('proposalResultEmbed: color + text per kind', () => {
  const merged = proposalResultEmbed('merged', { baseBranch: 'dev', sessionTitle: 'Add widget' });
  assert.equal(merged.color, 0x10b981);
  assert.match(String(merged.title), /Merged into dev/);
  assert.match(String(merged.description), /Add widget/);
  assert.match(String(proposalResultEmbed('discarded').title), /Discarded/);
  assert.equal(proposalResultEmbed('discarded').color, 0x6e7681);
  assert.match(String(proposalResultEmbed('conflict').title), /conflict/i);
  assert.equal(proposalResultEmbed('conflict').color, 0xf59e0b);
  assert.match(String(proposalResultEmbed('stale').title), /already resolved/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: FAIL — `buildActionId` / `parseActionId` / `proposalActionRow` / `proposalResultEmbed` not exported.

- [ ] **Step 3: Add the helpers**

In `src/lib/discord-format.ts`, extend the discord.js type import on line 1 and add a `GREY` color constant:

```ts
import type { APIEmbed, APIActionRowComponent, APIMessageActionRowComponent } from 'discord.js'; // type-only: erased at runtime, keeps this module pure
```

```ts
const GREY = 0x6e7681;
```

Append to the end of the file:

```ts
/** Encode/parse a proposal-action button id. Pure. */
export function buildActionId(action: 'merge' | 'discard', sessionId: string): string {
  return `mc:${action}:${sessionId}`;
}
export function parseActionId(
  customId: string,
): { action: 'merge' | 'discard'; sessionId: string } | null {
  const m = /^mc:(merge|discard):(.+)$/.exec(customId);
  return m ? { action: m[1] as 'merge' | 'discard', sessionId: m[2] } : null;
}

/**
 * Action row for a proposal embed: green "Approve & Merge" + red "Discard".
 * Hand-built component JSON (Discord literals: ActionRow=1, Button=2; Success=3, Danger=4)
 * so this module never imports discord.js runtime enums. Pure.
 */
export function proposalActionRow(sessionId: string): APIActionRowComponent<APIMessageActionRowComponent> {
  return {
    type: 1,
    components: [
      { type: 2, style: 3, label: 'Approve & Merge', custom_id: buildActionId('merge', sessionId) },
      { type: 2, style: 4, label: 'Discard', custom_id: buildActionId('discard', sessionId) },
    ],
  } as unknown as APIActionRowComponent<APIMessageActionRowComponent>;
}

/** Embed shown after a proposal button resolves (replaces the proposal embed). Pure. */
export function proposalResultEmbed(
  kind: 'merged' | 'discarded' | 'conflict' | 'stale',
  opts?: { baseBranch?: string; sessionTitle?: string },
): APIEmbed {
  const description = opts?.sessionTitle;
  if (kind === 'merged')
    return { title: `✅ Merged${opts?.baseBranch ? ` into ${opts.baseBranch}` : ''}`, description, color: GREEN };
  if (kind === 'discarded') return { title: '🗑️ Discarded', description, color: GREY };
  if (kind === 'conflict')
    return { title: '⚠️ Merge conflict — resolve in Mission Control', description, color: AMBER };
  return { title: 'Proposal already resolved', description, color: GREY };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec tsx --test src/lib/discord-format.test.ts`
Expected: PASS (existing chunk/embed tests + the 4 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-format.ts src/lib/discord-format.test.ts
git commit -m "feat(discord): pure helpers for proposal action buttons + result embed"
```

---

### Task 2: Wire buttons into notifications + handle clicks

No new unit test: both files are `server-only` / live discord.js. Logic that can be tested is in Task 1. Verify by `tsc --noEmit` + full suite + runtime.

**Files:**
- Modify: `src/lib/discord-notify.ts` (attach the action row to proposal embeds)
- Modify: `src/lib/discord-bot.ts` (button branch in the interaction handler)

**Interfaces (consumed):** `proposalActionRow`, `parseActionId`, `proposalResultEmbed` (Task 1); `mergeWorktree`, `discardWorktree` (`./worktree`).

- [ ] **Step 1: Attach the action row in `discord-notify.ts`**

Add the action-row types to the discord.js type import and `proposalActionRow` to the format import (the file already imports `Client`, `APIEmbed` type-only and `scheduleEmbed, dreamEmbed, proposalEmbed`):

```ts
import type { Client, APIEmbed, APIActionRowComponent, APIMessageActionRowComponent } from 'discord.js';
import { scheduleEmbed, dreamEmbed, proposalEmbed, proposalActionRow } from './discord-format';
```

(If `Client` / `APIEmbed` are imported on separate `import type` lines, just add `APIActionRowComponent, APIMessageActionRowComponent` to the discord.js type import and `proposalActionRow` to the existing `./discord-format` import — don't duplicate import lines.)

Change `postToProject` to accept optional components:

```ts
async function postToProject(
  client: Client,
  projectId: string,
  embed: APIEmbed,
  components?: APIActionRowComponent<APIMessageActionRowComponent>[],
): Promise<boolean> {
  try {
    const channelIds = await getChannelsForProject(projectId);
    for (const id of channelIds) {
      const ch = await client.channels.fetch(id);
      if (ch && 'send' in ch && typeof ch.send === 'function') {
        await ch.send({ embeds: [embed], ...(components ? { components } : {}) });
      }
    }
    return true;
  } catch (err) {
    console.error('[discord-notify] post failed:', err instanceof Error ? err.message : err);
    return false;
  }
}
```

In the proposals loop, pass the action row:

```ts
  for (const id of prop.newIds) {
    const p = proposals.find((x) => x.sessionId === id);
    if (p && (await postToProject(client, p.projectId, proposalEmbed(p), [proposalActionRow(p.sessionId)]))) {
      proposalCursor.add(id);
    }
  }
```

(The schedule and dream `postToProject` calls stay unchanged — no components.)

- [ ] **Step 2: Add the button handler in `discord-bot.ts`**

Add imports (after the existing imports):

```ts
import { mergeWorktree, discardWorktree } from './worktree';
import { parseActionId, proposalResultEmbed } from './discord-format';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
```

Add `ButtonInteraction` to the discord.js import (alongside the existing `type Interaction`, `type Message`):

```ts
  type Interaction,
  type ButtonInteraction,
  type Message,
```

Make `handleInteraction` dispatch buttons — change its first line:

```ts
async function handleInteraction(interaction: Interaction, allowed: Set<string>): Promise<void> {
  if (interaction.isButton()) return handleButton(interaction, allowed);
  if (!interaction.isChatInputCommand()) return;
  // …existing slash-command body unchanged…
```

Add `handleButton` (e.g. right after `handleInteraction`):

```ts
async function handleButton(interaction: ButtonInteraction, allowed: Set<string>): Promise<void> {
  const parsed = parseActionId(interaction.customId);
  if (!parsed) return; // not one of our proposal buttons
  try {
    if (!isAllowed(interaction.user.id, allowed)) {
      await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate(); // merge can take seconds; beat the 3s limit, keep the message
    const { action, sessionId } = parsed;

    const session = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).then((r) => r[0]);
    const title = session?.title ?? undefined;
    if (!session || !session.worktree_path) {
      await interaction.message.edit({ embeds: [proposalResultEmbed('stale', { sessionTitle: title })], components: [] });
      return;
    }
    const project = await db.select().from(projects).where(eq(projects.id, session.project_id)).limit(1).then((r) => r[0]);
    if (!project) {
      await interaction.message.edit({ embeds: [proposalResultEmbed('stale', { sessionTitle: title })], components: [] });
      return;
    }

    if (action === 'merge') {
      const base = project.default_branch ?? 'dev';
      const result = await mergeWorktree(sessionId, project.repo_path, base);
      if (result.ok) {
        await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
        await interaction.message.edit({ embeds: [proposalResultEmbed('merged', { baseBranch: base, sessionTitle: title })], components: [] });
      } else {
        await interaction.message.edit({ embeds: [proposalResultEmbed('conflict', { sessionTitle: title })], components: [] });
      }
    } else {
      await discardWorktree(sessionId, project.repo_path);
      await db.update(sessions).set({ worktree_path: null }).where(eq(sessions.id, sessionId));
      await interaction.message.edit({ embeds: [proposalResultEmbed('discarded', { sessionTitle: title })], components: [] });
    }
  } catch (err) {
    console.error('[discord] button action failed:', err instanceof Error ? err.message : err);
    try {
      await interaction.followUp({ content: `Action failed: ${err instanceof Error ? err.message : err}`, flags: MessageFlags.Ephemeral });
    } catch {
      /* best-effort */
    }
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Full suite — no regressions**

Run: `pnpm test`
Expected: all `src/lib/*.test.ts` pass (Task 1 helpers included); 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-notify.ts src/lib/discord-bot.ts
git commit -m "feat(discord): proposal Approve&Merge / Discard buttons (notify + handler)"
```

---

## Self-Review

**Spec coverage:**
- Pure `buildActionId`/`parseActionId` (round-trip + null on garbage) → Task 1. ✓
- `proposalActionRow` (green merge / red discard, custom_ids) → Task 1. ✓
- `proposalResultEmbed` (merged/discarded/conflict/stale) → Task 1. ✓
- Notifier attaches the action row to proposal embeds only → Task 2 Step 1. ✓
- Button branch: ignore foreign ids, re-check allowlist, `deferUpdate`, stale-check, merge (clear worktree_path) / conflict / discard, edit message + remove buttons, ephemeral error → Task 2 Step 2. ✓
- Mirrors merge route (`mergeWorktree(sessionId, repo_path, default_branch ?? 'dev')`, clear `worktree_path`) → Task 2 Step 2. ✓
- Testing: pure helpers unit-tested; effectful verified by tsc + suite + runtime → Tasks 1-2. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — full code + exact commands. ✓

**Type consistency:** `buildActionId`/`parseActionId`/`proposalActionRow`/`proposalResultEmbed` signatures match between Task 1 (definition + tests) and Task 2 (usage); `proposalResultEmbed` is called with the documented `kind` values and `{baseBranch, sessionTitle}` opts; `postToProject`'s new `components` param type matches `proposalActionRow`'s return; `mergeWorktree` returns `{ok:true} | {ok:false, conflict, message}` (handled); `discardWorktree(sessionId, repoPath)` and `session.worktree_path`/`title` columns match the schema. ✓
