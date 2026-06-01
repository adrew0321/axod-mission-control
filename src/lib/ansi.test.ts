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

test("bare reset \\x1b[m is equivalent to \\x1b[0m", () => {
  assert.deepEqual(parseAnsi("\x1b[31m\x1b[mplain"), [{ text: "plain" }]);
});

test("256-color selector (38;5;N) does not let the previous color bleed", () => {
  assert.deepEqual(parseAnsi("\x1b[31mred\x1b[38;5;196mxterm256\x1b[0mplain"), [
    { text: "red", color: "#f87171" },
    { text: "xterm256" },
    { text: "plain" },
  ]);
});

test("truecolor selector (38;2;r;g;b) also clears the current color", () => {
  assert.deepEqual(parseAnsi("\x1b[32mg\x1b[38;2;10;20;30mtrue"), [
    { text: "g", color: "#3fb950" },
    { text: "true" },
  ]);
});

test("OSC sequences (title) are stripped, surrounding text intact", () => {
  assert.deepEqual(parseAnsi("a\x1b]0;my title\x07b"), [
    { text: "a" },
    { text: "b" },
  ]);
});
