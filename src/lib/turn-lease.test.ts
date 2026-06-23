import { test } from "node:test";
import assert from "node:assert/strict";
import { isLeaseHeld, resolveTurnInput, LEASE_GRACE_MS } from "./turn-lease";

const MAX = 600_000; // 10 min

test("no lease (null) is not held", () => {
  assert.equal(isLeaseHeld(null, Date.now(), MAX), false);
});

test("a fresh lease is held", () => {
  const now = Date.now();
  assert.equal(isLeaseHeld(new Date(now - 1000), now, MAX), true);
});

test("a lease within max+grace is still held", () => {
  const now = Date.now();
  const justInside = new Date(now - (MAX + LEASE_GRACE_MS) + 1000);
  assert.equal(isLeaseHeld(justInside, now, MAX), true);
});

test("a lease older than max+grace is stale (not held)", () => {
  const now = Date.now();
  const expired = new Date(now - (MAX + LEASE_GRACE_MS) - 1000);
  assert.equal(isLeaseHeld(expired, now, MAX), false);
});

test("instruction wins → kind 'instruction' with trimmed content", () => {
  assert.deepEqual(resolveTurnInput("  do the thing  ", false), {
    kind: "instruction",
    content: "do the thing",
  });
});

test("no instruction but a pending user message → kind 'reply'", () => {
  assert.deepEqual(resolveTurnInput(undefined, true), { kind: "reply" });
});

test("empty/whitespace instruction is ignored", () => {
  assert.deepEqual(resolveTurnInput("   ", true), { kind: "reply" });
});

test("nothing to respond to → kind 'none'", () => {
  assert.deepEqual(resolveTurnInput(undefined, false), { kind: "none" });
  assert.deepEqual(resolveTurnInput("", false), { kind: "none" });
});
