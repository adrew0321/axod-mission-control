import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlanSnapshot } from "./plan-events";

test("a TodoWrite tool input becomes a plan snapshot", () => {
  const out = toPlanSnapshot(
    "TodoWrite",
    {
      todos: [
        { content: "Read the file", status: "completed", activeForm: "Reading the file" },
        { content: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
        { content: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
    },
    "sage",
  );
  assert.deepEqual(out, {
    agentId: "sage",
    todos: [
      { content: "Read the file", status: "completed", activeForm: "Reading the file" },
      { content: "Edit the file", status: "in_progress", activeForm: "Editing the file" },
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
    ],
  });
});

test("activeForm is optional and omitted when absent", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "Solo", status: "pending" }] }, "atlas");
  assert.deepEqual(out, { agentId: "atlas", todos: [{ content: "Solo", status: "pending" }] });
});

test("an unknown status is coerced to pending", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "X", status: "blocked" }] }, "sage");
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "X", status: "pending" }] });
});

test("a missing status defaults to pending", () => {
  const out = toPlanSnapshot("TodoWrite", { todos: [{ content: "X" }] }, "sage");
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "X", status: "pending" }] });
});

test("todos without usable content are dropped", () => {
  const out = toPlanSnapshot(
    "TodoWrite",
    { todos: [{ content: "Keep", status: "pending" }, { content: "" }, { status: "pending" }] },
    "sage",
  );
  assert.deepEqual(out, { agentId: "sage", todos: [{ content: "Keep", status: "pending" }] });
});

test("non-TodoWrite tools are ignored", () => {
  assert.equal(toPlanSnapshot("Read", { file_path: "x" }, "sage"), null);
  assert.equal(toPlanSnapshot("Bash", { command: "ls" }, "atlas"), null);
});

test("malformed TodoWrite input yields null", () => {
  assert.equal(toPlanSnapshot("TodoWrite", undefined, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", {}, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", { todos: "nope" }, "sage"), null);
  assert.equal(toPlanSnapshot("TodoWrite", { todos: [] }, "sage"), null);
});

test("a TodoWrite with only unusable todos yields null", () => {
  assert.equal(toPlanSnapshot("TodoWrite", { todos: [{ content: "" }, {}] }, "sage"), null);
});
