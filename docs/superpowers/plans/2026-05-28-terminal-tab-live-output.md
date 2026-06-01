# Terminal Tab — Live Command Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream agents' `Bash` commands and their stdout/stderr into the Terminal tab as a live, ANSI-colored, read-only, append-only log.

**Architecture:** The agent runner gains a `tool_result` event (results correlated to tool calls by `tool_use_id`). A pure `toTerminalEvent` helper filters Bash command/result events into `terminal` SSE events; both the Sage stream loop and the dispatch (Atlas) loop use it. A pure `parseAnsi` helper renders SGR colors. The client accumulates `terminalLines` in component state and renders `<TerminalView>`. No DB/schema changes; output is ephemeral (cleared on full reload).

**Tech Stack:** TypeScript, React 19 / Next 16, the Claude Agent SDK stream, `react`/Tailwind, Node's built-in `node:test` via `tsx`.

---

## File Structure

- **Modify** `src/lib/agent-runner-sdk.ts` — add `tool_result` to the `AgentEvent` union; track tool_use_id→name; emit `tool_result` events from SDK `user` messages.
- **Create** `src/lib/ansi.ts` (+ `src/lib/ansi.test.ts`) — pure minimal SGR parser `parseAnsi`.
- **Create** `src/lib/terminal-events.ts` (+ `src/lib/terminal-events.test.ts`) — pure `toTerminalEvent(event, agentId)` Bash filter.
- **Modify** `src/app/api/sessions/[id]/stream/route.ts` — emit `terminal` SSE events for Sage's Bash; skip raw-forwarding `tool_result`.
- **Modify** `src/lib/dispatch.ts` — emit `terminal` SSE events for the dispatched agent's Bash.
- **Create** `src/components/terminal-view.tsx` — append-only ANSI log view.
- **Modify** `src/components/mission-control.tsx` — `terminalLines` state, `terminal` SSE branch, render `<TerminalView>`.

---

## Task 1: Runner emits `tool_result` events

**Files:**
- Modify: `src/lib/agent-runner-sdk.ts`

This task has no unit test (it consumes the live SDK stream, which is impractical to mock); it is verified by `tsc` and exercised by the manual test at the end of Task 6. Keep the change minimal and type-safe.

- [ ] **Step 1: Extend the `AgentEvent` union**

In `src/lib/agent-runner-sdk.ts`, change the `AgentEvent` type (currently lines 5-9) to add the `tool_result` variant:

```ts
export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'tool'; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; content: string; isError: boolean }
  | { type: 'done'; fullText: string; costUsd?: number; tokensIn?: number; tokensOut?: number }
  | { type: 'error'; message: string };
```

- [ ] **Step 2: Add a content-flattening helper**

Add this module-level helper just above `export async function* runClaudeAgent` (after the `DEFAULT_ALLOWED_TOOLS` const):

```ts
// A tool_result block's content is either a plain string or an array of
// content blocks; for Bash it's the command's combined stdout/stderr. Flatten
// to a single string, keeping only text parts.
function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: string }).type === 'text'
          ? String((b as { text?: string }).text ?? '')
          : '',
      )
      .join('');
  }
  return '';
}
```

- [ ] **Step 3: Track tool_use ids and emit results**

In `runClaudeAgent`, just before the `for await (const message of response)` loop (right after `let fullText = '';`), add the id→name map:

```ts
  // Correlate tool_result blocks (which carry only tool_use_id) back to the
  // tool name, so consumers can tell which results were Bash commands.
  const toolNames = new Map<string, string>();
```

Then, inside the `assistant` branch's `tool_use` handling, capture the id. Replace the existing block (currently lines 113-124) with:

```ts
              if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
                const tu = block as { id?: string; name?: string; input?: unknown };
                if (tu.name) {
                  if (tu.id) toolNames.set(tu.id, tu.name);
                  yield {
                    type: 'tool',
                    name: tu.name,
                    input:
                      tu.input && typeof tu.input === 'object'
                        ? (tu.input as Record<string, unknown>)
                        : undefined,
                  };
                }
              }
```

Then add a new `else if` branch for `user` messages. Insert it AFTER the entire `} else if (message.type === 'assistant') { ... }` block and BEFORE `} else if (message.type === 'result') {`:

```ts
      } else if (message.type === 'user') {
        // Tool results come back on a `user` message as tool_result blocks.
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
              const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
              const tool = (tr.tool_use_id && toolNames.get(tr.tool_use_id)) || 'unknown';
              yield {
                type: 'tool_result',
                tool,
                content: flattenToolResultContent(tr.content),
                isError: Boolean(tr.is_error),
              };
            }
          }
        }
      }
```

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no errors. (If TS complains that `message.message` is possibly undefined on the `user` branch, the optional chaining `message.message?.content` already guards it; the `Array.isArray` guard narrows `content`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-runner-sdk.ts
git commit -m "feat(runner): emit tool_result events with resolved tool name

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `parseAnsi` minimal SGR parser (TDD)

**Files:**
- Create: `src/lib/ansi.ts`
- Test: `src/lib/ansi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/ansi.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "./ansi";

test("plain text is a single default segment", () => {
  assert.deepEqual(parseAnsi("hello world"), [{ text: "hello world" }]);
});

test("empty string yields no segments", () => {
  assert.deepEqual(parseAnsi(""), []);
});

test("a color sequence colors the following text; reset returns to default", () => {
  assert.deepEqual(parseAnsi("\x1b[31mred\x1b[0mplain"), [
    { text: "red", color: "#f87171" },
    { text: "plain" },
  ]);
});

test("bold on then off", () => {
  assert.deepEqual(parseAnsi("\x1b[1mbold\x1b[22mnormal"), [
    { text: "bold", bold: true },
    { text: "normal" },
  ]);
});

test("bright foreground color is supported", () => {
  assert.deepEqual(parseAnsi("\x1b[92mgreen"), [
    { text: "green", color: "#56d364" },
  ]);
});

test("unknown SGR codes are ignored, text preserved", () => {
  assert.deepEqual(parseAnsi("\x1b[7minverse\x1b[0m"), [{ text: "inverse" }]);
});

test("non-SGR escape sequences (cursor/clear) are stripped", () => {
  assert.deepEqual(parseAnsi("before\x1b[2Kafter"), [
    { text: "before" },
    { text: "after" },
  ]);
});

test("combined code list applies color and bold together", () => {
  assert.deepEqual(parseAnsi("\x1b[1;36mhi"), [
    { text: "hi", color: "#00e0ff", bold: true },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./ansi`.

- [ ] **Step 3: Implement `parseAnsi`**

Create `src/lib/ansi.ts`:

```ts
// Minimal ANSI SGR parser → styled text segments for the Terminal view.
// Supports reset (0), bold (1/22), default fg (39), and the 16 foreground
// colors (30-37, 90-97). Any other SGR code is ignored; any non-SGR escape
// sequence (cursor moves, screen clears) is stripped from the output.

export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
}

const ANSI_FG: Record<number, string> = {
  30: "#5c6470", 31: "#f87171", 32: "#3fb950", 33: "#d29922",
  34: "#3b82f6", 35: "#c084fc", 36: "#00e0ff", 37: "#e6edf3",
  90: "#8b949e", 91: "#fca5a5", 92: "#56d364", 93: "#e3b341",
  94: "#79c0ff", 95: "#d2a8ff", 96: "#56d4dd", 97: "#ffffff",
};

// eslint-disable-next-line no-control-regex
const ESC = /\x1b\[([0-9;]*)([A-Za-z])/g;

export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let lastIndex = 0;

  const push = (text: string) => {
    if (!text) return;
    const seg: AnsiSegment = { text };
    if (color) seg.color = color;
    if (bold) seg.bold = true;
    segments.push(seg);
  };

  ESC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC.exec(input)) !== null) {
    push(input.slice(lastIndex, m.index));
    lastIndex = ESC.lastIndex;
    if (m[2] === "m") {
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          color = undefined;
          bold = false;
        } else if (code === 1) {
          bold = true;
        } else if (code === 22) {
          bold = false;
        } else if (code === 39) {
          color = undefined;
        } else if (ANSI_FG[code]) {
          color = ANSI_FG[code];
        }
        // other codes: ignored
      }
    }
    // non-'m' final bytes (e.g. K, A, J, H) are control sequences: strip them.
  }
  push(input.slice(lastIndex));
  return segments;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS — all `ansi` tests green (plus the existing message-segments tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ansi.ts src/lib/ansi.test.ts
git commit -m "feat(terminal): minimal ANSI SGR parser + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `toTerminalEvent` Bash filter (TDD)

**Files:**
- Create: `src/lib/terminal-events.ts`
- Test: `src/lib/terminal-events.test.ts`

Depends on Task 1 (the `AgentEvent` union must include `tool_result`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/terminal-events.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toTerminalEvent } from "./terminal-events";

test("a Bash tool event becomes a command terminal event", () => {
  const out = toTerminalEvent(
    { type: "tool", name: "Bash", input: { command: "pnpm build" } },
    "atlas",
  );
  assert.deepEqual(out, {
    type: "terminal",
    stream: "command",
    agent_id: "atlas",
    content: "pnpm build",
  });
});

test("a Bash tool event with no command yields empty content", () => {
  const out = toTerminalEvent({ type: "tool", name: "Bash" }, "sage");
  assert.deepEqual(out, {
    type: "terminal",
    stream: "command",
    agent_id: "sage",
    content: "",
  });
});

test("a Bash tool_result event becomes an output terminal event", () => {
  const out = toTerminalEvent(
    { type: "tool_result", tool: "Bash", content: "build ok", isError: false },
    "atlas",
  );
  assert.deepEqual(out, {
    type: "terminal",
    stream: "output",
    agent_id: "atlas",
    content: "build ok",
    isError: false,
  });
});

test("an erroring Bash result propagates isError", () => {
  const out = toTerminalEvent(
    { type: "tool_result", tool: "Bash", content: "boom", isError: true },
    "atlas",
  );
  assert.deepEqual(out, {
    type: "terminal",
    stream: "output",
    agent_id: "atlas",
    content: "boom",
    isError: true,
  });
});

test("non-Bash tool events are ignored", () => {
  assert.equal(
    toTerminalEvent({ type: "tool", name: "Read", input: { file_path: "x" } }, "sage"),
    null,
  );
});

test("non-Bash tool_result events are ignored", () => {
  assert.equal(
    toTerminalEvent({ type: "tool_result", tool: "Read", content: "...", isError: false }, "sage"),
    null,
  );
});

test("token, done, and error events are ignored", () => {
  assert.equal(toTerminalEvent({ type: "token", content: "hi" }, "sage"), null);
  assert.equal(toTerminalEvent({ type: "done", fullText: "" }, "sage"), null);
  assert.equal(toTerminalEvent({ type: "error", message: "x" }, "sage"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./terminal-events`.

- [ ] **Step 3: Implement `toTerminalEvent`**

Create `src/lib/terminal-events.ts`:

```ts
import type { AgentEvent } from "./agent-runner-sdk";

// A single Terminal-tab line: either a command the agent ran, or a chunk of
// that command's output. Bash-only — other tools stay in the STATE pane / diff.
export interface TerminalEvent {
  type: "terminal";
  stream: "command" | "output";
  agent_id: string;
  content: string;
  isError?: boolean;
}

// Map a runner AgentEvent to a Terminal SSE event, or null if it is not a Bash
// command/result. Shared by the Sage stream loop and the dispatch loop so the
// Bash-only filtering lives in exactly one place.
export function toTerminalEvent(event: AgentEvent, agentId: string): TerminalEvent | null {
  if (event.type === "tool" && event.name === "Bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    return { type: "terminal", stream: "command", agent_id: agentId, content: command };
  }
  if (event.type === "tool_result" && event.tool === "Bash") {
    return {
      type: "terminal",
      stream: "output",
      agent_id: agentId,
      content: event.content,
      isError: event.isError,
    };
  }
  return null;
}
```

> The `import type { AgentEvent }` is type-only and erased at compile time, so it
> does not pull `agent-runner-sdk`'s `import 'server-only'` into the Node test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS — all `terminal-events` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminal-events.ts src/lib/terminal-events.test.ts
git commit -m "feat(terminal): pure Bash-only toTerminalEvent filter + tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Emit `terminal` SSE events from the server

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts`
- Modify: `src/lib/dispatch.ts`

Depends on Tasks 1 and 3.

- [ ] **Step 1: Wire the Sage stream loop**

In `src/app/api/sessions/[id]/stream/route.ts`, add the import near the other `@/lib` imports (after the `createDispatchServer` import on line 10):

```ts
import { toTerminalEvent } from '@/lib/terminal-events';
```

Then in the `for await (const event of runClaudeAgent({...}))` loop, add a terminal emission at the TOP of the loop body (before the existing `if (event.type === 'token')`), and change the final blanket forward to skip raw `tool_result` (whose output we already send as a `terminal` event). The loop body currently reads:

```ts
          if (event.type === 'token') {
            sageBuffer += event.content;
          } else if (event.type === 'tool') {
            // Sage's own tool activity (Read/Grep/dispatch_agent…) → live STATE box.
            controller.enqueue(
              sseEncode({ type: 'activity', agent_id: 'sage', tool: event.name, input: event.input }),
            );
          } else if (event.type === 'done') {
            costUsd = event.costUsd;
            tokensIn = event.tokensIn;
            tokensOut = event.tokensOut;
            if (!sageBuffer && event.fullText) sageBuffer = event.fullText;
          }
          controller.enqueue(sseEncode(event));
```

Replace it with:

```ts
          const term = toTerminalEvent(event, 'sage');
          if (term) controller.enqueue(sseEncode(term));

          if (event.type === 'token') {
            sageBuffer += event.content;
          } else if (event.type === 'tool') {
            // Sage's own tool activity (Read/Grep/dispatch_agent…) → live STATE box.
            controller.enqueue(
              sseEncode({ type: 'activity', agent_id: 'sage', tool: event.name, input: event.input }),
            );
          } else if (event.type === 'done') {
            costUsd = event.costUsd;
            tokensIn = event.tokensIn;
            tokensOut = event.tokensOut;
            if (!sageBuffer && event.fullText) sageBuffer = event.fullText;
          }
          // Forward the raw event for the client (token rendering relies on this),
          // but NOT raw tool_result — its (potentially large) output already went
          // out as the `terminal` event above, and the client ignores raw results.
          if (event.type !== 'tool_result') controller.enqueue(sseEncode(event));
```

- [ ] **Step 2: Wire the dispatch (Atlas) loop**

In `src/lib/dispatch.ts`, add the import after the existing `runClaudeAgent` import (line 7):

```ts
import { toTerminalEvent } from './terminal-events';
```

Then in the `for await (const event of runClaudeAgent({...}))` loop, add a terminal emission at the TOP of the loop body (before `if (event.type === 'token')`):

```ts
      for await (const event of runClaudeAgent({
        prompt: buildTaskPrompt(args.task, args.context),
        workingDir: ctx.workingDir,
        model: agent.model,
        systemPrompt: agent.system_prompt,
        allowedTools: agent.tools_allowlist ?? undefined,
        signal: ctx.signal,
      })) {
        const term = toTerminalEvent(event, agent.id);
        if (term) ctx.emit(term);

        if (event.type === 'token') {
```

(The rest of the loop body — the `token` / `tool` / `done` / `error` branches — is unchanged. `tool_result` events have no matching branch and simply fall through, which is correct.)

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/stream/route.ts src/lib/dispatch.ts
git commit -m "feat(terminal): stream Bash command/output as terminal SSE events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `<TerminalView>` component

**Files:**
- Create: `src/components/terminal-view.tsx`

Depends on Task 2 (`parseAnsi`).

- [ ] **Step 1: Create the component**

Create `src/components/terminal-view.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { parseAnsi } from "@/lib/ansi";

export interface TerminalLine {
  id: number;
  kind: "command" | "output";
  agentId: string;
  content: string;
  isError?: boolean;
}

// Append-only Terminal scrollback. Command lines render as "$ cmd" in cyan;
// output lines render ANSI SGR colors via parseAnsi, with errors tinted red.
// Autoscrolls to the newest line.
export default function TerminalView({ lines }: { lines: TerminalLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[11px] font-mono text-[#5c6470] p-4">
        No commands run yet — agent Bash output will stream here.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 text-xs font-mono leading-relaxed bg-black text-[#8b949e]">
      {lines.map((line) =>
        line.kind === "command" ? (
          <div key={line.id} className="flex items-start gap-1.5 mt-2 first:mt-0 text-cyan-400">
            <span className="select-none">$</span>
            <span className="text-[#e6edf3] font-bold whitespace-pre-wrap break-all">{line.content}</span>
          </div>
        ) : (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap break-all ${line.isError ? "text-red-300" : ""}`}
          >
            {parseAnsi(line.content).map((seg, i) => (
              <span key={i} style={{ color: seg.color, fontWeight: seg.bold ? 600 : undefined }}>
                {seg.text}
              </span>
            ))}
          </pre>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/terminal-view.tsx
git commit -m "feat(terminal): TerminalView append-only ANSI log component

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire the Terminal tab into mission-control

**Files:**
- Modify: `src/components/mission-control.tsx`

Depends on Task 5.

- [ ] **Step 1: Import TerminalView and its type**

After the existing `import Markdown from "@/components/markdown";` / `import { splitMessageSegments } ...` imports near line 30-31, add:

```ts
import TerminalView, { type TerminalLine } from "@/components/terminal-view";
```

- [ ] **Step 2: Add terminal state**

Inside the `MissionControl` component, next to the other `useState` hooks (e.g. right after the `agentActivity` state around line 194), add:

```ts
  // Live Terminal tab: agents' Bash commands + output, accumulated in-session.
  // Ephemeral — cleared on full page reload (fresh mount), capped to bound memory.
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const lineIdRef = useRef<number>(0);
```

(`useRef` is already imported on line 3.)

- [ ] **Step 3: Handle the `terminal` SSE event**

In the `es.onmessage` handler, the parsed event object's type annotation (around lines 331-345) lists known fields. Add `stream`, `isError` to it so TypeScript accepts them:

Find:
```ts
            tool?: string;
            input?: Record<string, unknown>;
          };
```
Replace with:
```ts
            tool?: string;
            input?: Record<string, unknown>;
            stream?: "command" | "output";
            isError?: boolean;
          };
```

Then add a new branch in the `if/else if` chain. Insert it right after the `if (evt.type === "activity" ...)` / before or among the others — place it immediately before the `} else if (evt.type === "token" ...)` branch:

```ts
          } else if (evt.type === "terminal" && typeof evt.content === "string" && evt.stream) {
            // Skip empty command lines (a bare "$" is noise).
            if (!(evt.stream === "command" && evt.content.trim() === "")) {
              const line: TerminalLine = {
                id: lineIdRef.current++,
                kind: evt.stream,
                agentId: evt.agent_id ?? "sage",
                content: evt.content,
                isError: evt.isError,
              };
              setTerminalLines((prev) => {
                const next = [...prev, line];
                return next.length > 1000 ? next.slice(next.length - 1000) : next;
              });
            }
```

(Make sure this `} else if` joins the existing chain correctly — it should sit between two existing branches, sharing their `} else if (...) {` structure.)

- [ ] **Step 4: Replace the mock terminal body with TerminalView**

Find the `activeTab === "terminal"` block's body — the `<ScrollArea>` element (currently lines 1106-1114):

```tsx
                <ScrollArea className="flex-1 p-4 text-xs font-mono leading-relaxed bg-black text-[#8b949e]">
                  <pre className="whitespace-pre-wrap">{artifacts.find((a) => a.type === "terminal")?.content}</pre>

                  <div className="mt-3 border-t border-[#1e2632]/80 pt-2 flex items-center gap-1.5 text-cyan-400">
                    <span>$</span>
                    <span className="text-[#e6edf3] font-bold">pnpm run build</span>
                    <div className="w-2 h-4 bg-cyan-400 animate-pulse ml-0.5 inline-block align-middle" />
                  </div>
                </ScrollArea>
```

Replace that entire `<ScrollArea>...</ScrollArea>` with:

```tsx
                <TerminalView lines={terminalLines} />
```

(Keep the surrounding `<div className="h-full flex flex-col bg-black ...">` container and its header `<div className="h-9 ...">` intact.)

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no errors.
Run: `pnpm lint`
Expected: no NEW errors in `src/` (pre-existing warnings under `data/` are unrelated).

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: build succeeds (exit 0).

- [ ] **Step 7: Manual verification**

Run `pnpm dev`, open a session, and send a prompt that makes Atlas run a shell command (e.g. "Atlas, run the project build and report the result"). Open the Terminal tab and confirm:
- the `$ <command>` line appears in cyan,
- its stdout/stderr streams in below with ANSI colors rendered,
- a failing command shows red output,
- switching tabs and back preserves the accumulated lines (until a full page reload).

- [ ] **Step 8: Commit**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(terminal): live Bash output in the Terminal tab (week 4 day 3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:**
  - Runner `tool_result` event + id→name correlation → Task 1 (spec §Components.1).
  - `parseAnsi` minimal SGR parser → Task 2 (spec §Components.3, §Testing).
  - `toTerminalEvent` Bash-only filter → Task 3 (spec §Components.2, §Testing).
  - Emit `terminal` SSE from Sage loop + dispatch loop, skip raw tool_result forward → Task 4 (spec §Components.4, §Components.5).
  - `<TerminalView>` append-only ANSI log, command/output/error styling, autoscroll, empty state → Task 5 (spec §Components.6).
  - `terminalLines` state, `terminal` SSE branch, soft cap 1000, no clear on persisted/stop, replace mock → Task 6 (spec §Components.7, §Error handling).
  - Out-of-scope items (operator input, persistence, non-Bash, full ANSI, xterm) — not implemented, as intended.
- **Placeholder scan:** none — all steps contain concrete code/commands.
- **Type consistency:** `AgentEvent.tool_result {tool, content, isError}` (Task 1) is consumed identically in `toTerminalEvent` (Task 3); `TerminalEvent {type,stream,agent_id,content,isError?}` (Task 3) matches the SSE branch fields and `TerminalLine {id,kind,agentId,content,isError?}` (Task 5/6); `AnsiSegment {text,color?,bold?}` (Task 2) is consumed in TerminalView (Task 5).
