# Paragraph-split agent bubbles — design

**Date:** 2026-05-28
**Status:** Approved design, pending spec review
**Scope:** Frontend-only rendering change in the orchestrator chat (middle pane).

## Problem

Each agent turn currently renders as **one bubble that grows**. Sage narrates a
sentence, runs a tool, narrates more, runs another tool — and every bit of that
text accumulates into a single chat bubble. The operator sees one big message
with responses appended to the end of it, rather than discrete messages.

Root cause (for reference, not changing):
- `src/app/api/sessions/[id]/stream/route.ts` accumulates all of Sage's tokens
  into one `sageBuffer` and writes **one DB row per turn** (flushing only at a
  dispatch boundary or at the end).
- `src/components/mission-control.tsx` mirrors this: one streaming bubble grown
  via `content + tokenText`.

## Decision

Split **at render time only**, on blank lines, into separate bubbles —
"cosmetic paragraph split". The stored message stays **one DB row**; the
server, SSE stream, and the client's token-accumulation logic are **unchanged**.
Rendering splits whatever content is present, so it behaves identically for
live-streaming text and for history loaded from the DB.

Rejected alternatives (from brainstorming):
- *Split at each tool use* / *at each model turn* — truer to the agent's
  structure and would persist distinct DB rows, but requires server + stream +
  schema-level changes. More than this need warrants.

## Components

### 1. `splitMessageSegments(content: string): string[]` — new pure module

Location: `src/lib/message-segments.ts` (no React/DOM/`server-only` deps, so it
is importable by both the client component and a Node test).

Behavior:
- Splits the content into paragraph segments on runs of one-or-more blank lines
  (`\n\s*\n`).
- **Fenced code blocks are atomic.** Text inside a ` ``` … ``` ` fence is never
  split, even when it contains blank lines. This is the critical correctness
  rule: Sage frequently emits code blocks with internal blank lines, and a naive
  blank-line split would break a fence across two bubbles and render as garbage.
  - A fence opens on a line whose first non-whitespace is ` ``` ` (or `~~~`) and
    closes on the next matching fence line. Track open/closed state line-by-line.
  - An unterminated fence (still streaming) keeps everything from the opening
    fence onward in the current/last segment — it is not split mid-block.
- Each returned segment is trimmed; empty segments are dropped.
- A message with no blank lines (outside fences) returns a single-element array
  — i.e. it renders exactly like today.

### 2. Render change in `mission-control.tsx` (agent branch, ~line 740)

For `msg.role === "agent"`:
- Keep the **single header** (sender name · `attribution` pill · timestamp)
  rendered once, above the stack.
- Render `splitMessageSegments(msg.content)` as **one bubble per segment**,
  stacked beneath the header with the existing bubble styling
  (`bg-[#11161d] border-[#1e2632]`), each wrapping its segment in `<Markdown>`.
- Render the **dispatch card** and the **approval block** once, after the last
  segment — not repeated per bubble.
- If the split yields zero segments (e.g. an empty streaming bubble before the
  first token), render a single empty bubble so the "typing" target still
  exists.

User (`role === "user"`) and system (`role === "system"`) messages are
**unchanged** — single bubble each. The complaint is specifically about agents
narrating in one growing blob; user messages are short and already fine.

## Data flow

```
DB row / streaming bubble (one Message, content = full turn text)
        │
        ▼
splitMessageSegments(content)  ──►  ["para 1", "```code\n\n```", "para 2", …]
        │
        ▼
one <Markdown> bubble per segment, under one shared header
```

No new state, no new SSE events, no schema change.

## Error handling / edge cases

- **Unterminated code fence** (mid-stream): everything from the fence onward
  stays in one segment; no split inside it.
- **Only whitespace / empty content:** returns `[]`; render falls back to a
  single empty bubble (streaming placeholder).
- **No blank lines:** one segment — identical to current behavior.
- **Leading/trailing blank lines:** trimmed away, no empty bubbles.
- **Markdown spanning a blank line that is NOT a fence** (e.g. a loose list with
  blank lines between items): this *will* split into separate bubbles. Accepted
  — it is rare in practice and the result is still readable. Only fences are
  treated as atomic; replicating full CommonMark block grouping is out of scope.

## Testing

TDD with Node's built-in `node:test` + `node:assert`, run via `tsx` — **no new
dependency** (consistent with the project's `.npmrc` `ignore-scripts` hardening
and pnpm `onlyBuiltDependencies` allowlist). Add a `test` script:
`"test": "tsx --test src/lib/*.test.ts"`.

Test file `src/lib/message-segments.test.ts` covers:
- prose with blank lines → multiple segments
- single paragraph → one segment
- code block with internal blank lines → stays one atomic segment
- mixed prose + code block → prose splits, code stays whole
- unterminated/streaming fence → no split inside the open fence
- leading/trailing/multiple consecutive blank lines → no empty segments
- empty / whitespace-only string → `[]`

Manual verification: run the app, send Sage a prompt that produces multi-paragraph
output with a code block, confirm separate bubbles render and code blocks stay intact.

## Out of scope

- Showing tool actions inline between bubbles (stays in the left STATE pane).
- Any server / SSE / DB / schema change.
- Splitting user or system messages.
- Persisting segments as distinct messages.
