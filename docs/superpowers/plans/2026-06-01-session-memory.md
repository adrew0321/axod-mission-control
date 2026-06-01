# Orchestrator Session Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Sage the full session conversation each turn by rebuilding an attributed transcript from the DB and passing it as the orchestrator's prompt.

**Architecture:** A new pure builder (`src/lib/conversation.ts`) renders stored messages into a labeled transcript; the stream route fetches all session messages + agent labels and feeds the transcript to `runClaudeAgent` instead of just the last user message. Specialists and the runner interface are unchanged.

**Tech Stack:** TypeScript, Drizzle/better-sqlite3, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-06-01-session-memory-design.md`
**Branch:** `feature/session-memory` (already created off `dev`).

---

### Task 1: Pure transcript builder (TDD)

**Files:**
- Create: `src/lib/conversation.ts`
- Create (test): `src/lib/conversation.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/lib/conversation.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestratorPrompt, type TranscriptMessage } from './conversation';

const LABELS = { sage: 'Sage', atlas: 'Atlas (developer)', echo: 'Echo (qa)' };

test('labels operator and agents, preserves order', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'user', content: 'add a border' },
    { role: 'agent', agentId: 'sage', content: 'dispatching Atlas' },
    { role: 'agent', agentId: 'atlas', content: 'done, edited Hero.astro' },
    { role: 'user', content: 'keep the hero changes' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.match(out, /Operator: add a border/);
  assert.match(out, /Sage: dispatching Atlas/);
  assert.match(out, /Atlas \(developer\): done, edited Hero\.astro/);
  // order preserved: first user line precedes the atlas line
  assert.ok(out.indexOf('add a border') < out.indexOf('edited Hero.astro'));
  // ends with the latest operator message
  assert.ok(out.trimEnd().endsWith('Operator: keep the hero changes'));
});

test('includes the framing header', () => {
  const out = buildOrchestratorPrompt([{ role: 'user', content: 'hi' }], LABELS);
  assert.match(out, /ongoing conversation for the current session/i);
});

test('skips system rows and empty content', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'system', content: 'Atlas requested tool permissions' },
    { role: 'agent', agentId: 'sage', content: '   ' },
    { role: 'user', content: 'real message' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.doesNotMatch(out, /requested tool permissions/);
  assert.doesNotMatch(out, /Sage:/);
  assert.match(out, /Operator: real message/);
});

test('falls back to agentId when no label, and to Agent when no id', () => {
  const msgs: TranscriptMessage[] = [
    { role: 'agent', agentId: 'nova', content: 'researched X' },
    { role: 'agent', content: 'no id here' },
  ];
  const out = buildOrchestratorPrompt(msgs, LABELS);
  assert.match(out, /nova: researched X/);
  assert.match(out, /Agent: no id here/);
});

test('empty input returns just the header (no throw)', () => {
  const out = buildOrchestratorPrompt([], LABELS);
  assert.match(out, /ongoing conversation for the current session/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pnpm exec tsx --test src/lib/conversation.test.ts`
Expected: FAIL — cannot find module `./conversation` (not created yet).

- [ ] **Step 3: Implement the builder.** Create `src/lib/conversation.ts`:

```ts
/**
 * Builds the orchestrator's prompt from a session's stored messages — the fix
 * for Sage having no memory within a session. Pure: no IO, never throws.
 * See docs/superpowers/specs/2026-06-01-session-memory-design.md.
 */

export interface TranscriptMessage {
  role: 'user' | 'agent' | 'system';
  agentId?: string | null;
  content: string;
}

const FRAMING_HEADER =
  'This is the ongoing conversation for the current session. Reply to the latest Operator message below, using the full context of the conversation.';

/**
 * Render messages (in the order given — caller passes them chronologically) into
 * an attributed transcript. `agentLabels` maps an agentId to a display label,
 * e.g. { sage: 'Sage', atlas: 'Atlas (developer)' }. System rows and
 * empty/whitespace content are skipped.
 */
export function buildOrchestratorPrompt(
  messages: TranscriptMessage[],
  agentLabels: Record<string, string>,
): string {
  const blocks: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const content = m.content?.trim();
    if (!content) continue;
    const label =
      m.role === 'user'
        ? 'Operator'
        : (m.agentId && agentLabels[m.agentId]) || m.agentId || 'Agent';
    blocks.push(`${label}: ${content}`);
  }
  if (blocks.length === 0) return FRAMING_HEADER;
  return `${FRAMING_HEADER}\n\n${blocks.join('\n\n')}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `pnpm exec tsx --test src/lib/conversation.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run the full suite to confirm nothing else broke.**

Run: `pnpm test`
Expected: `pass 44 / fail 0` (was 39 + 5 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/conversation.ts src/lib/conversation.test.ts
git commit -m "feat(memory): pure orchestrator-transcript builder + tests"
```

---

### Task 2: Feed the transcript to Sage in the stream route

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts`

- [ ] **Step 1: Update imports.** Replace the drizzle import (line 2) and add the conversation import. Change line 2 from:

```ts
import { and, desc, eq } from 'drizzle-orm';
```

to:

```ts
import { asc, eq, sql } from 'drizzle-orm';
```

Then add after the existing `@/lib/...` imports (e.g. after line 11):

```ts
import { buildOrchestratorPrompt, type TranscriptMessage } from '@/lib/conversation';
```

(`and`/`desc` are no longer used once Step 2 lands — removing them from the import avoids an unused-import lint error.)

- [ ] **Step 2: Fetch the whole conversation instead of just the last user message.** Replace the `lastUserMessage` block (lines 36–43):

```ts
  const lastUserMessage = await db
    .select()
    .from(messages)
    .where(and(eq(messages.session_id, sessionId), eq(messages.role, 'user')))
    .orderBy(desc(messages.created_at))
    .limit(1)
    .then((r) => r[0]);
  if (!lastUserMessage) return new Response('No user prompt to respond to', { status: 400 });
```

with:

```ts
  // Whole session, chronological (rowid tie-breaks a dispatch turn so it stays
  // Sage-pre → specialist → Sage-post — same ordering page.tsx uses).
  const conversation = await db
    .select()
    .from(messages)
    .where(eq(messages.session_id, sessionId))
    .orderBy(asc(messages.created_at), asc(sql`rowid`));
  const lastUserMessage = [...conversation].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) return new Response('No user prompt to respond to', { status: 400 });
```

- [ ] **Step 3: Load all agents and build labels.** Replace the single-Sage fetch (lines 52–57):

```ts
  const sage = await db
    .select()
    .from(agents)
    .where(eq(agents.id, 'sage'))
    .limit(1)
    .then((r) => r[0]);
```

with:

```ts
  const allAgents = await db.select().from(agents);
  const sage = allAgents.find((a) => a.id === 'sage');
  const agentLabels: Record<string, string> = Object.fromEntries(
    allAgents.map((a) => [a.id, a.id === 'sage' ? 'Sage' : `${a.name} (${a.role})`]),
  );
  const transcript = buildOrchestratorPrompt(
    conversation.map((m): TranscriptMessage => ({
      role: m.role as TranscriptMessage['role'],
      agentId: m.agent_id,
      content: m.content,
    })),
    agentLabels,
  );
```

- [ ] **Step 4: Pass the transcript as Sage's prompt.** In the `runClaudeAgent({ ... })` call, change the `prompt` line (line 149):

```ts
          prompt: lastUserMessage.content,
```

to:

```ts
          prompt: transcript,
```

- [ ] **Step 5: Verify the build is clean.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` — no type errors, no unused-import errors (`and`/`desc` removed, `asc`/`sql` used).

- [ ] **Step 6: Commit.**

```bash
git add "src/app/api/sessions/[id]/stream/route.ts"
git commit -m "feat(memory): feed full session transcript to Sage in the stream route"
```

---

### Task 3: Full verification + live smoke

**Files:** none

- [ ] **Step 1: Build + full test suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `pass 44 / fail 0`.

- [ ] **Step 2: Live continuity smoke (operator-run).** With `pnpm dev` running and logged in:
  1. Ask Sage something concrete (e.g. "what files are in src/components?").
  2. Send a follow-up that only makes sense with memory (e.g. "summarize the first one you listed").
  3. Confirm Sage answers with continuity — no "this appears to be the start of our conversation."
  4. Reload the page mid-session and send another dependent follow-up; confirm memory persists (it's rebuilt from the DB, so it should).

- [ ] **Step 3: Note the result** in the spec's wrap-up (any prompt-framing tweaks needed if Sage over- or under-uses the history).

---

## Wrap-up (after Task 3 passes)

- [ ] Add a short "what actually happened" note to `docs/superpowers/specs/2026-06-01-session-memory-design.md`.
- [ ] Integrate `feature/session-memory` → `dev` (operator confirms), independent of the Echo branch.

## Self-review (done at authoring)

- **Spec coverage:** builder + behavior (skip system/empty, labeling, framing, order) → Task 1; route fetch-all + labels + transcript + prompt swap → Task 2; unit + build + live verification → Tasks 1/3. Specialists/runner/system-prompt unchanged → reflected (untouched). No gaps.
- **Placeholders:** none. The framing-header match `/ongoing conversation for the current session/i` is asserted against the real string in `conversation.ts`.
- **Consistency:** `buildOrchestratorPrompt(messages, agentLabels)`, `TranscriptMessage` (`role`/`agentId`/`content`), and the `FRAMING_HEADER` text are identical across the test, the implementation, and the route. The route maps DB `agent_id` → `TranscriptMessage.agentId`.
