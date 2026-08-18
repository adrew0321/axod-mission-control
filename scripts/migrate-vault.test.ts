import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
    const second = migrateVault(d);
    assert.equal(second.moved, 0);
    assert.ok(existsSync(join(d, 'memory', 'hold-when-told.md')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
