import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRun,
  summarizeCadence,
  parseCadence,
  cadenceColumns,
  type Cadence,
} from "./schedule";

// All local-time Dates so the asserts are timezone-independent.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi, 0, 0);

test("every_hours: from + N hours", () => {
  const next = computeNextRun({ kind: "every_hours", intervalHours: 4 }, at(2026, 5, 21, 10, 0));
  assert.equal(next.getTime(), at(2026, 5, 21, 14, 0).getTime());
});

test("daily: later today when time is still ahead", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 1, 30));
  assert.equal(next.getTime(), at(2026, 5, 21, 9, 0).getTime());
});

test("daily: rolls to tomorrow when time already passed", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 10, 0));
  assert.equal(next.getTime(), at(2026, 5, 22, 9, 0).getTime());
});

test("daily: equal time rolls forward (strictly after)", () => {
  const next = computeNextRun({ kind: "daily", timeOfDay: "09:00" }, at(2026, 5, 21, 9, 0));
  assert.equal(next.getTime(), at(2026, 5, 22, 9, 0).getTime());
});

test("weekly: advances to the right weekday at the time", () => {
  // 2026-06-21 is a Sunday (getDay()===0). Target Wednesday (3) at 09:00.
  const next = computeNextRun({ kind: "weekly", dayOfWeek: 3, timeOfDay: "09:00" }, at(2026, 5, 21, 12, 0));
  assert.equal(next.getDay(), 3);
  assert.equal(next.getTime(), at(2026, 5, 24, 9, 0).getTime());
});

test("weekly: same weekday but time passed → next week", () => {
  // Sunday target, from is Sunday 12:00 with 09:00 time → +7 days.
  const next = computeNextRun({ kind: "weekly", dayOfWeek: 0, timeOfDay: "09:00" }, at(2026, 5, 21, 12, 0));
  assert.equal(next.getTime(), at(2026, 5, 28, 9, 0).getTime());
});

test("summarizeCadence renders each kind", () => {
  assert.equal(summarizeCadence({ kind: "every_hours", intervalHours: 1 }), "Every 1 hour");
  assert.equal(summarizeCadence({ kind: "every_hours", intervalHours: 4 }), "Every 4 hours");
  assert.equal(summarizeCadence({ kind: "daily", timeOfDay: "09:00" }), "Daily at 09:00");
  assert.equal(summarizeCadence({ kind: "weekly", dayOfWeek: 1, timeOfDay: "09:00" }), "Weekly on Mon at 09:00");
});

test("parseCadence ↔ cadenceColumns round-trip", () => {
  const cases: Cadence[] = [
    { kind: "every_hours", intervalHours: 6 },
    { kind: "daily", timeOfDay: "23:30" },
    { kind: "weekly", dayOfWeek: 5, timeOfDay: "08:15" },
  ];
  for (const c of cases) {
    const cols = cadenceColumns(c);
    assert.deepEqual(parseCadence(cols), c);
  }
});
