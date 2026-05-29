# Paragraph-Split Agent Bubbles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render each agent chat turn as one bubble per paragraph (blank-line boundaries) instead of one ever-growing bubble, while keeping fenced code blocks intact.

**Architecture:** A pure, fence-aware `splitMessageSegments(content)` helper splits agent text into segments at render time. `mission-control.tsx` renders one bubble per segment under a single shared header. No server, SSE, or DB changes — the split applies identically to live-streaming text and DB-loaded history.

**Tech Stack:** TypeScript, React 19 / Next 16, `react-markdown`, Node's built-in `node:test` run via `tsx`.

---

## File Structure

- **Create** `src/lib/message-segments.ts` — the pure `splitMessageSegments` helper. No React/DOM/`server-only` imports, so it is importable from both the client component and a Node test.
- **Create** `src/lib/message-segments.test.ts` — `node:test` unit tests for the helper.
- **Modify** `package.json` — add a `test` script.
- **Modify** `src/components/mission-control.tsx` — render agent messages as one bubble per segment under a single header.

---

## Task 1: The fence-aware segment splitter (TDD)

**Files:**
- Create: `src/lib/message-segments.ts`
- Test: `src/lib/message-segments.test.ts`
- Modify: `package.json` (add `test` script)

- [ ] **Step 1: Add the `test` script to `package.json`**

In the `"scripts"` block, add this line (after `"lint": "eslint",`):

```json
    "test": "tsx --test src/lib/*.test.ts",
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/message-segments.test.ts` with the full suite:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMessageSegments } from "./message-segments.ts";

test("single paragraph returns one segment", () => {
  assert.deepEqual(splitMessageSegments("Just one line."), ["Just one line."]);
});

test("blank-line separated prose splits into multiple segments", () => {
  const input = "First paragraph.\n\nSecond paragraph.\n\nThird.";
  assert.deepEqual(splitMessageSegments(input), [
    "First paragraph.",
    "Second paragraph.",
    "Third.",
  ]);
});

test("multiple consecutive blank lines do not produce empty segments", () => {
  const input = "One.\n\n\n\nTwo.";
  assert.deepEqual(splitMessageSegments(input), ["One.", "Two."]);
});

test("leading and trailing blank lines are trimmed", () => {
  const input = "\n\n  Hello.\n\n";
  assert.deepEqual(splitMessageSegments(input), ["Hello."]);
});

test("empty or whitespace-only input returns an empty array", () => {
  assert.deepEqual(splitMessageSegments(""), []);
  assert.deepEqual(splitMessageSegments("   \n\n  "), []);
});

test("a fenced code block with internal blank lines stays one segment", () => {
  const input = "```js\nconst a = 1;\n\nconst b = 2;\n```";
  assert.deepEqual(splitMessageSegments(input), [
    "```js\nconst a = 1;\n\nconst b = 2;\n```",
  ]);
});

test("prose around a code block: prose splits, code stays whole", () => {
  const input =
    "Here is the fix:\n\n```js\nfn(a);\n\nfn(b);\n```\n\nThat should work.";
  assert.deepEqual(splitMessageSegments(input), [
    "Here is the fix:",
    "```js\nfn(a);\n\nfn(b);\n```",
    "That should work.",
  ]);
});

test("tilde fences are treated as atomic", () => {
  const input = "~~~\nline 1\n\nline 2\n~~~";
  assert.deepEqual(splitMessageSegments(input), [
    "~~~\nline 1\n\nline 2\n~~~",
  ]);
});

test("an unterminated (still-streaming) fence is not split inside", () => {
  const input = "Working on it:\n\n```js\nconst a = 1;\n\nconst b = 2;";
  assert.deepEqual(splitMessageSegments(input), [
    "Working on it:",
    "```js\nconst a = 1;\n\nconst b = 2;",
  ]);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./message-segments.ts` (module does not exist yet).

- [ ] **Step 4: Implement `splitMessageSegments`**

Create `src/lib/message-segments.ts`:

```ts
// Splits an agent message's text into paragraph segments for rendering as
// separate chat bubbles. Boundaries are runs of one-or-more blank lines —
// EXCEPT inside a fenced code block (``` … ``` or ~~~ … ~~~), which is kept
// atomic so a fence with internal blank lines is never shattered across
// bubbles. An unterminated fence (still streaming) keeps everything from the
// opening fence onward in one trailing segment.

const FENCE = /^\s*(```|~~~)/;

export function splitMessageSegments(content: string): string[] {
  const lines = content.split("\n");
  const segments: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) segments.push(text);
    current = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      if (!inFence) {
        // Opening a fence: a blank line right before it already separated the
        // preceding prose, but flush defensively in case it didn't.
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (line.includes(fenceMarker)) {
        // Closing fence (same marker family). Keep the line, stay un-split.
        inFence = false;
        fenceMarker = "";
      }
      current.push(line);
      continue;
    }

    if (!inFence && line.trim() === "") {
      // Blank line outside a fence = a segment boundary.
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return segments;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS — all 9 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/message-segments.ts src/lib/message-segments.test.ts package.json
git commit -m "feat(chat): fence-aware message segment splitter + tests"
```

---

## Task 2: Render agent turns as one bubble per segment

**Files:**
- Modify: `src/components/mission-control.tsx` (import near line 30; agent render branch ~lines 740–785)

- [ ] **Step 1: Import the splitter**

After the existing import on line 30 (`import Markdown from "@/components/markdown";`), add:

```ts
import { splitMessageSegments } from "@/lib/message-segments";
```

- [ ] **Step 2: Replace the single agent bubble with a per-segment stack**

Find this block (the agent/user bubble, currently around lines 740–785):

```tsx
                {msg.role !== "system" && (
                  <div
                    className={`text-xs leading-relaxed p-3 rounded-md border ${
                      msg.role === "user"
                        ? "bg-[#161c25]/80 border-[#2a3441] text-[#e6edf3] whitespace-pre-wrap"
                        : "bg-[#11161d] border-[#1e2632] text-[#8b949e]"
                    }`}
                  >
                    {msg.role === "agent" ? <Markdown>{msg.content}</Markdown> : msg.content}

                    {msg.dispatch && (() => {
```

Replace **only the agent path** so user messages stay a single bubble and agent
messages render one bubble per segment, with the dispatch card after the last
segment. The full replacement for the `msg.role !== "system"` block is:

```tsx
                {msg.role === "user" && (
                  <div className="text-xs leading-relaxed p-3 rounded-md border bg-[#161c25]/80 border-[#2a3441] text-[#e6edf3] whitespace-pre-wrap">
                    {msg.content}
                  </div>
                )}

                {msg.role === "agent" && (() => {
                  const segments = splitMessageSegments(msg.content);
                  // An empty streaming bubble (before the first token) still needs
                  // a render target, so fall back to a single empty segment.
                  const rendered = segments.length > 0 ? segments : [""];
                  return (
                    <div className="space-y-1.5">
                      {rendered.map((segment, i) => (
                        <div
                          key={i}
                          className="text-xs leading-relaxed p-3 rounded-md border bg-[#11161d] border-[#1e2632] text-[#8b949e]"
                        >
                          <Markdown>{segment}</Markdown>
                        </div>
                      ))}

                      {msg.dispatch && (() => {
                        const dispatchAgent = team.find((a) => a.id === msg.dispatch!.agentId);
                        const status = msg.dispatch.status;
                        return (
                          <div className="mt-3 p-2.5 bg-[#060810] border border-cyan-500/10 rounded-md relative group overflow-hidden">
                            <div className="absolute left-0 inset-y-0 w-1 bg-gradient-to-b from-[#00e0ff] to-transparent" />
                            <div className="flex justify-between items-center text-[9px] font-mono text-cyan-400 uppercase tracking-wider mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5" />
                                Orchestrated Dispatch
                              </div>
                              {status === "working" ? (
                                <span className="text-[#3fb950] animate-pulse">Running</span>
                              ) : status === "failed" ? (
                                <span className="text-red-500">Failed</span>
                              ) : (
                                <span className="text-[#3fb950]">Done</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs font-semibold text-[#e6edf3]">
                              <span
                                className={`w-5 h-5 rounded bg-gradient-to-br ${
                                  dispatchAgent?.color ?? "from-blue-400 to-indigo-600"
                                } flex items-center justify-center text-black`}
                              >
                                <AgentIcon id={msg.dispatch.agentId} className="w-3 h-3" />
                              </span>
                              {msg.dispatch.agentName} <ArrowRight className="w-3 h-3 text-[#5c6470]" />{" "}
                              {dispatchAgent?.role ?? "Specialist"}
                            </div>
                            <p className="text-[11px] text-[#8b949e] mt-1">{msg.dispatch.task}</p>
                          </div>
                        );
                      })()}
                    </div>
                  );
                })()}
```

Note: the closing `)}` for the original `{msg.role !== "system" && (` wrapper is
now provided by the two new blocks above. The subsequent `{msg.approval && (`
block (which follows) is left exactly as-is — it already renders after the bubble.

- [ ] **Step 3: Verify the types and build compile**

Run: `pnpm exec tsc --noEmit`
Expected: PASS — no type errors. (`splitMessageSegments` returns `string[]`; the
`.map` callback types `segment` as `string`, matching `Markdown`'s `children: string`.)

Then run: `pnpm lint`
Expected: PASS — no new lint errors.

- [ ] **Step 4: Manual verification**

Run: `pnpm dev`, open a session, and send Sage a prompt that yields a
multi-paragraph reply containing a fenced code block (e.g. "Explain the diff
viewer and show a short code snippet"). Confirm:
- separate paragraphs render as separate stacked bubbles under one "Sage" header,
- the code block renders intact in a single bubble (not split at its blank lines),
- a dispatch turn still shows the dispatch card after the last bubble,
- user messages still render as a single bubble.

- [ ] **Step 5: Commit**

```bash
git add src/components/mission-control.tsx
git commit -m "feat(chat): render agent turns as one bubble per paragraph"
```

---

## Self-Review notes

- **Spec coverage:** Task 1 implements `splitMessageSegments` with fence atomicity, blank-line splitting, trimming, and the empty/unterminated-fence edge cases (spec §Components.1, §Error handling, §Testing). Task 2 implements the render change with one header, per-segment bubbles, dispatch card after last segment, and unchanged user/system messages (spec §Components.2, §Data flow). No server/SSE/DB work — matches spec §Out of scope.
- **Placeholder scan:** No TBDs; all code and commands are concrete.
- **Type consistency:** `splitMessageSegments(content: string): string[]` is referenced identically in the test, the import, and the `.map` in Task 2.
