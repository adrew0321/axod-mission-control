import { test, type TestContext } from 'node:test';
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

// File-symlink leaf resolution unverified — file symlinks need Developer Mode
// or elevation on Windows, and (unlike a directory link) there is no
// junction-style fallback for a single file. Probe the real capability
// rather than assuming from the platform, so these tests run wherever they
// actually can — and skip honestly, naming what's unverified, where they can't.
const skipFileSymlink = (await canFileSymlink())
  ? false
  : 'file-symlink leaf resolution unverified — file symlinks need Developer Mode or elevation on Windows';

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'room-paths-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  const outside = join(base, 'secrets');
  await mkdir(room, { recursive: true });
  await mkdir(doorway, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'prod.env'), 'TOKEN=hunter2');
  return { roots: { room, doorway }, outside };
}

test('an ordinary path inside the room is allowed', async (t) => {
  const { roots } = await fixture(t);
  await writeFile(join(roots.room, 'notes.md'), 'hi');
  const v = await validatePathReal(roots, 'notes.md');
  assert.equal(v.ok, true);
});

test('a file symlink pointing outside the room is refused', { skip: skipFileSymlink }, async (t) => {
  const { roots, outside } = await fixture(t);
  await symlink(join(outside, 'prod.env'), join(roots.room, 'escape'));
  const v = await validatePathReal(roots, 'escape');
  assert.equal(v.ok, false);
  // Must fail via the post-resolution regate, not the pure gate — the pure
  // gate's reason never mentions "symlink" (see the exact-reason assertion
  // on the traversal test below).
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a dangling file symlink is refused, not optimistically walked past', { skip: skipFileSymlink }, async (t) => {
  const { roots, outside } = await fixture(t);
  // Target never created. lstat succeeds (the link exists); realpath fails.
  // That must refuse, not be treated as "component absent, walk up".
  await symlink(join(outside, 'never-created.txt'), join(roots.room, 'ghost-file'));
  const v = await validatePathReal(roots, 'ghost-file');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a directory symlink pointing outside the room is refused', async (t) => {
  const { roots, outside } = await fixture(t);
  await linkDir(outside, join(roots.room, 'out'));
  const v = await validatePathReal(roots, 'out/prod.env');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a dangling directory link is refused, not optimistically walked past', async (t) => {
  const { roots, outside } = await fixture(t);
  // ghost -> secrets/never-created (a target that does not exist at all).
  // The vulnerable version of this code treated "realpath fails" as "this
  // component is absent" unconditionally, walked up past `ghost`, found
  // `room` resolves, and re-appended `ghost/stolen.txt` verbatim — textually
  // inside the room, so it verdicted `ok: true` with `abs` pointing at an
  // unresolved link. A later fs_write through that abs would follow the
  // link and land outside the room. lstat distinguishes "exists but doesn't
  // resolve" from "genuinely absent" and must refuse this case.
  await linkDir(join(outside, 'never-created'), join(roots.room, 'ghost'));
  const v = await validatePathReal(roots, 'ghost/stolen.txt');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a symlink planted in the doorway is refused too', async (t) => {
  const { roots, outside } = await fixture(t);
  await linkDir(outside, join(roots.doorway, 'out'));
  const v = await validatePathReal(roots, join(roots.doorway, 'out', 'prod.env'));
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a not-yet-existing leaf under a real directory is allowed (fs_write creates it)', async (t) => {
  const { roots } = await fixture(t);
  const v = await validatePathReal(roots, 'reports/new-file.md');
  assert.equal(v.ok, true, 'writing a new file must still work');
});

test('a deeply nested not-yet-existing path with no links involved is still allowed', async (t) => {
  const { roots } = await fixture(t);
  // No component in a/b/c/new.txt exists yet, and none of them is a link —
  // this is the legitimate create case the dangling-link fix must not break.
  const v = await validatePathReal(roots, 'a/b/c/new.txt');
  assert.equal(v.ok, true, 'creating nested directories via fs_write must still work');
});

test('the pure gate still rejects first — no fs call needed for an obvious escape', async (t) => {
  const { roots } = await fixture(t);
  const v = await validatePathReal(roots, '../../etc/passwd');
  assert.equal(v.ok, false);
  // Exact match against the PURE gate's reason (from paths.ts, no fs touched)
  // proves this was rejected before any realpath resolution ran — a test
  // that merely checked ok === false would pass even if the new logic in
  // paths-real.ts never executed at all.
  assert.equal((v as { reason: string }).reason, 'path outside the room and doorway');
});

test('a symlink that stays inside the room is allowed', async (t) => {
  const { roots } = await fixture(t);
  await mkdir(join(roots.room, 'real'), { recursive: true });
  await writeFile(join(roots.room, 'real', 'a.txt'), 'a');
  await linkDir(join(roots.room, 'real'), join(roots.room, 'link'));
  const v = await validatePathReal(roots, 'link/a.txt');
  assert.equal(v.ok, true);
  // ok === true alone doesn't prove resolution ran — a plain directory would
  // produce the same verdict. Confirm abs was actually resolved THROUGH the
  // link to its target, not just returned as the literal 'link' path.
  assert.ok((v as { abs: string }).abs.includes('real'));
});

test('a link chain two levels deep that ends outside the room is refused', async (t) => {
  const { roots, outside } = await fixture(t);
  // near -> mid -> outside. Node/OS realpath resolves the whole chain in one
  // call; this proves that isn't a one-hop-only assumption in our code.
  await linkDir(outside, join(roots.room, 'mid'));
  await linkDir(join(roots.room, 'mid'), join(roots.room, 'near'));
  const v = await validatePathReal(roots, 'near/prod.env');
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /symlink/i);
});

test('a not-yet-existing leaf under a directory link that resolves inside the room is allowed', async (t) => {
  const { roots } = await fixture(t);
  await mkdir(join(roots.room, 'real2'), { recursive: true });
  await linkDir(join(roots.room, 'real2'), join(roots.room, 'link2'));
  const v = await validatePathReal(roots, 'link2/brand-new.md');
  assert.equal(v.ok, true, 'writing a new file through a benign directory link must still work');
  // Same discrimination as above: prove the leaf resolved through the link
  // to 'real2', not that it merely returned the literal 'link2' path.
  assert.ok((v as { abs: string }).abs.includes('real2'));
});

test('a regular file used as a directory component still resolves (fs op will ENOTDIR later)', async (t) => {
  const { roots } = await fixture(t);
  // No link is involved here at all — f.txt is a plain file. lstat on
  // 'f.txt/sub' fails the same way realpath does (not ENOENT, but not a
  // dangling-link case either), so this still falls through to "absent,
  // walk up" and resolves ok: true. Not a boundary issue: the fs op that
  // actually tries to use this path later fails with ENOTDIR. Pinned here
  // so the dangling-link fix is not read as also needing to special-case this.
  await writeFile(join(roots.room, 'f.txt'), 'x');
  const v = await validatePathReal(roots, 'f.txt/sub');
  assert.equal(v.ok, true);
});
