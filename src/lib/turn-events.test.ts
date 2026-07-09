import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalTurnEvent } from "./turn-events";

test("persisted is terminal", () => {
  assert.equal(isTerminalTurnEvent({ type: "persisted" }), true);
});

test("skipped is terminal", () => {
  assert.equal(isTerminalTurnEvent({ type: "skipped", reason: "turn already running" }), true);
});

test("a fatal error is terminal", () => {
  assert.equal(isTerminalTurnEvent({ type: "error", message: "agent ended", fatal: true }), true);
});

test("a non-fatal error is NOT terminal", () => {
  assert.equal(isTerminalTurnEvent({ type: "error", message: "agent error: rate_limit", fatal: false }), false);
});

test("an error with no fatal flag is treated as non-terminal (safe default)", () => {
  assert.equal(isTerminalTurnEvent({ type: "error", message: "legacy error" }), false);
});

test("ordinary streaming events are not terminal", () => {
  assert.equal(isTerminalTurnEvent({ type: "token", content: "hi" }), false);
  assert.equal(isTerminalTurnEvent({ type: "activity", tool: "Read" }), false);
  assert.equal(isTerminalTurnEvent({ type: "start", messageId: "msg_1" }), false);
});
