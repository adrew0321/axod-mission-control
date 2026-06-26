# Discord Bot (Phase 1: foundation + chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An in-process Discord bot you can talk to: a message in a project-bound channel (from your allowlisted ID) runs an agent turn and streams the reply back into Discord.

**Architecture:** A discord.js gateway client started in `instrumentation.ts` alongside the Scheduler/Dreaming tickers (outbound websocket, no inbound endpoint). On a `messageCreate` in a channel bound to a project, it resolves that project's active session and calls `runSessionTurn(sessionId, { instruction, emit })` with a **Discord sink** that posts a placeholder and edits it as tokens stream. Pure helpers (allowlist, reply chunking) are unit-tested; the effectful bot is proven by runtime verification.

**Tech Stack:** Next.js 16 (instrumentation hook), discord.js v14, Drizzle + better-sqlite3, node:test via tsx.

**Scope note:** This plan is Phase 1 of the approved spec (`docs/superpowers/specs/2026-06-22-discord-bot-design.md`). Notifications (Phase 2) and merge/discard action buttons (Phase 3) are deferred to their own follow-up plans; this plan delivers working, shippable chat plus the `/mc bind` commands chat depends on.

## Global Constraints

- **Bot only starts when `DISCORD_BOT_TOKEN` is set** — machines without it never start it.
- **Idempotent startup** via a `globalThis.__mcDiscordStarted` guard (same pattern as `startScheduler`/`startDreaming`).
- **Authorization:** only Discord user IDs in `DISCORD_ALLOWED_USER_IDS` are obeyed; everyone else is silently ignored. Re-check on every handler.
- **Error isolation:** bot startup and every handler wrapped in try/catch — a Discord-side failure logs `[discord] …` and never affects the web server or other tickers.
- **Tests:** `pnpm test` runs `tsx --test src/lib/*.test.ts`; use **extensionless** imports in test files (a `.ts` extension breaks tsc/next build).
- **Do NOT run `pnpm approve-builds`** — the `onlyBuiltDependencies` allowlist is intentional. discord.js is pure JS; its optional native deps (zlib-sync/bufferutil) are not required.
- **Migrations:** next migration number is `0007` (Dreaming was `0006`). Generate with `pnpm db:generate`, apply with `pnpm db:migrate`. A fresh checkout needs a `data/` dir before build/migrate.

---

## File Structure

```
src/lib/
  discord-allow.ts        # pure: parse DISCORD_ALLOWED_USER_IDS, isAllowed() — unit-tested
  discord-format.ts       # pure: chunkReply() for the 2000-char limit — unit-tested
  discord-bindings.ts     # server-only: get/set/remove channel→project bindings (effectful)
  discord-session.ts      # server-only: getActiveSessionId(projectId) — most-recent-or-create (effectful)
  discord-sink.ts         # server-only: createDiscordSink() — turn emit events → throttled message edits
  discord-bot.ts          # server-only: startDiscordBot() — client, slash + message handlers (effectful)
src/db/schema.ts          # + discord_bindings table
drizzle/0007_*.sql        # generated migration
src/instrumentation.ts    # + startDiscordBot()
.env.example              # + DISCORD_* vars
package.json              # + discord.js dependency
```

---

## Task 1: Add discord.js dependency + env template

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `.env.example`

- [ ] **Step 1: Add discord.js**

Run:
```bash
pnpm add discord.js@^14
```
Expected: `package.json` gains `"discord.js": "^14.x"` under `dependencies`; lockfile updates. (No build scripts run — `ignore-scripts` is on; discord.js needs none.)

- [ ] **Step 2: Document the env vars**

Append to `.env.example`:
```bash

# --- Discord bot (optional; bot only starts when DISCORD_BOT_TOKEN is set) ---
DISCORD_BOT_TOKEN=
DISCORD_APP_ID=
# Comma-separated Discord user IDs allowed to talk to the bot (the auth boundary):
DISCORD_ALLOWED_USER_IDS=
# Optional: scope slash-command registration to one guild (instant vs ~1h global):
DISCORD_GUILD_ID=
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "feat(discord): add discord.js dep + env template"
```

---

## Task 2: `discord_bindings` table + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/0007_*.sql` (generated)

**Interfaces:**
- Produces: table `discord_bindings { channel_id: text PK, project_id: text FK→projects, created_at: timestamp }`; exported `discord_bindings` drizzle object.

- [ ] **Step 1: Add the table**

Append to `src/db/schema.ts` (after the `dreams`/`dream_insights` tables, following their style):
```ts
export const discord_bindings = sqliteTable('discord_bindings', {
  // Discord channel snowflake — one bound channel per row.
  channel_id: text('channel_id').primaryKey(),
  project_id: text('project_id').references(() => projects.id).notNull(),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull(),
});
```

- [ ] **Step 2: Generate + apply the migration**

Run:
```bash
pnpm db:generate
pnpm db:migrate
```
Expected: a new `drizzle/0007_*.sql` creating `discord_bindings`; `migrations applied successfully`.

- [ ] **Step 3: Verify the table exists**

Run:
```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.DATABASE_PATH||'data/mission-control.db');console.log(db.prepare(\"select name from sqlite_master where type='table' and name='discord_bindings'\").all())"
```
Expected: `[ { name: 'discord_bindings' } ]`

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(discord): discord_bindings table + migration"
```

---

## Task 3: Pure allowlist module (TDD)

**Files:**
- Create: `src/lib/discord-allow.ts`
- Test: `src/lib/discord-allow.test.ts`

**Interfaces:**
- Produces: `parseAllowedIds(raw: string | undefined): Set<string>`; `isAllowed(userId: string, allowed: Set<string>): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/discord-allow.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedIds, isAllowed } from './discord-allow';

test('parses a comma-separated list, trimming + dropping blanks', () => {
  const s = parseAllowedIds(' 111, 222 ,,333 ');
  assert.deepEqual([...s].sort(), ['111', '222', '333']);
});

test('undefined / empty → empty set', () => {
  assert.equal(parseAllowedIds(undefined).size, 0);
  assert.equal(parseAllowedIds('').size, 0);
  assert.equal(parseAllowedIds('  ').size, 0);
});

test('isAllowed matches exact ids only', () => {
  const s = parseAllowedIds('111,222');
  assert.equal(isAllowed('111', s), true);
  assert.equal(isAllowed('999', s), false);
});

test('empty allowlist denies everyone (fail closed)', () => {
  assert.equal(isAllowed('111', parseAllowedIds('')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./discord-allow`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/discord-allow.ts`:
```ts
/** Parse DISCORD_ALLOWED_USER_IDS (comma-separated snowflakes) into a Set. Pure. */
export function parseAllowedIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Fail-closed allowlist check: an empty set denies everyone. Pure. */
export function isAllowed(userId: string, allowed: Set<string>): boolean {
  return allowed.has(userId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (4 new tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-allow.ts src/lib/discord-allow.test.ts
git commit -m "feat(discord): pure allowlist module (TDD)"
```

---

## Task 4: Pure reply-chunking module (TDD)

**Files:**
- Create: `src/lib/discord-format.ts`
- Test: `src/lib/discord-format.test.ts`

**Interfaces:**
- Produces: `chunkReply(text: string, max?: number): string[]` — splits text into pieces each ≤ `max` (default 2000), preferring newline then space boundaries, never returning an empty array.

- [ ] **Step 1: Write the failing test**

Create `src/lib/discord-format.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkReply } from './discord-format';

test('short text → single chunk', () => {
  assert.deepEqual(chunkReply('hello'), ['hello']);
});

test('empty/whitespace text → single placeholder space (never empty)', () => {
  const out = chunkReply('');
  assert.equal(out.length, 1);
});

test('splits on newline boundaries under the max', () => {
  const text = 'a'.repeat(10) + '\n' + 'b'.repeat(10);
  const out = chunkReply(text, 12);
  assert.equal(out.length, 2);
  assert.ok(out.every((c) => c.length <= 12));
  assert.equal(out.join('\n').replace(/\n/g, ''), 'a'.repeat(10) + 'b'.repeat(10));
});

test('hard-splits a single token longer than max', () => {
  const out = chunkReply('x'.repeat(25), 10);
  assert.ok(out.every((c) => c.length <= 10));
  assert.equal(out.join(''), 'x'.repeat(25));
});

test('every chunk respects the max for realistic mixed text', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n');
  const out = chunkReply(text, 200);
  assert.ok(out.length > 1);
  assert.ok(out.every((c) => c.length <= 200));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./discord-format`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/discord-format.ts`:
```ts
/**
 * Split text into Discord-sendable chunks each ≤ max chars (default 2000).
 * Prefers to break on the last newline, then the last space, before max; a single
 * token longer than max is hard-split. Never returns an empty array. Pure.
 */
export function chunkReply(text: string, max = 2000): string[] {
  if (text.length === 0) return [' ']; // Discord rejects empty content
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max; // no boundary → hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(rest[cut] === '\n' || rest[cut] === ' ' ? cut + 1 : cut);
  }
  chunks.push(rest);
  return chunks;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (5 new tests green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/discord-format.ts src/lib/discord-format.test.ts
git commit -m "feat(discord): pure reply-chunking module (TDD)"
```

---

## Task 5: Bindings + active-session data helpers

**Files:**
- Create: `src/lib/discord-bindings.ts`
- Create: `src/lib/discord-session.ts`

**Interfaces:**
- Consumes: `discord_bindings` (Task 2); `sessions`, `projects` tables.
- Produces:
  - `getBinding(channelId: string): Promise<{ project_id: string } | undefined>`
  - `setBinding(channelId: string, projectId: string): Promise<void>` (upsert)
  - `removeBinding(channelId: string): Promise<void>`
  - `findProjectByName(name: string): Promise<{ id: string; name: string } | undefined>`
  - `getActiveSessionId(projectId: string): Promise<string>` — most-recently-updated session for the project, creating one if none exists.

- [ ] **Step 1: Write the bindings helper**

Create `src/lib/discord-bindings.ts`:
```ts
import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { discord_bindings, projects } from '@/db/schema';

export async function getBinding(channelId: string) {
  return db
    .select({ project_id: discord_bindings.project_id })
    .from(discord_bindings)
    .where(eq(discord_bindings.channel_id, channelId))
    .limit(1)
    .then((r) => r[0]);
}

export async function setBinding(channelId: string, projectId: string): Promise<void> {
  await db
    .insert(discord_bindings)
    .values({ channel_id: channelId, project_id: projectId, created_at: new Date() })
    .onConflictDoUpdate({
      target: discord_bindings.channel_id,
      set: { project_id: projectId },
    });
}

export async function removeBinding(channelId: string): Promise<void> {
  await db.delete(discord_bindings).where(eq(discord_bindings.channel_id, channelId));
}

/** Case-insensitive exact match on project name. */
export async function findProjectByName(name: string) {
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(sql`lower(${projects.name}) = lower(${name})`)
    .limit(1)
    .then((r) => r[0]);
}
```

- [ ] **Step 2: Write the active-session resolver**

Create `src/lib/discord-session.ts`:
```ts
import 'server-only';
import { desc, eq } from 'drizzle-orm';
import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import { db } from '@/db/client';
import { sessions, projects } from '@/db/schema';

/**
 * The project's active session for Discord chat: its most-recently-updated session,
 * or a freshly created one if the project has none yet. Mirrors how the Scheduler
 * seeds a session (branch = project default).
 */
export async function getActiveSessionId(projectId: string): Promise<string> {
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.project_id, projectId))
    .orderBy(desc(sessions.updated_at))
    .limit(1)
    .then((r) => r[0]);
  if (existing) return existing.id;

  const project = await db
    .select({ default_branch: projects.default_branch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .then((r) => r[0]);

  const sessionId = `sess_${bytesToHex(randomBytes(4))}`;
  const ts = new Date();
  await db.insert(sessions).values({
    id: sessionId,
    project_id: projectId,
    title: 'Discord',
    branch: project?.default_branch ?? 'dev',
    worktree_path: null,
    status: 'active',
    cleared_at: null,
    created_at: ts,
    updated_at: ts,
  });
  return sessionId;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors. (No unit test — effectful DB code is proven in Task 8 runtime verification.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/discord-bindings.ts src/lib/discord-session.ts
git commit -m "feat(discord): bindings + active-session data helpers"
```

---

## Task 6: Discord sink (turn events → throttled message edits)

**Files:**
- Create: `src/lib/discord-sink.ts`

**Interfaces:**
- Consumes: `chunkReply` (Task 4); discord.js `TextChannel`/`Message`.
- Produces: `createDiscordSink(channel: SendableChannel): { emit: TurnEmit; finalize: () => Promise<void> }` where `TurnEmit = (e: { type: string; [k: string]: unknown }) => void`. `emit` is passed to `runSessionTurn`; `finalize` flushes the last edit after the turn returns.

- [ ] **Step 1: Write the sink**

Create `src/lib/discord-sink.ts`:
```ts
import 'server-only';
import type { Message, TextBasedChannel } from 'discord.js';
import { chunkReply } from './discord-format';

type SendableChannel = TextBasedChannel & {
  send: (content: string) => Promise<Message>;
};

const THROTTLE_MS = 1200;
const THINKING = '💭 …';

/**
 * Adapts runSessionTurn's emit stream to Discord. Posts a placeholder, accumulates
 * `token` content, and edits the message at most every ~1.2s (well under Discord's
 * rate limits). On `error` it shows the failure. finalize() flushes the last state
 * and spills overflow (>2000 chars) into follow-up messages. Never throws into the turn.
 */
export function createDiscordSink(channel: SendableChannel) {
  let buffer = '';
  let message: Message | null = null;
  let lastEditAt = 0;
  let errored: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  const ensureMessage = async () => {
    if (!message) message = await channel.send(THINKING);
    return message;
  };

  const render = async () => {
    try {
      const text = errored ? `⚠️ turn failed: ${errored}` : buffer.trim() || THINKING;
      const [first] = chunkReply(text);
      const msg = await ensureMessage();
      await msg.edit(first);
      lastEditAt = Date.now();
    } catch (err) {
      console.error('[discord] render failed:', err instanceof Error ? err.message : err);
    }
  };

  const queue = (fn: () => Promise<void>) => {
    chain = chain.then(fn, fn);
    return chain;
  };

  const emit = (e: { type: string; [k: string]: unknown }) => {
    if (e.type === 'token' && typeof e.content === 'string') {
      buffer += e.content;
      if (Date.now() - lastEditAt >= THROTTLE_MS) void queue(render);
    } else if (e.type === 'error' && typeof e.message === 'string') {
      errored = e.message;
      void queue(render);
    }
  };

  const finalize = async () => {
    await chain;
    await render();
    await chain;
    // Spill any overflow beyond the first 2000-char chunk into follow-up messages.
    if (!errored) {
      const chunks = chunkReply(buffer.trim() || THINKING);
      for (const extra of chunks.slice(1)) {
        try {
          await channel.send(extra);
        } catch (err) {
          console.error('[discord] overflow send failed:', err instanceof Error ? err.message : err);
        }
      }
    }
  };

  return { emit, finalize };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/discord-sink.ts
git commit -m "feat(discord): turn-event sink with throttled message edits"
```

---

## Task 7: The bot — client, slash commands, chat handler

**Files:**
- Create: `src/lib/discord-bot.ts`

**Interfaces:**
- Consumes: `parseAllowedIds`/`isAllowed` (Task 3); `getBinding`/`setBinding`/`removeBinding`/`findProjectByName` (Task 5); `getActiveSessionId` (Task 5); `createDiscordSink` (Task 6); `runSessionTurn` (`@/lib/run-turn`).
- Produces: `startDiscordBot(): void` — idempotent, no-op unless `DISCORD_BOT_TOKEN` is set.

- [ ] **Step 1: Write the bot**

Create `src/lib/discord-bot.ts`:
```ts
import 'server-only';
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
  type Interaction,
  type Message,
} from 'discord.js';
import { parseAllowedIds, isAllowed } from './discord-allow';
import {
  getBinding,
  setBinding,
  removeBinding,
  findProjectByName,
} from './discord-bindings';
import { getActiveSessionId } from './discord-session';
import { createDiscordSink } from './discord-sink';
import { runSessionTurn } from './run-turn';

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('mc')
    .setDescription('Mission Control')
    .addSubcommand((s) =>
      s
        .setName('bind')
        .setDescription('Bind this channel to a project')
        .addStringOption((o) =>
          o.setName('project').setDescription('Project name').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('unbind').setDescription('Unbind this channel'))
    .addSubcommand((s) => s.setName('status').setDescription('Show this channel’s binding'))
    .toJSON(),
];

async function registerCommands(appId: string, token: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: COMMANDS });
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: COMMANDS });
  }
}

export function startDiscordBot(): void {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return; // bot disabled
  const g = globalThis as unknown as { __mcDiscordStarted?: boolean };
  if (g.__mcDiscordStarted) return;
  g.__mcDiscordStarted = true;

  const appId = process.env.DISCORD_APP_ID ?? '';
  const guildId = process.env.DISCORD_GUILD_ID || undefined;
  const allowed = parseAllowedIds(process.env.DISCORD_ALLOWED_USER_IDS);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    try {
      if (appId) await registerCommands(appId, token, guildId);
    } catch (err) {
      console.error('[discord] command registration failed:', err instanceof Error ? err.message : err);
    }
  });

  client.on(Events.InteractionCreate, (i) => void handleInteraction(i, allowed));
  client.on(Events.MessageCreate, (m) => void handleMessage(m, allowed));
  client.on(Events.Error, (err) => console.error('[discord] client error:', err.message));

  client.login(token).catch((err) =>
    console.error('[discord] login failed:', err instanceof Error ? err.message : err),
  );
}

async function handleInteraction(interaction: Interaction, allowed: Set<string>): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (!isAllowed(interaction.user.id, allowed)) {
      await interaction.reply({ content: 'Not authorized.', flags: MessageFlags.Ephemeral });
      return;
    }
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;
    if (sub === 'bind') {
      const name = interaction.options.getString('project', true);
      const project = await findProjectByName(name);
      if (!project) {
        await interaction.reply({ content: `No project named “${name}”.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await setBinding(channelId, project.id);
      await interaction.reply(`Bound this channel to **${project.name}**.`);
    } else if (sub === 'unbind') {
      await removeBinding(channelId);
      await interaction.reply('Unbound this channel.');
    } else if (sub === 'status') {
      const b = await getBinding(channelId);
      await interaction.reply(b ? `Bound to project \`${b.project_id}\`.` : 'Not bound.');
    }
  } catch (err) {
    console.error('[discord] interaction failed:', err instanceof Error ? err.message : err);
  }
}

async function handleMessage(message: Message, allowed: Set<string>): Promise<void> {
  try {
    if (message.author.bot) return;
    if (!isAllowed(message.author.id, allowed)) return; // silently ignore
    const text = message.content.trim();
    if (!text) return;
    const binding = await getBinding(message.channelId);
    if (!binding) return; // unbound channel → ignore

    const channel = message.channel;
    if (!('send' in channel) || typeof channel.send !== 'function') return;

    const sessionId = await getActiveSessionId(binding.project_id);
    const sink = createDiscordSink(channel as Parameters<typeof createDiscordSink>[0]);
    const result = await runSessionTurn(sessionId, { instruction: text, emit: sink.emit });
    if (result.status === 'skipped') {
      await channel.send('⏳ A turn is already running for this project — try again in a moment.');
      return;
    }
    await sink.finalize();
  } catch (err) {
    console.error('[discord] message handler failed:', err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm exec tsc --noEmit && pnpm build`
Expected: no type errors; build completes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/discord-bot.ts
git commit -m "feat(discord): gateway bot — slash commands + allowlisted chat handler"
```

---

## Task 8: Wire startDiscordBot into the boot hook

**Files:**
- Modify: `src/instrumentation.ts`

**Interfaces:**
- Consumes: `startDiscordBot` (Task 7); existing `startScheduler`, `startDreaming`.

- [ ] **Step 1: Add the starter**

Edit `src/instrumentation.ts` — inside the `if (process.env.NEXT_RUNTIME === 'nodejs')` block, after `startDreaming();`:
```ts
    const { startDiscordBot } = await import('@/lib/discord-bot');
    startDiscordBot();
```
And update the file's top comment to mention the Discord bot alongside the Scheduler and Dreaming Curator.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: build completes; no errors.

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat(discord): start the bot at boot alongside the tickers"
```

---

## Task 9: Runtime verification (the `verify` skill)

**Files:** none (verification only).

This task uses the `verify` skill against a real private Discord guild. Prerequisites (operator, one-time): create a Discord app + bot, enable the **Message Content** privileged intent, invite it to a private guild with read/send/embed permissions, and set `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_ALLOWED_USER_IDS` (your ID), `DISCORD_GUILD_ID` in `.env`.

- [ ] **Step 1: Start the app and confirm the bot connects**

Run `pnpm dev`; expected log line: `[discord] logged in as <bot>#0000`. (If `DISCORD_BOT_TOKEN` is unset, confirm instead that NO `[discord]` line appears — the disabled path.)

- [ ] **Step 2: Bind a channel**

In a test channel, run `/mc bind project:<an existing project name>`. Expected: "Bound this channel to **<name>**." Confirm a `discord_bindings` row exists.

- [ ] **Step 3: Chat (happy path)**

Send "Sage, what can you do?" in the bound channel. Expected: a placeholder appears, then edits into Sage's streamed reply; a `user` message + an `agent` reply are persisted to that project's active session (visible in the web UI too).

- [ ] **Step 4: 🔍 Probe — non-allowlisted user is ignored**

From a second Discord account (not in `DISCORD_ALLOWED_USER_IDS`), send a message in the bound channel and run `/mc status`. Expected: the message is silently ignored (no turn runs); the slash command replies "Not authorized."

- [ ] **Step 5: 🔍 Probe — unbound channel is ignored**

Send a message in a channel with no binding. Expected: no reply, no turn.

- [ ] **Step 6: 🔍 Probe — long reply chunking**

Ask for something long ("list 60 ideas, one per line"). Expected: the reply spans multiple messages, none truncated mid-stream, each ≤ 2000 chars.

- [ ] **Step 7: Report** PASS/FAIL with captured evidence (logs + screenshots) per the `verify` skill.

---

## Self-Review

**Spec coverage (Phase 1 scope):**
- In-process gateway bot started in `instrumentation.ts`, token-gated, idempotent — Tasks 7, 8 ✓
- Channel-per-project mapping (`discord_bindings`, `/mc bind`) — Tasks 2, 5, 7 ✓
- Allowlist auth enforced on messages + interactions — Tasks 3, 7 ✓ (re-checked in both handlers)
- Chat via `runSessionTurn` + Discord sink with throttled edits + 2000-char chunking — Tasks 4, 6, 7 ✓
- `@mention` passthrough — handled inside `runSessionTurn` (instruction path), no Discord-side work ✓
- Error isolation (try/catch around startup + every handler) — Task 7 ✓
- Pure modules unit-tested; effectful bot verified at runtime — Tasks 3, 4, 9 ✓
- Deferred to follow-up plans (explicitly out of scope here): notifications (Phase 2), merge/discard buttons (Phase 3), `/mc new-session`.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output.

**Type consistency:** `parseAllowedIds`/`isAllowed` (Task 3) consumed in Task 7; `chunkReply` (Task 4) consumed in Task 6; `getBinding`/`setBinding`/`removeBinding`/`findProjectByName` (Task 5) consumed in Task 7; `getActiveSessionId` (Task 5) consumed in Task 7; `createDiscordSink(channel) → { emit, finalize }` (Task 6) consumed in Task 7; `emit` matches `runSessionTurn`'s `TurnEmit` shape. Consistent.
