import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePathReal } from './paths-real';

// A real dir symlink needs elevation on Windows; an NTFS junction does not,
// and realpath() resolves through it the same way. Prefer the symlink so the
// test is exact on Linux, fall back so it still EXECUTES on Windows.
//
// Caution for the next reader: a junction is not a POSIX symlink (no file
// junctions, no cross-filesystem tricks, different reparse semantics). A
// green run here on Windows is genuine evidence the resolve-then-regate
// logic works against a real linked directory, but it is weaker evidence
// than a POSIX symlink run, and it does not retire the on-the-Mini
// verification in the final deploy task.
async function linkDir(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, 'dir');
  } catch {
    await symlink(target, linkPath, 'junction');
  }
}

/**
 * Probe whether this host can create a real (POSIX-style) *file* symlink.
 * Unlike a directory link, there is no privilege-free fallback for a file
 * symlink (junctions are directory-only), so when this probe says no, that
 * one test's skip means "genuinely unverified here," not "verified via a
 * substitute."
 */
async function canFileSymlink(): Promise<boolean> {
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

// File symlinks need Developer Mode or elevation on Windows, with no
// junction-style fallback. Probe the real capability rather than assuming
// from the platform, so this one test runs wherever it actually can — and
// skips honestly, with a specific reason, where it cannot.
const skipFileSymlink = (await canFileSymlink())
  ? false
  : 'file symlinks need Developer Mode or elevation on Windows';

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

test('an ordinary path inside the room is allowed', async () => {
  const { roots } = await fixture();
  await writeFile(join(roots.room, 'notes.md'), 'hi');
  const v = await validatePathReal(roots, 'notes.md');
  assert.equal(v.ok, true);
});

test('a file symlink pointing outside the room is refused', { skip: skipFileSymlink }, async () => {
  const { roots, outside } = await fixture();
  await symlink(join(outside, 'prod.env'), join(roots.room, 'escape'));
  const v = await validatePathReal(roots, 'escape');
  assert.equal(v.ok, false);
  // Must fail via the post-resolution regate, not the pure gate — the pure
  // gate's reason never mentions "symlink" (see the exact-reason assertion
  // on the traversal test below).
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a directory symlink pointing outside the room is refused', async () => {
  const { roots, outside } = await fixture();
  await linkDir(outside, join(roots.room, 'out'));
  const v = await validatePathReal(roots, 'out/prod.env');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a symlink planted in the doorway is refused too', async () => {
  const { roots, outside } = await fixture();
  await linkDir(outside, join(roots.doorway, 'out'));
  const v = await validatePathReal(roots, join(roots.doorway, 'out', 'prod.env'));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a not-yet-existing leaf under a real directory is allowed (fs_write creates it)', async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, 'reports/new-file.md');
  assert.equal(v.ok, true, 'writing a new file must still work');
});

test('the pure gate still rejects first — no fs call needed for an obvious escape', async () => {
  const { roots } = await fixture();
  const v = await validatePathReal(roots, '../../etc/passwd');
  assert.equal(v.ok, false);
  // Exact match against the PURE gate's reason (from paths.ts, no fs touched)
  // proves this was rejected before any realpath resolution ran — a test
  // that merely checked ok === false would pass even if the new logic in
  // paths-real.ts never executed at all.
  assert.equal((v as { reason: string }).reason, 'path outside the room and doorway');
});

test('a symlink that stays inside the room is allowed', async () => {
  const { roots } = await fixture();
  await mkdir(join(roots.room, 'real'), { recursive: true });
  await writeFile(join(roots.room, 'real', 'a.txt'), 'a');
  await linkDir(join(roots.room, 'real'), join(roots.room, 'link'));
  const v = await validatePathReal(roots, 'link/a.txt');
  assert.equal(v.ok, true);
});

test('a link chain two levels deep that ends outside the room is refused', async () => {
  const { roots, outside } = await fixture();
  // near -> mid -> outside. Node/OS realpath resolves the whole chain in one
  // call; this proves that isn't a one-hop-only assumption in our code.
  await linkDir(outside, join(roots.room, 'mid'));
  await linkDir(join(roots.room, 'mid'), join(roots.room, 'near'));
  const v = await validatePathReal(roots, 'near/prod.env');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a not-yet-existing leaf under a directory link that resolves inside the room is allowed', async () => {
  const { roots } = await fixture();
  await mkdir(join(roots.room, 'real2'), { recursive: true });
  await linkDir(join(roots.room, 'real2'), join(roots.room, 'link2'));
  const v = await validatePathReal(roots, 'link2/brand-new.md');
  assert.equal(v.ok, true, 'writing a new file through a benign directory link must still work');
});
