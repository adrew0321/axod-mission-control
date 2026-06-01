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
