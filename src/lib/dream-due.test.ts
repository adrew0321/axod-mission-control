import { test } from "node:test";
import assert from "node:assert/strict";
import { isDreamDue } from "./dream-due";

const at = (h: number) => new Date(2026, 5, 22, h, 0, 0, 0);

test("not due before the nightly hour", () => {
  assert.equal(isDreamDue(null, at(1), 3), false);
});

test("due after the hour with no prior dream", () => {
  assert.equal(isDreamDue(null, at(4), 3), true);
});

test("not due after the hour when last dream was recent (<12h)", () => {
  const now = at(4);
  const recent = new Date(now.getTime() - 2 * 3_600_000);
  assert.equal(isDreamDue(recent, now, 3), false);
});

test("due after the hour when last dream is stale (>12h)", () => {
  const now = at(4);
  const stale = new Date(now.getTime() - 26 * 3_600_000);
  assert.equal(isDreamDue(stale, now, 3), true);
});
