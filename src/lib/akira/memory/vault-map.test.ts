import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVaultMap, vaultBlock } from './vault-map';

const vault = () => mkdtempSync(join(tmpdir(), 'akira-map-'));

test('readVaultMap returns the root CLAUDE.md', () => {
  const d = vault();
  try {
    writeFileSync(join(d, 'CLAUDE.md'), '# Vault\nNavigate via INDEX.md.\n');
    assert.match(readVaultMap(d), /Navigate via INDEX\.md/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readVaultMap is empty when there is no CLAUDE.md', () => {
  const d = vault();
  try {
    assert.equal(readVaultMap(d), '');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readVaultMap truncates an oversized map (trim-before-slice order)', () => {
  const d = vault();
  try {
    // Pad with spaces beyond the cap boundary to validate trim happens before slice
    writeFileSync(join(d, 'CLAUDE.md'), '  ' + 'y'.repeat(9000) + '  ');
    const result = readVaultMap(d, 4096);
    // The result must never exceed the cap, and trim must run before slice —
    // no unbroken 'y' run has a newline to cut at, so this exercises the
    // hard-slice fallback and the leading spaces must still be gone.
    assert.ok(result.length <= 4096);
    assert.equal(result[0], 'y'); // First char should be 'y', not a space
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('readVaultMap cuts at the last newline before the cap, not mid-line', () => {
  const d = vault();
  try {
    // Lines of uneven length so the cap is very unlikely to land exactly on
    // a newline by chance — if the fix regresses to a hard slice, this line
    // structure will produce a partial line and fail the assertion below.
    let body = '# Vault\n';
    for (let i = 0; i < 30; i++) body += `line ${i}: ${'z'.repeat(i)}\n`;
    writeFileSync(join(d, 'CLAUDE.md'), body);

    const result = readVaultMap(d, 120);

    assert.ok(result.length <= 120, 'never exceeds the cap');
    assert.ok(result.length > 0);
    // The cut lands exactly at a newline boundary in the source text — the
    // last full line at or before the cap, never a partial line.
    const cutPoint = body.slice(0, 120).lastIndexOf('\n');
    assert.equal(result, body.slice(0, cutPoint));
    assert.ok(!result.endsWith('\n'), 'the trailing newline itself is excluded from the cut');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultBlock wraps a map and stays empty for none', () => {
  assert.equal(vaultBlock(''), '');
  assert.equal(vaultBlock('   '), '');
  assert.equal(vaultBlock('# Vault'), '## VAULT\n# Vault');
});
