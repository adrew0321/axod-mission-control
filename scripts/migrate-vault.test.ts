import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateVault, ZONES } from './migrate-vault';

const note = (title: string, type: string) =>
  `---\ntitle: ${title}\ndescription: d\ntype: ${type}\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-02T00:00:00.000Z\n---\nBody of ${title}.`;

function seeded() {
  const d = mkdtempSync(join(tmpdir(), 'akira-mig-'));
  writeFileSync(join(d, 'hold-when-told.md'), note('Hold when told', 'lesson'));
  writeFileSync(join(d, 'forge-mc-designs.md'), note('Forge MC designs', 'fact'));
  writeFileSync(join(d, 'SOUL.md'), '# AKIRA — Soul\nVoice.');
  writeFileSync(join(d, 'INDEX.md'), '- [[forge-mc-designs]] — d');
  return d;
}

test('migrateVault moves notes into memory/ and leaves SOUL at the root', () => {
  const d = seeded();
  try {
    const out = migrateVault(d);
    assert.equal(out.moved, 2);
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
    assert.ok(existsSync(join(d, 'memory', 'forge-mc-designs.md')));
    assert.ok(!existsSync(join(d, 'hold-when-told.md')));
    assert.ok(existsSync(join(d, 'SOUL.md')), 'SOUL stays at the root');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault creates every zone with a stub INDEX.md', () => {
  const d = seeded();
  try {
    migrateVault(d);
    for (const z of ZONES) {
      assert.ok(existsSync(join(d, z, 'INDEX.md')), `${z}/INDEX.md missing`);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault writes a root CLAUDE.md map and a root INDEX.md that is not the recall index', () => {
  const d = seeded();
  try {
    migrateVault(d);
    assert.match(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), /INDEX\.md/);
    const rootIndex = readFileSync(join(d, 'INDEX.md'), 'utf8');
    assert.doesNotMatch(rootIndex, /forge-mc-designs/, 'root index is a zone map, not the recall index');
    assert.match(rootIndex, /memory/);
    assert.match(readFileSync(join(d, 'memory', 'INDEX.md'), 'utf8'), /forge-mc-designs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault is idempotent', () => {
  const d = seeded();
  try {
    migrateVault(d);
    // Simulate operator edits made in Obsidian between runs.
    writeFileSync(join(d, 'ops', 'INDEX.md'), 'HUMAN EDITED');
    writeFileSync(join(d, 'CLAUDE.md'), 'HUMAN EDITED CLAUDE');
    writeFileSync(join(d, 'INDEX.md'), 'HUMAN EDITED ROOT INDEX');

    const second = migrateVault(d);
    assert.equal(second.moved, 0);
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
    assert.equal(readFileSync(join(d, 'ops', 'INDEX.md'), 'utf8'), 'HUMAN EDITED', 'a zone INDEX.md that already exists must not be clobbered');
    assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), 'HUMAN EDITED CLAUDE', 'root CLAUDE.md is operator-editable and must survive a re-run');
    assert.equal(readFileSync(join(d, 'INDEX.md'), 'utf8'), 'HUMAN EDITED ROOT INDEX', 'root INDEX.md is operator-editable and must survive a re-run');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault leaves a stray non-note file and a *.md-named directory untouched', () => {
  const d = seeded();
  try {
    writeFileSync(join(d, 'README.md'), '# Just a readme\nNo frontmatter here.');
    mkdirSync(join(d, 'notes.md'));
    writeFileSync(join(d, 'notes.md', 'inner.md'), note('Inner', 'fact'));

    migrateVault(d);

    assert.ok(existsSync(join(d, 'README.md')), 'stray non-note file must stay at the root');
    assert.equal(
      readFileSync(join(d, 'README.md'), 'utf8'),
      '# Just a readme\nNo frontmatter here.',
      'stray non-note file content must be untouched',
    );
    assert.ok(existsSync(join(d, 'notes.md')), 'the notes.md directory must still exist');
    assert.ok(existsSync(join(d, 'notes.md', 'inner.md')), 'the directory must not have been traversed into or moved');
    assert.ok(!existsSync(join(d, 'memory', 'inner.md')), 'the file inside the directory must not have been moved');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault does not overwrite a memory/ note when a same-named note already sits there', () => {
  const d = seeded();
  try {
    mkdirSync(join(d, 'memory'), { recursive: true });
    writeFileSync(join(d, 'memory', 'forge-mc-designs.md'), note('Existing memory copy', 'fact'));

    const out = migrateVault(d);

    assert.equal(out.moved, 1, 'only the non-colliding note (hold-when-told.md) should be counted as moved');
    assert.ok(existsSync(join(d, 'forge-mc-designs.md')), 'the colliding root file must be left in place, not clobbered or lost');
    assert.deepEqual(out.stranded, ['forge-mc-designs.md'], 'the collision skip must surface as a stranded note, not vanish silently');
    assert.match(
      readFileSync(join(d, 'memory', 'forge-mc-designs.md'), 'utf8'),
      /Existing memory copy/,
      'the pre-existing memory/ note must not be overwritten',
    );
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('migrateVault reports no stranded notes when memory/ pre-exists empty', () => {
  const d = seeded();
  try {
    // An operator creating an empty memory/ folder in Obsidian before
    // migrating must not shadow the notes still waiting to move into it.
    mkdirSync(join(d, 'memory'), { recursive: true });

    const out = migrateVault(d);

    assert.equal(out.moved, 2, 'both notes must still move into the pre-existing empty memory/');
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
    assert.ok(existsSync(join(d, 'memory', 'forge-mc-designs.md')));
    assert.deepEqual(out.stranded, [], 'nothing should be left stranded at the root');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
