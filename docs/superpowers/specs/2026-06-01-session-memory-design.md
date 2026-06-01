# Orchestrator Session Memory Design

**Date:** 2026-06-01
**Branch:** `feature/session-memory` (off `dev`, independent of `feature/echo-qa-agent`)
**Scope:** Give Sage memory of the conversation *within a session*. Today the orchestrator only ever receives the single most-recent operator message, so it treats every turn as the start of a new conversation ("this appears to be the start of our conversation"). After this change, Sage receives the full session transcript each turn.

---

## Root cause

`src/app/api/sessions/[id]/stream/route.ts` selects only the **last user message** (`role = 'user'`, `order by created_at desc, limit 1`) and passes `lastUserMessage.content` as the entire prompt to `runClaudeAgent` for Sage. No prior turns are included. The runner (`src/lib/agent-runner-sdk.ts`) takes a single `prompt: string` and captures no SDK session id, so there is no existing history mechanism.

The DB is already the source of truth for the conversation — `page.tsx` rebuilds the whole thread from the `messages` table on every load. The fix leans on that: rebuild the orchestrator's prompt from the DB.

## Decisions (operator-approved 2026-06-01)

1. **Rebuild from the DB** (not SDK session-resume). The `messages` table is authoritative and already replayed on reload; building the prompt from it survives page reloads, server restarts, and the upcoming VPS deploy, and avoids drift between SDK-managed history and our DB. (SDK resume keeps state in the CLI's on-disk store — ephemeral, lost on restart, and awkward across the nested-dispatch architecture.)
2. **Full thread, including specialists.** Sage sees operator messages, its own replies, AND what Atlas/Echo did in earlier turns — so a follow-up like "keep the Hero.astro changes" lands in full context.
3. **No history cap** for v1 (sessions are short, solo operator). Accepted tradeoff: prompt tokens grow over a long session, mitigated by the API's prompt caching. A message-count or token cap is a trivial later refinement.
4. **Within-session only.** Cross-session recall remains the deferred v2.2 "memory knowledge graph."

## Architecture

### 1. Pure transcript builder — `src/lib/conversation.ts` (new)

```ts
export interface TranscriptMessage {
  role: 'user' | 'agent' | 'system';
  agentId?: string | null;
  content: string;
}

/**
 * Render a session's stored messages into an attributed transcript prompt for
 * the orchestrator. `agentLabels` maps an agentId to a display label, e.g.
 * { atlas: 'Atlas (developer)', echo: 'Echo (qa)', sage: 'Sage' }.
 */
export function buildOrchestratorPrompt(
  messages: TranscriptMessage[],
  agentLabels: Record<string, string>,
): string;
```

**Behavior (the testable logic):**
- Iterate messages **in the order given** (the route passes them chronologically).
- Skip `role === 'system'` messages (UI notices: stop/error/approval banners — not conversation) and any message whose `content` is empty/whitespace.
- Label each retained message:
  - `role === 'user'` → `Operator`
  - `role === 'agent'` → `agentLabels[agentId]` if present, else `agentId` if present, else `Agent`
- Join as `"<Label>: <content>"` blocks separated by a blank line.
- Prepend a framing header so the model treats it as the running thread:
  > `This is the ongoing conversation for the current session. Reply to the latest Operator message below, using the full context of the conversation.`
- If there are no retained messages (shouldn't happen — the new user message is always present), return just the new content/header gracefully (the builder never throws).

This is pure (no IO) → unit-tested in `src/lib/conversation.test.ts` per the project's `node:test`/tsx convention.

### 2. Stream route — `src/app/api/sessions/[id]/stream/route.ts`

- Replace "fetch last user message" with "fetch **all** messages for the session, chronological" (`order by created_at asc, rowid asc` — mirroring `page.tsx`'s tie-break so a dispatch turn keeps Sage-pre → specialist → Sage-post order).
- Keep a check that the latest message is from the operator (there is a prompt to respond to); otherwise return the existing 400.
- Build `agentLabels` from the `agents` table (`id → "<name> (<role>)"`; Sage → just `Sage`). The route already loads Sage; extend to load all agents (one `select` from `agents`).
- Map the rows to `TranscriptMessage[]`, call `buildOrchestratorPrompt`, and pass the result as `prompt` to `runClaudeAgent` for Sage. Everything else (system prompt, tools, dispatch MCP server, SSE streaming, persistence) is unchanged.

### 3. Specialists unchanged

Atlas and Echo still receive a self-contained task brief from Sage via `dispatch_agent` (not the full transcript) — by design. Only the orchestrator needs the running thread. `dispatch.ts` is untouched.

### 4. No system-prompt change

The transcript's framing header is self-explanatory; `SAGE_SYSTEM_PROMPT` already establishes Sage as the orchestrator. (Avoids re-seeding for this change.)

## Data flow

```
operator sends message
  → POST /messages inserts the user row
  → GET /stream:
      fetch ALL session messages (asc, rowid tie-break)
      fetch agents → build agentLabels
      buildOrchestratorPrompt(messages, agentLabels)  →  transcript string
      runClaudeAgent({ prompt: transcript, systemPrompt: sage.system_prompt, ... })
      stream tokens / dispatch events to SSE
      persist Sage's reply  → becomes part of next turn's transcript
```

## Edge cases

- **First message of a session:** transcript = framing header + the single `Operator:` line. Sage responds fresh, correctly.
- **Empty/blank agent content:** skipped by the builder.
- **System rows (stops, errors, approval banners):** skipped — they aren't conversation.
- **Long session:** included in full (no cap, per decision); cost grows — acceptable for v1.

## Out of scope

History caps (message-count or token-budget) · SDK session-resume · cross-session memory / knowledge graph · giving specialists the full transcript · summarizing/compacting old turns.

## Verification

- Unit: `pnpm test` includes new `conversation.test.ts` cases (Operator/agent labeling, system+empty skipped, chronological order, framing header, first-message case). Suite goes 39 → 39+N green.
- Build: `pnpm build` clean.
- Live: in a session, (1) ask Sage something, (2) send a follow-up that depends on the first ("now do X to that file") — Sage responds with continuity instead of "this is the start of our conversation." Reload the page mid-session and confirm memory persists (because it's rebuilt from the DB).

## What actually happened (2026-06-01)

Implemented as designed on `feature/session-memory`: pure `buildOrchestratorPrompt` (`src/lib/conversation.ts`, 5 unit tests) + the stream route fetching the whole conversation and passing the attributed transcript to Sage. `pnpm build` clean, `pnpm test` 44/44. Operator-confirmed live: Sage now carries context across turns (no more "this appears to be the start of our conversation"). No prompt-framing tweaks needed. Commits `f655a59` (builder+tests), `751f09c` (route).
