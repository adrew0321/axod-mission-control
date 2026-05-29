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

test("a backtick fence is not closed by a tilde line inside it", () => {
  const input = "```js\ncode\n~~~\nstill code\n```";
  assert.deepEqual(splitMessageSegments(input), [
    "```js\ncode\n~~~\nstill code\n```",
  ]);
});

test("CRLF line endings are normalized to LF in output", () => {
  const input = "First.\r\n\r\nSecond.";
  assert.deepEqual(splitMessageSegments(input), ["First.", "Second."]);
});

test("a CRLF fenced block stays atomic with LF-normalized contents", () => {
  const input = "```js\r\nconst a = 1;\r\n\r\nconst b = 2;\r\n```";
  assert.deepEqual(splitMessageSegments(input), [
    "```js\nconst a = 1;\n\nconst b = 2;\n```",
  ]);
});
