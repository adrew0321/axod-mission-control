# `@`-Mention Direct Addressing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A leading `@<agent>` in the operator's message routes the turn straight to that specialist (bypassing Sage), running it in the worktree with the full transcript and no dispatch tool.

**Architecture:** A shared pure `parseMention` picks the target. The stream route runs a "primary" agent (the `@`-addressed specialist, else Sage); the dispatch MCP server attaches only on the Sage path. The client renders the streaming bubble as the primary agent. No mention / unrecognized mention → Sage, unchanged.

**Tech Stack:** TypeScript, Claude Agent SDK, Drizzle, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-06-01-at-mention-routing-design.md`
**Branch:** `feature/at-mention-routing` (already created off `dev`).

---

### Task 1: Pure `parseMention` (TDD)

**Files:**
- Create: `src/lib/mention.ts`
- Create (test): `src/lib/mention.test.ts`

- [ ] **Step 1: Write the failing tests.** Create `src/lib/mention.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMention } from './mention';

const AGENTS = [
  { id: 'sage', name: 'Sage' },
  { id: 'atlas', name: 'Atlas' },
  { id: 'echo', name: 'Echo' },
];

test('matches @id case-insensitively and strips the mention', () => {
  assert.deepEqual(parseMention('@Atlas dial it down', AGENTS), { agentId: 'atlas', text: 'dial it down' });
  assert.deepEqual(parseMention('@atlas go', AGENTS), { agentId: 'atlas', text: 'go' });
  assert.deepEqual(parseMention('@ECHO review', AGENTS), { agentId: 'echo', text: 'review' });
});

test('matches by first word of the name', () => {
  const agents = [{ id: 'echo', name: 'Echo Critic' }];
  assert.equal(parseMention('@Echo look', agents).agentId, 'echo');
});

test('no mention → null, text unchanged', () => {
  assert.deepEqual(parseMention('just do the thing', AGENTS), { agentId: null, text: 'just do the thing' });
});

test('mention must be leading', () => {
  assert.equal(parseMention('do it @Atlas now', AGENTS).agentId, null);
});

test('unrecognized @ → null, text unchanged (goes verbatim to Sage)', () => {
  assert.deepEqual(parseMention('@nobody hi', AGENTS), { agentId: null, text: '@nobody hi' });
});

test('bare @ → null', () => {
  assert.equal(parseMention('@ hi', AGENTS).agentId, null);
});

test('mention with no task → empty text', () => {
  assert.deepEqual(parseMention('@Atlas', AGENTS), { agentId: 'atlas', text: '' });
});
```

- [ ] **Step 2: Run tests, verify they fail.**

Run: `pnpm exec tsx --test src/lib/mention.test.ts`
Expected: FAIL — cannot find module `./mention`.

- [ ] **Step 3: Implement.** Create `src/lib/mention.ts`:

```ts
/**
 * Parses a leading "@<agent>" mention so the operator can address a specialist
 * directly (bypassing Sage). Pure; never throws.
 * See docs/superpowers/specs/2026-06-01-at-mention-routing-design.md.
 */

export interface MentionAgent {
  id: string;
  name: string;
}

export interface ParsedMention {
  /** Matched agent id, or null → route to Sage. */
  agentId: string | null;
  /** The message with a leading mention removed (original text when no match). */
  text: string;
}

/**
 * Match a LEADING "@<token>" (case-insensitive) against each agent's id or the
 * first word of its name. Absent or unrecognized mention → { agentId: null }.
 */
export function parseMention(text: string, agents: MentionAgent[]): ParsedMention {
  const m = /^\s*@(\S+)\s*/.exec(text);
  if (!m) return { agentId: null, text };
  const token = m[1].toLowerCase();
  const match = agents.find(
    (a) => a.id.toLowerCase() === token || a.name.toLowerCase().split(/\s+/)[0] === token,
  );
  if (!match) return { agentId: null, text };
  return { agentId: match.id, text: text.slice(m[0].length) };
}
```

- [ ] **Step 4: Run tests, verify pass.**

Run: `pnpm exec tsx --test src/lib/mention.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Full suite.**

Run: `pnpm test`
Expected: `pass 51 / fail 0` (44 + 7 new).

- [ ] **Step 6: Commit.**

```bash
git add src/lib/mention.ts src/lib/mention.test.ts
git commit -m "feat(mention): pure leading-@ parser + tests"
```

---

### Task 2: Route the turn to the addressed agent (stream route)

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts`

- [ ] **Step 1: Import the parser.** Add after the existing `@/lib/conversation` import:

```ts
import { parseMention } from '@/lib/mention';
```

- [ ] **Step 2: Pick the primary agent.** Immediately after the `transcript` is built (after the `buildOrchestratorPrompt(...)` block), add:

```ts
  // Direct addressing: a leading "@<agent>" routes the turn to that specialist
  // (bypassing Sage). No / unrecognized mention → Sage. A directly-addressed
  // specialist gets NO dispatch tool (only Sage orchestrates).
  const { agentId: mentionId } = parseMention(lastUserMessage.content, allAgents);
  const addressed = mentionId && mentionId !== 'sage' ? allAgents.find((a) => a.id === mentionId) : undefined;
  const primary = addressed ?? sage;
  const primaryId = primary?.id ?? 'sage';
```

- [ ] **Step 3: Generalize the buffer/flush from Sage to the primary agent.** Replace the buffer block:

```ts
        let sageBuffer = '';
        let sageEmitted = false;
        let costUsd: number | undefined;
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        const flushSage = async (usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number }) => {
          if (!sageBuffer.trim()) return;
          const now = new Date();
          await db.insert(messages).values({
            id: `msg_${bytesToHex(randomBytes(8))}`,
            session_id: sessionId,
            agent_id: 'sage',
            role: 'agent',
            content: sageBuffer,
            token_count_in: usage?.tokensIn,
            token_count_out: usage?.tokensOut,
            cost_usd: usage?.costUsd,
            created_at: now,
          });
          sageBuffer = '';
          sageEmitted = true;
        };
```

with:

```ts
        // The primary agent's text accumulates here. On the Sage path it's flushed
        // at each dispatch boundary (Sage-pre → specialist → Sage-post); a directly
        // addressed specialist has no dispatch, so it's just flushed once at the end.
        let primaryBuffer = '';
        let primaryEmitted = false;
        let costUsd: number | undefined;
        let tokensIn: number | undefined;
        let tokensOut: number | undefined;

        const flushPrimary = async (usage?: { costUsd?: number; tokensIn?: number; tokensOut?: number }) => {
          if (!primaryBuffer.trim()) return;
          const now = new Date();
          await db.insert(messages).values({
            id: `msg_${bytesToHex(randomBytes(8))}`,
            session_id: sessionId,
            agent_id: primaryId,
            role: 'agent',
            content: primaryBuffer,
            token_count_in: usage?.tokensIn,
            token_count_out: usage?.tokensOut,
            cost_usd: usage?.costUsd,
            created_at: now,
          });
          primaryBuffer = '';
          primaryEmitted = true;
        };
```

- [ ] **Step 4: Attach the dispatch server only on the Sage path.** Replace `const dispatchServer = createDispatchServer({` with:

```ts
        const dispatchServer = addressed
          ? null
          : createDispatchServer({
```

and change that call's `onBeforeDispatch: () => flushSage(),` to `onBeforeDispatch: () => flushPrimary(),`. (The `})` that closes `createDispatchServer({...})` now closes the conditional — leave it as `});`.)

- [ ] **Step 5: Run the primary agent (its model/prompt/tools; dispatch only when present).** Replace the `runClaudeAgent({ ... })` option head:

```ts
        for await (const event of runClaudeAgent({
          prompt: transcript,
          workingDir,
          model: sage?.model,
          systemPrompt: sage?.system_prompt,
          allowedTools: sage?.tools_allowlist ?? undefined,
          mcpServers: { [DISPATCH_SERVER_NAME]: dispatchServer },
          extraAllowedTools: [DISPATCH_TOOL_NAME],
          // The dispatch_agent MCP call blocks while Atlas works — well past the
          // 60s default SDK stream-close timeout. Give it 10 minutes.
          extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' },
          signal: req.signal, // operator "Stop" closes the EventSource → aborts the SDK
        })) {
```

with:

```ts
        for await (const event of runClaudeAgent({
          prompt: transcript,
          workingDir,
          model: primary?.model,
          systemPrompt: primary?.system_prompt,
          allowedTools: primary?.tools_allowlist ?? undefined,
          ...(dispatchServer
            ? {
                mcpServers: { [DISPATCH_SERVER_NAME]: dispatchServer },
                extraAllowedTools: [DISPATCH_TOOL_NAME],
              }
            : {}),
          // The dispatch_agent MCP call blocks while a specialist works — well past
          // the 60s default SDK stream-close timeout. Harmless for a direct agent.
          extraEnv: { CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '600000' },
          signal: req.signal, // operator "Stop" closes the EventSource → aborts the SDK
        })) {
```

- [ ] **Step 6: Tag the loop's events with the primary agent.** Inside the loop, make these three replacements:
  - `const term = toTerminalEvent(event, 'sage');` → `const term = toTerminalEvent(event, primaryId);`
  - `sageBuffer += event.content;` → `primaryBuffer += event.content;`
  - `sseEncode({ type: 'activity', agent_id: 'sage', tool: event.name, input: event.input }),` → `sseEncode({ type: 'activity', agent_id: primaryId, tool: event.name, input: event.input }),`
  - `if (!sageBuffer && event.fullText) sageBuffer = event.fullText;` → `if (!primaryBuffer && event.fullText) primaryBuffer = event.fullText;`

- [ ] **Step 7: Update the closing flush.** Replace:

```ts
        await flushSage({ costUsd, tokensIn, tokensOut });
        if (sageEmitted) {
```

with:

```ts
        await flushPrimary({ costUsd, tokensIn, tokensOut });
        if (primaryEmitted) {
```

- [ ] **Step 8: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` + `Finished TypeScript` — no type errors, no remaining `sageBuffer`/`flushSage`/`sageEmitted` references.

- [ ] **Step 9: Commit.**

```bash
git add "src/app/api/sessions/[id]/stream/route.ts"
git commit -m "feat(mention): route @-addressed turns to the specialist (no dispatch tool)"
```

---

### Task 3: Render the streaming turn as the addressed agent (client)

**Files:**
- Modify: `src/components/mission-control.tsx` (`handleSendMessage`)

- [ ] **Step 1: Import the parser.** Add with the other `@/lib/...` imports:

```ts
import { parseMention } from "@/lib/mention";
```

- [ ] **Step 2: Compute the primary agent.** In `handleSendMessage`, right after `const text = inputText.trim(); if (!text) return;`, add:

```ts
    const { agentId: mentionId } = parseMention(text, team);
    const primary =
      (mentionId && mentionId !== "sage" && team.find((a) => a.id === mentionId)) ||
      team.find((a) => a.id === "sage");
    const primaryId = primary?.id ?? "sage";
    const primaryName = primary?.name ?? "Sage";
```

- [ ] **Step 3: Set working state for the primary agent.** Replace:

```ts
    setWorkingAgents(["sage"]);
    setAgentActivity({ sage: "Charting the course…" });
```

with:

```ts
    setWorkingAgents([primaryId]);
    setAgentActivity({ [primaryId]: primaryId === "sage" ? "Charting the course…" : "On it…" });
```

- [ ] **Step 4: Make the streaming bubble the primary agent.** In the `setMessages` that adds the streaming bubble, replace its `agentId: "sage"` and `senderName: "Sage"` with:

```ts
          agentId: primaryId,
          senderName: primaryName,
```

- [ ] **Step 5: Rename the streaming-bubble tracker for clarity.** This var now holds the *primary* bubble id, which may be a specialist. Replace all occurrences of `currentSageId` with `currentPrimaryId` (there are 4: the `let currentSageId = streamingId;` declaration, the reassignment inside the post-dispatch `pendingNewSageBubble` branch, `const sageId = currentSageId;` in the token handler, and `const cardSageId = currentSageId;` in the dispatch-start handler). Also update the adjacent comment that says "The Sage bubble currently receiving tokens" to "The primary bubble currently receiving tokens".

  (Leave `pendingNewSageBubble` as-is — that path only fires on a dispatch, which only happens on the Sage turn.)

- [ ] **Step 6: Verify the build.**

Run: `pnpm build`
Expected: `✓ Compiled successfully` — no type errors, no remaining `currentSageId`.

- [ ] **Step 7: Commit.**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(mention): client renders @-addressed turn as the target agent"
```

---

### Task 4: Full verification + live smoke

**Files:** none

- [ ] **Step 1: Build + full suite.**

Run: `pnpm build && pnpm test`
Expected: build clean; `pass 51 / fail 0`.

- [ ] **Step 2: Live smoke (operator-run).** With `pnpm dev` running, logged in:
  1. `@Atlas add a one-line comment to the top of any source file` → an **Atlas** bubble (no "via Sage") makes the edit, visible in the Code diff. No Sage turn precedes it.
  2. Follow up `@Atlas what did you just change?` → Atlas answers with context (full transcript).
  3. `@Echo review the last change` → an **Echo** bubble reviews directly with a verdict.
  4. A plain message (no `@`) still routes to **Sage**, and Sage can still dispatch.
  5. `@nobody hello` → **Sage** handles it (treats it as normal text).

- [ ] **Step 3: Note the result** in the spec wrap-up (any surprises: does a directly-addressed Atlas stay on task without Sage's framing?).

---

## Wrap-up (after Task 4 passes)

- [ ] Add a "what actually happened" note to `docs/superpowers/specs/2026-06-01-at-mention-routing-design.md`.
- [ ] Integrate `feature/at-mention-routing` → `dev` (operator confirms).

## Self-review (done at authoring)

- **Spec coverage:** parser (leading-only, id/first-name, case-insensitive, unmatched/absent → null, strip) → Task 1; primary-agent selection + conditional dispatch server + primary model/prompt/tools + persist-as-primary + event tagging → Task 2; client bubble/status/token-routing as primary → Task 3; unit + build + live (incl. `@nobody` → Sage, plain → Sage+dispatch) → Tasks 1/4. No gaps.
- **Placeholders:** none. `<id>` route path segment is the real Next.js folder name.
- **Consistency:** `parseMention(text, agents) → { agentId, text }`, `MentionAgent {id,name}`, `primary`/`primaryId`/`primaryName`, and the `sageBuffer→primaryBuffer` / `flushSage→flushPrimary` / `sageEmitted→primaryEmitted` / `currentSageId→currentPrimaryId` renames are applied consistently in every task that references them.
```
