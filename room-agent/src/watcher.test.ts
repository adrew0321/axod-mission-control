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

// --- Fix round 1: reviewer findings ---

test('a zone missing at startup is retried on a backoff and starts working once it appears', async () => {
  // Regression for "a zone whose watch() fails is dead forever": a late-mounting
  // bind mount (container boot ordering) makes fs.watch() throw synchronously at
  // construction. The watcher must not give up — it should retry on `retryMs`
  // and pick the zone up once the directory exists.
  const base = await mkdtemp(join(tmpdir(), 'room-watch-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'playground'), { recursive: true });
  // inbox deliberately does NOT exist yet — construction must fail and retry.
  const roots = { room, doorway };
  const c = collector();
  // retryMs is well below the wait windows (7-10x, matching this file's settleMs
  // convention below) so a delayed timer under full-suite load still lands with
  // room to spare — a tighter ratio here flaked once in CI.
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40, retryMs: 20 });
  await settle(150); // let the first construction attempt fail
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  await settle(200); // let a retry land and start watching the now-real directory
  await writeFile(join(doorway, 'inbox', 'late.txt'), 'hello');
  await settle(400);
  w.stop();
  assert.equal(c.seen.length, 1);
  assert.equal(c.seen[0].zone, 'inbox');
  assert.equal(c.seen[0].name, 'late.txt');
});

test('stop() cancels a pending retry so a zone created after stop() is never picked up', async () => {
  const base = await mkdtemp(join(tmpdir(), 'room-watch-'));
  const room = join(base, 'workshop');
  const doorway = join(base, 'doorway');
  await mkdir(room, { recursive: true });
  await mkdir(join(doorway, 'playground'), { recursive: true });
  // inbox still missing — this forces a pending retry timer to exist when stop() runs.
  const roots = { room, doorway };
  const c = collector();
  const w = watchDoorway(roots, c.onDrop, { settleMs: 40, retryMs: 20 });
  await settle(50); // construction has failed and a retry is now pending
  w.stop();
  await mkdir(join(doorway, 'inbox'), { recursive: true });
  await writeFile(join(doorway, 'inbox', 'after-stop.txt'), 'x');
  await settle(400); // well past retryMs — if the retry weren't cancelled, this would fire
  assert.equal(c.seen.length, 0);
});
