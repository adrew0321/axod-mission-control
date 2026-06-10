# Memory view — design

**Date:** 2026-06-09
**Status:** approved (design)
**Nav section:** `memory` (currently `soon` → flip to `live`)

## Summary

A **context inspector** for the active session: the System-group nav view that shows exactly
what's in Sage's working memory — the attributed transcript it receives, a size readout, the
clear boundary, and the **Clear memory** control as its home. It reuses the chat's
already-loaded messages, so there's almost no new backend.

"What Sage remembers" within a session is the chronological transcript built by
`buildOrchestratorPrompt` (`src/lib/conversation.ts`): Operator / agent-labelled blocks,
skipping `system` and empty messages, and only the messages after the session's `cleared_at`
marker. The Memory view surfaces that, framed as inspectable, sizeable, clearable context —
distinct from the chat, which renders the same messages as a pretty conversation.

## Decisions (locked during brainstorm)

1. **Active session only** (not a cross-session picker).
2. **Context-inspector framing**: attributed transcript + size readout + clear boundary.
3. **Clear control lives here** (reuses the existing `/api/sessions/[id]/clear` route).
4. No new route/query — reuse `mission-control`'s existing `messages`/`session`/clear handler.

## 1. Pure helper — `src/lib/memory.ts` (no db, no server-only; testable)

```ts
export interface MemoryMessageInput {
  role: 'user' | 'agent' | 'system';
  senderName?: string;
  content: string;
}

export interface MemoryBlock {
  label: string;   // "Operator" for user; else senderName (fallback "Agent")
  content: string;
}

export interface MemorySummary {
  blocks: MemoryBlock[];
  messageCount: number;   // counted blocks (system/empty excluded)
  approxTokens: number;   // ceil(total block chars / 4)
}

export function summarizeMemory(messages: MemoryMessageInput[]): MemorySummary;
```

- Skips `role === 'system'` and empty/whitespace `content` (matches `buildOrchestratorPrompt`,
  so the count and size reflect what Sage actually receives).
- `label`: `'Operator'` for `user`; otherwise `senderName` (or `'Agent'` if absent).
- `approxTokens = Math.ceil(totalChars / 4)` — a rough size heuristic, labelled `~` in the UI.

## 2. UI — `src/components/memory-view.tsx`

Props: `{ messages: Message[]; sessionTitle: string; clearedAt: string | null; onClear: () => Promise<void> | void }`
(`Message` is the existing UI type from `@/lib/mock-data`).

- Rendered when `activeSection === "memory"` — a new branch alongside the Skills / Proposals /
  Task Board / Live Feed / Agent Team switch in `mission-control.tsx`. Flip `memory` →
  `status: 'live'` in `src/lib/nav-sections.ts` and update the nav test (live set gains `'memory'`).
- Computes `summarizeMemory(messages)` for the blocks + stats.
- Layout (themed mono + Georgia, `h-11` header):
  - Header: "Memory" + subtitle "what Sage remembers this session".
  - Stats line: `{messageCount} messages in context · ~{approxTokens} tokens · session "{sessionTitle}"`.
    Tokens shown as e.g. `3.1k` when ≥ 1000.
  - When `clearedAt` is set: a one-line note "Memory was cleared earlier — showing context since."
  - The attributed transcript: each block as `label` (colored: Operator = cyan, agents = muted)
    then its `content` (preserve line breaks, muted).
  - A **Clear memory** button with an inline confirm ("Clear Sage's memory for this session?
    Messages are archived, not deleted." → Yes/No) → calls `onClear`.
  - Empty state (no blocks): "Sage has no memory yet this session."

## 3. Data flow

No new route or query. In `mission-control.tsx`, the `memory` branch renders:

```tsx
<MemoryView
  messages={messages}
  sessionTitle={session.title}
  clearedAt={session.clearedAt ?? null}
  onClear={handleClearLog}
/>
```

- `messages` is the live state already maintained for the chat (server-filtered by `cleared_at`
  in `page.tsx`); the Memory view stays in sync as messages arrive or are cleared.
- `handleClearLog` already exists (POSTs `/api/sessions/[id]/clear`, then empties `messages`).
- **One page.tsx change:** add `clearedAt` to the session prop —
  `clearedAt: currentSessionRow.cleared_at ? currentSessionRow.cleared_at.toISOString() : null` —
  and add an optional `clearedAt?: string | null` to the `Session` type in `src/lib/mock-data`.

## 4. Error handling

- Clear failure is already handled by `handleClearLog` (sets `sendError`); the inline confirm
  prevents accidental clears. After a successful clear, `messages` is `[]` → the empty state shows.
- Unknown/agent-less messages render with the `'Agent'` fallback label; never crashes.

## 5. Testing

- Pure unit tests (`src/lib/memory.test.ts`): `summarizeMemory` filters system + empty,
  labels Operator vs agent (senderName, and the `'Agent'` fallback), counts blocks, and computes
  `approxTokens` from total chars. UI/clear are integration (the view renders props + calls the
  existing handler).

## Out of scope (later)

Cross-session memory / a knowledge graph (v2) · a session picker · editing or pinning memory ·
the raw-prompt copy view · accurate tokenizer counts (the `~/4` heuristic is enough for a gauge).

## What actually happened (2026-06-10)

Shipped per spec on `feature/memory` (inline execution). Build clean, `pnpm test` **95/95**
(91 + 4 `summarizeMemory`). No deviations — it reused `mission-control`'s existing `messages`
state, `session`, and `handleClearLog`; the only backend change was adding `clearedAt` to the
session prop. Released to `main` as part of **v1.6.0** (with Proposals + Skills).
