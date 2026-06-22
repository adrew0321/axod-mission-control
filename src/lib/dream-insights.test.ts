import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInsights } from "./dream-insights";

test("parses a clean JSON array", () => {
  const text = '[{"category":"risk","title":"T","detail":"D"}]';
  assert.deepEqual(parseInsights(text), [{ category: "risk", title: "T", detail: "D" }]);
});

test("parses a fenced ```json block with surrounding prose", () => {
  const text = 'Here are my insights:\n```json\n[{"category":"pattern","title":"P","detail":"d"}]\n```\nDone.';
  assert.deepEqual(parseInsights(text), [{ category: "pattern", title: "P", detail: "d" }]);
});

test("drops items with an unknown category", () => {
  const text = '[{"category":"bogus","title":"x","detail":"y"},{"category":"praise","title":"ok","detail":"good"}]';
  assert.deepEqual(parseInsights(text), [{ category: "praise", title: "ok", detail: "good" }]);
});

test("drops items missing a field or with empty strings", () => {
  const text = '[{"category":"risk","title":"x"},{"category":"risk","title":" ","detail":"y"},{"category":"suggestion","title":"keep","detail":"this"}]';
  assert.deepEqual(parseInsights(text), [{ category: "suggestion", title: "keep", detail: "this" }]);
});

test("trims title and detail", () => {
  assert.deepEqual(parseInsights('[{"category":"risk","title":"  T  ","detail":"  D  "}]'), [
    { category: "risk", title: "T", detail: "D" },
  ]);
});

test("returns [] for non-JSON / no array", () => {
  assert.deepEqual(parseInsights("I could not find anything notable."), []);
  assert.deepEqual(parseInsights(""), []);
});
