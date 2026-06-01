# Terminal tab — live command output — design

**Date:** 2026-05-28
**Status:** Approved design, pending spec review
**Scope:** Week 4 Day 3. Stream agents' `Bash` command output into the Terminal tab.

## Problem

The Terminal tab currently renders a static mock artifact (`mockArtifacts`
`type: 'terminal'`). It should show the **real** commands the agents run
(`pnpm build`, tests, git, …) and their stdout/stderr, live.

The blocker: `src/lib/agent-runner-sdk.ts` emits a `tool` event (name + input)
for each `tool_use` block, but **never captures tool results**. So command
output is not currently available to the stream.

Confirmed feasibility: the SDK emits `type: 'user'` messages whose
`message.content` is an array of blocks including `tool_result` blocks carrying
`tool_use_id`, `content` (string or `{type:'text',text}[]`), and `is_error`.
The runner can capture these and correlate each result to its originating
`tool_use` by id.

## Decisions (from brainstorming)

- **Rendering:** lightweight append-only log with a minimal ANSI parser — NOT
  xterm.js. Avoids a heavy client dependency and the CDN/bundling friction we
  hit with Monaco; our data is just command + output lines.
- **Scope:** `Bash` only. Read/Edit/Grep stay in the STATE pane and Code diff.
- **Persistence:** ephemeral / live-only. Output lives in client state, persists
  across turns within the session, and is cleared on a full page reload. No DB
  writes, no schema change.
- **Operator input box:** deferred. The Terminal is read-only in v1.

## Architecture / data flow

```
runClaudeAgent (SDK)
  ├─ assistant msg, tool_use block (Bash)  → existing `tool` event
  └─ user msg, tool_result block           → NEW `tool_result` event
        │
   route.ts (Sage loop) + dispatch.ts (Atlas loop)
        │   toTerminalEvent(event, agentId)   ← pure, Bash-only filter
        ▼
   SSE `terminal` event { stream: "command"|"output", content, isError?, agent_id }
        ▼
   mission-control.tsx  → terminalLines state (append, soft-capped)
        ▼
   <TerminalView>  → command lines "$ cmd" (cyan); output via parseAnsi spans;
                     isError tinted red; autoscroll
```

Both Bash commands and their output append chronologically. Agents run
sequentially (Sage blocks in the `dispatch_agent` tool while Atlas works), so
chronological append needs no id-correlation on the client.

## Components

### 1. `src/lib/agent-runner-sdk.ts` (modify)

- Add to the `AgentEvent` union:
  `| { type: 'tool_result'; tool: string; content: string; isError: boolean }`
- Maintain `const toolNames = new Map<string, string>()` (tool_use_id → name).
  In the existing `assistant` branch, when iterating `tool_use` blocks, record
  `toolNames.set(block.id, block.name)`.
- Add a branch for `message.type === 'user'`: iterate `message.message.content`
  blocks; for each block with `type === 'tool_result'`, resolve the tool name
  from `toolNames` by `tool_use_id` (fallback `'unknown'`), flatten its
  `content` to a string (string as-is; array → join `text` parts), and yield
  `{ type: 'tool_result', tool, content, isError: Boolean(block.is_error) }`.
- No behavior change to existing `token` / `tool` / `done` / `error` events.

### 2. `src/lib/terminal-events.ts` (create, with tests)

Pure module, no React/DOM/server-only imports.

```ts
import type { AgentEvent } from "./agent-runner-sdk";

export interface TerminalEvent {
  type: "terminal";
  stream: "command" | "output";
  agent_id: string;
  content: string;
  isError?: boolean;
}

export function toTerminalEvent(
  event: AgentEvent,
  agentId: string,
): TerminalEvent | null;
```

Behavior:
- `event.type === 'tool'` and `event.name === 'Bash'`: return a `command`
  event with `content` = `event.input?.command` (string) or `""`.
- `event.type === 'tool_result'` and `event.tool === 'Bash'`: return an
  `output` event with `content` = `event.content`, `isError` = `event.isError`.
- Anything else: `null`.

> Note: importing the `AgentEvent` type from `agent-runner-sdk.ts` (which has
> `import 'server-only'`) into a test is a type-only import, erased at compile
> time, so it does not pull `server-only` into the Node test runtime.

### 3. `src/lib/ansi.ts` (create, with tests)

Pure minimal ANSI SGR parser, no dependencies.

```ts
export interface AnsiSegment {
  text: string;
  color?: string;   // a hex/tailwind-ish color token, or undefined for default
  bold?: boolean;
}

export function parseAnsi(input: string): AnsiSegment[];
```

Behavior:
- Recognizes SGR escape sequences `\x1b[<codes>m`.
- Supported codes: `0` (reset), `1` (bold), `22` (bold off), `30–37` and
  `90–97` (foreground colors → fixed hex palette), `39` (default fg).
- Any other code within an SGR sequence is ignored (no-op).
- Any non-SGR escape sequence (e.g. cursor moves `\x1b[2K`, `\x1b[1A`) is
  stripped from the output text.
- Returns an ordered list of segments; consecutive text under the same style is
  one segment. Plain text with no escapes returns a single default segment.
- Empty string returns `[]`.

Color palette (16 colors) maps code → hex, e.g. 31/91 → red shades, 32/92 →
green, 33/93 → yellow, 36/96 → cyan, etc., chosen to read well on the black
terminal background.

### 4. `src/app/api/sessions/[id]/stream/route.ts` (modify)

In the Sage `for await` loop, after the existing handling, also compute
`const term = toTerminalEvent(event, 'sage');` and, if non-null,
`controller.enqueue(sseEncode(term));`. The existing `activity` emission for
Bash stays (STATE pane unchanged).

### 5. `src/lib/dispatch.ts` (modify)

In the dispatched-agent `for await` loop, also compute
`const term = toTerminalEvent(event, agent.id);` and, if non-null,
`ctx.emit(term);`. Existing `dispatch_activity` emission stays.

### 6. `src/components/terminal-view.tsx` (create)

Client component. Props: `lines: TerminalLine[]` where
`TerminalLine = { id: number; kind: 'command' | 'output'; agentId: string; content: string; isError?: boolean }`.

- `command` line → `$ {content}` in cyan, monospace.
- `output` line → `parseAnsi(content)` rendered as spans; if `isError`, wrap in
  a red-tinted container.
- Append-only, autoscrolls to bottom on new lines (a ref + effect).
- Empty state: a muted "No commands run yet — agent Bash output will stream
  here." message.

### 7. `src/components/mission-control.tsx` (modify)

- New state: `const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([])`
  and a monotonic `lineIdRef`.
- In the `es.onmessage` handler, add a branch:
  `else if (evt.type === 'terminal' && typeof evt.content === 'string')` →
  append `{ id: lineIdRef.current++, kind: evt.stream, agentId: evt.agent_id, content: evt.content, isError: evt.isError }`,
  soft-capping the array to the last 1000 entries.
- Do NOT clear `terminalLines` on `persisted`, `handleStop`, or new send — it is
  a session-scoped scrollback; it clears naturally on full page reload (fresh
  component mount).
- Replace the mock terminal `<ScrollArea>`/`<pre>` block (the `activeTab ===
  'terminal'` branch) with `<TerminalView lines={terminalLines} />`, keeping the
  existing tab header/chrome.
- (Optional, low-risk) a count badge on the Terminal tab button mirroring the
  Code-diff badge, showing `terminalLines` count — include only if trivial.

## Error handling / edge cases

- `tool_result` with array content → flattened to joined text in the runner.
- `isError` output → red-tinted in the view.
- Missing/empty Bash command string → `command` line with empty content is
  skipped client-side (don't render a bare `$`).
- Unbounded output → client soft-caps `terminalLines` at the last 1000 entries.
- Non-SGR ANSI escapes (cursor control) → stripped by `parseAnsi`.

## Testing

TDD with `node:test` via `tsx` (extensionless imports — see project convention).

`src/lib/terminal-events.test.ts`:
- Bash `tool` event → `command` TerminalEvent with the command string.
- Bash `tool` event with missing `input.command` → `command` event, content `""`.
- Bash `tool_result` event → `output` TerminalEvent, `isError` propagated.
- non-Bash `tool` (e.g. `Read`) → `null`.
- non-Bash `tool_result` → `null`.
- `token` / `done` / `error` events → `null`.

`src/lib/ansi.test.ts`:
- plain text → single default segment.
- empty string → `[]`.
- single color sequence → colored segment, then reset returns to default.
- bold on/off.
- multiple styled segments in sequence.
- unknown SGR code → ignored (text kept, no style).
- cursor-control escape (`\x1b[2K`) → stripped, surrounding text intact.

Manual verification: send a prompt that makes Atlas run `pnpm build` (or a test),
open the Terminal tab, confirm the command and its colored output stream in, and
that an erroring command shows red output.

## Out of scope

- Operator-typed command box / any interactive shell.
- Persistence across page reloads (no DB/schema change).
- Non-Bash tool output in the Terminal.
- Full ANSI support (cursor positioning, 256-color / truecolor, hyperlinks).
- xterm.js.
