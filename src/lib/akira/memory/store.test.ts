import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listNotes, readNote, writeNote, deleteNote, indexText, lessonsText } from './store';

const vault = () => mkdtempSync(join(tmpdir(), 'akira-mem-'));

test('writeNote then listNotes/readNote round-trips', () => {
  const dir = vault();
  try {
    const n = writeNote({ title: 'Obsidian memory', description: 'git-synced vault', type: 'project', body: 'Body.' }, dir);
    assert.equal(n.slug, 'obsidian-memory');
    assert.equal(listNotes(dir).length, 1);
    assert.equal(readNote('obsidian-memory', dir)?.body, 'Body.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeNote upsert preserves created and does not duplicate', () => {
  const dir = vault();
  try {
    const a = writeNote({ title: 'X', description: 'first', type: 'fact', body: 'one' }, dir);
    const b = writeNote({ slug: a.slug, title: 'X', description: 'second', type: 'fact', body: 'two' }, dir);
    assert.equal(b.created, a.created);
    assert.equal(b.description, 'second');
    assert.equal(listNotes(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listNotes ignores stray .md files without frontmatter (e.g. a README)', () => {
  const dir = vault();
  try {
    writeNote({ title: 'Real', description: 'r', type: 'fact', body: 'r' }, dir);
    writeFileSync(join(dir, 'README.md'), '# Notes\n\njust prose, not a memory');
    const list = listNotes(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Real');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteNote removes the note and refreshes the index', () => {
  const dir = vault();
  try {
    writeNote({ title: 'Keep', description: 'k', type: 'fact', body: 'k' }, dir);
    const g = writeNote({ title: 'Gone', description: 'g', type: 'fact', body: 'g' }, dir);
    assert.equal(deleteNote(g.slug, dir), true);
    assert.equal(deleteNote('nope', dir), false);
    assert.equal(listNotes(dir).length, 1);
    assert.match(indexText(dir), /\[\[keep\]\]/);
    assert.doesNotMatch(indexText(dir), /\[\[gone\]\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('indexText excludes lesson notes; lessonsText returns them in full', () => {
  const d = vault();
  try {
    writeNote({ title: 'Mini is UTC', description: 'clock', type: 'fact', body: 'The Mini runs UTC.' }, d);
    writeNote({ title: 'Terse briefs', description: 'prefers terse', type: 'lesson', body: 'A’Keem wants the morning brief in 2 sentences.' }, d);

    // buildIndex renders `[[slug]] — description`, not the title — so assert on
    // the slug (indexText's real vocabulary), same convention as the deleteNote test above.
    const idx = indexText(d);
    assert.ok(idx.includes('[[mini-is-utc]]'));
    assert.ok(!idx.includes('[[terse-briefs]]')); // lessons are NOT in the memory index

    const lessons = lessonsText(d);
    assert.ok(lessons.includes('A’Keem wants the morning brief in 2 sentences.')); // full body
    assert.ok(!lessons.includes('The Mini runs UTC.')); // non-lessons excluded
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText is empty when there are no lessons', () => {
  const d = vault();
  try {
    writeNote({ title: 'x', description: 'y', type: 'fact', body: 'z' }, d);
    assert.equal(lessonsText(d), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText respects the note-count cap, newest first', () => {
  const d = vault();
  try {
    for (let i = 0; i < 25; i++) {
      writeNote({ title: `lesson ${i}`, description: `d${i}`, type: 'lesson', body: `body ${i}` }, d);
    }
    const out = lessonsText(d, { maxNotes: 5, maxChars: 100_000 });
    assert.equal((out.match(/body \d+/g) ?? []).length, 5);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lessonsText respects the char budget', () => {
  const d = vault();
  try {
    for (let i = 0; i < 10; i++) {
      writeNote({ title: `L${i}`, description: `d${i}`, type: 'lesson', body: 'x'.repeat(50) }, d);
    }
    const out = lessonsText(d, { maxNotes: 100, maxChars: 120 });
    assert.ok(out.length <= 200); // stops well before all 10 (~500+ chars of bodies)
  } finally { rmSync(d, { recursive: true, force: true }); }
});
