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
    // Both: result is capped at 4096 AND trim removed the leading spaces
    assert.equal(result.length, 4096);
    assert.equal(result[0], 'y'); // First char should be 'y', not a space
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultBlock wraps a map and stays empty for none', () => {
  assert.equal(vaultBlock(''), '');
  assert.equal(vaultBlock('   '), '');
  assert.equal(vaultBlock('# Vault'), '## VAULT\n# Vault');
});
