import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePathReal } from './paths-real';

/**
 * Probe whether this host can actually create a symlink. Creating symlinks on
 * Windows needs Developer Mode or elevation — it often IS available, so a
 * blanket platform skip would mean this security control's RED step (and its
 * GREEN step) never actually execute during local development. POSIX hosts
 * (the room is Linux) can always do this.
 */
async function canSymlink(): Promise<boolean> {
  const base = await mkdtemp(join(tmpdir(), 'room-symlink-probe-'));
  try {
    await symlink(join(base, 'target'), join(base, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// Symlinks need Developer Mode or elevation on Windows. Probe the real
// capability rather than assuming from the platform, so these tests run
// wherever they actually can — and skip honestly where they cannot.
const skip = (await canSymlink()) ? false : 'symlink creation unavailable on this host';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'room-paths-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  const outside = join(base, 'secrets');
  await mkdir(room, { recursive: true });
  await mkdir(doorway, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'prod.env'), 'TOKEN=hunter2');
  return { roots: { room, doorway }, outside };
}

test('an ordinary path inside the room is allowed', { skip }, async () => {
  const { roots } = await fixture();
  await writeFile(join(roots.room, 'notes.md'), 'hi');
  const v = await validatePathReal(roots, 'notes.md');
  assert.equal(v.ok, true);
});

test('a file symlink pointing outside the room is refused', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(join(outside, 'prod.env'), join(roots.room, 'escape'));
  const v = await validatePathReal(roots, 'escape');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /outside/i);
});

test('a directory symlink pointing outside the room is refused', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(outside, join(roots.room, 'out'));
  const v = await validatePathReal(roots, 'out/prod.env');
  assert.equal(v.ok, false);
});

test('a symlink planted in the doorway is refused too', { skip }, async () => {
  const { roots, outside } = await fixture();
  await symlink(outside, join(roots.doorway, 'out'));
  const v = await validatePathReal(roots, join(roots.doorway, 'out', 'prod.env'));
  assert.equal(v.ok, false);
});

test('a not-yet-existing leaf under a real directory is allowed (fs_write creates it)', { skip }, async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, 'reports/new-file.md');
  assert.equal(v.ok, true, 'writing a new file must still work');
});

test('the pure gate still rejects first — no fs call needed for an obvious escape', { skip }, async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, '../../etc/passwd');
  assert.equal(v.ok, false);
});

test('a symlink that stays inside the room is allowed', { skip }, async () => {
  const { roots } = await fixture();
  await mkdir(join(roots.room, 'real'), { recursive: true });
  await writeFile(join(roots.room, 'real', 'a.txt'), 'a');
  await symlink(join(roots.room, 'real'), join(roots.room, 'link'));
  const v = await validatePathReal(roots, 'link/a.txt');
  assert.equal(v.ok, true);
});
