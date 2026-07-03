import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listNotes, readNote, writeNote, deleteNote, indexText } from './store';

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
