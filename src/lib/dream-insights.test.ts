import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInsights } from "./dream-insights";

test("parses a clean JSON array", () => {
  const text = '[{"category":"risk","title":"T","detail":"D"}]';
  assert.deepEqual(parseInsights(text), [{ category: "risk", title: "T", detail: "D", rank: 1 }]);
});

test("parses a fenced ```json block with surrounding prose", () => {
  const text = 'Here are my insights:\n```json\n[{"category":"pattern","title":"P","detail":"d"}]\n```\nDone.';
  assert.deepEqual(parseInsights(text), [{ category: "pattern", title: "P", detail: "d", rank: 1 }]);
});

test("drops items with an unknown category", () => {
  const text = '[{"category":"bogus","title":"x","detail":"y"},{"category":"praise","title":"ok","detail":"good"}]';
  assert.deepEqual(parseInsights(text), [{ category: "praise", title: "ok", detail: "good", rank: 1 }]);
});

test("drops items missing a field or with empty strings", () => {
  const text = '[{"category":"risk","title":"x"},{"category":"risk","title":" ","detail":"y"},{"category":"suggestion","title":"keep","detail":"this"}]';
  assert.deepEqual(parseInsights(text), [{ category: "suggestion", title: "keep", detail: "this", rank: 1 }]);
});

test("trims title and detail", () => {
  assert.deepEqual(parseInsights('[{"category":"risk","title":"  T  ","detail":"  D  "}]'), [
    { category: "risk", title: "T", detail: "D", rank: 1 },
  ]);
});

test("returns [] for non-JSON / no array", () => {
  assert.deepEqual(parseInsights("I could not find anything notable."), []);
  assert.deepEqual(parseInsights(""), []);
});

test("a valid rank is kept", () => {
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "T", detail: "D", rank: 2 },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].rank, 2);
});

test("a missing rank falls back to array position, 1-based", () => {
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D" },
    { category: "praise", title: "B", detail: "D" },
  ]));
  assert.deepEqual(out.map((i) => i.rank), [1, 2]);
});

test("a malformed rank falls back rather than dropping the insight", () => {
  // The whole point of the fallback (spec D4): a format miss must not lose
  // output from a pass that has already lost a third of its history to an outage.
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D", rank: "first" },
    { category: "risk", title: "B", detail: "D", rank: 0 },
    { category: "risk", title: "C", detail: "D", rank: -3 },
    { category: "risk", title: "E", detail: "D", rank: 1.5 },
  ]));
  assert.equal(out.length, 4, "no insight is dropped for a bad rank");
  assert.deepEqual(out.map((i) => i.rank), [1, 2, 3, 4]);
});

test("fallback positions count parsed insights, not raw array indexes", () => {
  // The middle item is invalid for a reason that DOES drop it (bad category),
  // so the survivors must be ranked 1 and 2 — not 1 and 3.
  const out = parseInsights(JSON.stringify([
    { category: "risk", title: "A", detail: "D" },
    { category: "nonsense", title: "B", detail: "D" },
    { category: "praise", title: "C", detail: "D" },
  ]));
  assert.deepEqual(out.map((i) => i.title), ["A", "C"]);
  assert.deepEqual(out.map((i) => i.rank), [1, 2]);
});
