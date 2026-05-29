import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "./ansi";

test("plain text is a single default segment", () => {
  assert.deepEqual(parseAnsi("hello world"), [{ text: "hello world" }]);
});

test("empty string yields no segments", () => {
  assert.deepEqual(parseAnsi(""), []);
});

test("a color sequence colors the following text; reset returns to default", () => {
  assert.deepEqual(parseAnsi("\x1b[31mred\x1b[0mplain"), [
    { text: "red", color: "#f87171" },
    { text: "plain" },
  ]);
});

test("bold on then off", () => {
  assert.deepEqual(parseAnsi("\x1b[1mbold\x1b[22mnormal"), [
    { text: "bold", bold: true },
    { text: "normal" },
  ]);
});

test("bright foreground color is supported", () => {
  assert.deepEqual(parseAnsi("\x1b[92mgreen"), [
    { text: "green", color: "#56d364" },
  ]);
});

test("unknown SGR codes are ignored, text preserved", () => {
  assert.deepEqual(parseAnsi("\x1b[7minverse\x1b[0m"), [{ text: "inverse" }]);
});

test("non-SGR escape sequences (cursor/clear) are stripped", () => {
  assert.deepEqual(parseAnsi("before\x1b[2Kafter"), [
    { text: "before" },
    { text: "after" },
  ]);
});

test("combined code list applies color and bold together", () => {
  assert.deepEqual(parseAnsi("\x1b[1;36mhi"), [
    { text: "hi", color: "#00e0ff", bold: true },
  ]);
});
