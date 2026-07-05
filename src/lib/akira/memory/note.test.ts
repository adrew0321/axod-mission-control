import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, safeSlug, serializeNote, parseNote, buildIndex, isNoteFile, type Note } from './note';

const note = (p: Partial<Note>): Note => ({
  slug: 'x', title: 'X', description: 'a note', type: 'fact',
  created: '2026-07-03T00:00:00.000Z', updated: '2026-07-03T00:00:00.000Z', body: 'body', ...p,
});

test('slugify lowercases and dashes non-alphanumerics', () => {
  assert.equal(slugify('Operator prefers X!'), 'operator-prefers-x');
  assert.equal(slugify('  Multiple   spaces  '), 'multiple-spaces');
});

test('safeSlug sanitizes and rejects traversal/empty (no slashes or dots survive)', () => {
  assert.equal(safeSlug('good-slug'), 'good-slug');
  assert.equal(safeSlug('../etc/passwd'), 'etc-passwd');
  assert.equal(safeSlug('..'), null);
  assert.equal(safeSlug('///'), null);
  assert.equal(safeSlug(''), null);
});

test('serializeNote/parseNote round-trip (slug is supplied, not stored)', () => {
  const n = note({ slug: 'obsidian', title: 'Obsidian memory', description: 'git-synced vault', type: 'project', body: 'Body [[link]].\n\nSecond para.' });
  const parsed = parseNote('obsidian', serializeNote(n));
  assert.deepEqual(parsed, n);
});

test('parseNote tolerates a file with no frontmatter', () => {
  const parsed = parseNote('loose', 'just body');
  assert.equal(parsed.body, 'just body');
  assert.equal(parsed.title, 'loose');
});

test('isNoteFile is true only for files with a frontmatter block', () => {
  assert.equal(isNoteFile(serializeNote(note({}))), true);
  assert.equal(isNoteFile('---\ntitle: x\n---\nbody'), true);
  assert.equal(isNoteFile('# A README\n\njust prose'), false);
  assert.equal(isNoteFile('no frontmatter here'), false);
  assert.equal(isNoteFile('---\nunterminated frontmatter'), false);
});

test('serializeNote strips newlines from frontmatter fields (never corrupts the block)', () => {
  const md = serializeNote(note({ title: 'Line one\nLine two', description: 'a\r\nb' }));
  assert.match(md, /^---\ntitle: Line one Line two\ndescription: a b\n/);
  // still parses cleanly — the body is intact and the frontmatter didn't leak
  const parsed = parseNote('x', md);
  assert.equal(parsed.title, 'Line one Line two');
  assert.equal(parsed.body, 'body');
});

test('buildIndex lists notes newest-first as wikilinks', () => {
  const idx = buildIndex([
    note({ slug: 'old', description: 'older', updated: '2026-07-01T00:00:00.000Z' }),
    note({ slug: 'new', description: 'newer', updated: '2026-07-03T00:00:00.000Z' }),
  ]);
  assert.equal(idx, '- [[new]] — newer\n- [[old]] — older');
});
