import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, stripMarkdown, isLongReply } from './format';

test('splits blank-line-separated text into paragraph blocks', () => {
  const blocks = parseReply('First paragraph.\n\nSecond paragraph.');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'paragraph');
  assert.deepEqual(blocks[0].type === 'paragraph' && blocks[0].spans, [
    { type: 'text', value: 'First paragraph.' },
  ]);
});

test('groups consecutive bullet lines into a single list block', () => {
  const blocks = parseReply('Here are the sources:\n\n- One\n- Two\n- Three');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[1].type, 'list');
  const list = blocks[1];
  assert.equal(list.type === 'list' && list.items.length, 3);
  assert.deepEqual(list.type === 'list' && list.items[0], [{ type: 'text', value: 'One' }]);
});

test('parses inline bold and links inside a paragraph', () => {
  const blocks = parseReply('It is **not** another LLM — see [the template](https://example.com/t).');
  assert.equal(blocks.length, 1);
  const p = blocks[0];
  assert.deepEqual(p.type === 'paragraph' && p.spans, [
    { type: 'text', value: 'It is ' },
    { type: 'bold', value: 'not' },
    { type: 'text', value: ' another LLM — see ' },
    { type: 'link', label: 'the template', url: 'https://example.com/t' },
    { type: 'text', value: '.' },
  ]);
});

test('preserves a single newline inside a paragraph as a soft break', () => {
  const blocks = parseReply('Line one\nLine two');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(
    blocks[0].type === 'paragraph' && blocks[0].spans[0].type === 'text' && blocks[0].spans[0].value,
    'Line one\nLine two',
  );
});

test('stripMarkdown yields clean spoken text (no symbols, links become labels)', () => {
  const out = stripMarkdown('It is **not** an LLM. See [the template](https://example.com).');
  assert.equal(out, 'It is not an LLM. See the template.');
});

test('stripMarkdown drops leading bullet markers', () => {
  assert.equal(stripMarkdown('- First\n- Second'), 'First\nSecond');
});

test('isLongReply: a short one-liner is not long (stays centered)', () => {
  assert.equal(isLongReply("It's a memory framework that keeps notes across sessions."), false);
});

test('isLongReply: multiple paragraphs is long', () => {
  assert.equal(isLongReply('First thought.\n\nSecond thought.'), true);
});

test('isLongReply: a bullet list is long', () => {
  assert.equal(isLongReply('Options:\n\n- One\n- Two'), true);
});

test('isLongReply: a single very long paragraph is long', () => {
  assert.equal(isLongReply('word '.repeat(60)), true);
});

test('parses a fenced code block as its own block', () => {
  const blocks = parseReply('Run this:\n\n```\npnpm exec playwright install\n```\n\nThen retry.');
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[1], { type: 'code', value: 'pnpm exec playwright install' });
  assert.equal(blocks[2].type, 'paragraph');
});

test('a code fence with a language label still captures just the code', () => {
  const blocks = parseReply('```bash\nls -la\n```');
  assert.deepEqual(blocks, [{ type: 'code', value: 'ls -la' }]);
});

test('a multi-line code block keeps its internal blank lines', () => {
  const blocks = parseReply('```\nline1\n\nline2\n```');
  assert.deepEqual(blocks, [{ type: 'code', value: 'line1\n\nline2' }]);
});

test('parses inline code spans', () => {
  const blocks = parseReply('use the `Read` tool');
  assert.deepEqual(blocks[0].type === 'paragraph' && blocks[0].spans, [
    { type: 'text', value: 'use the ' },
    { type: 'code', value: 'Read' },
    { type: 'text', value: ' tool' },
  ]);
});

test('isLongReply: a code block makes it long (renders left)', () => {
  assert.equal(isLongReply('```\nls\n```'), true);
});

test('stripMarkdown drops code fences and inline backticks for clean speech', () => {
  assert.equal(stripMarkdown('```\nls -la\n```'), 'ls -la');
  assert.equal(stripMarkdown('use the `Read` tool'), 'use the Read tool');
});
