# `@`-Mention Direct Addressing Design

**Date:** 2026-06-01
**Branch:** `feature/at-mention-routing` (off `dev`)
**Scope:** Let the operator address a team member directly by starting a message with `@<AgentName>`. The turn runs **straight to that agent**, bypassing Sage — for tight iteration on a specialist's work. Today every message runs Sage; the placeholder already advertises `@Atlas` but it isn't wired (Sage just interprets it).

Implements the "Direct addressing (`@Atlas`)" section of `docs/architecture/team-of-agents.md`.

---

## Behavior

- `@Atlas dial the marching-ants speed down 25%` → runs **Atlas** directly, in the session worktree, with its own tools. Atlas's edits show in the Code diff exactly as when dispatched. No "via Sage" attribution.
- `@Echo review the last change` → runs **Echo** directly.
- A plain message (no `@`), or an **unrecognized** `@foo`, runs **Sage** as today (forgiving — no error).
- The addressed agent receives the **full session transcript** (same builder Sage uses), so `@Atlas what was the last thing you did` and follow-ups like `@Atlas tweak that` work with context. (Operator-approved.)
- Directly-addressed specialists get **no dispatch capability** (only Sage can dispatch; no sub-dispatch / recursion).

## Decisions (operator-approved 2026-06-01)

1. **Leading `@` only.** The mention must start the message (so "ping me @ 5pm" doesn't trigger).
2. **Unrecognized `@` → Sage.** Forgiving fallthrough, not an error.
3. **No Sage-notification of the bypass in v1.** The architecture doc mentions Sage "gets a notification"; that's a YAGNI nicety — deferred.
4. **Addressed agent gets the full transcript** (not just the typed line).

## Architecture

### 1. Pure parser — `src/lib/mention.ts` (new)

```ts
export interface MentionAgent { id: string; name: string }

export interface ParsedMention {
  agentId: string | null; // matched agent id, or null (→ route to Sage)
  text: string;           // the message with a leading mention removed
}

/**
 * Parse a leading "@<token>" against the known agents. Matches case-insensitively
 * against each agent's id or first word of its name. Leading-only; an unmatched or
 * absent mention yields { agentId: null, text: <original> }.
 */
export function parseMention(text: string, agents: MentionAgent[]): ParsedMention;
```

**Behavior (the testable logic):**
- Trim-inspect the start: if it doesn't begin with `@`, return `{ agentId: null, text }` (original).
- Take the token after `@` up to the first whitespace; lowercase it.
- Match against each agent's `id.toLowerCase()` or the first whitespace-delimited word of `name.toLowerCase()`.
- On match: `{ agentId: <agent.id>, text: <remainder with the "@token " removed, trimmed> }`.
- No match: `{ agentId: null, text: <original> }` (the `@foo` stays, Sage sees it verbatim).

Pure → unit-tested in `src/lib/mention.test.ts`. Both client and server call it so routing never diverges.

### 2. Stream route — `src/app/api/sessions/[id]/stream/route.ts`

- After loading `conversation` + `allAgents` + building the transcript, determine the **primary agent**:
  ```
  const { agentId: mentionId } = parseMention(lastUserMessage.content, allAgents);
  const addressed = mentionId && mentionId !== 'sage'
    ? allAgents.find(a => a.id === mentionId) : undefined;
  const primary = addressed ?? sage;
  ```
- Run `runClaudeAgent` with `primary`'s `model` / `system_prompt` / `tools_allowlist`, `prompt: transcript`, in the worktree.
- **Dispatch server attaches only when `primary` is Sage** (`addressed` is falsy). A directly-addressed specialist gets no `mcpServers` / `extraAllowedTools` — it cannot dispatch.
- Persist the reply under `primary.id` (not hard-coded `'sage'`). The dispatch-boundary flush logic only runs on the Sage path; a direct agent is a simple accumulate-then-persist (no dispatch events occur).
- Keep the existing worktree setup, SSE encoding, and `extraEnv` timeout (harmless for a direct agent).

### 3. Client — `src/components/mission-control.tsx` (`handleSendMessage`)

- Parse the input: `const { agentId } = parseMention(text, team)`; `const primary = (agentId && agentId !== 'sage' && team.find(a => a.id === agentId)) || sageAgent`.
- Create the streaming bubble as **`primary`** (its `id` / `name`), not hard-coded Sage; set `workingAgents`/`agentActivity` for `primary.id`. Direct turns carry **no** `via Sage` attribution.
- Route `token` events into the primary bubble (rename the existing `currentSageId` tracking to a neutral `currentPrimaryId`). The post-dispatch "new bubble" path only triggers on `dispatch_*` events, which never fire on a direct turn — so a direct agent's tokens simply fill its one bubble.
- The optimistic user message persists with the **full** `@Atlas …` text (the chat shows what was typed).

### Data flow (direct address)

```
operator types "@Atlas tweak that"
  → POST /messages stores it (role user, full text)
  → GET /stream:
      build transcript (full session)
      parseMention("@Atlas tweak that", agents) → atlas
      primary = Atlas; run Atlas (its tools, transcript, worktree, NO dispatch server)
      stream tokens → client renders an "Atlas" bubble (no via-Sage)
      persist reply as agent_id=atlas
```

## Edge cases

- **`@Sage …`** → resolves to `sage` → normal Sage path (with dispatch server). Harmless.
- **`@` with no token / just "@"** → no match → Sage.
- **Mention mid-sentence** ("do it @Atlas") → not leading → Sage (verbatim).
- **Addressed agent that can edit (Atlas)** → edits land in the worktree → Code diff, same as a dispatch.
- **Unknown agent id from a stale client** → server re-parses authoritatively; if it doesn't resolve, Sage runs. (Server is the source of truth for routing.)

## Out of scope

Sage-notification of the bypass · `@`-mention autocomplete UI · addressing multiple agents in one message · mid-sentence mentions · changing the dispatch (Sage→specialist) path.

## Verification

- Unit: `mention.test.ts` — leading-only, id match, first-name match, case-insensitive, unmatched → null, absent → null, remainder stripped/trimmed. Suite stays green (44 → 44+N).
- Build: `pnpm build` clean.
- Live: `@Atlas <small edit request>` → an Atlas bubble (no via-Sage) makes the change, visible in the Code diff, with session context. `@Echo review it` → Echo reviews directly. A plain message still routes to Sage and can still dispatch. `@nobody hi` → Sage handles it.
