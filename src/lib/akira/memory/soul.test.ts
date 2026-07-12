import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSoul, writeSoul, seedSoulIfMissing, DEFAULT_SOUL, SOUL_FILE } from './soul';
import { writeSoulProposal, readSoulProposal, clearSoulProposal } from './soul';

function tmp(): string { return mkdtempSync(join(tmpdir(), 'akira-soul-')); }

test('readSoul returns DEFAULT_SOUL when the file is missing', () => {
  assert.equal(readSoul(tmp()), DEFAULT_SOUL);
});

test('readSoul returns DEFAULT_SOUL when the file is empty/whitespace', () => {
  const d = tmp();
  writeFileSync(join(d, SOUL_FILE), '   \n');
  assert.equal(readSoul(d), DEFAULT_SOUL);
});

test('writeSoul then readSoul round-trips', () => {
  const d = tmp();
  writeSoul('I am AKIRA, terse and warm.', d);
  assert.equal(readSoul(d), 'I am AKIRA, terse and warm.');
});

test('seedSoulIfMissing writes DEFAULT_SOUL once and never overwrites an edit', () => {
  const d = tmp();
  seedSoulIfMissing(d);
  assert.equal(readFileSync(join(d, SOUL_FILE), 'utf8'), DEFAULT_SOUL);
  writeSoul('edited soul', d);
  seedSoulIfMissing(d); // must NOT clobber the edit
  assert.equal(readSoul(d), 'edited soul');
});

test('DEFAULT_SOUL is non-empty and first-person', () => {
  assert.ok(DEFAULT_SOUL.length > 40);
  assert.match(DEFAULT_SOUL, /I am AKIRA/);
});

test('writeSoulProposal then readSoulProposal round-trips text + reason', () => {
  const d = tmp();
  writeSoulProposal('I am AKIRA, terser.', 'he values brevity', d);
  const p = readSoulProposal(d);
  assert.equal(p?.text, 'I am AKIRA, terser.');
  assert.equal(p?.reason, 'he values brevity');
});

test('readSoulProposal is null when none exists', () => {
  assert.equal(readSoulProposal(tmp()), null);
});

test('a fresh proposal overwrites the prior (freshest wins)', () => {
  const d = tmp();
  writeSoulProposal('first', 'r1', d);
  writeSoulProposal('second', 'r2', d);
  assert.equal(readSoulProposal(d)?.text, 'second');
});

test('clearSoulProposal removes it', () => {
  const d = tmp();
  writeSoulProposal('x', 'y', d);
  clearSoulProposal(d);
  assert.equal(readSoulProposal(d), null);
});
