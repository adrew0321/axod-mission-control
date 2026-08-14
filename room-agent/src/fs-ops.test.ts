import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFs } from './fs-ops';
import type { Roots } from './paths';

async function makeRoots(): Promise<Roots> {
  const base = await mkdtemp(join(tmpdir(), 'room-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  return { room, doorway };
}

test('fs_list lists a directory', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'a.txt'), 'x');
  const r = await execFs(roots, { id: 'c1', action: 'fs_list', path: '.' });
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'a.txt');
});

test('fs_read returns file contents', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'note.md'), 'hello room');
  const r = await execFs(roots, { id: 'c2', action: 'fs_read', path: 'note.md' });
  assert.equal(r.status, 'ok');
  assert.equal(r.text, 'hello room');
});

test('fs_write creates parent directories', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c3', action: 'fs_write', path: 'deep/nested/out.txt', content: 'written' });
  assert.equal(r.status, 'ok');
  assert.equal(await readFile(join(roots.room, 'deep/nested/out.txt'), 'utf8'), 'written');
});

test('fs_write into the doorway works', async () => {
  const roots = await makeRoots();
  const target = join(roots.doorway, 'inbox', 'reply.md');
  const r = await execFs(roots, { id: 'c4', action: 'fs_write', path: target, content: 'hi' });
  assert.equal(r.status, 'ok');
  assert.equal(await readFile(target, 'utf8'), 'hi');
});

test('a path outside the roots is blocked, not errored', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c5', action: 'fs_read', path: '/etc/passwd' });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason ?? '', /outside/i);
});

test('a missing file errors rather than throwing', async () => {
  const roots = await makeRoots();
  const r = await execFs(roots, { id: 'c6', action: 'fs_read', path: 'nope.txt' });
  assert.equal(r.status, 'error');
});

test('an oversized file is refused', async () => {
  const roots = await makeRoots();
  await writeFile(join(roots.room, 'big.bin'), 'x'.repeat(300_000));
  const r = await execFs(roots, { id: 'c7', action: 'fs_read', path: 'big.bin' });
  assert.equal(r.status, 'error');
  assert.match(r.reason ?? '', /too large/i);
});
