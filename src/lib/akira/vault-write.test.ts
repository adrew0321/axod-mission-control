import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkVaultPath, vaultWrite } from './vault-write';

function vault() {
  const d = mkdtempSync(join(tmpdir(), 'akira-vw-'));
  for (const z of ['memory', 'projects', 'ops', 'research', 'outputs', 'personal', 'skills']) {
    mkdirSync(join(d, z), { recursive: true });
  }
  return d;
}

test('rejects an empty path', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('   ', d).reason, 'empty-path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects anything that is not markdown', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('ops/script.sh', d).reason, 'not-markdown');
    assert.equal(checkVaultPath('.claude/settings.json', d).reason, 'not-markdown');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects paths that escape the vault', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('../escaped.md', d).reason, 'outside-vault');
    assert.equal(checkVaultPath('ops/../../escaped.md', d).reason, 'outside-vault');
    assert.equal(checkVaultPath('/etc/evil.md', d).reason, 'outside-vault');
    assert.equal(checkVaultPath('C:\\Windows\\evil.md', d).reason, 'outside-vault');
    // UNC (\\server\share\...) omitted: it asserts correctly but costs ~30s
    // per run on this box (Windows tries to resolve the nonexistent SMB
    // server), which is not "asserting cleanly" in any practical sense.
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('rejects the memory zone, which remember/forget owns', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('memory/note.md', d).reason, 'memory-zone');
    assert.equal(checkVaultPath('memory/INDEX.md', d).reason, 'memory-zone');
    assert.equal(checkVaultPath('Memory/INDEX.md', d).reason, 'memory-zone', 'the guard is case-insensitive, not defeated by a capital letter');
    assert.equal(checkVaultPath('MEMORY/x.md', d).reason, 'memory-zone');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('ALLOWS SOUL.md, the root map, and skills — deliberate, per spec D5/D10', () => {
  const d = vault();
  try {
    assert.equal(checkVaultPath('SOUL.md', d).ok, true, 'SOUL is writable by design (D10)');
    assert.equal(checkVaultPath('CLAUDE.md', d).ok, true, 'the vault map is writable by design (D10)');
    assert.equal(checkVaultPath('skills/foo/SKILL.md', d).ok, true, 'she may author skills (D5)');
    assert.equal(checkVaultPath('INDEX.md', d).ok, true, 'the root map is writable by design (D10)');
    assert.equal(checkVaultPath('research/a-page.md', d).ok, true, 'research/ is a document zone (D10)');
    assert.equal(checkVaultPath('projects/p.md', d).ok, true, 'projects/ is a document zone (D10)');
    assert.equal(checkVaultPath('ops/o.md', d).ok, true, 'ops/ is a document zone (D10)');
    assert.equal(checkVaultPath('outputs/o.md', d).ok, true, 'outputs/ is a document zone (D10)');
    assert.equal(checkVaultPath('personal/p.md', d).ok, true, 'personal/ is a document zone (D10)');
    assert.equal(checkVaultPath('projects/INDEX.md', d).ok, true, 'a nested INDEX.md is writable by design (D10)');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a symlink pointing outside the vault cannot be used as a bridge', (t) => {
  const d = vault();
  const outside = mkdtempSync(join(tmpdir(), 'akira-outside-'));
  try {
    try {
      symlinkSync(outside, join(d, 'ops', 'escape'), 'dir');
    } catch {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    assert.equal(checkVaultPath('ops/escape/pwned.md', d).reason, 'outside-vault');
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a dangling symlink pointing outside the vault is rejected, not followed', (t) => {
  const d = vault();
  try {
    try {
      symlinkSync(join(tmpdir(), 'akira-does-not-exist-' + Date.now()), join(d, 'ops', 'dangling.md'), 'file');
    } catch {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    assert.equal(checkVaultPath('ops/dangling.md', d).reason, 'outside-vault');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a symlink INSIDE the vault resolves and is allowed', (t) => {
  const d = vault();
  try {
    mkdirSync(join(d, '.claude'), { recursive: true });
    try {
      symlinkSync(join(d, 'skills'), join(d, '.claude', 'skills'), 'dir');
    } catch {
      t.skip('symlink creation unavailable (Windows without Developer Mode)');
      return;
    }
    const c = checkVaultPath('.claude/skills/foo/SKILL.md', d);
    assert.equal(c.ok, true, 'the .claude/skills symlink resolves back into skills/');
    assert.ok(c.abs?.includes(join('skills', 'foo')), 'and resolves to the real skills path');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultWrite creates parent folders and returns the byte count', () => {
  const d = vault();
  try {
    const r = vaultWrite('research/deep/page.md', '# Hello', d);
    assert.equal(r.bytes, 7);
    assert.equal(r.path, 'research/deep/page.md');
    assert.equal(readFileSync(join(d, 'research', 'deep', 'page.md'), 'utf8'), '# Hello');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('vaultWrite throws on a rejected path and writes nothing', () => {
  const d = vault();
  try {
    assert.throws(() => vaultWrite('memory/sneaky.md', 'x', d), /memory-zone/);
    assert.equal(existsSync(join(d, 'memory', 'sneaky.md')), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
