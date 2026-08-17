import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchDoorway } from './watcher';
import type { DropReport } from './doorway';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'room-watch-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  await mkdir(join(doorway, 'playground'), { recursive: true });
  return { room, doorway };
}

function collector() {
  const seen: DropReport[] = [];
  return { seen, onDrop: (r: DropReport) => seen.push(r) };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a file dropped in inbox is reported with zone inbox', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'inbox', 'resume.txt'), 'hello world');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].zone, 'inbox');
  assert.equal(c.seen[0].name, 'resume.txt');
  assert.match(c.seen[0].head, /hello world/);
});

test('a file dropped in playground is reported with zone playground', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'playground', 'sketch.md'), '# idea');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].zone, 'playground');
});

test('noise files are never reported', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await writeFile(join(roots.doorway, 'inbox', '~$resume.docx'), 'lock');
  await writeFile(join(roots.doorway, 'inbox', '.DS_Store'), 'junk');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 0);
});

test('a file still being written is reported once, after it settles', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 60 });
  const p = join(roots.doorway, 'inbox', 'big.txt');
  await writeFile(p, 'part1');
  await settle(20);
  await appendFile(p, 'part2');
  await settle(20);
  await appendFile(p, 'part3');
  await settle(500);
  w.stop();
  assert.equal(c.seen.length, 1, 'one settled report, not one per write');
  assert.match(c.seen[0].head, /part1part2part3/);
});

test('a directory created in the doorway is not reported as a drop', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  await mkdir(join(roots.doorway, 'inbox', 'archive'));
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 0);
});

test('stop() ends reporting', async () => {
  const roots = await fixture();
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40 });
  w.stop();
  await writeFile(join(roots.doorway, 'inbox', 'after.txt'), 'x');
  await settle(300);
  assert.equal(c.seen.length, 0);
});
